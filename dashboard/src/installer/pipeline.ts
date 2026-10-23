/**
 * The deployment, run on the machine for a token: the order of
 * docs/concepts.md, "What the deploy actually does", step for step, with the
 * decisions `sitesolide deploy` makes, taken from the same modules.
 *
 * **Why not bin/sitesolide.ts itself, with a local executor.** Its `Executor`
 * abstracts one thing, running a command or printing it; the pipeline around
 * it is the workstation's: it builds locally, sends with rsync, hands the
 * block to bin/deploy-caddy.sh, which re-deposits the Caddyfile and the zone's
 * variables from the workstation's copy, rewrites the local sitesolide.json,
 * and verifies over the public network. On the machine, half of those steps
 * have no meaning and the Caddy one would be wrong. What is shared is what
 * decides, and that is shared for real: the manifest's validation, the unit and
 * block generators, the block and unit decisions, the port conflicts, the
 * units a manifest no longer names, the loopback's project set, the door
 * confirmed under the lock, all borrowed from bin/cli/ unchanged. The Caddy
 * step is the gatekeeper's machine (caddy.ts).
 *
 * The order, and what differs:
 *
 *   1. the manifest, re-validated with `validate()`, then the token's scope;
 *      missing ports chosen here, for the public services alone, the door and
 *      the preview lock taken from the machine, as `deploy` does; then the
 *      secret files it would read or take from another site (claims.ts);
 *   2. the machine read: the block in service, the unit names systemd already
 *      gives to a unit of the machine, the schedules systemd reads, the ports,
 *      the loopback rule, the portal's readiness, before anything is written;
 *   3. the build happened on the client: the archive carries its result;
 *   4. the account and the directories, the project's store of secrets for
 *      an app, then the archive extracted as the project's account into a
 *      staging directory, and `install` run there.
 *      Over SSH, `install` runs after the code is in place; here it runs
 *      before, in the staging directory, because the project's account may
 *      write there and not in `app/`: a failing install changes nothing served;
 *   5. the units;
 *   6. the Caddy lock, the door read again under it, and for a site behind the
 *      portal, its block before its files;
 *   7. the staged trees put in place of the served ones;
 *   8. the manifest, and the loopback's project set;
 *   9. the declared secret files, checked the project's own, a missing one
 *      said; the store's declared names, those missing said and returned,
 *      none of them stopping anything; then every service restarted;
 *  10. for an app in the open, its block; then the verification;
 *  11. the services that run for good read again once STABILITY_WINDOW_MS has
 *      passed since their restart: one that fell meanwhile fails the
 *      deployment, as over SSH.
 *
 * **A new project refused leaves nothing behind.** Its account, its tree and
 * its units are created at steps 4 and 5, before the archive is judged and
 * before the Caddy lock: refused there, a project that did not exist kept an
 * account, an empty `/srv/sites/<slug>` that the zone's wildcard served to
 * everyone, and a line in the token's status, public and of no type. What
 * this run created is therefore removed when it stops before anything was
 * served, see undoCreation; an existing project keeps everything it had.
 *
 * **The store's folders exist before any unit that loads them.** Every unit
 * of an app with a store loads its `files/` folder with `LoadCredential=`,
 * which has no optional form: without the folder, every start of the
 * project fails with 243/CREDENTIALS. So the store is laid at step 4, on
 * every deployment, before step 5 lays a unit and before step 9 restarts
 * anything; a folder deleted by hand comes back at the next deployment. A
 * failure to lay it stops the deployment there, and is worded, as a 243 is
 * wherever a unit's exit status is read (bin/cli/store.ts).
 *
 * **A creation is a creation.** A deployment the steward accepted as the
 * creation of its project never lays itself over one deployed meanwhile, by
 * the owner over SSH above all, which never reads the tokens' registry: its
 * tree there, or its manifest, stops it before anything is written, and a
 * store there that no write of its token made stops it before a unit is
 * laid (src/control/claims.ts). Otherwise the token's code would run with
 * the owner's project and its values.
 *
 * **No value the service runs with is dropped.** A manifest that no longer
 * declares a legacy file its installed units read, its old form naming
 * fewer files or a manifest that lists names, would restart the service
 * without what that file supplies and neither the store nor a kept file
 * does: refused at step 1, `migrate-first`, before anything is written,
 * whatever the client checked (`judgeLegacyLoss`).
 *
 * **One rule `deploy` cannot apply, applied here.** Over SSH, a block or a unit
 * in service that differs from the generated one stops the deployment until
 * `--force`: it may have been edited by hand, and a manifest that changed looks
 * the same from the workstation. The machine can tell the two apart: a file
 * that is exactly what the previous deposited manifest generates was not
 * edited by hand, and is replaced; anything else stops the deployment, and the
 * owner settles it with `sitesolide deploy --force`. A token has no `--force`.
 */
import { generateFragment, decideBlock } from "../../borrowed/fragment";
import { PROJECT_PORTS_FILE, projectPortPairs, projectPortsFile, reachesOwnPorts, type ProjectAccount } from "../../borrowed/loopback";
import {
  domainHosts,
  hasStore,
  isApp,
  legacySecretFiles,
  readManifest,
  scheduledServices,
  secretsOf,
  servicesOf,
  setDomainActive,
  setLock,
  setPortal,
  type Manifest,
} from "../../borrowed/manifest";
import { credentialsFailure, CREDENTIALS_EXIT_STATUS } from "../../borrowed/store";
import type { StoreMissing } from "../../borrowed/store-protocol";
import { confirmDoorUnderLock, portalFromManifest, type DepositedRead } from "../../borrowed/portal-vm";
import { domainConflicts, foreignUnit, portConflicts, staleUnits, unstableUnits, type UnitStanding } from "../../borrowed/services";
import { decideUnit, earlierGenerations, generateUnits, runningUnits, unitArgument, unitFileName, watchedUnits } from "../../borrowed/unit";
import { compareDirectives, sameDirectives, summariseDivergence, usefulDirectives } from "../../borrowed/comparison";
import { FIRST_CERTIFICATE_MS, readZoneNamesAnswer, ZONE_NAMES_PATH } from "../../borrowed/zone-names";
import { isPortalReady, portalHost, fromPortal, answers, describe } from "../gatekeeper/probe";
import { TIMEOUTS } from "../gatekeeper/transaction";
import { allocatePorts, decideDoor, legacyLoss, legacyLossRefusal, scopeRefusals, takenPorts } from "../control/policy";
import { madeStore, readClaims } from "../control/claims";
import type { InstallRequest } from "../control/protocol";
import type { ProjectEntry } from "../secrets/scope";
import { installBlock } from "./caddy";
import { claimRefusals, claimsOf, namesToCheck, type SecretFile } from "./claims";
import type { Host, Part } from "./host";

/**
 * How long after their restart the services that run for good must still be
 * running, and never restarted by systemd meanwhile, for the deployment to
 * succeed: the window `sitesolide deploy` watches over SSH. A service started
 * with `Type=simple` is `active` as soon as it is spawned, and one that falls
 * a second later passed the restart's `is-active`; only a second reading
 * sees it. The wait overlaps the Caddy step and the verification.
 */
export const STABILITY_WINDOW_MS = 10_000;

export type PipelineOptions = {
  zone: string;
  /** /run/sitesolide-gatekeeper, where an interrupted Caddy change leaves its backup. */
  runFolder: string;
  /** Lines of an install's output kept in the log. */
  installTail?: number;
};

/**
 * `missingSecrets`: the declared runtime names and files the store lacked
 * when the services were restarted, names alone; null for a project without
 * a store or whose store could not be read, absent when the deployment
 * stopped before.
 */
export type Outcome =
  | { ok: true; url: string; allocated: { service: string | null; port: number }[]; missingSecrets?: StoreMissing | null }
  | { ok: false; code: string; message: string; allocated: { service: string | null; port: number }[]; missingSecrets?: StoreMissing | null };

/** Between two probes of a verification waiting for a first certificate, and how long each may take. */
const VERIFY_PAUSE_MS = 5_000;
const VERIFY_PROBE_MS = 15_000;

/**
 * The zone's sites written again for the ask endpoint, see
 * api/src/zone-names.ts: whether the zone is certified on demand. An answer
 * the script never gives is said, and stops nothing: with a DNS provider the
 * list is not read, and with manual DNS the verification tells whether the
 * site got its certificate.
 */
async function refreshZoneNames(host: Host): Promise<boolean> {
  const listed = await host.refreshZoneNames();
  const answer = listed.code === 0 ? readZoneNamesAnswer(listed.output) : null;
  if (answer === null) {
    const said = listed.output.trim().split("\n").at(-1)?.slice(0, 200) || `exit ${listed.code}`;
    host.log(`   !! ${ZONE_NAMES_PATH} could not be written again (${said}): with manual DNS, a site it does not list gets no certificate`);
    return false;
  }
  if (answer.onDemand) host.log(`   ${ZONE_NAMES_PATH}: ${answer.sites} site(s) under the zone, which the ask endpoint allows`);
  return answer.onDemand;
}

/** A refusal that stops the pipeline: a stable code and a message that says what to do. */
export class Stop extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a generator gives for a previous manifest, or `fallback` when that
 * manifest, deposited by an older checkout, no longer generates: it then only
 * fails to vouch for a file, which a hand edit would also do.
 */
function attempt<T>(generate: () => T, fallback: T): T {
  try {
    return generate();
  } catch {
    return fallback;
  }
}

/** The manifest a file of the machine was generated from, when it reads. */
function previousManifest(raw: string | undefined): Manifest | null {
  if (raw === undefined) return null;
  const { manifest } = readManifest(raw);
  return manifest ?? null;
}

/**
 * The manifest this deployment deposits: the client's, with its ports chosen,
 * the machine's door and preview lock, judged by `validate()` and by the
 * token's scope. Pure, so that the tests judge every refusal without a host.
 */
export function finalManifest(
  request: InstallRequest,
  deposited: ReadonlyMap<string, string>,
): { text: string; manifest: Manifest; portal: boolean; allocated: { service: string | null; port: number }[]; doorConfirmed: boolean } {
  const { slug, scope } = request;
  let object: unknown;
  try {
    object = JSON.parse(request.manifest);
  } catch {
    throw new Stop("invalid-manifest", "sitesolide.json is not JSON");
  }
  if (!isObject(object)) throw new Stop("invalid-manifest", "sitesolide.json must contain an object");

  const raw = deposited.get(slug);
  let onMachine: DepositedRead = { kind: "absent" };
  if (raw !== undefined) {
    const door = portalFromManifest(raw, slug);
    onMachine = door.kind === "read" ? { kind: "present", portal: door.portal, lock: door.lock } : door;
  }
  if (onMachine.kind === "unreadable") {
    throw new Stop("machine-unreadable", `the manifest on the machine does not read (${onMachine.reason}): nothing was changed, the owner must look at /srv/sites/${slug}/sitesolide.json`);
  }
  const previous = previousManifest(raw);

  const allocation = allocatePorts(object, takenPorts(deposited, slug), previous);
  if ("refusal" in allocation) throw new Stop("no-port", allocation.refusal);

  const asked = readManifest(JSON.stringify(allocation.object));
  if (asked.manifest === undefined || asked.errors.length > 0) {
    throw new Stop("invalid-manifest", `sitesolide.json is refused: ${asked.errors.join("; ")}`);
  }
  const refusals = scopeRefusals(asked.manifest, scope, slug);
  const door = decideDoor(asked.manifest, scope, onMachine.kind === "present" ? onMachine.portal : null, request.token.member !== null);
  if ("refusal" in door) refusals.push(door.refusal);
  if (refusals.length > 0 || "refusal" in door) throw new Stop("out-of-scope", refusals.join("; "));

  // The door and the preview lock are the machine's, as for `deploy`: the
  // dashboard and `sitesolide lock` change them on the machine, through the
  // gatekeeper, and a deployment follows.
  let text = `${JSON.stringify(allocation.object, null, 2)}\n`;
  text = setPortal(text, door.portal);
  text = setLock(text, previous?.lock === true);
  // So is a domain's switch: `sitesolide domain --activate` sets
  // `domain.active` after checking the DNS and that a closed site's domain
  // closes with it, and the table api/ certifies and routes from reads that
  // field at its next regeneration, whoever runs it. A token may declare a
  // domain, never switch it on or off (docs/access.md): the machine's value
  // stands, and only for names it already covered, so that a new name or a
  // new alias never rides an earlier activation.
  if (asked.manifest.domain !== undefined) {
    const before = previous?.domain;
    const covered = before !== undefined && typeof before.name === "string" ? new Set(attempt(() => domainHosts(before), [])) : new Set<string>();
    const active = before?.active === true && domainHosts(asked.manifest.domain).every((host) => covered.has(host));
    text = setDomainActive(text, active);
  }
  const final = readManifest(text);
  if (final.manifest === undefined || final.errors.length > 0) {
    throw new Stop("invalid-manifest", `sitesolide.json is refused once the machine's portal and lock are applied: ${final.errors.join("; ")}`);
  }
  const conflicts = portConflicts(final.manifest, deposited);
  if (conflicts.length > 0) throw new Stop("port-taken", `${conflicts.join("; ")}: pick a free port between 3000 and 3099, or leave the port out and the machine chooses one`);
  const names = domainConflicts(final.manifest, deposited);
  if (names.length > 0) throw new Stop("domain-taken", `${names.join("; ")}: a name belongs to one project`);
  return { text, manifest: final.manifest, portal: door.portal, allocated: allocation.allocated, doorConfirmed: onMachine.kind === "present" };
}

/**
 * Is the file in service one the deployment may replace? Absent, identical, or
 * exactly what the previous deposited manifest generates; anything else was
 * edited by hand on the machine. Exactly: its `EnvironmentFile=` lines too in
 * the same order and number, see generatedAs.
 */
export function replaceable(inService: string | null, generated: string, previous: string | null): boolean {
  if (inService === null || inService.trim() === "") return true;
  if (generatedAs(inService, generated)) return true;
  return previous !== null && generatedAs(inService, previous);
}

/**
 * Whether a file in service is what the generator wrote as `earlier`, to be
 * replaced without --force: the same directives, and its `EnvironmentFile=`
 * lines in the same order and number. sameDirectives compares sets, which
 * suits a file kept as it is; one about to be replaced is held to more, since
 * a hand edit that names a file again last, or swaps two, adds no line and
 * still decides which value wins, systemd reading them in order. A Caddy
 * block has no such line, and is judged on its directives alone.
 *
 * The rule of generatedAs in bin/cli/unit.ts, which `deploy` applies; kept
 * here until that function is on main, then borrowed in its place.
 */
export function generatedAs(inService: string, earlier: string): boolean {
  if (!sameDirectives(inService, earlier)) return false;
  const read = environmentFiles(inService);
  const written = environmentFiles(earlier);
  return read.length === written.length && read.every((line, i) => line === written[i]);
}

/** A unit's `EnvironmentFile=` lines in the order systemd reads them, a repeat kept. */
function environmentFiles(text: string): string[] {
  return usefulDirectives(text).filter((line) => line.startsWith("EnvironmentFile="));
}

function handEdited(path: string, inService: string, generated: string): Stop {
  const divergence = summariseDivergence(compareDirectives(inService, generated));
  return new Stop(
    "edited-by-hand",
    `${path} on the machine was edited by hand (${divergence.join(" ")}): nothing was changed; the owner must read it, then deploy once with sitesolide deploy --force`,
  );
}

export async function runPipeline(host: Host, request: InstallRequest, options: PipelineOptions): Promise<Outcome> {
  const { slug } = request;
  const { zone } = options;
  let allocated: { service: string | null; port: number }[] = [];
  let release: (() => void) | null = null;
  const created: Created = { account: false, tree: false, units: [], store: false };
  // What the store lacked once read, at step 9: kept in a failure that came after.
  let missing: { missingSecrets?: StoreMissing | null } = {};
  // Set once Caddy or the served trees may have changed: from there on, a
  // stop keeps what this run created, see undoCreation.
  let served = false;
  let succeeded = false;
  // The services that run for good as read right after their restart, see step 11.
  let stability: Stability | null = null;
  const unlock = () => {
    if (release !== null) {
      release();
      release = null;
    }
  };

  try {
    // --- 1. the manifest ------------------------------------------------------
    host.log("-> manifest, validated on the machine");
    let deposited: Map<string, string>;
    try {
      deposited = await host.readManifests();
    } catch (error) {
      throw new Stop("machine-unreadable", `cannot read the manifests on the machine (${(error as Error).message}): nothing was changed`);
    }
    if (request.creating && deposited.has(slug)) throw takenMeanwhile(slug);
    const final = finalManifest(request, deposited);
    allocated = final.allocated;
    const { manifest, text } = final;
    const previous = previousManifest(deposited.get(slug));
    const application = isApp(manifest);
    // Only an app's unit reads its `secrets`; any project's name may take a
    // file by its prefix all the same.
    await judgeClaims(host, slug, text, application ? legacySecretFiles(manifest) : []);
    if (hasStore(manifest)) await judgeLegacyLoss(host, slug, legacySecretFiles(manifest));
    const behindPortal = final.portal;
    for (const { service, port } of allocated) host.log(`   port ${port} chosen for ${service === null ? "the service" : `service ${service}`}`);
    host.log(`   project ${slug}, ${application ? `${servicesOf(manifest).length > 1 ? `${servicesOf(manifest).length} services` : "service"}` : "static"}, ${behindPortal ? "restricted" : "public"}`);

    // --- 2. the machine, read before anything is written -----------------------
    host.log("-> the machine");
    // An application's block, as `deploy` writes one for applications alone.
    const block = application ? generateFragment(manifest) : null;
    if (block !== null) {
      const inService = await host.machine.readBlock(slug);
      const before = previous === null ? null : attempt(() => generateFragment(previous), null);
      const replace = replaceable(inService, block, before);
      if (decideBlock({ manifest, inService, replace, doorConfirmed: final.doorConfirmed }) === "diverged") {
        throw handEdited(`/etc/caddy/sites/${slug}.caddy`, inService ?? "", block);
      }
    }
    // A unit name systemd already gives to a service of the machine, a
    // package's unit in /lib/systemd/system above all, which a unit laid in
    // /etc would replace: as `deploy` does, see foreignUnit in services.ts.
    if (application) {
      for (const { unit } of generateUnits(manifest)) {
        const facts = await host.unitFacts(slug, unit);
        if (facts === null) throw new Stop("machine-unreadable", `cannot tell whether systemd already runs a unit named ${unitFileName(unit)}: nothing was changed`);
        const foreign = foreignUnit(unit, slug, facts, host.unitsFolder);
        if (foreign !== null) throw new Stop("system-unit", `${foreign}: ${slug} is the name of a service of the machine, which a deployment never replaces; nothing was changed, pick another slug`);
      }
    }
    // validate() only knows a schedule is safe to write: whether it is a
    // time is systemd's to say, and a timer it cannot read is laid, loaded,
    // and never starts anything. Asked before anything is written, as
    // `deploy` asks, see scheduleCheckCommand in services.ts.
    const scheduled = scheduledServices(manifest);
    if (scheduled.length > 0) {
      const refused = await host.refusedSchedules(scheduled.map((service) => service.schedule!));
      if (refused === null) throw new Stop("machine-unreadable", "cannot ask systemd whether it reads the schedules: nothing was changed");
      if (refused.length > 0) {
        const named = scheduled.filter((service) => refused.includes(service.schedule!));
        throw new Stop(
          "invalid-manifest",
          `${named.map((service) => `services.${service.name}.schedule: systemd does not read ${JSON.stringify(service.schedule)} as a time`).join("; ")}; write it as OnCalendar= takes it, such as hourly, daily, *:0/15 or "Mon..Fri 08:00", which systemd-analyze calendar checks: nothing was changed`,
        );
      }
    }
    // A backup command reaches its service on its port, through the same set.
    if (reachesOwnPorts(manifest)) {
      const state = await host.loopback.state();
      if (state === "unreadable") throw new Stop("machine-unreadable", "cannot tell whether the loopback rule is in place: nothing was changed");
      if (state === "table") {
        throw new Stop("loopback-outdated", "the loopback rule on the machine predates the project set: the owner must run bin/deploy-loopback.sh close; nothing was changed");
      }
    }
    if ((await host.machine.interruptedTransaction()) !== null) {
      throw new Stop("caddy-unknown", "an interrupted change left Caddy in an unknown state on the machine: the owner must look at it; nothing was changed");
    }
    if (behindPortal) {
      const portal = await host.machine.probe(portalHost(zone), "/sante", TIMEOUTS.probeConfig);
      if (!isPortalReady(portal)) {
        throw new Stop("portal-not-ready", `the portal is not ready at https://${portalHost(zone)}/sante, a site behind it would be closed to everyone: the owner must deploy portal/ first`);
      }
    }
    host.log("   the block, the ports and general access agree");

    // --- 3. the build happened on the client ----------------------------------
    // --- 4. the account, the directories, the archive, `install` ---------------
    host.log("-> system user and directories");
    const account = await host.ensureAccount(slug);
    created.account = account === "created";
    if (created.account) host.log(`   site-${slug} created`);
    created.tree = (await host.prepareTree(slug, application)) === "created";
    if (request.creating && !created.tree) throw takenMeanwhile(slug);
    // Said at once: an installer killed from here on leaves a folder it laid itself.
    if (created.tree) host.laid(true);
    if (hasStore(manifest)) {
      created.store = await prepareStore(host, slug);
      if (request.creating && !created.store) await judgeStoreOwn(host, slug, request.token.id);
    }

    host.log("-> archive, extracted as the project's own account");
    const staging = await host.stage(slug);
    const extraction = await host.extract(slug, request.deployment, staging);
    if (!extraction.ok) throw new Stop("bundle-refused", `the archive is refused: ${extraction.reason}`);
    host.log(`   ${extraction.summary.files} file(s), ${extraction.summary.bytes} bytes`);
    const parts: Part[] = [];
    if (application) parts.push("app");
    if (manifest.publicDir !== undefined) {
      if (!(await host.hasFiles(staging, "public"))) {
        throw new Stop("public-empty", `publicDir ${manifest.publicDir} arrived empty: the live site would be wiped; did the build run?`);
      }
      parts.push("public");
    }

    if (application && manifest.install !== undefined) {
      host.log(`-> dependencies (${manifest.install}), as the project's own account`);
      const installed = await host.install(slug, staging, manifest.install);
      const lines = installed.output.split("\n").filter((line) => line.trim() !== "");
      for (const line of lines.slice(-(options.installTail ?? 40))) host.log(`   ${line}`);
      if (installed.code !== 0) throw new Stop("install-failed", `${manifest.install} failed (exit ${installed.code}): nothing served was changed`);
    }

    // --- 5. the units -----------------------------------------------------------
    const units = generateUnits(manifest);
    if (application) {
      host.log(units.length > 1 ? "-> systemd units" : "-> systemd unit");
      const previousUnits = previous === null ? [] : attempt(() => generateUnits(previous), []);
      const decisions = [];
      for (const { unit, text: generated } of units) {
        const onDisk = await host.readUnit(unit);
        const installed = onDisk ?? "";
        const before = previousUnits.find((candidate) => candidate.unit === unit)?.text ?? null;
        // A unit an earlier release generated, before the bind lines or the
        // system-call filter, from this manifest or the previous one, is the
        // generator's own too.
        const earlier = before === null ? [] : earlierGenerations(before);
        const replace =
          replaceable(installed, generated, before) ||
          earlierGenerations(generated).some((text, generation) => replaceable(installed, text, earlier[generation] ?? null));
        decisions.push({ unit, generated, installed, absent: onDisk === null, action: decideUnit({ installed, generated, replace }) });
      }
      // As `deploy` does: a unit edited by hand stays, and says so; the main
      // one of a project with several services stops everything, since it is
      // what starts the others at boot.
      const [main] = decisions;
      if (main !== undefined && main.action === "diverged" && decisions.length > 1) {
        throw handEdited(`/etc/systemd/system/${unitFileName(main.unit)}`, main.installed, main.generated);
      }
      let changed = false;
      for (const decision of decisions) {
        if (decision.action === "present") {
          host.log(`   unchanged  ${unitFileName(decision.unit)}`);
          continue;
        }
        if (decision.action === "diverged") {
          host.log(`   differs    ${unitFileName(decision.unit)}, edited by hand on the machine: left as it is, so a changed port, memory, schedule or env has no effect until the owner deploys with --force`);
          continue;
        }
        await host.installUnit(decision.unit, decision.generated);
        if (decision.absent) created.units.push(decision.unit);
        host.log(`   installed  ${unitFileName(decision.unit)}`);
        changed = true;
      }
      // A service or a schedule dropped from the manifest takes its unit
      // with it, a timer included: left, it would go on starting a service
      // that no longer exists, or one that now runs for good.
      const stale = staleUnits(manifest, await host.generatedUnits(slug));
      if (stale.length > 0) {
        await host.removeUnits(stale);
        for (const unit of stale) host.log(`   removed    ${unitFileName(unit)}, no longer declared`);
      }
      if (changed) await host.enable(slug);
    }

    // --- 6. the Caddy lock, the door again, a protected site's block ------------
    host.log("-> Caddy lock, shared with the gatekeeper and the workstation");
    const taken = await host.machine.takeLock();
    if (taken.kind === "held") {
      throw new Stop("caddy-busy", `Caddy is being changed by ${taken.who ?? "another action"}: nothing served was changed, deploy again in a moment`);
    }
    release = taken.release;
    let underLock: DepositedRead = { kind: "absent" };
    let current: Map<string, string> | null = null;
    try {
      current = await host.readManifests();
      const raw = current.get(slug);
      if (raw !== undefined) {
        const door = portalFromManifest(raw, slug);
        underLock = door.kind === "read" ? { kind: "present", portal: door.portal, lock: door.lock } : door;
      }
    } catch (error) {
      underLock = { kind: "unreadable", reason: (error as Error).message };
    }
    // The portal and the code both: a code set from the dashboard while this
    // deployment was being prepared would be dropped by its manifest, the code
    // left in force for a manifest that no longer asks for it.
    const agreement = confirmDoorUnderLock(slug, { portal: behindPortal, lock: manifest.lock === true }, underLock);
    if (agreement.kind === "rejects") throw new Stop("access-changed", `${agreement.message}; nothing served was changed`);
    // The ports again, under the lock every deposit takes: two deployments
    // running side by side chose theirs from the same reading, and the first
    // to get here has deposited its own since.
    const collisions = current === null ? [] : portConflicts(manifest, current);
    if (collisions.length > 0) {
      throw new Stop("port-taken", `${collisions.join("; ")}, since this deployment started: nothing served was changed, deploy again`);
    }
    const claimed = current === null ? [] : domainConflicts(manifest, current);
    if (claimed.length > 0) throw new Stop("domain-taken", `${claimed.join("; ")}, since this deployment started: nothing served was changed`);
    // The first change anybody may see: a protected site's block, or the
    // trees. A Caddy step that fails restores the block, but one whose
    // restore failed leaves it to the owner, and this run cannot tell them
    // apart from here: everything stays from this point on.
    served = true;

    // Only now, with manual DNS, may the ask endpoint allow the site's name:
    // the archive judged, `install` run, and everything that follows kept
    // even if it fails, a project the owner sees. Listed any earlier, a
    // token could open TLS to a name whose deployment it then lets fail, and
    // spend the authority's weekly certificates on the zone one throwaway
    // slug at a time. Before the Caddy step and the verification, whose
    // handshakes obtain the certificate.
    const onDemand = await refreshZoneNames(host);

    if (block !== null && behindPortal) {
      host.log("-> Caddy block, before the files: the restriction goes up first");
      const outcome = await installBlock(host.machine, { slug, zone, text: block, protected: true, runFolder: options.runFolder, onDemand });
      if (!outcome.ok) throw new Stop("caddy-refused", outcome.message);
      host.log(`   ${outcome.detail}`);
    }

    // --- 7. the files ------------------------------------------------------------
    host.log(`-> ${parts.join(" and ")}, put in place`);
    await host.place(slug, staging, parts);

    // --- 8. the manifest, the loopback's set ----------------------------------------
    host.log("-> manifest");
    await host.depositManifest(slug, text);
    if (application) await rebuildProjectPorts(host, reachesOwnPorts(manifest));
    if (!application || behindPortal) unlock();

    // --- 9. secrets, restart ----------------------------------------------------------
    if (application) {
      const secrets = legacySecretFiles(manifest);
      if (secrets.length > 0) {
        host.log("-> declared secret files");
        const foreign: string[] = [];
        // Judged at step 1 already, and again here, right before the restart
        // that has the unit read them: a file laid since by somebody else.
        // A file missing stops nothing: the unit reads it optionally, and the
        // service starts without its variables, which the log says.
        const account = await host.accountUid(slug);
        for (const name of secrets) {
          const file = await host.secretFile(name);
          if (file.kind === "absent") host.log(`   !! /etc/sitesolide/${name} missing: the service starts without its variables`);
          else if (file.kind !== "file" || account === null || file.uid !== account) foreign.push(name);
          else host.log(`   present  /etc/sitesolide/${name}`);
        }
        if (foreign.length > 0) {
          throw new Stop(
            "secret-taken",
            `/etc/sitesolide/${foreign.join(", /etc/sitesolide/")} does not belong to site-${slug}: a project reads its own files alone; the files are in place, the service was not restarted, the owner of the machine must look at it`,
          );
        }
      }
      missing = { missingSecrets: hasStore(manifest) ? await missingFromStore(host, slug, manifest) : null };
      // Every unit but the scheduled services, which their timers start:
      // restarted, one would run at once, outside its schedule, and an idle
      // one is inactive by design. The main unit's restart reaches a run in
      // progress through its PartOf, and leaves an idle one idle.
      const units = runningUnits(manifest);
      const names = units.map(unitArgument);
      host.log(names.length > 1 ? "-> services restart" : "-> service restart");
      const restarted = await host.restart(names);
      if (restarted.code !== 0) {
        // A unit that could not load its files says so in systemd's words,
        // "Protocol error": its exit status says what it is.
        const worded = await credentialsFailures(host, slug, units);
        const said = `${names.join(", ")} did not come back active (${restarted.output.trim().split("\n").join(", ") || "no answer"})`;
        throw new Stop("service-failed", `${worded.length > 0 ? worded.join("; ") : said}: read sitesolide logs`);
      }
      stability = await firstReading(host, watchedUnits(manifest));

      // --- 10. an open app's block, then the verification ---------------------------
      if (block !== null && !behindPortal) {
        host.log("-> Caddy block, through the validated path");
        const outcome = await installBlock(host.machine, { slug, zone, text: block, protected: false, runFolder: options.runFolder, onDemand });
        if (!outcome.ok) throw new Stop("caddy-refused", outcome.message);
        host.log(`   ${outcome.detail}`);
      }
    }
    unlock();

    host.log("-> verify");
    const url = `https://${slug}.${zone}/`;
    let answer = await host.machine.probe(`${slug}.${zone}`, "/", TIMEOUTS.probeConfig);
    // With manual DNS alone, a site that does not answer at all may be
    // obtaining its first certificate through this very handshake: asked
    // again, bounded. Any answer is judged at once, as it always was.
    if (onDemand && "error" in answer) {
      host.log(`   no answer yet: the zone is certified on demand, and the site's first certificate is obtained by this handshake; asking again for up to ${FIRST_CERTIFICATE_MS / 1000} s`);
      const until = host.machine.now() + FIRST_CERTIFICATE_MS;
      while ("error" in answer && host.machine.now() + VERIFY_PAUSE_MS < until) {
        await host.machine.wait(VERIFY_PAUSE_MS);
        answer = await host.machine.probe(`${slug}.${zone}`, "/", VERIFY_PROBE_MS);
      }
    }
    if (behindPortal) {
      if (!fromPortal(answer)) throw new Stop("verify-failed", `${url} should answer the portal's 401, got ${describe(answer)}: sitesolide.json says Restricted, and the site answers anyone; tell the owner of the machine now`);
      host.log(`   ${url} 401, restricted: visitors are asked to sign in`);
    } else {
      if (!answers(answer)) {
        // The rule of `deploy`, said the same way: docs/manifest.md, under `start`.
        const nothing = "code" in answer && answer.code === 404;
        throw new Stop(
          "verify-failed",
          nothing
            ? `${url} answered 404: nothing is served at the site's root; make it answer 200, from the app, which receives / unless the manifest has routes, or from an index.html in publicDir (docs/manifest.md, under start)`
            : `${url} answered ${describe(answer)}, expected 200`,
        );
      }
      host.log(`   ${url} ${"code" in answer ? answer.code : ""}`);
    }

    // --- 11. the services, a while after their restart -------------------------------
    if (stability !== null) await secondReading(host, slug, stability);
    succeeded = true;
    return { ok: true, url, allocated, ...missing };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, code: error.code, message: error.message, allocated, ...missing };
    const name = (error as { code?: unknown } | null)?.code ?? (error as Error).name;
    return { ok: false, code: "failure", message: `unexpected error on the machine (${String(name)}): the owner must read journalctl -u sitesolide-installer@${slug}`, allocated, ...missing };
  } finally {
    unlock();
    try {
      await host.cleanUp(slug);
    } catch {
      // A staging directory left behind is removed by the next deployment.
    }
    if (!succeeded && !served) await undoCreation(host, slug, created);
  }
}

/**
 * The secret files this deployment would read or take from another site,
 * judged before anything is written (claims.ts): a refusal names each file,
 * never what it holds.
 */
async function judgeClaims(host: Host, slug: string, text: string, declared: readonly string[]): Promise<void> {
  let scope: { projects: ProjectEntry[]; present: string[] };
  try {
    scope = await host.secretScope();
  } catch (error) {
    throw new Stop("machine-unreadable", `cannot list the projects and the secret files on the machine (${(error as Error).message}): nothing was changed`);
  }
  const claims = claimsOf(slug, text, scope.projects, scope.present);
  const files = new Map<string, SecretFile>();
  for (const name of namesToCheck(declared, claims)) files.set(name, await host.secretFile(name));
  const refusals = claimRefusals(slug, declared, claims, files, await host.accountUid(slug));
  if (refusals.length > 0) throw new Stop("secret-taken", `${refusals.join("; ")}; nothing was changed`);
}

/** A creation that finds its project laid since it was accepted: someone else's, the owner's SSH deploy above all. */
function takenMeanwhile(slug: string): Stop {
  return new Stop("taken-meanwhile", `${slug} was deployed on the machine since this deployment was accepted as its creation: a token's creation never lays itself over another project; nothing was changed`);
}

/**
 * A creation finding a store already there: its token's own only when that
 * token's write made it ahead of this deployment (src/control/claims.ts).
 * Any other, laid or filled by the owner, or another token's, refuses before
 * a unit is laid, so that the token's code never runs with its values. The
 * claims that do not read refuse too.
 */
async function judgeStoreOwn(host: Host, slug: string, token: string): Promise<void> {
  let claims: ReturnType<typeof readClaims>;
  try {
    claims = readClaims(await host.readClaims());
  } catch {
    claims = { unreadable: "claims.json does not read" };
  }
  if (!("unreadable" in claims) && madeStore(claims, slug, token)) return;
  throw new Stop(
    "store-not-yours",
    `/etc/sitesolide/projects/${slug} holds a store no write of this token made: a token's creation never takes a store it did not make; nothing was served, the owner of the machine must look at it`,
  );
}

/**
 * The values this deployment would drop (src/control/policy.ts,
 * `legacyLoss`): what the legacy files the installed units read supply and
 * the store lacks, a manifest that reads the store alone being deployed.
 * Refused before anything is written, `migrate-first`, naming neither a
 * variable nor a file: the owner runs `sitesolide secrets migrate --restart`
 * first. A store whose names cannot be read refuses too, rather than guess.
 */
async function judgeLegacyLoss(host: Host, slug: string, kept: readonly string[]): Promise<void> {
  let read: Awaited<ReturnType<Host["legacyReadByUnits"]>>;
  try {
    read = await host.legacyReadByUnits(slug, kept);
  } catch (error) {
    throw new Stop("machine-unreadable", `cannot read the units of ${slug} on the machine (${(error as Error).message}): nothing was changed`);
  }
  // Only the files an installed unit reads and this manifest no longer declares can drop anything.
  if (read.every((file) => file.read === false || kept.includes(file.name) || file.state === "absent")) return;
  const names = await host.storeNames(slug);
  if (names === null) {
    throw new Stop("machine-unreadable", "cannot tell what the project's store holds of the variables legacy files supply the service with: nothing was changed");
  }
  const refusal = legacyLossRefusal(legacyLoss(read, new Set(names.variables), kept));
  if (refusal !== null) throw new Stop("migrate-first", refusal);
}

/**
 * The project's store laid before any unit that loads it (I3'), the three
 * folders root's: whether this run made the project's folder. A refusal, a
 * link or anything that is no folder where one goes, stops the deployment
 * before a unit is laid, and so does a store that cannot be laid at all.
 */
async function prepareStore(host: Host, slug: string): Promise<boolean> {
  let prepared: Awaited<ReturnType<Host["prepareStore"]>>;
  try {
    prepared = await host.prepareStore(slug);
  } catch (error) {
    const name = (error as { code?: unknown } | null)?.code ?? (error as Error).name;
    throw new Stop(
      "store-failed",
      `the project's store of secrets could not be laid under /etc/sitesolide/projects (${String(name)}): without its files folder every start of the project would fail; nothing was served, the owner of the machine must run sitesolide upgrade, then look at it`,
    );
  }
  if (prepared.kind === "refused") {
    throw new Stop("store-refused", `${prepared.path} is not a folder root owns: the owner of the machine must look at it; nothing was changed`);
  }
  if (prepared.created) host.log("   the project's store of secrets laid, empty");
  return prepared.created;
}

/**
 * The declared runtime names and files the store lacks, read right before
 * the restart, said in the log and returned. Names alone: nothing is ever
 * read of a value. Nothing stops: a service that cannot live without one
 * fails its start, which the stability reading then says. Null when the
 * store's names cannot be read, which is said too.
 */
async function missingFromStore(host: Host, slug: string, manifest: Manifest): Promise<StoreMissing | null> {
  const declared = secretsOf(manifest);
  if (declared.runtime.length === 0 && declared.files.length === 0) return { runtime: [], files: [] };
  host.log("-> the store's declared names");
  const names = await host.storeNames(slug);
  if (names === null) {
    host.log("   !! the store's names could not be read: whether a declared secret is missing is not checked");
    return null;
  }
  const runtime = declared.runtime.filter((name) => !names.variables.includes(name));
  const files = declared.files.filter((name) => !names.files.includes(name));
  if (runtime.length > 0) {
    host.log(`   !! runtime secrets not set on the machine: ${runtime.join(", ")}: sitesolide secrets set ${runtime[0]}, or sitesolide secrets generate ${runtime.at(-1)}`);
  }
  if (files.length > 0) {
    host.log(`   !! secret files not set on the machine: ${files.join(", ")}: sitesolide secrets set-file ${files[0]} < ${files[0]}`);
  }
  if (runtime.length === 0 && files.length === 0) host.log("   every declared name is set");
  return { runtime, files };
}

/**
 * The units among these whose main process exited 243, each worded by
 * `credentialsFailure`: systemd logs it "Failed to set up credentials:
 * Protocol error", which sends one looking elsewhere. Empty when none did,
 * or when their standing cannot be read.
 */
async function credentialsFailures(host: Host, slug: string, units: string[]): Promise<string[]> {
  const standing = await host.standing(units).catch(() => null);
  if (standing === null) return [];
  return units.filter((unit) => standing.get(unit)?.status === CREDENTIALS_EXIT_STATUS).map((unit) => credentialsFailure(unitFileName(unit), slug));
}

/** The services that run for good, as read right after their restart. */
type Stability = { units: string[]; at: number; before: Map<string, UnitStanding> };

/**
 * How the servers and the workers stand right after their restart: the
 * reading the second one is compared with. Null when there is none to watch,
 * a project whose every service is scheduled, or when systemctl did not
 * answer, which is said and fails nothing: the restart's `is-active` passed.
 */
async function firstReading(host: Host, units: string[]): Promise<Stability | null> {
  if (units.length === 0) return null;
  const at = host.machine.now();
  const before = await host.standing(units);
  if (before === null) {
    host.log("   !! how the services stand could not be read: whether they hold is not checked");
    return null;
  }
  return { units, at, before };
}

/**
 * The second reading, once STABILITY_WINDOW_MS has passed since the first:
 * a unit no longer active, or restarted by systemd meanwhile, fails the
 * deployment, named with what was seen. Everything is in place by then, as
 * after a failed verification: the owner reads the logs, fixes, deploys again.
 */
async function secondReading(host: Host, slug: string, stability: Stability): Promise<void> {
  const remaining = stability.at + STABILITY_WINDOW_MS - host.machine.now();
  host.log(`-> ${stability.units.length > 1 ? "services" : "service"}, ${STABILITY_WINDOW_MS / 1000} s after the restart`);
  if (remaining > 0) await host.machine.wait(remaining);
  const after = await host.standing(stability.units);
  if (after === null) {
    host.log("   !! how the services stand could not be read: whether they hold is not checked");
    return;
  }
  const fallen = unstableUnits(stability.before, after);
  if (fallen.length > 0) {
    // A unit that could not load its files is worded by what it is.
    const credentials = stability.units.filter((unit) => after.get(unit)?.status === CREDENTIALS_EXIT_STATUS);
    if (credentials.length > 0) throw new Stop("service-failed", `${credentials.map((unit) => credentialsFailure(unitFileName(unit), slug)).join("; ")}: read sitesolide logs`);
    throw new Stop("service-failed", `${fallen.join("; ")}, within ${STABILITY_WINDOW_MS / 1000} s of the restart: the files are in place; read sitesolide logs`);
  }
  host.log(`   ${stability.units.map(unitFileName).join(", ")} still running`);
}

/** What this run created on the machine, as opposed to what it found there. */
type Created = { account: boolean; tree: boolean; units: string[]; store: boolean };

/**
 * A project this run created, taken away again when it stops before anything
 * was served: its units, its tree, then its account, the order of
 * `sitesolide remove` (bin/cli/removal.ts), the account last so that no file
 * outlives its owner for the next account to inherit on the same uid.
 *
 * Only for a project that did not exist: `/srv/sites/<slug>` absent before
 * the run. A project that had its tree keeps everything, whatever this run
 * added to it, and an account or a unit found on the machine is never
 * removed, even for a new tree: an account left by a removal that stopped half
 * way is not this run's to take. A step that fails leaves the rest, and says
 * so: the refusal stands either way, the leftovers are the owner's.
 *
 * The store's folders this run laid go after the units that load them and
 * the tree, and only while empty: left, they would be a store under a name
 * nobody holds, which no token may then create (src/control/policy.ts). A
 * store found on the machine, one a token wrote ahead of this deployment
 * above all, stays.
 */
async function undoCreation(host: Host, slug: string, created: Created): Promise<void> {
  if (!created.tree) return;
  host.log("-> nothing was served: what this deployment created is removed");
  try {
    if (created.units.length > 0) {
      await host.removeUnits(created.units);
      for (const unit of created.units) host.log(`   removed    ${unitFileName(unit)}`);
    }
    if (!(await host.removeTree(slug))) {
      host.log(`   !! /srv/sites/${slug} carries a manifest deposited in the meantime: left as it is${created.account ? `, and site-${slug} with it` : ""}${created.store ? ", and its store" : ""}`);
      return;
    }
    host.log(`   removed    /srv/sites/${slug}`);
    host.laid(false);
    // Once nobody else deployed it meanwhile: a deployment that did would
    // have laid units that load the folder.
    if (created.store) {
      if (await host.removeStore(slug)) host.log("   removed    the project's store of secrets, empty");
      else host.log("   !! the project's store of secrets holds something written since: left for the owner");
    }
    // Never listed by this run, but listed by any other writer that ran
    // while the folder existed: it drops out with the folder.
    await refreshZoneNames(host);
    if (!created.account) return;
    const removed = await host.removeAccount(slug);
    if (removed.code !== 0) {
      host.log(`   !! userdel site-${slug} failed (${removed.output.trim().slice(0, 200) || `exit ${removed.code}`}): the account is left for the owner`);
      return;
    }
    host.log(`   removed    site-${slug}`);
  } catch (error) {
    host.log(`   !! ${(error as Error).message}: the rest is left for the owner`);
  }
}

/**
 * The loopback's project set, rebuilt from the manifests on the machine, as
 * `rebuildProjectPorts` of bin/sitesolide.ts does: strict for a project that
 * reaches its own ports, which depends on it (reachesOwnPorts); following
 * otherwise, so that a project that no longer does drops out of it.
 */
async function rebuildProjectPorts(host: Host, strict: boolean): Promise<void> {
  const fail = (message: string): void => {
    if (strict) throw new Stop("loopback-failed", `${message}: the project could not reach its own ports`);
    host.log(`   !! ${message}: the loopback's project set was left as it is`);
  };
  const state = await host.loopback.state();
  if (state === "unreadable") return fail("cannot tell whether the loopback rule is in place");
  if (state === "table" && strict) return fail("the loopback rule predates the project set");

  let manifests: Map<string, string>;
  try {
    manifests = await host.readManifests();
  } catch {
    return fail("cannot read the manifests on the machine");
  }
  const projects: Manifest[] = [];
  for (const [folder, raw] of manifests) {
    const { manifest } = readManifest(raw);
    if (manifest === undefined || !reachesOwnPorts(manifest)) continue;
    // A worker or a scheduled service declares no port, and has none to check.
    const ports = servicesOf(manifest).flatMap((service) => (service.port === null ? [] : [service.port]));
    if (manifest.slug !== folder || !ports.every((port) => Number.isInteger(port) && port >= 3000 && port <= 3099)) continue;
    projects.push(manifest);
  }
  const slugs = projects.map((manifest) => manifest.slug);
  let uids = new Map<string, number>();
  if (slugs.length > 0) {
    const read = await host.loopback.uids(slugs);
    if (read === null) return fail("cannot read the system users of the projects that reach their own ports");
    uids = read;
  }
  const accounts: ProjectAccount[] = projects.map((manifest) => ({ manifest, uid: uids.get(manifest.slug)! }));
  if (state === "set" && !strict) {
    const current = await host.loopback.pairs();
    if (current === null) return fail("cannot read the loopback's project set");
    const wanted = projectPortPairs(accounts);
    if (current.length === wanted.length && current.every((pair) => wanted.includes(pair))) return;
  }
  if (state !== "set" && !strict && !(await host.loopback.filePresent())) return;

  host.log("-> loopback: each project's own ports");
  const written = await host.loopback.write(projectPortsFile(accounts), state === "set");
  if (written.code !== 0) return fail(`${PROJECT_PORTS_FILE} refused (${written.output.trim() || "no message"})`);
  host.log(`   ${slugs.length === 0 ? "no project" : slugs.join(", ")} reaching ${slugs.length === 1 ? "its" : "their"} own ports`);
}
