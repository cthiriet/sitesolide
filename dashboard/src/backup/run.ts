/**
 * A scheduled run, launched by sitesolide-backup.timer: every project's data
 * folder snapshotted, the old snapshots pruned, the bucket brought up to date,
 * and the status written for the monitor.
 *
 * In this order, and each step tolerant of the others: a project that fails
 * does not stop the next one, a bucket that does not answer does not cost the
 * local snapshots, and the status file is written whatever happened, so that
 * a silent machine is never mistaken for a healthy one.
 */
import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readSnapshotName } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { newMaster } from "./crypto";
import { DATABASE_NAME, openDatabase, recordAudit, replaceOffsite, writeSetting } from "./database";
import { backupFolders, localSnapshots } from "./listing";
import { waitForLock } from "./lock";
import { objectKey, offsiteTarget, openBucket, redact, type Bucket, type Offsite, type RemoteObject } from "./offsite";
import { listProjects } from "./projects";
import { retain } from "./retention";
import { takeSnapshot } from "./snapshot";
import { shortError, writeStatus, type ProjectStatus, type RunStatus } from "./status";

export type RunDependencies = {
  config: BackupConfig;
  now: () => number;
  log: (line: string) => void;
  /** The bucket, opened from its settings. The tests point it at a local fake. */
  openBucket?: (offsite: Offsite) => Bucket;
  /** How long to wait for a restore in progress to finish. */
  lockWaitMs?: number;
};

/** A restore takes minutes; a run waits that long before giving up on this hour. */
export const LOCK_WAIT_MS = 15 * 60 * 1000;

/**
 * The share of the unit's time the offsite catch-up may use. The unit is killed
 * at 50 minutes: past 40, older uploads wait for the next run, and the status
 * file still gets written.
 */
export const OFFSITE_DEADLINE_MS = 40 * 60 * 1000;

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

  const db = openDatabase(join(config.stateFolder, DATABASE_NAME));
  try {
    if (lock.ok) {
      writeSetting(db, "retention", config.retention);
      writeSetting(db, "offsite", {
        target: config.offsite !== null && !("error" in config.offsite) ? offsiteTarget(config.offsite) : null,
        error: config.offsite !== null && "error" in config.offsite ? config.offsite.error : null,
      });

      // --- The snapshots
      const taken: string[] = [];
      for (const found of listProjects(config.sitesDir, config.accountsFile, config.checkOwners)) {
        if ("error" in found) {
          fail(found.folder, found.error);
          log(`backup ${found.folder}: ${found.error}`);
          continue;
        }
        const { project, excluded } = found;
        if (excluded !== null) {
          projects[project.folder] = { ok: true, snapshot: null, error: null };
          continue;
        }
        const outcome = await takeSnapshot(config, project, "scheduled", now(), log);
        if (outcome.ok) {
          projects[project.folder] = { ok: true, snapshot: outcome.name, error: null };
          taken.push(project.folder);
          log(`backup ${project.folder}: ${outcome.name}, ${outcome.bytes} bytes`);
        } else {
          fail(project.folder, outcome.error);
          log(`backup ${project.folder}: ${outcome.error}`);
        }
      }
      audit.snapshots = taken.length;

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
    // The code or the name only in the status: a system error's message quotes a path.
    const code = (error as { code?: unknown } | null)?.code;
    runError = `the run failed (${typeof code === "string" ? code : (error as Error).name}), see the journal of sitesolide-backup`;
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
  try {
    writeStatus(config.stateFolder, status);
  } finally {
    recordAudit(db, { actor: "system", action: "backup.run", target: null, detail: { ok: status.ok, ...audit, failed, ...(runError === null ? {} : { error: runError }) } }, now());
    db.close();
  }
  return status;
}

/**
 * The bucket: what it holds, what it lacks, what it keeps. The newest snapshot
 * of each project goes first, then the older ones the bucket lacks, until the
 * deadline. Nothing is deleted from a listing that failed.
 */
async function offsiteStep(
  dependencies: RunDependencies,
  db: ReturnType<typeof openDatabase>,
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

  const bucket = (dependencies.openBucket ?? openBucket)(setting);
  let remote: RemoteObject[];
  try {
    remote = await bucket.list();
  } catch (error) {
    const message = `the bucket could not be listed: ${redact((error as Error).message, setting)}`;
    for (const folder of folders) fail(folder, `no offsite copy: ${message}`);
    return { error: shortError(message) };
  }

  const master = await newMaster(setting.passphrase);
  const present = new Set(remote.map((object) => object.key));
  let uploaded = 0;
  const errors = new Map<string, string>();
  // Round one: each project's newest snapshot. Round two: the older ones.
  for (const round of [0, 1]) {
    for (const folder of folders) {
      if (errors.has(folder)) continue;
      const kept = retain(localSnapshots(config.backupFolder, folder), config.retention).keep;
      const missing = kept.filter((name) => !present.has(objectKey(setting, folder, name)));
      const wanted = round === 0 ? missing.slice(0, 1) : missing;
      for (const name of wanted) {
        if (round === 1 && now() - startedAt > OFFSITE_DEADLINE_MS) break;
        const key = objectKey(setting, folder, name);
        try {
          const bytes = await bucket.upload(key, join(config.backupFolder, folder, name), master);
          present.add(key);
          const snapshot = readSnapshotName(folder, name)!;
          remote.push({ folder, snapshot, key, bytes });
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
      if (!prune.has(object.snapshot.name)) {
        kept.push(object);
        continue;
      }
      try {
        await bucket.remove(object.key);
        pruned++;
      } catch (error) {
        kept.push(object);
        log(`backup ${folder}: ${object.key} not pruned from the bucket (${(error as Error).message})`);
      }
    }
  }
  replaceOffsite(db, kept.map((object) => ({ folder: object.folder, name: object.snapshot.name, bytes: object.bytes })));
  return { uploaded, pruned, ...(errors.size === 0 ? {} : { failed: [...errors.keys()] }) };
}
