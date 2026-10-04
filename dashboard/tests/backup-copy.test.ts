import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSnapshotName } from "../borrowed/backups";
import { startChild, type Job } from "../src/backup/runner";
import { takeSnapshot, verifyArchive } from "../src/backup/snapshot";
import { ACCOUNTS, BALANCE, audit, createAccounts, createLegacy, project, startWriter, tree } from "./backup-fixtures";

/**
 * The copy and the extraction, run for real: the component's own entry point
 * in a child process, as the unit runs it, on SQLite databases in WAL mode
 * that another process keeps writing while the snapshot is taken.
 */
const { root, sites, config } = tree();
afterAll(() => rmSync(root, { recursive: true, force: true }));

const data = project(sites, "ledger");
createAccounts(join(data, "app.db"));
createLegacy(join(data, "legacy.db"));
mkdirSync(join(data, "uploads", "2026"), { recursive: true });
const photo = crypto.getRandomValues(new Uint8Array(300_000));
writeFileSync(join(data, "uploads", "2026", "photo.bin"), photo);
mkdirSync(join(data, "cache"));
writeFileSync(join(data, "été.txt"), "accents survive");
symlinkSync("/etc/passwd", join(data, "link"));
Bun.spawnSync(["mkfifo", join(data, "pipe")]);

const ledger = { folder: "ledger", account: "site-ledger", owner: null, dataDir: data, manifest: null };

/** An extraction as a restore starts it, the snapshot's folder and time given. */
function extraction(destination: string, archive: string, folder: string, takenAt: number, maxBytes = 1 << 30): Job {
  return {
    mode: "extract",
    folder: "ledger",
    account: "site-ledger",
    uid: null,
    args: [destination, String(maxBytes), folder, String(takenAt)],
    readWrite: [destination],
    bind: [destination],
    cacheDirectory: null,
    stdin: archive,
    stdout: "ignore",
    timeoutMs: 60_000,
  };
}

describe("a snapshot taken while the database is written", () => {
  let name = "";

  test("is consistent: no transfer caught in the middle", async () => {
    const writer = await startWriter(root, join(data, "app.db"), 2500);
    const outcome = await takeSnapshot(config, ledger, "scheduled", Date.now());
    const transactions = await writer.done;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    name = outcome.name;
    // The writer really wrote during the copy, or this test proves nothing.
    expect(transactions).toBeGreaterThan(100);
    expect(outcome.summary.databases.sort()).toEqual(["app.db", "legacy.db"]);
    expect(outcome.summary.skipped).toEqual([
      { path: "link", reason: "symbolic link" },
      { path: "pipe", reason: "named pipe" },
    ]);
    // The live database is still sound, and still the writer's.
    expect(audit(join(data, "app.db"))).toEqual({ total: ACCOUNTS * BALANCE, rows: ACCOUNTS, integrity: "ok" });
  });

  test("is root's alone, complete, and named for its second", async () => {
    const path = join(config.backupFolder, "ledger", name);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(config.backupFolder, "ledger")).mode & 0o777).toBe(0o700);
    expect(name).toMatch(/^ledger-\d{8}T\d{6}Z\.tar\.gz$/);
    expect((await verifyArchive(path)).entries).toBeGreaterThan(5);
    // No temporary file left beside it, no database copy left in staging.
    expect(readdirSync(join(config.backupFolder, "ledger"))).toEqual([name]);
    expect(readdirSync(join(config.stagingFolder, "ledger"))).toEqual([]);
  });

  test("lists with tar itself: data/ and the description", () => {
    const listed = Bun.spawnSync(["tar", "-tzf", join(config.backupFolder, "ledger", name)]).stdout.toString();
    expect(listed).toContain("data/app.db");
    expect(listed).toContain("data/uploads/2026/photo.bin");
    expect(listed).toContain("sitesolide-backup.json");
    // The databases' side files are inside the copies, never beside them.
    expect(listed).not.toContain("app.db-wal");
    expect(listed).not.toContain("app.db-shm");
    expect(listed).not.toContain("data/link");
  });

  test("extracts, as the project would, into a sound copy of everything", async () => {
    const destination = join(root, "restored");
    mkdirSync(destination);
    const child = startChild(extraction(destination, join(config.backupFolder, "ledger", name), "ledger", readSnapshotName("ledger", name)!.takenAt), config);
    const { code, report } = await child.result;
    expect(report.error).toBeNull();
    expect(code).toBe(0);
    expect(report.summary).toMatchObject({ event: "summary", described: true });

    // Before any connection opens them: plain files, no WAL left to replay.
    expect(readdirSync(destination).sort()).toEqual(["app.db", "cache", "legacy.db", "uploads", "été.txt"]);
    expect(audit(join(destination, "app.db"))).toEqual({ total: ACCOUNTS * BALANCE, rows: ACCOUNTS, integrity: "ok" });
    expect(new Uint8Array(readFileSync(join(destination, "uploads", "2026", "photo.bin")))).toEqual(photo);
    expect(readFileSync(join(destination, "été.txt"), "utf8")).toBe("accents survive");
    expect(statSync(join(destination, "cache")).isDirectory()).toBe(true);
    expect(existsSync(join(destination, "link"))).toBe(false);
  });

  test("names its project and its time, and an extraction asked for another refuses it", async () => {
    const archive = join(config.backupFolder, "ledger", name);
    const listed = Bun.spawnSync(["tar", "-xzOf", archive, "sitesolide-backup.json"]).stdout.toString();
    const takenAt = readSnapshotName("ledger", name)!.takenAt;
    expect(JSON.parse(listed)).toMatchObject({ format: 2, folder: "ledger", takenAt: new Date(takenAt).toISOString(), raw: false });
    for (const [folder, at, reason] of [
      ["cms", takenAt, "the archive is a snapshot of another site than the one being restored"],
      ["ledger", takenAt + 3_600_000, "the archive was taken at another time than its name says"],
    ] as const) {
      const destination = join(root, `refused-${folder}-${at}`);
      mkdirSync(destination);
      const { code, report } = await startChild(extraction(destination, archive, folder, at), config).result;
      expect(code).toBe(1);
      expect(report.error).toBe(reason);
    }
  });

  test("a refused archive extracts nothing and says why", async () => {
    const forged = join(root, "forged.tar.gz");
    // A tar that names a file outside data/: the reader refuses it before writing.
    const block = new Uint8Array(512);
    block.set(new TextEncoder().encode("etc/evil"), 0);
    block.set(new TextEncoder().encode("0000644\0"), 100);
    block.set(new TextEncoder().encode("00000000000\0"), 124);
    block[156] = 0x30;
    block.set(new TextEncoder().encode("ustar\u000000"), 257);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    block.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    writeFileSync(forged, Bun.gzipSync(Bun.concatArrayBuffers([block, new Uint8Array(1024)], Infinity, true)));
    const destination = join(root, "refused");
    mkdirSync(destination);
    const { code, report } = await startChild(extraction(destination, forged, "ledger", 0, 1_000_000), config).result;
    expect(code).toBe(1);
    expect(report.error).toContain("outside data/");
    expect(readdirSync(destination)).toEqual([]);
  });
});

describe("the copy refuses to run as anyone but the project", () => {
  test("a uid that is not the expected one stops it before it reads anything", async () => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "backup.ts"), "copy", data, join(root, "staging")], {
      env: { ...process.env, BACKUP_EXPECTED_UID: String((process.getuid?.() ?? 0) + 1) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("not the project's");
  });
});
