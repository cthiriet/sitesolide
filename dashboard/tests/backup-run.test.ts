import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotName } from "../borrowed/backups";
import { configFrom } from "../src/backup/config";
import { decryptStream } from "../src/backup/crypto";
import { openDatabase, readAudit, readOffsite, readSetting } from "../src/backup/database";
import { takeLock } from "../src/backup/lock";
import { listing } from "../src/backup/main";
import { redact, type Bucket } from "../src/backup/offsite";
import { runBackups } from "../src/backup/run";
import { readStatus } from "../src/backup/status";
import { createAccounts, project, SCRIPT, tree } from "./backup-fixtures";
import { startFakeS3 } from "./fake-s3";

const HOUR = 3_600_000;
/** Sunday 4 October 2026, 13:00 UTC. */
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A machine with the projects every run test needs. */
function machine(extra: Record<string, string> = {}) {
  const made = tree(extra);
  roots.push(made.root);
  const { sites } = made;
  createAccounts(join(project(sites, "ledger"), "app.db"), 200);
  // A static site: no data folder at all.
  mkdirSync(join(sites, "notes", "public"), { recursive: true });
  writeFileSync(join(sites, "notes", "sitesolide.json"), JSON.stringify({ slug: "notes", publicDir: "public" }));
  writeFileSync(join(project(sites, "scratch", { backup: false }), "cache.bin"), "rebuilt at every start");
  project(sites, "fresh");
  // The landing: its folder bears the zone's name, and it has no manifest.
  mkdirSync(join(sites, "test-zone.invalid", "data"), { recursive: true });
  writeFileSync(join(sites, "test-zone.invalid", "data", "messages.json"), "[]");
  return made;
}

function state(root: string) {
  return openDatabase(join(root, "state", "backup.db"));
}

describe("a scheduled run", () => {
  const { root, config } = machine();

  test("snapshots every project that has data, and leaves out the others on purpose", async () => {
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status).toEqual({
      startedAt: "2026-10-04T13:00:00.000Z",
      finishedAt: "2026-10-04T13:00:00.000Z",
      ok: true,
      projects: {
        fresh: { ok: true, snapshot: null, error: null },
        ledger: { ok: true, snapshot: "ledger-20261004T130000Z.tar.gz", error: null },
        notes: { ok: true, snapshot: null, error: null },
        scratch: { ok: true, snapshot: null, error: null },
        "test-zone.invalid": { ok: true, snapshot: "test-zone.invalid-20261004T130000Z.tar.gz", error: null },
      },
    });
    expect(readdirSync(join(root, "backups")).sort()).toEqual(["ledger", "test-zone.invalid"]);
  });

  test("writes the status file the monitor reads, in the contract's exact shape, readable by anyone", () => {
    const path = join(root, "state", "last-run.json");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(parsed).sort()).toEqual(["finishedAt", "ok", "projects", "startedAt"]);
    expect(Object.keys(parsed.projects.ledger).sort()).toEqual(["error", "ok", "snapshot"]);
    expect(readStatus(readFileSync(path, "utf8"))?.projects.ledger?.snapshot).toBe("ledger-20261004T130000Z.tar.gz");
  });

  test("records the run in its audit, as the system, with no value at all", () => {
    const db = state(root);
    const [entry] = readAudit(db, null, 10);
    expect(entry).toMatchObject({ actor: "system", action: "backup.run", target: null });
    expect(entry!.detail).toMatchObject({ ok: true, snapshots: 2, pruned: 0, failed: [], offsite: null });
    expect(readSetting(db, "retention")).toEqual({ hourly: 24, daily: 7, weekly: 4, preRestore: 3 });
    expect(readSetting(db, "offsite")).toEqual({ target: null, error: null });
    db.close();
  });

  test("prunes by the policy, and never touches a file that is not a snapshot", async () => {
    const folder = join(root, "backups", "ledger");
    // Two days of hourly snapshots before this one, and a stray file.
    for (let i = 1; i <= 48; i++) writeFileSync(join(folder, snapshotName("ledger", T - i * HOUR, "scheduled")), "old");
    writeFileSync(join(folder, "keep-me.txt"), "a hand-made copy");
    const status = await runBackups({ config, now: () => T + HOUR, log: silent });
    expect(status.ok).toBe(true);
    const names = readdirSync(folder);
    expect(names).toContain("keep-me.txt");
    expect(names).toContain(snapshotName("ledger", T + HOUR, "scheduled"));
    // 50 snapshots from 2 October 13:00 to 4 October 14:00: the 24 newest hours,
    // which already hold the newest of 3 and 4 October, plus the newest of 2
    // October; all three days are the same ISO week.
    expect(names.filter((name) => name.endsWith(".tar.gz"))).toHaveLength(25);
    expect(names).toContain(snapshotName("ledger", T - 38 * HOUR, "scheduled"));
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ pruned: 25 });
    db.close();
  });

  test("the CLI's listing reads it back", () => {
    const listed = listing(
      { BACKUP_FOLDER: config.backupFolder, BACKUP_STATE_FOLDER: config.stateFolder, BACKUP_ISOLATION: "none" },
      "ledger",
    );
    expect(listed.snapshots[0]).toMatchObject({ name: snapshotName("ledger", T + HOUR, "scheduled"), kind: "scheduled", local: true, offsite: false });
    expect(listed.lastRun).toMatchObject({ ok: true, snapshot: snapshotName("ledger", T + HOUR, "scheduled") });
  });
});

describe("what stops a run, or a project", () => {
  test("a restore holding the lock: the run waits, then gives up and says so", async () => {
    const { root, config } = machine();
    const lock = takeLock(config.runFolder, "restore");
    expect(lock.ok).toBe(true);
    const status = await runBackups({ config, now: () => T, log: silent, lockWaitMs: 0 });
    expect(status.ok).toBe(false);
    expect(status.projects).toEqual({});
    expect(readdirSync(join(root, "backups"))).toEqual([]);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ ok: false, error: expect.stringContaining("a restore has held the backup lock") });
    db.close();
    if (lock.ok) lock.release();
  });

  test("a run that has run out of time skips the rest, and still writes its status", async () => {
    const { config } = machine();
    let clock = T;
    // Every reading of the clock moves it forward ten minutes.
    const status = await runBackups({ config, now: () => (clock += 10 * 60_000), log: silent });
    expect(status.ok).toBe(false);
    const skipped = Object.values(status.projects).filter((project) => project.error === "skipped: the run ran out of time before reaching it");
    expect(skipped.length).toBeGreaterThan(0);
    expect(status.finishedAt).not.toBe(status.startedAt);
  });

  test("a disk that would be too full: no snapshot, and a reason", async () => {
    const { root, config } = machine({ BACKUP_DISK_RESERVE: String(10 ** 18) });
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(false);
    expect(status.projects.ledger).toEqual({ ok: false, snapshot: null, error: "not enough disk space: the disk of the archives is at its reserve" });
    expect(readdirSync(join(root, "backups", "ledger"))).toEqual([]);
    // Neither the disk's figures nor the data's reach a file anyone may read.
    expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toMatch(/[0-9]+ ?(MB|bytes)/);
  });

  test("an unreadable data folder fails that project alone, without naming it to the monitor", async () => {
    const { root, sites, config } = machine();
    const data = join(sites, "ledger", "data");
    // A name that is the project's business: it must reach the journal, never the status file.
    const privateName = "invoices-of-alice-martin";
    mkdirSync(join(data, privateName));
    writeFileSync(join(data, privateName, "secret"), "x");
    Bun.spawnSync(["chmod", "000", join(data, privateName)]);
    const journal: string[] = [];
    try {
      const status = await runBackups({ config, now: () => T, log: (line) => journal.push(line) });
      expect(status.ok).toBe(false);
      expect(status.projects.ledger).toEqual({ ok: false, snapshot: null, error: "a folder of the data cannot be read (permission denied)" });
      expect(status.projects["test-zone.invalid"]?.ok).toBe(true);
      expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toContain(privateName);
      expect(journal.join("\n")).toContain(privateName);
    } finally {
      Bun.spawnSync(["chmod", "700", join(data, privateName)]);
    }
  });
});

describe("the offsite copy", () => {
  const ACCESS = "AKIDBACKUPTEST";
  const PASSPHRASE = "correct horse battery staple, offsite";

  function offsiteMachine(s3: { url: string; bucket: string }, more: Record<string, string> = {}) {
    return machine({
      BACKUP_S3_ENDPOINT: s3.url,
      BACKUP_S3_BUCKET: s3.bucket,
      BACKUP_S3_ACCESS_KEY_ID: ACCESS,
      BACKUP_S3_SECRET_ACCESS_KEY: "secret-for-the-fake",
      BACKUP_ENCRYPTION_PASSPHRASE: PASSPHRASE,
      ...more,
    });
  }

  test("uploads each new snapshot encrypted, indexes it, and reads back to the very bytes", async () => {
    const s3 = startFakeS3(ACCESS);
    try {
      const { root, config } = offsiteMachine(s3);
      const status = await runBackups({ config, now: () => T, log: silent });
      expect(status.ok).toBe(true);
      const key = "sitesolide/ledger/ledger-20261004T130000Z.tar.gz.enc";
      expect([...s3.objects.keys()].sort()).toEqual([key, "sitesolide/test-zone.invalid/test-zone.invalid-20261004T130000Z.tar.gz.enc"]);
      const sealed = s3.objects.get(key)!;
      // Not a gzip: the bucket's provider sees noise.
      expect(new TextDecoder().decode(sealed.subarray(0, 8))).toBe("SSBACKUP");
      const plain: Uint8Array[] = [];
      await decryptStream(new Blob([sealed as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>, PASSPHRASE, async (bytes) => void plain.push(bytes.slice()));
      expect(Bun.concatArrayBuffers(plain, Infinity, true)).toEqual(new Uint8Array(readFileSync(join(root, "backups", "ledger", "ledger-20261004T130000Z.tar.gz"))));
      const db = state(root);
      expect(readOffsite(db, "ledger")).toEqual([{ name: "ledger-20261004T130000Z.tar.gz", bytes: sealed.byteLength }]);
      expect(readSetting(db, "offsite")).toEqual({ target: `backups at ${new URL(s3.url).host}`, error: null });
      db.close();
      // The secret key never enters what the dashboard reads.
      expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toContain("secret-for-the-fake");
    } finally {
      s3.stop();
    }
  });

  test("catches up what the bucket lacks, and prunes it by the same policy", async () => {
    const s3 = startFakeS3(ACCESS);
    try {
      // Two hours kept: "the hours that have a snapshot" would otherwise keep
      // a three-month-old object, there being fewer than 24 of them.
      const { root, config } = offsiteMachine(s3, { BACKUP_KEEP_HOURLY: "2", BACKUP_KEEP_DAILY: "0", BACKUP_KEEP_WEEKLY: "0" });
      // An old object the policy no longer keeps, a stranger the policy never touches.
      s3.objects.set(`sitesolide/ledger/${snapshotName("ledger", T - 90 * 24 * HOUR, "scheduled")}.enc`, new Uint8Array(10));
      s3.objects.set("sitesolide/ledger/notes.txt", new Uint8Array(1));
      mkdirSync(join(root, "backups", "ledger"), { recursive: true });
      writeFileSync(join(root, "backups", "ledger", snapshotName("ledger", T - HOUR, "scheduled")), "an older local snapshot");
      const status = await runBackups({ config, now: () => T, log: silent });
      expect(status.ok).toBe(true);
      const keys = [...s3.objects.keys()].filter((key) => key.startsWith("sitesolide/ledger/")).sort();
      expect(keys).toEqual([
        `sitesolide/ledger/${snapshotName("ledger", T - HOUR, "scheduled")}.enc`,
        `sitesolide/ledger/${snapshotName("ledger", T, "scheduled")}.enc`,
        "sitesolide/ledger/notes.txt",
      ]);
      const db = state(root);
      expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ offsite: { uploaded: 3, pruned: 1 } });
      db.close();
    } finally {
      s3.stop();
    }
  });

  test("an archive bigger than a part goes up in several, and comes back whole", async () => {
    const s3 = startFakeS3(ACCESS);
    try {
      const { root, sites, config } = offsiteMachine(s3);
      // Random bytes do not compress: twelve megabytes stay twelve.
      const noise = new Uint8Array(12 * 1024 * 1024);
      for (let i = 0; i < noise.byteLength; i += 65536) noise.set(crypto.getRandomValues(new Uint8Array(65536)), i);
      writeFileSync(join(sites, "ledger", "data", "noise.bin"), noise);
      expect((await runBackups({ config, now: () => T, log: silent })).ok).toBe(true);
      expect(s3.requests.some((request) => request.includes("?uploads"))).toBe(true);
      const key = "sitesolide/ledger/ledger-20261004T130000Z.tar.gz.enc";
      const plain: Uint8Array[] = [];
      await decryptStream(new Blob([s3.objects.get(key)! as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>, PASSPHRASE, async (bytes) => void plain.push(bytes.slice()));
      expect(Bun.concatArrayBuffers(plain, Infinity, true)).toEqual(new Uint8Array(readFileSync(join(root, "backups", "ledger", "ledger-20261004T130000Z.tar.gz"))));
    } finally {
      s3.stop();
    }
  });

  test("a bucket that does not answer costs the offsite copy, never the local snapshots", async () => {
    const s3 = startFakeS3(ACCESS);
    s3.down.value = true;
    try {
      const { root, config } = offsiteMachine(s3);
      const status = await runBackups({ config, now: () => T, log: silent });
      expect(status.ok).toBe(false);
      expect(status.projects.ledger).toEqual({ ok: false, snapshot: "ledger-20261004T130000Z.tar.gz", error: expect.stringContaining("no offsite copy") });
      expect(readdirSync(join(root, "backups", "ledger"))).toEqual(["ledger-20261004T130000Z.tar.gz"]);
    } finally {
      s3.stop();
    }
  });

  test("a bucket that stops answering mid-upload is abandoned at the deadline, and the status still written", async () => {
    const { root, config } = offsiteMachine({ url: "https://bucket.test-zone.invalid", bucket: "backups" });
    const uploads: string[] = [];
    const stalled: Bucket = {
      list: async () => [],
      upload: (key) => {
        uploads.push(key);
        return new Promise<number>(() => undefined);
      },
      download: () => Promise.reject(new Error("not used")),
      remove: () => Promise.reject(new Error("not used")),
    };
    const started = Date.now();
    const status = await runBackups({ config, now: () => T, log: silent, openBucket: () => stalled, offsiteStopMs: 500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(uploads).toEqual(["sitesolide/ledger/ledger-20261004T130000Z.tar.gz.enc"]);
    expect(status.projects.ledger).toEqual({ ok: false, snapshot: "ledger-20261004T130000Z.tar.gz", error: "offsite upload stopped: the run ran out of time" });
    expect(status.projects["test-zone.invalid"]).toMatchObject({ ok: false, error: "offsite upload skipped: the run ran out of time" });
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))?.ok).toBe(false);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ offsite: { uploaded: 0, abandoned: true } });
    db.close();
  });

  test("a bucket that never answers its listing is abandoned too", async () => {
    const { config } = offsiteMachine({ url: "https://bucket.test-zone.invalid", bucket: "backups" });
    const silentBucket: Bucket = {
      list: () => new Promise<never>(() => undefined),
      upload: () => Promise.reject(new Error("not used")),
      download: () => Promise.reject(new Error("not used")),
      remove: () => Promise.reject(new Error("not used")),
    };
    const status = await runBackups({ config, now: () => T, log: silent, openBucket: () => silentBucket, offsiteStopMs: 300 });
    expect(status.projects.ledger).toMatchObject({ ok: false, error: "no offsite copy: the bucket could not be listed: no answer in time" });
  });

  test("half a configuration is an error the page shows, not a silent fallback", async () => {
    const { root, config } = machine({ BACKUP_S3_BUCKET: "backups" });
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(false);
    expect(status.projects.ledger?.error).toContain("BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_ENCRYPTION_PASSPHRASE missing");
    const db = state(root);
    expect(readSetting(db, "offsite")).toMatchObject({ target: null, error: expect.stringContaining("half configured") });
    db.close();
  });

  test("what the Activity page reads of the audit carries no credential, whatever the bucket says", async () => {
    const SECRET = "secret-key-that-must-stay-home";
    const leaky = (where: string) => new Error(`${where} denied for ${ACCESS} with ${SECRET} under ${PASSPHRASE} at https://s3.test-zone.invalid/b/k?X-Amz-Signature=abc0123`);
    const refusing: Bucket = {
      list: () => Promise.reject(leaky("ListObjectsV2")),
      upload: () => Promise.reject(leaky("PutObject")),
      download: () => Promise.reject(new Error("not used")),
      remove: () => Promise.reject(new Error("not used")),
    };
    const uploadRefused: Bucket = { ...refusing, list: () => Promise.resolve([]) };
    const settings = { BACKUP_S3_ENDPOINT: "https://s3.test-zone.invalid", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: ACCESS, BACKUP_S3_SECRET_ACCESS_KEY: SECRET, BACKUP_ENCRYPTION_PASSPHRASE: PASSPHRASE };
    const { root, config } = machine(settings);
    await runBackups({ config, now: () => T, log: silent, openBucket: () => refusing });
    await runBackups({ config, now: () => T + HOUR, log: silent, openBucket: () => uploadRefused });
    const db = state(root);
    const rows = readAudit(db, null, 50);
    db.close();
    expect(rows.map((row) => row.action)).toEqual(["backup.run", "backup.run"]);
    expect(JSON.stringify(rows.map((row) => row.detail))).toContain("denied");
    const handed = JSON.stringify(rows);
    for (const value of [ACCESS, SECRET, PASSPHRASE, "abc0123"]) expect(handed).not.toContain(value);
  });

  test("a bucket's error reaches the status with no credential and no signature in it", () => {
    const setting = { endpoint: "https://e.invalid", bucket: "b", region: null, accessKeyId: "AKIDLEAKED", secretAccessKey: "SECRETLEAKED", prefix: "p", passphrase: "PASSPHRASE-LEAKED-0" };
    expect(redact("AccessDenied for AKIDLEAKED with SECRETLEAKED at https://e.invalid/b/k?X-Amz-Signature=abc&X-Amz-Credential=AKIDLEAKED", setting)).toBe(
      "AccessDenied for [redacted] with [redacted] at https://e.invalid/b/k?[redacted]",
    );
  });

  test("the settings refuse what would leak or weaken", () => {
    const base = {
      BACKUP_S3_ENDPOINT: "https://fsn1.example.invalid",
      BACKUP_S3_BUCKET: "b",
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
      BACKUP_ENCRYPTION_PASSPHRASE: "sixteen chars ok",
    };
    const offsite = (env: Record<string, string>) => configFrom(env, { bun: "bun", script: SCRIPT }).offsite;
    expect(offsite({})).toBeNull();
    expect(offsite(base)).toMatchObject({ endpoint: "https://fsn1.example.invalid", prefix: "sitesolide", region: null });
    expect(offsite({ ...base, BACKUP_S3_ENDPOINT: "http://fsn1.example.invalid" })).toEqual({ error: "BACKUP_S3_ENDPOINT must be an https:// address" });
    expect(offsite({ ...base, BACKUP_ENCRYPTION_PASSPHRASE: "short" })).toEqual({ error: "BACKUP_ENCRYPTION_PASSPHRASE must be at least 16 characters long" });
    expect(offsite({ ...base, BACKUP_S3_PREFIX: "../escape" })).toHaveProperty("error");
    expect(offsite({ ...base, BACKUP_S3_PREFIX: "/machines/one/" })).toMatchObject({ prefix: "machines/one" });
  });
});
