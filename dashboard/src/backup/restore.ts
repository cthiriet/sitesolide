/**
 * A restore, launched by the steward as `sitesolide-restore@<folder>.service`,
 * one project per start. In order, and the order is the point:
 *
 *   1. read and consume the request; refuse the dashboard and the portal
 *   2. take the backup lock: never beside a run, which could prune the snapshot
 *   3. repair what an interrupted restore left, or refuse
 *   4. fetch the snapshot, from the server or from the bucket
 *   5. extract it beside the data, as the project, while the service still
 *      runs: a snapshot that does not extract changes nothing
 *   6. check that the unit has the time left for what follows, or refuse
 *   7. stop the project's services, leaving a mark that says so
 *   8. snapshot the current data, `pre-restore`: the restore can be undone
 *   9. swap the folders: data aside, the snapshot in its place
 *  10. start the services and watch them for eight seconds
 *  11. running: the previous data goes. Not running: it comes back, and the
 *      services start on it again
 *
 * Every phase is written to the result file the steward reads, and the whole
 * restore is recorded in the component's audit, with the requester the
 * dashboard named.
 *
 * **A restore cut short never leaves a site stopped.** The mark written before
 * the stop is removed only once the restore has started the services again
 * itself. Killed in between, by its unit's timeout or by anything else, it
 * leaves the mark, and the unit's ExecStopPost (`backup.js after-restore`,
 * afterRestore below) repairs what is certain and starts the services. Step 6
 * makes that the exception: nothing is stopped without the time to finish.
 *
 * **No network here.** The unit denies it: a snapshot only the bucket holds is
 * fetched by a child of its own, a dynamic user with the network and no right
 * on any project (runner.ts), whose output is written here within a time and
 * above the disk's reserve.
 *
 * NEVER `caddy stop` or `caddy start`, and nothing here touches Caddy at all:
 * a restore changes a data folder and restarts that project's services.
 */
import { chownSync, chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { readSnapshotName } from "../../borrowed/backups";
import { servicesOf } from "../../borrowed/manifest";
import { unitArgument } from "../../borrowed/unit";
import { readShow, showArguments, verdict, type ServiceReading } from "../secrets/restart";
import type { Verdict } from "../secrets/protocol";
import { label } from "../secrets/scope";
import { unitOf } from "../state";
import type { BackupConfig } from "./config";
import { DATABASE_NAME, openDatabase, recordAudit } from "./database";
import { takeLock, waitForLock } from "./lock";
import { freeBytes, readProject, type Project } from "./projects";
import { DATA, FAILED, INCOMING, PREVIOUS, recoveryPlan, type Present } from "./recovery";
import {
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  REQUESTS_NAME,
  RESULTS_NAME,
  excludedFromRestore,
  pageMessage,
  readRequest,
  type RestoreRequest,
  type RestoreResult,
} from "./request";
import { startChild, within, type Job } from "./runner";
import { takeSnapshot } from "./snapshot";
import { syncFolder, writeFileAtomically } from "./status";

export type Command = { code: number; output: string };

export type RestoreDependencies = {
  config: BackupConfig;
  now: () => number;
  log: (line: string) => void;
  systemctl: (args: string[], timeoutMs: number) => Promise<Command>;
  wait?: (ms: number) => Promise<void>;
  /** Eight seconds of watching after the start, a reading every half second. */
  observationMs?: number;
  stepMs?: number;
  lockWaitMs?: number;
  /** The unit's TimeoutStartSec, which the restore must finish within: RESTORE_TIMEOUT_MS. */
  unitTimeoutMs?: number;
  /** The longest a download from the bucket may take: DOWNLOAD_TIMEOUT_MS. */
  downloadTimeoutMs?: number;
};

/** A run takes minutes; a restore waits that long for it, the page showing why. */
export const RESTORE_LOCK_WAIT_MS = 10 * 60 * 1000;
export const OBSERVATION_MS = 8000;
export const STEP_MS = 500;
const SYSTEMCTL_TIMEOUT_MS = 90_000;

/** sitesolide-restore@.service's TimeoutStartSec, which tests/backup-units.test.ts holds equal. */
export const RESTORE_TIMEOUT_MS = 90 * 60 * 1000;
/** What a restore needs after the snapshot of the current data: the swap, the start, the watch, a rollback. */
export const AFTER_STOP_MS = 10 * 60 * 1000;
/** A bucket's copy of several gigabytes takes minutes; beyond this, the line or the bucket is the problem. */
export const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
/** Measuring a data folder is `lstat` alone. */
export const MEASURE_TIMEOUT_MS = 10 * 60 * 1000;
/** The least a raw copy of the current data is given, should the consistent one fail. */
const MIN_RAW_MS = 60_000;
/** How often, in bytes written, the free space is measured again during a download. */
const CHECK_EVERY = 64 * 1024 * 1024;
/** How long a child that ran out of time is still listened to. */
const REPORT_GRACE_MS = 2000;

/** The mark a restore leaves while the project's services are stopped. */
export const STOPPED_SUFFIX = ".stopped";

/** Nothing was changed: the request, the site or the snapshot is not fit. */
class Refused extends Error {
  override name = "Refused";
}

/** Something was tried and did not work out; the message says in which state it left the site. */
class Failure extends Error {
  override name = "Failure";
}

function errorText(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

/** The request, read once and removed: a request is never acted on twice. */
export function consumeRequest(stateFolder: string, folder: string, checkOwners: boolean, now: number): { request: RestoreRequest } | { refusal: string } {
  const path = join(stateFolder, REQUESTS_NAME, `${folder}.json`);
  let text: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) {
      rmSync(path, { force: true, recursive: false });
      return { refusal: "the restore request is not a plain file" };
    }
    if (checkOwners && (stat.uid !== 0 || (stat.mode & 0o077) !== 0)) {
      unlinkSync(path);
      return { refusal: "the restore request is not root's alone" };
    }
    text = readFileSync(path, "utf8");
    unlinkSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { refusal: "no restore request for this site: restores are started from the dashboard" };
    return { refusal: `the restore request cannot be read (${errorText(error)})` };
  }
  return readRequest(folder, text, now);
}

/**
 * The project's units: the main one, then its other services, as the deploy
 * named them. The others' names are drawn from the manifest's slug, which
 * must therefore be the folder's own: a manifest naming another project would
 * have this restore stop and start that project's services. Null then.
 */
export function projectUnits(project: Project): string[] | null {
  const main = unitOf(project.folder);
  if (project.manifest === null) return [main];
  if (project.manifest.slug !== label(project.folder)) return null;
  return [main, ...servicesOf(project.manifest).slice(1).map((service) => unitArgument(service.unit))];
}

/** A child of the restore, waited for within its time, and killed past it. */
async function runChild(job: Job, config: BackupConfig, what: string) {
  const child = startChild(job, config);
  const finished = await within(child.result, job.timeoutMs + REPORT_GRACE_MS);
  if (finished === null) {
    child.stop();
    throw new Refused(`${what} did not finish in time, nothing was changed`);
  }
  return finished.value;
}

export async function restore(dependencies: RestoreDependencies, folder: string): Promise<RestoreResult> {
  const { config, now, log } = dependencies;
  const wait = dependencies.wait ?? ((ms: number) => Bun.sleep(ms));
  const startedAt = now();
  // Root's alone: a refused archive's message may quote a file name of the
  // project's data, which only the steward, and the dashboard's user, may read.
  const resultsFolder = join(config.runFolder, RESULTS_NAME);
  mkdirSync(resultsFolder, { recursive: true, mode: 0o700 });

  const result: RestoreResult = { nonce: null, state: "running", message: "Reading the request.", snapshot: null, preRestore: null, actor: null, startedAt, at: startedAt };
  const publish = (state: RestoreResult["state"], message: string) => {
    result.state = state;
    result.message = pageMessage(message);
    result.at = now();
    writeFileAtomically(resultsFolder, `${folder}.json`, `${JSON.stringify(result)}\n`, 0o600);
    log(`restore ${folder}: ${state}, ${result.message}`);
  };
  publish("running", "Reading the request.");

  const consumed = consumeRequest(config.stateFolder, folder, config.checkOwners, now());
  if ("refusal" in consumed) {
    publish("rejects", consumed.refusal);
    return result;
  }
  const { request } = consumed;
  result.nonce = request.nonce;
  result.snapshot = request.snapshot;
  result.actor = request.actor;

  let releaseLock: (() => void) | null = null;
  let held: string | null = null;
  let raw = false;
  // The services stopped, and not started again yet by this restore: see afterRestore.
  const stoppedMark = join(resultsFolder, `${folder}${STOPPED_SUFFIX}`);
  const markStopped = (units: string[]) => writeFileAtomically(resultsFolder, `${folder}${STOPPED_SUFFIX}`, `${JSON.stringify({ units })}\n`, 0o600);
  const clearStopped = () => rmSync(stoppedMark, { force: true });
  try {
    const excluded = excludedFromRestore(folder);
    if (excluded !== null) throw new Refused(excluded);

    publish("running", "Waiting for any backup run to finish.");
    const lock = await waitForLock(config.runFolder, "restore", dependencies.lockWaitMs ?? RESTORE_LOCK_WAIT_MS);
    if (!lock.ok) throw new Refused("a backup run is still going on: try again in a few minutes");
    releaseLock = lock.release;

    const found = readProject(config.sitesDir, folder, config.accountsFile, config.checkOwners);
    if ("error" in found) throw new Refused(`${folder}: ${found.error}`);
    const { project } = found;
    const projectUnitNames = projectUnits(project);
    if (projectUnitNames === null) throw new Refused(`${folder}: its sitesolide.json names another slug, so its services cannot be named safely`);
    const root = join(config.sitesDir, folder);

    // --- Leftovers of an interrupted restore
    const plan = recoveryPlan(presentIn(root));
    if (plan.kind === "refuse") throw new Refused(plan.reason);
    for (const step of plan.steps) {
      if ("rename" in step) renameSync(join(root, step.rename[0]), join(root, step.rename[1]));
      else rmSync(join(root, step.remove), { recursive: true, force: true });
    }
    if (plan.note !== null) log(`restore ${folder}: ${plan.note}`);
    const dataStat = lstatOrNull(join(root, DATA));
    if (dataStat === null || !dataStat.isDirectory() || dataStat.isSymbolicLink()) throw new Refused(`${folder} has no data folder to restore into`);

    // --- The snapshot
    publish("running", "Fetching the snapshot.");
    const archive = await fetchSnapshot(dependencies, project, request.snapshot, (path) => (held = path));

    // --- Extraction beside the data, as the project. The room keeps what the
    // snapshot of the current data will need, measured by the project too:
    // root never walks a project's tree.
    const measured = await runChild(
      { mode: "measure", folder, account: project.account, uid: project.owner?.uid ?? null, args: [project.dataDir], readWrite: [], bind: [project.dataDir], cacheDirectory: null, stdin: null, stdout: "ignore", timeoutMs: MEASURE_TIMEOUT_MS },
      config,
      "measuring the current data",
    );
    const current = measured.report.summary?.bytes;
    if (measured.code !== 0 || typeof current !== "number") {
      throw new Refused(`the current data could not be measured, nothing was changed: ${measured.report.error ?? (measured.report.tail || `exit code ${measured.code}`)}`);
    }
    const room = freeBytes(root) - config.reserveBytes - 2 * current;
    if (room <= 0) throw new Refused("not enough disk space to extract the snapshot and save the current data first");
    publish("running", "Extracting the snapshot.");
    const incoming = join(root, INCOMING);
    mkdirSync(incoming, { mode: 0o700 });
    // The mode first, while root still owns it: afterwards it would take CAP_FOWNER.
    chmodSync(incoming, dataStat.mode & 0o777);
    if (project.owner !== null) chownSync(incoming, project.owner.uid, project.owner.gid);
    const takenAt = readSnapshotName(folder, request.snapshot)!.takenAt;
    let extracted;
    try {
      extracted = await runChild(
        {
          mode: "extract",
          folder,
          account: project.account,
          uid: project.owner?.uid ?? null,
          args: [incoming, String(room), folder, String(takenAt)],
          readWrite: [incoming],
          bind: [incoming],
          cacheDirectory: null,
          stdin: archive,
          stdout: "ignore",
          timeoutMs: config.childTimeoutMs,
        },
        config,
        "the extraction",
      );
    } catch (error) {
      rmSync(incoming, { recursive: true, force: true });
      throw error;
    }
    if (extracted.code !== 0 || extracted.report.summary === null) {
      rmSync(incoming, { recursive: true, force: true });
      throw new Refused(`the snapshot could not be extracted, nothing was changed: ${extracted.report.error ?? (extracted.report.tail || `exit code ${extracted.code}`)}`);
    }

    // --- The time for what follows, or nothing is stopped
    const unitTimeoutMs = dependencies.unitTimeoutMs ?? RESTORE_TIMEOUT_MS;
    if (unitTimeoutMs - (now() - startedAt) < config.childTimeoutMs + AFTER_STOP_MS) {
      rmSync(incoming, { recursive: true, force: true });
      throw new Refused("not enough time left in this restore to save the current data and swap it safely, nothing was changed: start it again");
    }

    // --- Stop, save, swap, start
    const units = await loadedUnits(dependencies, projectUnitNames);
    if (units.length > 0) {
      publish("running", `Stopping ${folder}.`);
      markStopped(units);
      await dependencies.systemctl(["stop", ...units], SYSTEMCTL_TIMEOUT_MS);
      // A service still running would keep writing into the folder about to be
      // set aside, and its writes would be lost with it.
      for (const unit of units) {
        const state = (await dependencies.systemctl(["is-active", unit], SYSTEMCTL_TIMEOUT_MS)).output.trim();
        if (state === "active" || state === "activating" || state === "deactivating" || state === "reloading") {
          rmSync(incoming, { recursive: true, force: true });
          await dependencies.systemctl(["start", units[0]!], SYSTEMCTL_TIMEOUT_MS);
          clearStopped();
          throw new Failure(`${unit} did not stop (${state}), so nothing was changed`);
        }
      }
    }

    publish("running", "Saving the current data first.");
    // The services are stopped: no backup command runs, there is no server to
    // ask, and a live database folder is saved as the files its server left.
    let saved = await takeSnapshot(config, project, "pre-restore", now(), log, { timeoutMs: config.childTimeoutMs, stopped: true });
    // A database the copy cannot read consistently is often the very reason
    // for the restore. The services are stopped: nothing writes, and the files
    // as they are, side files included, are what SQLite itself would recover
    // from. Saved so, and said so, rather than refusing the restore.
    const leftForRaw = unitTimeoutMs - (now() - startedAt) - AFTER_STOP_MS;
    if (!saved.ok && saved.cause === "database" && leftForRaw >= MIN_RAW_MS) {
      publish("running", "A database of the current data cannot be read consistently: saving it as raw files.");
      log(`restore ${folder}: ${saved.error}; the current data is saved as raw files`);
      saved = await takeSnapshot(config, project, "pre-restore", now(), log, { timeoutMs: Math.min(config.childTimeoutMs, leftForRaw), raw: true, stopped: true });
    }
    if (!saved.ok) {
      rmSync(incoming, { recursive: true, force: true });
      if (units.length > 0) await dependencies.systemctl(["start", units[0]!], SYSTEMCTL_TIMEOUT_MS);
      clearStopped();
      throw new Failure(`the current data could not be saved first, so nothing was changed: ${saved.error}`);
    }
    result.preRestore = saved.name;
    raw = saved.raw;

    publish("running", "Putting the snapshot in place.");
    renameSync(join(root, DATA), join(root, PREVIOUS));
    renameSync(incoming, join(root, DATA));
    syncFolder(root);

    const restored = units.length === 0 ? null : await startAndWatch(dependencies, units, wait, () => publish("running", `Starting ${folder}.`));
    if (restored === null || restored.running) {
      clearStopped();
      rmSync(join(root, PREVIOUS), { recursive: true, force: true });
      publish(
        "ok",
        `Restored ${folder} from the snapshot of ${new Date(takenAt).toISOString().slice(0, 16).replace("T", " ")} UTC.${restored === null ? "" : ` ${folder} is running.`} The data it replaced is saved as a before-restore snapshot${raw ? ", as raw files: one of its databases could not be read consistently" : ""}.`,
      );
      return result;
    }

    // --- The service did not come back: the previous data goes back in.
    publish("running", `${folder} did not start on the restored data. Putting the previous data back.`);
    await dependencies.systemctl(["stop", ...units], SYSTEMCTL_TIMEOUT_MS);
    renameSync(join(root, DATA), join(root, FAILED));
    renameSync(join(root, PREVIOUS), join(root, DATA));
    syncFolder(root);
    const back = await startAndWatch(dependencies, units, wait, () => undefined);
    clearStopped();
    rmSync(join(root, FAILED), { recursive: true, force: true });
    throw new Failure(
      `${folder} did not start on the restored data (${restored.detail}). The previous data is back and ${folder} is ${back.running ? "running again" : `still not running (${back.detail})`}.`,
    );
  } catch (error) {
    if (error instanceof Refused) publish("rejects", error.message);
    else if (error instanceof Failure) publish("failure", error.message);
    else publish("failure", `the restore failed: ${errorText(error)}. Check the site and the journal: journalctl -u sitesolide-restore@${folder}`);
    return result;
  } finally {
    if (held !== null) rmSync(held, { force: true });
    releaseLock?.();
    auditRestore(dependencies, folder, result, raw ? { preRestoreRaw: true } : {});
  }
}

function auditRestore(dependencies: Pick<RestoreDependencies, "config" | "now" | "log">, folder: string, result: RestoreResult, extra: Record<string, unknown>): void {
  const { config, now, log } = dependencies;
  try {
    const db = openDatabase(join(config.stateFolder, DATABASE_NAME));
    try {
      recordAudit(
        db,
        {
          actor: result.actor ?? "system",
          action: "backup.restore",
          target: folder,
          detail: { result: result.state === "running" ? "failure" : result.state, snapshot: result.snapshot, preRestore: result.preRestore, message: result.message, ...extra },
        },
        now(),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    log(`restore ${folder}: audit not written (${errorText(error)})`);
  }
}

function presentIn(root: string): Present {
  return {
    data: exists(join(root, DATA)),
    incoming: exists(join(root, INCOMING)),
    previous: exists(join(root, PREVIOUS)),
    failed: exists(join(root, FAILED)),
  };
}

function exists(path: string): boolean {
  return lstatOrNull(path) !== null;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * The archive to extract: the server's own file, or the bucket's copy,
 * decrypted by a download child into a root-only folder, removed once the
 * restore is over. The download is stopped past its time, or when the disk
 * comes down to its reserve.
 */
async function fetchSnapshot(dependencies: RestoreDependencies, project: Project, name: string, hold: (path: string) => void): Promise<string> {
  const { config } = dependencies;
  const local = join(config.backupFolder, project.folder, name);
  const stat = lstatOrNull(local);
  if (stat !== null && stat.isFile()) return local;

  const setting = config.offsite;
  if (setting === null || "error" in setting) throw new Refused("this snapshot is no longer on the server, and no bucket is configured");
  const downloads = join(config.stateFolder, "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  if (freeBytes(downloads) < config.reserveBytes) throw new Refused("not enough disk space to fetch the snapshot from the bucket");
  const target = join(downloads, name);
  hold(target);
  rmSync(target, { force: true });
  const timeoutMs = dependencies.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    const child = startChild(
      { mode: "download", folder: project.folder, account: null, uid: null, args: [project.folder, name], readWrite: [], bind: [], cacheDirectory: null, stdin: null, stdout: "pipe", timeoutMs, offsite: setting },
      config,
    );
    const reader = child.stdout!.getReader();
    let written = 0;
    let nextCheck = CHECK_EVERY;
    let stopped: string | null = null;
    for (;;) {
      const next = await within(reader.read(), deadline - Date.now());
      if (next === null) {
        stopped = "the snapshot could not be fetched from the bucket in time";
        break;
      }
      const { done, value } = next.value;
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) offset += writeSync(fd, value, offset, value.byteLength - offset);
      written += value.byteLength;
      if (written >= nextCheck) {
        nextCheck += CHECK_EVERY;
        if (freeBytes(downloads) < config.reserveBytes) {
          stopped = "not enough disk space to fetch the snapshot from the bucket";
          break;
        }
      }
    }
    if (stopped !== null) {
      void reader.cancel().catch(() => undefined);
      child.stop();
      throw new Refused(stopped);
    }
    const finished = await within(child.result, Math.max(deadline - Date.now(), REPORT_GRACE_MS));
    if (finished === null) {
      child.stop();
      throw new Refused("the snapshot could not be fetched from the bucket in time");
    }
    if (finished.value.code !== 0 || finished.value.report.summary === null) {
      throw new Refused(`the snapshot could not be fetched from the bucket: ${finished.value.report.error ?? (finished.value.report.tail || `exit code ${finished.value.code}`)}`);
    }
    if (written === 0) throw new Refused("the snapshot fetched from the bucket is empty");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return target;
}

/** The project's units systemd knows: a project without one has nothing to stop. */
async function loadedUnits(dependencies: Pick<RestoreDependencies, "systemctl">, units: string[]): Promise<string[]> {
  const loaded: string[] = [];
  for (const unit of units) {
    const response = await dependencies.systemctl(["show", unit, "-p", "LoadState", "--value"], SYSTEMCTL_TIMEOUT_MS);
    if (response.code === 0 && response.output.trim() === "loaded") loaded.push(unit);
  }
  return loaded;
}

/**
 * Starts the main unit, which starts the others, and watches it like the
 * steward watches a restart (src/secrets/restart.ts): running, with a restart
 * counter that does not move, for the last three seconds of eight. The other
 * units are then asked once whether they are active.
 */
async function startAndWatch(
  dependencies: RestoreDependencies,
  units: string[],
  wait: (ms: number) => Promise<void>,
  announce: () => void,
): Promise<{ running: boolean; detail: string }> {
  const [main, ...others] = units as [string, ...string[]];
  announce();
  await dependencies.systemctl(["reset-failed", ...units], SYSTEMCTL_TIMEOUT_MS);
  await dependencies.systemctl(["start", main], SYSTEMCTL_TIMEOUT_MS);
  const readings: ServiceReading[] = [];
  const start = dependencies.now();
  const observationMs = dependencies.observationMs ?? OBSERVATION_MS;
  for (;;) {
    const response = await dependencies.systemctl(showArguments(main), SYSTEMCTL_TIMEOUT_MS);
    if (response.code === 0) readings.push({ ...readShow(response.output), a: dependencies.now() });
    if (dependencies.now() - start >= observationMs) break;
    await wait(dependencies.stepMs ?? STEP_MS);
  }
  const seen: Verdict = verdict(readings);
  if (seen.kind !== "active") return { running: false, detail: `${main} ${seen.kind}, ${seen.state}/${seen.subState}` };
  for (const unit of others) {
    const response = await dependencies.systemctl(["is-active", unit], SYSTEMCTL_TIMEOUT_MS);
    if (response.output.trim() !== "active") return { running: false, detail: `${unit} ${response.output.trim() || "not active"}` };
  }
  return { running: true, detail: "running" };
}

// --- After the unit stops ------------------------------------------------------

/** A unit's name as a restore writes it in its mark: a project's unit, nothing a shell would read. */
const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,250}$/;

/** A root-only file of the results folder, read whole, or null. */
function readOwn(path: string, checkOwners: boolean): string | null {
  const stat = lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.size > MAX_RESULT_BYTES) return null;
  if (checkOwners && (stat.uid !== 0 || (stat.mode & 0o077) !== 0)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The units a restore stopped and has not started again, from its mark; null when there is none. */
export function readStoppedMark(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { units?: unknown };
    const units = parsed.units;
    if (!Array.isArray(units) || units.length === 0 || units.length > 64) return null;
    return units.every((unit) => typeof unit === "string" && UNIT_NAME.test(unit)) ? (units as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * The unit's ExecStopPost: runs once the restore's process is gone, however
 * it went. A restore that finished left neither its mark nor a `running`
 * result, and nothing is done. Otherwise it was cut short:
 *
 * - services stopped (the mark is there): what is certain is repaired, as the
 *   next restore would (recovery.ts), under the lock the dead restore can no
 *   longer hold, and the services are started again, on their current data,
 *   or on the restored data when the swap was done and that is what they
 *   were started on;
 * - nothing stopped: the result says the restore was cut short before
 *   changing anything.
 *
 * The result file and the audit say what happened, for the page.
 */
export async function afterRestore(dependencies: Pick<RestoreDependencies, "config" | "now" | "log" | "systemctl">, folder: string): Promise<void> {
  const { config, now, log } = dependencies;
  const resultsFolder = join(config.runFolder, RESULTS_NAME);
  const markPath = join(resultsFolder, `${folder}${STOPPED_SUFFIX}`);
  const units = readStoppedMark(readOwn(markPath, config.checkOwners));
  let previous: Partial<RestoreResult> | null = null;
  try {
    const text = readOwn(join(resultsFolder, `${folder}.json`), config.checkOwners);
    previous = text === null ? null : (JSON.parse(text) as Partial<RestoreResult>);
  } catch {
    previous = null;
  }
  const cutShort = previous === null || previous.state === "running";
  // No mark and no restore said to be running: it finished, or never began.
  if (units === null && previous?.state !== "running") return;

  let message: string;
  if (units === null) {
    message = "The restore was cut short before it changed anything: start it again from the dashboard.";
  } else {
    let note = "";
    const lock = takeLock(config.runFolder, "restore");
    if (lock.ok) {
      try {
        const root = join(config.sitesDir, folder);
        const plan = recoveryPlan(presentIn(root));
        if (plan.kind === "clean") {
          for (const step of plan.steps) {
            if ("rename" in step) renameSync(join(root, step.rename[0]), join(root, step.rename[1]));
            else rmSync(join(root, step.remove), { recursive: true, force: true });
          }
          if (plan.note !== null) log(`restore ${folder}: ${plan.note}`);
        } else {
          note = ` ${plan.reason}.`;
        }
      } catch (error) {
        log(`restore ${folder}: the leftovers could not be repaired (${errorText(error)})`);
      } finally {
        lock.release();
      }
    }
    await dependencies.systemctl(["reset-failed", ...units], SYSTEMCTL_TIMEOUT_MS);
    await dependencies.systemctl(["start", units[0]!], SYSTEMCTL_TIMEOUT_MS);
    const state = (await dependencies.systemctl(["is-active", units[0]!], SYSTEMCTL_TIMEOUT_MS)).output.trim() || "unknown";
    rmSync(markPath, { force: true });
    const before = cutShort ? "The restore was cut short (its time ran out, or it was stopped)." : (previous?.message ?? "").replace(/\.?\s*$/, ".");
    message = `${before} ${folder} had been stopped, and was started again by the restore's cleanup (${state}).${note}`;
  }
  const result: RestoreResult = {
    nonce: typeof previous?.nonce === "string" ? previous.nonce : null,
    state: "failure",
    message: pageMessage(message),
    snapshot: typeof previous?.snapshot === "string" ? previous.snapshot : null,
    preRestore: typeof previous?.preRestore === "string" ? previous.preRestore : null,
    actor: typeof previous?.actor === "string" ? previous.actor : null,
    startedAt: typeof previous?.startedAt === "number" ? previous.startedAt : now(),
    at: now(),
  };
  mkdirSync(resultsFolder, { recursive: true, mode: 0o700 });
  writeFileAtomically(resultsFolder, `${folder}.json`, `${JSON.stringify(result)}\n`, 0o600);
  log(`restore ${folder}: after the unit stopped, ${result.message}`);
  auditRestore(dependencies, folder, result, { cutShort: true });
}
