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
 *      missing ports chosen here, the door and the preview lock taken from the
 *      machine, as `deploy` does;
 *   2. the machine read: the block in service, the unit names systemd already
 *      gives to a service of the machine, the ports, the loopback rule, the
 *      portal's readiness, before anything is written;
 *   3. the build happened on the client: the archive carries its result;
 *   4. the account and the directories, then the archive extracted as the
 *      project's account into a staging directory, and `install` run there.
 *      Over SSH, `install` runs after the code is in place; here it runs
 *      before, in the staging directory, because the project's account may
 *      write there and not in `app/`: a failing install changes nothing served;
 *   5. the units;
 *   6. the Caddy lock, the door read again under it, and for a site behind the
 *      portal, its block before its files;
 *   7. the staged trees put in place of the served ones;
 *   8. the manifest, and the loopback's project set;
 *   9. the declared secrets, checked present, then every service restarted;
 *  10. for an app in the open, its block; then the verification.
 *
 * **A new project refused leaves nothing behind.** Its account, its tree and
 * its units are created at steps 4 and 5, before the archive is judged and
 * before the Caddy lock: refused there, a project that did not exist kept an
 * account, an empty `/srv/sites/<slug>` that the zone's wildcard served to
 * everyone, and a line in the token's status, public and of no type. What
 * this run created is therefore removed when it stops before anything was
 * served, see undoCreation; an existing project keeps everything it had.
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
import { PROJECT_PORTS_FILE, projectPortPairs, projectPortsFile, type ProjectAccount } from "../../borrowed/loopback";
import { hasServices, isApp, readManifest, servicesOf, setLock, setPortal, type Manifest } from "../../borrowed/manifest";
import { confirmDoorUnderLock, portalFromManifest, type DepositedRead } from "../../borrowed/portal-vm";
import { foreignUnit, portConflicts, staleUnits } from "../../borrowed/services";
import { decideUnit, generateUnits, unitArgument } from "../../borrowed/unit";
import { compareDirectives, sameDirectives, summariseDivergence } from "../../borrowed/comparison";
import { isPortalReady, portalHost, fromPortal, answers, describe } from "../gatekeeper/probe";
import { TIMEOUTS } from "../gatekeeper/transaction";
import { allocatePorts, decideDoor, scopeRefusals, takenPorts } from "../control/policy";
import type { InstallRequest } from "../control/protocol";
import { installBlock } from "./caddy";
import type { Host, Part } from "./host";

export type PipelineOptions = {
  zone: string;
  /** /run/sitesolide-gatekeeper, where an interrupted Caddy change leaves its backup. */
  runFolder: string;
  /** Lines of an install's output kept in the log. */
  installTail?: number;
};

export type Outcome =
  | { ok: true; url: string; allocated: { service: string | null; port: number }[] }
  | { ok: false; code: string; message: string; allocated: { service: string | null; port: number }[] };

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
    onMachine = door.kind === "read" ? { kind: "present", portal: door.portal } : door;
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
  // dashboard and bin/lock.sh change them on the machine, a deployment follows.
  let text = `${JSON.stringify(allocation.object, null, 2)}\n`;
  text = setPortal(text, door.portal);
  text = setLock(text, previous?.lock === true);
  const final = readManifest(text);
  if (final.manifest === undefined || final.errors.length > 0) {
    throw new Stop("invalid-manifest", `sitesolide.json is refused once the machine's portal and lock are applied: ${final.errors.join("; ")}`);
  }
  const conflicts = portConflicts(final.manifest, deposited);
  if (conflicts.length > 0) throw new Stop("port-taken", `${conflicts.join("; ")}: pick a free port between 3000 and 3099, or leave the port out and the machine chooses one`);
  return { text, manifest: final.manifest, portal: door.portal, allocated: allocation.allocated, doorConfirmed: onMachine.kind === "present" };
}

/**
 * Is the file in service one the deployment may replace? Absent, identical, or
 * exactly what the previous deposited manifest generates; anything else was
 * edited by hand on the machine.
 */
export function replaceable(inService: string | null, generated: string, previous: string | null): boolean {
  if (inService === null || inService.trim() === "") return true;
  if (sameDirectives(inService, generated)) return true;
  return previous !== null && sameDirectives(inService, previous);
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
  const created: Created = { account: false, tree: false, units: [] };
  // Set once Caddy or the served trees may have changed: from there on, a
  // stop keeps what this run created, see undoCreation.
  let served = false;
  let succeeded = false;
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
    const final = finalManifest(request, deposited);
    allocated = final.allocated;
    const { manifest, text } = final;
    const previous = previousManifest(deposited.get(slug));
    const application = isApp(manifest);
    const behindPortal = final.portal;
    for (const { service, port } of allocated) host.log(`   port ${port} chosen for ${service === null ? "the service" : `service ${service}`}`);
    host.log(`   project ${slug}, ${application ? `${servicesOf(manifest).length > 1 ? `${servicesOf(manifest).length} services` : "service"}` : "static"}, ${behindPortal ? "behind the portal" : "public"}`);

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
        if (facts === null) throw new Stop("machine-unreadable", `cannot tell whether systemd already runs a service named ${unit}: nothing was changed`);
        const foreign = foreignUnit(unit, slug, facts, host.unitsFolder);
        if (foreign !== null) throw new Stop("system-unit", `${foreign}: ${slug} is the name of a service of the machine, which a deployment never replaces; nothing was changed, pick another slug`);
      }
    }
    if (hasServices(manifest)) {
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
        const replace = replaceable(installed, generated, before);
        decisions.push({ unit, generated, installed, absent: onDisk === null, action: decideUnit({ installed, generated, replace }) });
      }
      // As `deploy` does: a unit edited by hand stays, and says so; the main
      // one of a project with several services stops everything, since it is
      // what starts the others at boot.
      const [main] = decisions;
      if (main !== undefined && main.action === "diverged" && decisions.length > 1) {
        throw handEdited(`/etc/systemd/system/${main.unit}.service`, main.installed, main.generated);
      }
      let changed = false;
      for (const decision of decisions) {
        if (decision.action === "present") {
          host.log(`   unchanged  ${decision.unit}.service`);
          continue;
        }
        if (decision.action === "diverged") {
          host.log(`   differs    ${decision.unit}.service, edited by hand on the machine: left as it is, so a changed port, memory or env has no effect until the owner deploys with --force`);
          continue;
        }
        await host.installUnit(decision.unit, decision.generated);
        if (decision.absent) created.units.push(decision.unit);
        host.log(`   installed  ${decision.unit}.service`);
        changed = true;
      }
      const stale = staleUnits(manifest, await host.generatedUnits(slug));
      if (stale.length > 0) {
        await host.removeUnits(stale);
        for (const unit of stale) host.log(`   removed    ${unit}.service, no longer declared`);
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
        underLock = door.kind === "read" ? { kind: "present", portal: door.portal } : door;
      }
    } catch (error) {
      underLock = { kind: "unreadable", reason: (error as Error).message };
    }
    const agreement = confirmDoorUnderLock(slug, behindPortal, underLock);
    if (agreement.kind === "rejects") throw new Stop("access-changed", `${agreement.message}; nothing served was changed`);
    // The ports again, under the lock every deposit takes: two deployments
    // running side by side chose theirs from the same reading, and the first
    // to get here has deposited its own since.
    const collisions = current === null ? [] : portConflicts(manifest, current);
    if (collisions.length > 0) {
      throw new Stop("port-taken", `${collisions.join("; ")}, since this deployment started: nothing served was changed, deploy again`);
    }
    // The first change anybody may see: a protected site's block, or the
    // trees. A Caddy step that fails restores the block, but one whose
    // restore failed leaves it to the owner, and this run cannot tell them
    // apart from here: everything stays from this point on.
    served = true;

    if (block !== null && behindPortal) {
      host.log("-> Caddy block, before the files: the restriction goes up first");
      const outcome = await installBlock(host.machine, { slug, zone, text: block, protected: true, runFolder: options.runFolder });
      if (!outcome.ok) throw new Stop("caddy-refused", outcome.message);
      host.log(`   ${outcome.detail}`);
    }

    // --- 7. the files ------------------------------------------------------------
    host.log(`-> ${parts.join(" and ")}, put in place`);
    await host.place(slug, staging, parts);

    // --- 8. the manifest, the loopback's set ----------------------------------------
    host.log("-> manifest");
    await host.depositManifest(slug, text);
    if (application) await rebuildProjectPorts(host, hasServices(manifest));
    if (!application || behindPortal) unlock();

    // --- 9. secrets, restart ----------------------------------------------------------
    if (application) {
      const secrets = manifest.secrets ?? [];
      if (secrets.length > 0) {
        host.log("-> declared secrets");
        const missing: string[] = [];
        for (const name of secrets) {
          if (await host.secretPresent(name)) host.log(`   present  /etc/sitesolide/${name}`);
          else missing.push(name);
        }
        if (missing.length > 0) {
          throw new Stop(
            "secret-missing",
            `/etc/sitesolide/${missing.join(", /etc/sitesolide/")} missing: the owner of the machine creates it in the Secrets section of https://dashboard.${zone}/ for ${slug}, then deploy again; the files are in place, the service was not restarted`,
          );
        }
      }
      const names = units.map(({ unit }) => unitArgument(unit));
      host.log(units.length > 1 ? "-> services restart" : "-> service restart");
      const restarted = await host.restart(names);
      if (restarted.code !== 0) {
        throw new Stop("service-failed", `${names.join(", ")} did not come back active (${restarted.output.trim().split("\n").join(", ") || "no answer"}): read sitesolide logs`);
      }

      // --- 10. an open app's block, then the verification ---------------------------
      if (block !== null && !behindPortal) {
        host.log("-> Caddy block, through the validated path");
        const outcome = await installBlock(host.machine, { slug, zone, text: block, protected: false, runFolder: options.runFolder });
        if (!outcome.ok) throw new Stop("caddy-refused", outcome.message);
        host.log(`   ${outcome.detail}`);
      }
    }
    unlock();

    host.log("-> verify");
    const url = `https://${slug}.${zone}/`;
    const answer = await host.machine.probe(`${slug}.${zone}`, "/", TIMEOUTS.probeConfig);
    if (behindPortal) {
      if (!fromPortal(answer)) throw new Stop("verify-failed", `${url} should answer the portal's 401, got ${describe(answer)}: the site is declared behind the portal and is not; tell the owner of the machine now`);
      host.log(`   ${url} 401, behind the portal: unknown visitors get the sign-in page`);
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
    succeeded = true;
    return { ok: true, url, allocated };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, code: error.code, message: error.message, allocated };
    const name = (error as { code?: unknown } | null)?.code ?? (error as Error).name;
    return { ok: false, code: "failure", message: `unexpected error on the machine (${String(name)}): the owner must read journalctl -u sitesolide-installer@${slug}`, allocated };
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

/** What this run created on the machine, as opposed to what it found there. */
type Created = { account: boolean; tree: boolean; units: string[] };

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
 */
async function undoCreation(host: Host, slug: string, created: Created): Promise<void> {
  if (!created.tree) return;
  host.log("-> nothing was served: what this deployment created is removed");
  try {
    if (created.units.length > 0) {
      await host.removeUnits(created.units);
      for (const unit of created.units) host.log(`   removed    ${unit}.service`);
    }
    if (!(await host.removeTree(slug))) {
      host.log(`   !! /srv/sites/${slug} carries a manifest deposited in the meantime: left as it is${created.account ? `, and site-${slug} with it` : ""}`);
      return;
    }
    host.log(`   removed    /srv/sites/${slug}`);
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
 * `rebuildProjectPorts` of bin/sitesolide.ts does: strict for a project with
 * several services, which depends on it; following otherwise, so that a
 * project that no longer declares several drops out of it.
 */
async function rebuildProjectPorts(host: Host, strict: boolean): Promise<void> {
  const fail = (message: string): void => {
    if (strict) throw new Stop("loopback-failed", `${message}: the project's services could not reach each other`);
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
    if (manifest === undefined || !hasServices(manifest)) continue;
    const ports = servicesOf(manifest).map((service) => service.port);
    if (manifest.slug !== folder || !ports.every((port) => Number.isInteger(port) && port >= 3000 && port <= 3099)) continue;
    projects.push(manifest);
  }
  const slugs = projects.map((manifest) => manifest.slug);
  let uids = new Map<string, number>();
  if (slugs.length > 0) {
    const read = await host.loopback.uids(slugs);
    if (read === null) return fail("cannot read the system users of the projects with several services");
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
  host.log(`   ${slugs.length === 0 ? "no project" : slugs.join(", ")} with several services`);
}
