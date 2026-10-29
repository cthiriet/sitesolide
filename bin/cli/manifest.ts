/**
 * The `sitesolide.json` manifest, read at the root of the deployed repository.
 *
 * An input format, hand-written in arbitrary repositories just like a
 * `package.json`, hence its keys in English, like the whole of the CLI's
 * interface. `KNOWN_KEYS` lists them all.
 *
 * It is a site's only configuration file, on both sides: it is versioned in the
 * repository and deposited as is at the root of the project on the VM, where
 * api/src/table.ts and the dashboard's gatekeeper read it again. The
 * `site.json` with French keys that held this role is gone: two files for a
 * single state ended up diverging, and the lock showed it.
 *
 * This whole file is pure: nothing in it touches the disk or the network, so
 * that every refusal from `validate()` is checkable without a server.
 */
import { MACHINE_FOLDER } from "./backups";
import { egressErrors } from "./egress";
import {
  buildNameRefusal,
  checkKey,
  isVariableName,
  looksLikeSecretValue,
  MAX_KEY,
  PASSWORD_VARIABLE,
  RESERVED_ENV,
  VALUE_LIKE_PREFIXES,
} from "./variables";

/** Defined in ./variables with the other rules of a variable's name, and re-exported where it always was. */
export { RESERVED_ENV } from "./variables";

/**
 * One process of a project that runs several, declared under `services`: a web
 * front, the API it calls, a worker behind it. Each one becomes a systemd unit
 * of its own, under the project's system user, with the project's directories
 * and secrets.
 *
 * Three kinds, see ServiceKind: a server listens on its `port`; an internal
 * service without one is a worker, which runs for good and listens on
 * nothing; a service with a `schedule` runs at the times it names, and
 * between them nothing runs.
 */
export type Service = {
  start: string;
  /** The loopback port it listens on; absent for a worker or a scheduled service. */
  port?: number;
  /** The paths Caddy sends to this service. Absent: every path no other service claims. */
  routes?: string[];
  /** Reached by the project's other services only, never by Caddy. */
  internal?: boolean;
  memory?: string;
  /** The processor ceiling, as systemd's CPUQuota takes it: `50%` is half of one core. */
  cpu?: string;
  /** Added to the project's `env`, and winning over it on a shared name. */
  env?: Record<string, string>;
  /** The folder of the data this service keeps live, and how a consistent copy of it is made, see ServiceBackup. */
  backup?: ServiceBackup;
  /** When it runs, a systemd calendar expression such as `hourly` or `*:0/15`, see isValidSchedule. */
  schedule?: string;
  /** How long one scheduled run may take before systemd stops it, see isValidTimeout. */
  timeout?: string;
};

/**
 * How the hourly snapshot saves a folder of the data that a service keeps
 * live, a PostgreSQL or MongoDB cluster for one: copied file by file while
 * the server writes, it would be archived as no server can start from it.
 *
 * `command` runs just before the copy, as the project, with the service's
 * environment and `BACKUP_DIR`, an empty folder outside the data. It leaves
 * there a consistent copy the service can start from as `folder`, and the
 * archive holds that copy under `data/<folder>`, never the live files. See
 * dashboard/src/backup/README.md and docs/manifest.md.
 */
export type ServiceBackup = {
  /** Relative to the data folder: the folder the service keeps live. */
  folder: string;
  /** Run like `start`, whose rules it follows: see commandErrors and commandWords. */
  command: string;
};

/** What a repository declares in order to be deployable. */
export type Manifest = {
  slug: string;
  description?: string;
  /** Where the code lives, when not beside the manifest, see isSourcePath. */
  source?: string;
  publicDir?: string;
  build?: string;
  install?: string;
  start?: string;
  port?: number;
  routes?: string[];
  /** Several processes instead of one `start`, see Service. */
  services?: Record<string, Service>;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  exclude?: string[];
  memory?: string;
  /** The processor ceiling of every service, as a service's own `cpu` overrides it. */
  cpu?: string;
  network?: "localhost" | "outbound";
  /**
   * The names of the project's secrets, never a value: a list of variable
   * names, the short form, or SecretsLongForm when a file or a build secret
   * is needed: see secretsOf.
   */
  secrets?: string[] | SecretsLongForm;
  domain?: { name: string; aliases?: string[]; active?: boolean };
  lock?: boolean;
  /** The site goes behind the shared portal, see portal/README.md. */
  portal?: boolean;
  /** The paths the portal lets through: signed webhooks, above all. */
  portalExempt?: string[];
  /** The hosts reachable through the egress proxy, see bin/cli/egress.ts. */
  egress?: string[];
  /** The connectors asked for; a grant on the machine allows them, see bin/cli/egress.ts. */
  connectors?: string[];
  /**
   * `false` keeps the data folder out of the machine's snapshots, see
   * isBackedUp. An object is the single service's own backup command, in the
   * form with one `start`, as `start` and `port` are its own: see ServiceBackup.
   */
  backup?: false | ServiceBackup;
};

/**
 * Every key this file knows how to read. Another one is a typo, and a typo on
 * `portal` or `lock` would deploy an open site its author believes closed: it
 * is therefore refused rather than passed over in silence.
 */
export const KNOWN_KEYS = [
  "slug",
  "description",
  "source",
  "publicDir",
  "build",
  "install",
  "start",
  "port",
  "routes",
  "services",
  "env",
  "headers",
  "exclude",
  "memory",
  "cpu",
  "network",
  "secrets",
  "domain",
  "lock",
  "portal",
  "portalExempt",
  "egress",
  "connectors",
  "backup",
];

/** The keys of one entry of `services`, refused beyond these for the same reason. */
export const SERVICE_KEYS = ["start", "port", "routes", "internal", "memory", "cpu", "env", "backup", "schedule", "timeout"];

/** The keys of a service's `backup`, refused beyond these for the same reason. */
export const BACKUP_KEYS = ["folder", "command"];

/** A range of ports, both ends included: a single port has `first` equal to `last`. */
export type PortRange = { readonly first: number; readonly last: number };

/**
 * The services' ports, in two blocks. The loopback rule reserves them to
 * Caddy and root, see bin/cli/loopback.ts, and every generated unit denies
 * them to a service but its own port, see DENIED_BINDS in bin/cli/unit.ts.
 * They live here because the manifest's validation needs them too, and this
 * file is the one the dashboard borrows. Every reader goes through this list,
 * isServicePort and the formatters below, never through a number of its own.
 *
 * The first, 3000 to 3099: 3000 the landing, 3001 the shared service, then
 * the sites and the projects. The only one until the second was added, and
 * still valid, so that every manifest and every machine in service keeps
 * working: with the platform's own ports taken, it held fewer than a hundred
 * servers, and a project with a database takes two.
 *
 * The second, 21000 to 29999, nine thousand more. Not 3100 and up: 3128 and
 * 3129, the egress proxy's, sit right above, and 2019, Caddy's admin API,
 * below, each outside on purpose with rules of its own. Not 20000: the
 * tunnel's connector serves its metrics on 20240, which the monitor reads as
 * its own account, and cloudflared takes 20241 to 20245 by default
 * (TUNNEL_METRICS in bin/cli/tunnel.ts). And below 32768, where Linux's
 * ephemeral ports begin, so that no outgoing connection ever takes one of its
 * ports as its source.
 *
 * A machine opens the second block only once every project unit on it denies
 * it and its loopback rule reserves it: until then `deploy` and the installer
 * refuse a port there (secondBlockRefusal in bin/cli/services.ts).
 */
export const SERVICE_PORT_RANGES: readonly PortRange[] = [
  { first: 3000, last: 3099 },
  { first: 21000, last: 29999 },
];

/** The block every machine has reserved since the loopback rule exists. */
export const FIRST_BLOCK: PortRange = SERVICE_PORT_RANGES[0]!;

/** Is `port` one of `range`'s? */
export function inPortRange(range: PortRange, port: number): boolean {
  return Number.isInteger(port) && port >= range.first && port <= range.last;
}

/** Is `port` a port a service may be given: a whole number inside one of the blocks? */
export function isServicePort(port: number): boolean {
  return SERVICE_PORT_RANGES.some((range) => inPortRange(range, port));
}

/** Is `port` a service's port outside the first block, one a machine opens late? */
export function inLaterBlock(port: number): boolean {
  return isServicePort(port) && !inPortRange(FIRST_BLOCK, port);
}

/** A range as systemd's `SocketBindDeny=` and nftables write it: `3000-3099`, or `2019` alone. */
export function portRangeText(range: PortRange): string {
  return range.first === range.last ? String(range.first) : `${range.first}-${range.last}`;
}

/** The blocks in a sentence: `3000 to 3099 or 21000 to 29999`. */
export function servicePortsProse(): string {
  return SERVICE_PORT_RANGES.map((range) => `${range.first} to ${range.last}`).join(" or ");
}

/** The slug of the portal itself, which cannot put itself behind its own door. */
export const PORTAL_SLUG = "portal";

/** Default memory ceiling, the one of the units already in service. */
export const DEFAULT_MEMORY = "256M";

/**
 * How long a scheduled run may take when its service names no `timeout`. A
 * run that hangs would otherwise hold its unit for good, and the timer, which
 * never starts a unit already running, would skip every run after it.
 */
export const DEFAULT_TIMEOUT = "1h";

/** The longest a scheduled run may be given: a run of a day is a worker. */
export const MAX_TIMEOUT_SECONDS = 24 * 3600;

/**
 * The slug becomes a DNS label, `<slug>.<zone>`, and a directory name inside a
 * path built by Caddy. Stricter than api's `isValidSlug`, which accepts dots
 * because it also reads the zone's directory, the landing's: a slug generated
 * here never has a dot.
 */
export function isValidSlug(slug: string): boolean {
  return slug.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/**
 * The names a slug may not take, because the machine already runs something
 * of that name that deploy must never replace.
 *
 * A project's unit is `/etc/systemd/system/<slug>.service`, while the units of
 * the system's own packages live in /lib/systemd/system: finding no file of
 * that name in /etc, deploy would lay one there, and systemd reads /etc first.
 * A project called `caddy` would replace the web server of every site at its
 * first restart, one called `ssh` the way into the machine. The list names
 * what an Ubuntu cloud image and this platform run; the machine itself is
 * asked before anything is written, for the units no list foresees, see
 * unitOriginsCommand in services.ts.
 *
 * `www` is not a unit: the landing's block serves `www.<zone>`, and a project
 * of that name would never be reached. Nor is `public`: the wildcard block
 * roots a host at `/srv/sites/<first label>/public`, and a host whose first
 * label is empty, `.<zone>`, still matches it, rooted at `/srv/sites//public`,
 * which is `/srv/sites/public`: a project of that name would have its
 * manifest and its code served from there, past its portal or its lock. The platform's own projects, the
 * dashboard, the portal and analytics, are not here: their owner deploys them
 * with this very validation. A token may not, see RESERVED_SLUGS in
 * dashboard/src/control/policy.ts.
 */
export const SYSTEM_NAMES: readonly string[] = [
  "www",
  "public",
  "caddy",
  "ssh",
  "sshd",
  "dbus",
  "cron",
  "atd",
  "nftables",
  "networking",
  "rsyslog",
  "chrony",
  "ufw",
  "apparmor",
  "polkit",
  "snapd",
  "udev",
  "getty",
  "sudo",
  "rsync",
  "logrotate",
  "fstrim",
  "cloud-init",
  "cloud-config",
  "cloud-final",
  "unattended-upgrades",
  "apt-daily",
  "apt-daily-upgrade",
];

/** Whole families of units: systemd's own, and the platform's services, all `sitesolide-*`. */
export const SYSTEM_PREFIXES: readonly string[] = ["systemd-", "sitesolide-"];

export function isSystemName(slug: string): boolean {
  return SYSTEM_NAMES.includes(slug) || SYSTEM_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

/** Same rule as api's `isValidDomain`: what passes here must pass there too. */
export function isValidDomain(domain: string): boolean {
  return (
    domain.length > 0 &&
    domain.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  );
}

/**
 * A path declared in the manifest must never leave the deployed repository:
 * `publicDir` is the source of an rsync, and a `..` there would send any
 * directory on the workstation off to the VM.
 */
export function isInternalPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[/\\]/).some((part) => part === "..");
}

/**
 * `source` names the folder whose content leaves, when the code lives in a
 * repository of its own that should carry nothing about its deployment: the
 * manifest then stays in the sites repository, and points at it.
 *
 * Relative to the manifest's folder, `..` included, since the code is
 * elsewhere by definition. Never absolute: `/Users/<name>/...` would name the
 * workstation that wrote it, and fail on every other one.
 */
export function isSourcePath(path: string): boolean {
  if (path.length === 0 || /[\r\n]/.test(path)) return false;
  return !path.startsWith("/") && !path.startsWith("~") && !/^[a-zA-Z]:/.test(path);
}

/** `256M`, `1G`, `524288K`. A bare number would be accepted by systemd as bytes. */
export function isValidMemory(memory: string): boolean {
  return /^[0-9]+[KMG]$/.test(memory);
}

/**
 * `50%`, `200%`: systemd's CPUQuota, a share of one core, so `200%` is two
 * whole cores. A bare number means nothing to systemd, and a share above
 * what any machine of this platform carries is a typo.
 */
export function isValidCpu(cpu: unknown): cpu is string {
  if (typeof cpu !== "string" || !/^[1-9][0-9]{0,3}%$/.test(cpu)) return false;
  return Number(cpu.slice(0, -1)) <= 6400;
}

/**
 * A systemd calendar expression, as `OnCalendar=` takes it: `hourly`,
 * `daily`, `*:0/15` for every quarter of an hour, `Mon..Fri 08:00`,
 * `*-*-* 06:30:00 Europe/Paris`. Written into the timer as it is, so one line
 * of the characters such an expression uses, nothing systemd would read as a
 * specifier (`%`) or a continuation (`\`).
 *
 * Whether systemd understands it is systemd's to say: `deploy` asks
 * `systemd-analyze calendar` on the machine before anything is written, see
 * scheduleCheckCommand in services.ts. What passes here is only safe to
 * write, not necessarily a time.
 */
export function isValidSchedule(schedule: unknown): schedule is string {
  return (
    typeof schedule === "string" &&
    schedule.length <= 128 &&
    /^[A-Za-z0-9*]/.test(schedule) &&
    /^[A-Za-z0-9*:/.,~_+ -]+$/.test(schedule) &&
    !schedule.endsWith(" ")
  );
}

/**
 * How long a scheduled run may take: `90s`, `15m`, `2h`, which systemd's
 * RuntimeMaxSec reads as seconds, minutes and hours. A day at most.
 */
export function isValidTimeout(timeout: unknown): timeout is string {
  const seconds = timeoutSeconds(timeout);
  return seconds !== null && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS;
}

/** A timeout in seconds, or null when it is not written as isValidTimeout takes it. */
export function timeoutSeconds(timeout: unknown): number | null {
  if (typeof timeout !== "string") return null;
  const match = /^([0-9]{1,5})(s|m|min|h)$/.exec(timeout);
  if (match === null) return null;
  const unit = { s: 1, m: 60, min: 60, h: 3600 }[match[2] as "s" | "m" | "min" | "h"];
  return Number(match[1]) * unit;
}

/**
 * A secret is never written into a versioned file. `env` is made for what has
 * nothing to hide, `NODE_ENV` or an AWS region; what does hide is named under
 * `secrets` and set on the server. The check is on the name first: everybody
 * recognises a key named `API_KEY`. A value that starts like a provider's key
 * is refused too, whatever its name, see SECRET_VALUE_PREFIXES in
 * ./variables; a name a framework publishes anyway is let through, see
 * FRAMEWORK_PUBLIC_PREFIXES.
 */
export const SUSPICIOUS_ENV = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS)$/;

/**
 * The prefixes under which a framework publishes a variable into the code it
 * sends to every visitor: whatever such a name holds is public by
 * construction, so SUSPICIOUS_ENV does not refuse it, and
 * `NEXT_PUBLIC_STRIPE_KEY` may sit in `env`. The platform imposes no prefix of
 * its own: this list only relaxes a refusal.
 */
export const FRAMEWORK_PUBLIC_PREFIXES: readonly string[] = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "REACT_APP_", "VITE_", "PUBLIC_", "GATSBY_"];

/** Does a framework publish this variable to every visitor anyway? See FRAMEWORK_PUBLIC_PREFIXES. */
export function isFrameworkPublic(name: string): boolean {
  return FRAMEWORK_PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The service is an application as soon as it declares a start command. */
export function isApp(manifest: Manifest): boolean {
  return (typeof manifest.start === "string" && manifest.start.length > 0) || hasServices(manifest);
}

/** Does the project declare its processes under `services`, rather than one `start`? */
export function hasServices(manifest: Manifest): boolean {
  const services = manifest.services;
  return typeof services === "object" && services !== null && !Array.isArray(services) && Object.keys(services).length > 0;
}

/**
 * A service name becomes the second half of a unit name, `<slug>.<name>`, and a
 * Caddy matcher name. The dot between the two is what keeps units apart: a
 * slug never carries one, so `shop.api` can only belong to `shop`, where
 * `shop-api` could be another project's slug.
 */
export function isValidServiceName(name: string): boolean {
  return name.length <= 32 && /^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name) && !UNIT_TYPES.includes(name);
}

/**
 * The unit types of systemd. A name ending in one of them is read as that
 * type: `lab.socket` addresses a socket unit, not `lab.socket.service`, and
 * a restart or a removal would reach the wrong unit. The leading letter keeps
 * integer-like names out, which JavaScript would sort before the others and
 * silently make the main service.
 */
const UNIT_TYPES = ["service", "socket", "device", "mount", "automount", "swap", "target", "path", "timer", "slice", "scope"];

/**
 * What a service is, from what its manifest says:
 *
 * - `server`: it listens on its `port`, for Caddy or for its siblings, and
 *   runs for good;
 * - `worker`: internal, no port, no schedule. It runs for good and listens on
 *   nothing: a queue's consumer, a bot holding a connection, an agent;
 * - `scheduled`: it has a `schedule`. A timer starts it at the times it names,
 *   it runs to its end, and nothing runs between two runs.
 */
export type ServiceKind = "server" | "worker" | "scheduled";

/** One process as the deployment sees it, whichever way the manifest declared it. */
export type ServiceView = {
  /** Its name under `services`, null for a project with a single `start`. */
  name: string | null;
  /**
   * The systemd unit, without `.service`. The main service keeps the slug, so
   * that every tool naming a project's unit after its folder, the dashboard,
   * the steward and the collector, still finds the one that stands for the
   * whole project. The others are `<slug>.<name>`. See mainService.
   */
  unit: string;
  kind: ServiceKind;
  start: string;
  /** Null for a worker and a scheduled service, which listen on nothing. */
  port: number | null;
  routes?: string[];
  /** Never reached by Caddy: an internal server, a worker, a scheduled service. */
  internal: boolean;
  memory: string;
  /** Its CPUQuota, the service's own or the project's, null for none. */
  cpu: string | null;
  env: Record<string, string>;
  /** Its backup command and the live folder it saves, or null. Read as written: validate() judges it. */
  backup: ServiceBackup | null;
  /** Its calendar expression, for a scheduled service alone. */
  schedule: string | null;
  /** How long one of its runs may take, for a scheduled service alone. */
  timeout: string | null;
};

/** A `backup` that has the shape of a command's, as servicesOf reads one: the judging is validate()'s. */
function asServiceBackup(value: unknown): ServiceBackup | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ServiceBackup) : null;
}

/** What a declared service is, see ServiceKind. Read as written: validate() judges it. */
function kindOf(service: Service): ServiceKind {
  if (service.schedule !== undefined) return "scheduled";
  if (service.internal === true && service.port === undefined) return "worker";
  return "server";
}

/**
 * Every process of the project, the main one first. Empty for a static site.
 *
 * The main service is the first one that runs for good, in the written order:
 * its unit keeps the slug, and it is the one the project is known by. A
 * scheduled service is never it, being inactive between two runs; a project
 * whose every service is scheduled has an anchor for its main unit instead,
 * see isAnchored. A project with no scheduled service keeps its written
 * order, its units and their names unchanged.
 *
 * A project with a single `start` gives one entry built from its top-level
 * keys, exactly those the generators read before `services` existed: its unit
 * and its block come out unchanged.
 */
export function servicesOf(manifest: Manifest): ServiceView[] {
  if (hasServices(manifest)) {
    // Tolerant of a broken entry, which validate() reports: the dashboard reads
    // the manifests on the machine as they are, and one bad line must not take
    // the whole page down.
    const entries = Object.entries(manifest.services!).filter(
      ([, service]) => typeof service === "object" && service !== null && !Array.isArray(service),
    );
    const main = entries.findIndex(([, service]) => kindOf(service) !== "scheduled");
    const ordered = main <= 0 ? entries : [entries[main]!, ...entries.slice(0, main), ...entries.slice(main + 1)];
    return ordered.map(([name, service], rank) => {
      const kind = kindOf(service);
      return {
        name,
        unit: rank === 0 && main !== -1 ? manifest.slug : `${manifest.slug}.${name}`,
        kind,
        start: service.start,
        port: typeof service.port === "number" ? service.port : null,
        routes: service.routes,
        internal: service.internal === true || kind !== "server",
        memory: service.memory ?? manifest.memory ?? DEFAULT_MEMORY,
        cpu: service.cpu ?? manifest.cpu ?? null,
        env: { ...manifest.env, ...service.env },
        backup: asServiceBackup(service.backup),
        schedule: kind === "scheduled" ? service.schedule! : null,
        timeout: kind === "scheduled" ? (service.timeout ?? DEFAULT_TIMEOUT) : null,
      };
    });
  }
  if (!isApp(manifest)) return [];
  return [
    {
      name: null,
      unit: manifest.slug,
      kind: "server",
      start: manifest.start!,
      port: typeof manifest.port === "number" ? manifest.port : null,
      routes: manifest.routes,
      internal: false,
      memory: manifest.memory ?? DEFAULT_MEMORY,
      cpu: manifest.cpu ?? null,
      env: manifest.env ?? {},
      backup: asServiceBackup(manifest.backup),
      schedule: null,
      timeout: null,
    },
  ];
}

/**
 * Does the project's main unit stand alone, as an anchor? When every service
 * is scheduled, none runs for good to be known by: the main unit, `<slug>`,
 * is then one that runs nothing, wants the timers and stays active, so that
 * the dashboard, the steward, the monitor and a reboot find the project as
 * they find any other. See generateUnits in unit.ts.
 */
export function isAnchored(manifest: Manifest): boolean {
  const services = servicesOf(manifest);
  return services.length > 0 && services.every((service) => service.kind === "scheduled");
}

/**
 * A project that serves no page: services, none of them public, and no
 * `publicDir`. Its address answers a line saying so, see fragment.ts, rather
 * than a page that looks served and is not; a portal or a preview code still
 * closes it, as any other.
 */
export function isHeadless(manifest: Manifest): boolean {
  return hasServices(manifest) && manifest.publicDir === undefined && servicesOf(manifest).every((service) => service.internal);
}

/** The units a scheduled service brings: its own and its timer's, see timerUnit in unit.ts. */
export function scheduledServices(manifest: Manifest): ServiceView[] {
  return servicesOf(manifest).filter((service) => service.kind === "scheduled");
}

/** The port of the project's main service, the one a single-service project declares. */
export function mainPort(manifest: Manifest): number | null {
  const main = servicesOf(manifest)[0];
  return main !== undefined && main.unit === manifest.slug && typeof main.port === "number" ? main.port : null;
}

/**
 * A route goes as is into a Caddy `path` matcher: a path, with no space, quote
 * or brace that would cut the line. `/_portal` belongs to the portal, which
 * Caddy routes before the site.
 *
 * The top-level `routes` are judged by this rule too. They were only asked to
 * start with a slash, which let `/x\n\theader Leak "{$CLOUDFLARE_API_TOKEN}"`
 * through: a line break and a placeholder of its choosing in the site's block.
 */
export function isValidRoute(route: unknown): route is string {
  return typeof route === "string" && /^\/[A-Za-z0-9._~\/*%-]*$/.test(route) && !route.startsWith("/_portal");
}

/**
 * Could one request match both routes? Caddy compares paths without regard to
 * case, and a `*` matches anything, so the answer errs on the side of yes: two
 * services that could both claim a path are refused, rather than having the
 * written order of the block decide, which the comparison of blocks does not
 * see (bin/cli/comparison.ts).
 */
export function routesOverlap(a: string, b: string): boolean {
  const prefix = (route: string): string => {
    const star = route.indexOf("*");
    return (star === -1 ? route : route.slice(0, star)).toLowerCase();
  };
  const [wildA, wildB] = [a.includes("*"), b.includes("*")];
  const [prefixA, prefixB] = [prefix(a), prefix(b)];
  if (!wildA && !wildB) return prefixA === prefixB;
  if (wildA && wildB) return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
  return wildA ? prefixB.startsWith(prefixA) : prefixA.startsWith(prefixB);
}

/** Does the site go behind the portal? */
export function isProtected(manifest: Manifest): boolean {
  return manifest.portal === true;
}

/**
 * Every name a declared domain answers on, its own name first: the name and
 * each alias, each with its `www` when it is a second level domain. The same
 * forms as api/src/table.ts writes into the table Caddy certifies and routes
 * by, which bin/tests/cli-manifest.test.ts checks: a name the table carries
 * and no block of the site claims falls into the nameless block of static
 * files, and serves the site's public/ without its service, or its door.
 */
export function domainHosts(domain: { name: string; aliases?: string[] }): string[] {
  const forms = (name: string) => (name.split(".").length === 2 ? [name, `www.${name}`] : [name]);
  return [...new Set([domain.name, ...(domain.aliases ?? [])].flatMap(forms))];
}

/**
 * An exemption goes as is into a Caddy `path` matcher: a path, with no space,
 * quote or brace that would cut the line, and with no `..`.
 */
export function isValidExemption(path: unknown): path is string {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9._~\/*-]*$/.test(path)) return false;
  if (path.split("/").includes("..")) return false;
  // Exempting everything amounts to protecting nothing.
  if (["/", "/*", "*"].includes(path)) return false;
  // Those paths belong to the portal, which Caddy routes before the site.
  return !path.startsWith("/_portal");
}

/**
 * A header's name, written bare after `header` in the site's Caddy block.
 *
 * A subset of the token characters of RFC 7230, on purpose: the full set holds
 * `+`, `-`, `?` and `>`, which Caddy reads at the head of a name as "add",
 * "delete", "default" and "defer", and `$`, `*` or `|`, which no real header
 * needs. A letter first, then letters, digits and dashes: every header in use.
 */
export function isValidHeaderName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 128 && /^[A-Za-z][A-Za-z0-9-]*$/.test(name);
}

/**
 * A header's value, written between double quotes in the site's Caddy block,
 * and served to every visitor.
 *
 * **Since the control API, whoever holds a team token writes it.** Caddy
 * substitutes `{$NAME}` with its own environment while it reads the
 * configuration, and `{env.NAME}` at each request: a value of
 * `{$CLOUDFLARE_API_TOKEN}` was the zone's DNS token, in a response header, to
 * anyone who asked. Measured on Caddy 2.11.4, both forms. A `"` ends the
 * quoted value and lets the rest of the line become directives, a `\` escapes
 * the closing quote, a backtick opens Caddy's other quoting.
 *
 * Printable ASCII, then, without `"`, `\`, `{`, `}`, `$` and the backtick: the
 * characters Caddy reads as syntax or as a placeholder, and `$`, which no
 * header needs, refused with them so that no spelling of a placeholder is left.
 * What real headers use all stays: the single quotes, semicolons, colons,
 * slashes, commas, parentheses and spaces of a Content-Security-Policy or a
 * Permissions-Policy, the angle brackets of a Link. A Permissions-Policy that
 * names an origin between double quotes is the one casualty: the service
 * sends that header itself.
 */
export function isValidHeaderValue(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]*$/.test(value) && !/["\\{}$`]/.test(value);
}

/**
 * C0 and C1 control characters, and DEL. A line break in a value written into
 * the unit would add a directive of its own choosing to it, a `User=root` after
 * the generated one; the others have no business in a one-line setting.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Does this text end with a backslash systemd would take for a line
 * continuation? It then glues the next line of the unit onto the value: the
 * `Restart=always` after `ExecStart=` becomes an argument of the command.
 */
function endsWithContinuation(text: string): boolean {
  return /\\\s*$/.test(text);
}

/**
 * The refusals of a command systemd runs, the project's `start` or a
 * service's, `label` naming which.
 *
 * systemd reads a prefix on `ExecStart=` as an instruction: `+` and `!` run the
 * command with full privileges, that is as root, whatever `User=` says; `@`,
 * `-`, `:` and `|` change what is run or how. A manifest written by a team
 * token must never reach any of them, so the command starts with the program
 * itself: an absolute path, or a name systemd looks up, its first character a
 * letter, a digit, a slash, a dot or an underscore. A lone `;` separates
 * a second command, whose own prefix is judged the same way. `$NAME` stays
 * allowed: systemd expands it from the service's own environment, which the
 * service holds anyway, and `--port $PORT` is a common way to write a start.
 * A `%` is escaped by the generator, see unit.ts.
 */
export function commandErrors(command: string, label: string): string[] {
  if (CONTROL_CHARACTERS.test(command)) return [`${label}: a single line, no line break`];
  const errors: string[] = [];
  const words = command.split(/\s+/);
  const programs = [words[0] ?? "", ...words.flatMap((word, rank) => (word === ";" ? [words[rank + 1] ?? ""] : []))];
  if (!programs.every((program) => /^[A-Za-z0-9/._]/.test(program))) {
    errors.push(
      `${label}: must start with the program to run, such as /usr/local/bin/bun; systemd reads a leading + ! @ - : or | as an instruction, + and ! as "run as root"`,
    );
  }
  if (endsWithContinuation(command)) {
    errors.push(`${label}: must not end with a backslash, which systemd reads as a line continuation`);
  }
  return errors;
}

/** The C escapes systemd reads in a command line, those this reading accepts: anything rarer is refused. */
const COMMAND_ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', "'": "'", s: " ", n: "\n", t: "\t" };

/**
 * The words of a command, as systemd reads an `ExecStart=` line: separated by
 * spaces, `"..."` and `'...'` keeping spaces in one word, wherever
 * they open in it, and a backslash escaping the next character. Null for a
 * line it would not read the same way, or that is not one program: a quote
 * left open, a trailing backslash, an escape outside COMMAND_ESCAPES, no word
 * at all, or a lone `;`, which systemd reads as a second command.
 *
 * A service's backup command is not written into a unit: the backup
 * component hands these words to the program that runs it, through
 * systemd-run (dashboard/src/backup/runner.ts). Reading them as systemd reads
 * `start` keeps the two alike; `$NAME` is left in place, for PID 1 to expand
 * from the unit's environment, exactly as it does in `ExecStart=`.
 */
export function commandWords(command: string): string[] | null {
  // Tabs and line breaks are refused with every control character, as commandErrors does.
  if (CONTROL_CHARACTERS.test(command)) return null;
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "\\") {
      const escaped = COMMAND_ESCAPES[command[index + 1] ?? ""];
      if (escaped === undefined) return null;
      word = (word ?? "") + escaped;
      index++;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      word ??= "";
      continue;
    }
    if (character === " ") {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word = (word ?? "") + character;
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  if (words.length === 0 || words.includes(";")) return null;
  return words;
}

/**
 * A folder of the data, as a service's `backup` names it: relative, already
 * normalized, made of plain names. No `..`, no `.`, no empty part, so no
 * leading, trailing or doubled slash, and nothing a shell or systemd would
 * read: the backup component builds paths and arguments from it.
 */
export function isDataFolder(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return false;
  return path.split("/").every((part) => part.length <= 255 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

/** Is one folder of the data the other, or inside it? Two services cannot keep the same one live. */
export function foldersOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** A one-line text for the unit's Description=, see validate(). */
export function isValidDescription(description: unknown): description is string {
  return typeof description === "string" && !CONTROL_CHARACTERS.test(description) && !endsWithContinuation(description);
}

/** An environment variable's name, as `Environment=` and every shell expect one. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

/**
 * An environment variable's value, written as `Environment=KEY=value`, which
 * systemd splits on spaces and unquotes: `"x DATA_DIR=/elsewhere"` would set a
 * second variable, past every rule on names, and a backslash would escape a
 * character or continue the line. One line, then, without spaces, quotes or
 * backslashes. Such a value never worked as written; it is refused rather than
 * quoted, which keeps every unit in service byte for byte. `$` has no meaning
 * there for systemd, and a `%` is escaped by the generator, see unit.ts.
 */
export function isValidEnvValue(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value) && !/[\s"'\\]/.test(value);
}

// --- Secrets -----------------------------------------------------------------
//
// A manifest names its secrets, never their values. The values live on the
// machine, in the project's store, /etc/sitesolide/projects/<slug>/ (see
// ./store), or with whoever deploys for a build secret.
//
// - The short form, `"secrets": ["API_KEY"]`, lists runtime variables.
// - The long form, SecretsLongForm, adds files read whole, which every
//   service finds at $CREDENTIALS_DIRECTORY/files_<name>, and the build's
//   secrets.

/** The long form of `secrets`, each list optional. */
export type SecretsLongForm = { runtime?: string[]; files?: string[]; build?: string[] };

/** The keys of the long form, refused beyond these for the same reason as KNOWN_KEYS. */
const SECRETS_KEYS = ["runtime", "files", "build"];

/** How a manifest declares its secrets: not at all, or as names. */
export type SecretsForm = "none" | "names";

/** A manifest's secrets, read tolerantly: what parses is kept, nothing throws (the steward reads deployed manifests so). */
export type SecretsDeclaration = {
  form: SecretsForm;
  runtime: string[];
  files: string[];
  build: string[];
};

/**
 * The platform's projects that have no store: the dashboard's and the
 * portal's units read `/etc/sitesolide/<slug>.env`, which carries the owner's
 * password hash and which Change password writes; nothing else goes there,
 * see HASH_ONLY in dashboard/src/secrets/scope.ts. Their manifests declare no
 * secret: the generator names that file itself (./unit, platformFile).
 */
export const STORELESS_SLUGS: readonly string[] = ["dashboard", "portal"];

/** An app whose slug is valid and not storeless: its units read the project's store. */
export function hasStore(manifest: Manifest): boolean {
  const slug = manifest.slug as unknown;
  return isApp(manifest) && typeof slug === "string" && isValidSlug(slug) && !STORELESS_SLUGS.includes(slug);
}

/**
 * A file of the store, as systemd's `LoadCredential=` loads it from the
 * project's `files/` folder, measured on systemd 257: no leading dot, which
 * it would skip silently, no `/`, which it would flatten into `_` and
 * collide, and 64 characters, far under the 249 its credential id allows.
 */
export const FILE_NAME_SHAPE: RegExp = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** FILE_NAME_SHAPE, and no `..`. */
export function isValidFileName(name: unknown): name is string {
  return typeof name === "string" && FILE_NAME_SHAPE.test(name) && !name.includes("..");
}

/** The files a manifest may declare: what systemd loads for one unit is bounded, see ./store. */
export const MAX_DECLARED_FILES = 32;

/** Not a placeholder: refused wherever a manifest writes it, see placeholderErrors. */
export const NOT_A_PLACEHOLDER = "{credentials}";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The strings of a list, what is not one left out; nothing for what is not a list. */
function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The manifest's secrets, whatever their form, read tolerantly: the dashboard
 * and the steward read the manifests deployed on the machine as they are, and
 * one bad entry must not take a page down. validate() judges them.
 */
export function secretsOf(manifest: Manifest): SecretsDeclaration {
  const declaration: SecretsDeclaration = { form: "none", runtime: [], files: [], build: [] };
  const raw = manifest.secrets as unknown;
  if (Array.isArray(raw)) {
    const names = stringsOf(raw);
    return names.length === 0 ? declaration : { ...declaration, form: "names", runtime: names };
  }
  if (isRecord(raw) && Object.keys(raw).length > 0) {
    return { ...declaration, form: "names", runtime: stringsOf(raw.runtime), files: stringsOf(raw.files), build: stringsOf(raw.build) };
  }
  return declaration;
}

/**
 * The project-level `env` a build receives, raw: the placeholders are the
 * caller's to replace. A service's `env` is that service's alone, and a
 * SITESOLIDE_ name never reaches a build: the dashboard's SITESOLIDE_ZONE
 * reaches its service, not the code it builds.
 */
export function buildEnvOf(manifest: Manifest): [string, string][] {
  const env = manifest.env as unknown;
  if (!isRecord(env)) return [];
  return Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].startsWith("SITESOLIDE_"));
}

/**
 * The served zone, for the one rule that depends on it: a customer domain
 * declared under it would get nothing, the wildcard already covering it. The
 * zone itself is the one name of it a project may declare, the bare domain.
 *
 * It comes from the environment rather than from a parameter because this
 * module is also embedded by the dashboard, which validates the same manifests
 * on the machine. Empty, the rule does not apply: better to refuse nothing than
 * to refuse in the name of an invented zone.
 */
export function servedZone(environment: Record<string, string | undefined> = process.env): string {
  return environment.SITESOLIDE_ZONE ?? "";
}

/**
 * The address to ask for an access code, shown by the door page of a closed
 * preview. Empty for whoever has not declared it, and the line then disappears
 * from the page.
 */
export function servedContact(environment: Record<string, string | undefined> = process.env): string {
  return environment.SITESOLIDE_CONTACT ?? "";
}

/**
 * What a JSON parser said, without what it quoted: Bun names the word it
 * stopped at, and a sitesolide.json that was a link to a secret would hand
 * that word to whoever reads the refusal, an agent through MCP included. A
 * quoted punctuation mark, `'}'`, stays: it says what was expected.
 */
export function parserComplaint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(["'])[^"']{2,}\1/g, "$1...$1").slice(0, 120);
}

/**
 * Parses the manifest's JSON. Returning the errors rather than throwing allows
 * showing them all at once, rather than having them fixed one by one.
 */
export function readManifest(raw: string): { manifest?: Manifest; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { errors: [`sitesolide.json is unreadable: ${parserComplaint(err)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { errors: ["sitesolide.json must contain an object"] };
  }
  const manifest = parsed as Manifest;
  return { manifest, errors: validate(manifest) };
}

/**
 * The refusals that are decided without the VM. The two that remain, a slug
 * already taken and a port already listened to, are measured on the machine: a
 * local registry would lie from the first deployment made from somewhere else.
 */
export function validate(manifest: Manifest, zone = servedZone()): string[] {
  const errors: string[] = [];
  const isApplication = isApp(manifest);

  for (const key of Object.keys(manifest)) {
    if (!KNOWN_KEYS.includes(key)) {
      errors.push(`${key}: unknown key, a typo here could deploy an open site`);
    }
  }

  if (typeof manifest.slug !== "string" || !isValidSlug(manifest.slug)) {
    errors.push(
      "slug: lowercase letters, digits and dashes, no dot, no leading or trailing dash",
    );
  } else if (manifest.slug === "landing") {
    // Without this refusal, the deployment SUCCEEDS: it creates
    // /srv/sites/landing and publishes a duplicate of the landing that the
    // wildcard block serves straight away.
    errors.push("slug: landing is reserved for the site on the bare domain, which deploy does not handle");
  } else if (manifest.slug === MACHINE_FOLDER) {
    // Its snapshots would mix with those of the machine's own state.
    errors.push(`slug: ${MACHINE_FOLDER} is reserved for the backups of the machine's own state: pick another`);
  } else if (isSystemName(manifest.slug)) {
    errors.push(`slug: ${manifest.slug} is a name the machine already uses, a system service, the landing's www or the folder name public: pick another`);
  }

  if (manifest.description !== undefined) {
    // Written into the unit's Description=: a trailing backslash would glue the
    // next line onto it, and a `%` is escaped by the generator.
    if (!isValidDescription(manifest.description)) {
      errors.push("description: a single line of text, no line break, not ending with a backslash");
    }
  }

  if (manifest.source !== undefined) {
    if (typeof manifest.source !== "string" || !isSourcePath(manifest.source)) {
      errors.push("source: a path relative to this manifest's folder, such as ../../my-app, never absolute");
    }
  }

  if (manifest.publicDir !== undefined) {
    if (typeof manifest.publicDir !== "string" || !isInternalPath(manifest.publicDir)) {
      errors.push("publicDir: a path inside the repository, no `..`");
    }
  }

  if (!isApplication && manifest.publicDir === undefined) {
    errors.push("a project without `start` must declare `publicDir`");
  }

  // Written into the unit's ExecStart=: see commandErrors.
  if (typeof manifest.start === "string" && manifest.start.length > 0) {
    errors.push(...commandErrors(manifest.start, "start"), ...placeholderErrors(manifest.start, "start"));
  }

  if (manifest.services !== undefined) {
    errors.push(...serviceErrors(manifest));
  } else if (isApplication) {
    if (typeof manifest.port !== "number" || !Number.isInteger(manifest.port)) {
      errors.push("port: required as soon as `start` is declared");
    } else if (!isServicePort(manifest.port)) {
      // The blocks the loopback rule closes: on any other port, every project
      // of the machine reaches the app directly, past its door.
      errors.push(`port: inside ${servicePortsProse()}, the blocks only Caddy and the project itself can reach; leave it out and deploy picks a free one`);
    }
  } else if (manifest.port !== undefined) {
    errors.push("port: useless without `start`, Caddy serves the folder itself");
  }

  if (manifest.memory !== undefined && !isValidMemory(manifest.memory)) {
    errors.push("memory: a number followed by K, M or G, such as 256M");
  }

  if (manifest.cpu !== undefined) {
    if (!isValidCpu(manifest.cpu)) {
      errors.push("cpu: a share of one core followed by %, such as 50% or 200% for two cores");
    } else if (!isApplication) {
      errors.push("cpu: without `start`, nothing runs to be limited");
    }
  }

  if (manifest.network !== undefined && !["localhost", "outbound"].includes(manifest.network)) {
    errors.push("network: `localhost` or `outbound`");
  }

  errors.push(...egressErrors(manifest, isApplication));

  // Joined into the `path` matcher of the site's Caddy block, like a service's.
  if (manifest.routes !== undefined && !Array.isArray(manifest.routes)) {
    errors.push("routes: a list of paths, such as [\"/api/*\"]");
  } else {
    for (const route of manifest.routes ?? []) {
      if (!isValidRoute(route)) {
        errors.push(`routes: "${String(route)}" should start with / and be a path such as /api/*, not under /_portal`);
      }
    }
  }
  if (manifest.routes !== undefined && !isApplication) {
    errors.push("routes: without `start`, no request reaches a service");
  }

  errors.push(...envErrors(manifest.env, "env"));
  // The build receives the project's env too, see buildEnvOf: a static site
  // that builds may declare one.
  if (manifest.env !== undefined && !isApplication && !hasBuild(manifest)) {
    errors.push("env: without start or build, nothing reads these variables");
  }

  // Written into the site's Caddy block, see isValidHeaderName and
  // isValidHeaderValue.
  const headers = manifest.headers as unknown;
  const headersObject = typeof headers === "object" && headers !== null && !Array.isArray(headers);
  if (headers !== undefined && !headersObject) {
    errors.push('headers: an object naming each header, such as { "X-Robots-Tag": "noindex" }');
  } else if (headers !== undefined && !isApplication) {
    // A static site has no block of its own: the Caddyfile's shared blocks
    // serve its folder, and nothing would ever write these headers there.
    errors.push("headers: only an app has a Caddy block of its own to carry them; a static site is served by the machine's shared blocks, which add none");
  }
  for (const [name, value] of headersObject ? Object.entries(headers) : []) {
    if (!isValidHeaderName(name)) {
      errors.push(`headers: "${name}" is not a header name`);
    }
    if (!isValidHeaderValue(value)) {
      errors.push(
        `headers: the value of ${name} must be printable ASCII with no line break, and none of " \\ { } $ or a backtick, which Caddy reads as syntax or placeholders`,
      );
    }
    // The headers are placed in the routes snippet, therefore on ALL of the
    // site's blocks. A noindex there would also hold for the customer's final
    // domain, which it would drop from Google with nothing to report it.
    if (name.toLowerCase() === "x-robots-tag" && manifest.domain !== undefined) {
      errors.push(
        "headers: X-Robots-Tag would also apply to the customer domain, which must stay indexed",
      );
    }
  }

  errors.push(...secretsErrors(manifest, isApplication));

  const declared = manifest.domain as unknown;
  if (declared !== undefined && (typeof declared !== "object" || declared === null || Array.isArray(declared))) {
    // A `null` here, or an `aliases` that is no list, used to throw from
    // validate() itself, and the installer with it.
    errors.push('domain: an object such as { "name": "example.com" }');
  } else if (manifest.domain !== undefined) {
    const domain = manifest.domain;
    if (typeof domain.name !== "string" || !isValidDomain(domain.name)) {
      errors.push("domain.name: invalid domain name");
    } else if (zone !== "" && domain.name.endsWith(`.${zone}`)) {
      // The `ask` endpoint already refuses these domains: the wildcard covers
      // them, and a manifest declaring them would get nothing. The zone itself
      // is not one of them: the bare domain is served by the project that
      // declares it, as any customer domain, and its www by the wildcard
      // block, which sends it there.
      errors.push(`domain.name: ${domain.name} is under the ${zone} zone, which the wildcard already covers; the zone itself, ${zone}, may be declared`);
    }
    if (isHeadless(manifest)) {
      // Its address answers a line saying the project serves no page: a
      // domain would be certified, and answer that line to its visitors.
      errors.push("domain: this project serves no page, no public service and no publicDir, so a domain would have nothing to show");
    }
    if (domain.aliases !== undefined && !Array.isArray(domain.aliases)) {
      errors.push('domain.aliases: a list of domain names, such as ["www.example.com"]');
    } else {
      for (const alias of domain.aliases ?? []) {
        if (typeof alias !== "string" || !isValidDomain(alias)) {
          errors.push(`domain.aliases: "${String(alias)}" is invalid`);
        } else if (zone !== "" && (alias === zone || alias.endsWith(`.${zone}`))) {
          // An alias is a Caddy address of the site's block, which sends it to
          // the domain: one under the zone would be more specific than the
          // wildcard, and send another site's preview away.
          errors.push(`domain.aliases: "${alias}" is in the ${zone} zone, which serves the previews`);
        }
      }
    }
  }

  if (manifest.portal !== undefined) {
    if (manifest.portal !== true) {
      // Like lock: its absence is already the shape of an open site.
      errors.push("portal: true, or absent");
    } else {
      if (!isApplication) {
        errors.push("portal: only a project with `start` can sit behind the portal for now");
      }
      if (manifest.lock === true) {
        errors.push("portal: a site behind the portal needs no preview lock");
      }
      if (manifest.slug === PORTAL_SLUG) {
        errors.push("portal: the portal cannot sit behind itself");
      }
    }
  }

  if (manifest.portalExempt !== undefined) {
    // Without `portal`, the exemptions are accepted and do nothing: the
    // generator only reads them behind the door. That is the shape left by a
    // portal removed from the dashboard, which keeps them in reserve so that
    // the door put back reopens the same paths, a provider's webhook included. Their
    // shape, on the other hand, is judged in both cases: an exemption that
    // would open everything must not wait for the portal's return to be seen.
    if (!Array.isArray(manifest.portalExempt)) {
      errors.push("portalExempt: a list of paths");
    } else {
      for (const path of manifest.portalExempt) {
        if (!isValidExemption(path)) {
          errors.push(`portalExempt: "${String(path)}" must be a path such as /webhook/*, not everything, not /_portal`);
        }
      }
    }
  }

  errors.push(...backupErrors(manifest, isApplication));

  return errors;
}

/**
 * Is the project's data folder in the machine's snapshots? Every app's is,
 * unless its manifest says `"backup": false`: a folder holding nothing worth
 * keeping, a cache or a copy of something kept elsewhere, need not take room
 * on the backups disk every hour. See dashboard/src/backup/README.md.
 */
export function isBackedUp(manifest: Manifest): boolean {
  return manifest.backup !== false;
}

/**
 * The project's `backup`. `false` opts out. Like `portal`, its absence
 * already has a meaning, the default, and `true` would be a second way of
 * writing it, which ends up diverging. A static site has no data folder.
 *
 * An object is the backup command of the project's single service, in the
 * form with one `start`: the project and its service are then one, as they
 * are for `start` and `port`. Under `services`, each service declares its
 * own, and the top level keeps `false` alone, as it keeps no `start`.
 */
function backupErrors(manifest: Manifest, isApplication: boolean): string[] {
  const backup = manifest.backup as unknown;
  if (backup === undefined) return [];
  if (backup !== false && (typeof backup !== "object" || backup === null || Array.isArray(backup))) {
    return [
      'backup: false to keep the data folder out of the snapshots, an object such as { "folder": "postgres", "command": "..." } for a service that keeps a live database there, or absent',
    ];
  }
  if (!isApplication) return ["backup: without `start`, there is no data folder to back up"];
  if (backup === false) return [];
  if (manifest.services !== undefined) {
    return ["backup: a backup command is declared per service once `services` is present; at the top level, only false, which keeps the whole project out"];
  }
  return [...serviceBackupErrors(backup, "backup"), ...backupDirErrors(manifest.env, "env")];
}

/**
 * `BACKUP_DIR` is the folder the backup component hands a backup command, and
 * the component's other variables are `BACKUP_` too: an `env` of such a name,
 * beside a backup command, would never reach it, the component's winning,
 * and would only mislead whoever reads the manifest. Beside none, they are
 * names like any other.
 */
function backupDirErrors(env: Record<string, string> | undefined, label: string): string[] {
  if (env === undefined || typeof env !== "object" || env === null) return [];
  return Object.keys(env)
    .filter((name) => name.startsWith("BACKUP_"))
    .map((name) => `${label}: ${name} is a name of the backup component, which sets BACKUP_DIR for the backup command: no BACKUP_ variable beside one`);
}

/**
 * The refusals of a service's `backup`, `label` naming where it was written.
 *
 * The command is judged like `start`, and read as systemd reads it
 * (commandWords): one program, which the backup component starts with the
 * service's identity and walls. The folder is one the data holds, never
 * the data itself: a cluster kept straight in `DATA_DIR` would have the
 * snapshot hold nothing else, and the restore would lose what is beside it.
 */
function serviceBackupErrors(raw: unknown, label: string): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [`${label}: an object such as { "folder": "postgres", "command": "/bin/sh /srv/sites/<slug>/app/backup.sh" }`];
  }
  const errors: string[] = [];
  const backup = raw as Record<string, unknown>;
  for (const key of Object.keys(backup)) {
    if (!BACKUP_KEYS.includes(key)) errors.push(`${label}.${key}: unknown key, a backup takes \`folder\` and \`command\``);
  }
  if (!isDataFolder(backup.folder)) {
    errors.push(`${label}.folder: a folder inside the data, relative, such as postgres or db/main, with no \`..\`, \`.\` or empty part`);
  }
  const command = backup.command;
  if (typeof command !== "string" || command.length === 0) {
    errors.push(`${label}.command: required, the command that leaves a consistent copy of the folder in $BACKUP_DIR`);
  } else {
    const refused = commandErrors(command, `${label}.command`);
    errors.push(...refused, ...placeholderErrors(command, `${label}.command`));
    if (refused.length === 0 && commandWords(command) === null) {
      errors.push(`${label}.command: one program and its arguments, read as systemd reads them: no quote left open, no lone ;, and no escape but \\\\ \\" \\' \\s \\n \\t; a script does the rest`);
    }
  }
  return errors;
}

/** The refusals of an `env`, the project's or a service's, `label` naming which. */
function envErrors(env: Record<string, string> | undefined, label: string): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isValidEnvName(key)) {
      errors.push(`${label}: "${key}" is not an environment variable name`);
    } else if (RESERVED_ENV.includes(key)) {
      errors.push(`${label}: ${key} is set by the deployment and cannot be redefined`);
    } else if (SUSPICIOUS_ENV.test(key) && !isFrameworkPublic(key)) {
      errors.push(
        `${label}: ${key} looks like a secret: list its name under "secrets" and set its value on the server, never in a committed file`,
      );
    }
    if (typeof value !== "string") {
      errors.push(`${label}: the value of ${key} must be a string`);
    } else if (CONTROL_CHARACTERS.test(value)) {
      errors.push(`${label}: the value of ${key} must hold on one line`);
    } else if (!isValidEnvValue(value)) {
      errors.push(`${label}: the value of ${key} must hold no space, quote or backslash, which systemd would split or unquote`);
    } else if (looksLikeSecretValue(value)) {
      // Whatever its name: this file is committed. Never quoted.
      errors.push(`${label}: the value of ${key} starts like a secret key; a secret goes in secrets, never in a committed file`);
    } else {
      errors.push(...placeholderErrors(value, label));
    }
  }
  return errors;
}

/** Does the project build anything? Its build is what reads `env` and `secrets.build` without a service. */
function hasBuild(manifest: Manifest): boolean {
  return typeof manifest.build === "string" && manifest.build.trim().length > 0;
}

/**
 * `{credentials}` is no placeholder: nothing replaces it, in a unit, an
 * environment file or a backup command's line alike, as measured on systemd
 * 257. It is refused so that nobody writes it believing it works.
 */
function placeholderErrors(text: string, label: string): string[] {
  return text.includes(NOT_A_PLACEHOLDER)
    ? [`${label}: ${NOT_A_PLACEHOLDER} is not replaced; a service reads its files at $CREDENTIALS_DIRECTORY/files_<name>`]
    : [];
}

/** Every name the project's `env` or any service's sets: a secret's name lives in one place. */
function envNamesOf(manifest: Manifest): Set<string> {
  const names = new Set(isRecord(manifest.env) ? Object.keys(manifest.env) : []);
  for (const service of isRecord(manifest.services) ? Object.values(manifest.services) : []) {
    if (isRecord(service) && isRecord(service.env)) for (const name of Object.keys(service.env)) names.add(name);
  }
  return names;
}

/** Does any service of the project have a backup command, its single one or one under `services`? */
function hasBackupCommand(manifest: Manifest): boolean {
  if (isRecord(manifest.backup)) return true;
  return (isRecord(manifest.services) ? Object.values(manifest.services) : []).some((service) => isRecord(service) && isRecord(service.backup));
}

/**
 * How a refusal names an entry: by itself when it has a variable name's shape
 * and does not start like a key, by its rank otherwise. A value pasted where
 * a name goes is never quoted back, into a terminal, an agent's context or a
 * log.
 */
function entryLabel(name: string, rank: number, quotable: boolean): string {
  return quotable && !VALUE_LIKE_PREFIXES.some((prefix) => name.startsWith(prefix)) ? name : `entry ${rank + 1}`;
}

const SECRETS_SHAPE = 'secrets: a list of variable names, such as ["API_KEY"], or { "runtime": [...], "files": [...], "build": [...] }';
const NOT_A_NAME = `not a variable name: letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most`;
const LIKE_A_KEY = "starts like a secret key, not a variable name: a value never goes in sitesolide.json";

/**
 * The refusals of `secrets`, in every form, see secretsOf. None quotes a
 * value: a name is quoted only once it has a name's shape, see entryLabel.
 */
function secretsErrors(manifest: Manifest, isApplication: boolean): string[] {
  const raw = manifest.secrets as unknown;
  if (raw === undefined) return [];
  const listOfStrings = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
  const shaped = listOfStrings(raw) || (isRecord(raw) && Object.entries(raw).every(([key, list]) => SECRETS_KEYS.includes(key) && listOfStrings(list)));
  if (!shaped) return [SECRETS_SHAPE];

  const declaration = secretsOf(manifest);
  if (declaration.form === "none") return [];

  const slug = manifest.slug as unknown;
  if (typeof slug === "string" && STORELESS_SLUGS.includes(slug)) {
    return [`secrets: ${slug} keeps its password hash in ${slug}.env, which its unit reads: it declares no secret`];
  }
  const errors: string[] = [];
  const shortForm = Array.isArray(raw);
  if (!isApplication && (shortForm || declaration.runtime.length > 0 || declaration.files.length > 0)) {
    errors.push("secrets: without start, no service reads a runtime secret; a value the build needs goes under secrets.build");
  } else {
    errors.push(...runtimeNameErrors(manifest, declaration.runtime, shortForm ? "secrets" : "secrets.runtime"));
    errors.push(...fileNameErrors(declaration.files));
  }
  errors.push(...buildNameErrors(manifest, declaration.build));
  return errors;
}

/** The runtime variables' names: each set in the store, read by every service of the project at start. */
function runtimeNameErrors(manifest: Manifest, names: string[], label: string): string[] {
  const errors: string[] = [];
  const set = envNamesOf(manifest);
  const besideBackup = hasBackupCommand(manifest);
  const seen = new Set<string>();
  for (const [rank, name] of names.entries()) {
    const entry = entryLabel(name, rank, isVariableName(name));
    if (!isVariableName(name)) {
      errors.push(`${label}: ${entry} is ${NOT_A_NAME}`);
      continue;
    }
    if (entry !== name) {
      errors.push(`${label}: ${entry} ${LIKE_A_KEY}`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${label}: ${name} is listed twice`);
      continue;
    }
    seen.add(name);
    if (name === PASSWORD_VARIABLE) {
      errors.push(`${label}: ${name} is changed with Change password, in the dashboard's and the portal's files alone`);
      continue;
    }
    // The name has a variable's shape here: checkKey's reasons are the
    // reserved ones, and each starts with the name.
    const reserved = checkKey(name);
    if (reserved !== null) {
      errors.push(`${label}: ${reserved}`);
      continue;
    }
    if (set.has(name)) errors.push(`${label}: ${name} is also set in env; a name lives in one place`);
    if (besideBackup && name.startsWith("BACKUP_")) {
      errors.push(`${label}: ${name} is a name of the backup component, which sets BACKUP_DIR for the backup command: no BACKUP_ variable beside one`);
    }
  }
  return errors;
}

/** The files' names: each a file of the store's files/ folder, see isValidFileName. */
function fileNameErrors(names: string[]): string[] {
  const errors: string[] = [];
  if (names.length > MAX_DECLARED_FILES) {
    errors.push(`secrets.files: ${MAX_DECLARED_FILES} files at most, systemd loads a bounded amount for each unit`);
  }
  const seen = new Set<string>();
  for (const [rank, name] of names.entries()) {
    if (!isValidFileName(name)) {
      errors.push(
        `secrets.files: entry ${rank + 1} is not a file name: a letter or a digit first, then letters, digits, dots, dashes and underscores, 64 characters at most, no ..`,
      );
      continue;
    }
    if (seen.has(name)) errors.push(`secrets.files: ${entryLabel(name, rank, true)} is listed twice`);
    seen.add(name);
  }
  return errors;
}

/** The build secrets' names: each taken from whoever deploys, by the build alone, see buildNameRefusal. */
function buildNameErrors(manifest: Manifest, names: string[]): string[] {
  const errors: string[] = [];
  if (names.length > 0 && !hasBuild(manifest)) errors.push("secrets.build: without build, nothing reads them");
  const env = new Set(isRecord(manifest.env) ? Object.keys(manifest.env) : []);
  const seen = new Set<string>();
  for (const [rank, name] of names.entries()) {
    const entry = entryLabel(name, rank, isVariableName(name));
    if (!isVariableName(name)) {
      errors.push(`secrets.build: ${entry} is ${NOT_A_NAME}`);
      continue;
    }
    if (entry !== name) {
      errors.push(`secrets.build: ${entry} ${LIKE_A_KEY}`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`secrets.build: ${name} is listed twice`);
      continue;
    }
    seen.add(name);
    const refusal = buildNameRefusal(name);
    if (refusal !== null) {
      errors.push(`secrets.build: ${refusal}`);
      continue;
    }
    if (env.has(name)) errors.push(`secrets.build: ${name} is also set in env; a name lives in one place`);
  }
  return errors;
}

/**
 * The refusals of `services`.
 *
 * Every port sits in the range the loopback rule closes. Outside it, the
 * project's internal service would be reachable by every other project on the
 * machine, which is exactly what declaring it internal was meant to prevent.
 * A worker and a scheduled service declare none: they listen on nothing, and
 * a port held for nothing would be one less for the machine's other projects.
 *
 * Exactly one public service takes the paths nobody claims, unless a
 * `publicDir` serves them: without it, a path matched by no route would get an
 * empty 200 from Caddy, a page that looks served and is not. A project with no
 * public service at all and no `publicDir` serves no page, see isHeadless.
 */
function serviceErrors(manifest: Manifest): string[] {
  const errors: string[] = [];
  const services = manifest.services as unknown;
  if (typeof services !== "object" || services === null || Array.isArray(services) || Object.keys(services).length === 0) {
    return ['services: an object naming each service, such as { "web": { "start": "...", "port": 3040 } } or { "sync": { "start": "...", "schedule": "hourly" } }'];
  }
  for (const key of ["start", "port", "routes"] as const) {
    if (manifest[key] !== undefined) {
      errors.push(`${key}: declared per service once \`services\` is present`);
    }
  }

  const ports = new Map<number, string>();
  const defaults: string[] = [];
  const exposed: string[] = [];
  const claimed: { name: string; route: string }[] = [];
  const backedUp: { name: string; folder: string }[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const label = `services.${name}`;
    if (!isValidServiceName(name)) {
      errors.push(
        `services: "${name}" should start with a letter, then lowercase letters, digits and dashes, 32 characters at most, and not be a systemd unit type`,
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${label}: an object with at least \`start\`, and a \`port\` unless it is internal or scheduled`);
      continue;
    }
    const service = raw as Service;
    for (const key of Object.keys(service)) {
      if (!SERVICE_KEYS.includes(key)) {
        errors.push(`${label}.${key}: unknown key, a typo here could deploy something unintended`);
      }
    }

    if (typeof service.start !== "string" || service.start.length === 0) {
      errors.push(`${label}.start: required, the command systemd runs`);
    } else {
      errors.push(...commandErrors(service.start, `${label}.start`), ...placeholderErrors(service.start, `${label}.start`));
    }

    if (service.internal !== undefined && service.internal !== true) {
      errors.push(`${label}.internal: true, or absent`);
    }
    const scheduled = service.schedule !== undefined;
    const internal = service.internal === true || scheduled;

    if (scheduled) {
      if (!isValidSchedule(service.schedule)) {
        errors.push(
          `${label}.schedule: a systemd calendar expression such as hourly, daily, *:0/15 (every quarter of an hour) or "Mon..Fri 08:00", on one line, with no % or backslash`,
        );
      }
      if (service.timeout !== undefined && !isValidTimeout(service.timeout)) {
        errors.push(`${label}.timeout: how long one run may take, such as 90s, 15m or 2h, a day at most`);
      }
      if (service.port !== undefined) {
        errors.push(`${label}.port: a scheduled service listens on nothing, between two runs nothing runs at all`);
      }
      if (service.backup !== undefined) {
        errors.push(`${label}.backup: a scheduled service keeps no live folder between its runs, the snapshot copies its data as files`);
      }
    } else if (service.timeout !== undefined) {
      errors.push(`${label}.timeout: only a scheduled service has one, a service that runs for good is never stopped for its time`);
    }

    const port = service.port;
    if (port === undefined) {
      if (!internal) {
        errors.push(`${label}.port: required, the loopback port the service listens on; a worker that listens on nothing says "internal": true`);
      }
    } else if (scheduled) {
      // Refused above.
    } else if (typeof port !== "number" || !Number.isInteger(port)) {
      errors.push(`${label}.port: a whole number, the loopback port the service listens on`);
    } else if (!isServicePort(port)) {
      errors.push(`${label}.port: inside ${servicePortsProse()}, the blocks only Caddy and the project itself can reach`);
    } else if (ports.has(port)) {
      errors.push(`${label}.port: ${port} is already the port of ${ports.get(port)}`);
    } else {
      ports.set(port, name);
    }

    if (service.cpu !== undefined && !isValidCpu(service.cpu)) {
      errors.push(`${label}.cpu: a share of one core followed by %, such as 50% or 200% for two cores`);
    }

    if (!internal) exposed.push(name);
    if (service.routes !== undefined) {
      if (!Array.isArray(service.routes) || service.routes.length === 0) {
        errors.push(`${label}.routes: a non-empty list of paths, or absent to take every path left`);
      } else {
        for (const route of service.routes) {
          if (!isValidRoute(route)) {
            errors.push(`${label}.routes: "${String(route)}" must be a path such as /api/*, not under /_portal`);
          } else {
            claimed.push({ name, route });
          }
        }
      }
      if (internal) errors.push(`${label}.routes: an internal service receives no request from Caddy`);
    } else if (!internal) {
      defaults.push(name);
    }

    if (service.memory !== undefined && !isValidMemory(service.memory)) {
      errors.push(`${label}.memory: a number followed by K, M or G, such as 256M`);
    }
    errors.push(...envErrors(service.env, `${label}.env`));

    if (service.backup !== undefined) {
      errors.push(...serviceBackupErrors(service.backup, `${label}.backup`));
      errors.push(...backupDirErrors({ ...manifest.env, ...service.env }, `${label}.env`));
      if (manifest.backup === false) {
        errors.push(`${label}.backup: the project's "backup": false keeps its data out of the snapshots, so this command would never run`);
      }
      const folder = (service.backup as Partial<ServiceBackup> | null)?.folder;
      if (isDataFolder(folder)) backedUp.push({ name, folder });
    }
  }

  // One live folder, one service: two backup commands writing the same
  // folder, or one inside the other, would have the archive hold one of them
  // and lose the other.
  for (const [i, a] of backedUp.entries()) {
    for (const b of backedUp.slice(i + 1)) {
      if (foldersOverlap(a.folder, b.folder)) {
        errors.push(`services: ${a.name} (${a.folder}) and ${b.name} (${b.folder}) back up the same folder, or one inside the other: one service per live folder`);
      }
    }
  }

  if (defaults.length > 1) {
    errors.push(`services: ${defaults.join(", ")} would all take every path left; give routes to all but one`);
  }
  if (exposed.length > 0 && defaults.length === 0 && manifest.publicDir === undefined) {
    errors.push("services: without publicDir, one public service must take every path left: leave its routes out");
  }
  for (const [i, a] of claimed.entries()) {
    for (const b of claimed.slice(i + 1)) {
      if (a.name !== b.name && routesOverlap(a.route, b.route)) {
        errors.push(`services: ${a.route} (${a.name}) and ${b.route} (${b.name}) could match the same request`);
      }
    }
  }
  return errors;
}

/**
 * What the rsync must never carry along: the dependencies installed on the
 * workstation. A macOS `node_modules` or a `.venv` built for arm64 dumped onto
 * a Linux x86_64 machine gives a service that does not start, after erasing the
 * previous one.
 *
 * The check takes the directory's entries rather than reading the disk, so as
 * to stay checkable without a test tree.
 */
export const DEPENDENCIES = ["node_modules", ".venv", "venv", "__pycache__"];

/**
 * What never leaves the workstation, whatever the manifest says, at any depth
 * of the code and of the public files: a repository's history, whose
 * `.git/config` may carry a token, and the `.env` files that hold secrets by
 * convention. A `public/` that is a clone used to serve `/.git/config`, and a
 * `config/.env.production` left with the code. As rsync and the archive read
 * patterns, a name without a slash matches at any depth; Caddy's file servers
 * hide the same names, for what an earlier deployment left on the machine,
 * see fragment.ts.
 */
export const NEVER_SENT: readonly string[] = [".git", ".env*"];

export function missingExclusions(manifest: Manifest, entries: string[]): string[] {
  const declared = new Set(manifest.exclude ?? []);
  return DEPENDENCIES.filter((name) => entries.includes(name) && !declared.has(name));
}

/**
 * The manifest read back as an object, validating nothing further: the
 * functions below only touch one key and leave the rest as is, key order
 * included. The file is versioned, and an action that puts a lock in place must
 * not read as a rewrite of the manifest.
 */
function readObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sitesolide.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The manifest rewritten with its `lock` field, as the gatekeeper writes it on
 * the machine and `deploy` makes the repository follow.
 *
 * The lock lives here and nowhere else: this is the file the deployment
 * deposits on the VM and that the gatekeeper generates the locks from, and a
 * lock written elsewhere would be erased at the next deployment.
 *
 * The field disappears when the lock is lifted, rather than being `false`: its
 * absence is already the shape open sites have, and two ways of writing the
 * same thing end up diverging.
 */
export function setLock(raw: string, closed: boolean): string {
  const manifest = readObject(raw);
  if (closed) manifest.lock = true;
  else delete manifest.lock;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The manifest rewritten with its `portal` field, as the dashboard's
 * gatekeeper deposits it on the VM (dashboard/src/gatekeeper/).
 *
 * Like the lock, the field disappears when the door is removed: `validate()`
 * refuses `false`, and its absence is already the shape of an open site.
 *
 * `portalExempt` stays in place. Without `portal`, it is inert, the generator
 * does not read it; keeping it means a door put back reopens the same paths,
 * instead of silently closing a webhook that a third party calls unsigned. For
 * the same reason, `portal` put back comes just before `portalExempt`: a
 * removal followed by a placement gives back the original file, key order
 * included.
 */
export function setPortal(raw: string, active: boolean): string {
  const parsed = readObject(raw);
  if (!active) {
    delete parsed.portal;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if ("portal" in parsed || !("portalExempt" in parsed)) {
    parsed.portal = true;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const ordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "portalExempt") ordered.portal = true;
    ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The manifest rewritten with its `domain.active`, as `sitesolide domain`
 * records it.
 *
 * `active` governs the domain's entry in the table: true, Caddy routes it and
 * the `ask` endpoint authorises its certificate; false, the site stays
 * reachable on its preview subdomain and nothing is issued in its name.
 *
 * The field is written even when it is `false`, unlike the lock: a `domain`
 * without `active` reads as a forgotten switch, where a manifest without `lock`
 * is simply an open site.
 */
export function setDomainActive(raw: string, active: boolean): string {
  const parsed = readObject(raw);
  const domain = parsed.domain;
  if (typeof domain !== "object" || domain === null || Array.isArray(domain)) {
    throw new Error("no domain declared in sitesolide.json");
  }
  (domain as Record<string, unknown>).active = active;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
