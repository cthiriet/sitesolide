import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { snapshotName } from "../borrowed/backups";
import {
  clearStaleLocks,
  commandLines,
  forgetSnapshots,
  localRepository,
  readBackupSummary,
  readListing,
  readStored,
  resticCommand,
  resticEnvironment,
  resticFailure,
  resticLines,
  resticTime,
  runExclusive,
  runRestic,
  SNAPSHOT_HOST,
} from "../src/backup/restic";
import { bucketRepository } from "../src/backup/offsite";
import { takeSnapshot, TIMEOUT_ERROR } from "../src/backup/snapshot";
import { names, NO_RESTIC, project, restic, tree } from "./backup-fixtures";

/**
 * What the component asks of restic, and what restic does that the design
 * leans on, run against restic itself on its local backend: a snapshot only
 * when the command it runs exits 0, a stale lock removed and an exclusive call
 * tried again, the exit codes turned into fixed sentences, the copy's report
 * kept under the 64 KiB per line restic forwards, a snapshot that does not
 * read back forgotten.
 */
setDefaultTimeout(120_000);
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function made() {
  const machine = tree();
  roots.push(machine.root);
  return machine;
}

describe("restic's environment and command line", () => {
  const config = { resticCache: "/var/cache/sitesolide-restic", restic: "/usr/bin/restic", choom: "/usr/bin/choom", isolation: "systemd" as const };
  const local = localRepository({ repository: "/var/backups/sitesolide-restic", repositoryKey: "/var/backups/sitesolide-restic.key" });
  const offsite = { endpoint: "https://e.invalid", bucket: "b", region: "fsn1", accessKeyId: "AKID", secretAccessKey: "SECRET", prefix: "p", passphrase: "PASSPHRASE-LONG-ENOUGH", repository: "s3:https://e.invalid/b/p-restic" };

  test("is built from nothing: the zone, its bounds, its cache, its repository and its password", () => {
    expect(resticEnvironment(config, local)).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TZ: "UTC",
      GOMAXPROCS: "2",
      GOMEMLIMIT: "128MiB",
      RESTIC_CACHE_DIR: "/var/cache/sitesolide-restic",
      TMPDIR: "/var/cache/sitesolide-restic/tmp",
      RESTIC_REPOSITORY: "/var/backups/sitesolide-restic",
      RESTIC_PASSWORD_FILE: "/var/backups/sitesolide-restic.key",
    });
  });

  test("hands the bucket's credentials to the calls to the bucket alone, the local password as a file", () => {
    const bucket = resticEnvironment(config, bucketRepository(offsite), local);
    expect(bucket).toMatchObject({
      RESTIC_REPOSITORY: "s3:https://e.invalid/b/p-restic",
      RESTIC_PASSWORD: "PASSPHRASE-LONG-ENOUGH",
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "SECRET",
      AWS_DEFAULT_REGION: "fsn1",
      RESTIC_FROM_REPOSITORY: "/var/backups/sitesolide-restic",
      RESTIC_FROM_PASSWORD_FILE: "/var/backups/sitesolide-restic.key",
    });
    expect(Object.keys(resticEnvironment(config, local)).some((name) => name.startsWith("AWS_"))).toBe(false);
  });

  test("runs through choom under systemd, two connections per backend, and plain on the workstation", () => {
    expect(resticCommand(config, ["snapshots"])).toEqual(["/usr/bin/choom", "-n", "1000", "--", "/usr/bin/restic", "-o", "local.connections=2", "-o", "s3.connections=2", "snapshots"]);
    expect(resticCommand({ ...config, isolation: "none" }, ["snapshots"])[0]).toBe("/usr/bin/restic");
  });

  test("--time is the UTC second, as restic reads it with TZ=UTC", () => {
    expect(resticTime(T + 999)).toBe("2026-10-04 13:00:00");
  });
});

describe("what restic answers, read", () => {
  const ours = { id: "a".repeat(64), time: "2026-10-04T13:00:00Z", paths: ["/cms.tar"], hostname: SNAPSHOT_HOST, tags: ["scheduled"], summary: { total_bytes_processed: 100, data_added_packed: 40 } };

  test("one of our snapshots, its name drawn from its path, time and tag", () => {
    expect(readStored(ours)).toEqual({ id: "a".repeat(64), name: snapshotName("cms", T, "scheduled"), folder: "cms", takenAt: T, kind: "scheduled", bytes: 100, added: 40 });
    expect(readStored({ ...ours, tags: ["pre-restore"], time: "2026-10-04T15:00:00+02:00" })?.name).toBe(snapshotName("cms", T, "pre-restore"));
  });

  test("a snapshot made by hand, or by anything else, is never ours", () => {
    for (const other of [
      { ...ours, hostname: "a-workstation" },
      { ...ours, paths: ["/srv/sites/cms/data"] },
      { ...ours, paths: ["/../etc.tar"] },
      { ...ours, tags: [] },
      { ...ours, tags: ["scheduled", "extra"] },
      { ...ours, time: "2026-10-04T13:00:00.5Z" },
      { ...ours, id: "short" },
    ]) {
      expect(readStored(other)).toBeNull();
    }
    expect(readListing(JSON.stringify([ours, { ...ours, hostname: "elsewhere" }]))).toHaveLength(1);
    expect(() => readListing("{}")).toThrow();
  });

  test("a backup's summary names the snapshot it saved", () => {
    const stdout = `${JSON.stringify({ message_type: "status", percent_done: 1 })}\n${JSON.stringify({ message_type: "summary", snapshot_id: "b".repeat(64), total_bytes_processed: 10, data_added_packed: 3 })}\n`;
    expect(readBackupSummary(stdout)).toEqual({ id: "b".repeat(64), bytes: 10, added: 3 });
    expect(readBackupSummary(JSON.stringify({ message_type: "summary", dry_run: true }))).toBeNull();
  });

  test("the command's lines are told from restic's own", () => {
    const stderr = 'subprocess bun: {"event":"summary","files":1}\n{"message_type":"exit_error","code":1,"message":"x"}\nsubprocess systemd-run: noise\n';
    expect(commandLines(stderr)).toBe('{"event":"summary","files":1}\nnoise');
    expect(resticLines(stderr)).toBe('{"message_type":"exit_error","code":1,"message":"x"}');
  });

  test("every exit code is a fixed sentence, which quotes nothing restic said", () => {
    const local = { store: "local" as const };
    const offsite = { store: "offsite" as const };
    expect(resticFailure({ code: 10 }, local)).toBe("the server's repository does not exist: run bin/deploy-backup.sh install");
    expect(resticFailure({ code: 11 }, local)).toBe("the repository is locked by another restic process, see the journal of sitesolide-backup");
    expect(resticFailure({ code: 12 }, offsite)).toContain("does not open with BACKUP_ENCRYPTION_PASSPHRASE");
    expect(resticFailure({ code: null }, local)).toBe("restic did not finish in time, see the journal of sitesolide-backup");
    expect(resticFailure({ code: 42 }, local)).toBe("restic failed (exit code 42), see the journal of sitesolide-backup");
  });
});

describe.concurrent.skipIf(NO_RESTIC)("restic itself, on its local backend", () => {
  test("a command that fails, or is killed, leaves no snapshot", async () => {
    const { config } = made();
    const local = localRepository(config);
    const args = ["backup", "--json", "-q", "--host", SNAPSHOT_HOST, "--tag", "scheduled", "--time", resticTime(T), "--stdin-filename", "cms.tar", "--stdin-from-command", "--"];
    const failed = await runRestic(config, local, [...args, "sh", "-c", "head -c 100000 /dev/zero; exit 3"], Date.now() + 60_000);
    expect(failed.code).toBe(1);
    const killed = await runRestic(config, local, [...args, "sh", "-c", "head -c 100000 /dev/zero; kill -9 $$"], Date.now() + 60_000);
    expect(killed.code).toBe(1);
    expect(names(config, "cms")).toEqual([]);
    const done = await runRestic(config, local, [...args, "printf", "a tar"], Date.now() + 60_000);
    expect(done.code).toBe(0);
    expect(readBackupSummary(done.stdout)).not.toBeNull();
    expect(names(config, "cms")).toEqual([snapshotName("cms", T, "scheduled")]);
  });

  test("restic stopped at its deadline saves nothing, and removes its lock", async () => {
    const { config } = made();
    const local = localRepository(config);
    const args = ["backup", "-q", "--host", SNAPSHOT_HOST, "--tag", "scheduled", "--time", resticTime(T), "--stdin-filename", "cms.tar", "--stdin-from-command", "--", "sh", "-c", "head -c 100000 /dev/zero; exec sleep 30"];
    const stopped = await runRestic(config, local, args, Date.now() + 3000);
    expect(stopped.code).toBeNull();
    expect(names(config, "cms")).toEqual([]);
    expect(readdirSync(join(config.repository, "locks"))).toEqual([]);
  });

  test("a lock left by a restic killed outright blocks forget, until the stale locks are removed", async () => {
    const { config } = made();
    const local = localRepository(config);
    // What restic calls a lock; the local backend may also leave the temporary file it was writing.
    const locks = () => readdirSync(join(config.repository, "locks")).filter((name) => !name.includes("-tmp-"));
    expect(restic(config, ["backup", "-q", "--host", SNAPSHOT_HOST, "--tag", "scheduled", "--time", resticTime(T), "--stdin-filename", "cms.tar", "--stdin-from-command", "--", "printf", "x"]).code).toBe(0);
    const id = JSON.parse(restic(config, ["snapshots", "--json", "-q"]).stdout.toString())[0].id as string;
    // A backup killed with SIGKILL leaves its lock behind.
    const hung = Bun.spawn([config.restic, "-r", config.repository, "--password-file", config.repositoryKey, "backup", "--stdin-filename", "x.tar", "--stdin-from-command", "--", "sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: Bun.env.PATH ?? "", RESTIC_CACHE_DIR: config.resticCache },
    });
    while (locks().length === 0) await Bun.sleep(100);
    hung.kill("SIGKILL");
    await hung.exited;
    expect(locks()).toHaveLength(1);
    expect((await runRestic(config, local, ["forget", "-q", id], Date.now() + 60_000)).code).toBe(11);
    // The exclusive call removes what is stale, and is tried once more.
    const forgotten = await runExclusive(config, local, ["forget", "-q", id], Date.now() + 60_000, silent);
    expect(forgotten.code).toBe(0);
    expect(names(config, "cms")).toEqual([]);
    // And a run clears them before it starts.
    const again = Bun.spawn([config.restic, "-r", config.repository, "--password-file", config.repositoryKey, "backup", "--stdin-filename", "x.tar", "--stdin-from-command", "--", "sleep", "30"], {
      stdin: "ignore",
      env: { PATH: Bun.env.PATH ?? "", RESTIC_CACHE_DIR: config.resticCache },
    });
    while (locks().length === 0) await Bun.sleep(100);
    again.kill("SIGKILL");
    await again.exited;
    await clearStaleLocks(config, local, Date.now() + 60_000, silent);
    expect(locks()).toEqual([]);
  });

  test("no repository, or one that does not open: exit codes 10 and 12", async () => {
    const { config } = made();
    expect((await runRestic(config, { ...localRepository(config), url: join(config.repository, "missing") }, ["snapshots", "--json"], Date.now() + 60_000)).code).toBe(10);
    const wrong = join(config.stagingFolder, "wrong-key");
    writeFileSync(wrong, "not the key");
    expect((await runRestic(config, { ...localRepository(config), password: { file: wrong } }, ["snapshots", "--json"], Date.now() + 60_000)).code).toBe(12);
  });

  test("forget by id forgets those, and those alone", async () => {
    const { config } = made();
    for (const hour of [0, 1]) {
      expect(restic(config, ["backup", "-q", "--host", SNAPSHOT_HOST, "--tag", "scheduled", "--time", resticTime(T - hour * 3_600_000), "--stdin-filename", "cms.tar", "--stdin-from-command", "--", "printf", String(hour)]).code).toBe(0);
    }
    const listed = readListing(restic(config, ["snapshots", "--json", "-q"]).stdout.toString());
    const result = await forgetSnapshots(config, localRepository(config), [listed[1]!.id], Date.now() + 60_000, silent);
    expect(result?.code).toBe(0);
    expect(names(config, "cms")).toEqual([snapshotName("cms", T, "scheduled")]);
    expect(await forgetSnapshots(config, localRepository(config), [], Date.now() + 60_000, silent)).toBeNull();
  });
});

describe.concurrent.skipIf(NO_RESTIC)("the copy's report through restic", () => {
  test("stays under restic's 64 KiB per line, whatever the data holds, and the full lists come back in the description", async () => {
    const { config, sites } = made();
    const data = project(sites, "crowd");
    writeFileSync(join(data, "f"), "x");
    mkdirSync(join(data, "links"));
    // Enough to fill every list of the description to its bound.
    for (let i = 0; i < 16_000; i++) symlinkSync("../f", join(data, "links", `link-${String(i).padStart(6, "0")}`));
    mkdirSync(join(config.stagingFolder, "crowd"), { recursive: true });
    const copy = Bun.spawn([process.execPath, resolve(import.meta.dir, "..", "backup.ts"), "copy", data, join(config.stagingFolder, "crowd"), "crowd", String(T), String(1 << 30)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([copy.stderr.text(), copy.exited]);
    expect(code).toBe(0);
    for (const line of stderr.split("\n")) expect(Buffer.byteLength(line)).toBeLessThan(4096);
    const outcome = await takeSnapshot(config, { folder: "crowd", account: "site-crowd", owner: null, dataDir: data, manifest: null }, "scheduled", T);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.counts.skipped).toBe(16_000);
    expect(outcome.summary.skipped.length).toBeGreaterThan(100);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("a snapshot reported taken has been read back", () => {
  /** A copy that writes what a forged copy would, and says it is done. */
  function forgingCopy(root: string, body: string): string {
    const wrapper = join(root, `forging-copy-${crypto.randomUUID()}.ts`);
    writeFileSync(
      wrapper,
      [
        `import { TarWriter } from ${JSON.stringify(resolve(import.meta.dir, "..", "src", "backup", "tar.ts"))};`,
        `const [mode] = process.argv.slice(2);`,
        `if (mode !== "copy") process.exit(9);`,
        `const writer = Bun.stdout.writer();`,
        `const tar = new TarWriter({ async write(bytes) { writer.write(bytes); await writer.flush(); }, async close() { await writer.end(); } });`,
        body,
        `process.stderr.write(JSON.stringify({ event: "summary", files: 1 }) + "\\n");`,
      ].join("\n"),
    );
    return wrapper;
  }

  test("a stream the reader refuses is forgotten at once, and the snapshot reported failed", async () => {
    const { config, sites, root } = made();
    const data = project(sites, "cms");
    writeFileSync(join(data, "f"), "x");
    const script = forgingCopy(root, `await tar.directory("data", { mode: 0o700, mtime: 0, uid: 0, gid: 0 });\nawait tar.file("etc/evil", { mode: 0o600, mtime: 0, uid: 0, gid: 0 }, 1, new Uint8Array([1]));\nawait tar.end();`);
    const journal: string[] = [];
    const outcome = await takeSnapshot({ ...config, script }, { folder: "cms", account: "site-cms", owner: null, dataDir: data, manifest: null }, "scheduled", T, (line) => journal.push(line));
    // restic had started: the run prunes what it left (dirty).
    expect(outcome).toEqual({ ok: false, error: "the snapshot written does not read back, see the journal of sitesolide-backup", cause: null, dirty: true });
    expect(journal.join("\n")).toContain("entry outside data/");
    expect(names(config, "cms")).toEqual([]);
  });

  test("a backup that saves without a summary that reads: the snapshot is found by its name, and forgotten", async () => {
    const { config, sites, root } = made();
    const data = project(sites, "cms");
    writeFileSync(join(data, "f"), "x");
    // restic as it is, its backup's summary line dropped on the way.
    const wrapper = join(root, "restic-without-summary.ts");
    writeFileSync(
      wrapper,
      [
        `#!${process.execPath}`,
        `const child = Bun.spawn([${JSON.stringify(config.restic)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });`,
        `const out = await new Response(child.stdout).text();`,
        `process.stdout.write(out.split("\\n").filter((line) => !line.includes('"message_type":"summary"')).join("\\n"));`,
        `process.exit(await child.exited);`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const outcome = await takeSnapshot({ ...config, restic: wrapper }, { folder: "cms", account: "site-cms", owner: null, dataDir: data, manifest: null }, "scheduled", T);
    expect(outcome).toEqual({ ok: false, error: "the snapshot was not saved, see the journal of sitesolide-backup", cause: null, dirty: true });
    expect(names(config, "cms")).toEqual([]);
  });

  test("a backup that finishes just as its deadline stops it: the snapshot it saved is forgotten", async () => {
    const { config, sites, root } = made();
    const data = project(sites, "cms");
    writeFileSync(join(data, "f"), "x");
    // restic as it is, its backup's answer held until the stop comes, then
    // given with exit code 0, as a restic finishing at that very moment would.
    const wrapper = join(root, "restic-finishing-late.ts");
    writeFileSync(
      wrapper,
      [
        `#!${process.execPath}`,
        `const args = process.argv.slice(2);`,
        `const child = Bun.spawn([${JSON.stringify(config.restic)}, ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });`,
        `const out = await new Response(child.stdout).text();`,
        `const code = await child.exited;`,
        `if (!args.includes("backup")) { process.stdout.write(out); process.exit(code); }`,
        `process.on("SIGTERM", () => { process.stdout.write(out); process.exit(code); });`,
        `setInterval(() => undefined, 1000);`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const journal: string[] = [];
    const outcome = await takeSnapshot({ ...config, restic: wrapper }, { folder: "cms", account: "site-cms", owner: null, dataDir: data, manifest: null }, "scheduled", T, (line) => journal.push(line), {
      timeoutMs: 3000,
    });
    expect(outcome).toEqual({ ok: false, error: TIMEOUT_ERROR, cause: "timeout", dirty: true });
    expect(journal.join("\n")).toContain("backup cms: the copy did not finish within 3 s, it was stopped");
    expect(names(config, "cms")).toEqual([]);
  });

  test("a copy that ends without its report: whatever restic saved is forgotten", async () => {
    const { config, sites, root } = made();
    const data = project(sites, "cms");
    writeFileSync(join(data, "f"), "x");
    const script = join(root, "silent-copy.ts");
    writeFileSync(script, `process.stdout.write("something");\n`);
    const outcome = await takeSnapshot({ ...config, script }, { folder: "cms", account: "site-cms", owner: null, dataDir: data, manifest: null }, "scheduled", T);
    expect(outcome).toEqual({ ok: false, error: "the copy ended without its report, see the journal of sitesolide-backup", cause: null, dirty: true });
    expect(names(config, "cms")).toEqual([]);
  });
});
