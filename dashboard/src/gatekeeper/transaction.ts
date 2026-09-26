/**
 * The gatekeeper's transaction: putting a site's portal up or taking it away,
 * and never leaving Caddy in a state nobody has checked.
 *
 * It is the riskiest act on the platform: it rewrites a block and reloads
 * Caddy, which serves every site of the single machine. The model is
 * bin/lock.sh and bin/deploy-caddy.sh, in this order:
 *
 *   1. Caddy's lock, common to the gatekeepers and to the workstation's tools:
 *      nothing else touches Caddy as long as it is held. It is taken before
 *      the first reading and given back after the result, on every path;
 *   2. reading and plan, without touching anything (plan.ts), and the
 *      preconditions: Caddy active, configuration in place already valid,
 *      portal ready if it must be put up, reading of the sites that answer;
 *   3. re-reading of the manifest and of the block, and a new plan: what
 *      changed during the preconditions is never overwritten; then the backup,
 *      in memory and on disk;
 *   4. writing of the manifest (owner and mode preserved) and of the block, or
 *      its removal;
 *   5. `caddy validate`, with the environment systemd gives Caddy;
 *   6. `systemctl reload caddy`, then `systemctl is-active caddy`;
 *   7. probe: the targeted site answers as it must, and all those that
 *      answered before still answer;
 *   8. at the slightest failure from 4 to 7, restore, validation, reload;
 *   9. success: the collector's reading, so that the dashboard sees it.
 *
 * No exception leaves here once the backup is made: every error, foreseen or
 * not, goes through the restore.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: they address the
 * administration API of the instance in service, whatever `--config` says.
 * Only `systemctl reload caddy` applies a configuration. See the Production
 * section of CLAUDE.md.
 */
import { MESSAGE_MAX } from "../secrets/portal";
import { MAX_PORTAL_MS, type OperationResult } from "../secrets/protocol";
import { RUN_FOLDER, backupFolder } from "./instance";
import type { Machine, ManifestRead } from "./machine";
import { portalState, planPortal, type BlockAction } from "./plan";
import {
  alreadySilent,
  portalHost,
  describe,
  servedHosts,
  judgeTarget,
  isPortalReady,
  regressions,
  answers,
  type ProbeResponse,
} from "./probe";

export type PortalDemand = { slug: string; active: boolean; zone: string };

/** What the gatekeeper writes in /run/sitesolide-gatekeeper/<slug>.json, and what the steward re-reads. */
export type Result = {
  a: number;
  result: OperationResult;
  /** In English, for the page. Never a secret. */
  message: string;
  /** The dropped manifest carries `"portal": true`, re-read after the action. */
  requested: boolean;
  /** The block in service carries the portal guard, re-read after the action. */
  installed: boolean;
};

/**
 * The longest each step has the right to take. All of them are bounded, and
 * their sum in the worst case, restore included, fits under the unit's
 * `TimeoutStartSec`, itself under `MAX_PORTAL_MS`: a gatekeeper killed
 * by systemd in the middle of a transaction would restore nothing.
 * tests/gatekeeper-transaction.test.ts checks it.
 */
export const TIMEOUTS = {
  /** One second at most on the VM for the whole configuration: eight of margin. */
  validate: 8_000,
  /**
   * `caddy reload` hands back control when the configuration is in service.
   * Past that delay, the client is killed but systemd's work carries on, and
   * the restore's reload will come after it.
   */
  reload: 10_000,
  active: 3_000,
  sites: 2_000,
  /** One request. */
  probeConfig: 5_000,
  /** All the probes after the reload, retries included. */
  probes: 8_000,
  pause: 1_000,
  collector: 2_000,
} as const;

/**
 * What the worst transaction must leave to systemd: reading and writing the
 * files, the lock, the result, and the overrun of one last probe.
 */
export const MARGIN_MS = 5_000;

/** The duration of the worst transaction: each step up to its delay, then the restore. */
export function worstDuration(): number {
  const d = TIMEOUTS;
  const preconditions = d.active + d.validate + d.sites + d.probeConfig;
  const forward = d.validate + d.reload + d.active + d.probes;
  const restoration = d.validate + d.active + d.reload + d.active;
  return preconditions + forward + restoration + d.collector;
}

if (worstDuration() + MARGIN_MS >= MAX_PORTAL_MS) {
  throw new Error("gatekeeper: the worst transaction outlasts MAX_PORTAL_MS");
}

/**
 * What Caddy says about a refusal, in one line: the last `Error:`, otherwise
 * the last non-empty line. The machine has already purged the output.
 */
export function caddyExtract(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const error = [...lines].reverse().find((line) => /^error:/i.test(line));
  const line = error ?? lines[lines.length - 1] ?? "no output";
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** A step that fails, and what must be said about it. */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
  }
}

function enumerate(elements: string[], limit = 3): string {
  const seen = elements.slice(0, limit).join(", ");
  return elements.length > limit ? `${seen} and ${elements.length - limit} more` : seen;
}

/**
 * A message the page will display. The steward replaces with a generic text
 * any message longer than `MESSAGE_MAX` characters, and that text says that a
 * failure restored the previous state, which would be false after a failed
 * restore. The middle is therefore cut out: the beginning says the step (or,
 * at the front, the failed restore), the last short clause says the conclusion
 * (`previous configuration restored`). The whole message goes to the log.
 */
export function boundMessage(message: string): string {
  if (message.length <= MESSAGE_MAX) return message;
  // Two forms of conclusion: `; previous configuration restored` after a
  // failure, `, nothing was changed` for a refusal from before the action.
  // Measured on the bench: the second was lost behind an over-long output of
  // `caddy validate`, and the page no longer said that nothing had moved.
  const cut = Math.max(message.lastIndexOf("; "), message.lastIndexOf(", nothing was changed"));
  const conclusion = cut !== -1 && message.length - cut <= 100 ? message.slice(cut) : "";
  return `${message.slice(0, MESSAGE_MAX - 3 - conclusion.length)}...${conclusion}`;
}

/** `14:03:12 UTC`, to say since when the lock has been held. */
function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

/** The refusal when another holds Caddy's lock. */
export function lockHeldMessage(who: string | null, since: number): string {
  if (who === "gatekeeper") return `another portal change is in progress (since ${utcTime(since)}): try again in a moment`;
  return `Caddy is being changed from the workstation (${who ?? "unknown holder"}, since ${utcTime(since)}): try again in a moment`;
}

/**
 * The refusal when a backup has remained: a gatekeeper killed in the middle of
 * an action (systemd, MemoryMax, power cut). What must be checked and the
 * command that lifts the backup, within the page's limit; the detail in the
 * log.
 */
export function interruptedMessage(slug: string, runFolder: string): { message: string; log: string } {
  const folder = backupFolder(slug, runFolder);
  const long =
    `a portal change of ${slug} was interrupted, state unknown: put back the files saved in ${folder}/ where they differ, ` +
    `then sudo systemctl reload caddy, check that the sites answer, and sudo rm -r ${folder}`;
  const short = `a portal change of ${slug} was interrupted, state unknown: see the gatekeeper journal, then sudo rm -r ${folder}`;
  const log =
    `${folder}/ holds the state before the interrupted change: sitesolide.json goes to /srv/sites/${slug}/ ` +
    `(owner and mode in permissions.json), ${slug}.caddy to /etc/caddy/sites/ (${slug}.caddy.absent: no block). ` +
    `Put back whatever differs, apply with sudo systemctl reload caddy and nothing else (CLAUDE.md, Production), ` +
    `check that https://${slug}.<zone> and the other sites answer, then sudo rm -r ${folder}`;
  return { message: long.length <= MESSAGE_MAX ? long : short, log };
}

/** `runFolder`: where the machine keeps its backups, to name them in the messages. */
export async function run(machine: Machine, requested: PortalDemand, runFolder: string = RUN_FOLDER): Promise<Result> {
  const { slug } = requested;

  async function finish(result: OperationResult, message: string): Promise<Result> {
    let state = { requested: false, installed: false };
    try {
      const manifest = await machine.readManifest(slug);
      state = portalState({ manifest: manifest?.text ?? null, block: await machine.readBlock(slug) });
    } catch (error) {
      machine.log(`gatekeeper ${slug}: final state unreadable: ${errorMessage(error)}`);
    }
    machine.log(`gatekeeper ${slug} ${requested.active ? "on" : "off"}: ${result}: ${message}`);
    return { a: machine.now(), result, message: boundMessage(message), ...state };
  }

  let lockResult;
  try {
    lockResult = await machine.takeLock();
  } catch (error) {
    return finish("failure", `cannot take the Caddy lock: ${errorMessage(error)}, nothing was changed`);
  }
  if (lockResult.kind === "held") return finish("rejects", lockHeldMessage(lockResult.who, lockResult.since));

  try {
    return await underLock(machine, requested, runFolder, finish);
  } finally {
    lockResult.release();
  }
}

async function underLock(
  machine: Machine,
  requested: PortalDemand,
  runFolder: string,
  finish: (result: OperationResult, message: string) => Promise<Result>,
): Promise<Result> {
  const { slug, active, zone } = requested;
  const target = `${slug}.${zone}`;
  const action = active ? "portal set" : "portal removed";

  // --- what is decided without touching anything -----------------------------

  let interrupted: string | null;
  try {
    interrupted = await machine.interruptedTransaction();
  } catch (error) {
    return finish("failure", `cannot read the gatekeeper backups: ${errorMessage(error)}, nothing was changed`);
  }
  if (interrupted !== null) {
    // A configuration that nobody knows whether it was validated is not
    // reloaded on top. The action resumes when a human has looked.
    let instruction: { message: string; log: string };
    try {
      instruction = interruptedMessage(interrupted, runFolder);
    } catch {
      instruction = {
        message: `an interrupted portal change left an unexpected entry in ${runFolder}/sauvegardes/: check it by hand, then remove it`,
        log: "unexpected entry in the backups",
      };
    }
    machine.log(`gatekeeper ${slug}: ${instruction.log}`);
    return finish("rejects", instruction.message);
  }

  let manifest: ManifestRead | null;
  let block: string | null;
  try {
    manifest = await machine.readManifest(slug);
    block = await machine.readBlock(slug);
  } catch (error) {
    return finish("failure", `cannot read the site's files: ${errorMessage(error)}, nothing was changed`);
  }

  const plan = planPortal(slug, active, { manifest: manifest?.text ?? null, block });
  if (plan.kind === "rejects") return finish("rejects", plan.message);
  if (plan.kind === "nothing") return finish("ok", plan.message);
  // planPortal only returns `change` on a manifest that was read.
  const before: ManifestRead = manifest!;

  let hosts: string[];
  let reading: Map<string, ProbeResponse>;
  try {
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) {
      return finish("failure", "Caddy is not active, nothing was changed");
    }

    // The configuration in place must already pass. Otherwise the restore
    // would fail in any case, and it is also here that an unreadable
    // cloudflare.env shows, before anything has been written.
    const before = await machine.validateCaddy(TIMEOUTS.validate);
    if (!before.ok) {
      return finish(
        "failure",
        `caddy validate refuses the configuration already in place: ${caddyExtract(before.output)}, nothing was changed`,
      );
    }

    hosts = servedHosts(zone, await machine.servedSites(TIMEOUTS.sites));
    if (!hosts.includes(target)) hosts.push(target);

    const [beforeAction, portal] = await Promise.all([
      probeAll(machine, hosts),
      active ? machine.probe(portalHost(zone), "/sante", TIMEOUTS.probeConfig) : Promise.resolve(null),
    ]);
    reading = beforeAction;
    if (portal !== null && !isPortalReady(portal)) {
      return finish(
        "rejects",
        `the portal is not ready at https://${portalHost(zone)}/sante, a site behind it would be closed to its owner too`,
      );
    }
  } catch (error) {
    return finish("failure", `preconditions: ${errorMessage(error)}, nothing was changed`);
  }

  // Re-read just before writing. The lock keeps the workstation's tools at a
  // distance, but the preconditions took up to some twenty seconds: a
  // deployment that ignored it, or a touch-up by hand, could have changed the
  // manifest or the block in the meantime. The plan is remade on what is in
  // place; if it changed, nothing is overwritten.
  let reread: ManifestRead | null;
  let blockReread: string | null;
  try {
    reread = await machine.readManifest(slug);
    blockReread = await machine.readBlock(slug);
  } catch (error) {
    return finish("failure", `cannot read the site's files again: ${errorMessage(error)}, nothing was changed`);
  }
  if (reread?.text !== before.text || blockReread !== block) {
    const replan = planPortal(slug, active, { manifest: reread?.text ?? null, block: blockReread });
    if (replan.kind === "rejects") return finish("rejects", replan.message);
    if (replan.kind === "nothing") return finish("ok", replan.message);
    return finish(
      "rejects",
      "sitesolide.json or the Caddy block changed while the change was being prepared, nothing was changed: try again",
    );
  }
  // Same texts: only owner and mode could have changed, and it is the last ones
  // read that count.
  const parsed: ManifestRead = reread!;

  try {
    await machine.saveBackup(slug, { manifest: parsed, block });
  } catch (error) {
    try {
      await machine.clearBackup(slug);
    } catch {
      // A half-written backup remains, and will block the next action: that is
      // intended, one has to look at why the disk refuses.
    }
    return finish("failure", `backup failed: ${errorMessage(error)}, nothing was changed`);
  }

  // --- the action -------------------------------------------------------------

  let step = "write";
  let reloadAttempted = false;
  try {
    await write(machine, slug, plan.manifest, parsed, plan.block);

    step = "validate";
    const validation = await machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) throw new StepFailure(step, caddyExtract(validation.output));

    step = "reload";
    reloadAttempted = true;
    const reload = await machine.reloadCaddy(TIMEOUTS.reload);
    if (!reload.ok) throw new StepFailure(step, caddyExtract(reload.output));
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) throw new StepFailure(step, "Caddy is no longer active");

    step = "probe";
    const problem = await probeAfter(machine, active, target, reading);
    if (problem !== null) throw new StepFailure(step, problem);
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure(step, errorMessage(error));
    machine.log(`gatekeeper ${slug}: ${failure.message}, restoring`);

    let restoration: string | null;
    try {
      restoration = await restore(machine, slug, parsed, block, reloadAttempted);
    } catch (unexpected) {
      restoration = errorMessage(unexpected);
    }
    if (restoration !== null) {
      // The backup stays in place: it is the one to be put back by hand, and
      // its presence refuses any other action from the gatekeeper until then.
      // The most serious first, the page cutting over-long messages.
      await collectAnyway(machine, slug);
      machine.log(`gatekeeper ${slug}: ${interruptedMessage(slug, runFolder).log}`);
      return finish(
        "failure",
        `restore failed, check Caddy now, backup kept in ${backupFolder(slug, runFolder)}/: ${failure.message}; ${restoration}`,
      );
    }
    await cleanUp(machine, slug);
    return finish("failure", `${failure.message}; previous configuration restored`);
  }

  await cleanUp(machine, slug);

  const others = hosts.filter((host) => host !== target && answers(reading.get(host) ?? { error: "" })).length;
  const silent = alreadySilent(reading, target);
  const checked = active ? `${target} answers the portal's 401` : `${target} answers without the portal`;
  const tail = silent.length > 0 ? `; already not answering before: ${enumerate(silent)}` : "";
  return finish("ok", `${action}: validated, reloaded, ${checked}, ${others} other site(s) still answer${tail}`);
}

async function write(
  machine: Machine,
  slug: string,
  manifest: string,
  before: ManifestRead,
  block: BlockAction,
): Promise<void> {
  // The manifest first: on its own, it changes nothing of what Caddy serves,
  // and a failure between the two leaves an intact block.
  await machine.writeManifest(slug, manifest, before.permissions);
  if (block.kind === "write") await machine.writeBlock(slug, block.text);
  else if (block.kind === "remove") await machine.removeBlock(slug);
}

async function probeAll(machine: Machine, hosts: string[]): Promise<Map<string, ProbeResponse>> {
  const responses = await Promise.all(hosts.map((host) => machine.probe(host, "/", TIMEOUTS.probeConfig)));
  return new Map(hosts.map((host, i) => [host, responses[i]!]));
}

/**
 * The targeted site, and those that answered before. Several attempts:
 * bin/lock.sh waits two seconds after a reload, the first request possibly
 * still leaving under the old configuration. Here we try again up to the
 * delay, which hands back control as soon as everything answers.
 */
async function probeAfter(
  machine: Machine,
  active: boolean,
  target: string,
  reading: Map<string, ProbeResponse>,
): Promise<string | null> {
  const deadline = machine.now() + TIMEOUTS.probes;
  const hosts = [target, ...[...reading].filter(([host, r]) => host !== target && answers(r)).map(([host]) => host)];
  const seen = new Map<string, ProbeResponse>();
  let pending = hosts;

  for (;;) {
    const remaining = Math.max(500, Math.min(TIMEOUTS.probeConfig, deadline - machine.now()));
    const responses = await Promise.all(pending.map((host) => machine.probe(host, "/", remaining)));
    pending.forEach((host, i) => seen.set(host, responses[i]!));

    const targetProblem = judgeTarget(active, target, seen.get(target)!);
    const lost = regressions(reading, seen, target);
    if (targetProblem === null && lost.length === 0) return null;

    if (machine.now() + TIMEOUTS.pause >= deadline) {
      const reasons = [...(targetProblem === null ? [] : [targetProblem])];
      if (lost.length > 0) {
        const details = lost.map((host) => `${host} ${describe(seen.get(host) ?? { error: "not probed" })}`);
        reasons.push(`no longer answering: ${enumerate(details)}`);
      }
      return reasons.join("; ");
    }
    pending = [...(targetProblem === null ? [] : [target]), ...lost];
    await machine.wait(TIMEOUTS.pause);
  }
}

/**
 * Puts back the manifest and the block from before, validates, reloads.
 * Returns null if Caddy serves the previous configuration again, otherwise
 * what failed.
 *
 * A file already identical to the backup is not rewritten: the write that has
 * just failed would probably fail again, and would announce a failed restore
 * when nothing had changed. The reload only takes place if it had been
 * attempted on the way out: otherwise Caddy never left the previous
 * configuration, and reloading it would bring nothing but one more risk.
 */
async function restore(
  machine: Machine,
  slug: string,
  before: ManifestRead,
  block: string | null,
  reloadAttempted: boolean,
): Promise<string | null> {
  try {
    const manifest = await readCautiously(() => machine.readManifest(slug));
    if (manifest === undefined || manifest?.text !== before.text) {
      await machine.writeManifest(slug, before.text, before.permissions);
    }
    const currentBlock = await readCautiously(() => machine.readBlock(slug));
    if (currentBlock === undefined || currentBlock !== block) {
      if (block === null) await machine.removeBlock(slug);
      else await machine.writeBlock(slug, block);
    }
  } catch (error) {
    return `files not written back: ${errorMessage(error)}`;
  }

  const validation = await machine.validateCaddy(TIMEOUTS.validate);
  if (!validation.ok) return `the restored configuration does not validate: ${caddyExtract(validation.output)}`;

  if (!reloadAttempted) return null;

  // Caddy stopped after the reload: `systemctl reload` would refuse an
  // inactive unit, and leaving the machine mute until a human sees it would be
  // worse. The configuration has just been validated.
  const active = await machine.isCaddyActive(TIMEOUTS.active);
  const command = active ? await machine.reloadCaddy(TIMEOUTS.reload) : await machine.startCaddy(TIMEOUTS.reload);
  if (!command.ok) return `${active ? "reload" : "start"} refused: ${caddyExtract(command.output)}`;
  if (!(await machine.isCaddyActive(TIMEOUTS.active))) return "Caddy is not active";
  return null;
}

/** undefined: unreadable. The restore then rewrites on principle. */
async function readCautiously<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

async function cleanUp(machine: Machine, slug: string): Promise<void> {
  try {
    await machine.clearBackup(slug);
  } catch (error) {
    machine.log(`gatekeeper ${slug}: backup not removed: ${errorMessage(error)}`);
  }
  await collectAnyway(machine, slug);
}

/** The dashboard must see the real state as soon as possible, especially after a failure. */
async function collectAnyway(machine: Machine, slug: string): Promise<void> {
  try {
    const reading = await machine.restartCollector(TIMEOUTS.collector);
    if (!reading.ok) machine.log(`gatekeeper ${slug}: collector not started: ${caddyExtract(reading.output)}`);
  } catch (error) {
    machine.log(`gatekeeper ${slug}: collector not started: ${errorMessage(error)}`);
  }
}
