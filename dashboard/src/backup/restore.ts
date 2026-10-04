/**
 * A restore, launched by the steward as `sitesolide-restore@<folder>.service`,
 * one project per start. In order, and the order is the point:
 *
 *   1. read and consume the request; refuse the dashboard itself
 *   2. take the backup lock: never beside a run, which could prune the snapshot
 *   3. repair what an interrupted restore left, or refuse
 *   4. fetch the snapshot, from the server or from the bucket
 *   5. extract it beside the data, as the project, while the service still
 *      runs: a snapshot that does not extract changes nothing
 *   6. stop the project's services
 *   7. snapshot the current data, `pre-restore`: the restore can be undone
 *   8. swap the folders: data aside, the snapshot in its place
 *   9. start the services and watch them for eight seconds
 *  10. running: the previous data goes. Not running: it comes back, and the
 *      services start on it again
 *
 * Every phase is written to the result file the steward reads, and the whole
 * restore is recorded in the component's audit, with the requester the
 * dashboard named.
 *
 * NEVER `caddy stop` or `caddy start`, and nothing here touches Caddy at all:
 * a restore changes a data folder and restarts that project's services.
 */
import { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readSnapshotName } from "../../borrowed/backups";
import { servicesOf } from "../../borrowed/manifest";
import { unitArgument } from "../../borrowed/unit";
import { DASHBOARD_SLUG } from "../gatekeeper/rules";
import { readShow, showArguments, verdict, type ServiceReading } from "../secrets/restart";
import type { Verdict } from "../secrets/protocol";
import { unitOf } from "../state";
import type { BackupConfig } from "./config";
import { DATABASE_NAME, openDatabase, recordAudit } from "./database";
import { waitForLock } from "./lock";
import { objectKey, openBucket, type Bucket, type Offsite } from "./offsite";
import { freeBytes, measure, readProject, type Project } from "./projects";
import { DATA, FAILED, INCOMING, PREVIOUS, recoveryPlan, type Present } from "./recovery";
import { MAX_REQUEST_BYTES, REQUESTS_NAME, RESULTS_NAME, pageMessage, readRequest, type RestoreRequest, type RestoreResult } from "./request";
import { startChild } from "./runner";
import { takeSnapshot } from "./snapshot";
import { syncFolder, writeFileAtomically } from "./status";

export type Command = { code: number; output: string };

export type RestoreDependencies = {
  config: BackupConfig;
  now: () => number;
  log: (line: string) => void;
  systemctl: (args: string[], timeoutMs: number) => Promise<Command>;
  wait?: (ms: number) => Promise<void>;
  openBucket?: (offsite: Offsite) => Bucket;
  /** Eight seconds of watching after the start, a reading every half second. */
  observationMs?: number;
  stepMs?: number;
  lockWaitMs?: number;
};

/** A run takes minutes; a restore waits that long for it, the page showing why. */
export const RESTORE_LOCK_WAIT_MS = 10 * 60 * 1000;
export const OBSERVATION_MS = 8000;
export const STEP_MS = 500;
const SYSTEMCTL_TIMEOUT_MS = 90_000;

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

/** The project's units: the main one, then its other services, as the deploy named them. */
export function projectUnits(project: Project): string[] {
  const main = unitOf(project.folder);
  const others = project.manifest === null ? [] : servicesOf(project.manifest).slice(1).map((service) => unitArgument(service.unit));
  return [main, ...others];
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
  try {
    if (folder === DASHBOARD_SLUG) throw new Refused("the dashboard's own data is not restored from the dashboard: see the Backups README to do it by hand");

    publish("running", "Waiting for any backup run to finish.");
    const lock = await waitForLock(config.runFolder, "restore", dependencies.lockWaitMs ?? RESTORE_LOCK_WAIT_MS);
    if (!lock.ok) throw new Refused("a backup run is still going on: try again in a few minutes");
    releaseLock = lock.release;

    const found = readProject(config.sitesDir, folder, config.accountsFile, config.checkOwners);
    if ("error" in found) throw new Refused(`${folder}: ${found.error}`);
    const { project } = found;
    const root = join(config.sitesDir, folder);

    // --- Leftovers of an interrupted restore
    const present: Present = {
      data: exists(join(root, DATA)),
      incoming: exists(join(root, INCOMING)),
      previous: exists(join(root, PREVIOUS)),
      failed: exists(join(root, FAILED)),
    };
    const plan = recoveryPlan(present);
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

    // --- Extraction beside the data, as the project
    const room = freeBytes(root) - config.reserveBytes - 2 * measure(project.dataDir);
    if (room <= 0) throw new Refused("not enough disk space to extract the snapshot and save the current data first");
    publish("running", "Extracting the snapshot.");
    const incoming = join(root, INCOMING);
    mkdirSync(incoming, { mode: 0o700 });
    // The mode first, while root still owns it: afterwards it would take CAP_FOWNER.
    chmodSync(incoming, dataStat.mode & 0o777);
    if (project.owner !== null) chownSync(incoming, project.owner.uid, project.owner.gid);
    const extraction = startChild(
      {
        mode: "extract",
        folder,
        account: project.account,
        uid: project.owner?.uid ?? null,
        args: [incoming, String(room)],
        readWrite: [incoming],
        bind: [incoming],
        cacheDirectory: null,
        stdin: archive,
        stdout: "ignore",
      },
      config,
    );
    const extracted = await extraction.result;
    if (extracted.code !== 0 || extracted.report.summary === null) {
      rmSync(incoming, { recursive: true, force: true });
      throw new Refused(`the snapshot could not be extracted, nothing was changed: ${extracted.report.error ?? (extracted.report.tail || `exit code ${extracted.code}`)}`);
    }

    // --- Stop, save, swap, start
    const units = await loadedUnits(dependencies, project);
    if (units.length > 0) {
      publish("running", `Stopping ${folder}.`);
      await dependencies.systemctl(["stop", ...units], SYSTEMCTL_TIMEOUT_MS);
      // A service still running would keep writing into the folder about to be
      // set aside, and its writes would be lost with it.
      for (const unit of units) {
        const state = (await dependencies.systemctl(["is-active", unit], SYSTEMCTL_TIMEOUT_MS)).output.trim();
        if (state === "active" || state === "activating" || state === "deactivating" || state === "reloading") {
          rmSync(incoming, { recursive: true, force: true });
          await dependencies.systemctl(["start", units[0]!], SYSTEMCTL_TIMEOUT_MS);
          throw new Failure(`${unit} did not stop (${state}), so nothing was changed`);
        }
      }
    }

    publish("running", "Saving the current data first.");
    const saved = await takeSnapshot(config, project, "pre-restore", now(), log);
    if (!saved.ok) {
      rmSync(incoming, { recursive: true, force: true });
      if (units.length > 0) await dependencies.systemctl(["start", units[0]!], SYSTEMCTL_TIMEOUT_MS);
      throw new Failure(`the current data could not be saved first, so nothing was changed: ${saved.error}`);
    }
    result.preRestore = saved.name;

    publish("running", "Putting the snapshot in place.");
    renameSync(join(root, DATA), join(root, PREVIOUS));
    renameSync(incoming, join(root, DATA));
    syncFolder(root);

    const restored = units.length === 0 ? null : await startAndWatch(dependencies, units, wait, () => publish("running", `Starting ${folder}.`));
    if (restored === null || restored.running) {
      rmSync(join(root, PREVIOUS), { recursive: true, force: true });
      const when = readSnapshotName(folder, request.snapshot)?.takenAt ?? null;
      publish(
        "ok",
        `Restored ${folder} from the snapshot of ${when === null ? request.snapshot : new Date(when).toISOString().slice(0, 16).replace("T", " ")} UTC.${restored === null ? "" : ` ${folder} is running.`} The data it replaced is saved as a before-restore snapshot.`,
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
    try {
      const db = openDatabase(join(config.stateFolder, DATABASE_NAME));
      try {
        recordAudit(
          db,
          {
            actor: result.actor ?? "system",
            action: "backup.restore",
            target: folder,
            detail: { result: result.state === "running" ? "failure" : result.state, snapshot: result.snapshot, preRestore: result.preRestore, message: result.message },
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
 * The archive to extract: the server's own file, or the bucket's copy
 * decrypted into a root-only folder, removed once the restore is over.
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
  const target = join(downloads, name);
  hold(target);
  rmSync(target, { force: true });
  const file = Bun.file(target).writer();
  try {
    await (dependencies.openBucket ?? openBucket)(setting).download(objectKey(setting, project.folder, name), async (bytes) => {
      file.write(bytes);
      await file.flush();
    });
  } catch (error) {
    throw new Refused(`the snapshot could not be fetched from the bucket: ${errorText(error)}`);
  } finally {
    await file.end();
  }
  if (statSync(target).size === 0) throw new Refused("the snapshot fetched from the bucket is empty");
  return target;
}

/** The project's units systemd knows: a project without one has nothing to stop. */
async function loadedUnits(dependencies: RestoreDependencies, project: Project): Promise<string[]> {
  const loaded: string[] = [];
  for (const unit of projectUnits(project)) {
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
