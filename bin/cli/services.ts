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
import { domainHosts, FIRST_BLOCK, inLaterBlock, isValidSchedule, isValidSlug, PORTAL_SLUG, readManifest, servicesOf, type Manifest } from "./manifest";
import { PORTAL_PORT } from "./portal";
import { autobindReachesBlocks, LOOPBACK_TABLE, PROJECT_PORTS_FILE, PROJECT_PORTS_SET, reservesEveryBlock } from "./loopback";
import { CREDENTIALS_EXIT_STATUS, credentialsFailure } from "./store";
import { BIND_LINES_FEATURE, BIND_PROPERTIES, isTimerUnit, readBindStates, systemUser, unboundStates, unitArgument, unitFileName, unitNames, type BindState } from "./unit";

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

// --- the second block of the services' ports ---------------------------------

/**
 * The ports `manifest` declares outside the first block: those a machine
 * lets a project listen on only once it has opened the second block.
 */
export function laterBlockPorts(manifest: Manifest): number[] {
  return servicesOf(manifest).flatMap((service) => (service.port !== null && inLaterBlock(service.port) ? [service.port] : []));
}

/** Where the backup component and the installer are built into one file each. */
export const COMPONENTS_FOLDER = "/usr/local/lib/sitesolide";

/**
 * The components that confine a project's program by DENIED_BINDS without a
 * unit file of their own: the backup component runs each service's backup
 * command as the project, and the installer runs `install` and writes the
 * units of a token's deployment. A build of either from before the second
 * block lets those programs listen there, or writes units that do.
 */
export const BIND_COMPONENTS = ["backup", "installer"] as const;
export type BindComponent = (typeof BIND_COMPONENTS)[number];
export type ComponentState = "current" | "outdated" | "absent";

/** The sections of secondBlockStateCommand's answer, in order. */
const SECTIONS = ["rule", "units", "components", "listeners", "accounts", "ports"] as const;

/** What the read prints when systemctl or the listing of sockets fails: the whole read is then no answer. */
const READ_FAILED = "read failed";

/**
 * What a machine is read for before a project may listen in the second block,
 * and at every deployment after, in one round trip, as root (nft lists
 * nothing to anyone else), changing nothing:
 *
 * - `rule`: the loopback rule the kernel carries, `nft list table`, nothing
 *   when none is laid;
 * - `units`: every service unit file of /etc/systemd/system, a dangling link
 *   and a masked unit skipped as systemd skips them, a template too, which
 *   runs nothing by itself and which `systemctl show` refuses, as systemd
 *   has it loaded: `systemctl show` of who it runs as and where it may not
 *   listen (readBindStates in bin/cli/unit.ts). The number of files comes
 *   first, `files <n>`, and a systemctl that fails says so: an answer with
 *   fewer units than files, cut off or empty, is no answer, never a machine
 *   with no unit at fault;
 * - `components`: whether the backup component and the installer were built
 *   with this release's bind lines, BIND_LINES_FEATURE searched in each;
 * - `listeners`: the listening TCP sockets, the kernel's own lines of
 *   /proc/net/tcp and tcp6, each with the uid that opened it, and `accounts`
 *   to name the uid: what already holds a port of the second block, a
 *   scheduled run started under an earlier unit for one, which no reload
 *   closes;
 * - `ports`: the kernel's ephemeral range and its reserved ports
 *   (PORT_RESERVATION_FILE in bin/cli/loopback.ts).
 */
export function secondBlockStateCommand(): string {
  if (!/^[a-z0-9:,-]+$/.test(BIND_LINES_FEATURE)) throw new Error("unexpected feature marker");
  const components = BIND_COMPONENTS.join(" ");
  return [
    "sudo sh -c '",
    `echo "== rule"; nft list table inet ${LOOPBACK_TABLE} 2>/dev/null; `,
    'echo "== units"; units=""; count=0; for unit in /etc/systemd/system/*.service; do [ -f "$unit" ] || continue; case "$unit" in *@.service) continue ;; esac; units="$units ${unit##*/}"; count=$((count + 1)); done; ',
    `echo "files $count"; [ -z "$units" ] || systemctl show ${BIND_PROPERTIES.map((property) => `-p ${property}`).join(" ")} -- $units || echo "${READ_FAILED}"; `,
    `echo "== components"; for name in ${components}; do file=${COMPONENTS_FOLDER}/$name.js; `,
    `if [ ! -f "$file" ]; then echo "$name absent"; elif grep -qF ${BIND_LINES_FEATURE} "$file"; then echo "$name current"; else echo "$name outdated"; fi; done; `,
    // A listening socket's state is 0A, a field of its own: grep finding none
    // answers 1, a file it cannot read 2. tcp6 is absent from a kernel booted
    // without IPv6; tcp never is.
    `echo "== listeners"; for file in /proc/net/tcp /proc/net/tcp6; do if [ -r "$file" ]; then grep -h " 0A " "$file"; [ $? -le 1 ] || echo "${READ_FAILED}"; `,
    `elif [ "$file" = /proc/net/tcp ]; then echo "${READ_FAILED}"; fi; done; `,
    `echo "== accounts"; if accounts=$(getent passwd); then printf "%s\\n" "$accounts" | cut -d: -f1,3; else echo "${READ_FAILED}"; fi; `,
    'echo "== ports"; cat /proc/sys/net/ipv4/ip_local_port_range /proc/sys/net/ipv4/ip_local_reserved_ports; ',
    `echo ${MARKER_DONE}'`,
  ].join("");
}

/** A socket listening on a port of a later block, and the account that opened it. */
export type Listener = { port: number; uid: number; account: string | null };

export type SecondBlockState = {
  /** The loaded rule refuses the others on every block. */
  reserved: boolean;
  /** Who each service unit runs as and where it may not listen, as systemd has it loaded. */
  units: BindState[];
  components: Record<BindComponent, ComponentState>;
  /** What already listens on a port of a later block. */
  listeners: Listener[];
  /** May the kernel hand a process a port of a block by itself? */
  autobind: boolean;
};

/** `getent passwd | cut -d: -f1,3`, or /etc/passwd itself: each uid's account. Null when a line does not read. */
export function readAccounts(text: string): Map<number, string> | null {
  const accounts = new Map<number, string>();
  for (const line of text.split("\n").map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    const [name, second, third] = line.split(":");
    const uid = Number(third ?? second);
    if (name === undefined || name === "" || !Number.isInteger(uid) || uid < 0) return null;
    if (!accounts.has(uid)) accounts.set(uid, name);
  }
  return accounts;
}

/**
 * The listening sockets on a port of a later block, from the kernel's lines of
 * /proc/net/tcp and tcp6: `sl local rem st ... uid timeout inode`, the local
 * port in hexadecimal, state 0A for a listening one, the uid that opened it in
 * the eighth field. Null when a line does not read. One per port and uid: a
 * service listening on IPv4 and IPv6 is one listener.
 */
export function readListeners(lines: readonly string[], accounts: ReadonlyMap<number, string>): Listener[] | null {
  const found = new Map<string, Listener>();
  for (const line of lines.map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    const fields = line.split(/\s+/);
    const local = /^[0-9A-Fa-f]+:([0-9A-Fa-f]{4})$/.exec(fields[1] ?? "");
    const uid = Number(fields[7]);
    if (local === null || !Number.isInteger(uid) || uid < 0) return null;
    if (fields[3] !== "0A") continue;
    const port = Number.parseInt(local[1]!, 16);
    if (!inLaterBlock(port)) continue;
    found.set(`${port}.${uid}`, { port, uid, account: accounts.get(uid) ?? null });
  }
  return [...found.values()].sort((a, b) => a.port - b.port || a.uid - b.uid);
}

/** A listener as a refusal names it: `21000 (site-old)`. */
export function describeListener(listener: Listener): string {
  return `${listener.port} (${listener.account ?? `uid ${listener.uid}`})`;
}

/**
 * The listeners of a later block that no deposited manifest accounts for: a
 * port no project declares, or one a project declares and another account
 * holds. What bin/deploy-loopback.sh refuses to open the block over, and the
 * monitor reports: a socket a run of the release before opened there, which
 * no reload closes, would take the visitors of the next project given the
 * port. A manifest that no longer reads accounts for nothing.
 */
export function strayListeners(listeners: readonly Listener[], deposited: ReadonlyMap<string, string>): Listener[] {
  const owners = new Map<number, string>();
  for (const [folder, raw] of deposited) {
    const { manifest } = readManifest(raw);
    if (manifest === undefined || manifest.slug !== folder) continue;
    for (const service of servicesOf(manifest)) if (service.port !== null) owners.set(service.port, systemUser(manifest.slug));
  }
  return listeners.filter((listener) => owners.get(listener.port) !== listener.account);
}

/** secondBlockStateCommand's answer, read; null when any part of it does not read, and nothing opens then. */
export function readSecondBlockState(output: string): SecondBlockState | null {
  const lines = output.split("\n");
  if (lines.map((line) => line.trim()).filter((line) => line !== "").at(-1) !== MARKER_DONE) return null;
  const at = SECTIONS.map((name) => lines.indexOf(`== ${name}`));
  if (at.some((index, i) => index < 0 || (i > 0 && index < at[i - 1]!))) return null;
  const section = (i: number): string[] => lines.slice(at[i]! + 1, i + 1 < at.length ? at[i + 1] : lines.findLastIndex((line) => line.trim() === MARKER_DONE));
  const [files, ...shown] = section(1);
  const count = /^files (\d+)$/.exec(files?.trim() ?? "");
  if (count === null || shown.some((line) => line.trim() === READ_FAILED)) return null;
  const units = readBindStates(shown.join("\n"));
  if (units === null || units.length !== Number(count[1])) return null;
  const components = {} as Record<BindComponent, ComponentState>;
  for (const line of section(2).map((line) => line.trim()).filter((line) => line !== "")) {
    const [name, state] = line.split(" ");
    if (!BIND_COMPONENTS.includes(name as BindComponent) || !["current", "outdated", "absent"].includes(state ?? "")) return null;
    components[name as BindComponent] = state as ComponentState;
  }
  if (BIND_COMPONENTS.some((name) => components[name] === undefined)) return null;
  if ([3, 4].some((i) => section(i).some((line) => line.trim() === READ_FAILED))) return null;
  const accounts = readAccounts(section(4).join("\n"));
  const listeners = accounts === null ? null : readListeners(section(3), accounts);
  if (listeners === null) return null;
  const ports = section(5).map((line) => line.trim());
  const [portRange, reservedPorts = "", ...rest] = ports.filter((line, i) => i < 2 || line !== "");
  if (portRange === undefined || rest.length > 0) return null;
  const autobind = autobindReachesBlocks(portRange, reservedPorts);
  if (autobind === null) return null;
  return { reserved: reservesEveryBlock(section(0).join("\n")), units, components, listeners, autobind };
}

/** The units of the machine that may still listen in a block, its own `units` aside: those a deployment is about to write. */
export function unguardedUnits(state: SecondBlockState, own: readonly string[] = []): string[] {
  const mine = new Set(own.map(unitFileName));
  return unboundStates(state.units).filter((unit) => !mine.has(unit));
}

/**
 * Why a project may not listen on `ports`, ports of the second block, on a
 * machine that has not opened it; null when it has.
 *
 * Open means all of these, measured at the deployment, never remembered:
 *
 * - the loaded loopback rule refuses the others on every block, which no
 *   rule in `observe` does: no other account connects to the service;
 * - no unit that runs as a project's account may listen in a block, as
 *   systemd has it loaded: no other project takes the port first. A unit
 *   generated before this release may bind any port of the second block,
 *   and on a port Caddy sends one project's visitors to, the first to listen
 *   gets them, a neighbour's service between two of its restarts included;
 * - the backup component and the installer, which run a project's programs
 *   outside its units, carry this release's bind lines;
 * - the kernel never hands a port of a block out by itself.
 *
 * bin/deploy-loopback.sh lays the rule with both blocks only once the last
 * three hold, so `reserved` alone already says the machine was safe when it
 * was laid; the rest is read again because each can come back since, a
 * project deployed by an older CLI for one. `layRule` names the command that
 * lays the rule, the kit's path for the CLI. `own` are the units this
 * deployment writes, which the read does not hold against it.
 *
 * And, open or not, nothing but the project's own `account` may already
 * listen on one of `ports`: a run started under a unit of the release before,
 * a scheduled one up to 24 hours long, can hold a port of the block, and no
 * reload closes its socket. The project's bind would then fail and Caddy
 * send its visitors to that socket. `account` null holds every listener
 * against the project.
 */
export function secondBlockRefusal(
  ports: number[],
  state: SecondBlockState,
  layRule: () => string = () => "bin/deploy-loopback.sh close",
  own: readonly string[] = [],
  account: string | null = null,
): string[] | null {
  if (ports.length === 0) return null;
  const unbound = unguardedUnits(state, own);
  const stale = BIND_COMPONENTS.filter((name) => state.components[name] === "outdated");
  const taken = state.listeners.filter((listener) => ports.includes(listener.port) && (account === null || listener.account !== account));
  const opened = state.reserved && unbound.length === 0 && stale.length === 0 && !state.autobind;
  if (opened && taken.length === 0) return null;
  const named = [...new Set(ports)].sort((a, b) => a - b).join(", ");
  const held = taken.length === 0 ? [] : [`already listened on by another account, which Caddy would send this project's visitors to: ${taken.map(describeListener).join(", ")}; the owner stops what holds it before the port is given`];
  if (opened) return [`port ${named}: taken on this machine`, ...held];
  return [
    `port ${named}: the second block of the services' ports, which this machine has not opened yet`,
    ...(state.reserved ? [] : ["its loopback rule does not refuse other accounts on that block: any account could connect there"]),
    ...(unbound.length === 0 ? [] : [`units that may still listen there, taking another project's visitors: ${unbound.join(", ")}`]),
    ...(stale.length === 0 ? [] : [`components built before that block, whose programs may listen there: ${stale.join(", ")}`]),
    ...(state.autobind ? ["the kernel may hand a port of that block to any process that asks for none: its reservation is missing"] : []),
    ...held,
    `the owner opens it: sitesolide upgrade, sitesolide refresh --all, then ${layRule()}, in that order (docs/upgrading.md); a unit edited by hand takes the missing SocketBindDeny= lines, then systemctl daemon-reload and a restart`,
    `until then, a port of ${FIRST_BLOCK.first} to ${FIRST_BLOCK.last} works as before`,
  ];
}

/**
 * What every deployment says once the block is open and a unit may listen in
 * it again, the deployment going on: the project being deployed has nothing
 * there to lose, the one that does is not the one deploying. Null when
 * nothing is to be said.
 */
export function unguardedWarning(state: SecondBlockState, own: readonly string[] = []): string[] | null {
  if (!state.reserved) return null;
  const unbound = unguardedUnits(state, own);
  if (unbound.length === 0) return null;
  return [
    `units that may listen on the second block's ports, where Caddy sends other projects' visitors: ${unbound.join(", ")}`,
    "most likely a project deployed by an older CLI: write them again with sitesolide refresh --all; a unit edited by hand takes the missing SocketBindDeny= lines, then systemctl daemon-reload and a restart",
  ];
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

/**
 * How a unit stands, as stabilityCommand reads it. `status`: the exit status
 * of its main process, when the reading asked for it, null for one that could
 * not tell (the installer's); 243 is a unit whose secret files could not be
 * loaded (CREDENTIALS_EXIT_STATUS in ./store).
 */
export type UnitStanding = { active: string; sub: string; restarts: number; status?: number | null };

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
  return `systemctl show -p Id -p ActiveState -p SubState -p NRestarts -p ExecMainStatus ${units.map(unitArgument).join(" ")} && echo ${MARKER_DONE}`;
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
    const status = fields.get("ExecMainStatus");
    standings.set(unit, {
      active: fields.get("ActiveState") ?? "unknown",
      sub: fields.get("SubState") ?? "unknown",
      restarts: Number.isInteger(restarts) ? restarts : 0,
      // Only when asked for: a reading without it, the installer's, keeps its shape.
      ...(status !== undefined && /^[0-9]+$/.test(status) ? { status: Number(status) } : {}),
    });
  }
  return units.every((unit) => standings.has(unit)) ? standings : null;
}

/**
 * The units that did not hold: no longer active, or restarted by systemd
 * since the first reading. Each named with what was seen, for the refusal;
 * one whose last start exited 243 by credentialsFailure, since systemd logs
 * it as "Protocol error", which sends one looking elsewhere.
 */
export function unstableUnits(before: Map<string, UnitStanding>, after: Map<string, UnitStanding>): string[] {
  const fallen: string[] = [];
  for (const [unit, now] of after) {
    const then = before.get(unit);
    const restarted = then !== undefined && now.restarts > then.restarts;
    if (now.active !== "active" || restarted) {
      if (now.status === CREDENTIALS_EXIT_STATUS) {
        // A unit's slug is its name up to the first dot: `shop`, `shop.worker`.
        fallen.push(credentialsFailure(unitFileName(unit), unit.split(".")[0]!));
        continue;
      }
      fallen.push(`${unitFileName(unit)} is ${now.active} (${now.sub})${restarted ? `, restarted ${now.restarts - then!.restarts} time(s) by systemd` : ""}`);
    }
  }
  return fallen;
}
