/**
 * A scheduled run, launched by sitesolide-backup.timer: every project's data
 * folder snapshotted into the server's restic repository, the old snapshots
 * forgotten, the archives of the format before restic imported, the bucket's
 * repository brought up to date, once a day a prune and a check, and the
 * status written for the monitor.
 *
 * In this order, and each step tolerant of the others: a project that fails
 * does not stop the next one, a bucket that does not answer does not cost the
 * local snapshots, and the status file is written whatever happened, so that
 * a silent machine is never mistaken for a healthy one.
 *
 * **No project can take the others' turn.** The projects are read one at a
 * time, as the run reaches them, and whatever one of them throws is that
 * project's failure, never the run's. Each is given a share of the time left,
 * not the whole of it: a project whose copy is stopped or slowed by its own
 * service is cut at its share and tried again once every other project has
 * had its turn, with what is left. Its place in the order changes nothing.
 *
 * **Retention decides, restic carries it out.** Which snapshots go is
 * retention.ts's, pure and tested without a disk; restic is only told
 * `forget <id>...`, on the server and in the bucket alike.
 *
 * **What a failure leaves, the run takes back.** A snapshot that failed once
 * restic had started leaves packs no snapshot uses: a run that saw one ends,
 * still under the lock, with `restic prune --max-repack-size 0`, which deletes
 * wholly unused packs and repacks nothing, so that a project failing late every
 * hour cannot fill the disk for the others. A snapshot restic would not forget
 * when asked (a person's live lock) is recorded, kept out of every listing,
 * index and copy, and forgotten at the next run's start.
 */
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { twinName } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import {
  clearDoomed,
  DATABASE_NAME,
  markForgotten,
  openDatabase,
  PRUNE_WANTED,
  readDoomed,
  readImports,
  readSetting,
  recordAudit,
  recordDoomed,
  replaceSnapshots,
  writeSetting,
  type IndexedSnapshot,
} from "./database";
import { importLegacy, removeLegacyArchives, removeLegacyObjects } from "./legacy";
import { waitForLock } from "./lock";
import { checksOf, maintain, MAINTENANCE_NOW, readMaintenance } from "./maintenance";
import { bucketRepository, offsiteTarget, openLegacyBucket, redact, type LegacyBucket, type Offsite, type RemoteObject } from "./offsite";
import { projectFolders, readProject, type Found, type Project } from "./projects";
import {
  clearStaleLocks,
  forgetSnapshots,
  listSnapshots,
  localRepository,
  resticFailure,
  resticJournal,
  resticTemporary,
  runExclusive,
  type Repository,
  type Stored,
} from "./restic";
import { retain, type RetentionPolicy } from "./retention";
import { within } from "./runner";
import { TIMEOUT_ERROR, takeSnapshot, type SnapshotOutcome } from "./snapshot";
import { shortError, writeStatus, type ProjectStatus, type RunStatus } from "./status";

export type RunDependencies = {
  config: BackupConfig;
  now: () => number;
  log: (line: string) => void;
  /** The bucket's objects of the format before restic, opened from its settings. The tests point it at a local fake. */
  openLegacyBucket?: (offsite: Offsite) => LegacyBucket;
  /** How long to wait for a restore in progress to finish. */
  lockWaitMs?: number;
  /** When, from the run's start, a call to the bucket still waiting is abandoned: OFFSITE_STOP_MS. */
  offsiteStopMs?: number;
};

/** A restore takes minutes; a run waits that long before giving up on this hour. */
export const LOCK_WAIT_MS = 15 * 60 * 1000;

/**
 * The share of the unit's time the offsite catch-up may use. The unit is killed
 * at 50 minutes: past 40, older copies wait for the next run, and the status
 * file still gets written.
 */
export const OFFSITE_DEADLINE_MS = 40 * 60 * 1000;

/**
 * Past this, a call to the bucket still waiting, a copy begun at 39 minutes
 * on a slow line for one, is stopped and said so: the status file must be
 * written before systemd kills the run at 50.
 */
export const OFFSITE_STOP_MS = 45 * 60 * 1000;

/**
 * Past this, the projects not reached yet are reported as skipped rather than
 * started: a copy begun at 45 minutes would have the unit killed before the
 * status file is written, and a silent run is the one thing the monitor cannot
 * tell from a healthy one.
 */
export const SNAPSHOT_DEADLINE_MS = 25 * 60 * 1000;

/** The least a project is given, whatever its share: a small folder's copy takes seconds, a stuck one never ends. */
export const MIN_PROJECT_MS = 60 * 1000;

/** How long a listing or a forget of the server's repository may take: a second or two, measured. */
const LOCAL_CALL_MS = 5 * 60 * 1000;

/** Whether the operator asked for the maintenance now: a plain file of the state folder, root's when owners are checked. */
function maintenanceAsked(config: BackupConfig): boolean {
  try {
    const stat = lstatSync(join(config.stateFolder, MAINTENANCE_NOW));
    return stat.isFile() && (!config.checkOwners || stat.uid === 0);
  } catch {
    return false;
  }
}

/**
 * A project's time: an equal share of what is left of the snapshot window
 * among the projects still to come, this one included, within the child
 * timeout. Every project gets at least its share of the whole window,
 * wherever it stands in the order, and the time a quick project leaves goes
 * to the ones after it.
 */
export function projectTime(remainingMs: number, projectsLeft: number, childTimeoutMs: number): number {
  return Math.min(childTimeoutMs, Math.max(MIN_PROJECT_MS, Math.floor(remainingMs / Math.max(1, projectsLeft))));
}

/** The code or the name only, for the status: a system error's message quotes a path. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

/**
 * Which of one repository's snapshots retention forgets: per project, by
 * retain(), over the names. Two snapshots under one name (a copy made twice)
 * keep one.
 */
export function forgotten(stored: readonly Stored[], policy: RetentionPolicy): { keep: Stored[]; forget: Stored[] } {
  const byFolder = new Map<string, Stored[]>();
  for (const snapshot of stored) byFolder.set(snapshot.folder, [...(byFolder.get(snapshot.folder) ?? []), snapshot]);
  const keep: Stored[] = [];
  const forget: Stored[] = [];
  for (const snapshots of byFolder.values()) {
    const byName = new Map<string, Stored>();
    for (const snapshot of snapshots) {
      if (byName.has(snapshot.name)) forget.push(snapshot);
      else byName.set(snapshot.name, snapshot);
    }
    const decision = retain([...byName.values()], policy);
    const pruned = new Set(decision.prune);
    for (const snapshot of byName.values()) (pruned.has(snapshot.name) ? forget : keep).push(snapshot);
  }
  return { keep, forget };
}

function indexed(stored: readonly Stored[]): IndexedSnapshot[] {
  return stored.map(({ folder, name, id, takenAt, kind, bytes, added }) => ({ folder, name, id, takenAt, kind, bytes, added }));
}

export async function runBackups(dependencies: RunDependencies): Promise<RunStatus> {
  const { config, now, log } = dependencies;
  const startedAt = now();
  const projects: Record<string, ProjectStatus> = {};
  const fail = (folder: string, error: string, snapshot: string | null = null) => {
    projects[folder] = { ok: false, snapshot: projects[folder]?.snapshot ?? snapshot, error: shortError(error) };
  };
  const audit: Record<string, unknown> = {};
  let runError: string | null = null;
  let checks: RunStatus["checks"] = { local: null, offsite: null, since: null, offsiteSince: null };
  /** restic left packs no snapshot uses: pruned before the run ends. */
  let dirty = false;

  const lock = await waitForLock(config.runFolder, "run", dependencies.lockWaitMs ?? LOCK_WAIT_MS);
  if (!lock.ok) {
    runError = lock.holder === null ? "the backup lock is held" : `a ${lock.holder.who} has held the backup lock since ${new Date(lock.holder.since).toISOString()}`;
    log(`backup: ${runError}, no run this time`);
  }

  // A database that does not open costs the audit, the index and the import,
  // never the snapshots nor the status file.
  let db: Database | null = null;
  try {
    db = openDatabase(join(config.stateFolder, DATABASE_NAME));
  } catch (error) {
    runError ??= `the component's database could not be opened (${errorCode(error)}), see the journal of sitesolide-backup`;
    log(`backup: the database could not be opened: ${(error as Error).message}`);
  }

  try {
    if (lock.ok) {
      if (db !== null) {
        writeSetting(db, "retention", config.retention);
        writeSetting(db, "offsite", {
          target: config.offsite !== null && !("error" in config.offsite) ? offsiteTarget(config.offsite) : null,
          error: config.offsite !== null && "error" in config.offsite ? config.offsite.error : null,
        });
        checks = checksOf(readMaintenance(db));
      }
      const local = localRepository(config);
      // restic's temporary packs, on disk: what a killed restic left goes first.
      rmSync(resticTemporary(config), { recursive: true, force: true });
      mkdirSync(resticTemporary(config), { recursive: true, mode: 0o700 });
      await clearStaleLocks(config, local, Date.now() + LOCAL_CALL_MS, log);
      // What an earlier run wanted forgotten and restic would not forget then.
      const doomed = db === null ? [] : readDoomed(db, "local");
      if (db !== null && doomed.length > 0) {
        const result = await forgetSnapshots(config, local, doomed, Date.now() + LOCAL_CALL_MS, log);
        if (result !== null && result.code === 0) {
          clearDoomed(db, "local", doomed);
          dirty = true;
        } else if (result !== null) log(resticJournal("backup: restic forget of the snapshots an earlier run could not forget", result));
      }
      if (db !== null && readSetting(db, PRUNE_WANTED) === true) dirty = true;

      const listed = await listSnapshots(config, local, Date.now() + LOCAL_CALL_MS, [], log);
      if ("failure" in listed) {
        // No repository to write into: every project would fail alike, said once.
        runError = resticFailure(listed.failure, local);
        log(resticJournal("backup: restic snapshots on the local repository", listed.failure));
      } else {
        // Those still waiting to be forgotten are no snapshots: never listed, indexed or copied.
        const left = new Set(db === null ? [] : readDoomed(db, "local"));
        const listing = listed.snapshots.filter((stored) => !left.has(stored.id));

        // --- The snapshots
        const taken = await snapshotStep(dependencies, startedAt, projects, fail, listing);
        audit.snapshots = taken.count;
        if (taken.dirty) dirty = true;
        if (db !== null) for (const id of taken.orphans) recordDoomed(db, "local", id, now());

        // --- The archives of the format before restic, imported, then removed seven days on
        let legacyObjects: { bucket: LegacyBucket; objects: RemoteObject[] } | null = null;
        if (db !== null) {
          legacyObjects = await listLegacyObjects(dependencies, startedAt);
          const imported = await importLegacy(dependencies, db, listing, startedAt, legacyObjects === null || config.offsite === null || "error" in config.offsite ? null : { offsite: config.offsite, objects: legacyObjects.objects });
          if (imported.dirty) dirty = true;
          if (imported.imported > 0 || imported.failed.length > 0) audit.imported = { imported: imported.imported, failed: imported.failed };
        }

        // --- Retention, on the server
        const decided = forgotten(listing, config.retention);
        let kept = listing;
        if (decided.forget.length > 0) {
          const result = await forgetSnapshots(config, local, decided.forget.map((snapshot) => snapshot.id), Date.now() + LOCAL_CALL_MS, log);
          if (result !== null && result.code === 0) {
            kept = decided.keep;
            // An archive of the format before restic whose copy retention forgot may go at once.
            if (db !== null) {
              const gone = new Set(decided.forget.map((snapshot) => `${snapshot.folder}/${snapshot.name}`));
              for (const row of readImports(db)) if (gone.has(`${row.folder}/${twinName(row.folder, row.name)}`)) markForgotten(db, row.folder, row.name, now());
            }
          } else if (result !== null) log(resticJournal("backup: restic forget on the local repository", result));
        }
        audit.forgotten = kept === listing ? 0 : decided.forget.length;
        if (db !== null) {
          replaceSnapshots(db, "local", indexed(kept));
          const removed = removeLegacyArchives(dependencies, db, kept);
          if (removed > 0) audit.legacyArchivesRemoved = removed;
        }

        // --- The bucket
        const offsite = await offsiteStep(dependencies, db, startedAt, fail, kept, legacyObjects);
        audit.offsite = offsite.audit;

        // --- Once a day, or at once when the operator asks: prune and check
        if (db !== null) {
          const asked = maintenanceAsked(config);
          const outcome = await maintain(
            dependencies,
            db,
            { local, offsite: { configured: config.offsite !== null && !("error" in config.offsite), repository: offsite.repository, log: offsite.log } },
            startedAt,
            offsiteStop(dependencies, startedAt),
            asked,
          );
          if (asked) rmSync(join(config.stateFolder, MAINTENANCE_NOW), { force: true });
          if (outcome.ran) {
            audit.checks = { local: outcome.record.local?.ok ?? null, offsite: outcome.record.offsite?.ok ?? null };
            // The maintenance's own prune took what failures left, if it ran to its end.
            if (!(outcome.record.local?.error ?? "").startsWith("the prune failed")) {
              dirty = false;
              writeSetting(db, PRUNE_WANTED, false);
            }
          }
          checks = checksOf(outcome.record);
        }

        // --- What failures left, taken back before the lock goes
        if (dirty) {
          const result = await runExclusive(config, local, ["prune", "-q", "--max-repack-size", "0"], offsiteStop(dependencies, startedAt), log);
          if (result.code === 0) {
            audit.cleaned = true;
            if (db !== null) writeSetting(db, PRUNE_WANTED, false);
          } else log(resticJournal("backup: restic prune of what failures left", result));
        }
      }
    }
  } catch (error) {
    runError = `the run failed (${errorCode(error)}), see the journal of sitesolide-backup`;
    log(`backup: the run failed: ${(error as Error).message}`);
  } finally {
    if (lock.ok) lock.release();
  }

  const failed = Object.entries(projects).filter(([, status]) => !status.ok).map(([folder]) => folder);
  const status: RunStatus = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    ok: runError === null && failed.length === 0,
    projects,
    checks,
  };
  // Each written on its own: a status that cannot be written does not cost the audit, nor the reverse.
  try {
    writeStatus(config.stateFolder, status);
  } catch (error) {
    log(`backup: the status file could not be written: ${(error as Error).message}`);
  }
  if (db !== null) {
    try {
      recordAudit(db, { actor: "system", action: "backup.run", target: null, detail: { ok: status.ok, ...audit, failed, ...(runError === null ? {} : { error: runError }) } }, now());
    } catch (error) {
      log(`backup: the audit could not be written: ${(error as Error).message}`);
    } finally {
      db.close();
    }
  }
  return status;
}

/**
 * Every project, read when its turn comes, snapshotted within its share of
 * the window; those cut at their share are tried once more at the end, with
 * what is left. Returns the number of snapshots taken, whether a failure left
 * packs behind, and the snapshots restic would not forget; `listing` gains
 * the snapshots taken.
 */
async function snapshotStep(
  dependencies: RunDependencies,
  startedAt: number,
  projects: Record<string, ProjectStatus>,
  fail: (folder: string, error: string) => void,
  listing: Stored[],
): Promise<{ count: number; dirty: boolean; orphans: string[] }> {
  const { config, now, log } = dependencies;
  const windowEnd = startedAt + SNAPSHOT_DEADLINE_MS;
  const folders = projectFolders(config.sitesDir);
  const again: Project[] = [];
  let taken = 0;
  let dirty = false;
  const orphans: string[] = [];

  const attempt = async (project: Project, left: number, last: boolean, late: string) => {
    if (now() > windowEnd) {
      fail(project.folder, late);
      return;
    }
    const timeoutMs = projectTime(windowEnd - now(), left, config.childTimeoutMs);
    const takenAt = now();
    let outcome: SnapshotOutcome;
    try {
      outcome = await takeSnapshot(config, project, "scheduled", takenAt, log, { timeoutMs, existing: new Set(listing.filter((stored) => stored.folder === project.folder).map((stored) => stored.name)) });
    } catch (error) {
      log(`backup ${project.folder}: the snapshot failed: ${(error as Error).message}`);
      outcome = { ok: false, error: `the snapshot failed (${errorCode(error)}), see the journal of sitesolide-backup`, cause: null };
    }
    if (!outcome.ok) {
      if (outcome.dirty === true) dirty = true;
      orphans.push(...(outcome.orphans ?? []));
    }
    if (outcome.ok) {
      projects[project.folder] = { ok: true, snapshot: outcome.name, error: null };
      listing.push({ id: outcome.id, name: outcome.name, folder: project.folder, takenAt: Math.floor(takenAt / 1000) * 1000, kind: "scheduled", bytes: outcome.bytes, added: outcome.added });
      taken++;
      log(`backup ${project.folder}: ${outcome.name}, ${outcome.bytes ?? "?"} bytes, ${outcome.added ?? "?"} added`);
      return;
    }
    if (outcome.cause === "timeout" && !last) {
      again.push(project);
      log(`backup ${project.folder}: out of its time, tried again after the others`);
      return;
    }
    fail(project.folder, outcome.error);
    log(`backup ${project.folder}: ${outcome.error}`);
  };

  for (const [index, folder] of folders.entries()) {
    let found: Found;
    try {
      found = readProject(config.sitesDir, folder, config.accountsFile, config.checkOwners);
    } catch (error) {
      fail(folder, `the project could not be read (${errorCode(error)}), see the journal of sitesolide-backup`);
      log(`backup ${folder}: the project could not be read: ${(error as Error).message}`);
      continue;
    }
    if ("error" in found) {
      fail(found.folder, found.error);
      log(`backup ${found.folder}: ${found.error}`);
      continue;
    }
    if (found.excluded !== null) {
      projects[found.project.folder] = { ok: true, snapshot: null, error: null };
      continue;
    }
    await attempt(found.project, folders.length - index, false, "skipped: the run ran out of time before reaching it");
  }
  for (const [index, project] of again.entries()) await attempt(project, again.length - index, true, TIMEOUT_ERROR);
  return { count: taken, dirty, orphans };
}

/**
 * When every call to the bucket stops, as a time of `Date.now()`: the run's
 * own clock says how far into the run it is, the real one bounds the waits.
 */
function offsiteStop(dependencies: RunDependencies, startedAt: number): number {
  return Date.now() + (dependencies.offsiteStopMs ?? OFFSITE_STOP_MS) - (dependencies.now() - startedAt);
}

/** The bucket's objects of the format before restic, when there is a bucket; null when there is none or it does not answer. */
async function listLegacyObjects(dependencies: RunDependencies, startedAt: number): Promise<{ bucket: LegacyBucket; objects: RemoteObject[] } | null> {
  const { config, log } = dependencies;
  const setting = config.offsite;
  if (setting === null || "error" in setting) return null;
  const bucket = (dependencies.openLegacyBucket ?? openLegacyBucket)(setting);
  try {
    const listed = await within(bucket.list(), offsiteStop(dependencies, startedAt) - Date.now());
    if (listed === null) {
      log("backup: the bucket's objects of the format before restic could not be listed in time");
      return null;
    }
    return { bucket, objects: listed.value };
  } catch (error) {
    log(`backup: the bucket's objects of the format before restic could not be listed: ${redact((error as Error).message, setting)}`);
    return null;
  }
}

/** The names a folder's snapshots carry, for retention. */
const byFolder = (stored: readonly Stored[], folder: string) => stored.filter((snapshot) => snapshot.folder === folder);

/**
 * The bucket's repository: what it holds, what it lacks, what it keeps. Each
 * project's newest snapshot goes first, then the older ones the bucket lacks,
 * until the deadline: the snapshots the server's retention keeps and that the
 * bucket's would keep too, by id, never "everything" (restic copies again a
 * snapshot the bucket forgot, which would fight the bucket's retention every
 * hour). Every call is stopped at OFFSITE_STOP_MS, and nothing more is asked
 * of the bucket after. The bucket's stale locks go first: one left by a prune
 * or a check killed outright would otherwise refuse every later run, and every
 * restore from the bucket. Everything restic says of the bucket reaches the
 * journal with the bucket's credentials redacted.
 */
async function offsiteStep(
  dependencies: RunDependencies,
  db: Database | null,
  startedAt: number,
  fail: (folder: string, error: string) => void,
  local: readonly Stored[],
  legacy: { bucket: LegacyBucket; objects: RemoteObject[] } | null,
): Promise<{ audit: Record<string, unknown> | null; repository: Repository | null; log: (line: string) => void }> {
  const { config, now } = dependencies;
  const setting = config.offsite;
  const folders = [...new Set(local.map((snapshot) => snapshot.folder))].sort();
  if (setting === null) {
    if (db !== null) replaceSnapshots(db, "offsite", []);
    return { audit: null, repository: null, log: dependencies.log };
  }
  if ("error" in setting) {
    for (const folder of folders) fail(folder, `no offsite copy: ${setting.error}`);
    return { audit: { error: setting.error }, repository: null, log: dependencies.log };
  }
  const log = (line: string) => dependencies.log(redact(line, setting));
  const stopAt = offsiteStop(dependencies, startedAt);
  const bucket = bucketRepository(setting);
  const source = localRepository(config);
  const audit: Record<string, unknown> = {};

  await clearStaleLocks(config, bucket, stopAt, log);
  let listed = await listSnapshots(config, bucket, stopAt, [], log);
  if ("failure" in listed && listed.failure.code === 10) {
    // A bucket configured since the last run: its repository, with the
    // server's chunker parameters, so that what both hold is stored once.
    const made = await runExclusive(config, bucket, ["init", "-q", "--copy-chunker-params"], stopAt, log, { from: source });
    if (made.code === 0) {
      log("backup: the bucket's repository was initialised");
      audit.initialised = true;
      listed = { snapshots: [] };
    } else {
      log(resticJournal("backup: restic init of the bucket's repository", made));
      listed = { failure: made };
    }
  }
  if ("failure" in listed) {
    const message = `the bucket's repository could not be read: ${resticFailure(listed.failure, bucket)}`;
    log(resticJournal("backup: restic snapshots on the bucket's repository", listed.failure));
    for (const folder of folders) fail(folder, `no offsite copy: ${message}`);
    return { audit: { error: shortError(message) }, repository: null, log };
  }
  let remote = listed.snapshots;

  // What to copy: kept here, missing there, and kept there once added.
  const plan = new Map<string, Stored[]>();
  for (const folder of folders) {
    const kept = retain(byFolder(local, folder), config.retention).keep;
    const present = new Set(byFolder(remote, folder).map((snapshot) => snapshot.name));
    const missing = byFolder(local, folder).filter((snapshot) => kept.includes(snapshot.name) && !present.has(snapshot.name));
    const wouldKeep = new Set(retain([...byFolder(remote, folder), ...missing], config.retention).keep);
    const copies = missing.filter((snapshot) => wouldKeep.has(snapshot.name)).sort((a, b) => b.takenAt - a.takenAt);
    if (copies.length > 0) plan.set(folder, copies);
  }

  let copied = 0;
  let abandoned = false;
  const errors = new Map<string, string>();
  // Round one: each project's newest snapshot. Round two: the older ones.
  for (const round of [0, 1]) {
    for (const [folder, copies] of plan) {
      if (errors.has(folder)) continue;
      const wanted = round === 0 ? copies.slice(0, 1) : copies.slice(1);
      if (wanted.length === 0) continue;
      if (abandoned || now() - startedAt > OFFSITE_DEADLINE_MS) {
        // The older ones wait for the next run; a newest one skipped is a missing copy, said so.
        if (round === 0) errors.set(folder, "offsite copy skipped: the run ran out of time");
        continue;
      }
      const result = await runExclusive(config, bucket, ["copy", "-q", ...wanted.map((snapshot) => snapshot.id)], stopAt, log, { from: source });
      if (result.code === null) {
        abandoned = true;
        errors.set(folder, "offsite copy stopped: the run ran out of time");
        log(`backup ${folder}: the copy to the bucket was stopped at the run's offsite deadline`);
        continue;
      }
      if (result.code !== 0) {
        errors.set(folder, `offsite copy failed: ${resticFailure(result, bucket)}`);
        log(resticJournal(`backup ${folder}: restic copy`, result));
        continue;
      }
      copied += wanted.length;
    }
  }
  for (const [folder, error] of errors) fail(folder, error);

  // The bucket as it now stands: copied snapshots get ids of their own there.
  if (copied > 0 && !abandoned) {
    const again = await listSnapshots(config, bucket, stopAt, [], log);
    if ("failure" in again) log(resticJournal("backup: restic snapshots on the bucket's repository", again.failure));
    else remote = again.snapshots;
  }

  // Retention in the bucket: the same policy, over what the bucket holds.
  let pruned = 0;
  if (!abandoned) {
    const decided = forgotten(remote, config.retention);
    if (decided.forget.length > 0) {
      const result = await forgetSnapshots(config, bucket, decided.forget.map((snapshot) => snapshot.id), stopAt, log);
      if (result !== null && result.code === 0) {
        pruned = decided.forget.length;
        remote = decided.keep;
      } else if (result !== null) {
        log(resticJournal("backup: restic forget on the bucket's repository", result));
      }
    }
  }
  if (db !== null) replaceSnapshots(db, "offsite", indexed(remote));

  // The objects of the format before restic whose copy is safe in the bucket's repository.
  if (legacy !== null && db !== null && !abandoned) {
    const removed = await removeLegacyObjects({ ...dependencies, log }, db, legacy.bucket, legacy.objects, remote, stopAt);
    if (removed > 0) audit.legacyRemoved = removed;
  }
  return {
    audit: { copied, forgotten: pruned, ...audit, ...(errors.size === 0 ? {} : { failed: [...errors.keys()] }), ...(abandoned ? { abandoned: true } : {}) },
    repository: abandoned ? null : bucket,
    log,
  };
}
