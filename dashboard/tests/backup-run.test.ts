import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotName, type SnapshotKind } from "../borrowed/backups";
import { configFrom, isolationRefusal, type BackupConfig } from "../src/backup/config";
import { openDatabase, readAudit, readDoomed, readSetting, readSnapshots } from "../src/backup/database";
import { takeLock } from "../src/backup/lock";
import { listing } from "../src/backup/main";
import { redact, type LegacyBucket } from "../src/backup/offsite";
import { MAINTENANCE_NOW, nextPart } from "../src/backup/maintenance";
import { forgotten, runBackups } from "../src/backup/run";
import type { Stored } from "../src/backup/restic";
import { DEFAULT_RETENTION } from "../src/backup/retention";
import { COPY_STOPPED_ERROR } from "../src/backup/snapshot";
import { readStatus } from "../src/backup/status";
import { createAccounts, names, NO_RESTIC, project, repositoryTemplate, restic, SCRIPT, stored, tree } from "./backup-fixtures";

setDefaultTimeout(120_000);

const HOUR = 3_600_000;
/** Sunday 4 October 2026, 13:00 UTC. */
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
/** The bucket's objects of the format before restic: none, here. */
const noLegacy = (): LegacyBucket => ({ list: async () => [], download: () => Promise.reject(new Error("not used")), remove: () => Promise.reject(new Error("not used")) });

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

/**
 * A snapshot of ours stored straight with restic, at a given time: what an
 * earlier run would have left. `host` other than the component's: one made
 * by hand.
 */
function seed(config: BackupConfig, folder: string, takenAt: number, kind: SnapshotKind = "scheduled", repository = config.repository, host = "sitesolide"): void {
  const time = new Date(takenAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  const made = restic(config, ["backup", "-q", "--host", host, "--tag", kind, "--time", time, "--stdin-filename", `${folder}.tar`, "--stdin-from-command", "--", "printf", "an older snapshot"], repository);
  if (made.code !== 0) throw new Error(made.stderr);
}

/**
 * The bucket: a folder for restic's local backend, a copy of the template
 * repository (whose key the tests hand as the passphrase) or nothing yet.
 */
function bucketMachine(more: Record<string, string> = {}, bucket: "copy" | "none" = "copy") {
  const holder = mkdtempSync(join(tmpdir(), "backup-bucket-"));
  roots.push(holder);
  const repository = join(holder, "repository");
  if (bucket === "copy") cpSync(repositoryTemplate().repository, repository, { recursive: true });
  const passphrase = readFileSync(repositoryTemplate().key, "utf8");
  const made = machine({
    BACKUP_S3_ENDPOINT: "https://bucket.test-zone.invalid",
    BACKUP_S3_BUCKET: "backups",
    BACKUP_S3_ACCESS_KEY_ID: "AKIDBACKUPTEST",
    BACKUP_S3_SECRET_ACCESS_KEY: "secret-for-the-test",
    BACKUP_ENCRYPTION_PASSPHRASE: passphrase,
    BACKUP_OFFSITE_REPOSITORY: repository,
    ...more,
  });
  return { ...made, bucket: repository };
}

describe.skipIf(NO_RESTIC)("a scheduled run", () => {
  const { root, config } = machine();

  test("snapshots every project that has data into the repository, and leaves out the others on purpose", async () => {
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status).toEqual({
      startedAt: "2026-10-04T13:00:00.000Z",
      finishedAt: "2026-10-04T13:00:00.000Z",
      ok: true,
      projects: {
        fresh: { ok: true, snapshot: null, error: null },
        ledger: { ok: true, snapshot: "ledger-20261004T130000Z.tar", error: null },
        notes: { ok: true, snapshot: null, error: null },
        scratch: { ok: true, snapshot: null, error: null },
        "test-zone.invalid": { ok: true, snapshot: "test-zone.invalid-20261004T130000Z.tar", error: null },
      },
      checks: { local: null, offsite: null, since: "2026-10-04T13:00:00.000Z", offsiteSince: null },
    });
    const kept = stored(config);
    expect(kept.map((snapshot) => snapshot.name).sort()).toEqual(["ledger-20261004T130000Z.tar", "test-zone.invalid-20261004T130000Z.tar"]);
    // restic counted what each holds and what it added.
    expect(kept.every((snapshot) => (snapshot.bytes ?? 0) > 0 && snapshot.added !== null)).toBe(true);
  });

  test("writes the status file the monitor reads, in the contract's exact shape, readable by anyone", () => {
    const path = join(root, "state", "last-run.json");
    expect(statSync(path).mode & 0o777).toBe(0o644);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(parsed).sort()).toEqual(["checks", "finishedAt", "ok", "projects", "startedAt"]);
    expect(Object.keys(parsed.projects.ledger).sort()).toEqual(["error", "ok", "snapshot"]);
    expect(readStatus(readFileSync(path, "utf8"))?.projects.ledger?.snapshot).toBe("ledger-20261004T130000Z.tar");
  });

  test("records the run in its audit, as the system, with no value at all, and indexes the repository for the steward", () => {
    const db = state(root);
    const [entry] = readAudit(db, null, 10);
    expect(entry).toMatchObject({ actor: "system", action: "backup.run", target: null });
    expect(entry!.detail).toMatchObject({ ok: true, snapshots: 2, forgotten: 0, failed: [], offsite: null });
    expect(readSetting(db, "retention")).toEqual({ hourly: 24, daily: 7, weekly: 4, preRestore: 3 });
    expect(readSetting(db, "offsite")).toEqual({ target: null, error: null });
    const [row] = readSnapshots(db, "local", "ledger");
    expect(row).toMatchObject({ name: "ledger-20261004T130000Z.tar", kind: "scheduled", takenAt: T, id: stored(config).find((snapshot) => snapshot.folder === "ledger")!.id });
    expect(readSnapshots(db, "offsite", "ledger")).toEqual([]);
    // The first run starts the clock of the daily maintenance, and checks nothing yet.
    expect(readSetting(db, "maintenance")).toMatchObject({ at: T, local: null, offsite: null });
    db.close();
  });

  test("the CLI's listing reads the index back", () => {
    const listed = listing({ BACKUP_STATE_FOLDER: config.stateFolder, BACKUP_ISOLATION: "none" }, "ledger");
    expect(listed.snapshots[0]).toMatchObject({ name: snapshotName("ledger", T, "scheduled"), kind: "scheduled", local: true, offsite: false });
    expect(listed.snapshots[0]!.added).toBeGreaterThan(0);
    expect(listed.lastRun).toMatchObject({ ok: true, snapshot: snapshotName("ledger", T, "scheduled") });
  });

  test("a second snapshot in the same second is refused, the first kept", async () => {
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.projects.ledger).toEqual({ ok: false, snapshot: null, error: "a snapshot was already taken this very second" });
    expect(names(config, "ledger")).toEqual(["ledger-20261004T130000Z.tar"]);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("retention", () => {
  test("forgets by the policy, by id, and never a snapshot made by hand", async () => {
    const { root, config } = machine({ BACKUP_KEEP_HOURLY: "2", BACKUP_KEEP_DAILY: "0", BACKUP_KEEP_WEEKLY: "0" });
    for (const hours of [1, 2, 3]) seed(config, "ledger", T - hours * HOUR);
    seed(config, "ledger", T - 5 * HOUR, "pre-restore");
    seed(config, "ledger", T - 4 * HOUR, "scheduled", config.repository, "a-workstation");
    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(true);
    // The two newest hours, the pre-restore one kept apart; the one by hand is not ours at all.
    expect(names(config, "ledger")).toEqual([snapshotName("ledger", T, "scheduled"), snapshotName("ledger", T - HOUR, "scheduled"), snapshotName("ledger", T - 5 * HOUR, "pre-restore")]);
    const all = JSON.parse(restic(config, ["snapshots", "--json", "-q"]).stdout.toString()) as { hostname: string }[];
    expect(all.filter((snapshot) => snapshot.hostname === "a-workstation")).toHaveLength(1);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ forgotten: 2 });
    expect(readSnapshots(db, "local", "ledger").map((row) => row.name)).toEqual(names(config, "ledger"));
    db.close();
  });

  test("the decision is retain()'s, by name: two days of hours keep the 24 newest and the day before", () => {
    const made = (hours: number, id = String(hours).padStart(64, "0")): Stored => ({
      id,
      name: snapshotName("ledger", T - hours * HOUR, "scheduled"),
      folder: "ledger",
      takenAt: T - hours * HOUR,
      kind: "scheduled",
      bytes: 1,
      added: 1,
    });
    const snapshots = Array.from({ length: 49 }, (_, hours) => made(hours));
    const { keep, forget } = forgotten(snapshots, DEFAULT_RETENTION);
    // From 2 October 13:00 to 4 October 13:00: the 24 newest hours, which hold
    // the newest of 3 and 4 October, plus the newest of 2 October, its 23:00;
    // all three days are the same ISO week.
    expect(keep).toHaveLength(25);
    expect(keep.map((snapshot) => snapshot.takenAt)).toContain(T - 38 * HOUR);
    expect(forget).toHaveLength(24);
    // A name stored twice, a copy made again: one is forgotten.
    const twice = forgotten([made(0), made(0, "f".repeat(64))], DEFAULT_RETENTION);
    expect(twice.keep).toHaveLength(1);
    expect(twice.forget.map((snapshot) => snapshot.id)).toEqual(["f".repeat(64)]);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("the daily maintenance", () => {
  test("a day after the first run, prune and a check of part of the repository, their verdict in the status file", async () => {
    const { root, config } = machine();
    const since = new Date(T).toISOString();
    expect((await runBackups({ config, now: () => T, log: silent })).checks).toEqual({ local: null, offsite: null, since, offsiteSince: null });
    // Before a day has passed: nothing yet.
    expect((await runBackups({ config, now: () => T + HOUR, log: silent })).checks).toEqual({ local: null, offsite: null, since, offsiteSince: null });
    const status = await runBackups({ config, now: () => T + 25 * HOUR, log: silent });
    expect(status.checks).toEqual({ local: { at: new Date(T + 25 * HOUR).toISOString(), ok: true, error: null }, offsite: null, since, offsiteSince: null });
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))?.checks?.local?.ok).toBe(true);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ checks: { local: true, offsite: null } });
    expect(readSetting(db, "repository")).toMatchObject({ bytes: expect.any(Number) });
    db.close();
  });

  test("a damaged repository fails its check, in a fixed sentence, and the run goes on", async () => {
    const { root, config } = machine();
    expect((await runBackups({ config, now: () => T, log: silent })).ok).toBe(true);
    // A pack of the repository lost, as a failing disk would lose it.
    const packs = Bun.spawnSync(["find", join(config.repository, "data"), "-type", "f"]).stdout.toString().trim().split("\n");
    rmSync(packs[0]!);
    const journal: string[] = [];
    const status = await runBackups({ config, now: () => T + 25 * HOUR, log: (line) => journal.push(line) });
    expect(status.checks?.local).toMatchObject({ ok: false, error: expect.stringMatching(/^(the prune failed: restic failed|the check of the server's repository found errors)/) });
    expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toContain(config.repository);
  });

  test("each day reads the part after the last one read whole, every part in turn", () => {
    let last = 0;
    const parts: number[] = [];
    for (let day = 0; day < 8; day++) parts.push((last = nextPart(last, 7)));
    expect(parts).toEqual([1, 2, 3, 4, 5, 6, 7, 1]);
    expect(nextPart(28, 28)).toBe(1);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("what stops a run, or a project", () => {
  test("a restore holding the lock: the run waits, then gives up and says so", async () => {
    const { root, config } = machine();
    const lock = takeLock(config.runFolder, "restore");
    expect(lock.ok).toBe(true);
    const status = await runBackups({ config, now: () => T, log: silent, lockWaitMs: 0 });
    expect(status.ok).toBe(false);
    expect(status.projects).toEqual({});
    expect(stored(config)).toEqual([]);
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
    expect(status.projects.ledger).toEqual({ ok: false, snapshot: null, error: "not enough disk space: the disk of the repository is at its reserve" });
    expect(stored(config)).toEqual([]);
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
      // And restic kept nothing of the failed copy.
      expect(names(config, "ledger")).toEqual([]);
    } finally {
      Bun.spawnSync(["chmod", "700", join(data, privateName)]);
    }
  });

  test("no repository: the run says to install, once, in a fixed sentence, and writes its status", async () => {
    const { root, config } = machine();
    rmSync(config.repository, { recursive: true });
    const journal: string[] = [];
    const status = await runBackups({ config, now: () => T, log: (line) => journal.push(line) });
    expect(status).toMatchObject({ ok: false, projects: {} });
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ ok: false, error: "the server's repository does not exist: run bin/deploy-backup.sh install" });
    db.close();
    // restic's own words, which quote the path, went to the journal alone.
    expect(journal.join("\n")).toContain("exit code 10");
    expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toContain(config.repository);
  });
});

describe.concurrent.skipIf(NO_RESTIC)("the offsite copy, to the bucket's repository", () => {
  test("copies each new snapshot, by id, indexes it, and the bucket's copy reads back to the same tar", async () => {
    const { root, config, bucket } = bucketMachine();
    const status = await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy });
    expect(status.ok).toBe(true);
    expect(names(config, "ledger", bucket)).toEqual([snapshotName("ledger", T, "scheduled")]);
    expect(names(config, "test-zone.invalid", bucket)).toEqual([snapshotName("test-zone.invalid", T, "scheduled")]);
    // The same tar, byte for byte, in both repositories.
    const local = restic(config, ["dump", stored(config).find((s) => s.folder === "ledger")!.id, "/ledger.tar"]).stdout;
    const remote = restic(config, ["dump", stored(config, bucket).find((s) => s.folder === "ledger")!.id, "/ledger.tar"], bucket).stdout;
    expect(Bun.hash(remote)).toBe(Bun.hash(local));
    const db = state(root);
    expect(readSnapshots(db, "offsite", "ledger").map((row) => row.name)).toEqual([snapshotName("ledger", T, "scheduled")]);
    expect(readSetting(db, "offsite")).toEqual({ target: "backups at bucket.test-zone.invalid", error: null });
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ offsite: { copied: 2, forgotten: 0 } });
    db.close();
    const listed = listing({ BACKUP_STATE_FOLDER: config.stateFolder, BACKUP_ISOLATION: "none" }, "ledger");
    expect(listed.snapshots[0]).toMatchObject({ local: true, offsite: true });
    // The secret key never enters what the dashboard reads.
    expect(readFileSync(join(root, "state", "last-run.json"), "utf8")).not.toContain("secret-for-the-test");
  });

  test("a bucket configured since: its repository is initialised with the server's chunker parameters", async () => {
    const { root, config, bucket } = bucketMachine({}, "none");
    const status = await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy });
    expect(status.ok).toBe(true);
    const polynomial = (repository: string) => JSON.parse(restic(config, ["cat", "config"], repository).stdout.toString()).chunker_polynomial;
    expect(polynomial(bucket)).toBe(polynomial(config.repository));
    expect(names(config, "ledger", bucket)).toEqual([snapshotName("ledger", T, "scheduled")]);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ offsite: { initialised: true, copied: 2 } });
    db.close();
  });

  test("catches up what the bucket lacks, prunes it by the same policy, and copies nothing the bucket would drop", async () => {
    const { root, config, bucket } = bucketMachine({ BACKUP_KEEP_HOURLY: "2", BACKUP_KEEP_DAILY: "0", BACKUP_KEEP_WEEKLY: "0" });
    // On the server, 11:00; in the bucket, 11:30 of the same hour, which the
    // server no longer has, and a three-month-old one the policy drops.
    seed(config, "ledger", T - 2 * HOUR);
    seed(config, "ledger", T - 90 * 60_000, "scheduled", bucket);
    seed(config, "ledger", T - 90 * 24 * HOUR, "scheduled", bucket);
    const status = await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy });
    expect(status.ok).toBe(true);
    // 13:00 copied; 11:00 not, the bucket keeping 11:30 for that hour; the old one forgotten.
    expect(names(config, "ledger", bucket)).toEqual([snapshotName("ledger", T, "scheduled"), snapshotName("ledger", T - 90 * 60_000, "scheduled")]);
    const db = state(root);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ offsite: { copied: 2, forgotten: 1 } });
    db.close();
    // An hour later, nothing copied again that the bucket would forget.
    expect((await runBackups({ config, now: () => T + HOUR, log: silent, openLegacyBucket: noLegacy })).ok).toBe(true);
    const again = state(root);
    expect(readAudit(again, null, 1)[0]!.detail).toMatchObject({ offsite: { copied: 2 } });
    again.close();
    expect(names(config, "ledger", bucket)).toEqual([snapshotName("ledger", T + HOUR, "scheduled"), snapshotName("ledger", T, "scheduled")]);
  });

  test("a bucket whose repository does not open costs the offsite copy, never the local snapshots, and says why in a fixed sentence", async () => {
    const { root, config } = bucketMachine({ BACKUP_ENCRYPTION_PASSPHRASE: "a passphrase changed in the dashboard since" });
    const journal: string[] = [];
    const status = await runBackups({ config, now: () => T, log: (line) => journal.push(line), openLegacyBucket: noLegacy });
    expect(status.ok).toBe(false);
    expect(status.projects.ledger).toEqual({
      ok: false,
      snapshot: "ledger-20261004T130000Z.tar",
      error: expect.stringContaining("no offsite copy: the bucket's repository could not be read: the bucket's repository does not open with BACKUP_ENCRYPTION_PASSPHRASE"),
    });
    expect(names(config, "ledger")).toEqual(["ledger-20261004T130000Z.tar"]);
    // No credential in what anyone reads, nor in the journal.
    const db = state(root);
    const handed = JSON.stringify(readAudit(db, null, 50)) + readFileSync(join(root, "state", "last-run.json"), "utf8") + journal.join("\n");
    db.close();
    for (const value of ["secret-for-the-test", "a passphrase changed in the dashboard since"]) expect(handed).not.toContain(value);
  });

  test("a bucket that does not answer in time is abandoned, and the status still written", async () => {
    const { root, config } = bucketMachine({}, "none");
    const started = Date.now();
    const status = await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy, offsiteStopMs: 1 });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(status.projects.ledger).toMatchObject({ ok: false, snapshot: "ledger-20261004T130000Z.tar", error: expect.stringContaining("restic did not finish in time") });
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))?.ok).toBe(false);
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
});

/**
 * A copy mode of the component's own entry point that does what `body` says,
 * the other modes left as they are: a copy stopped, killed, or failing late,
 * as a project's service or the OOM killer would have it.
 */
function copyDoing(root: string, body: string): string {
  const script = join(root, `copy-${crypto.randomUUID()}.ts`);
  writeFileSync(
    script,
    [
      `import { main } from ${JSON.stringify(join(import.meta.dir, "..", "src", "backup", "main.ts"))};`,
      `const [mode] = process.argv.slice(2);`,
      `if (mode !== "copy") process.exit(await main(process.argv.slice(2), process.env));`,
      body,
    ].join("\n"),
  );
  return script;
}

/** The files restic keeps its packs in: what a failure may leave behind. */
function packs(config: BackupConfig): string[] {
  return Bun.spawnSync(["find", join(config.repository, "data"), "-type", "f"]).stdout.toString().trim().split("\n").filter((line) => line !== "").sort();
}

describe.concurrent.skipIf(NO_RESTIC)("what a run leaves behind never stops the next", () => {
  test("a stale exclusive lock in the bucket's repository is removed, and the copy goes on", async () => {
    const { config, bucket } = bucketMachine();
    expect((await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy })).ok).toBe(true);
    // An exclusive call on the bucket killed outright, a check here: the OOM killer, a reboot, a SIGKILL past the grace.
    const check = Bun.spawn([config.restic, "-r", bucket, "--password-file", config.repositoryKey, "check"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: Bun.env.PATH ?? "", RESTIC_CACHE_DIR: config.resticCache },
    });
    // What restic calls a lock; the local backend may also leave the temporary file it was writing.
    const locks = () => readdirSync(join(bucket, "locks")).filter((name) => !name.includes("-tmp-"));
    while (locks().length === 0) await Bun.sleep(5);
    check.kill("SIGSTOP");
    check.kill("SIGKILL");
    await check.exited;
    expect(locks()).toHaveLength(1);
    for (const hour of [1, 2]) {
      const status = await runBackups({ config, now: () => T + hour * HOUR, log: silent, openLegacyBucket: noLegacy });
      expect(status.ok).toBe(true);
      expect(names(config, "ledger", bucket)).toContain(snapshotName("ledger", T + hour * HOUR, "scheduled"));
    }
    expect(locks()).toEqual([]);
  });

  test("a copy that fails late leaves no pack behind: the run prunes what restic wrote for it", async () => {
    const made = tree();
    roots.push(made.root);
    writeFileSync(join(project(made.sites, "late"), "x"), "x");
    const before = packs(made.config);
    // Forty megabytes, two full packs restic stores as they fill, then a failure.
    const script = copyDoing(
      made.root,
      [
        `const writer = Bun.stdout.writer();`,
        `for (let i = 0; i < 640; i++) { writer.write(crypto.getRandomValues(new Uint8Array(65536))); await writer.flush(); }`,
        `process.stderr.write(JSON.stringify({ event: "error", message: "the copy failed late" }) + "\\n");`,
        `process.exit(3);`,
      ].join("\n"),
    );
    const status = await runBackups({ config: { ...made.config, script }, now: () => T, log: silent });
    expect(status.projects.late).toEqual({ ok: false, snapshot: null, error: "the copy failed late" });
    expect(names(made.config, "late")).toEqual([]);
    const db = openDatabase(join(made.root, "state", "backup.db"));
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ cleaned: true });
    db.close();
    expect(packs(made.config)).toEqual(before);
  });

  test("a copy whose unit is killed is said to have stopped, not restic to have failed", async () => {
    const made = tree();
    roots.push(made.root);
    writeFileSync(join(project(made.sites, "killed"), "x"), "x");
    const script = copyDoing(made.root, `process.stdout.write("half a tar");\nprocess.kill(process.pid, "SIGKILL");`);
    const journal: string[] = [];
    const status = await runBackups({ config: { ...made.config, script }, now: () => T, log: (line) => journal.push(line) });
    expect(status.projects.killed).toEqual({ ok: false, snapshot: null, error: COPY_STOPPED_ERROR });
    expect(journal.join("\n")).toContain("command failed");
  });

  test("a snapshot restic would not forget is kept out of everything, and forgotten by the next run", async () => {
    const made = tree();
    roots.push(made.root);
    writeFileSync(join(project(made.sites, "forged"), "x"), "x");
    // A person's restic, live, holds a lock: forget is refused while it runs.
    const person = Bun.spawn([made.config.restic, "-r", made.config.repository, "--password-file", made.config.repositoryKey, "backup", "--stdin-filename", "x.tar", "--stdin-from-command", "--", "sleep", "60"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: Bun.env.PATH ?? "", RESTIC_CACHE_DIR: join(made.root, "person-cache") },
    });
    while (readdirSync(join(made.config.repository, "locks")).filter((name) => !name.includes("-tmp-")).length === 0) await Bun.sleep(10);
    // A copy that streams what the reader refuses: its snapshot is to be forgotten.
    const script = copyDoing(
      made.root,
      [
        `import { TarWriter } from ${JSON.stringify(join(import.meta.dir, "..", "src", "backup", "tar.ts"))};`,
        `const writer = Bun.stdout.writer();`,
        `const tar = new TarWriter({ async write(bytes) { writer.write(bytes); await writer.flush(); }, async close() { await writer.end(); } });`,
        `await tar.directory("data", { mode: 0o700, mtime: 0, uid: 0, gid: 0 });`,
        `await tar.file("etc/evil", { mode: 0o600, mtime: 0, uid: 0, gid: 0 }, 1, new Uint8Array([1]));`,
        `await tar.end();`,
        `process.stderr.write(JSON.stringify({ event: "summary", files: 1 }) + "\\n");`,
      ].join("\n"),
    );
    try {
      const status = await runBackups({ config: { ...made.config, script }, now: () => T, log: silent });
      expect(status.projects.forged?.error).toBe("the snapshot written does not read back, see the journal of sitesolide-backup");
      const left = stored(made.config).filter((snapshot) => snapshot.folder === "forged");
      expect(left).toHaveLength(1);
      const db = openDatabase(join(made.root, "state", "backup.db"));
      expect(readDoomed(db, "local")).toEqual([left[0]!.id]);
      expect(readSnapshots(db, "local", "forged")).toEqual([]);
      db.close();
    } finally {
      person.kill("SIGTERM");
      await person.exited;
    }
    // The lock gone, the next run forgets it first, and takes a sound snapshot.
    const next = await runBackups({ config: made.config, now: () => T + HOUR, log: silent });
    expect(next.ok).toBe(true);
    expect(names(made.config, "forged")).toEqual([snapshotName("forged", T + HOUR, "scheduled")]);
    const db = openDatabase(join(made.root, "state", "backup.db"));
    expect(readDoomed(db, "local")).toEqual([]);
    db.close();
  });

  test("the operator has the next run maintain at once, whatever the hour of the last", async () => {
    const { root, config } = machine();
    expect((await runBackups({ config, now: () => T, log: silent })).checks?.local).toBeNull();
    writeFileSync(join(config.stateFolder, MAINTENANCE_NOW), "", { mode: 0o600 });
    const status = await runBackups({ config, now: () => T + HOUR, log: silent });
    expect(status.checks?.local).toEqual({ at: new Date(T + HOUR).toISOString(), ok: true, error: null });
    expect(existsSync(join(root, "state", MAINTENANCE_NOW))).toBe(false);
  });

  test("a day the bucket does not answer keeps its last check, for the monitor to judge its age", async () => {
    const { root, config } = bucketMachine();
    expect((await runBackups({ config, now: () => T, log: silent, openLegacyBucket: noLegacy })).ok).toBe(true);
    writeFileSync(join(config.stateFolder, MAINTENANCE_NOW), "", { mode: 0o600 });
    const checked = await runBackups({ config, now: () => T + HOUR, log: silent, openLegacyBucket: noLegacy });
    expect(checked.checks?.offsite).toEqual({ at: new Date(T + HOUR).toISOString(), ok: true, error: null });
    // The day after, the bucket refusing every read: its check stays what it was.
    const bucket = (config.offsite as { repository: string }).repository;
    Bun.spawnSync(["chmod", "000", bucket]);
    try {
      const unreachable = await runBackups({ config, now: () => T + 26 * HOUR, log: silent, openLegacyBucket: noLegacy });
      expect(unreachable.projects.ledger?.error).toContain("no offsite copy");
      expect(unreachable.checks?.local?.at).toBe(new Date(T + 26 * HOUR).toISOString());
      expect(unreachable.checks?.offsite).toEqual(checked.checks?.offsite);
      expect(unreachable.checks?.offsiteSince).toBe(new Date(T).toISOString());
    } finally {
      Bun.spawnSync(["chmod", "700", bucket]);
    }
    expect(readStatus(readFileSync(join(root, "state", "last-run.json"), "utf8"))?.checks?.offsite).toEqual(checked.checks?.offsite);
  });
});

describe.skipIf(NO_RESTIC)("between the install and the first run", () => {
  test("the CLI's listing of a database the version before wrote is empty, never an error", () => {
    const made = tree();
    roots.push(made.root);
    const old = new Database(join(made.config.stateFolder, "backup.db"), { create: true });
    old.run("CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT)");
    old.close();
    expect(listing({ BACKUP_STATE_FOLDER: made.config.stateFolder, BACKUP_ISOLATION: "none" }, "ledger").snapshots).toEqual([]);
  });
});

describe("the bucket's settings", () => {
  test("an error reaches the journal with no credential and no signature in it", () => {
    const setting = { endpoint: "https://e.invalid", bucket: "b", region: null, accessKeyId: "AKIDLEAKED", secretAccessKey: "SECRETLEAKED", prefix: "p", passphrase: "PASSPHRASE-LEAKED-0", repository: "s3:https://e.invalid/b/p-restic" };
    expect(redact("AccessDenied for AKIDLEAKED with SECRETLEAKED at https://e.invalid/b/k?X-Amz-Signature=abc&X-Amz-Credential=AKIDLEAKED", setting)).toBe(
      "AccessDenied for [redacted] with [redacted] at https://e.invalid/b/k?[redacted]",
    );
  });

  test("a repository given in place of the bucket's is the workstation's alone: under systemd, root never takes it", () => {
    const base = {
      BACKUP_S3_ENDPOINT: "https://fsn1.example.invalid",
      BACKUP_S3_BUCKET: "b",
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
      BACKUP_ENCRYPTION_PASSPHRASE: "sixteen chars ok",
      BACKUP_OFFSITE_REPOSITORY: "sftp:somewhere:/repository",
    };
    const offsite = (env: Record<string, string>) => configFrom(env, { bun: "bun", script: SCRIPT }).offsite;
    expect(offsite(base)).toMatchObject({ repository: "s3:https://fsn1.example.invalid/b/sitesolide-restic" });
    expect(offsite({ ...base, BACKUP_ISOLATION: "none" })).toMatchObject({ repository: "sftp:somewhere:/repository" });
    expect(isolationRefusal("none", 0, "a0b1c2")).toBe("BACKUP_ISOLATION=none is for the workstation's tests, never under systemd");
    expect(isolationRefusal("none", 501, "a0b1c2")).toBeNull();
    expect(isolationRefusal("none", 0, undefined)).toBeNull();
    expect(isolationRefusal("systemd", 0, "a0b1c2")).toBeNull();
  });

  test("refuse what would leak or weaken, and name the bucket's repository beside the old objects", () => {
    const base = {
      BACKUP_S3_ENDPOINT: "https://fsn1.example.invalid",
      BACKUP_S3_BUCKET: "b",
      BACKUP_S3_ACCESS_KEY_ID: "k",
      BACKUP_S3_SECRET_ACCESS_KEY: "s",
      BACKUP_ENCRYPTION_PASSPHRASE: "sixteen chars ok",
    };
    const offsite = (env: Record<string, string>) => configFrom(env, { bun: "bun", script: SCRIPT }).offsite;
    expect(offsite({})).toBeNull();
    expect(offsite(base)).toMatchObject({ endpoint: "https://fsn1.example.invalid", prefix: "sitesolide", region: null, repository: "s3:https://fsn1.example.invalid/b/sitesolide-restic" });
    expect(offsite({ ...base, BACKUP_S3_ENDPOINT: "http://fsn1.example.invalid" })).toEqual({ error: "BACKUP_S3_ENDPOINT must be an https:// address" });
    expect(offsite({ ...base, BACKUP_ENCRYPTION_PASSPHRASE: "short" })).toEqual({ error: "BACKUP_ENCRYPTION_PASSPHRASE must be at least 16 characters long" });
    expect(offsite({ ...base, BACKUP_S3_PREFIX: "../escape" })).toHaveProperty("error");
    expect(offsite({ ...base, BACKUP_S3_PREFIX: "/machines/one/" })).toMatchObject({ prefix: "machines/one", repository: "s3:https://fsn1.example.invalid/b/machines/one-restic" });
  });
});
