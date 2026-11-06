/**
 * A project renamed on the machine: everything its slug names moved to the
 * new one, in one run under the Caddy lock, put back at the first failure.
 *
 *   systemctl start sitesolide-rename@nis2.service
 *   cat /run/sitesolide-installer/rename-nis2.json
 *
 * The steward asks for it, from the dashboard or from `sitesolide rename`
 * over the owner's SSH, after writing the request it reads; it re-keys its
 * own registries (who has access, the tokens' scopes) once this run says it
 * succeeded. bin/cli/rename.ts judges the new name.
 *
 * **What moves.** Over the run, in this order, each step undone in the
 * reverse order if a later one fails:
 *
 *   1. the project's units stopped and disabled, their files set aside;
 *   2. its account, `site-<slug>` and its group, renamed with `usermod -l`
 *      and `groupmod -n`: the uid stays, so every file it owns in `data/`
 *      and the loopback's `port . uid` pairs stay right without a walk;
 *   3. `/srv/sites/<slug>`, its store of secrets and the store's previous
 *      versions, the drop-ins of its units, moved by a rename each;
 *   4. the deposited manifest under the new slug, the old one added to its
 *      `formerSlugs`, which `deploy` follows from an old checkout;
 *   5. the units generated again from it, laid, enabled;
 *   6. its Caddy block generated again, the old one removed, the domain
 *      table written again when it has its own domain, then Caddy
 *      validated and reloaded;
 *   7. the services started, then every site probed: the new address must
 *      answer as the old one did, and no other site may stop answering.
 *
 * Only the old address stops: `<old>.<zone>` answers what the zone's
 * wildcard answers for a name no folder carries. Its own domain, if any,
 * keeps answering throughout but for the seconds the service is down.
 *
 * **What does not move.** The data snapshots stay in the backup repository
 * under the old name, and the next backup run starts the new one's; the
 * journals keep the old name in what they said before. A site that opens with
 * a code is refused (bin/cli/rename.ts): its stanza, cookie and door page
 * are the gatekeeper's.
 *
 * **Interrupted.** The gatekeeper's backup of the old slug stays in
 * /run/sitesolide-gatekeeper for the whole run: killed in the middle, it
 * leaves that backup, and every change of a general access is refused until
 * the owner has looked, as after an interrupted gatekeeper.
 *
 * NEVER `caddy stop`, `caddy start` or `caddy reload`: see the Production
 * section of CLAUDE.md. Only `systemctl reload caddy` applies a configuration.
 */
import { generateFragment } from "../../borrowed/fragment";
import { isApp, isProtected, readManifest, setSlug, type Manifest } from "../../borrowed/manifest";
import { renameRefusal } from "../../borrowed/rename";
import { foreignUnit } from "../../borrowed/services";
import { generateUnits, runningUnits, systemUser, unitArgument, unitFileName, unitNames } from "../../borrowed/unit";
import { FIRST_CERTIFICATE_MS, readZoneNamesAnswer } from "../../borrowed/zone-names";
import type { Machine, ManifestRead } from "../gatekeeper/machine";
import { answers, describe, regressions, servedHosts, type ProbeResponse } from "../gatekeeper/probe";
import { TIMEOUTS, caddyExtract, errorMessage, probeAll, reloadRestored } from "../gatekeeper/transaction";
import { RENAME_PREFIX, REQUEST_MAX_AGE_MS, type RenameRequest } from "../control/protocol";
import { isValidSlug } from "../../borrowed/manifest";
import type { Execution } from "./host";

/** What a rename moves by a plain rename of a folder: the tree, the store, the store's previous versions. */
export type Place = "tree" | "store" | "previous";

export type RenameHost = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** One line of the run's log, which the steward hands back. Never a secret. */
  log: (line: string) => void;
  /** The gatekeeper's machine: Caddy's lock, the blocks, the manifests, validate, reload, probe. */
  machine: Machine;
  /** Where systemd reads the units this run lays, /etc/systemd/system. */
  unitsFolder: string;

  /** Every deposited manifest, by directory name. Throws when the listing cannot be read. */
  readManifests: () => Promise<Map<string, string>>;
  /** Does `site-<slug>` exist? */
  accountExists: (slug: string) => Promise<boolean>;
  /** `usermod -l` then `groupmod -n`, the uid and gid kept. */
  renameAccount: (from: string, to: string) => Promise<Execution>;
  /** Is there anything at this place for this slug, a link included? */
  exists: (place: Place, slug: string) => Promise<boolean>;
  /** One rename, never a copy: refuses when the destination exists. */
  move: (place: Place, from: string, to: string) => Promise<void>;
  /** The previous versions a removed project of that name left, dropped. */
  dropPrevious: (slug: string) => Promise<void>;

  /** Every unit file named after the slug, `<slug>.service` and `<slug>.*`, by unit as unitNames names them. */
  unitFiles: (slug: string) => Promise<string[]>;
  /** What systemd knows of a unit, see foreignUnit; null when systemctl did not answer. */
  unitFacts: (slug: string, unit: string) => Promise<import("../../borrowed/services").UnitFacts | null>;
  readUnit: (unit: string) => Promise<string | null>;
  installUnit: (unit: string, text: string) => Promise<void>;
  /** Unit files removed, nothing asked of systemd. */
  deleteUnits: (units: string[]) => Promise<void>;
  /** A unit's drop-in folder, `<unit>.service.d`, moved to another unit's name when there is one; whether there was. */
  moveDropIn: (from: string, to: string) => Promise<boolean>;
  systemctl: (arguments_: string[], timeoutMs: number) => Promise<Execution>;

  /** The deposited manifest written in place, its owner and mode kept. */
  writeManifest: (slug: string, text: string, read: ManifestRead) => Promise<void>;

  domainTable: {
    /** /etc/caddy/domaines.map, null when missing. */
    read: () => Promise<string | null>;
    /** The table api/ generates from the manifests on the machine now, without `without`'s names when given. */
    build: (without?: string) => Promise<string>;
    /** Written atomically, root 0644; null removes it. */
    write: (text: string | null) => Promise<void>;
  };
  /** The zone's sites for the ask endpoint, see src/installer/pipeline.ts. */
  refreshZoneNames: () => Promise<Execution>;

  /** A place removed whole, links inside removed and never followed: a removal. */
  removePlace: (place: Place, slug: string) => Promise<void>;
  /** A unit's drop-in folder removed, when there is one. */
  removeDropIn: (unit: string) => Promise<void>;
  /** `userdel site-<slug>`, its group with it. */
  deleteAccount: (slug: string) => Promise<Execution>;
};

export type RenameOutcome = { ok: true; url: string } | { ok: false; code: string; message: string };

export class RenameStop extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The unit this run is started as, for a slug. */
export function renameUnit(slug: string): string {
  return `${RENAME_PREFIX}@${slug}.service`;
}

/** `argv` as the unit passes it, `installer.js --rename %n`: the current slug. */
export function readRenameLaunch(argv: readonly string[]): { ok: true; slug: string } | { ok: false; reason: string } {
  if (argv.length !== 2 || argv[0] !== "--rename") return { ok: false, reason: "expected --rename and the unit name (%n)" };
  const found = new RegExp(`^${RENAME_PREFIX}@([^@/]+)\\.service$`).exec(argv[1]!);
  if (found === null) return { ok: false, reason: `unexpected unit name, expected ${RENAME_PREFIX}@<slug>.service` };
  if (!isValidSlug(found[1]!)) return { ok: false, reason: "invalid slug in the unit name" };
  return { ok: true, slug: found[1]! };
}

/**
 * The steward's request for this unit's slug, fresh: one for another slug,
 * stale or malformed is refused, so that a restart by hand or a reboot never
 * replays a rename nobody asked for.
 */
export function readRenameRequest(text: string | null, slug: string, now: number): { ok: true; request: RenameRequest } | { ok: false; reason: string } {
  if (text === null) return { ok: false, reason: "no request from the steward for this project" };
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the steward's request is not JSON" };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return { ok: false, reason: "the steward's request is not an object" };
  const { to, requestedAt, actor } = object as Record<string, unknown>;
  if ((object as Record<string, unknown>).slug !== slug) return { ok: false, reason: "the steward's request names another project" };
  if (typeof to !== "string" || !isValidSlug(to)) return { ok: false, reason: "the steward's request names no new slug" };
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return { ok: false, reason: "the steward's request has no date" };
  if (now - requestedAt > REQUEST_MAX_AGE_MS || requestedAt - now > 60_000) return { ok: false, reason: "the steward's request is stale: it is replayed, not asked for" };
  if (typeof actor !== "string" || actor === "" || actor.length > 320) return { ok: false, reason: "the steward's request names nobody" };
  return { ok: true, request: { slug, to, requestedAt, actor } };
}

/** The units of a project, the old name's and the new one's, side by side: the same services, renamed. */
function pairedUnits(before: Manifest, after: Manifest): { from: string; to: string }[] {
  const old = unitNames(before);
  const renamed = unitNames(after);
  return old.map((unit, i) => ({ from: unit, to: renamed[i]! }));
}

/** One step's way back, run in the reverse order of the steps. */
type Undo = { what: string; run: () => Promise<void> };

/**
 * The new address answers as the old one did before, and no other site
 * stopped answering. Asked again up to the probes' delay, or a first
 * certificate's when the zone is certified on demand and the new address
 * does not answer at all yet. Null when it holds, else what is wrong.
 */
async function judgeAfter(host: RenameHost, oldHost: string, newHost: string, before: Map<string, ProbeResponse>, onDemand: boolean): Promise<string | null> {
  const expected = before.get(oldHost);
  const started = host.now();
  const others = [...before].filter(([name, response]) => name !== oldHost && answers(response)).map(([name]) => name);
  for (;;) {
    const seen = await probeAll(host.machine, [newHost, ...others]);
    const got = seen.get(newHost)!;
    let problem: string | null = null;
    if (expected !== undefined && "code" in expected) {
      if (!("code" in got) || got.code !== expected.code || got.door !== expected.door) {
        problem = `${newHost} answers ${describe(got)}, where ${oldHost} answered ${describe(expected)}`;
      }
    }
    const lost = regressions(before, seen, [oldHost, newHost]);
    if (problem === null && lost.length === 0) return null;
    const issuing = onDemand && lost.length === 0 && "error" in got;
    const limit = started + (issuing ? FIRST_CERTIFICATE_MS : TIMEOUTS.probes * 3);
    if (host.now() + TIMEOUTS.pause >= limit) {
      const reasons = problem === null ? [] : [problem];
      if (lost.length > 0) reasons.push(`no longer answering: ${lost.slice(0, 3).map((name) => `${name} ${describe(seen.get(name) ?? { error: "not probed" })}`).join(", ")}`);
      return reasons.join("; ");
    }
    await host.wait(TIMEOUTS.pause);
  }
}

export async function runRename(host: RenameHost, request: RenameRequest, options: { zone: string }): Promise<RenameOutcome> {
  const { slug: from, to } = request;
  const { zone } = options;
  const undos: Undo[] = [];
  let release: (() => void) | null = null;
  let backedUp = false;
  let reloadAttempted = false;

  const check = (deposited: Map<string, string>): void => {
    const refusal = renameRefusal(from, to, deposited, zone);
    if (refusal !== null) throw new RenameStop("refused", `${refusal}: nothing was changed`);
  };

  try {
    // --- what the machine carries, before anything is written -----------------
    host.log(`-> ${from} renamed ${to}, for ${request.actor}`);
    let deposited = await host.readManifests().catch((error: unknown) => {
      throw new RenameStop("machine-unreadable", `cannot read the manifests on the machine (${errorMessage(error)}): nothing was changed`);
    });
    check(deposited);

    host.log("-> Caddy lock, shared with the gatekeeper, the installer and the workstation");
    const taken = await host.machine.takeLock();
    if (taken.kind === "held") throw new RenameStop("caddy-busy", `Caddy is being changed by ${taken.who ?? "another action"}: nothing was changed, try again in a moment`);
    release = taken.release;
    // Read again under the lock: a deployment that ended meanwhile deposited its own.
    deposited = await host.readManifests();
    check(deposited);

    const read = await host.machine.readManifest(from);
    if (read === null) throw new RenameStop("refused", `the machine carries no manifest for ${from}: nothing was changed`);
    const before = readManifest(read.text).manifest!;
    const renamedText = setSlug(read.text, to);
    const parsed = readManifest(renamedText);
    if (parsed.manifest === undefined || parsed.errors.length > 0) {
      throw new RenameStop("invalid-manifest", `the manifest under ${to} would not read (${parsed.errors.join("; ")}): nothing was changed`);
    }
    const after = parsed.manifest;
    const application = isApp(before);

    // Nothing of the new name may be on the machine already.
    if (await host.accountExists(to)) throw new RenameStop("taken", `${systemUser(to)} already exists on the machine: nothing was changed, pick another name`);
    for (const place of ["tree", "store"] as const) {
      if (await host.exists(place, to)) {
        throw new RenameStop("taken", `${place === "tree" ? `/srv/sites/${to}` : `the store of secrets /etc/sitesolide/projects/${to}`} already exists: nothing was changed, pick another name`);
      }
    }
    const leftUnits = await host.unitFiles(to);
    if (leftUnits.length > 0) throw new RenameStop("taken", `${leftUnits.map(unitFileName).join(", ")} already in ${host.unitsFolder}: nothing was changed, pick another name`);
    if ((await host.machine.readBlock(to)) !== null) throw new RenameStop("taken", `/etc/caddy/sites/${to}.caddy already exists: nothing was changed, pick another name`);
    const pairs = pairedUnits(before, after);
    for (const { to: unit } of pairs) {
      const facts = await host.unitFacts(to, unit);
      if (facts === null) throw new RenameStop("machine-unreadable", `cannot tell whether systemd already runs a unit named ${unitFileName(unit)}: nothing was changed`);
      const foreign = foreignUnit(unit, to, facts, host.unitsFolder);
      if (foreign !== null) throw new RenameStop("system-unit", `${foreign}: ${to} is the name of a service of the machine; nothing was changed, pick another name`);
    }
    if ((await host.machine.interruptedTransaction()) !== null) {
      throw new RenameStop("caddy-unknown", "an interrupted change left Caddy in an unknown state on the machine: the owner must look at it; nothing was changed");
    }
    if (!(await host.machine.isCaddyActive(TIMEOUTS.active))) throw new RenameStop("caddy-inactive", "Caddy is not active: nothing was changed");
    const validation = await host.machine.validateCaddy(TIMEOUTS.validate);
    if (!validation.ok) throw new RenameStop("caddy-refused", `caddy validate refuses the configuration already in place: ${caddyExtract(validation.output)}; nothing was changed`);

    const oldHost = `${from}.${zone}`;
    const newHost = `${to}.${zone}`;
    const hosts = servedHosts(zone, await host.machine.servedSites(TIMEOUTS.sites));
    if (!hosts.includes(oldHost)) hosts.push(oldHost);
    const answered = await probeAll(host.machine, hosts);
    const oldBlock = await host.machine.readBlock(from);
    // Kept for the whole run: interrupted, it says so to every later action.
    await host.machine.saveBackup(from, { manifest: read, block: oldBlock });
    backedUp = true;
    host.log(`   ${hosts.length} site(s) answer as before; ${oldHost} answers ${describe(answered.get(oldHost) ?? { error: "not probed" })}`);

    // --- 1. the units stopped, their files set aside --------------------------------
    const oldUnits = application ? await host.unitFiles(from) : [];
    const oldTexts = new Map<string, string>();
    for (const unit of oldUnits) {
      const text = await host.readUnit(unit);
      if (text !== null) oldTexts.set(unit, text);
    }
    if (oldUnits.length > 0) {
      host.log("-> services stopped");
      undos.push({
        what: `${from}'s services started again`,
        run: async () => {
          await host.systemctl(["daemon-reload"], 60_000);
          await host.systemctl(["enable", from], 60_000);
          const units = runningUnits(before).map(unitArgument);
          await host.systemctl(["reset-failed", ...units], 10_000);
          await host.systemctl(["restart", ...units], 120_000);
        },
      });
      const ordered = [...oldUnits.filter((unit) => unit.endsWith(".timer")), ...oldUnits.filter((unit) => !unit.endsWith(".timer"))];
      const stopped = await host.systemctl(["disable", "--now", ...ordered.map(unitArgument)], 120_000);
      if (stopped.code !== 0) throw new RenameStop("service-failed", `systemctl could not stop ${from} (${stopped.output.trim().split("\n").at(-1) ?? `exit ${stopped.code}`})`);
      undos.push({ what: `${from}'s unit files laid again`, run: async () => { for (const [unit, text] of oldTexts) await host.installUnit(unit, text); } });
      await host.deleteUnits(oldUnits);
      for (const { from: unit, to: renamed } of pairs) {
        if (await host.moveDropIn(unit, renamed)) {
          host.log(`   ${unitFileName(unit)}.d moved to ${unitFileName(renamed)}.d`);
          undos.push({ what: `${unitFileName(unit)}.d moved back`, run: async () => void (await host.moveDropIn(renamed, unit)) });
        }
      }
      await host.systemctl(["daemon-reload"], 60_000);
    }

    // --- 2. the account -------------------------------------------------------------
    if (await host.accountExists(from)) {
      host.log(`-> ${systemUser(from)} renamed ${systemUser(to)}, its uid kept`);
      const renamed = await host.renameAccount(from, to);
      if (renamed.code !== 0) throw new RenameStop("account-failed", `${systemUser(from)} could not be renamed (${renamed.output.trim().slice(0, 200) || `exit ${renamed.code}`})`);
      undos.push({
        what: `${systemUser(to)} renamed back`,
        run: async () => {
          const back = await host.renameAccount(to, from);
          if (back.code !== 0) throw new Error(`usermod: ${back.output.trim().slice(0, 200)}`);
        },
      });
    }

    // --- 3. the folders ----------------------------------------------------------------
    host.log("-> folders moved");
    if (await host.exists("previous", to)) await host.dropPrevious(to);
    for (const place of ["tree", "store", "previous"] as const) {
      if (!(await host.exists(place, from))) continue;
      await host.move(place, from, to);
      undos.push({ what: `${place} moved back`, run: () => host.move(place, to, from) });
      host.log(`   ${place === "tree" ? `/srv/sites/${from} -> /srv/sites/${to}` : place === "store" ? "the store of secrets" : "the store's previous versions"}`);
    }

    // --- 4. the manifest ------------------------------------------------------------------
    host.log(`-> manifest under ${to}, ${from} among its former names`);
    undos.push({ what: "manifest written back", run: () => host.writeManifest(to, read.text, read) });
    await host.writeManifest(to, renamedText, read);

    // --- 5. the units -----------------------------------------------------------------------
    if (application) {
      host.log("-> systemd units generated again");
      const units = generateUnits(after);
      undos.push({
        what: `${to}'s units removed`,
        run: async () => {
          await host.systemctl(["disable", ...units.map(({ unit }) => unitArgument(unit))], 60_000);
          await host.deleteUnits(units.map(({ unit }) => unit));
          await host.systemctl(["daemon-reload"], 60_000);
        },
      });
      for (const { unit, text } of units) {
        await host.installUnit(unit, text);
        host.log(`   installed  ${unitFileName(unit)}`);
      }
      const reloaded = await host.systemctl(["daemon-reload"], 60_000);
      if (reloaded.code !== 0) throw new RenameStop("service-failed", "systemctl daemon-reload failed");
      const enabled = await host.systemctl(["enable", to], 60_000);
      if (enabled.code !== 0) throw new RenameStop("service-failed", `systemctl enable ${to} failed`);
    }

    // --- 6. Caddy -------------------------------------------------------------------------------
    host.log("-> Caddy: the block, the domain table, validated and reloaded");
    // An app's block, or a protected static site's, as deploy writes them.
    const block = application || isProtected(after) ? generateFragment(after) : null;
    if (block !== null || oldBlock !== null) {
      undos.push({
        what: "Caddy blocks put back",
        run: async () => {
          await host.machine.removeBlock(to);
          if (oldBlock !== null) await host.machine.writeBlock(from, oldBlock);
        },
      });
      if (block !== null) await host.machine.writeBlock(to, block);
      if (oldBlock !== null) await host.machine.removeBlock(from);
      host.log(`   ${block === null ? "no block" : `/etc/caddy/sites/${to}.caddy`}${oldBlock !== null ? `, ${from}.caddy removed` : ""}`);
    }
    if (after.domain !== undefined) {
      const table = await host.domainTable.read();
      const next = await host.domainTable.build();
      if (next !== table) {
        undos.push({ what: "domain table written back", run: () => host.domainTable.write(table) });
        await host.domainTable.write(next);
        host.log(`   domain table: ${after.domain.name} -> ${to}`);
      }
    }
    const listed = await host.refreshZoneNames();
    const onDemand = listed.code === 0 && readZoneNamesAnswer(listed.output)?.onDemand === true;

    const validated = await host.machine.validateCaddy(TIMEOUTS.validate);
    if (!validated.ok) throw new RenameStop("caddy-refused", `caddy validate refuses the renamed configuration: ${caddyExtract(validated.output)}`);
    reloadAttempted = true;
    const reload = await host.machine.reloadCaddy(TIMEOUTS.reload);
    if (!reload.ok) throw new RenameStop("caddy-refused", `systemctl reload caddy failed: ${caddyExtract(reload.output)}`);
    if (!(await host.machine.isCaddyActive(TIMEOUTS.active))) throw new RenameStop("caddy-refused", "Caddy is no longer active after the reload");

    // --- 7. started, then probed ------------------------------------------------------------------
    if (application) {
      const units = runningUnits(after).map(unitArgument);
      host.log(units.length > 1 ? "-> services started" : "-> service started");
      const started = await host.systemctl(["restart", ...units], 120_000);
      const active = started.code === 0 ? await host.systemctl(["is-active", ...units], 10_000) : started;
      if (active.code !== 0) throw new RenameStop("service-failed", `${units.join(", ")} did not come back active under the new name (${active.output.trim().split("\n").join(", ") || "no answer"})`);
    }
    host.log("-> verify");
    const problem = await judgeAfter(host, oldHost, newHost, answered, onDemand);
    if (problem !== null) throw new RenameStop("verify-failed", problem);
    const url = `https://${newHost}/`;
    host.log(`   ${url} answers as ${oldHost} did, every other site still answers`);

    // Done: nothing to put back any more.
    undos.length = 0;
    await host.machine.clearBackup(from).catch((error: unknown) => host.log(`   !! the gatekeeper's backup of ${from} was not removed (${errorMessage(error)}): the owner must remove it`));
    await host.machine.restartCollector(TIMEOUTS.collector).catch(() => undefined);
    return { ok: true, url };
  } catch (error) {
    const stop =
      error instanceof RenameStop
        ? error
        : new RenameStop("failure", `unexpected error on the machine (${errorMessage(error)}): the owner must read journalctl -u ${renameUnit(from)}`);
    if (undos.length === 0) {
      if (backedUp) await host.machine.clearBackup(from).catch(() => undefined);
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
    let restored: string | null = null;
    try {
      restored = await reloadRestored(host.machine, reloadAttempted);
    } catch (reloadError) {
      restored = errorMessage(reloadError);
    }
    if (restored !== null) failed.push(`Caddy: ${restored}`);
    if (failed.length > 0) {
      return {
        ok: false,
        code: "restore-failed",
        message: `${stop.message}; and putting ${from} back failed: ${failed.join("; ")}. The owner must look at the machine now: the gatekeeper's backup of ${from} stays in /run/sitesolide-gatekeeper`,
      };
    }
    await host.machine.clearBackup(from).catch(() => undefined);
    await host.machine.restartCollector(TIMEOUTS.collector).catch(() => undefined);
    return { ok: false, code: stop.code, message: `${stop.message}; ${from} is back as it was` };
  } finally {
    if (release !== null) release();
  }
}
