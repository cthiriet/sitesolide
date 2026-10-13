/**
 * What `deploy` and `remove` decide about a project's services beyond the unit
 * and the block: ports taken by another project, units the manifest no longer
 * declares, and the reads on the machine these decisions rest on.
 *
 * Pure, like the rest of bin/cli/: the commands are returned as strings and
 * their answers parsed here, bin/sitesolide.ts runs them. Every read ends with
 * a marker, for the reason given in unit.ts: an empty output is a failed read,
 * never an answer.
 */
import { domainHosts, isValidSchedule, isValidSlug, PORTAL_SLUG, readManifest, servicesOf, type Manifest } from "./manifest";
import { PORTAL_PORT } from "./portal";
import { LOOPBACK_TABLE, PROJECT_PORTS_FILE, PROJECT_PORTS_SET } from "./loopback";
import { isTimerUnit, systemUser, unitArgument, unitFileName, unitNames } from "./unit";

export const MARKER_DONE = "DONE";

/**
 * The ports no manifest declares, taken all the same: the landing's and the
 * shared service's, whose units are laid by their own scripts.
 */
export const RESERVED_PORTS: ReadonlyMap<number, string> = new Map([
  [3000, "the landing"],
  [3001, "the shared service (api/)"],
]);

/**
 * The platform's services that sitesolide deploys like any project, by the
 * port their manifest declares, and the slug that deploys there:
 * `bin/tests/cli-ports.test.ts` reads the three manifests and fails if one of
 * them moves without this table.
 *
 * Reserved whether they are deployed or not, for every other project: a
 * project on the portal's port would refuse the portal's first deployment,
 * and the dashboard, which the loopback rule lets through to the portal's
 * port, would reach it.
 */
export const PLATFORM_PORTS: ReadonlyMap<number, string> = new Map([
  [3022, "dashboard"],
  [PORTAL_PORT, PORTAL_SLUG],
  [3029, "analytics"],
]);

/** The ports no project may declare, by owner, `slug` aside: the platform's own exempt for their own port. */
export function reservedPorts(slug: string): Map<number, string> {
  const reserved = new Map<number, string>(RESERVED_PORTS);
  for (const [port, owner] of PLATFORM_PORTS) if (owner !== slug) reserved.set(port, `the platform's ${owner}, deployed or not`);
  return reserved;
}

/**
 * The ports of `manifest` another project already declares on the machine, or
 * that the landing, the shared service or a platform service holds.
 *
 * Measured against the manifests deposited there rather than a list kept on the
 * workstation, which would lie from the first deployment made from somewhere
 * else. A clash is worse than a service that fails to start: the second
 * project could bind first after a reboot, and Caddy would send the first
 * one's visitors to it.
 *
 * A deposited manifest that no longer reads is skipped: this check is not
 * where it gets repaired, and its ports are unknown anyway.
 */
export function portConflicts(manifest: Manifest, deposited: ReadonlyMap<string, string>): string[] {
  const taken = reservedPorts(manifest.slug);
  for (const [slug, raw] of deposited) {
    if (slug === manifest.slug) continue;
    const { manifest: other } = readManifest(raw);
    if (other === undefined) continue;
    for (const service of servicesOf(other)) {
      if (typeof service.port === "number") taken.set(service.port, `project ${slug}`);
    }
  }
  const conflicts: string[] = [];
  for (const service of servicesOf(manifest)) {
    if (service.port === null) continue;
    const owner = taken.get(service.port);
    if (owner !== undefined) {
      const who = service.name === null ? "" : ` (service ${service.name})`;
      conflicts.push(`port ${service.port}${who} is already declared by ${owner}`);
    }
  }
  return conflicts;
}

/**
 * The names of `manifest`'s domain another project already declares on the
 * machine, active or not.
 *
 * An app's fragment claims every name of its domain in a block of its own,
 * and a block that names a host beats the nameless one of the static sites'
 * domains: an app declaring a static site's domain, or its alias, would take
 * that site's visitors as soon as the table certifies the name for its owner.
 * Two apps declaring the same name would fail Caddy's validation for every
 * site. Measured against the deposited manifests, like the ports.
 */
export function domainConflicts(manifest: Manifest, deposited: ReadonlyMap<string, string>): string[] {
  if (manifest.domain === undefined) return [];
  const mine = domainHosts(manifest.domain);
  const conflicts: string[] = [];
  for (const [slug, raw] of deposited) {
    if (slug === manifest.slug) continue;
    const { manifest: other } = readManifest(raw);
    if (other?.domain === undefined || typeof other.domain.name !== "string") continue;
    const theirs = new Set(domainHosts(other.domain));
    for (const name of mine) if (theirs.has(name)) conflicts.push(`${name} is already declared by project ${slug}`);
  }
  return conflicts;
}

/** Where systemd reads a unit laid by `deploy`, a service or a timer, see unitFileName. */
export function unitPath(unit: string): string {
  return `/etc/systemd/system/${unitFileName(unit)}`;
}

/**
 * Lists the project's secondary units on the machine, `<slug>.<name>`, and
 * only those `deploy` wrote. The dot right after the slug keeps the pattern off
 * another project's units, no slug carrying one, but not off units nobody
 * generated: a helper written by hand next to a project, or a system unit whose
 * name happens to start the same way, `dbus-org.freedesktop.timesync1`. The
 * file must therefore carry the generator's header and hang on the project's
 * main unit, which only a generated secondary does.
 *
 * The timers of scheduled services are listed too, by their name with its
 * `.timer`, as unitFileName writes it: a schedule dropped from the manifest
 * must take its timer with it, or it would go on starting a service that no
 * longer exists, or one that now runs for good.
 */
export function listUnitsCommand(slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  return (
    `sudo sh -c 'for f in /etc/systemd/system/${slug}.*.service /etc/systemd/system/${slug}.*.timer; do [ -e "$f" ] || continue; ` +
    `grep -qx "PartOf=${slug}.service" "$f" && grep -q "generated by bin/sitesolide.ts" "$f" || continue; ` +
    `basename "$f" .service; done; echo ${MARKER_DONE}'`
  );
}

/** The line every unit file `deploy` writes carries, see unit.ts. */
export const GENERATOR_MARK = "generated by bin/sitesolide.ts";

/**
 * Asks systemd what it already knows of each unit a deployment is about to
 * lay, before anything is written: its load state, the file it reads it from,
 * and whether that file carries the generator's mark or serves this project's
 * folder.
 *
 * Reading `/etc/systemd/system/<unit>.service` alone, as decideUnit does, is
 * blind to the units of the system's packages, which live in
 * /lib/systemd/system: a project called like one of them would see no file,
 * lay its own in /etc, and replace the system's service, which systemd reads
 * from /etc first. validate() refuses the names it knows (isSystemName in
 * manifest.ts); this read catches the others, and an alias in /etc pointing at
 * a vendor unit with them, since systemd names the file it really reads.
 *
 * One line per unit, `UNIT <unit> <load state> <mark> <project> <file>`, then
 * the end marker.
 */
export function unitOriginsCommand(slug: string, units: string[]): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  for (const unit of units) {
    if (unit !== slug && !(unit.startsWith(`${slug}.`) && /^[a-z0-9.-]+$/.test(unit))) throw new Error(`invalid unit: ${unit}`);
  }
  // A timer is asked for by its own name, a service with `.service` added.
  return (
    `sudo sh -c 'for u in ${units.join(" ")}; do ` +
    `case "$u" in *.timer) n="$u";; *) n="$u.service";; esac; ` +
    `s=$(systemctl show -p LoadState --value "$n" 2>/dev/null); ` +
    `f=$(systemctl show -p FragmentPath --value "$n" 2>/dev/null); ` +
    `g=no; p=no; if [ -n "$f" ] && [ -f "$f" ]; then ` +
    `grep -q "${GENERATOR_MARK}" "$f" && g=yes; grep -q "/srv/sites/${slug}/" "$f" && p=yes; fi; ` +
    `echo "UNIT $u \${s:-unknown} $g $p \${f:--}"; done; echo ${MARKER_DONE}'`
  );
}

/** What systemd knows of one unit, however it was read: over SSH, or by the installer on the machine. */
export type UnitFacts = {
  /** `loaded`, `not-found`, `masked`...: systemctl's LoadState. */
  loadState: string;
  /** The file systemd reads the unit from, "" for none. */
  fragmentPath: string;
  /** The file carries the generator's mark. */
  generated: boolean;
  /** The file names this project's folder, `/srv/sites/<slug>/`. */
  project: boolean;
};

export type UnitOriginsRead = { kind: "read"; facts: Map<string, UnitFacts> } | { kind: "unreadable" };

/** The answer to unitOriginsCommand: every unit asked for, once, or unreadable. */
export function readUnitOrigins(output: string, units: string[]): UnitOriginsRead {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.at(-1) !== MARKER_DONE || lines.length !== units.length + 1) return { kind: "unreadable" };
  const facts = new Map<string, UnitFacts>();
  for (const line of lines.slice(0, -1)) {
    const match = /^UNIT ([a-z0-9.-]+) ([a-z-]+) (yes|no) (yes|no) (\S+)$/.exec(line);
    if (match === null || !units.includes(match[1]!) || facts.has(match[1]!) || match[2] === "unknown") return { kind: "unreadable" };
    facts.set(match[1]!, { loadState: match[2]!, fragmentPath: match[5] === "-" ? "" : match[5]!, generated: match[3] === "yes", project: match[4] === "yes" });
  }
  return { kind: "read", facts };
}

/**
 * Why a unit may not be laid, or null when it may: unknown to systemd, or read
 * from the very file deploy writes, which carries the generator's mark or
 * serves this project. A unit written by hand for the project stays this
 * project's, and decideUnit settles it as it always has, `--force` included.
 * Anything else is a service of the machine: a package's unit, an alias, a
 * masked name, a unit someone wrote in /etc for something other than this
 * project. `--force` does not reach those: no deployment replaces them.
 */
export function foreignUnit(unit: string, slug: string, facts: UnitFacts, unitsFolder = "/etc/systemd/system"): string | null {
  if (facts.loadState === "not-found" && facts.fragmentPath === "") return null;
  const own = `${unitsFolder}/${unitFileName(unit)}`;
  if (facts.fragmentPath === own && facts.loadState !== "masked" && (facts.generated || facts.project)) return null;
  if (facts.fragmentPath === own) {
    return `${own} is ${facts.loadState === "masked" ? "masked" : `a unit deploy did not write, for something other than /srv/sites/${slug}`}`;
  }
  return `${unitFileName(unit)} is already a ${isTimerUnit(unit) ? "timer" : "service"} of the machine, read from ${facts.fragmentPath === "" ? `nowhere (${facts.loadState})` : facts.fragmentPath}`;
}

export type UnitsRead = { kind: "read"; units: string[] } | { kind: "unreadable" };

export function readUnitsAnswer(output: string, slug: string): UnitsRead {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.at(-1) !== MARKER_DONE) return { kind: "unreadable" };
  const units = lines.slice(0, -1);
  if (!units.every((unit) => unit.startsWith(`${slug}.`) && /^[a-z0-9.-]+$/.test(unit))) {
    return { kind: "unreadable" };
  }
  return { kind: "read", units };
}

/** The secondary units in service that the manifest no longer declares, its timers included. */
export function staleUnits(manifest: Manifest, onMachine: string[]): string[] {
  const declared = new Set(unitNames(manifest));
  return onMachine.filter((unit) => !declared.has(unit));
}

/**
 * Stops and removes units, tolerating their absence like every removal
 * gesture. The timers first, so that none starts its service between the
 * service's stop and its removal. Then their failed state is cleared:
 * systemd keeps a failed unit in memory after its file is gone, and a
 * scheduled service is `failed` after a run that failed, its rest state
 * until the next; left, it would stay in `systemctl --failed` for good.
 */
export function removeUnitsCommand(units: string[]): string {
  const ordered = [...units.filter(isTimerUnit), ...units.filter((unit) => !isTimerUnit(unit))];
  const names = ordered.map(unitArgument).join(" ");
  return [
    `sudo systemctl disable --now ${names} 2>/dev/null || true`,
    `sudo rm -f ${ordered.map(unitPath).join(" ")}`,
    "sudo systemctl daemon-reload",
    `{ sudo systemctl reset-failed ${names} 2>/dev/null || true; }`,
  ].join(" && ");
}

/**
 * Where the loopback rule stands on the machine:
 *
 * - `none`: no rule at all, the services already reach each other;
 * - `table`: a rule laid before the project set existed, which would refuse
 *   the calls between the services of one project;
 * - `set`: the rule this deployment can fill.
 */
export function loopbackStateCommand(): string {
  return (
    `sudo sh -c 'if nft list table inet ${LOOPBACK_TABLE} >/dev/null 2>&1; then ` +
    `if nft list set inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET} >/dev/null 2>&1; then echo set; else echo table; fi; ` +
    `else echo none; fi; echo ${MARKER_DONE}'`
  );
}

export type LoopbackState = "none" | "table" | "set" | "unreadable";

export function readLoopbackState(output: string): LoopbackState {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 2 || lines[1] !== MARKER_DONE) return "unreadable";
  const state = lines[0];
  return state === "none" || state === "table" || state === "set" ? state : "unreadable";
}

/** Reads the uid of each project's system user, one `<slug> <uid>` line each. */
export function uidsCommand(slugs: string[]): string {
  for (const slug of slugs) if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  const reads = slugs.map((slug) => `echo "${slug} $(id -u ${systemUser(slug)} 2>/dev/null)";`).join(" ");
  return `sh -c '${reads} echo ${MARKER_DONE}'`;
}

export type UidsRead = { kind: "read"; uids: Map<string, number> } | { kind: "unreadable" };

/**
 * A user that does not exist gives an empty uid, and the whole read is refused
 * rather than that project left out: its ports would silently drop from the
 * set, and its services stop reaching each other at the next restart.
 */
export function readUidsAnswer(output: string, slugs: string[]): UidsRead {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.at(-1) !== MARKER_DONE || lines.length !== slugs.length + 1) return { kind: "unreadable" };
  const uids = new Map<string, number>();
  for (const line of lines.slice(0, -1)) {
    const match = /^([a-z0-9-]+) ([0-9]+)$/.exec(line);
    if (match === null || !slugs.includes(match[1]!)) return { kind: "unreadable" };
    uids.set(match[1]!, Number(match[2]));
  }
  return uids.size === slugs.length ? { kind: "read", uids } : { kind: "unreadable" };
}

/**
 * Writes the set's file on the machine and, when `apply`, loads it. The file
 * travels inside the command, a quoted heredoc, and lands beside the one in
 * service; that one is replaced only once the new one is checked and applied,
 * so that a refusal leaves the kernel and the boot replay agreeing.
 */
export function projectPortsCommand(content: string, apply: boolean): string {
  if (/['\\]|^EOF$/m.test(content)) throw new Error("unexpected character in the project set file");
  const staging = `${PROJECT_PORTS_FILE}.new`;
  const load = apply
    ? `nft -c -f ${staging} && nft -f ${staging} && mv ${staging} ${PROJECT_PORTS_FILE}`
    : `mv ${staging} ${PROJECT_PORTS_FILE}`;
  return [
    `sudo sh -c 'umask 022; cat > ${staging} <<"EOF"`,
    content.trimEnd(),
    "EOF",
    `${load} || { rm -f ${staging}; exit 1; }'`,
  ].join("\n");
}

/** The pairs the kernel carries in the set, ended by the marker. */
export function currentPairsCommand(): string {
  return `sudo sh -c 'nft list set inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET} && echo ${MARKER_DONE}'`;
}

/** The pairs listed, `<port> . <uid>`, or null when the listing failed. */
export function readCurrentPairs(output: string): string[] | null {
  if (!output.split("\n").some((line) => line.trim() === MARKER_DONE)) return null;
  return [...output.matchAll(/(\d+) \. (\d+)/g)].map((match) => `${match[1]} . ${match[2]}`);
}

/**
 * Asks systemd, on the machine, whether it reads each schedule as a time:
 * validate() only knows the expression is safe to write, systemd alone knows
 * the calendar syntax, and a timer it cannot read is laid, loaded, and never
 * starts anything. One `OK` or `BAD` line per schedule, in order, then the
 * marker. A read, run before anything is written, and in a dry run too.
 *
 * Each expression goes between double quotes: isValidSchedule leaves nothing
 * in it a shell reads there, no `$`, quote, backslash or backtick.
 */
export function scheduleCheckCommand(schedules: string[]): string {
  for (const schedule of schedules) {
    if (!isValidSchedule(schedule)) throw new Error(`invalid schedule: ${schedule}`);
  }
  const checks = schedules.map(
    (schedule) => `if systemd-analyze calendar "${schedule}" >/dev/null 2>&1; then echo OK; else echo BAD; fi;`,
  );
  return `sh -c '${checks.join(" ")} echo ${MARKER_DONE}'`;
}

/** The schedules systemd refused, in the manifest's order, or null when the answer does not read. */
export function readScheduleCheck(output: string, schedules: string[]): string[] | null {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.at(-1) !== MARKER_DONE || lines.length !== schedules.length + 1) return null;
  const refused: string[] = [];
  for (const [rank, line] of lines.slice(0, -1).entries()) {
    if (line === "BAD") refused.push(schedules[rank]!);
    else if (line !== "OK") return null;
  }
  return refused;
}

/** How a unit stands, as stabilityCommand reads it. */
export type UnitStanding = { active: string; sub: string; restarts: number };

/**
 * Reads how each unit stands, its state and how many times systemd restarted
 * it on its own. `deploy` reads it right after its restart, and again a few
 * seconds later: a service that started and fell at once is `active` to the
 * first `is-active`, `Type=simple` counting it started as soon as it is
 * spawned, and only the second reading sees it crash. A read: no sudo.
 */
export function stabilityCommand(units: string[]): string {
  for (const unit of units) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(unit)) throw new Error(`invalid unit: ${unit}`);
  }
  return `systemctl show -p Id -p ActiveState -p SubState -p NRestarts ${units.map(unitArgument).join(" ")} && echo ${MARKER_DONE}`;
}

/** Each unit's standing, by unit as named in `units`, or null when the answer does not read. */
export function readStability(output: string, units: string[]): Map<string, UnitStanding> | null {
  if (!output.split("\n").some((line) => line.trim() === MARKER_DONE)) return null;
  const standings = new Map<string, UnitStanding>();
  const byId = new Map(units.map((unit) => [unitFileName(unit), unit]));
  for (const block of output.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const equal = line.indexOf("=");
      if (equal > 0) fields.set(line.slice(0, equal).trim(), line.slice(equal + 1).trim());
    }
    const unit = byId.get(fields.get("Id") ?? "");
    if (unit === undefined) continue;
    const restarts = Number(fields.get("NRestarts"));
    standings.set(unit, {
      active: fields.get("ActiveState") ?? "unknown",
      sub: fields.get("SubState") ?? "unknown",
      restarts: Number.isInteger(restarts) ? restarts : 0,
    });
  }
  return units.every((unit) => standings.has(unit)) ? standings : null;
}

/**
 * The units that did not hold: no longer active, or restarted by systemd
 * since the first reading. Each named with what was seen, for the refusal.
 */
export function unstableUnits(before: Map<string, UnitStanding>, after: Map<string, UnitStanding>): string[] {
  const fallen: string[] = [];
  for (const [unit, now] of after) {
    const then = before.get(unit);
    const restarted = then !== undefined && now.restarts > then.restarts;
    if (now.active !== "active" || restarted) {
      fallen.push(`${unitFileName(unit)} is ${now.active} (${now.sub})${restarted ? `, restarted ${now.restarts - then!.restarts} time(s) by systemd` : ""}`);
    }
  }
  return fallen;
}
