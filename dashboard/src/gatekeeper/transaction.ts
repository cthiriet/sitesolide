/**
 * The gatekeeper's transaction: changing a site's general access, Public,
 * Restricted or Anyone with the code, or giving it a new code, and never
 * leaving Caddy in a state nobody has checked.
 *
 * It is the riskiest act on the platform: it rewrites a block or the preview
 * locks and reloads Caddy, which serves every site of the single machine. It
 * is the one path that does it from the machine: the dashboard reaches it
 * through the steward, and so does `sitesolide lock`, over the owner's SSH.
 * In this order:
 *
 *   1. Caddy's lock, common to the gatekeepers and to the workstation's tools:
 *      nothing else touches Caddy as long as it is held. It is taken before
 *      the first reading and given back after the result, on every path;
 *   2. reading and plan, without touching anything (plan.ts), and the
 *      preconditions: Caddy active, configuration in place already valid,
 *      portal ready if it must be put up, reading of the sites that answer;
 *   3. re-reading of every file the plan read: what changed during the
 *      preconditions is never overwritten; then the backup, in memory and on
 *      disk;
 *   4. writing of the manifest (owner and mode preserved), of the codes file,
 *      of the door page, of the block or its removal, of the locks' fragment;
 *   5. `caddy validate`, with the environment systemd gives Caddy;
 *   6. `systemctl reload caddy`, then `systemctl is-active caddy`;
 *   7. probe: the targeted site answers as it must, the door page without its
 *      code and the site with it, a code replaced no longer opening it, and
 *      all those that answered before still answer;
 *   8. at the slightest failure from 4 to 7, restore, validation, reload;
 *   9. success: the collector's reading, so that the dashboard sees it.
 *
 * A switch between Restricted and the code changes both sides here, in one
 * transaction: the manifest refuses `portal` and `lock` together, and a half
 * done switch would leave neither.
 *
 * **The code never leaves the machine through here.** It is drawn here, by
 * `generateCode`, written into the codes file and the fragment, and nowhere
 * else: not in the result, which other accounts read, not in a message, not
 * in the journal. Whatever is said is first purged of the codes at stake.
 *
 * No exception leaves here once the backup is made: every error, foreseen or
 * not, goes through the restore.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: they address the
 * administration API of the instance in service, whatever `--config` says.
 * Only `systemctl reload caddy` applies a configuration. See the Production
 * section of CLAUDE.md.
 */
import { cookieName, DOOR_PAGES_DIR, FRAGMENT_NAME } from "../../borrowed/locks";
import { DOOR_PAGE_MARKER, doorPage } from "../../borrowed/page";
import { MESSAGE_MAX } from "../secrets/portal";
import { MAX_PORTAL_MS, type OperationResult } from "../secrets/protocol";
import { RUN_FOLDER, backupFolder, targetOf, type Action, type GeneralAccess } from "./instance";
import type { Backup, GeneralMachine, ManifestRead } from "./machine";
import { activeDomain, portalState, planGeneral, type Deployed, type Plan } from "./plan";
import {
  alreadySilent,
  portalHost,
  describe,
  servedHosts,
  judgeTarget,
  judgeCoded,
  judgeOpened,
  isPortalReady,
  regressions,
  answers,
  targetHosts,
  type ProbeResponse,
} from "./probe";
import { redact } from "./real";

/**
 * What the steward asked: the site and the action, from the unit's name; the
 * zone and the contact address, from /etc/caddy/sitesolide.env.
 */
export type GeneralDemand = {
  slug: string;
  action: Action;
  zone: string;
  /** The address the door page offers to ask a code from; empty, no line. */
  contact?: string;
  /** Where the door pages live: /srv/garde on the machine. */
  doorPagesDir?: string;
  /** The draw of a code; the tests impose one. */
  draw?: () => string;
};

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
  if (who === "installer") return `a deployment is being installed on the machine (since ${utcTime(since)}): try again in a moment`;
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
    `(owner and mode in permissions.json), ${slug}.caddy to /etc/caddy/sites/ (${slug}.caddy.absent: no block), ` +
    `when present locks-codes.json to /etc/caddy/ (rewritten in place, deployment account 0600) and ${FRAGMENT_NAME} to /etc/caddy/locks/ ` +
    `(.absent: none). ` +
    `Put back whatever differs, apply with sudo systemctl reload caddy and nothing else (CLAUDE.md, Production), ` +
    `check that https://${slug}.<zone> and the other sites answer, then sudo rm -r ${folder}`;
  return { message: long.length <= MESSAGE_MAX ? long : short, log };
}

/** `runFolder`: where the machine keeps its backups, to name them in the messages. */
export async function run(machine: GeneralMachine, requested: GeneralDemand, runFolder: string = RUN_FOLDER): Promise<Result> {
  const { slug, action } = requested;
  // The codes at stake, the one drawn included: purged from every word that
  // leaves, the log's, the page's and the result's.
  const hidden: string[] = [];
  const quiet: GeneralMachine = { ...machine, log: (line) => machine.log(redact(line, hidden)) };

  async function finish(result: OperationResult, message: string): Promise<Result> {
    let state = { requested: false, installed: false };
    try {
      const manifest = await machine.readManifest(slug);
      state = portalState({ manifest: manifest?.text ?? null, block: await machine.readBlock(slug) });
    } catch (error) {
      quiet.log(`gatekeeper ${slug}: final state unreadable: ${errorMessage(error)}`);
    }
    const clean = redact(message, hidden);
    quiet.log(`gatekeeper ${slug} ${action}: ${result}: ${clean}`);
    return { a: machine.now(), result, message: boundMessage(clean), ...state };
  }

  let lockResult;
  try {
    lockResult = await machine.takeLock();
  } catch (error) {
    return finish("failure", `cannot take the Caddy lock: ${errorMessage(error)}, nothing was changed`);
  }
  if (lockResult.kind === "held") return finish("rejects", lockHeldMessage(lockResult.who, lockResult.since));

  try {
    return await underLock(quiet, requested, runFolder, finish, hidden);
  } finally {
    lockResult.release();
  }
}

/** Every file a change of general access reads, and the manifest with its owner and mode. */
async function readAll(machine: GeneralMachine, slug: string): Promise<{ deployed: Deployed; manifest: ManifestRead | null }> {
  const manifest = await machine.readManifest(slug);
  const block = await machine.readBlock(slug);
  // The codes and the other sites' locks are refused by the plan only when
  // this site's lock is at stake: their reading failing is said there.
  let codes: Deployed["codes"];
  try {
    codes = await machine.readCodes();
  } catch (error) {
    codes = { error: errorMessage(error) };
  }
  const fragment = await machine.readLocksFragment();
  let sites: Deployed["sites"];
  try {
    sites = await machine.readLockSites();
  } catch (error) {
    sites = { error: errorMessage(error) };
  }
  return { deployed: { manifest: manifest?.text ?? null, block, codes, fragment, sites }, manifest };
}

function sameReading(a: Deployed, b: Deployed): boolean {
  return (
    a.manifest === b.manifest &&
    a.block === b.block &&
    JSON.stringify(a.codes) === JSON.stringify(b.codes) &&
    a.fragment === b.fragment &&
    JSON.stringify(a.sites) === JSON.stringify(b.sites)
  );
}

/** Every valid code of the codes file, to purge from what is said. */
function codesIn(codes: Deployed["codes"]): string[] {
  if (typeof codes !== "string") return [];
  try {
    return Object.values(JSON.parse(codes) as Record<string, unknown>).filter((value): value is string => typeof value === "string" && /^[A-Z0-9]{6}$/.test(value));
  } catch {
    return [];
  }
}

/**
 * The door page, from the template the portal's sign-in page shares: written
 * when it is missing, or when it is the generated one and the template has
 * changed since; a page a site placed itself, which does not carry the
 * template's marker, is left as it is.
 */
async function placeDoorPage(machine: GeneralMachine, slug: string, contact: string, owner: { uid: number; gid: number } | null): Promise<boolean> {
  const page = doorPage(contact);
  const current = await machine.readDoorPage(slug);
  if (current !== null && (current === page || !current.includes(DOOR_PAGE_MARKER))) return false;
  await machine.writeDoorPage(slug, page, owner);
  return true;
}

/** What the action did, in the words its message opens with. */
function actionWords(action: Action, portalChanged: boolean, leavingCode: boolean): string {
  switch (action) {
    case "on":
      return leavingCode ? "code removed, portal set" : "portal set";
    case "off":
      return leavingCode ? "code removed" : "portal removed";
    case "code":
      return portalChanged ? "portal removed, code set" : "code set";
    case "renew":
      return "new code set";
  }
}

async function underLock(
  machine: GeneralMachine,
  requested: GeneralDemand,
  runFolder: string,
  finish: (result: OperationResult, message: string) => Promise<Result>,
  hidden: string[],
): Promise<Result> {
  const { slug, action, zone } = requested;
  const target = targetOf(action);
  const host = `${slug}.${zone}`;
  const options = { zone, draw: requested.draw, doorPagesDir: requested.doorPagesDir ?? DOOR_PAGES_DIR };

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

  let first: { deployed: Deployed; manifest: ManifestRead | null };
  try {
    first = await readAll(machine, slug);
  } catch (error) {
    return finish("failure", `cannot read the site's files: ${errorMessage(error)}, nothing was changed`);
  }
  hidden.push(...codesIn(first.deployed.codes));

  const plan = planGeneral(slug, action, first.deployed, options);
  if (plan.kind === "rejects") return finish("rejects", plan.message);
  const owner = first.manifest === null ? null : { uid: first.manifest.permissions.uid, gid: first.manifest.permissions.gid };
  if (plan.kind === "nothing") {
    if (plan.target === "code") {
      // Nothing for Caddy; the door page still follows the template, which is
      // how a touch-up of portal/src/page.ts reaches a site already closed.
      try {
        if (await placeDoorPage(machine, slug, requested.contact ?? "", owner)) machine.log(`gatekeeper ${slug}: door page written again from the template`);
      } catch (error) {
        return finish("failure", `${plan.message}, but its door page could not be written: ${errorMessage(error)}`);
      }
    }
    return finish("ok", plan.message);
  }
  // planGeneral only returns `change` on a manifest that was read.
  const before: ManifestRead = first.manifest!;
  if (plan.code !== null) hidden.push(plan.code);
  const leavingCode = plan.leaving;

  // The site's own domain, when it serves one, closes and opens with it.
  const domain = activeDomain(first.deployed.manifest);
  let hosts: string[];
  let targets: string[];
  let reading: Map<string, ProbeResponse>;
  try {
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) {
      return finish("failure", "Caddy is not active, nothing was changed");
    }

    // The configuration in place must already pass. Otherwise the restore
    // would fail in any case, and it is also here that an unreadable
    // cloudflare.env shows, before anything has been written.
    const validation = await machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) {
      return finish(
        "failure",
        `caddy validate refuses the configuration already in place: ${caddyExtract(validation.output)}, nothing was changed`,
      );
    }

    hosts = servedHosts(zone, await machine.servedSites(TIMEOUTS.sites));
    for (const one of [host, domain]) if (one !== null && !hosts.includes(one)) hosts.push(one);

    const [beforeAction, portal] = await Promise.all([
      probeAll(machine, hosts),
      target === "restricted" ? machine.probe(portalHost(zone), "/sante", TIMEOUTS.probeConfig) : Promise.resolve(null),
    ]);
    reading = beforeAction;
    targets = targetHosts(host, domain, reading);
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
  // deployment that ignored it, or a touch-up by hand, could have changed a
  // file in the meantime. The plan is remade on what is in place; if it
  // changed, nothing is overwritten.
  let again: { deployed: Deployed; manifest: ManifestRead | null };
  try {
    again = await readAll(machine, slug);
  } catch (error) {
    return finish("failure", `cannot read the site's files again: ${errorMessage(error)}, nothing was changed`);
  }
  if (!sameReading(first.deployed, again.deployed)) {
    hidden.push(...codesIn(again.deployed.codes));
    const replan: Plan = planGeneral(slug, action, again.deployed, options);
    if (replan.kind === "rejects") return finish("rejects", replan.message);
    if (replan.kind === "nothing") return finish("ok", replan.message);
    return finish(
      "rejects",
      "sitesolide.json, the Caddy block or the preview locks changed while the change was being prepared, nothing was changed: try again",
    );
  }
  // Same texts: only owner and mode could have changed, and it is the last ones
  // read that count.
  const parsed: ManifestRead = again.manifest!;

  if (target === "code") {
    // Before anything Caddy reads: the stanza rewrites every address of the
    // site towards this page, a 404 without it.
    try {
      await placeDoorPage(machine, slug, requested.contact ?? "", owner);
    } catch (error) {
      return finish("failure", `the door page could not be written: ${errorMessage(error)}, nothing was changed`);
    }
  }

  const backup: Backup = {
    manifest: parsed,
    block: again.deployed.block,
    ...(plan.locks === null ? {} : { locks: { codes: typeof again.deployed.codes === "string" ? again.deployed.codes : null, fragment: again.deployed.fragment } }),
  };
  try {
    await machine.saveBackup(slug, backup);
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
    await write(machine, slug, plan, parsed);

    step = "validate";
    const validation = await machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) throw new StepFailure(step, caddyExtract(validation.output));

    step = "reload";
    reloadAttempted = true;
    const reload = await machine.reloadCaddy(TIMEOUTS.reload);
    if (!reload.ok) throw new StepFailure(step, caddyExtract(reload.output));
    if (!(await machine.isCaddyActive(TIMEOUTS.active))) throw new StepFailure(step, "Caddy is no longer active");

    step = "probe";
    const problem = await probeAfter(machine, { slug, hosts: targets, target, code: plan.code, previous: plan.previous, leavingCode }, reading);
    if (problem !== null) throw new StepFailure(step, problem);
  } catch (error) {
    const failure = error instanceof StepFailure ? error : new StepFailure(step, errorMessage(error));
    machine.log(`gatekeeper ${slug}: ${failure.message}, restoring`);

    let restoration: string | null;
    try {
      restoration = await restore(machine, slug, backup, reloadAttempted);
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

  const others = hosts.filter((one) => !targets.includes(one) && answers(reading.get(one) ?? { error: "" })).length;
  const silent = alreadySilent(reading, targets);
  const site = `${targets.join(" and ")} ${targets.length > 1 ? "answer" : "answers"}`;
  const checked =
    target === "restricted"
      ? `${site} the portal's 401`
      : target === "public"
        ? leavingCode
          ? `${site} without a code`
          : `${site} without the portal`
        : plan.previous !== null
          ? `${site} the door page's 401 and ${targets.length > 1 ? "open" : "opens"} with the new code, not the old one`
          : `${site} the door page's 401 and ${targets.length > 1 ? "open" : "opens"} with its code`;
  const tail = silent.length > 0 ? `; already not answering before: ${enumerate(silent)}` : "";
  const words = actionWords(action, plan.portalChanged, leavingCode);
  return finish("ok", `${words}: validated, reloaded, ${checked}, ${others} other site(s) still answer${tail}`);
}

async function write(machine: GeneralMachine, slug: string, plan: Extract<Plan, { kind: "change" }>, before: ManifestRead): Promise<void> {
  // The manifest first: on its own, it changes nothing of what Caddy serves,
  // and a failure between the two leaves an intact block. The codes file
  // next, which nothing serves until the fragment names them.
  if (plan.manifest !== null) await machine.writeManifest(slug, plan.manifest, before.permissions);
  if (plan.locks !== null && plan.locks.codes !== null) {
    await machine.writeCodes(plan.locks.codes, { uid: before.permissions.uid, gid: before.permissions.gid });
  }
  if (plan.block.kind === "write") await machine.writeBlock(slug, plan.block.text);
  else if (plan.block.kind === "remove") await machine.removeBlock(slug);
  if (plan.locks !== null && plan.locks.fragment !== null) await machine.writeLocksFragment(plan.locks.fragment);
}

async function probeAll(machine: GeneralMachine, hosts: string[]): Promise<Map<string, ProbeResponse>> {
  const responses = await Promise.all(hosts.map((host) => machine.probe(host, "/", TIMEOUTS.probeConfig)));
  return new Map(hosts.map((host, i) => [host, responses[i]!]));
}

/** The targeted site, its addresses, and what they must answer once the action is done. */
type Expected = { slug: string; hosts: string[]; target: GeneralAccess; code: string | null; previous: string | null; leavingCode: boolean };

/** The targeted site's answers on every address it is judged on: what is wrong, or null. */
async function judgeAfter(machine: GeneralMachine, expected: Expected, timeoutMs: number): Promise<string | null> {
  const problems = await Promise.all(expected.hosts.map((host) => judgeHost(machine, expected, host, timeoutMs)));
  const found = problems.filter((problem): problem is string => problem !== null);
  return found.length === 0 ? null : found.join("; ");
}

/** One address of the targeted site, judged by what its general access now is. */
async function judgeHost(machine: GeneralMachine, expected: Expected, host: string, timeoutMs: number): Promise<string | null> {
  const { target } = expected;
  const without = await machine.probe(host, "/", timeoutMs);
  if (target === "restricted") return judgeTarget(true, host, without);
  if (target === "public") return expected.leavingCode ? judgeOpened(host, without) : judgeTarget(false, host, without);
  const cookie = (code: string) => `${cookieName(expected.slug)}=${code}`;
  const [withCode, withPrevious] = await Promise.all([
    machine.probe(host, "/", timeoutMs, cookie(expected.code!)),
    expected.previous === null ? Promise.resolve(null) : machine.probe(host, "/", timeoutMs, cookie(expected.previous)),
  ]);
  return judgeCoded(host, { without, withCode, withPrevious });
}

/**
 * The targeted site, and those that answered before. Several attempts: the
 * first request may still leave under the old configuration. Here we try
 * again up to the delay, which hands back control as soon as everything
 * answers.
 */
async function probeAfter(machine: GeneralMachine, expected: Expected, reading: Map<string, ProbeResponse>): Promise<string | null> {
  const deadline = machine.now() + TIMEOUTS.probes;
  const targets = expected.hosts;
  const others = [...reading].filter(([host, r]) => !targets.includes(host) && answers(r)).map(([host]) => host);
  const seen = new Map<string, ProbeResponse>();
  let pending = others;
  let checkTarget = true;
  let targetProblem: string | null = null;

  for (;;) {
    const remaining = Math.max(500, Math.min(TIMEOUTS.probeConfig, deadline - machine.now()));
    const [judged, responses]: [string | null, ProbeResponse[]] = await Promise.all([
      checkTarget ? judgeAfter(machine, expected, remaining) : Promise.resolve(null),
      Promise.all(pending.map((host) => machine.probe(host, "/", remaining))),
    ]);
    targetProblem = judged;
    pending.forEach((host, i) => seen.set(host, responses[i]!));

    const lost = regressions(reading, seen, targets);
    if (targetProblem === null && lost.length === 0) return null;

    if (machine.now() + TIMEOUTS.pause >= deadline) {
      const reasons = [...(targetProblem === null ? [] : [targetProblem])];
      if (lost.length > 0) {
        const details = lost.map((host) => `${host} ${describe(seen.get(host) ?? { error: "not probed" })}`);
        reasons.push(`no longer answering: ${enumerate(details)}`);
      }
      return reasons.join("; ");
    }
    checkTarget = targetProblem !== null;
    pending = lost;
    await machine.wait(TIMEOUTS.pause);
  }
}

/**
 * Puts back every file from before, validates, reloads. Returns null if Caddy
 * serves the previous configuration again, otherwise what failed.
 *
 * A file already identical to the backup is not rewritten: the write that has
 * just failed would probably fail again, and would announce a failed restore
 * when nothing had changed. The reload only takes place if it had been
 * attempted on the way out: otherwise Caddy never left the previous
 * configuration, and reloading it would bring nothing but one more risk.
 */
async function restore(machine: GeneralMachine, slug: string, backup: Backup, reloadAttempted: boolean): Promise<string | null> {
  const before = backup.manifest;
  try {
    const manifest = await readCautiously(() => machine.readManifest(slug));
    if (manifest === undefined || manifest?.text !== before.text) {
      await machine.writeManifest(slug, before.text, before.permissions);
    }
    const currentBlock = await readCautiously(() => machine.readBlock(slug));
    if (currentBlock === undefined || currentBlock !== backup.block) {
      if (backup.block === null) await machine.removeBlock(slug);
      else await machine.writeBlock(slug, backup.block);
    }
    if (backup.locks !== undefined) {
      const { codes, fragment } = backup.locks;
      const currentCodes = await readCautiously(() => machine.readCodes());
      // A codes file that did not exist cannot be removed from inside the
      // unit, /etc/caddy being read-only there: an empty table says the same.
      const wanted = codes ?? "{}\n";
      if (currentCodes === undefined || (currentCodes !== codes && !(codes === null && currentCodes === null))) {
        await machine.writeCodes(wanted, { uid: before.permissions.uid, gid: before.permissions.gid });
      }
      const currentFragment = await readCautiously(() => machine.readLocksFragment());
      if (currentFragment === undefined || currentFragment !== fragment) {
        if (fragment === null) await machine.removeLocksFragment();
        else await machine.writeLocksFragment(fragment);
      }
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

async function cleanUp(machine: GeneralMachine, slug: string): Promise<void> {
  try {
    await machine.clearBackup(slug);
  } catch (error) {
    machine.log(`gatekeeper ${slug}: backup not removed: ${errorMessage(error)}`);
  }
  await collectAnyway(machine, slug);
}

/** The dashboard must see the real state as soon as possible, especially after a failure. */
async function collectAnyway(machine: GeneralMachine, slug: string): Promise<void> {
  try {
    const reading = await machine.restartCollector(TIMEOUTS.collector);
    if (!reading.ok) machine.log(`gatekeeper ${slug}: collector not started: ${caddyExtract(reading.output)}`);
  } catch (error) {
    machine.log(`gatekeeper ${slug}: collector not started: ${errorMessage(error)}`);
  }
}
