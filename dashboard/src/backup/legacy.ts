/**
 * The archives written before restic: `.tar.gz` files under
 * /var/backups/sitesolide/<folder>/, and their encrypted copies in the
 * bucket, `<prefix>/<folder>/<archive>.enc`. This version writes none. Its
 * first runs import them into the server's repository, verified, and remove
 * them seven days after their copy was verified: long enough to go back to
 * the version before, which still finds its files.
 *
 * - **An archive on the server** is read back by the tar reader as the run
 *   always did (`verifyArchive`), its description held to the name it bears,
 *   then stored by restic with the name's time and kind, the command being
 *   `gzip -dc` on the file: the snapshot holds exactly the tar the archive
 *   held. Then proved byte for byte: the SHA-256 of `restic dump` must be
 *   the SHA-256 of the archive decompressed. A copy that differs is
 *   forgotten, and the archive stays.
 * - **An object only the bucket holds** (the server rebuilt since) is fetched
 *   by a download child in its `legacy` mode, which decrypts and decompresses
 *   it, as restic's command; the stored snapshot is read back and its
 *   description held to its name.
 * - **Removal**, never on an absence: an archive goes once its copy was
 *   verified seven days ago and that copy is still in the repository, or as
 *   soon as retention itself forgot the copy (`forgotten`, which the run
 *   records as it forgets), which the version before would have pruned too.
 *   A copy merely missing, a repository lost and made again for one, removes
 *   nothing: the archive is imported again into the new one. An object goes
 *   on the same terms, its copy in the bucket's repository.
 *
 * Bounded like the rest of a run: no import starts past IMPORT_DEADLINE_MS,
 * none runs past IMPORT_STOP_MS, what is left waits for the next run; none
 * starts without the room for it above the disk's reserve, and one that
 * brings the disk down to the reserve is stopped. Root reads these files as it
 * always read them back; it never opens a project's file.
 *
 * The next version removes this module: its install refuses while an archive
 * remains on the server or a copy is younger than seven days.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { twinName } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { MAX_ENTRIES } from "./copy";
import { readImports, recordDoomed, recordImport, type Imported } from "./database";
import { descriptionMismatch } from "./extract";
import { backupFolders, localSnapshots } from "./listing";
import { offsiteEnvironment, type LegacyBucket, type Offsite, type RemoteObject } from "./offsite";
import { freeBytes } from "./projects";
import {
  backupArguments,
  forgetSnapshots,
  localRepository,
  readBackupSummary,
  resticJournal,
  snapshotPath,
  startRestic,
  watchCall,
  type Stored,
} from "./restic";
import { preparedChild, within, type Job } from "./runner";
import { verifyArchive } from "./snapshot";
import { gunzip } from "./tar";

/** How long an imported archive stays, its copy verified: the time to go back to the version before. */
export const ROLLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** No import starts past this, from the run's start. */
export const IMPORT_DEADLINE_MS = 30 * 60 * 1000;

/** No import runs past this, from the run's start: the bucket and the status come after, and the unit stops at 50. */
export const IMPORT_STOP_MS = 40 * 60 * 1000;

/** The longest one archive's import may take, or one object's download: a copy of several gigabytes takes minutes. */
export const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;

export type ImportDependencies = { config: BackupConfig; now: () => number; log: (line: string) => void };

/** `dirty`: restic left packs no snapshot uses, which the run prunes before it ends. */
export type ImportOutcome = { imported: number; failed: string[]; dirty: boolean };

const key = (folder: string, name: string) => `${folder}/${name}`;

/** The SHA-256 of a stream, read to its end. */
async function digestOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return hasher.digest("hex");
    hasher.update(value);
  }
}

/** The stored snapshot's tar, its SHA-256, read through `restic dump`; null when the dump fails. */
async function storedDigest(config: BackupConfig, id: string, folder: string, deadline: number): Promise<string | null> {
  const dump = startRestic(config, localRepository(config), ["dump", id, snapshotPath(folder)], { stdout: "stream" });
  const digest = await within(digestOf(dump.stdout!), deadline - Date.now());
  if (digest === null) dump.stop();
  const result = await within(dump.result, 15_000);
  return digest === null || result === null || result.value.code !== 0 ? null : digest.value;
}

/**
 * Stores one stream as a snapshot of `folder`, at the name's time and kind,
 * the disk watched every second; the new snapshot, or why not. `stopOthers`
 * stops what restic runs, a download child's unit.
 */
async function store(
  dependencies: ImportDependencies,
  stored: Stored,
  command: string[],
  deadline: number,
  stopOthers: () => void,
  extra: Record<string, string> = {},
): Promise<{ stored: Stored } | { error: string; saved: string | null }> {
  const { config } = dependencies;
  const call = startRestic(config, localRepository(config), [...backupArguments(stored.folder, stored.kind, stored.takenAt), ...command], { extra });
  const watched = await watchCall(call, deadline, () => freeBytes(config.repository) < config.reserveBytes, stopOthers);
  if ("stopped" in watched) {
    // Finishing as it was stopped: what it saved is not wanted.
    const saved = watched.late !== null && watched.late.code === 0 ? (readBackupSummary(watched.late.stdout)?.id ?? null) : null;
    return { error: watched.stopped === "disk" ? "stopped: the disk came down to its reserve" : "stopped: it did not finish in its time", saved };
  }
  const result = watched.ended;
  if (result.code !== 0) return { error: resticJournal("restic backup", result), saved: null };
  const saved = readBackupSummary(result.stdout);
  if (saved === null) return { error: "restic backup named no snapshot", saved: null };
  return { stored: { ...stored, id: saved.id, bytes: saved.bytes, added: saved.added } };
}

/**
 * Imports what is not imported yet, or whose copy the repository no longer
 * holds without retention having forgotten it. `listing`, the server's
 * repository as the run knows it, gains the new snapshots. `bucket`, the
 * bucket's objects of the format before restic, when there is a bucket and
 * its listing answered.
 */
export async function importLegacy(
  dependencies: ImportDependencies,
  db: Database,
  listing: Stored[],
  startedAt: number,
  bucket: { offsite: Offsite; objects: RemoteObject[] } | null,
): Promise<ImportOutcome> {
  const { config, now, log } = dependencies;
  const outcome: ImportOutcome = { imported: 0, failed: [], dirty: false };
  const imports = new Map(readImports(db).map((row) => [key(row.folder, row.name), row]));
  const present = (folder: string, name: string) => listing.some((stored) => stored.folder === folder && stored.name === twinName(folder, name));
  /** Imported, and its copy still there or forgotten by retention: nothing to do. */
  const settled = (folder: string, name: string) => {
    const row = imports.get(key(folder, name));
    return row !== undefined && (row.forgotten !== null || present(folder, name));
  };
  const late = () => now() - startedAt > IMPORT_DEADLINE_MS;
  /** Each import's deadline: its own time, never past IMPORT_STOP_MS into the run, as a time of `Date.now()`. */
  const deadlineOf = () => Date.now() + Math.min(IMPORT_TIMEOUT_MS, IMPORT_STOP_MS - (now() - startedAt));
  const record = (row: Omit<Imported, "forgotten">) => {
    const full = { ...row, forgotten: null };
    recordImport(db, full);
    imports.set(key(row.folder, row.name), full);
  };
  /** A copy not wanted: forgotten, or recorded to be when restic will. */
  const forget = async (id: string, folder: string) => {
    outcome.dirty = true;
    const result = await forgetSnapshots(config, localRepository(config), [id], Date.now() + 60_000, log);
    if (result !== null && result.code !== 0) {
      log(resticJournal(`backup ${folder}: restic forget of an import's copy`, result));
      recordDoomed(db, "local", id, now());
    }
  };
  const room = () => freeBytes(config.repository) - config.reserveBytes;

  // --- The archives on the server, the newest first: the likeliest to be restored.
  const archives = backupFolders(config.backupFolder)
    .flatMap((folder) => localSnapshots(config.backupFolder, folder))
    .filter((snapshot) => snapshot.legacy)
    .sort((a, b) => b.takenAt - a.takenAt);
  const onServer = new Set(archives.map((archive) => key(archive.folder, archive.name)));
  for (const archive of archives) {
    if (settled(archive.folder, archive.name)) continue;
    if (late()) break;
    const deadline = deadlineOf();
    if (deadline <= Date.now()) break;
    const twin = twinName(archive.folder, archive.name)!;
    const path = join(config.backupFolder, archive.folder, archive.name);
    const fail = (why: string) => {
      outcome.failed.push(archive.name);
      log(`backup ${archive.folder}: the archive ${archive.name} was not imported: ${why}`);
    };
    try {
      const read = await verifyArchive(gunzip(Bun.file(path).stream() as ReadableStream<Uint8Array>), { maxEntries: MAX_ENTRIES, maxBytes: Number.MAX_SAFE_INTEGER }, deadline);
      const mismatch = read.description === null ? null : descriptionMismatch(read.description, { folder: archive.folder, takenAt: archive.takenAt });
      if (mismatch !== null) {
        fail(mismatch);
        continue;
      }
      let copy = listing.find((stored) => stored.folder === archive.folder && stored.name === twin) ?? null;
      let fresh = false;
      if (copy === null) {
        // What it holds, at worst all new to the repository, above the reserve.
        if (room() <= read.bytes) {
          fail(`not enough disk space above the reserve for its ${read.bytes} bytes`);
          continue;
        }
        const saved = await store(dependencies, { id: "", name: twin, folder: archive.folder, takenAt: archive.takenAt, kind: archive.kind, bytes: null, added: null }, [config.gzip, "-dc", path], deadline, () => undefined);
        if ("error" in saved) {
          outcome.dirty = true;
          if (saved.saved !== null) await forget(saved.saved, archive.folder);
          fail(saved.error);
          continue;
        }
        copy = saved.stored;
        fresh = true;
      }
      const expected = await digestOf(gunzip(Bun.file(path).stream() as ReadableStream<Uint8Array>));
      const actual = await storedDigest(config, copy.id, archive.folder, deadline);
      if (actual !== expected) {
        if (fresh) await forget(copy.id, archive.folder);
        fail(actual === null ? "its copy does not read back" : "its copy differs from it");
        continue;
      }
      if (fresh) listing.push(copy);
      record({ folder: archive.folder, name: archive.name, source: "archive", digest: expected, at: now() });
      outcome.imported++;
      log(`backup ${archive.folder}: ${archive.name} imported as ${twin}, verified`);
    } catch (error) {
      fail((error as Error).message);
    }
  }

  // --- The objects only the bucket holds.
  if (bucket !== null) {
    for (const object of bucket.objects.sort((a, b) => b.snapshot.takenAt - a.snapshot.takenAt)) {
      const { folder, snapshot } = object;
      if (settled(folder, snapshot.name) || onServer.has(key(folder, snapshot.name))) continue;
      if (late()) break;
      const twin = twinName(folder, snapshot.name)!;
      if (listing.some((stored) => stored.folder === folder && stored.name === twin)) continue;
      const deadline = deadlineOf();
      if (deadline <= Date.now()) break;
      if (room() <= object.bytes) {
        outcome.failed.push(snapshot.name);
        log(`backup ${folder}: the bucket's object ${snapshot.name} was not imported: not enough disk space above the reserve`);
        continue;
      }
      const job: Job = {
        mode: "download",
        folder,
        account: null,
        uid: null,
        args: [folder, snapshot.name, "legacy"],
        readWrite: [],
        bind: [],
        cacheDirectory: null,
        stdin: null,
        stdout: "pipe",
        timeoutMs: Math.max(1000, deadline - Date.now()),
        offsite: bucket.offsite,
      };
      const child = preparedChild(job, config);
      const extra = config.isolation === "none" ? offsiteEnvironment(bucket.offsite) : {};
      const saved = await store(dependencies, { id: "", name: twin, folder, takenAt: snapshot.takenAt, kind: snapshot.kind, bytes: null, added: null }, child.command, deadline, child.stop, extra);
      if ("error" in saved) {
        outcome.dirty = true;
        if (saved.saved !== null) await forget(saved.saved, folder);
        outcome.failed.push(snapshot.name);
        log(`backup ${folder}: the bucket's object ${snapshot.name} was not imported: ${saved.error}`);
        continue;
      }
      // Read back, and held to its name: the object was sealed for its key, and its description says the same.
      const dump = startRestic(config, localRepository(config), ["dump", saved.stored.id, snapshotPath(folder)], { stdout: "stream" });
      let why: string | null = null;
      try {
        const read = await verifyArchive(dump.stdout!, { maxEntries: MAX_ENTRIES, maxBytes: Number.MAX_SAFE_INTEGER }, deadline);
        why = read.description === null ? null : descriptionMismatch(read.description, { folder, takenAt: snapshot.takenAt });
      } catch (error) {
        why = (error as Error).message;
        dump.stop();
      }
      const dumped = await within(dump.result, 15_000);
      if (why === null && (dumped === null || dumped.value.code !== 0)) why = "its copy does not read back";
      if (why !== null) {
        await forget(saved.stored.id, folder);
        outcome.failed.push(snapshot.name);
        log(`backup ${folder}: the bucket's object ${snapshot.name} was not imported: ${why}`);
        continue;
      }
      listing.push(saved.stored);
      record({ folder, name: snapshot.name, source: "object", digest: null, at: now() });
      outcome.imported++;
      log(`backup ${folder}: the bucket's ${snapshot.name} imported as ${twin}, verified`);
    }
  }
  return outcome;
}

/**
 * The archives on the server that may go, once retention has run: their copy
 * forgotten by retention, or verified seven days ago and still in `kept`, the
 * server's repository as it now stands. Never one whose copy is merely
 * missing. Returns how many went.
 */
export function removeLegacyArchives(dependencies: ImportDependencies, db: Database, kept: readonly Stored[]): number {
  const { config, now, log } = dependencies;
  const present = new Set(kept.map((stored) => key(stored.folder, stored.name)));
  let removed = 0;
  for (const row of readImports(db)) {
    if (row.source !== "archive") continue;
    const twin = twinName(row.folder, row.name);
    if (twin === null) continue;
    if (row.forgotten === null && !(now() - row.at >= ROLLBACK_MS && present.has(key(row.folder, twin)))) continue;
    const path = join(config.backupFolder, row.folder, row.name);
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      removed++;
      const folder = join(config.backupFolder, row.folder);
      if (readdirSync(folder).length === 0) rmdirSync(folder);
    } catch (error) {
      log(`backup ${row.folder}: ${row.name} not removed (${(error as Error).message})`);
    }
  }
  return removed;
}

/**
 * The bucket's objects that may go, once the bucket's repository has been
 * listed: their copy forgotten by retention, or verified seven days ago and in
 * the bucket's repository. Never an object whose copy was never verified, nor
 * one whose copy is merely missing.
 */
export async function removeLegacyObjects(
  dependencies: ImportDependencies,
  db: Database,
  bucket: LegacyBucket,
  objects: readonly RemoteObject[],
  remote: readonly Stored[],
  stopAt: number,
): Promise<number> {
  const { now, log } = dependencies;
  const imports = new Map(readImports(db).map((row) => [key(row.folder, row.name), row]));
  const inRemote = new Set(remote.map((stored) => key(stored.folder, stored.name)));
  let removed = 0;
  for (const object of objects) {
    const row = imports.get(key(object.folder, object.snapshot.name));
    if (row === undefined) continue;
    const twin = key(object.folder, twinName(object.folder, object.snapshot.name)!);
    if (row.forgotten === null && !(now() - row.at >= ROLLBACK_MS && inRemote.has(twin))) continue;
    if (Date.now() > stopAt) break;
    try {
      const done = await within(bucket.remove(object.key), stopAt - Date.now());
      if (done === null) break;
      removed++;
    } catch (error) {
      log(`backup ${object.folder}: ${object.key} not removed from the bucket (${(error as Error).message})`);
    }
  }
  return removed;
}
