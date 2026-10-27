import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshotName, SERVICE_COMMANDS_FEATURE, snapshotName } from "../borrowed/backups";
import type { Manifest } from "../borrowed/manifest";
import { BIND_LINES_FEATURE, generateUnits, unitFileName, withoutStoreLines } from "../borrowed/unit";
import { configFrom } from "../src/backup/config";
import { HOOK_EXIT, removeTree } from "../src/backup/child";
import { copyData, CopyError, LISTED_BYTES, measureCopy, undeclaredServer } from "../src/backup/copy";
import { extractData } from "../src/backup/extract";
import { DISCARD_TIMEOUT_MS, discardJob, hookJob, HOOK_GRACE_MS, hookMemory, installedUnit, projectHooks, runHooks, unitStoreLines } from "../src/backup/hooks";
import { freeBytes } from "../src/backup/projects";
import { encodeRequest } from "../src/backup/request";
import { restore, type Command } from "../src/backup/restore";
import { runBackups } from "../src/backup/run";
import { childCommand, confinement, startChild, type Job } from "../src/backup/runner";
import { CREDENTIALS_EXIT_STATUS, credentialsFailure, storeCredentials, storeEnvironmentFile } from "../borrowed/store";
import { staging, takeSnapshot, verifyArchive } from "../src/backup/snapshot";
import { TarWriter, type Sink } from "../src/backup/tar";
import { dumped, names as storedNames, NO_RESTIC, project, SCRIPT, tree } from "./backup-fixtures";

setDefaultTimeout(120_000);

/**
 * A service that keeps a server database in the data declares its backup
 * command, and the snapshot holds what that command left, never the live
 * files. Run for real here, with no isolation: the command, the copy and the
 * removal of the command's copy are plain children, as the run starts them on
 * the workstation. The walls they get under systemd are compared with the
 * service's own unit, line by line.
 *
 * The live folders below carry the marks of a running PostgreSQL, a
 * `postmaster.pid` beside `PG_VERSION`, and a file standing for a page half
 * written: none of it may reach an archive taken while the server runs.
 */
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    // A test that failed may leave a folder without write permission behind.
    Bun.spawnSync(["chmod", "-R", "u+rwx", root]);
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A folder of installed units for `manifest`, as /etc/systemd/system holds
 * them: this release's (`current`), those 0.7 laid (`0.7`), or none.
 */
function installedUnits(manifest: Manifest, how: "current" | "0.7" | "none"): string {
  const folder = mkdtempSync(join(tmpdir(), "backup-units-"));
  roots.push(folder);
  if (how === "none") return folder;
  for (const { unit, text } of generateUnits(manifest, { slug: manifest.slug, zone: "test-zone.invalid", contact: "" })) {
    writeFileSync(join(folder, unitFileName(unit)), how === "current" ? text : withoutStoreLines(text));
  }
  return folder;
}

/** A running cluster's files, as a copy file by file would find them. */
function liveCluster(folder: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "PG_VERSION"), "17\n");
  writeFileSync(join(folder, "postmaster.pid"), "4242\n");
  writeFileSync(join(folder, "torn-page"), "half written");
}

/**
 * `vault`, a web front and a database service whose backup command is the
 * script given, laid in its `app/`; or, with `single`, the same command in
 * the form with one `start`.
 */
function vault(script: string, options: { single?: boolean; folder?: string; extra?: Record<string, string> } = {}) {
  const made = tree(options.extra);
  roots.push(made.root);
  const app = join(made.sites, "vault", "app");
  mkdirSync(app, { recursive: true });
  mkdirSync(join(made.sites, "vault", "public"), { recursive: true });
  writeFileSync(join(app, "backup.sh"), `set -eu\n${script}\n`);
  const backup = { folder: options.folder ?? "db", command: `/bin/sh ${join(app, "backup.sh")}` };
  const manifest = options.single
    ? { port: 3041, backup, env: { PUBLIC_URL: "https://{slug}.{zone}" } }
    : {
        start: undefined,
        port: undefined,
        publicDir: "public",
        env: { PUBLIC_URL: "https://{slug}.{zone}" },
        services: { web: { start: "/usr/local/bin/bun web.ts", port: 3040 }, db: { start: "/bin/sh db.sh", port: 3041, internal: true, backup } },
      };
  const data = project(made.sites, "vault", manifest);
  liveCluster(join(data, "db"));
  writeFileSync(join(data, "notes.txt"), "kept as it is");
  const read = JSON.parse(readFileSync(join(made.sites, "vault", "sitesolide.json"), "utf8")) as Manifest;
  const vaultProject = { folder: "vault", account: "site-vault", owner: null, dataDir: data, manifest: read };
  return { ...made, data, app, project: vaultProject };
}

/** A snapshot's tar, dumped from the repository, listed and its description read with tar itself. */
const listing = (archive: string) => Bun.spawnSync(["tar", "-tf", archive]).stdout.toString().trim().split("\n");
const description = (archive: string) => JSON.parse(Bun.spawnSync(["tar", "-xOf", archive, "sitesolide-backup.json"]).stdout.toString());

/** What the staging folder of `vault` holds: nothing once a snapshot is over, whatever its outcome. */
const leftInStaging = (config: { stagingFolder: string }) => readdirSync(join(config.stagingFolder, "vault"));

const WRITES_A_COPY = `
printf consistent > "$BACKUP_DIR/state"
printf '%s|%s|%s|%s' "$PORT" "$DATA_DIR" "$PUBLIC_URL" "$(pwd)" > "$BACKUP_DIR/environment"
mkdir "$BACKUP_DIR/base"
printf page > "$BACKUP_DIR/base/1"`;

describe.skipIf(NO_RESTIC)("a service's backup command, in a scheduled run", () => {
  const made = vault(WRITES_A_COPY);
  const journal: string[] = [];
  let archive = "";

  test("runs before the copy, and the snapshot holds its copy in place of the live folder", async () => {
    const status = await runBackups({ config: made.config, now: () => T, log: (line) => journal.push(line) });
    expect(status.projects.vault).toEqual({ ok: true, snapshot: snapshotName("vault", T, "scheduled"), error: null });
    archive = dumped(made.config, "vault", snapshotName("vault", T, "scheduled"));
    const names = listing(archive);
    expect(names).toEqual(expect.arrayContaining(["data/", "data/db/", "data/db/state", "data/db/environment", "data/db/base/", "data/db/base/1", "data/notes.txt", "sitesolide-backup.json"]));
    // Nothing of the live cluster: neither its pid file, nor its torn page.
    expect(names.filter((name) => /postmaster|torn-page|PG_VERSION/.test(name))).toEqual([]);
    expect(journal).toContain("backup vault: the backup command of service db left its copy of db");
  });

  test("is handed its service's environment, placeholders replaced, its working directory, and BACKUP_DIR", () => {
    const told = Bun.spawnSync(["tar", "-xOf", archive, "data/db/environment"]).stdout.toString();
    // `pwd` resolves the links of the temporary folder: macOS's /var is one.
    expect(told).toBe(`3041|${join(made.sites, "vault", "data")}|https://vault.test-zone.invalid|${realpathSync(made.app)}`);
  });

  test("the description says which folder came from a backup command", () => {
    expect(description(archive)).toMatchObject({ format: 2, folder: "vault", raw: false, stopped: false, fromBackupCommand: ["db"], liveAsFiles: [] });
  });

  test("what the command left is removed once the snapshot is taken", () => {
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("the folder comes back 0700 and the project's, the files as they were made", async () => {
    // The staging folder is made 0700, and archived with its mode: PostgreSQL
    // refuses a data directory others can read.
    const entry = Bun.spawnSync(["tar", "-tvf", archive]).stdout.toString().split("\n").find((line) => line.endsWith(" data/db/"));
    expect(entry).toStartWith("drwx------");
    const destination = join(made.root, "restored");
    mkdirSync(destination);
    const takenAt = readSnapshotName("vault", snapshotName("vault", T, "scheduled"))!.takenAt;
    const job: Job = {
      mode: "extract",
      folder: "vault",
      account: "site-vault",
      uid: null,
      args: [destination, String(1 << 30), "vault", String(takenAt)],
      readWrite: [destination],
      bind: [destination],
      cacheDirectory: null,
      stdin: archive,
      stdout: "ignore",
      timeoutMs: 60_000,
    };
    const { code, report } = await startChild(job, made.config).result;
    expect(report.error).toBeNull();
    expect(code).toBe(0);
    expect(statSync(join(destination, "db")).mode & 0o777).toBe(0o700);
    expect(statSync(join(destination, "db")).uid).toBe(process.getuid!());
    expect(statSync(join(destination, "db", "base")).mode & 0o777).toBe(0o700);
    expect(statSync(join(destination, "db", "state")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(destination, "db", "base", "1"), "utf8")).toBe("page");
  });
});

describe.skipIf(NO_RESTIC)("a backup command that does not do its job fails the snapshot, loudly", () => {
  test("a non-zero exit: our message in the status file, never the command's words", async () => {
    const made = vault(`
printf '%s\\n' '{"event":"error","message":"the invoices of alice-martin"}' >&2
printf 'password=hunter2\\n' >&2
printf '{"event":"summary"}\\n' >&2
exit 3`);
    const journal: string[] = [];
    const status = await runBackups({ config: made.config, now: () => T, log: (line) => journal.push(line) });
    expect(status.projects.vault).toEqual({ ok: false, snapshot: null, error: "the backup command of service db failed, see the journal of sitesolide-backup" });
    const file = readFileSync(join(made.config.stateFolder, "last-run.json"), "utf8");
    expect(file).not.toContain("alice-martin");
    expect(file).not.toContain("hunter2");
    expect(journal.join("\n")).toContain("exit code 3");
    expect(storedNames(made.config, "vault")).toEqual([]);
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("an empty BACKUP_DIR", async () => {
    const made = vault("true");
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, silent);
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db left nothing in BACKUP_DIR, see docs/manifest.md", cause: null });
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("a program that is not there", async () => {
    const made = vault("true");
    const manifest = { ...made.project.manifest!, services: { ...made.project.manifest!.services!, db: { ...made.project.manifest!.services!.db!, backup: { folder: "db", command: "/nonexistent/pg_basebackup -D x" } } } };
    const outcome = await takeSnapshot(made.config, { ...made.project, manifest }, "scheduled", T, silent);
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db could not be started, see the journal of sitesolide-backup", cause: null });
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("a command past its time is stopped, said so, and the project is tried again after the others", async () => {
    const made = vault("printf started > \"$BACKUP_DIR/state\"\nexec /bin/sleep 30");
    const started = Date.now();
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, silent, { timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db did not finish in its time, see the journal of sitesolide-backup", cause: "timeout" });
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("a command that brings the disk down to its reserve is stopped", async () => {
    // A reserve 48 MiB under what is free, and a command that writes 96 MiB, then waits.
    const made = vault(`dd if=/dev/zero of="$BACKUP_DIR/fill" bs=1048576 count=96 2>/dev/null\nexec /bin/sleep 20`);
    const config = { ...made.config, reserveBytes: freeBytes(made.config.repository) - 48 * 1024 * 1024 };
    const journal: string[] = [];
    const started = Date.now();
    const outcome = await takeSnapshot(config, made.project, "scheduled", T, (line) => journal.push(line));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(outcome).toEqual({ ok: false, error: "stopped: the disk was about to fill", cause: null });
    expect(journal.join("\n")).toContain("came down to its reserve");
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("a declaration the machine's copy of the manifest gets wrong is not run", async () => {
    const made = vault(`touch "$DATA_DIR/ran"\n${WRITES_A_COPY}`, { folder: "../app" });
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, silent);
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db in sitesolide.json is not valid: fix it and deploy again, see docs/manifest.md", cause: null });
    expect(existsSync(join(made.data, "ran"))).toBe(false);
  });
});

describe.skipIf(NO_RESTIC)("what a command leaves behind never blocks the next run", () => {
  test("a read-only folder in BACKUP_DIR: archived, removed, and the next run runs", async () => {
    const made = vault(`${WRITES_A_COPY}\nmkdir "$BACKUP_DIR/sealed"\nprintf kept > "$BACKUP_DIR/sealed/f"\nchmod 555 "$BACKUP_DIR/sealed" "$BACKUP_DIR/base"`);
    const first = await takeSnapshot(made.config, made.project, "scheduled", T, silent);
    expect(first.ok).toBe(true);
    expect(leftInStaging(made.config)).toEqual([]);
    const second = await takeSnapshot(made.config, made.project, "scheduled", T + 3_600_000, silent);
    expect(second.ok).toBe(true);
  });

  test("a read-only tree a run cut short left: the next command's run empties it first", async () => {
    const made = vault(WRITES_A_COPY);
    const left = join(made.config.stagingFolder, "vault", "hooks", "vault.db", "sealed", "deeper");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "f"), "from a run cut short");
    chmodSync(left, 0o000);
    chmodSync(join(made.config.stagingFolder, "vault", "hooks", "vault.db", "sealed"), 0o500);
    chmodSync(join(made.config.stagingFolder, "vault", "hooks"), 0o500);
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, silent);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(listing(dumped(made.config, "vault", outcome.name)).filter((name) => name.includes("sealed"))).toEqual([]);
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("what a project that no longer declares a command left is removed by the next run", async () => {
    const made = tree();
    roots.push(made.root);
    writeFileSync(join(project(made.sites, "plain"), "notes.txt"), "kept");
    const left = join(made.config.stagingFolder, "plain", "hooks", "plain");
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, "base"), "a copy no command will ever take again");
    chmodSync(left, 0o500);
    const status = await runBackups({ config: made.config, now: () => T, log: silent });
    expect(status.projects.plain?.ok).toBe(true);
    expect(readdirSync(join(made.config.stagingFolder, "plain"))).toEqual([]);
  });

  test("the removal gives the owner back its rights first, and follows no link", () => {
    const root = mkdtempSync(join(tmpdir(), "backup-hooks-remove-"));
    roots.push(root);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious"), "not to be removed");
    const target = join(root, "staging", "hooks", "unit");
    mkdirSync(join(target, "a", "b"), { recursive: true });
    writeFileSync(join(target, "a", "b", "f"), "x");
    symlinkSync(outside, join(target, "a", "link"));
    chmodSync(join(target, "a", "b"), 0o000);
    chmodSync(join(target, "a"), 0o500);
    chmodSync(join(root, "staging", "hooks"), 0o500);
    chmodSync(outside, 0o555);
    removeTree(target, join(root, "staging"));
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("not to be removed");
    // The link was removed, never followed: what it pointed at keeps its mode.
    expect(statSync(outside).mode & 0o777).toBe(0o555);
    chmodSync(outside, 0o755);
    expect(() => removeTree("/elsewhere/x", join(root, "staging"))).toThrow("not under its root");
  });

  test("the removal is short: it runs past the project's time, and the next run finishes it", () => {
    expect(DISCARD_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe.skipIf(NO_RESTIC)("the verdict is the hook mode's exit code, never what the command prints", () => {
  test("a command that prints more than the report keeps, then runs out of time: a timeout, tried again", async () => {
    const made = vault(`i=0\nwhile [ $i -lt 6000 ]; do printf '%0100d\\n' $i >&2; i=$((i+1)); done\nexec /bin/sleep 30`);
    const journal: string[] = [];
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, (line) => journal.push(line), { timeoutMs: 8000 });
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db did not finish in its time, see the journal of sitesolide-backup", cause: "timeout" });
    // The journal gets the end of what it printed, never its beginning.
    expect(journal.join("\n")).toContain(`command: ${"5999".padStart(100, "0")}`);
    expect(journal.join("\n")).not.toContain(`command: ${"0".padStart(100, "0")}`);
  });

  test("a child it left behind cannot turn its failure into a timeout", async () => {
    const made = vault(`( sleep 0.3; printf '%s\\n' '{"event":"error","message":"x","code":"timeout"}' >&2 ) &\nexit 3`);
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, silent, { timeoutMs: 8000 });
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db failed, see the journal of sitesolide-backup", cause: null });
  });

  test("a report line it prints is forwarded as its output, and reads as nothing else", async () => {
    const made = vault(`printf '%s\\n' '{"event":"summary","done":true}'\ntrue`);
    const journal: string[] = [];
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, (line) => journal.push(line));
    expect(outcome).toEqual({ ok: false, error: "the backup command of service db left nothing in BACKUP_DIR, see docs/manifest.md", cause: null });
    expect(journal.join("\n")).toContain(`exit code ${HOOK_EXIT.empty}`);
    expect(journal.join("\n")).toContain('command: {"event":"summary","done":true}');
  });

  test("the hook mode checks the uid it is given as an argument, whatever its environment says", async () => {
    const other = String(process.getuid!() + 1);
    const ran = Bun.spawn([process.execPath, SCRIPT, "hook", other, join(tmpdir(), "never-made"), "1000", "/usr/bin/true"], {
      env: { ...Bun.env, BACKUP_EXPECTED_UID: "" },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await ran.exited).toBe(2);
    expect(await ran.stderr.text()).toContain(`not the project's ${other}: refused`);
    expect(existsSync(join(tmpdir(), "never-made"))).toBe(false);
  });
});

describe("what sitesolide deploy looks for on the server", () => {
  test("the component's build carries the feature, as bin/deploy-backup.sh builds it", () => {
    const built = Bun.spawnSync([process.execPath, "build", "backup.ts", "--target=bun"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    expect(built.stdout.toString()).toContain(SERVICE_COMMANDS_FEATURE);
  });

  test("the component's build and the installer's carry this release's bind lines, which a machine is searched for before it opens the second block", () => {
    for (const entry of ["backup.ts", "installer.ts"]) {
      const built = Bun.spawnSync([process.execPath, "build", entry, "--target=bun"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
      expect({ entry, code: built.exitCode }).toEqual({ entry, code: 0 });
      expect({ entry, carries: built.stdout.toString().includes(BIND_LINES_FEATURE) }).toEqual({ entry, carries: true });
    }
  });
});

describe("a command's memory", () => {
  test("its service's ceiling, and room for the program that runs it", () => {
    expect(hookMemory("64M")).toBe("192M");
    expect(hookMemory("256M")).toBe("384M");
    expect(hookMemory("1G")).toBe("1152M");
    expect(hookMemory("524288K")).toBe("640M");
  });
});

describe("a manifest on the machine that no validation passed", () => {
  test("a service name that would lead the command's folder out of its place runs nothing", () => {
    const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid" }, { bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js" });
    const backup = { folder: "db", command: "/bin/true" };
    for (const name of ["..", "../../../../srv/sites/vault/data", "a/b", "Db"]) {
      const manifest = { slug: "vault", publicDir: "public", services: { [name]: { start: "/bin/true", port: 3041, internal: true, backup } } } as unknown as Manifest;
      const found = projectHooks({ folder: "vault", account: "site-vault", owner: null, dataDir: "/srv/sites/vault/data", manifest }, staging(config, "vault").path);
      expect(found).toEqual({ error: `the backup command of service ${name} in sitesolide.json is not valid: fix it and deploy again, see docs/manifest.md` });
    }
  });
});

describe("no snapshot is reported taken that the restore refuses", () => {
  test("a folder of 16,000 links: the description lists the first and counts them all, and the archive extracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "backup-hooks-links-"));
    roots.push(root);
    const data = join(root, "data");
    const links = join(data, "links-with-a-reasonably-long-folder-name");
    mkdirSync(links, { recursive: true });
    mkdirSync(join(root, "staging"));
    writeFileSync(join(data, "f"), "x");
    for (let i = 0; i < 16_000; i++) symlinkSync("../f", join(links, `link-${String(i).padStart(6, "0")}`));
    const chunks: Uint8Array[] = [];
    const sink: Sink = {
      async write(bytes) {
        chunks.push(bytes.slice());
      },
      async close() {},
    };
    const summary = await copyData(data, join(root, "staging"), sink, { folder: "vault", takenAt: T, maxBytes: 1 << 30 });
    expect(summary.counts.skipped).toBe(16_000);
    expect(summary.skipped.length).toBeGreaterThan(100);
    expect(summary.skipped.length).toBeLessThan(16_000);
    expect(Buffer.byteLength(JSON.stringify(summary.skipped))).toBeLessThanOrEqual(LISTED_BYTES);
    const archive = join(root, "links.tar");
    writeFileSync(archive, Bun.concatArrayBuffers(chunks, Infinity, true));
    await verifyArchive(Bun.file(archive).stream() as ReadableStream<Uint8Array>);
    const destination = join(root, "restored");
    mkdirSync(destination);
    const extracted = await extractData(Bun.file(archive).stream() as ReadableStream<Uint8Array>, destination, { maxEntries: 2_000_000, maxBytes: 1 << 30 });
    expect(extracted.description).toMatchObject({ counts: { skipped: 16_000 } });
  });

  /** An archive written by hand, as a forged copy would be. */
  async function forged(root: string, write: (tar: TarWriter) => Promise<void>): Promise<string> {
    const path = join(root, `forged-${crypto.randomUUID()}.tar`);
    const chunks: Uint8Array[] = [];
    const tar = new TarWriter({
      async write(bytes) {
        chunks.push(bytes.slice());
      },
      async close() {},
    });
    await write(tar);
    await tar.end();
    writeFileSync(path, Bun.concatArrayBuffers(chunks, Infinity, true));
    return path;
  }

  test("the read-back refuses what the extraction refuses entry by entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "backup-hooks-forged-"));
    roots.push(root);
    const meta = { mode: 0o600, mtime: 0, uid: 0, gid: 0 };
    const outside = await forged(root, async (tar) => {
      await tar.directory("data", { ...meta, mode: 0o700 });
      await tar.file("etc/evil", meta, 1, new Uint8Array([1]));
    });
    const read = (path: string) => Bun.file(path).stream() as ReadableStream<Uint8Array>;
    await expect(verifyArchive(read(outside))).rejects.toThrow("entry outside data/ in the archive");
    const big = new TextEncoder().encode(`${JSON.stringify({ format: 2, padding: "x".repeat(1024 * 1024) })}\n`);
    const described = await forged(root, async (tar) => {
      await tar.directory("data", { ...meta, mode: 0o700 });
      await tar.file("sitesolide-backup.json", meta, big.byteLength, big);
    });
    await expect(verifyArchive(read(described))).rejects.toThrow("the archive's description is too large");
  });
});

describe.skipIf(NO_RESTIC)("in the form with one start", () => {
  test("the project's own backup command runs, its folder saved from it", async () => {
    const made = vault(WRITES_A_COPY, { single: true });
    const journal: string[] = [];
    const outcome = await takeSnapshot(made.config, made.project, "scheduled", T, (line) => journal.push(line));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.fromBackupCommand).toEqual(["db"]);
    expect(journal).toContain("backup vault: the backup command left its copy of db");
    expect(listing(dumped(made.config, "vault", outcome.name))).not.toContain("data/db/postmaster.pid");
  });
});

// This describe and the next two time nothing, and each test lays its own
// tree: their tests run side by side. Those that time a command, or watch the
// disk, run one by one.
describe.concurrent.skipIf(NO_RESTIC)("the room a snapshot needs counts the command's copy, not the live folder", () => {
  /** A file of `bytes` apparent size, holes only: the measure counts it whole. */
  function sparse(path: string, bytes: number): void {
    const fd = openSync(path, "w");
    ftruncateSync(fd, bytes);
    closeSync(fd);
  }
  const GIB = 1024 * 1024 * 1024;

  test("a live folder bigger than the room, a small copy: the snapshot is taken", async () => {
    const made = vault(WRITES_A_COPY);
    sparse(join(made.data, "db", "base-relation"), 64 * GIB);
    const config = { ...made.config, reserveBytes: freeBytes(made.config.repository) - 8 * GIB };
    const outcome = await takeSnapshot(config, made.project, "scheduled", T, silent);
    expect(outcome.ok).toBe(true);
  });

  test("a copy bigger than the room allows: refused, and no figure in the message", async () => {
    const made = vault(`${WRITES_A_COPY}\ntruncate -s 16G "$BACKUP_DIR/base/2"`);
    const config = { ...made.config, reserveBytes: freeBytes(made.config.repository) - 8 * GIB };
    const outcome = await takeSnapshot(config, made.project, "scheduled", T, silent);
    expect(outcome).toEqual({ ok: false, error: "not enough disk space for this snapshot above the reserve, see the journal of sitesolide-backup", cause: null, dirty: true });
    expect(leftInStaging(made.config)).toEqual([]);
  });

  test("the measure leaves the live folder out and adds each copy, as one folder more", () => {
    const root = mkdtempSync(join(tmpdir(), "backup-hooks-measure-"));
    roots.push(root);
    const data = join(root, "data");
    liveCluster(join(data, "db"));
    writeFileSync(join(data, "notes.txt"), "12345");
    const copy = join(root, "copy");
    mkdirSync(join(copy, "base"), { recursive: true });
    writeFileSync(join(copy, "base", "1"), "1234567");
    expect(measureCopy(data, [{ folder: "db", source: copy }])).toEqual({ bytes: 12, entries: 4 });
    // As files, with the services stopped: the live folder counts whole.
    expect(measureCopy(data, [{ folder: "db", source: null }])).toEqual({ bytes: 5 + 3 + 5 + 12, entries: 5 });
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a running server no service declares", () => {
  async function refused(lay: (data: string) => void): Promise<{ error: string | null; journal: string; file: string }> {
    const made = tree();
    roots.push(made.root);
    const data = project(made.sites, "shop");
    writeFileSync(join(data, "orders.db.txt"), "kept");
    lay(data);
    const journal: string[] = [];
    const status = await runBackups({ config: made.config, now: () => T, log: (line) => journal.push(line) });
    return { error: status.projects.shop!.error, journal: journal.join("\n"), file: readFileSync(join(made.config.stateFolder, "last-run.json"), "utf8") };
  }

  test("PostgreSQL: the snapshot is refused, the way out given, the folder named to the journal alone", async () => {
    const outcome = await refused((data) => liveCluster(join(data, "pg-of-alice-martin")));
    expect(outcome.error).toBe(undeclaredServer("PostgreSQL"));
    expect(outcome.error).toBe("a running PostgreSQL keeps its files in the data, which a copy file by file would archive unusable: declare a backup command for its service, see docs/manifest.md");
    expect(outcome.file).not.toContain("pg-of-alice-martin");
    expect(outcome.journal).toContain("pg-of-alice-martin");
  });

  test("PostgreSQL deeper in the tree, or straight in the data folder", async () => {
    expect((await refused((data) => liveCluster(join(data, "apps", "billing", "pg")))).error).toBe(undeclaredServer("PostgreSQL"));
    expect((await refused((data) => liveCluster(data))).error).toBe(undeclaredServer("PostgreSQL"));
  });

  test("MongoDB, its lock holding the server's pid", async () => {
    const outcome = await refused((data) => {
      mkdirSync(join(data, "mongo"));
      writeFileSync(join(data, "mongo", "WiredTiger"), "WiredTiger\n");
      writeFileSync(join(data, "mongo", "mongod.lock"), "4242\n");
    });
    expect(outcome.error).toBe(undeclaredServer("MongoDB"));
  });

  test("a server stopped cleanly left no such mark: its files are files, and saved", async () => {
    const outcome = await refused((data) => {
      mkdirSync(join(data, "pg"));
      writeFileSync(join(data, "pg", "PG_VERSION"), "17\n");
      mkdirSync(join(data, "mongo"));
      writeFileSync(join(data, "mongo", "WiredTiger"), "WiredTiger\n");
      writeFileSync(join(data, "mongo", "mongod.lock"), "");
    });
    expect(outcome.error).toBeNull();
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a restore's own snapshot, the services stopped", () => {
  test("runs no backup command, and saves every live folder as files, said so", async () => {
    const made = vault(`touch "$DATA_DIR/ran"\n${WRITES_A_COPY}`);
    liveCluster(join(made.data, "undeclared"));
    const outcome = await takeSnapshot(made.config, made.project, "pre-restore", T, silent, { stopped: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(existsSync(join(made.data, "ran"))).toBe(false);
    const archive = dumped(made.config, "vault", outcome.name);
    expect(description(archive)).toMatchObject({ stopped: true, raw: false, fromBackupCommand: [], liveAsFiles: ["db", "undeclared"] });
    expect(listing(archive)).toEqual(expect.arrayContaining(["data/db/postmaster.pid", "data/db/torn-page", "data/undeclared/postmaster.pid"]));
  });

  test("a restore puts the command's copy back, and saves the stopped cluster first", async () => {
    // The command refuses to run once `refuse` is there: if the restore's own
    // snapshot ran it, the restore would fail.
    const made = vault(`test ! -e "$DATA_DIR/refuse"\n${WRITES_A_COPY}`);
    const run = await runBackups({ config: made.config, now: () => T, log: silent });
    expect(run.projects.vault?.ok).toBe(true);
    writeFileSync(join(made.data, "refuse"), "");
    writeFileSync(join(made.data, "db", "torn-page"), "written after the snapshot");
    mkdirSync(join(made.config.stateFolder, "requests"), { recursive: true });
    writeFileSync(
      join(made.config.stateFolder, "requests", "vault.json"),
      encodeRequest({ nonce: "0123456789abcdef", snapshot: snapshotName("vault", T, "scheduled"), actor: "owner", requestedAt: T + 60_000 }),
      { mode: 0o600 },
    );
    // No unit is loaded: the restore stops and starts none.
    const systemctl = async (): Promise<Command> => ({ code: 0, output: "not-found\n" });
    let clock = T + 60_000;
    const result = await restore({ config: made.config, now: () => (clock += 1000), log: silent, systemctl, wait: async () => undefined }, "vault");
    expect(result.state).toBe("ok");
    expect(readdirSync(join(made.data, "db")).sort()).toEqual(["base", "environment", "state"]);
    expect(statSync(join(made.data, "db")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(made.data, "refuse"))).toBe(false);
    const saved = dumped(made.config, "vault", result.preRestore!);
    expect(description(saved)).toMatchObject({ stopped: true, liveAsFiles: ["db"] });
    expect(Bun.spawnSync(["tar", "-xOf", saved, "data/db/torn-page"]).stdout.toString()).toBe("written after the snapshot");
  });
});

describe("the substitution, in the copy itself", () => {
  /** A sink that keeps the archive, to read it back. */
  function memory(): Sink & { stream: () => ReadableStream<Uint8Array> } {
    const chunks: Uint8Array[] = [];
    return {
      async write(bytes) {
        chunks.push(bytes.slice());
      },
      async close() {},
      stream: () => new Blob([Bun.concatArrayBuffers(chunks, Infinity, true) as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>,
    };
  }
  function scratch() {
    const root = mkdtempSync(join(tmpdir(), "backup-hooks-copy-"));
    roots.push(root);
    const copy = join(root, "copy");
    mkdirSync(copy, { mode: 0o700 });
    writeFileSync(join(copy, "state"), "consistent");
    mkdirSync(join(root, "staging"));
    return { root, data: join(root, "data"), copy };
  }

  test("a declared folder missing from the live data is archived all the same, under its name", async () => {
    const { root, data, copy } = scratch();
    mkdirSync(join(data, "db"), { recursive: true });
    const sink = memory();
    const summary = await copyData(data, join(root, "staging"), sink, { folder: "vault", takenAt: T, maxBytes: 1 << 20, live: [{ folder: "db/main", source: copy }] });
    expect(summary.fromBackupCommand).toEqual(["db/main"]);
    const destination = join(root, "restored");
    mkdirSync(destination);
    await extractData(sink.stream(), destination, { maxEntries: 100, maxBytes: 1 << 20 });
    expect(readFileSync(join(destination, "db", "main", "state"), "utf8")).toBe("consistent");
  });

  test("a declared folder under a file of the data is refused, rather than archived as no restore would take it", async () => {
    const { root, data, copy } = scratch();
    mkdirSync(data);
    writeFileSync(join(data, "db"), "a file where a folder should be");
    const error = await copyData(data, join(root, "staging"), memory(), { folder: "vault", takenAt: T, maxBytes: 1 << 20, live: [{ folder: "db/main", source: copy }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CopyError);
    expect((error as CopyError).message).toBe("a folder a backup command saves is not reached through plain folders of the data");
  });

  test("a live folder with no copy, the services running, is never archived as it is", async () => {
    const { root, data } = scratch();
    liveCluster(join(data, "db"));
    const error = await copyData(data, join(root, "staging"), memory(), { folder: "vault", takenAt: T, maxBytes: 1 << 20, live: [{ folder: "db", source: null }] }).catch((caught: unknown) => caught);
    expect((error as CopyError).message).toBe("a service's backup command did not run before the copy");
  });
});

describe("a backup command's unit", () => {
  const manifest = {
    slug: "vault",
    publicDir: "public",
    env: { PUBLIC_URL: "https://{slug}.{zone}", RATIO: "100%" },
    secrets: ["VAULT_KEY"],
    services: {
      web: { start: "/usr/local/bin/bun run web.ts", port: 3040 },
      db: { start: "/bin/sh /srv/sites/vault/app/postgres.sh", port: 3041, internal: true, memory: "512M", backup: { folder: "db", command: "/bin/sh /srv/sites/vault/app/backup.sh" } },
    },
  } as Manifest;
  // Its service's unit installed as this release lays it.
  const config = { ...configFrom({ SITESOLIDE_ZONE: "test-zone.invalid" }, { bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js" }), unitsFolder: installedUnits(manifest, "current") };
  const vaultProject = { folder: "vault", account: "site-vault", owner: { uid: 1042, gid: 1042 }, dataDir: "/srv/sites/vault/data", manifest };
  const place = staging(config, "vault");
  const found = projectHooks(vaultProject, place.path);
  if ("error" in found) throw new Error(found.error);
  const [hook] = found.hooks;
  const job = hookJob(config, vaultProject, hook!, 600_000, place.cacheDirectory);
  const command = childCommand(job, config, "a1b2c3d4");
  const unit = generateUnits(manifest, { slug: "vault", zone: "test-zone.invalid", contact: "" }).find((generated) => generated.unit === "vault.db")!.text;
  const lines = unit.split("\n");
  const properties = command.flatMap((argument, index) => (command[index - 1] === "-p" ? [argument] : []));

  test("goes through systemd-run as the project's account, its folder in the copy's staging", () => {
    expect(command.slice(0, 11)).toEqual([
      "/usr/bin/systemd-run",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      "--unit=sitesolide-backup-hook-vault-a1b2c3d4.service",
      "--description=Backup hook of vault",
      "--uid=site-vault",
      "--gid=site-vault",
      "--nice=10",
    ]);
    // The uid it must run as comes as an argument: this unit's environment is
    // the project's to set, through its env and its secret files.
    expect(command.some((argument) => argument.includes("BACKUP_EXPECTED_UID"))).toBe(false);
    expect(hook!.backupDir).toBe("/var/cache/sitesolide-backup/vault/hooks/vault.db");
    expect(properties).toContain("CacheDirectory=sitesolide-backup/vault");
    expect(properties).toContain("CacheDirectoryMode=0700");
  });

  test("runs the command's words through the hook mode, nothing in between", () => {
    expect(command.slice(command.indexOf("--") + 1)).toEqual([
      "/usr/local/bin/bun",
      "/usr/local/lib/sitesolide/backup.js",
      "hook",
      "1042",
      "/var/cache/sitesolide-backup/vault/hooks/vault.db",
      String(600_000 - HOOK_GRACE_MS),
      "/bin/sh",
      "/srv/sites/vault/app/backup.sh",
    ]);
  });

  test("is confined at least like its service, the loopback kept", () => {
    const wanted = lines
      .filter((line) =>
        /^(NoNewPrivileges|PrivateTmp|PrivateDevices|ProtectSystem|ProtectHome|ReadWritePaths|TemporaryFileSystem|BindPaths|BindReadOnlyPaths|InaccessiblePaths|ProtectProc|ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|RestrictNamespaces|RestrictSUIDSGID|RestrictRealtime|LockPersonality|UMask|IPAddressDeny|IPAddressAllow|SocketBindDeny|MemoryMax)=/.test(line),
      )
      .map((line) => line.replace(/^(\w+)=true$/, "$1=yes"));
    expect(wanted).toContain("IPAddressAllow=localhost");
    // The loopback kept, the machine's ports stay its owners': a command run
    // every hour must not listen where a neighbour or the portal restarts.
    expect(wanted).toContain("SocketBindDeny=3000-3099");
    expect(wanted).toContain("SocketBindDeny=21000-29999");
    expect(confinement(job).some((property) => property.startsWith("SocketBindAllow"))).toBe(false);
    expect(wanted).toContain("BindReadOnlyPaths=/srv/sites/vault/app");
    expect(wanted).toContain("MemoryMax=512M");
    for (const line of wanted.filter((line) => !line.startsWith("MemoryMax="))) expect(confinement(job)).toContain(line);
    // Its service's ceiling, and room for the program that runs the command.
    expect(confinement(job)).toContain("MemoryMax=640M");
    // /etc/sitesolide hidden from both, the secrets reaching each through PID 1
    // all the same, and the processes of other accounts too.
    expect(wanted).toContain("InaccessiblePaths=-/etc/sitesolide");
    expect(wanted).toContain("ProtectProc=invisible");
    expect(confinement(job)).not.toContain("DynamicUser=yes");
    expect(confinement(job).some((property) => property.startsWith("RestrictAddressFamilies"))).toBe(false);
    expect(confinement(job)).toContain("RuntimeMaxSec=600");
  });

  test("its environment is its service's, BACKUP_DIR last, values as the service receives them", () => {
    const fromUnit = lines.filter((line) => line.startsWith("Environment=")).map((line) => line.slice("Environment=".length).replaceAll("%%", "%"));
    const given = command.filter((argument) => argument.startsWith("--setenv=") && !argument.includes("BACKUP_EXPECTED_UID")).map((argument) => argument.slice("--setenv=".length));
    expect(given).toEqual([...fromUnit, "BACKUP_DIR=/var/cache/sitesolide-backup/vault/hooks/vault.db"]);
    expect(given).toContain("PUBLIC_URL=https://vault.test-zone.invalid");
    expect(given).toContain("RATIO=100%");
  });

  test("its secrets are read by PID 1 from its store, as its service reads it, never put on the command line", () => {
    const files = lines.filter((line) => line.startsWith("EnvironmentFile="));
    expect(files).toEqual(["EnvironmentFile=-/etc/sitesolide/projects/vault/env"]);
    expect(properties.filter((property) => property.startsWith("EnvironmentFile="))).toEqual(files);
    // Its files as its service loads them, each at $CREDENTIALS_DIRECTORY/files_<name>.
    const credentials = lines.filter((line) => line.startsWith("LoadCredential="));
    expect(credentials).toEqual(["LoadCredential=files:/etc/sitesolide/projects/vault/files"]);
    expect(properties.filter((property) => property.startsWith("LoadCredential="))).toEqual(credentials);
    expect(properties).toContain("WorkingDirectory=/srv/sites/vault/app");
    // No placeholder, no credentials path, no %d: systemd sets CREDENTIALS_DIRECTORY itself.
    expect(command.some((argument) => /%d|\/run\/credentials|CREDENTIALS_DIRECTORY/.test(argument))).toBe(false);
  });

  test("with no isolation, the same mode as a plain child", () => {
    expect(childCommand(job, { ...config, isolation: "none" })).toEqual(["/usr/local/bin/bun", "/usr/local/lib/sitesolide/backup.js", "hook", ...job.args]);
  });

  test("the removal of its copy runs as the project, with no network and nothing of /srv", () => {
    const removal = discardJob(vaultProject, place.path, place.cacheDirectory);
    expect(removal.args).toEqual(["/var/cache/sitesolide-backup/vault/hooks"]);
    expect(confinement(removal)).toContain("IPAddressDeny=any");
    expect(confinement(removal)).not.toContain("IPAddressAllow=localhost");
    expect(confinement(removal).filter((property) => property.startsWith("Bind"))).toEqual([]);
    expect(childCommand(removal, config, "00ff00ff")).toContain("--uid=site-vault");
  });

  test("a manifest naming another slug runs no command", () => {
    expect(projectHooks({ ...vaultProject, manifest: { ...manifest, slug: "other" } }, place.path)).toEqual({ error: "its sitesolide.json names another slug, so its backup commands cannot be run safely" });
  });
});

describe("a worker's backup command", () => {
  test("is told no port, as its unit is not: it listens on nothing, the rest of its environment as its service has it", () => {
    const manifest = {
      slug: "vault",
      publicDir: "public",
      services: {
        web: { start: "/usr/local/bin/bun run web.ts", port: 3040 },
        indexer: { start: "/usr/local/bin/bun run indexer.ts", internal: true, backup: { folder: "index", command: "/usr/local/bin/bun run snapshot.ts" } },
      },
    } as Manifest;
    const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid" }, { bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js" });
    const project = { folder: "vault", account: "site-vault", owner: { uid: 1042, gid: 1042 }, dataDir: "/srv/sites/vault/data", manifest };
    const place = staging(config, "vault");
    const found = projectHooks(project, place.path);
    if ("error" in found) throw new Error(found.error);
    expect(found.hooks.map((hook) => hook.service.kind)).toEqual(["worker"]);
    const job = hookJob(config, project, found.hooks[0]!, 600_000, place.cacheDirectory);
    expect(job.environment!.map(([name]) => name)).toEqual(["DATA_DIR", "PUBLIC_DIR", "BACKUP_DIR"]);
    const unit = generateUnits(manifest, { slug: "vault", zone: "test-zone.invalid", contact: "" }).find((generated) => generated.unit === "vault.indexer")!.text;
    expect(unit).not.toContain("Environment=PORT=");
    const given = childCommand(job, config, "a1b2c3d4").filter((argument) => argument.startsWith("--setenv=") && !argument.includes("BACKUP_EXPECTED_UID"));
    expect(given).toEqual(["--setenv=DATA_DIR=/srv/sites/vault/data", "--setenv=PUBLIC_DIR=/srv/sites/vault/public", "--setenv=BACKUP_DIR=/var/cache/sitesolide-backup/vault/hooks/vault.indexer"]);
  });
});

/**
 * A backup command gets its project's store as its service does: the store's
 * env file by EnvironmentFile=, the files folder by LoadCredential=, and the
 * processes of other accounts hidden. Measured on the runner's own line on
 * systemd 257 (the store's bench, Q8): CREDENTIALS_DIRECTORY set, the files
 * read, and a missing folder failing systemd-run with 243.
 */
describe("a backup command and its project's store", () => {
  const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid" }, { bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js" });
  const backup = { folder: "db", command: "/bin/sh /srv/sites/vault/app/backup.sh" };
  /** The command's job, its service's units installed as `how` says, or in the folder given. */
  const jobOf = (manifest: Manifest, how: "current" | "0.7" | "none" | { folder: string } = "current") => {
    const project = { folder: manifest.slug, account: `site-${manifest.slug}`, owner: { uid: 1042, gid: 1042 }, dataDir: `/srv/sites/${manifest.slug}/data`, manifest };
    const place = staging(config, manifest.slug);
    const found = projectHooks(project, place.path);
    if ("error" in found) throw new Error(found.error);
    const unitsFolder = typeof how === "string" ? installedUnits(manifest, how) : how.folder;
    return hookJob({ ...config, unitsFolder }, project, found.hooks[0]!, 600_000, place.cacheDirectory);
  };
  const propertiesOf = (job: Job) => {
    const command = childCommand(job, config, "a1b2c3d4");
    return command.flatMap((argument, index) => (command[index - 1] === "-p" ? [argument] : []));
  };

  test("the names form, or no secret at all: the store alone, its env file and its files", () => {
    for (const secrets of [["API_KEY"], { runtime: ["API_KEY"], files: ["tls.key"] }, undefined]) {
      const job = jobOf({ slug: "vault", port: 3041, start: "/bin/sh db.sh", backup, ...(secrets === undefined ? {} : { secrets }) } as Manifest);
      expect(job.environmentFiles).toEqual([storeEnvironmentFile("vault")]);
      expect(job.environmentFiles).toEqual(["-/etc/sitesolide/projects/vault/env"]);
      expect(job.credentials).toEqual([storeCredentials("vault")]);
      expect(job.credentials).toEqual(["files:/etc/sitesolide/projects/vault/files"]);
      expect(propertiesOf(job).filter((property) => /^(EnvironmentFile|LoadCredential)=/.test(property))).toEqual([
        "EnvironmentFile=-/etc/sitesolide/projects/vault/env",
        "LoadCredential=files:/etc/sitesolide/projects/vault/files",
      ]);
    }
  });

  test("a service whose unit 0.7 laid reads no store: its command gets none either, its files/ folder perhaps not laid yet", () => {
    // Between the dashboard's upgrade and the project's next deployment. Given
    // LoadCredential= from the manifest, a folder not laid yet failed every
    // snapshot of the project with 243 (review finding M1).
    for (const secrets of [["API_KEY"], { runtime: ["API_KEY"], files: ["tls.key"] }, undefined]) {
      const job = jobOf({ slug: "vault", port: 3041, start: "/bin/sh db.sh", backup, ...(secrets === undefined ? {} : { secrets }) } as Manifest, "0.7");
      expect(job.environmentFiles).toEqual([]);
      expect(job.credentials).toEqual([]);
      expect(propertiesOf(job).some((property) => property.startsWith("LoadCredential=") || property.includes("/projects/"))).toBe(false);
    }
  });

  test("its own service's unit decides, not the project's main one", () => {
    const manifest = { slug: "vault", services: { web: { start: "/usr/local/bin/bun run web.ts", port: 3040 }, db: { start: "/bin/sh db.sh", port: 3041, internal: true, backup } }, secrets: ["API_KEY"] } as Manifest;
    const folder = installedUnits(manifest, "current");
    // The database's unit still 0.7's, the front's this release's.
    writeFileSync(join(folder, "vault.db.service"), withoutStoreLines(readFileSync(join(folder, "vault.db.service"), "utf8")));
    expect(jobOf(manifest, { folder }).credentials).toEqual([]);
    expect(jobOf(manifest, "current").credentials).toEqual(["files:/etc/sitesolide/projects/vault/files"]);
  });

  test("a store folder no deploy laid never yields a LoadCredential line: no unit, a link, a unit too big, or one edited by hand", () => {
    const manifest = { slug: "vault", port: 3041, start: "/bin/sh db.sh", backup, secrets: { files: ["tls.key"] } } as Manifest;
    const current = readFileSync(join(installedUnits(manifest, "current"), "vault.service"), "utf8");
    const credentialsOf = (write: (folder: string) => void) => {
      const folder = mkdtempSync(join(tmpdir(), "backup-units-"));
      roots.push(folder);
      write(folder);
      return jobOf(manifest, { folder }).credentials;
    };
    // The unit itself, as a reference.
    expect(credentialsOf((folder) => writeFileSync(join(folder, "vault.service"), current))).toEqual(["files:/etc/sitesolide/projects/vault/files"]);
    // Never deployed as an app, or its unit gone.
    expect(credentialsOf(() => undefined)).toEqual([]);
    // A link is not read, wherever it points.
    expect(
      credentialsOf((folder) => {
        writeFileSync(join(folder, "elsewhere"), current);
        symlinkSync(join(folder, "elsewhere"), join(folder, "vault.service"));
      }),
    ).toEqual([]);
    // Past the bound a unit has no reason to reach.
    expect(credentialsOf((folder) => writeFileSync(join(folder, "vault.service"), `${current}${"#".repeat(256 * 1024)}\n`))).toEqual([]);
    // Edited by hand: the line in a comment, outside [Service], or naming another project's store or another path.
    const loads = "LoadCredential=files:/etc/sitesolide/projects/vault/files\n";
    for (const edited of [
      current.replace(loads, `# ${loads}`),
      current.replace(loads, "").replace("[Install]\n", `[Install]\n${loads}`),
      current.replace(loads, "LoadCredential=files:/etc/sitesolide/projects/other/files\n"),
      current.replace(loads, "LoadCredential=key:/etc/ssl/private/vault.pem\n"),
      current.replace(loads, "LoadCredential=files:/etc/sitesolide/projects/vault/files/\n"),
    ]) {
      expect(credentialsOf((folder) => writeFileSync(join(folder, "vault.service"), edited))).toEqual([]);
    }
  });

  test("the store's lines of an installed unit, read exactly, each on its own", () => {
    const service = (...lines: string[]) => ["[Unit]", "Description=x", "", "[Service]", ...lines, "", "[Install]", "WantedBy=multi-user.target", ""].join("\n");
    const env = "EnvironmentFile=-/etc/sitesolide/projects/vault/env";
    const files = "LoadCredential=files:/etc/sitesolide/projects/vault/files";
    expect(unitStoreLines(service(env, files), "vault")).toEqual({ environmentFiles: ["-/etc/sitesolide/projects/vault/env"], credentials: ["files:/etc/sitesolide/projects/vault/files"] });
    expect(unitStoreLines(service(env), "vault")).toEqual({ environmentFiles: ["-/etc/sitesolide/projects/vault/env"], credentials: [] });
    expect(unitStoreLines(service(files), "vault")).toEqual({ environmentFiles: [], credentials: ["files:/etc/sitesolide/projects/vault/files"] });
    // Indented, or twice: once.
    expect(unitStoreLines(service(`  ${files}`, files), "vault").credentials).toEqual(["files:/etc/sitesolide/projects/vault/files"]);
    expect(unitStoreLines(service(env, files), "other")).toEqual({ environmentFiles: [], credentials: [] });
    expect(unitStoreLines(service("EnvironmentFile=/etc/sitesolide/projects/vault/env"), "vault").environmentFiles).toEqual([]);
    expect(unitStoreLines(null, "vault")).toEqual({ environmentFiles: [], credentials: [] });
    // A storeless slug or one that is not a project's reads none, whatever its unit says.
    expect(unitStoreLines(service("LoadCredential=files:/etc/sitesolide/projects/dashboard/files"), "dashboard").credentials).toEqual([]);
    expect(unitStoreLines(service(files), "../vault")).toEqual({ environmentFiles: [], credentials: [] });
  });

  test("an installed unit is read as a plain file, by its unit's file name", () => {
    const folder = mkdtempSync(join(tmpdir(), "backup-units-"));
    roots.push(folder);
    writeFileSync(join(folder, "vault.db.service"), "[Service]\n");
    expect(installedUnit(folder, "vault.db")).toBe("[Service]\n");
    expect(installedUnit(folder, "vault")).toBeNull();
    mkdirSync(join(folder, "vault.service"));
    expect(installedUnit(folder, "vault")).toBeNull();
  });

  test("after the upgrade, a project still on its 0.7 unit keeps its snapshot; on this release's, its command gets the files", async () => {
    // A systemd-run that fails as PID 1 does when the folder LoadCredential=
    // names is missing (bench Q8): 243, the command never run.
    const root = mkdtempSync(join(tmpdir(), "backup-m1-"));
    roots.push(root);
    const systemdRun = join(root, "systemd-run");
    writeFileSync(systemdRun, '#!/bin/sh\nfor argument; do case "$argument" in LoadCredential=*) exit 243 ;; esac; done\nexit 0\n', { mode: 0o755 });
    const manifest = { slug: "vault", port: 3041, start: "/bin/sh db.sh", backup, secrets: ["API_KEY"] } as Manifest;
    const project = { folder: "vault", account: "site-vault", owner: { uid: 1042, gid: 1042 }, dataDir: join(root, "data"), manifest };
    const found = projectHooks(project, join(root, "staging"));
    if ("error" in found) throw new Error(found.error);
    const ran = async (how: "current" | "0.7") => {
      const journal: string[] = [];
      const outcome = await runHooks({ ...config, systemdRun, unitsFolder: installedUnits(manifest, how) }, project, found.hooks, Date.now() + 30_000, null, (line) => journal.push(line));
      return { outcome, journal };
    };
    const before = await ran("0.7");
    expect(before.outcome).toEqual({ ok: true });
    expect(before.journal).toEqual(["backup vault: the backup command left its copy of db"]);
    // Laid by a deploy, the unit comes with its folder; were it gone, the
    // command fails as its service would, and says why.
    const after = await ran("current");
    expect(after.outcome).toEqual({ ok: false, error: credentialsFailure("the backup command", "vault"), cause: null });
  });

  test("dashboard and portal have no store: no store line (I10)", () => {
    for (const slug of ["dashboard", "portal"]) {
      const job = jobOf({ slug, port: 3041, start: "/bin/sh db.sh", backup } as Manifest);
      expect(job.environmentFiles).toEqual([]);
      expect(job.credentials).toEqual([]);
      expect(propertiesOf(job).some((property) => property.startsWith("LoadCredential=") || property.includes("/projects/"))).toBe(false);
    }
  });

  test("its line is the one the bench ran, with the store's files, ProtectProc and the second block added, and nothing else", () => {
    // The line bench/hookline.ts built with the runner of main for project
    // demo (hookline.json), which systemd 257 ran with the store's env file;
    // Q8b added LoadCredential=files:<store>/files to it, and read the files.
    const bench = ["/usr/bin/systemd-run","--quiet","--wait","--pipe","--collect","--service-type=exec","--unit=sitesolide-backup-hook-demo-bench.service","--description=Backup hook of demo","--uid=site-demo","--gid=site-demo","--nice=10","--setenv=PORT=3010","--setenv=DATA_DIR=/srv/sites/demo/data","--setenv=PUBLIC_DIR=/srv/sites/demo/public","--setenv=BACKUP_DIR=/srv/sites/demo/data/.backup","-p","EnvironmentFile=-/etc/sitesolide/projects/demo/env","-p","WorkingDirectory=/srv/sites/demo/app","-p","UMask=0077","-p","NoNewPrivileges=yes","-p","PrivateTmp=yes","-p","PrivateDevices=yes","-p","ProtectSystem=strict","-p","ProtectHome=yes","-p","ReadWritePaths=/srv/sites/demo/data","-p","TemporaryFileSystem=/srv:ro","-p","BindReadOnlyPaths=/srv/sites/demo/app","-p","BindReadOnlyPaths=/srv/sites/demo/public","-p","BindPaths=/srv/sites/demo/data","-p","InaccessiblePaths=-/etc/sitesolide","-p","InaccessiblePaths=-/var/lib/sitesolide-steward","-p","InaccessiblePaths=-/var/backups","-p","ProtectKernelTunables=yes","-p","ProtectKernelModules=yes","-p","ProtectControlGroups=yes","-p","RestrictNamespaces=yes","-p","RestrictSUIDSGID=yes","-p","RestrictRealtime=yes","-p","LockPersonality=yes","-p","MemoryMax=384M","-p","IPAddressDeny=any","-p","IPAddressAllow=localhost","-p","SocketBindDeny=2019","-p","SocketBindDeny=3000-3099","-p","SocketBindDeny=3128-3129","-p","IOSchedulingClass=idle","-p","RuntimeMaxSec=60","-p","TimeoutStopSec=15s","--","/bin/sh","/srv/sites/demo/app/hookprobe.sh","hook","997","/srv/sites/demo/data/.backup","55000"];
    const job: Job = {
      mode: "hook",
      folder: "demo",
      account: "site-demo",
      uid: 997,
      args: ["997", "/srv/sites/demo/data/.backup", "55000"],
      readWrite: ["/srv/sites/demo/data"],
      bind: ["/srv/sites/demo/data"],
      bindReadOnly: ["/srv/sites/demo/app", "/srv/sites/demo/public"],
      cacheDirectory: null,
      stdin: null,
      stdout: "ignore",
      timeoutMs: 60000,
      loopback: true,
      environment: [["PORT", "3010"], ["DATA_DIR", "/srv/sites/demo/data"], ["PUBLIC_DIR", "/srv/sites/demo/public"], ["BACKUP_DIR", "/srv/sites/demo/data/.backup"]],
      environmentFiles: [storeEnvironmentFile("demo")],
      credentials: [storeCredentials("demo")],
      workingDirectory: "/srv/sites/demo/app",
      memory: "384M",
    };
    const line = childCommand(job, { isolation: "systemd", systemdRun: "/usr/bin/systemd-run", bun: "/bin/sh", script: "/srv/sites/demo/app/hookprobe.sh", offsiteFile: "/unused" }, "bench");
    const added = (properties: string[]) => {
      const removed = [...line];
      for (const property of properties) {
        const at = removed.indexOf(property);
        expect({ property, found: at > 0 && removed[at - 1] === "-p" }).toEqual({ property, found: true });
        removed.splice(at - 1, 2);
      }
      return removed;
    };
    // And the second block of the services' ports, denied since: the bench
    // ran before it existed.
    expect(added(["LoadCredential=files:/etc/sitesolide/projects/demo/files", "ProtectProc=invisible", "SocketBindDeny=21000-29999"])).toEqual(bench);
    // ${CREDENTIALS_DIRECTORY} on a command's line is systemd's to expand there:
    // the runner never turns that off, as the installer's line does.
    expect(line).not.toContain("--expand-environment=no");
  });

  test("a command naming one of its files through ${CREDENTIALS_DIRECTORY} is run as written, systemd expanding it", () => {
    const job = jobOf({ slug: "vault", port: 3041, start: "/bin/sh db.sh", backup: { folder: "db", command: "/bin/sh /srv/sites/vault/app/backup.sh ${CREDENTIALS_DIRECTORY}/files_tls.key" }, secrets: { files: ["tls.key"] } } as Manifest);
    expect(childCommand(job, config, "a1b2c3d4").at(-1)).toBe("${CREDENTIALS_DIRECTORY}/files_tls.key");
  });

  test("every child hides the processes of other accounts, whatever its mode", () => {
    const base: Job = { mode: "copy", folder: "vault", account: "site-vault", uid: 1042, args: [], readWrite: [], bind: [], cacheDirectory: null, stdin: null, stdout: "ignore", timeoutMs: 60_000 };
    const jobs: Job[] = [
      base,
      { ...base, mode: "extract" },
      { ...base, mode: "measure" },
      { ...base, mode: "discard" },
      { ...base, mode: "hook", loopback: true },
      { ...base, mode: "download", account: null, uid: null, offsite: null },
      { ...base, folder: "machine", account: null, uid: null, readAll: true },
    ];
    for (const job of jobs) {
      const properties = confinement(job);
      expect({ mode: job.mode, readAll: job.readAll === true, count: properties.filter((property) => property === "ProtectProc=invisible").length }).toEqual({ mode: job.mode, readAll: job.readAll === true, count: 1 });
      expect(properties.some((property) => /^(PrivatePIDs|ProcSubset)=/.test(property))).toBe(false);
    }
    // A child that is not a backup command loads no credential.
    expect(childCommand(base, config, "a1b2c3d4").some((argument) => argument.startsWith("LoadCredential="))).toBe(false);
  });

  test("a command whose unit could not load its secret files (243) is said so, not as a failure of the command", async () => {
    const root = mkdtempSync(join(tmpdir(), "backup-243-"));
    roots.push(root);
    // systemd-run returns the unit's status: 243 when its credentials could
    // not be set up, before the command ever ran. A program exiting 243
    // stands for it here, with no isolation.
    const fails = join(root, "credentials.sh");
    writeFileSync(fails, "exit 243\n");
    const plain = configFrom({ BACKUP_ISOLATION: "none", SITESOLIDE_ZONE: "test-zone.invalid", BACKUP_REPOSITORY: join(root, "repository") }, { bun: "/bin/sh", script: fails });
    const manifest = { slug: "vault", port: 3041, start: "/bin/sh db.sh", backup, secrets: { files: ["tls.key"] } } as Manifest;
    const project = { folder: "vault", account: "site-vault", owner: null, dataDir: join(root, "data"), manifest };
    const found = projectHooks(project, join(root, "staging"));
    if ("error" in found) throw new Error(found.error);
    const journal: string[] = [];
    const outcome = await runHooks(plain, project, found.hooks, Date.now() + 30_000, null, (line) => journal.push(line));
    expect(CREDENTIALS_EXIT_STATUS).toBe(243);
    expect(outcome).toEqual({ ok: false, error: credentialsFailure("the backup command", "vault"), cause: null });
    expect(outcome).toEqual({
      ok: false,
      error: "the backup command could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh vault lays the folder again",
      cause: null,
    });
    expect(journal.some((line) => line.includes("failed, exit code 243"))).toBe(true);
  });
});
