import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacySnapshotName, snapshotName, type SnapshotKind } from "../borrowed/backups";
import type { BackupConfig } from "../src/backup/config";
import { copyData } from "../src/backup/copy";
import { encryptFile, newMaster } from "../src/backup/crypto";
import { openDatabase, readAudit, readImports, readSnapshots } from "../src/backup/database";
import { ROLLBACK_MS } from "../src/backup/legacy";
import { runBackups } from "../src/backup/run";
import { gzipSink } from "../src/backup/tar";
import { freeBytes } from "../src/backup/projects";
import { copyRepository, names, NO_RESTIC, project, repositoryTemplate, restic, stored, tree } from "./backup-fixtures";
import { startFakeS3 } from "./fake-s3";

/**
 * The archives written before restic, imported by the first runs of this
 * version into the repository, each proved byte for byte, then removed seven
 * days after: on the server's disk, and in the bucket for the objects the
 * server no longer has.
 */
setDefaultTimeout(120_000);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An archive of the format before restic, as the version before wrote it: the copy, gzipped, under its name. */
async function legacyArchive(config: BackupConfig, dataDir: string, folder: string, takenAt: number, kind: SnapshotKind = "scheduled", described = takenAt): Promise<string> {
  const target = join(config.backupFolder, folder);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const path = join(target, legacySnapshotName(folder, takenAt, kind));
  const chunks: Uint8Array[] = [];
  const staging = join(config.stagingFolder, `legacy-${crypto.randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  await copyData(
    dataDir,
    staging,
    gzipSink({
      async write(bytes) {
        chunks.push(bytes.slice());
      },
      async close() {},
    }),
    { folder, takenAt: described, maxBytes: 1 << 30 },
  );
  writeFileSync(path, Bun.concatArrayBuffers(chunks, Infinity, true), { mode: 0o600 });
  return path;
}

/** The plain tar an archive holds. */
const plainOf = (path: string) => Bun.gunzipSync(new Uint8Array(readFileSync(path)));

function machine(extra: Record<string, string> = {}) {
  const made = tree(extra);
  roots.push(made.root);
  const data = project(made.sites, "cms");
  writeFileSync(join(data, "upload.txt"), "the first version");
  return { ...made, data };
}

describe.concurrent.skipIf(NO_RESTIC)("the archives on the server", () => {
  test("are imported, each proved byte for byte, kept seven days, then removed", async () => {
    const { root, config, data } = machine();
    const older = await legacyArchive(config, data, "cms", T - 2 * HOUR);
    writeFileSync(join(data, "upload.txt"), "the second version");
    const newer = await legacyArchive(config, data, "cms", T - HOUR);
    const before = await legacyArchive(config, data, "cms", T - 3 * HOUR, "pre-restore");

    const status = await runBackups({ config, now: () => T, log: silent });
    expect(status.ok).toBe(true);
    expect(names(config, "cms")).toEqual([
      snapshotName("cms", T, "scheduled"),
      snapshotName("cms", T - HOUR, "scheduled"),
      snapshotName("cms", T - 2 * HOUR, "scheduled"),
      snapshotName("cms", T - 3 * HOUR, "pre-restore"),
    ]);
    // What restic gives back is the very tar the archive held.
    for (const [path, at, kind] of [[older, T - 2 * HOUR, "scheduled"], [newer, T - HOUR, "scheduled"], [before, T - 3 * HOUR, "pre-restore"]] as const) {
      const copy = stored(config).find((snapshot) => snapshot.name === snapshotName("cms", at, kind))!;
      expect(Bun.hash(restic(config, ["dump", copy.id, "/cms.tar"]).stdout)).toBe(Bun.hash(plainOf(path)));
    }
    const db = openDatabase(join(root, "state", "backup.db"));
    expect(readImports(db).map((row) => [row.name, row.source, row.at])).toEqual([
      [legacySnapshotName("cms", T - 3 * HOUR, "pre-restore"), "archive", T],
      [legacySnapshotName("cms", T - 2 * HOUR, "scheduled"), "archive", T],
      [legacySnapshotName("cms", T - HOUR, "scheduled"), "archive", T],
    ]);
    expect(readImports(db).every((row) => row.digest !== null && /^[0-9a-f]{64}$/.test(row.digest))).toBe(true);
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ imported: { imported: 3, failed: [] } });
    expect(readAudit(db, null, 1)[0]!.detail).not.toHaveProperty("legacyArchivesRemoved");
    // The page lists the copies; the archives stay, for the version before.
    expect(readSnapshots(db, "local", "cms")).toHaveLength(4);
    db.close();
    for (const path of [older, newer, before]) expect(existsSync(path)).toBe(true);

    // An hour on: nothing imported twice, nothing removed yet.
    expect((await runBackups({ config, now: () => T + HOUR, log: silent })).ok).toBe(true);
    expect(names(config, "cms").filter((name) => name.includes("T1100") || name.includes("T1200"))).toHaveLength(2);
    for (const path of [older, newer, before]) expect(existsSync(path)).toBe(true);

    // Seven days after their copy was verified, they go, and their folder with them.
    expect((await runBackups({ config, now: () => T + ROLLBACK_MS + HOUR, log: silent })).ok).toBe(true);
    for (const path of [older, newer, before]) expect(existsSync(path)).toBe(false);
    expect(existsSync(join(config.backupFolder, "cms"))).toBe(false);
  });

  test("an archive whose copy retention forgets goes with it, in the same run", async () => {
    const { root, config, data } = machine({ BACKUP_KEEP_HOURLY: "1", BACKUP_KEEP_DAILY: "0", BACKUP_KEEP_WEEKLY: "0", BACKUP_KEEP_PRE_RESTORE: "0" });
    const old = await legacyArchive(config, data, "cms", T - 90 * DAY);
    expect((await runBackups({ config, now: () => T, log: silent })).ok).toBe(true);
    // Imported, forgotten by the policy, and the archive removed, all in one run.
    expect(names(config, "cms")).toEqual([snapshotName("cms", T, "scheduled")]);
    expect(existsSync(old)).toBe(false);
    const db = openDatabase(join(root, "state", "backup.db"));
    expect(readImports(db)).toEqual([expect.objectContaining({ name: legacySnapshotName("cms", T - 90 * DAY, "scheduled"), forgotten: T })]);
    db.close();
  });

  test("a repository lost and made again removes no archive: they are imported again, even past seven days", async () => {
    const { config, data } = machine();
    const archives = [await legacyArchive(config, data, "cms", T - HOUR), await legacyArchive(config, data, "cms", T - 2 * HOUR)];
    expect((await runBackups({ config, now: () => T, log: silent })).ok).toBe(true);
    // The repository lost, `bin/deploy-backup.sh install` makes a new one: here a fresh copy of the template.
    rmSync(config.repository, { recursive: true, force: true });
    copyRepository(config.repository);
    const status = await runBackups({ config, now: () => T + ROLLBACK_MS + HOUR, log: silent });
    expect(status.ok).toBe(true);
    for (const path of archives) expect(existsSync(path)).toBe(true);
    expect(names(config, "cms")).toEqual(expect.arrayContaining([snapshotName("cms", T - HOUR, "scheduled"), snapshotName("cms", T - 2 * HOUR, "scheduled")]));
    // Imported again, their seven days counted again from now.
    expect((await runBackups({ config, now: () => T + ROLLBACK_MS + 2 * HOUR, log: silent })).ok).toBe(true);
    for (const path of archives) expect(existsSync(path)).toBe(true);
  });

  test("an archive that does not hold what its name says, or does not read, stays, and is said so", async () => {
    const { root, config, data } = machine();
    const mislabelled = await legacyArchive(config, data, "cms", T - HOUR, "scheduled", T - 5 * HOUR);
    const broken = join(config.backupFolder, "cms", legacySnapshotName("cms", T - 2 * HOUR, "scheduled"));
    writeFileSync(broken, "not a gzip at all");
    const journal: string[] = [];
    const status = await runBackups({ config, now: () => T, log: (line) => journal.push(line) });
    // The project's own snapshot is not the archives' business.
    expect(status.ok).toBe(true);
    expect(names(config, "cms")).toEqual([snapshotName("cms", T, "scheduled")]);
    expect(existsSync(mislabelled)).toBe(true);
    expect(existsSync(broken)).toBe(true);
    expect(journal.join("\n")).toContain("was not imported: the archive was taken at another time than its name says");
    const db = openDatabase(join(root, "state", "backup.db"));
    expect(readAudit(db, null, 1)[0]!.detail).toMatchObject({ imported: { imported: 0, failed: [legacySnapshotName("cms", T - HOUR, "scheduled"), legacySnapshotName("cms", T - 2 * HOUR, "scheduled")] } });
    expect(readImports(db)).toEqual([]);
    db.close();
  });
});

describe.concurrent.skipIf(NO_RESTIC)("the objects only the bucket holds", () => {
  test("are imported through a download child, copied to the bucket's repository, and removed from the bucket seven days on", async () => {
    const s3 = startFakeS3("AKIDLEGACY");
    try {
      const holder = mkdtempSync(join(tmpdir(), "backup-bucket-"));
      roots.push(holder);
      const bucket = join(holder, "repository");
      cpSync(repositoryTemplate().repository, bucket, { recursive: true });
      const passphrase = readFileSync(repositoryTemplate().key, "utf8");
      const { root, config, data } = machine({
        BACKUP_S3_ENDPOINT: s3.url,
        BACKUP_S3_BUCKET: s3.bucket,
        BACKUP_S3_ACCESS_KEY_ID: "AKIDLEGACY",
        BACKUP_S3_SECRET_ACCESS_KEY: "secret",
        BACKUP_ENCRYPTION_PASSPHRASE: passphrase,
        BACKUP_OFFSITE_REPOSITORY: bucket,
      });
      // The object of a day before, written by the version before; its archive gone from the server.
      const archive = await legacyArchive(config, data, "cms", T - DAY);
      const name = legacySnapshotName("cms", T - DAY, "scheduled");
      const key = `sitesolide/cms/${name}.enc`;
      const sealed: Uint8Array[] = [];
      await encryptFile(archive, key, await newMaster(passphrase), async (bytes) => void sealed.push(bytes.slice()));
      s3.objects.set(key, Bun.concatArrayBuffers(sealed, Infinity, true));
      s3.objects.set("sitesolide/cms/notes.txt", new Uint8Array(1));
      const plain = plainOf(archive);
      rmSync(join(config.backupFolder, "cms"), { recursive: true });

      const status = await runBackups({ config, now: () => T, log: silent });
      expect(status.ok).toBe(true);
      const twin = snapshotName("cms", T - DAY, "scheduled");
      const copy = stored(config).find((snapshot) => snapshot.name === twin)!;
      expect(Bun.hash(restic(config, ["dump", copy.id, "/cms.tar"]).stdout)).toBe(Bun.hash(plain));
      expect(names(config, "cms", bucket)).toContain(twin);
      const db = openDatabase(join(root, "state", "backup.db"));
      expect(readImports(db).map((row) => [row.name, row.source])).toEqual([[name, "object"]]);
      db.close();
      // Younger than seven days: the object stays.
      expect(s3.objects.has(key)).toBe(true);

      expect((await runBackups({ config, now: () => T + ROLLBACK_MS + HOUR, log: silent })).ok).toBe(true);
      expect(names(config, "cms", bucket)).toContain(twin);
      expect(s3.objects.has(key)).toBe(false);
      // What is not an object of ours is never touched.
      expect(s3.objects.has("sitesolide/cms/notes.txt")).toBe(true);
    } finally {
      s3.stop();
    }
  });
});

// Alone: the room it measures must not move with other tests' writes.
describe.skipIf(NO_RESTIC)("the disk's reserve", () => {
  test("no archive is imported without the room for it above the disk's reserve", async () => {
    const { config, data } = machine();
    writeFileSync(join(data, "big.bin"), crypto.getRandomValues(new Uint8Array(65536)));
    const archive = await legacyArchive(config, data, "cms", T - HOUR);
    rmSync(join(data, "big.bin"));
    const journal: string[] = [];
    // Room above the reserve for the project's own small snapshot, not for the archive's 64 KiB.
    await runBackups({ config: { ...config, reserveBytes: freeBytes(config.repository) - 40_000 }, now: () => T, log: (line) => journal.push(line) });
    expect(journal.join("\n")).toContain("was not imported: not enough disk space above the reserve");
    expect(names(config, "cms")).not.toContain(snapshotName("cms", T - HOUR, "scheduled"));
    expect(existsSync(archive)).toBe(true);
  });
});
