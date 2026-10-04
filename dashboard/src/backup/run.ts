/**
 * A scheduled run, launched by sitesolide-backup.timer: every project's data
 * folder snapshotted, the old snapshots pruned, the bucket brought up to date,
 * and the status written for the monitor.
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
 */
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { readSnapshotName } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { newMaster } from "./crypto";
import { DATABASE_NAME, openDatabase, recordAudit, replaceOffsite, writeSetting } from "./database";
import { backupFolders, localSnapshots } from "./listing";
import { waitForLock } from "./lock";
import { objectKey, offsiteTarget, openBucket, redact, type Bucket, type Offsite, type RemoteObject } from "./offsite";
import { projectFolders, readProject, type Found, type Project } from "./projects";
import { retain } from "./retention";
import { within } from "./runner";
import { TIMEOUT_ERROR, takeSnapshot, type SnapshotOutcome } from "./snapshot";
import { shortError, writeStatus, type ProjectStatus, type RunStatus } from "./status";

export type RunDependencies = {
  config: BackupConfig;
  now: () => number;
  log: (line: string) => void;
  /** The bucket, opened from its settings. The tests point it at a local fake. */
  openBucket?: (offsite: Offsite) => Bucket;
  /** How long to wait for a restore in progress to finish. */
  lockWaitMs?: number;
  /** When, from the run's start, a call to the bucket still waiting is abandoned: OFFSITE_STOP_MS. */
  offsiteStopMs?: number;
};

/** A restore takes minutes; a run waits that long before giving up on this hour. */
export const LOCK_WAIT_MS = 15 * 60 * 1000;

/**
 * The share of the unit's time the offsite catch-up may use. The unit is killed
 * at 50 minutes: past 40, older uploads wait for the next run, and the status
 * file still gets written.
 */
export const OFFSITE_DEADLINE_MS = 40 * 60 * 1000;

/**
 * Past this, a call to the bucket still waiting, an upload begun at 39
 * minutes on a slow line for one, is abandoned and said so: the status file
 * must be written before systemd kills the run at 50.
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

export async function runBackups(dependencies: RunDependencies): Promise<RunStatus> {
  const { config, now, log } = dependencies;
  const startedAt = now();
  const projects: Record<string, ProjectStatus> = {};
  const fail = (folder: string, error: string, snapshot: string | null = null) => {
    projects[folder] = { ok: false, snapshot: projects[folder]?.snapshot ?? snapshot, error: shortError(error) };
  };
  const audit: Record<string, unknown> = {};
  let runError: string | null = null;

  const lock = await waitForLock(config.runFolder, "run", dependencies.lockWaitMs ?? LOCK_WAIT_MS);
  if (!lock.ok) {
    runError = lock.holder === null ? "the backup lock is held" : `a ${lock.holder.who} has held the backup lock since ${new Date(lock.holder.since).toISOString()}`;
    log(`backup: ${runError}, no run this time`);
  }

  // A database that does not open costs the audit and the bucket's index,
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
      }

      // --- The snapshots
      audit.snapshots = await snapshotStep(dependencies, startedAt, projects, fail);

      // --- Retention, on the server
      let pruned = 0;
      for (const folder of backupFolders(config.backupFolder)) {
        const decision = retain(localSnapshots(config.backupFolder, folder), config.retention);
        for (const name of decision.prune) {
          try {
            const path = join(config.backupFolder, folder, name);
            if (lstatSync(path).isFile()) {
              unlinkSync(path);
              pruned++;
            }
          } catch (error) {
            log(`backup ${folder}: ${name} not pruned (${(error as Error).message})`);
          }
        }
      }
      audit.pruned = pruned;

      // --- The bucket
      audit.offsite = await offsiteStep(dependencies, db, startedAt, fail);
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
 * what is left. Returns the number of snapshots taken.
 */
async function snapshotStep(
  dependencies: RunDependencies,
  startedAt: number,
  projects: Record<string, ProjectStatus>,
  fail: (folder: string, error: string) => void,
): Promise<number> {
  const { config, now, log } = dependencies;
  const windowEnd = startedAt + SNAPSHOT_DEADLINE_MS;
  const folders = projectFolders(config.sitesDir);
  const again: Project[] = [];
  let taken = 0;

  const attempt = async (project: Project, left: number, last: boolean, late: string) => {
    if (now() > windowEnd) {
      fail(project.folder, late);
      return;
    }
    const timeoutMs = projectTime(windowEnd - now(), left, config.childTimeoutMs);
    let outcome: SnapshotOutcome;
    try {
      outcome = await takeSnapshot(config, project, "scheduled", now(), log, { timeoutMs });
    } catch (error) {
      log(`backup ${project.folder}: the snapshot failed: ${(error as Error).message}`);
      outcome = { ok: false, error: `the snapshot failed (${errorCode(error)}), see the journal of sitesolide-backup`, cause: null };
    }
    if (outcome.ok) {
      projects[project.folder] = { ok: true, snapshot: outcome.name, error: null };
      taken++;
      log(`backup ${project.folder}: ${outcome.name}, ${outcome.bytes} bytes`);
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
  return taken;
}

/**
 * The bucket: what it holds, what it lacks, what it keeps. The newest snapshot
 * of each project goes first, then the older ones the bucket lacks, until the
 * deadline. Nothing is deleted from a listing that failed. Every call is
 * abandoned at OFFSITE_STOP_MS, and nothing more is asked of the bucket after.
 */
async function offsiteStep(
  dependencies: RunDependencies,
  db: Database | null,
  startedAt: number,
  fail: (folder: string, error: string) => void,
): Promise<Record<string, unknown> | null> {
  const { config, now, log } = dependencies;
  const setting = config.offsite;
  if (setting === null) return null;
  const folders = backupFolders(config.backupFolder);
  if ("error" in setting) {
    for (const folder of folders) if (localSnapshots(config.backupFolder, folder).length > 0) fail(folder, `no offsite copy: ${setting.error}`);
    return { error: setting.error };
  }
  const stopAt = startedAt + (dependencies.offsiteStopMs ?? OFFSITE_STOP_MS);
  const bounded = <T>(promise: Promise<T>) => within(promise, stopAt - now());

  const bucket = (dependencies.openBucket ?? openBucket)(setting);
  let remote: RemoteObject[];
  try {
    const listed = await bounded(bucket.list());
    if (listed === null) throw new Error("no answer in time");
    remote = listed.value;
  } catch (error) {
    const message = `the bucket could not be listed: ${redact((error as Error).message, setting)}`;
    for (const folder of folders) fail(folder, `no offsite copy: ${message}`);
    return { error: shortError(message) };
  }

  const master = await newMaster(setting.passphrase);
  const present = new Set(remote.map((object) => object.key));
  let uploaded = 0;
  let abandoned = false;
  const errors = new Map<string, string>();
  // Round one: each project's newest snapshot. Round two: the older ones.
  for (const round of [0, 1]) {
    for (const folder of folders) {
      if (errors.has(folder)) continue;
      const kept = retain(localSnapshots(config.backupFolder, folder), config.retention).keep;
      const missing = kept.filter((name) => !present.has(objectKey(setting, folder, name)));
      const wanted = round === 0 ? missing.slice(0, 1) : missing;
      for (const name of wanted) {
        if (abandoned || now() - startedAt > OFFSITE_DEADLINE_MS) {
          // The older ones wait for the next run; a newest one skipped is a missing copy, said so.
          if (round === 0) errors.set(folder, "offsite upload skipped: the run ran out of time");
          break;
        }
        const key = objectKey(setting, folder, name);
        try {
          const sent = await bounded(bucket.upload(key, join(config.backupFolder, folder, name), master));
          if (sent === null) {
            abandoned = true;
            errors.set(folder, "offsite upload stopped: the run ran out of time");
            log(`backup ${folder}: ${name} not uploaded, abandoned at the run's offsite deadline`);
            break;
          }
          present.add(key);
          const snapshot = readSnapshotName(folder, name)!;
          remote.push({ folder, snapshot, key, bytes: sent.value });
          uploaded++;
        } catch (error) {
          const message = redact((error as Error).message, setting);
          errors.set(folder, `offsite upload failed: ${message}`);
          log(`backup ${folder}: ${name} not uploaded (${message})`);
          break;
        }
      }
    }
  }
  for (const [folder, error] of errors) fail(folder, error);

  // Retention in the bucket: the same policy, over what the bucket holds.
  let pruned = 0;
  const byFolder = new Map<string, RemoteObject[]>();
  for (const object of remote) byFolder.set(object.folder, [...(byFolder.get(object.folder) ?? []), object]);
  const kept: RemoteObject[] = [];
  for (const [folder, objects] of byFolder) {
    const decision = retain(objects.map((object) => object.snapshot), config.retention);
    const prune = new Set(decision.prune);
    for (const object of objects) {
      if (abandoned || !prune.has(object.snapshot.name)) {
        kept.push(object);
        continue;
      }
      try {
        const removed = await bounded(bucket.remove(object.key));
        if (removed === null) {
          abandoned = true;
          kept.push(object);
          log(`backup ${folder}: ${object.key} not pruned from the bucket, abandoned at the run's offsite deadline`);
          continue;
        }
        pruned++;
      } catch (error) {
        kept.push(object);
        log(`backup ${folder}: ${object.key} not pruned from the bucket (${(error as Error).message})`);
      }
    }
  }
  if (db !== null) replaceOffsite(db, kept.map((object) => ({ folder: object.folder, name: object.snapshot.name, bytes: object.bytes })));
  return { uploaded, pruned, ...(errors.size === 0 ? {} : { failed: [...errors.keys()] }), ...(abandoned ? { abandoned: true } : {}) };
}
