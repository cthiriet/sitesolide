import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyBudget, copyData, CopyError, GROWTH_FLOOR, measureData } from "../src/backup/copy";
import { extractData } from "../src/backup/extract";
import { main } from "../src/backup/main";
import { freeBytes, readProject } from "../src/backup/projects";
import { MIN_PROJECT_MS, projectTime, runBackups } from "../src/backup/run";
import { childCommand, confinement, type Job } from "../src/backup/runner";
import { TIMEOUT_ERROR, takeSnapshot, verifyArchive } from "../src/backup/snapshot";
import { readStatus } from "../src/backup/status";
import type { Sink } from "../src/backup/tar";
import { createAccounts, project, tree } from "./backup-fixtures";

/**
 * What one project can do to the others, and to root: a folder of too many
 * names, a copy stopped by its own service, a file grown to a terabyte, a data
 * folder swapped for a link. Each costs that project alone, within its own
 * time, and nothing of its tree reaches the status file.
 */
const roots: string[] = [];
// A minute: the folder of too many names takes its time to remove, and on
// GitHub's runner it took more than the five seconds a hook gets by default.
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}, 60_000);
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "backup-bounds-"));
  roots.push(root);
  return root;
}
const silent = () => undefined;
const T = Date.UTC(2026, 9, 4, 13, 0, 0);

/** A sink that keeps nothing: what is measured is the copy, not its storage. */
function nowhere(): Sink & { bytes: () => number } {
  let total = 0;
  return {
    async write(bytes) {
      total += bytes.byteLength;
    },
    async close() {},
    bytes: () => total,
  };
}

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

describe("root and a folder of too many names", () => {
  // Names as long as a file system allows: what costs memory is their bytes.
  const NAMES = 60_000;
  const root = scratch();
  const sites = join(root, "sites");
  const data = join(sites, "crowd", "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(root, "passwd"), "");
  const pad = "n".repeat(240);
  for (let i = 0; i < NAMES; i++) closeSync(openSync(join(data, `${pad}${String(i).padStart(8, "0")}`), "w"));

  /** The peak resident memory of a child running `body`, the modules root uses already loaded. */
  async function peak(body: string): Promise<number> {
    const script = join(root, `probe-${crypto.randomUUID()}.ts`);
    writeFileSync(
      script,
      [
        `import { readdirSync } from "node:fs";`,
        `import { readProject } from ${JSON.stringify(resolve(import.meta.dir, "..", "src", "backup", "projects.ts"))};`,
        `const sites = ${JSON.stringify(sites)}, data = ${JSON.stringify(data)}, passwd = ${JSON.stringify(join(root, "passwd"))};`,
        `void readdirSync; void readProject; void sites; void data; void passwd;`,
        body,
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "inherit", env: { ...Bun.env, SITESOLIDE_ZONE: "test-zone.invalid" } });
    expect(await child.exited).toBe(0);
    return child.resourceUsage()!.maxRSS;
  }

  test(
    "reading a project costs root no memory for the names of its data folder",
    async () => {
      const baseline = await peak("");
      const reading = await peak(`if (!("project" in readProject(sites, "crowd", passwd, false))) process.exit(3);`);
      // The listing a run used to make, as the control: the probe sees it.
      const listing = await peak(`if (readdirSync(data).length !== ${NAMES}) process.exit(3);`);
      const BOUND = 12 * 1024 * 1024;
      expect(listing - baseline).toBeGreaterThan(BOUND);
      expect(reading - baseline).toBeLessThan(BOUND);
      // And the verdict is right: not empty, so not excluded.
      expect(readProject(sites, "crowd", join(root, "passwd"), false)).toMatchObject({ excluded: null });
    },
    120_000,
  );

  test("an empty data folder is still recognised, by its first name alone", () => {
    mkdirSync(join(sites, "quiet", "data"), { recursive: true });
    expect(readProject(sites, "quiet", join(root, "passwd"), false)).toMatchObject({ excluded: "empty data folder" });
  });
});

describe("one project's failure is a failed project, never a dead run", () => {
  test("a project whose snapshot throws fails alone, and the next ones are saved", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    // First in the order: a file where its folder of archives should be.
    writeFileSync(join(project(sites, "aaa"), "x"), "x");
    writeFileSync(join(root, "backups", "aaa"), "not a folder");
    createAccounts(join(project(sites, "ledger"), "app.db"), 50);
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(false);
    expect(status.projects.aaa).toEqual({ ok: false, snapshot: null, error: expect.stringMatching(/^the snapshot failed \([A-Z]+\), see the journal/) });
    expect(status.projects.ledger).toMatchObject({ ok: true, snapshot: expect.stringContaining("ledger-") });
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))?.projects.ledger?.ok).toBe(true);
  });

  test("a database that does not open costs the audit, not the snapshots nor the status", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    createAccounts(join(project(sites, "ledger"), "app.db"), 50);
    mkdirSync(join(root, "state", "backup.db"));
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(false);
    expect(status.projects.ledger?.ok).toBe(true);
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))).toMatchObject({ ok: false });
  });

  test("a setting at fault still leaves a status that says the run failed", async () => {
    const root = scratch();
    const code = await main(["run"], { BACKUP_STATE_FOLDER: root, BACKUP_KEEP_HOURLY: "many", BACKUP_ISOLATION: "none" });
    expect(code).toBe(1);
    expect(readStatus(readFileSync(join(root, "last-run.json"), "utf8"))).toMatchObject({ ok: false, projects: {} });
  });
});

describe("a project's time is its own", () => {
  test("each gets a share of what is left, within the child timeout, never less than a minute", () => {
    expect(projectTime(25 * 60_000, 5, 20 * 60_000)).toBe(5 * 60_000);
    expect(projectTime(25 * 60_000, 1, 20 * 60_000)).toBe(20 * 60_000);
    expect(projectTime(60_000, 30, 20 * 60_000)).toBe(MIN_PROJECT_MS);
    expect(projectTime(-1, 3, 20 * 60_000)).toBe(MIN_PROJECT_MS);
    expect(projectTime(25 * 60_000, 2, 1500)).toBe(1500);
  });

  test(
    "a copy stopped by its own service is cut at its time, tried again last, and the next project is saved",
    async () => {
      const { root, sites, config } = tree({ BACKUP_CHILD_TIMEOUT_MS: "1500" });
      roots.push(root);
      // The service of `aaa` stops its copy, as SIGSTOP from the same uid would.
      const wrapper = join(root, "stopping-copy.ts");
      writeFileSync(
        wrapper,
        [
          `import { main } from ${JSON.stringify(resolve(import.meta.dir, "..", "src", "backup", "main.ts"))};`,
          `const [mode, data] = process.argv.slice(2);`,
          `if (mode === "copy" && data!.includes("/aaa/")) process.kill(process.pid, "SIGSTOP");`,
          `process.exit(await main(process.argv.slice(2), process.env));`,
        ].join("\n"),
      );
      writeFileSync(join(project(sites, "aaa"), "x"), "x");
      createAccounts(join(project(sites, "ledger"), "app.db"), 50);
      const journal: string[] = [];
      const started = Date.now();
      const status = await runBackups({ config: { ...config, script: wrapper }, now: () => T, log: (line) => journal.push(line) });
      const elapsed = Date.now() - started;
      expect(status.projects.aaa).toEqual({ ok: false, snapshot: null, error: TIMEOUT_ERROR });
      expect(status.projects.ledger).toMatchObject({ ok: true });
      // Twice its time and the others' copies, not the child's 30 seconds of grace.
      expect(elapsed).toBeLessThan(15_000);
      expect(journal.join("\n")).toContain("backup aaa: out of its time, tried again after the others");
      expect(readdirSync(join(root, "backups", "aaa"))).toEqual([]);
    },
    30_000,
  );

  test("a child carries its own time, and PID 1 kills it shortly after, stopped or not", () => {
    const job: Job = {
      mode: "copy",
      folder: "cms",
      account: "site-cms",
      uid: 1042,
      args: [],
      readWrite: [],
      bind: [],
      cacheDirectory: null,
      stdin: null,
      stdout: "pipe",
      timeoutMs: 90_500,
    };
    expect(confinement(job)).toContain("RuntimeMaxSec=91");
    expect(confinement(job)).toContain("TimeoutStopSec=15s");
  });

  test("reading an archive back stops at its deadline, and at the entries an extraction accepts", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    const data = project(sites, "ledger");
    for (let i = 0; i < 5; i++) writeFileSync(join(data, `f${i}`), "x");
    const outcome = await takeSnapshot(config, { folder: "ledger", account: "site-ledger", owner: null, dataDir: data, manifest: null }, "scheduled", T);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const path = join(config.backupFolder, "ledger", outcome.name);
    expect((await verifyArchive(path)).entries).toBe(7);
    await expect(verifyArchive(path, { maxEntries: 6, maxBytes: 1 << 30 })).rejects.toThrow("more than 6 entries");
    await expect(verifyArchive(path, undefined, Date.now() - 1)).rejects.toThrow("could not be read back in time");
  });
});

describe("a file grown after it was measured", () => {
  test("a sparse file counts for its apparent size: the disk check sees it whole", () => {
    const root = scratch();
    const huge = openSync(join(root, "huge.bin"), "w");
    ftruncateSync(huge, 10 * 1024 ** 3);
    closeSync(huge);
    expect(measureData(root).bytes).toBeGreaterThanOrEqual(10 * 1024 ** 3);
  });

  test("the copy stops at its budget before reading a byte of it, in an instant", async () => {
    const root = scratch();
    const data = join(root, "data");
    mkdirSync(data);
    mkdirSync(join(root, "staging"));
    writeFileSync(join(data, "small.txt"), "measured");
    const measured = measureData(data).bytes;
    // Then the service makes a terabyte of holes.
    const huge = openSync(join(data, "zz-huge.bin"), "w");
    ftruncateSync(huge, 1024 ** 4);
    closeSync(huge);
    const started = Date.now();
    const sink = nowhere();
    const copying = copyData(data, join(root, "staging"), sink, { folder: "ledger", takenAt: T, maxBytes: copyBudget(measured, 1024 ** 5) });
    await expect(copying).rejects.toThrow("the data grew past its measured size while being copied");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(sink.bytes()).toBeLessThan(1024 * 1024);
  });

  test("the budget is the measure, a quarter more and 64 MiB at least, within the room", () => {
    expect(copyBudget(0, 1024 ** 4)).toBe(GROWTH_FLOOR);
    expect(copyBudget(1024 ** 3, 1024 ** 4)).toBe(1024 ** 3 + 1024 ** 3 / 4);
    expect(copyBudget(1024 ** 3, 1024 ** 3 + 1)).toBe(1024 ** 3 + 1);
  });
});

describe("what the status file says of a project's tree", () => {
  test("too little room: the copy refuses, and no figure reaches the status file", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    const data = project(sites, "ledger");
    writeFileSync(join(data, "big.bin"), new Uint8Array(4 * 1024 * 1024));
    // One mebibyte of room above the reserve: the data needs eight.
    const status = await runBackups({ config: { ...config, reserveBytes: freeBytes(config.backupFolder) - 1024 * 1024 }, now: () => T, log: silent });
    expect(status.projects.ledger).toEqual({ ok: false, snapshot: null, error: "not enough disk space for this snapshot above the reserve, see the journal of sitesolide-backup" });
    expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toMatch(/[0-9]+ ?(MB|bytes)/);
  });

  test("a data folder swapped for a link after root looked: the copy refuses, and walks nothing", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    const data = project(sites, "ledger");
    writeFileSync(join(data, "x"), "x");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "not-ledger's"), "secret");
    const found = readProject(sites, "ledger", config.accountsFile, false);
    expect(found).toMatchObject({ excluded: null });
    rmSync(data, { recursive: true });
    symlinkSync(elsewhere, data);
    const outcome = await takeSnapshot(config, (found as { project: Parameters<typeof takeSnapshot>[1] }).project, "scheduled", T);
    expect(outcome).toEqual({ ok: false, error: "the data folder is not a folder", cause: null });
    expect(readdirSync(join(config.backupFolder, "ledger"))).toEqual([]);
  });
});

describe("no snapshot is taken that a restore would refuse", () => {
  test("the copy counts the entries exactly as the extraction does, and stops at the same number", async () => {
    const root = scratch();
    const data = join(root, "data");
    mkdirSync(join(data, "sub"), { recursive: true });
    mkdirSync(join(root, "staging"));
    writeFileSync(join(data, "a"), "a");
    writeFileSync(join(data, "sub", "b"), "b");
    // data/, sub/, a, sub/b and the description: five entries.
    const options = { folder: "ledger", takenAt: T, maxBytes: 1 << 20 };
    await expect(copyData(data, join(root, "staging"), nowhere(), { ...options, maxEntries: 4 })).rejects.toThrow(
      "more than 4 files and folders in the data: a snapshot of them could not be restored, so none is taken",
    );
    expect(() => measureData(data, 4)).toThrow(CopyError);
    expect(measureData(data, 5)).toEqual({ bytes: 2, entries: 3 });
    const archive = memory();
    await copyData(data, join(root, "staging"), archive, { ...options, maxEntries: 5 });
    const destination = join(root, "restored");
    mkdirSync(destination);
    const extracted = await extractData(archive.stream(), destination, { maxEntries: 5, maxBytes: 1 << 20 });
    expect(extracted).toMatchObject({ files: 2, directories: 1 });
  });

  test("the copy and the extraction share their cap", () => {
    const child = readFileSync(join(import.meta.dir, "..", "src", "backup", "child.ts"), "utf8");
    expect(child).toContain("maxEntries: MAX_ENTRIES");
    expect(child).not.toContain("2_000_000");
  });
});

describe("a download, the one child that is not a project", () => {
  const config = { isolation: "systemd" as const, systemdRun: "/usr/bin/systemd-run", bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js", offsiteFile: "/etc/sitesolide/dashboard-backup.env" };
  const offsite = { endpoint: "https://e.invalid", bucket: "b", region: null, accessKeyId: "AKIDNEVERSHOWN", secretAccessKey: "SECRETNEVERSHOWN", prefix: "p", passphrase: "PASSPHRASE-NEVER-SHOWN" };
  const job: Job = {
    mode: "download",
    folder: "cms",
    account: null,
    uid: null,
    args: ["cms", "cms-20261004T130000Z.tar.gz"],
    readWrite: [],
    bind: [],
    cacheDirectory: null,
    stdin: null,
    stdout: "pipe",
    timeoutMs: 600_000,
    offsite,
  };

  test("runs as a dynamic user, with the network, its settings read by PID 1 from the file, never on the command line", () => {
    const command = childCommand(job, config, "a1b2c3d4");
    expect(command.some((part) => part.startsWith("--uid="))).toBe(false);
    expect(command).toContain("DynamicUser=yes");
    expect(command).toContain("EnvironmentFile=/etc/sitesolide/dashboard-backup.env");
    expect(command).toContain("InaccessiblePaths=-/etc/sitesolide");
    expect(command).not.toContain("IPAddressDeny=any");
    expect(command.join(" ")).not.toMatch(/NEVERSHOWN|NEVER-SHOWN/);
  });

  test("a project's child keeps no network", () => {
    expect(confinement({ ...job, mode: "copy", account: "site-cms", offsite: null })).toContain("IPAddressDeny=any");
    expect(confinement({ ...job, mode: "copy", account: "site-cms", offsite: null })).not.toContain("DynamicUser=yes");
  });
});
