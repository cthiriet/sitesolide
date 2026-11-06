/**
 * A project turned off, turned on, or removed on the machine, in one run under
 * the Caddy lock: the owner's, from the dashboard or `sitesolide disable` and
 * `sitesolide enable`. bin/cli/lifecycle.ts says what each one keeps and what
 * each refuses.
 *
 *   systemctl start sitesolide-lifecycle@blog.service
 *   cat /run/sitesolide-installer/lifecycle-blog.json
 *
 * **Off**: its services stopped and disabled, its manifest marked `disabled`,
 * its block replaced by one that answers every address it has with a 503
 * (disabledFragment in bin/cli/fragment.ts), Caddy validated, reloaded, the
 * site probed for its 503 and every other site for its answer. Any failure
 * puts everything back.
 *
 * **On**: the manifest unmarked, its own block generated again as deploy
 * writes it, Caddy validated and reloaded, its services enabled and started,
 * the site probed for an answer and every other one too. Any failure puts it
 * back off.
 *
 * **Removed**: what can be undone first, its services stopped, its block
 * taken out, the domain table written again, Caddy reloaded and every other
 * site probed, put back on failure; then what cannot, its unit files, its
 * folder and data, its store and its previous versions, its account. The
 * steward then lets its people with access and its token go.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: see the Production
 * section of CLAUDE.md. Only `systemctl reload caddy` applies a configuration.
 */
import { disabledFragment, generateFragment } from "../../borrowed/fragment";
import { lifecycleRefusal, type Lifecycle } from "../../borrowed/lifecycle";
import { isApp, isProtected, isValidSlug, readManifest, setDisabled, type Manifest } from "../../borrowed/manifest";
import { readZoneNamesAnswer } from "../../borrowed/zone-names";
import { runningUnits, systemUser, unitArgument } from "../../borrowed/unit";
import { describe, regressions, servedHosts, fromPortal, type ProbeResponse } from "../gatekeeper/probe";
import { TIMEOUTS, caddyExtract, errorMessage, probeAll, reloadRestored } from "../gatekeeper/transaction";
import { LIFECYCLE_PREFIX, REQUEST_MAX_AGE_MS, type LifecycleRequest } from "../control/protocol";
import { RenameStop as Stop, type RenameHost } from "./rename";
import { domainHosts } from "../../borrowed/manifest";

export type LifecycleOutcome = { ok: true } | { ok: false; code: string; message: string };

export function lifecycleUnit(slug: string): string {
  return `${LIFECYCLE_PREFIX}@${slug}.service`;
}

/** `argv` as the unit passes it, `installer.js --lifecycle %n`. */
export function readLifecycleLaunch(argv: readonly string[]): { ok: true; slug: string } | { ok: false; reason: string } {
  if (argv.length !== 2 || argv[0] !== "--lifecycle") return { ok: false, reason: "expected --lifecycle and the unit name (%n)" };
  const found = new RegExp(`^${LIFECYCLE_PREFIX}@([^@/]+)\\.service$`).exec(argv[1]!);
  if (found === null) return { ok: false, reason: `unexpected unit name, expected ${LIFECYCLE_PREFIX}@<slug>.service` };
  if (!isValidSlug(found[1]!)) return { ok: false, reason: "invalid slug in the unit name" };
  return { ok: true, slug: found[1]! };
}

/** The steward's request for this slug, fresh, as for a rename. */
export function readLifecycleRequest(text: string | null, slug: string, now: number): { ok: true; request: LifecycleRequest } | { ok: false; reason: string } {
  if (text === null) return { ok: false, reason: "no request from the steward for this project" };
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the steward's request is not JSON" };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return { ok: false, reason: "the steward's request is not an object" };
  const { action, requestedAt, actor } = object as Record<string, unknown>;
  if ((object as Record<string, unknown>).slug !== slug) return { ok: false, reason: "the steward's request names another project" };
  if (action !== "disable" && action !== "enable" && action !== "remove") return { ok: false, reason: "the steward's request names no action" };
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return { ok: false, reason: "the steward's request has no date" };
  if (now - requestedAt > REQUEST_MAX_AGE_MS || requestedAt - now > 60_000) return { ok: false, reason: "the steward's request is stale: it is replayed, not asked for" };
  if (typeof actor !== "string" || actor === "" || actor.length > 320) return { ok: false, reason: "the steward's request names nobody" };
  return { ok: true, request: { slug, action, requestedAt, actor } };
}

type Undo = { what: string; run: () => Promise<void> };

/** The project's own addresses: its preview, and its domain's names when switched on. */
function ownHosts(manifest: Manifest, zone: string): string[] {
  const domain = manifest.domain;
  return [`${manifest.slug}.${zone}`, ...(domain !== undefined && domain.active === true ? domainHosts(domain) : [])];
}

/** What a site answers once on again: anything but a server error, its 404 or the 503 of a site off; the portal's 401 when restricted. */
function answersOn(manifest: Manifest, response: ProbeResponse): boolean {
  if (!("code" in response)) return false;
  if (isProtected(manifest)) return fromPortal(response) || (response.code >= 300 && response.code < 400);
  return response.code < 500 && response.code !== 404;
}

/**
 * The project's preview judged by `wanted`, and no other site lost, asked
 * again up to the probes' delay. Null when it holds, else what is wrong.
 */
async function judgeAfter(host: RenameHost, preview: string | null, wanted: (response: ProbeResponse) => boolean, expected: string, before: Map<string, ProbeResponse>, own: string[]): Promise<string | null> {
  const started = host.now();
  const others = [...before].filter(([name]) => !own.includes(name)).map(([name]) => name);
  for (;;) {
    const seen = await probeAll(host.machine, [...(preview === null ? [] : [preview]), ...others]);
    const got = preview === null ? null : seen.get(preview)!;
    const problem = got === null || wanted(got) ? null : `${preview} answers ${describe(got)}, where ${expected} was expected`;
    const lost = regressions(before, seen, own);
    if (problem === null && lost.length === 0) return null;
    if (host.now() + TIMEOUTS.pause >= started + TIMEOUTS.probes * 3) {
      const reasons = problem === null ? [] : [problem];
      if (lost.length > 0) reasons.push(`no longer answering: ${lost.slice(0, 3).map((name) => `${name} ${describe(seen.get(name) ?? { error: "not probed" })}`).join(", ")}`);
      return reasons.join("; ");
    }
    await host.wait(TIMEOUTS.pause);
  }
}

const VERB: Record<Lifecycle, string> = { disable: "turned off", enable: "turned on", remove: "removed" };

export async function runLifecycle(host: RenameHost, request: LifecycleRequest, options: { zone: string }): Promise<LifecycleOutcome> {
  const { slug, action } = request;
  const { zone } = options;
  const undos: Undo[] = [];
  let release: (() => void) | null = null;
  let backedUp = false;
  let reloadAttempted = false;
  const check = (deposited: Map<string, string>): void => {
    const refusal = lifecycleRefusal(action, slug, deposited, zone);
    if (refusal !== null) throw new Stop("refused", `${refusal}: nothing was changed`);
  };

  try {
    host.log(`-> ${slug} ${VERB[action]}, for ${request.actor}`);
    check(await host.readManifests());
    host.log("-> Caddy lock, shared with the gatekeeper, the installer and the workstation");
    const taken = await host.machine.takeLock();
    if (taken.kind === "held") throw new Stop("caddy-busy", `Caddy is being changed by ${taken.who ?? "another action"}: nothing was changed, try again in a moment`);
    release = taken.release;
    check(await host.readManifests());

    const read = (await host.machine.readManifest(slug))!;
    const manifest = readManifest(read.text).manifest!;
    const application = isApp(manifest);
    if ((await host.machine.interruptedTransaction()) !== null) {
      throw new Stop("caddy-unknown", "an interrupted change left Caddy in an unknown state on the machine: the owner must look at it; nothing was changed");
    }
    if (!(await host.machine.isCaddyActive(TIMEOUTS.active))) throw new Stop("caddy-inactive", "Caddy is not active: nothing was changed");
    const validation = await host.machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) throw new Stop("caddy-refused", `caddy validate refuses the configuration already in place: ${caddyExtract(validation.output)}; nothing was changed`);
    const preview = `${slug}.${zone}`;
    const own = ownHosts(manifest, zone);
    const hosts = servedHosts(zone, await host.machine.servedSites(TIMEOUTS.sites));
    for (const name of own) if (!hosts.includes(name)) hosts.push(name);
    const before = await probeAll(host.machine, hosts);
    const oldBlock = await host.machine.readBlock(slug);
    await host.machine.saveBackup(slug, { manifest: read, block: oldBlock });
    backedUp = true;
    const units = application ? await host.unitFiles(slug) : [];
    const ordered = [...units.filter((unit) => unit.endsWith(".timer")), ...units.filter((unit) => !unit.endsWith(".timer"))];
    const startAgain = async (of: Manifest) => {
      await host.systemctl(["daemon-reload"], 60_000);
      await host.systemctl(["enable", slug], 60_000);
      const running = runningUnits(of).map(unitArgument);
      await host.systemctl(["reset-failed", ...running], 10_000);
      await host.systemctl(["restart", ...running], 120_000);
    };
    const putBlock = async (block: string | null) => {
      if (block === null) await host.machine.removeBlock(slug);
      else await host.machine.writeBlock(slug, block);
    };
    const reload = async () => {
      const listed = await host.refreshZoneNames();
      void (listed.code === 0 ? readZoneNamesAnswer(listed.output) : null);
      const validated = await host.machine.validateCaddy(TIMEOUTS.validate);
      if (!validated.ok) throw new Stop("caddy-refused", `caddy validate refuses the new configuration: ${caddyExtract(validated.output)}`);
      reloadAttempted = true;
      const reloaded = await host.machine.reloadCaddy(TIMEOUTS.reload);
      if (!reloaded.ok) throw new Stop("caddy-refused", `systemctl reload caddy failed: ${caddyExtract(reloaded.output)}`);
      if (!(await host.machine.isCaddyActive(TIMEOUTS.active))) throw new Stop("caddy-refused", "Caddy is no longer active after the reload");
    };
    const stopUnits = async () => {
      if (ordered.length === 0) return;
      host.log(ordered.length > 1 ? "-> services stopped and disabled" : "-> service stopped and disabled");
      undos.push({ what: `${slug}'s services started again`, run: () => startAgain(manifest) });
      const stopped = await host.systemctl(["disable", "--now", ...ordered.map(unitArgument)], 120_000);
      if (stopped.code !== 0) throw new Stop("service-failed", `systemctl could not stop ${slug} (${stopped.output.trim().split("\n").at(-1) ?? `exit ${stopped.code}`})`);
    };

    if (action === "disable") {
      await stopUnits();
      host.log("-> manifest marked turned off, the block that says so in place of its own");
      const text = setDisabled(read.text, true);
      undos.push({ what: "manifest written back", run: () => host.writeManifest(slug, read.text, read) });
      await host.writeManifest(slug, text, read);
      undos.push({ what: "its own block put back", run: () => putBlock(oldBlock) });
      await putBlock(disabledFragment(readManifest(text).manifest!));
      await reload();
      host.log("-> verify");
      const problem = await judgeAfter(host, preview, (response) => "code" in response && response.code === 503, "the 503 of a site turned off", before, own);
      if (problem !== null) throw new Stop("verify-failed", problem);
      host.log(`   ${preview} answers that it is off, every other site still answers`);
    } else if (action === "enable") {
      host.log("-> manifest unmarked, its own block generated again");
      const text = setDisabled(read.text, false);
      const on = readManifest(text).manifest!;
      undos.push({ what: "manifest written back", run: () => host.writeManifest(slug, read.text, read) });
      await host.writeManifest(slug, text, read);
      undos.push({ what: "the block of a site turned off put back", run: () => putBlock(oldBlock) });
      await putBlock(application || isProtected(on) ? generateFragment(on) : null);
      await reload();
      if (application) {
        host.log("-> services enabled and started");
        undos.push({ what: `${slug}'s services stopped again`, run: async () => void (await host.systemctl(["disable", "--now", ...ordered.map(unitArgument)], 120_000)) });
        await startAgain(on);
        const running = runningUnits(on).map(unitArgument);
        const active = await host.systemctl(["is-active", ...running], 10_000);
        if (active.code !== 0) throw new Stop("service-failed", `${running.join(", ")} did not come back active (${active.output.trim().split("\n").join(", ") || "no answer"}): read sitesolide logs`);
      }
      host.log("-> verify");
      const problem = await judgeAfter(host, preview, (response) => answersOn(on, response), isProtected(on) ? "the portal's 401" : "an answer of the site", before, own);
      if (problem !== null) throw new Stop("verify-failed", problem);
      host.log(`   ${preview} answers again, every other site still answers`);
    } else {
      // What can be undone first: nothing is deleted before Caddy holds.
      await stopUnits();
      host.log("-> its block taken out, the domain table written again");
      if (oldBlock !== null) {
        undos.push({ what: "its block put back", run: () => putBlock(oldBlock) });
        await putBlock(null);
      }
      if (manifest.domain !== undefined) {
        const table = await host.domainTable.read();
        // Built as if its folder were gone already: its names drop out.
        const next = await host.domainTable.build(slug);
        if (next !== table) {
          undos.push({ what: "domain table written back", run: () => host.domainTable.write(table) });
          await host.domainTable.write(next);
        }
      }
      await reload();
      host.log("-> verify the other sites");
      const problem = await judgeAfter(host, null, () => true, "", before, own);
      if (problem !== null) throw new Stop("verify-failed", problem);
      // From here on, nothing is put back: what fails is said, and the rest goes on.
      undos.length = 0;
      host.log("-> unit files, folder and data, store of secrets, account");
      const failures: string[] = [];
      const attempt = async (what: string, run: () => Promise<void>) => {
        try {
          await run();
          host.log(`   removed    ${what}`);
        } catch (error) {
          failures.push(`${what} (${errorMessage(error)})`);
        }
      };
      if (units.length > 0) {
        await attempt(`${units.length} unit file(s)`, async () => {
          await host.deleteUnits(units);
          for (const unit of units) await host.removeDropIn(unit);
          await host.systemctl(["daemon-reload"], 60_000);
          await host.systemctl(["reset-failed", ...ordered.map(unitArgument)], 60_000);
        });
      }
      await attempt(`/srv/sites/${slug}`, () => host.removePlace("tree", slug));
      await attempt("its store of secrets", () => host.removePlace("store", slug));
      await attempt("the store's previous versions", () => host.removePlace("previous", slug));
      if (await host.accountExists(slug)) {
        await attempt(systemUser(slug), async () => {
          const removed = await host.deleteAccount(slug);
          if (removed.code !== 0) throw new Error(removed.output.trim().slice(0, 200) || `exit ${removed.code}`);
        });
      }
      await host.refreshZoneNames().catch(() => undefined);
      if (failures.length > 0) {
        await host.machine.clearBackup(slug).catch(() => undefined);
        return { ok: false, code: "removal-incomplete", message: `${slug} no longer answers, but some of it is left on the machine: ${failures.join("; ")}. The owner must remove it by hand` };
      }
    }

    undos.length = 0;
    await host.machine.clearBackup(slug).catch((error: unknown) => host.log(`   !! the gatekeeper's backup of ${slug} was not removed (${errorMessage(error)}): the owner must remove it`));
    await host.machine.restartCollector(TIMEOUTS.collector).catch(() => undefined);
    return { ok: true };
  } catch (error) {
    const stop = error instanceof Stop ? error : new Stop("failure", `unexpected error on the machine (${errorMessage(error)}): the owner must read journalctl -u ${lifecycleUnit(slug)}`);
    if (undos.length === 0) {
      if (backedUp) await host.machine.clearBackup(slug).catch(() => undefined);
      return { ok: false, code: stop.code, message: stop.message };
    }
    host.log(`!! ${stop.message}: everything is put back`);
    const failed: string[] = [];
    for (const undo of undos.reverse()) {
      try {
        await undo.run();
      } catch (undoError) {
        failed.push(`${undo.what} (${errorMessage(undoError)})`);
      }
    }
    await host.refreshZoneNames().catch(() => undefined);
    let restored: string | null;
    try {
      restored = await reloadRestored(host.machine, reloadAttempted);
    } catch (reloadError) {
      restored = errorMessage(reloadError);
    }
    if (restored !== null) failed.push(`Caddy: ${restored}`);
    if (failed.length > 0) {
      return { ok: false, code: "restore-failed", message: `${stop.message}; and putting ${slug} back failed: ${failed.join("; ")}. The owner must look at the machine now: the gatekeeper's backup of ${slug} stays in /run/sitesolide-gatekeeper` };
    }
    await host.machine.clearBackup(slug).catch(() => undefined);
    await host.machine.restartCollector(TIMEOUTS.collector).catch(() => undefined);
    return { ok: false, code: stop.code, message: `${stop.message}; ${slug} is back as it was` };
  } finally {
    if (release !== null) release();
  }
}
