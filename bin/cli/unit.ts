/**
 * Generates the systemd unit of an application project.
 *
 * The model is the hardening shared by every service on the machine.
 * **Nothing is taken away from it here**: this file exists so that a project
 * deployed from any repository is confined exactly like a site from the
 * repository, and not slightly less.
 *
 * Pure: returns text, touches nothing.
 */
import { sameDirectives, usefulDirectives } from "./comparison";
import { CONNECTORS_PORT, EGRESS_PROXY_PORT, egressUnitLines } from "./egress";
import { CADDY_ADMIN_PORT } from "./loopback";
import {
  commandErrors,
  hasStore,
  isAnchored,
  isValidCpu,
  isValidDescription,
  isValidEnvName,
  isValidEnvValue,
  isValidFileName,
  isValidMemory,
  isValidSchedule,
  isValidServiceName,
  isValidSlug,
  isValidTimeout,
  secretsOf,
  SERVICE_PORTS,
  servedContact,
  servedZone,
  servicesOf,
  type Manifest,
  type ServiceView,
} from "./manifest";
import { SECRETS_FOLDER, STORE_ROOT, STORE_UNIT_LINES_AFTER, storeCredentials, storeEnvironmentFile } from "./store";

export type ProjectPaths = {
  root: string;
  app: string;
  publicDir: string;
  dataDir: string;
};

/** The served tree on the VM, the same for every project. */
export function projectPaths(slug: string, sitesRoot = "/srv/sites"): ProjectPaths {
  const root = `${sitesRoot}/${slug}`;
  return {
    root,
    app: `${root}/app`,
    publicDir: `${root}/public`,
    dataDir: `${root}/data`,
  };
}

/**
 * A unit as systemctl and journalctl must be given it. The main unit is the
 * slug, which has no dot, and systemd adds `.service` itself. A secondary unit,
 * `<slug>.<name>`, gets it written out: systemd reads what follows the last dot
 * as a type, and the suffix removes any doubt about which unit is meant. A
 * timer is named with its suffix already, `<slug>.<name>.timer`, see
 * timerUnit, and goes as it is.
 */
export function unitArgument(unit: string): string {
  if (isTimerUnit(unit)) return unit;
  return unit.includes(".") ? `${unit}.service` : unit;
}

/**
 * Units are named without `.service`, as they always were, and a timer with
 * its `.timer`: a scheduled service and its timer share `<slug>.<name>`, and
 * the suffix keeps them apart. No service is named `timer` (UNIT_TYPES in
 * manifest.ts), so no service unit ends that way.
 */
export function isTimerUnit(unit: string): boolean {
  return unit.endsWith(".timer");
}

/** The timer that starts a scheduled service, `<slug>.<name>.timer`. */
export function timerUnit(service: ServiceView): string {
  return `${service.unit}.timer`;
}

/** The file a unit lives in, its name and type: `<unit>.service`, or the timer's own name. */
export function unitFileName(unit: string): string {
  return isTimerUnit(unit) ? unit : `${unit}.service`;
}

/** The project's system user, with no shell, created by `init`. */
export function systemUser(slug: string): string {
  return `site-${slug}`;
}

/**
 * The flat file a project without a store reads, the dashboard's or the
 * portal's (STORELESS_SLUGS): `/etc/sitesolide/<slug>.env`, which carries the
 * owner's password hash. Its manifest declares no secret: the unit names it.
 */
export function platformFile(slug: string): string {
  return `${SECRETS_FOLDER}/${slug}.env`;
}

/**
 * The placeholders an environment value can carry, and their replacement.
 *
 * Without them, a versioned manifest would have to write the domain of the
 * machine serving it, and would no longer be valid elsewhere: the dashboard
 * declares "PUBLIC_URL": "https://{slug}.{zone}" and is valid for everyone.
 *
 * A placeholder whose value is empty stays in place, visible as is. Better a
 * variable that is obviously incomplete, seen in `systemctl cat`, than a wrong
 * address with nothing to say it is wrong.
 *
 * Except for an optional one, where empty is an answer and not a gap. The
 * contact address is optional: absent, the door page of a locked preview drops
 * its line. Left as `{contact}`, it was not absent but a value, and the page
 * offered to write to "{contact}".
 */
const OPTIONAL_PLACEHOLDERS: ReadonlySet<string> = new Set(["contact"]);

export function substitute(value: string, placeholders: Record<string, string>): string {
  let output = value;
  for (const [name, replacement] of Object.entries(placeholders)) {
    if (replacement !== "" || OPTIONAL_PLACEHOLDERS.has(name)) output = output.replaceAll(`{${name}}`, replacement);
  }
  return output;
}

/**
 * A manifest's text as a unit setting carries it. systemd expands `%`
 * specifiers in Description=, Environment= and ExecStart=: `%h` becomes a home
 * folder, `%m` the machine's id, and an unknown one makes systemd drop the
 * line. `%%` is the percent sign itself, so the setting says what the manifest
 * wrote, whoever wrote it. A text without `%`, as every unit in service today,
 * comes out unchanged.
 */
export function escapeSpecifiers(text: string): string {
  return text.replaceAll("%", "%%");
}

/**
 * The second barrier behind validate(), as in fragment.ts: since the control
 * API, a team token writes the manifest, and a value that would add a
 * directive, set a variable past the rules on names, or run the command as
 * root (`ExecStart=+...`) is never written. It throws rather than writes, and
 * refuses only what validate() refuses.
 */
function assertWritable(manifest: Manifest, service: ServiceView): void {
  const refused = (what: string) => new Error(`${what} is not what validate() accepts, it is never written into a unit`);
  if (manifest.description !== undefined && !isValidDescription(manifest.description)) throw refused("description");
  if (typeof service.start !== "string" || commandErrors(service.start, "start").length > 0) throw refused(`the start of ${service.unit}`);
  if (service.cpu !== null && !isValidCpu(service.cpu)) throw refused(`the cpu of ${service.unit}`);
  if (service.kind === "scheduled" && (!isValidSchedule(service.schedule) || !isValidTimeout(service.timeout))) {
    throw refused(`the schedule of ${service.unit}`);
  }
  for (const [name, value] of Object.entries(service.env)) {
    if (!isValidEnvName(name) || !isValidEnvValue(value)) throw refused(`env ${JSON.stringify(name)}`);
  }
  // No file's name goes into the unit, which loads the whole folder: still,
  // a name systemd would skip or flatten is refused here as in validate().
  for (const file of secretsOf(manifest).files) {
    if (!isValidFileName(file)) throw refused(`secrets.files ${JSON.stringify(file)}`);
  }
}

/**
 * The same barrier as assertWritable, for the fields that name or bound the
 * unit itself rather than its command: the slug, which becomes the unit's
 * name, its account `site-<slug>` and its `/srv/sites/<slug>` folder; a
 * service name, which becomes `<slug>.<name>` and sits in the anchor's
 * `Wants=`; and the memory, written to `MemoryMax=` unescaped. A newline in
 * any of them would add a directive PID 1 obeys as root, `User=root` the worst
 * of them. It runs before anything is rendered, because the anchor and the
 * secondary units embed the slug and the names before assertWritable is
 * reached; it refuses only what validate() refuses, and throws rather than
 * write.
 */
function assertNamesWritable(manifest: Manifest, services: ServiceView[]): void {
  const refused = (what: string) => new Error(`${what} is not what validate() accepts, it is never written into a unit`);
  if (!isValidSlug(manifest.slug)) throw refused("the slug");
  for (const service of services) {
    if (service.name !== null && !isValidServiceName(service.name)) throw refused(`the name of a service`);
    if (!isValidMemory(service.memory)) throw refused(service.name === null ? "the memory" : "the memory of a service");
  }
}

/**
 * What a service is told of its tree: its port, its data folder and its
 * public folder, as its unit sets them, `PORT`, `DATA_DIR` and `PUBLIC_DIR`.
 * The backup component hands the same to a service's backup command
 * (dashboard/src/backup/hooks.ts): one writing of them for both.
 */
export function treeVariables(manifest: Manifest, service: ServiceView, sitesRoot = "/srv/sites"): [string, string][] {
  const paths = projectPaths(manifest.slug, sitesRoot);
  return [
    // A worker and a scheduled service listen on nothing, and are told no port.
    ...(service.port === null ? [] : [["PORT", String(service.port)] as [string, string]]),
    ["DATA_DIR", paths.dataDir],
    ["PUBLIC_DIR", paths.publicDir],
  ];
}

/**
 * A service's own `env`, the project's merged in, its placeholders replaced:
 * each value as the process receives it. The unit escapes the `%` on top,
 * for systemd's specifiers; a backup command, handed them through
 * systemd-run's `--setenv`, which expands none, takes them as they are.
 */
export function declaredVariables(service: ServiceView, placeholders: Record<string, string>): [string, string][] {
  return Object.entries(service.env).map(([key, value]) => [key, substitute(value, placeholders)]);
}

/**
 * A generated unit: its name, without `.service` for a service and with
 * `.timer` for a timer (see unitFileName), and its text.
 */
export type GeneratedUnit = { unit: string; text: string };

function defaultPlaceholders(manifest: Manifest): Record<string, string> {
  return { slug: manifest.slug, zone: servedZone(), contact: servedContact() };
}

/**
 * The unit of the project's main service: the only one of a project with a
 * single `start`, the first that runs for good of its `services` otherwise,
 * or its anchor when every one of them is scheduled.
 */
export function generateUnit(manifest: Manifest, placeholders = defaultPlaceholders(manifest)): string {
  const [main] = generateUnits(manifest, placeholders);
  if (main === undefined) throw new Error(`${manifest.slug} declares no service`);
  return main.text;
}

/**
 * Every unit of the project, the main one first.
 *
 * The others hang on the main one: it `Wants=` them, so starting it starts
 * them, and they are `PartOf=` it, so stopping or restarting it does the same
 * to them. That is what lets the dashboard and the steward, which know a
 * project by its main unit alone, restart all of it when a secret changes.
 *
 * A scheduled service is the exception: the main unit wants its timer, never
 * the service itself, which would run at every start of the project. The
 * timer starts it at the times it names. Both are `PartOf=` the main unit,
 * whose restart restarts the timer and a run in progress, never one that is
 * not: systemd propagates it as a try-restart. When every service is
 * scheduled, the main unit is an anchor, see isAnchored.
 */
export function generateUnits(manifest: Manifest, placeholders = defaultPlaceholders(manifest)): GeneratedUnit[] {
  const services = servicesOf(manifest);
  if (services.length === 0) return [];
  assertNamesWritable(manifest, services);
  const anchored = isAnchored(manifest);
  const main = anchored ? null : services[0]!;
  const others = anchored ? services : services.slice(1);
  const mainUnit = manifest.slug;
  const wanted = others.map((service) => (service.kind === "scheduled" ? timerUnit(service) : `${service.unit}.service`));
  const after = others.filter((service) => service.kind !== "scheduled").map((service) => `${service.unit}.service`);

  const units: GeneratedUnit[] = [
    main === null
      ? { unit: mainUnit, text: renderAnchor(manifest, wanted) }
      : { unit: main.unit, text: renderUnit(manifest, main, { wanted, after }, placeholders) },
  ];
  for (const service of others) {
    units.push({ unit: service.unit, text: renderUnit(manifest, service, { main: mainUnit }, placeholders) });
    if (service.kind === "scheduled") units.push({ unit: timerUnit(service), text: renderTimer(manifest, service, mainUnit) });
  }
  return units;
}

/**
 * The names of every unit the project's manifest generates, the main one
 * first, as generateUnits names them, without writing a line of them: what
 * the listings on the machine are compared with.
 */
export function unitNames(manifest: Manifest): string[] {
  const services = servicesOf(manifest);
  if (services.length === 0) return [];
  const names = isAnchored(manifest) ? [manifest.slug] : [];
  for (const service of services) {
    names.push(service.unit);
    if (service.kind === "scheduled") names.push(timerUnit(service));
  }
  return names;
}

/** The units `deploy` restarts and expects active: every one but the scheduled services, which their timers start. */
export function runningUnits(manifest: Manifest): string[] {
  const scheduled = scheduledUnits(manifest);
  return unitNames(manifest).filter((unit) => !scheduled.has(unit));
}

/**
 * The units that run a program for good, the servers and the workers: those
 * `deploy` watches for a while after their restart, see stabilityCommand in
 * services.ts. Not the anchor, which runs nothing, nor a timer.
 */
export function watchedUnits(manifest: Manifest): string[] {
  return servicesOf(manifest).filter((service) => service.kind !== "scheduled").map((service) => service.unit);
}

function scheduledUnits(manifest: Manifest): Set<string> {
  return new Set(servicesOf(manifest).filter((service) => service.kind === "scheduled").map((service) => service.unit));
}

/**
 * The main unit of a project whose every service is scheduled: it runs
 * nothing, as the project's account and with no network, and stays active
 * once started. It wants the timers, so that they start at boot and after a
 * deployment, and their `PartOf=` makes its restart theirs.
 */
function renderAnchor(manifest: Manifest, wanted: string[]): string {
  if (manifest.description !== undefined && !isValidDescription(manifest.description)) {
    throw new Error("description is not what validate() accepts, it is never written into a unit");
  }
  const slug = manifest.slug;
  const account = systemUser(slug);
  const description = escapeSpecifiers(manifest.description ?? `Project ${slug}`);
  return [
    `# Anchor of project ${slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
    "#",
    "# Every service of this project is scheduled: this unit runs nothing. It",
    "# stands for the project, wants its timers so that they start at boot,",
    "# and stays active, as the main unit of any project does.",
    "",
    "[Unit]",
    `Description=${description}`,
    `Wants=${wanted.join(" ")}`,
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/bin/true",
    `User=${account}`,
    `Group=${account}`,
    `WorkingDirectory=${projectPaths(slug).app}`,
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateNetwork=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The timer of a scheduled service: it starts the service of the same name at
 * the times its `schedule` names. `Persistent` runs at boot a time missed
 * while the machine was down; `AccuracySec` keeps systemd from delaying a run
 * by up to a minute to group it with others, which a server has no reason to
 * do. A timer never starts a service still running: a time that falls during
 * a run that outlasts its interval is skipped, never doubled.
 */
function renderTimer(manifest: Manifest, service: ServiceView, mainUnit: string): string {
  if (!isValidSchedule(service.schedule)) throw new Error(`the schedule of ${service.unit} is not what validate() accepts, it is never written into a timer`);
  const description = escapeSpecifiers(manifest.description ?? `Project ${manifest.slug}`);
  return [
    `# Timer of project ${manifest.slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
    "",
    "[Unit]",
    `Description=${description}, schedule of service ${service.name}`,
    "# Started by the project's main unit, and stopped or restarted with it.",
    `PartOf=${mainUnit}.service`,
    "",
    "[Timer]",
    `OnCalendar=${escapeSpecifiers(service.schedule)}`,
    "Persistent=true",
    "AccuracySec=1s",
    "",
  ].join("\n");
}

/** What 0.7 wrote above InaccessiblePaths in a unit reading no secret. */
const NO_SECRET_COMMENT: readonly string[] = [
  "# No secret for this project: the whole folder is closed to it, which",
  "# hides from it even the names of the files.",
];

/** In place of InaccessiblePaths in the dashboard's and the portal's units, which read their own flat file. */
const PLATFORM_FILE_COMMENT: readonly string[] = [
  "# This project reads its own file in /etc/sitesolide: InaccessiblePaths",
  "# is not laid here, or systemd could not hand the file to it.",
];

/** Above the lines every unit of a project with a store ends its walls with, STORE_UNIT_LINES_AFTER. */
const STORE_UNIT_COMMENT: readonly string[] = [
  "# Its secrets reach it from PID 1, read before the walls go up: the",
  "# store's variables last, so that they win over a file named above, and",
  "# its files, each a private copy at $CREDENTIALS_DIRECTORY/files_<name>.",
  "# /etc/sitesolide is closed to it, the names of its files included. The",
  "# processes of other accounts are hidden from it; those of the project's",
  "# other services, which share its account, are not.",
];

function renderUnit(
  manifest: Manifest,
  service: ServiceView,
  place: { wanted: string[]; after: string[] } | { main: string },
  placeholders: Record<string, string>,
): string {
  assertWritable(manifest, service);
  const slug = manifest.slug;
  const account = systemUser(slug);
  const paths = projectPaths(slug);
  const store = hasStore(manifest);
  const isOutbound = manifest.network === "outbound";
  const description = escapeSpecifiers(manifest.description ?? `Project ${slug}`);

  const lines = [
    `# Service of project ${slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
    "#",
    "# Isolation: dedicated user with no shell, system mounted read only,",
    "# writing allowed in the project's data folder alone. A compromised",
    "# project can read neither the landing nor the other sites.",
    "",
    "[Unit]",
    // What `systemctl status` shows. Without the field, the slug alone, which
    // is enough for a personal project and loses the little a hand-written unit
    // said. The zone does not come in here: a unit names no machine, and the
    // served address is read in the Caddy fragment.
    `Description=${service.name === null ? description : `${description}, service ${service.name}`}`,
    "After=network-online.target",
    "Wants=network-online.target",
  ];

  if ("main" in place) {
    lines.push(
      service.kind === "scheduled"
        ? "# Started by its timer, and stopped or restarted with the project's main unit."
        : "# Started by the project's main unit, and stopped or restarted with it.",
      `PartOf=${place.main}.service`,
    );
  } else if (place.wanted.length > 0) {
    lines.push(
      "# The project's other services start before this one, and follow it when",
      "# it stops or restarts: see their PartOf.",
      `Wants=${place.wanted.join(" ")}`,
      ...(place.after.length > 0 ? [`After=${place.after.join(" ")}`] : []),
    );
  }
  if (service.kind === "worker") {
    lines.push(
      "# A worker is restarted however long it keeps failing: the monitor says",
      "# so, and the delay between two attempts grows instead.",
      "StartLimitIntervalSec=0",
    );
  }

  lines.push(
    "",
    "[Service]",
    service.kind === "scheduled" ? "Type=exec" : "Type=simple",
    `User=${account}`,
    `Group=${account}`,
    `WorkingDirectory=${paths.app}`,
    "",
    ...treeVariables(manifest, service).map(([key, value]) => `Environment=${key}=${value}`),
  );

  // The proxy and the connectors, only for a project that asks for them: the
  // unit of every other project is unchanged, line for line.
  lines.push(...egressUnitLines(manifest));

  // The variables declared by the project. They never carry a secret, this file
  // being versioned: validate() refuses the names that announce one. What does
  // hide arrives from /etc/sitesolide, read by PID 1, see below: the
  // dashboard's Secrets section holds it on the VM.
  //
  // `{zone}` and `{slug}` are replaced there, so that a versioned manifest
  // never writes a machine's domain: a project declares
  // "PUBLIC_URL": "https://{slug}.{zone}" and is valid for everyone.
  //
  // The `%` escaped after the replacement, so that a zone or a contact holding
  // one is written as it is too.
  for (const [key, value] of declaredVariables(service, placeholders)) {
    lines.push(`Environment=${key}=${escapeSpecifiers(value)}`);
  }

  // The secrets are read by PID 1, as root, before the service enters its
  // namespace, never by the service from a file: EnvironmentFile hands it
  // variables, LoadCredential a private copy of each file, owned by its
  // account, 0400, at $CREDENTIALS_DIRECTORY/files_<name> (measured on
  // systemd 257, the store's bench, Q1 and Q3).
  //
  // The dash lets the service start with a store not written yet: deploy
  // warns of a missing variable, and an app that cannot do without it stops
  // at its start, which the stability check reports.
  //
  // The files' folder has no optional form: missing, it fails every start of
  // every service of the project with 243/CREDENTIALS (bench Q2). Every path
  // that lays this unit lays the folder first, and only `sitesolide remove`,
  // after stopping the units, takes it away (see ./store).
  //
  // The lines depend on the manifest alone, never on what the store holds:
  // setting or removing a variable or a file never rewrites a unit. dashboard
  // and portal have no store and read their own flat file, as 0.7 wrote it.
  if (store) {
    lines.push(`EnvironmentFile=${storeEnvironmentFile(slug)}`, `LoadCredential=${storeCredentials(slug)}`);
  } else {
    lines.push(`EnvironmentFile=-${platformFile(slug)}`);
  }

  lines.push(
    "",
    `ExecStart=${escapeSpecifiers(service.start)}`,
    ...restartLines(service),
    "",
    "# What the service writes belongs to it alone.",
    "UMask=0077",
    "",
    "# Confinement",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadWritePaths=${paths.dataDir}`,
    "",
    "# /srv is replaced by an empty mount, then only this project's folders",
    "# are exposed again in it: the service cannot read the landing nor the",
    "# other sites, even if their Unix permissions allowed it.",
    "TemporaryFileSystem=/srv:ro",
    `BindReadOnlyPaths=${paths.app}`,
    `BindReadOnlyPaths=${paths.publicDir}`,
    `BindPaths=${paths.dataDir}`,
    "",
  );

  if (store) {
    // Every project with a store: EnvironmentFile and LoadCredential are both delivered behind
    // InaccessiblePaths, the service seeing /etc/sitesolide as a folder it
    // can neither list nor read (bench Q3). ProtectProc hides the processes
    // of other accounts; a project's services share one account and see
    // each other, which the model accepts: they receive the same secrets
    // (bench Q4). See withoutStoreLines for the units laid before this.
    lines.push(...STORE_UNIT_COMMENT, ...STORE_UNIT_LINES_AFTER, "");
  } else {
    // dashboard and portal alone (STORELESS_SLUGS), whose flat file holds
    // the owner's password hash: their unit stays as 0.7 wrote it, line for
    // line, without InaccessiblePaths, or systemd could not hand it the file.
    lines.push(...PLATFORM_FILE_COMMENT, "");
  }

  lines.push(
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictNamespaces=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    ...syscallLines(),
    `MemoryMax=${service.memory}`,
    ...resourceLines(service),
    "",
  );

  if (isOutbound) {
    lines.push(
      "# network: outbound. This project reaches an outside API; the network",
      "# confinement is lifted, everything else holds.",
      "",
    );
  } else {
    lines.push(
      "# The only client of this service is Caddy, on the loopback.",
      "#",
      "# THIS BLOCKING ALSO CUTS DNS OFF. This machine's resolvers are those",
      "# of the hosting provider, hence external. Measured on 19 August 2026",
      "# in a transient unit carrying these very two lines:",
      "#",
      "#   to a name        curl: (6) Could not resolve host",
      "#   to an IP         curl: (28) Connection timed out, after the full delay",
      "#   to 127.0.0.1     200, the loopback goes through",
      "#",
      "# Both messages mislead: the first sends one hunting a DNS outage, the",
      "# second a slowness of the remote service. The cure is neither to tinker",
      "# with /etc/resolv.conf nor to lengthen a delay, it is network: outbound",
      "# in the project's sitesolide.json.",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "",
    );
  }

  lines.push(...bindLines(service), "");

  if ("main" in place) {
    // Never enabled on its own: the main unit wants it, at boot as after a
    // deployment, and a second way of starting it would outlive a removal.
    lines.push(service.kind === "scheduled" ? "# No [Install]: started by its timer." : "# No [Install]: started by the project's main unit.", "");
  } else {
    lines.push("[Install]", "WantedBy=multi-user.target", "");
  }

  return lines.join("\n");
}

/**
 * The ports of the machine no project listens on but its own: Caddy's admin
 * API, the range Caddy sends the sites' visitors to, the platform's among
 * them, and the egress proxy with its connectors.
 */
export const DENIED_BINDS = [
  String(CADDY_ADMIN_PORT),
  `${SERVICE_PORTS.first}-${SERVICE_PORTS.last}`,
  `${EGRESS_PROXY_PORT}-${CONNECTORS_PORT}`,
];

/**
 * Where a service may listen. The loopback rule judges who connects to a
 * port, never who answers on it, and a project's account may bind any port
 * left free: Caddy, which reaches the whole range, then connects to whoever
 * listens. A compromised app waiting on the portal's port while the portal
 * restarts, during an upgrade, would answer every forward_auth with the
 * identity it likes and receive the owner's password typed on a sign-in
 * page; on the egress proxy's ports, every project's outgoing requests; on a
 * neighbour's port between two of its restarts, that site's visitors. A
 * server listens on its own port alone, a worker and a scheduled service on
 * none of them. Ports outside these stay free: what a project binds there
 * nobody else is sent to.
 *
 * SocketBindAllow wins over SocketBindDeny, which is what lets the server's
 * own port through the range. Every unit generated before carries none of
 * these lines, and is still the generator's own: see withoutBindLines.
 */
function bindLines(service: ServiceView): string[] {
  return [
    service.port === null
      ? "# Listens on none of the machine's ports: not a neighbour's, nor the platform's."
      : "# Listens on its own port, and on none of the machine's others.",
    ...(service.port === null ? [] : [`SocketBindAllow=tcp:${service.port}`]),
    ...DENIED_BINDS.map((ports) => `SocketBindDeny=${ports}`),
  ];
}

/**
 * A generated unit as the generator wrote it before the bind lines: the unit
 * of every project deployed until then. Recognised as the generator's own, it
 * is replaced at the next deployment without `--force`, rather than read as
 * edited by hand on every machine at once.
 */
export function withoutBindLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^# Listens on (its own port|none of the machine's ports)/.test(lines[i]!)) {
      kept.push(lines[i]!);
      continue;
    }
    // The block bindLines writes: its comment, its lines, the blank after.
    while (lines[i + 1]?.startsWith("SocketBind")) i++;
    if (lines[i + 1] === "") i++;
  }
  return kept.join("\n");
}

/**
 * The system calls a service may make: systemd's `@system-service` set, the
 * one the platform's own services run under (infra/), which a Bun, Node,
 * Python or Go server needs, and none of the calls that change the machine
 * rather than the process: mounting, loading a module, rebooting, swapping,
 * setting the clock, tracing another process, raw I/O. A kernel flaw reached
 * through one of those is out of a project's reach.
 *
 * A call outside the set fails with EPERM, as one the account may not make,
 * rather than killing the process as systemd would by default: a runtime that
 * probes for a call goes on without it, and a program that needs one says so
 * in its own error instead of dying with status=31/SYS and restarting every
 * two seconds. Measured on 19 October 2026 on a Debian 13 machine on x86_64,
 * Bun 1.3.14 and 1.4.3, Node 20, Python 3.13, Go 1.24: Node calls pkey_alloc
 * as it starts, for V8's memory protection keys, and the default action
 * killed it there, as it did not on arm64; with EPERM it serves. `native` closes the 32-bit
 * entry points of an x86_64 kernel, which the filter would otherwise judge by
 * other numbers.
 *
 * Every unit generated before carries none of these lines, and is still the
 * generator's own: see earlierGenerations.
 */
function syscallLines(): string[] {
  return [
    "# The system calls of a service, and none that changes the machine: no",
    "# mount, module, reboot, swap, clock or tracing. Any other fails with EPERM.",
    "SystemCallArchitectures=native",
    "SystemCallFilter=@system-service",
    "SystemCallErrorNumber=EPERM",
  ];
}

/** A generated unit as the generator wrote it before syscallLines: the units of 0.6. */
export function withoutSyscallLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "# The system calls of a service, and none that changes the machine: no") {
      kept.push(lines[i]!);
      continue;
    }
    // The block syscallLines writes: its comment, then its lines.
    if (lines[i + 1]?.startsWith("# ")) i++;
    while (lines[i + 1]?.startsWith("SystemCall")) i++;
  }
  return kept.join("\n");
}

/** `EnvironmentFile=-/etc/sitesolide/projects/<slug>/env`, whatever the slug. */
function isStoreEnvironmentLine(line: string): boolean {
  return line.startsWith(`EnvironmentFile=-${STORE_ROOT}/`) && line.endsWith("/env");
}

/** A `LoadCredential=` whose path, after the credential's id, lies in the stores' folder. */
function isStoreCredentialLine(line: string): boolean {
  if (!line.startsWith("LoadCredential=")) return false;
  const value = line.slice("LoadCredential=".length);
  return value.slice(value.indexOf(":") + 1).startsWith(`${STORE_ROOT}/`);
}

/**
 * A unit as 0.7 generated it, from what this release generates.
 *
 * Every project but dashboard and portal now reads its store, and every
 * unit in service would otherwise read as edited by hand at its next
 * deployment. Taken off: the store's `EnvironmentFile=` and
 * `LoadCredential=`, and `ProtectProc=invisible`. The comment above them
 * becomes the one 0.7 wrote there, so that a text this release generated
 * comes back as 0.7 wrote it, byte for byte; the comparison ignores comments
 * anyway, and a text of another making only loses those directives.
 */
export function withoutStoreLines(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (STORE_UNIT_COMMENT.every((comment, offset) => lines[i + offset] === comment)) {
      kept.push(...NO_SECRET_COMMENT);
      i += STORE_UNIT_COMMENT.length - 1;
      continue;
    }
    if (isStoreEnvironmentLine(line) || isStoreCredentialLine(line) || line === "ProtectProc=invisible") continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * What earlier releases generated where this one generates `text`, newest
 * first: without the store's lines, as 0.7 wrote it, then also without the
 * system-call filter, as 0.6 did, then also without the bind lines, as
 * every release before; and the two this list held before the store,
 * without the filter, then without the bind lines either. A unit in service
 * that reads as one of them was never edited by hand, and is replaced at the
 * project's next deployment without `--force`, by `deploy`, `refresh` and
 * the installer alike.
 */
export function earlierGenerations(text: string): string[] {
  const beforeStore = withoutStoreLines(text);
  const beforeStoreAndFilter = withoutSyscallLines(beforeStore);
  const beforeFilter = withoutSyscallLines(text);
  return [beforeStore, beforeStoreAndFilter, withoutBindLines(beforeStoreAndFilter), beforeFilter, withoutBindLines(beforeFilter)];
}

/**
 * How a service comes back. A server as it always did, two seconds after it
 * stopped. A worker too, but each restart systemd makes on its own waits
 * longer, up to five minutes: a worker that dies at once on an outside API's
 * error would otherwise call it, and pay for it, every two seconds. The count
 * behind the delay starts again at every start asked of systemd, a deployment
 * or a restart from the dashboard, not after a while running fine. A scheduled run is
 * never restarted: the next time its timer names runs it again, and
 * RuntimeMaxSec stops a run that outlasts its timeout.
 */
function restartLines(service: ServiceView): string[] {
  switch (service.kind) {
    case "server":
      return ["Restart=always", "RestartSec=2"];
    case "worker":
      return ["Restart=always", "RestartSec=2", "RestartSteps=8", "RestartMaxDelaySec=5min"];
    case "scheduled":
      return ["Restart=no", `RuntimeMaxSec=${service.timeout}`];
  }
}

/**
 * The processor, beside the memory. A server keeps the machine's defaults, so
 * that the unit of every site in service stays as it is; a worker and a
 * scheduled run work in the background, and yield to the sites when the
 * processor is contended: CPUWeight 20 against the default 100 gives a busy
 * site five times their share. TasksMax bounds the processes and threads, a
 * runaway pool or a browser's children. `cpu` caps any of them, CPUQuota
 * being a share of one core.
 */
function resourceLines(service: ServiceView): string[] {
  const lines = service.kind === "server" ? [] : ["CPUWeight=20", "TasksMax=512"];
  if (service.cpu !== null) lines.push(`CPUQuota=${service.cpu}`);
  return lines;
}

// --- a project's program, run outside its service --------------------------------

/** One program run as the project's account, in a transient unit. */
export type ProjectRun = {
  slug: string;
  purpose: "extract" | "install";
  /** Fixed paths only: nothing a manifest or an archive wrote ever goes into the arguments. */
  command: string[];
  /** Its standard input: the archive's descriptor, the install command's text, or none. */
  stdin: number | Uint8Array | null;
  /** The only directories of /srv it sees: `source` mounted at `target`, writable. */
  binds: { source: string; target: string }[];
  workingDirectory: string | null;
  /** Outbound network, never the loopback. Off for the extraction. */
  network: boolean;
  timeoutS: number;
  memory: string;
};

/**
 * The `systemd-run` line for a project's program: the generated unit's
 * confinement, the binds alone visible under /srv, and the limits. The
 * installer runs the extraction and `install` with it for a token
 * (dashboard/src/installer/real.ts), and `deploy` its `install` over SSH, see
 * sandboxedInstallCommand: one writing of the walls for both paths.
 */
export function systemdRunArguments(run: ProjectRun, systemdRun = "/usr/bin/systemd-run"): string[] {
  const account = systemUser(run.slug);
  const properties = [
    `User=${account}`,
    `Group=${account}`,
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictNamespaces=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "UMask=0022",
    // The generated unit's own pattern for its data folder: /srv emptied, the
    // directory bound back in, and declared writable for ProtectSystem=strict.
    "TemporaryFileSystem=/srv:ro",
    ...run.binds.flatMap(({ source, target }) => [`BindPaths=${source}:${target}`, `ReadWritePaths=${target}`]),
    "InaccessiblePaths=-/etc/sitesolide",
    `MemoryMax=${run.memory}`,
    `RuntimeMaxSec=${run.timeoutS}`,
    "TasksMax=256",
    // The extraction needs no network at all; an install fetches packages, but
    // never reaches the loopback, where every other project listens. Nor does
    // it hold one of the machine's ports for its fifteen minutes: the
    // portal's, held, could not start again (bindLines).
    ...(run.network ? ["IPAddressDeny=localhost"] : ["PrivateNetwork=yes", "IPAddressDeny=any"]),
    ...DENIED_BINDS.map((ports) => `SocketBindDeny=${ports}`),
    ...(run.workingDirectory === null ? [] : [`WorkingDirectory=${run.workingDirectory}`]),
  ];
  return [
    systemdRun,
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    // Nothing expanded in the command line (systemd 254 and later), which only
    // carries fixed paths anyway.
    "--expand-environment=no",
    `--description=sitesolide ${run.purpose} for ${run.slug}`,
    ...properties.flatMap((property) => ["-p", property]),
    "-E",
    "HOME=/tmp",
    "-E",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "-E",
    "CI=1",
    ...run.command,
  ];
}

/**
 * The remote command `deploy` runs a manifest's `install` with over SSH: as
 * the project's own account, in the walls the installer gives it for a token,
 * the network but never the loopback, /srv hidden but `app/`, nothing of
 * /etc/sitesolide, a throwaway HOME, fifteen minutes and 1G at most. The
 * install command itself travels on standard input, to `sh -s`: systemd
 * expands `$VAR` and `%` in a unit's command line, and the manifest's text
 * must reach the shell exactly as it was written.
 *
 * It used to run as the deployment account, which holds sudo without a
 * password (sitesolide setup gives it that), outside any sandbox; and `bun install`
 * and `uv sync` run the lifecycle scripts of what they fetch. Any package one
 * of them pulled had root on the machine that serves every site.
 *
 * `app/` belongs to the deployment account, so that the service cannot
 * rewrite its own code. It is handed to the project's account for the length
 * of the install, then back, whatever the install's outcome: a failed one
 * leaving `app/` to the project would refuse the next rsync. `-h` never
 * follows a link the install laid, and the service keeps seeing `app/`
 * read-only meanwhile, through its own unit.
 */
export function sandboxedInstallCommand(slug: string, owner: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (!/^[a-z_][a-z0-9_.-]*$/.test(owner)) throw new Error(`unexpected account: ${owner}`);
  const app = projectPaths(slug).app;
  const account = systemUser(slug);
  const run = systemdRunArguments({
    slug,
    purpose: "install",
    command: ["/bin/sh", "-s"],
    stdin: null,
    binds: [{ source: app, target: app }],
    workingDirectory: app,
    network: true,
    timeoutS: 900,
    memory: "1G",
  });
  // Every argument is fixed or built from the slug; a quote among them would
  // break out of the double quotes below.
  if (run.some((argument) => /["'$`\\]/.test(argument))) throw new Error("unexpected character in the systemd-run line");
  const line = run.map((argument) => `"${argument}"`).join(" ");
  return `sudo sh -c 'chown -hR ${account}:${account} ${app} && ${line}; code=$?; chown -hR ${owner}:${owner} ${app}; exit $code'`;
}

/**
 * What the machine answers when asked about a file it carries, or does not. Two
 * words, and nothing else is recognised.
 *
 * **An empty output is not an absence.** A refused `sudo`, an ssh that does not
 * get through or a remote shell that balks give the same emptiness, and
 * mistaking it for "the file is not there" would deposit over what is in
 * service. It is the only path by which `deploy` could replace a unit or a
 * secret without meaning to, and these two markers close it.
 */
export const MARKER_ABSENT = "ABSENT";
export const MARKER_PRESENT = "PRESENT";

export type UnitRead =
  | { kind: "absent" }
  | { kind: "present"; content: string }
  | { kind: "unreadable" };

/**
 * The answer to the reading of a unit: the marker, then the file as is. The
 * marker comes first rather than in place of an empty output, a unit being able
 * to be empty without being absent.
 */
export function readUnitAnswer(output: string): UnitRead {
  if (output.trim() === MARKER_ABSENT) return { kind: "absent" };
  if (output.startsWith(`${MARKER_PRESENT}\n`)) {
    return { kind: "present", content: output.slice(MARKER_PRESENT.length + 1) };
  }
  return { kind: "unreadable" };
}

export type PresenceRead = { kind: "absent" } | { kind: "present" } | { kind: "unreadable" };

/**
 * The answer of a remote presence test, `test -f` printing one marker or
 * the other. Anything that is neither marker, an empty output included,
 * reads as a failure: a refused sudo prints nothing, and taking that silence
 * for an absence would act on a file that is there.
 */
export function readPresenceAnswer(output: string): PresenceRead {
  const clean = output.trim();
  if (clean === MARKER_ABSENT) return { kind: "absent" };
  if (clean === MARKER_PRESENT) return { kind: "present" };
  return { kind: "unreadable" };
}

export type UnitState = {
  /** What /etc/systemd/system/<slug>.service holds, "" if the file is missing. */
  installed: string;
  /** What the manifest generates today. */
  generated: string;
  /** --force, the deliberate act of switching to the generated one. */
  replace: boolean;
  /**
   * What the generator makes of this unit from the manifest the previous
   * deployment deposited on the machine, null when there is none or it does
   * not read: a unit that matches it, or one of its earlier generations, is
   * the generator's own, and a changed manifest replaces it.
   */
  previous?: string | null;
};

export type UnitAction = "install" | "present" | "diverged";

/**
 * What is to be done with a project's unit, so that `deploy` can put it in
 * place on the first pass without ever replacing the one running a service.
 *
 * Hand-written units carry decisions the manifest cannot express:
 * a unit that needs a device may drop `PrivateDevices` on purpose, saying
 * why. Replacing it because a deployment happened to pass by would cut that
 * device off without anyone having asked for it, and that is exactly
 * what `diverged` avoids: the divergence is reported, and `--force` settles it.
 *
 * Returning `present` on an equivalent unit is what makes `deploy` idempotent:
 * the second pass deposits nothing, reloads nothing, and says nothing. The
 * equivalence is about the directives and not about the text, failing which a
 * hand-written unit would be declared divergent at every deployment for its
 * comments alone, while running exactly the same service. See comparison.ts.
 *
 * A unit an earlier release generated, before the store's lines, the bind
 * lines or the system-call filter, is the generator's own, not one edited by
 * hand: installed, so that every project takes them at its next deployment.
 * See earlierGenerations.
 *
 * So is a unit generated from the manifest the previous deployment left on
 * the machine, by this release or an earlier one: a changed manifest, a port,
 * an `env` or a secret's name replaces it,
 * rather than every manifest change asking for --force. Only what neither
 * manifest generates was edited by hand.
 */
export function decideUnit(state: UnitState): UnitAction {
  if (state.installed.trim() === "") return "install";
  if (sameDirectives(state.installed, state.generated)) return "present";
  if (earlierGenerations(state.generated).some((earlier) => generatedAs(state.installed, earlier))) return "install";
  const previous = state.previous ?? null;
  if (previous !== null && [previous, ...earlierGenerations(previous)].some((earlier) => generatedAs(state.installed, earlier))) return "install";
  return state.replace ? "install" : "diverged";
}

/**
 * Whether a unit in service is what the generator wrote as `earlier`, to be
 * replaced without --force: the same directives, and its `EnvironmentFile=`
 * lines in the same order and number. sameDirectives compares sets, which
 * suits a unit kept as it is; one about to be replaced is held to more,
 * since a hand edit that names a file again last, or reorders them, adds no
 * line and still decides which value wins, systemd reading them in order.
 * earlierGenerations only takes lines away, so the order it leaves is the
 * one that release wrote.
 */
export function generatedAs(installed: string, earlier: string): boolean {
  if (!sameDirectives(installed, earlier)) return false;
  const read = environmentFiles(installed);
  const written = environmentFiles(earlier);
  return read.length === written.length && read.every((line, i) => line === written[i]);
}

/** A unit's `EnvironmentFile=` lines in the order systemd reads them, a repeat kept. */
function environmentFiles(text: string): string[] {
  return usefulDirectives(text).filter((line) => line.startsWith("EnvironmentFile="));
}
