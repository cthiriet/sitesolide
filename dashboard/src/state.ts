/**
 * What the machine carries, computed and nothing more.
 *
 * This module receives what the collector read and returns the snapshot the
 * page displays. No disk access, no network access, no implicit clock:
 * everything comes in through the parameters, so that every discrepancy
 * reported here is checkable without a VM. The reading belongs to
 * `collector.ts`, the display to the Astro application of `web/`.
 *
 * The rules are not rewritten: `isValidCode` comes from `api/src/locks.ts`,
 * which also decides what Caddy accepts, `isApp` from `bin/cli/manifest.ts`,
 * which decides what the CLI generates, and `PLATFORM_PORTS` from
 * `bin/cli/services.ts`, which keeps the platform's ports for its own
 * projects. A dashboard that rewrites these rules ends up displaying a state
 * the machine denies, and that is the reason the `dashboard/` folder is in
 * this repository rather than in a neighbouring one.
 *
 * The import goes through `borrowed/`, where `scripts/borrow.ts` copies these
 * files before every build: the deployment's rsync carries only
 * `dashboard/`, and an import climbing higher makes the service fail on the VM
 * after a deployment that otherwise succeeded.
 */
import {
  isApp,
  isHeadless,
  isProtected,
  mainPort,
  PORTAL_SLUG,
  secretsOf,
  servicesOf,
  type Manifest,
  type ServiceKind,
  type ServiceView,
} from "../borrowed/manifest";
import { fragmentIsProtected, fragmentPassesIdentity } from "../borrowed/portal";
import { isValidCode, previewHost } from "../borrowed/locks";
import { PLATFORM_PORTS } from "../borrowed/services";
import { timerUnit } from "../borrowed/unit";
import { duration, monitorDiscrepancies } from "./monitor";

/**
 * The landing is not served from `/srv/sites/landing` but from the bare
 * domain's directory, and its unit does not bear the name of its directory.
 * This correspondence is written here because without it the dashboard would
 * display the landing as a fallen service and as a directory without a
 * manifest, wrongly twice over.
 */
import { LANDING_FOLDER } from "./config";
export { LANDING_FOLDER } from "./config";
export const LANDING_UNIT = "sitesolide-landing";

/** The systemd unit of a served directory, which bears its name except for the landing. */
export function unitOf(slug: string): string {
  return slug === LANDING_FOLDER ? LANDING_UNIT : slug;
}

/**
 * The address of a served directory.
 *
 * The landing occupies the bare domain, whose name its directory already
 * bears: applying the `<slug>.<zone>` convention to it would display
 * `<zone>.<zone>`. It is the same exception as that of
 * `unitOf`, taken from the other end.
 */
export function addressOf(slug: string, zone: string): string {
  return slug === LANDING_FOLDER ? slug : previewHost(slug, zone);
}

/**
 * Where the link carrying a site's code leads: its own domain once it serves
 * one, where its visitors go and where the code opens it as on the preview;
 * its preview otherwise.
 */
export function codeAddress(slug: string, zone: string, manifest: Manifest | null): string {
  const domain = manifest?.domain;
  return domain?.active === true && typeof domain.name === "string" ? domain.name : addressOf(slug, zone);
}

/**
 * Beyond that, the snapshot is announced as stale rather than presented as the
 * current state. The timer passes every minute: three minutes without a new
 * collection means that the timer no longer runs, and that is precisely what a
 * dashboard must not keep quiet about.
 */
export const STALE_AFTER_MS = 3 * 60 * 1000;

/** A peak beyond this share of the limit deserves to be seen before the OOM. */
export const WORRYING_PEAK_SHARE = 0.8;

/** What `systemctl show` returned, one property per key, with no interpretation. */
export type RawUnit = Record<string, string>;

/** A directory of `/srv/sites`, as the collector read it. */
export type RawFolder = {
  slug: string;
  /** Content of the `sitesolide.json` dropped at the project root, or null. */
  manifest: string | null;
  unit: RawUnit | null;
  /**
   * The project's other units, by name, for a project declaring `services`:
   * `<slug>.<name>` for a service, `<slug>.<name>.timer` for the timer of a
   * scheduled one, the suffix keeping the two apart. The main one is `unit`,
   * which for a project whose every service is scheduled is its anchor:
   * every service is then here. A scheduled service's reading carries how its
   * last run ended, a timer's when it fires; see the collector.
   *
   * Optional, and it stays so: a reading dropped by a collector older than
   * services does not carry it, and the dashboard must open all the same in
   * the minute that follows a deployment. A name missing from it was not read,
   * by a collector older than scheduled services, which is not a unit missing
   * from the machine: null says that.
   */
  units?: Record<string, RawUnit | null>;
  /** Size of the directory in bytes. */
  bytes: number | null;
  /** Date of the manifest, which dates the last drop. */
  deployed: number | null;
};

export type RawMachine = {
  memoryTotal: number | null;
  memoryAvailable: number | null;
  diskTotal: number | null;
  diskFree: number | null;
  /** The three averages of /proc/loadavg, over one, five and fifteen minutes. */
  load1: number | null;
  load5: number | null;
  load15: number | null;
  /** Number of cores, without which a load average means nothing. */
  cores: number | null;
};

/** Everything the collector read, before the slightest decision. */
export type Raw = {
  generated: number;
  zone: string;
  folders: RawFolder[];
  /** Content of `/etc/caddy/locks-codes.json`, as it stands. */
  codes: string | null;
  /** Content of `/etc/caddy/domains.map`, as it stands. */
  domains: string | null;
  /**
   * The snapshot dropped by the `analytics` service, as it stands.
   *
   * That confined service cannot open the visits database, and the loopback
   * rule forbids it to reach the service that holds it: the collector is the
   * only path, and it copies this file as it copies the domain table.
   * `src/audience.ts` interprets it.
   *
   * Optional, and it stays so: a reading dropped by a collector older than
   * this measurement does not carry it, and the dashboard must open all the
   * same in the minute that follows a deployment.
   */
  audience?: string | null;
  /**
   * The monitor's status, /var/lib/sitesolide-monitor/status.json, as it
   * stands, copied by the collector like the audience snapshot.
   * `src/monitor.ts` interprets it. Optional for the same reason: a collector
   * older than the monitor does not carry it.
   */
  monitor?: string | null;
  /** Ports listening on the loopback interface. */
  ports: number[];
  /**
   * The fragments in service in `/etc/caddy/sites`, slug to content. The
   * content serves to confront the portal's door with what the manifest asks
   * for.
   */
  blocks: Record<string, string>;
  machine: RawMachine | null;
  /**
   * The previous reading, reduced to what is needed for a rate.
   *
   * systemd gives no CPU level, only `CPUUsageNSec`, the processor time
   * accumulated since the unit started. A percentage exists only between two
   * readings: the collector therefore carries over here the counters of the
   * snapshot it replaces, and the division is done in this module, where it is
   * tested without a VM.
   */
  previous: { generated: number; cpu: Record<string, number> } | null;
};

export type Service = {
  unit: string;
  loaded: boolean;
  active: string;
  subState: string;
  memory: number | null;
  peak: number | null;
  limit: number | null;
  restarts: number | null;
  /** Since when the service has been active, in epoch milliseconds. */
  since: number | null;
  /** Processor time accumulated since this startup, in milliseconds. */
  cpuTotal: number | null;
  /**
   * Share of a core consumed since the previous reading, as a percentage. Null
   * at the first reading, for lack of a predecessor: an active service would
   * otherwise display zero, which would read as asleep.
   */
  cpuShare: number | null;
};

export type Domain = {
  name: string;
  aliases: string[];
  /** `domain.active` from the manifest: the intention. */
  active: boolean;
  /** Present in `domains.map`: what Caddy actually routes. */
  route: boolean;
};

export type Lock = {
  /** `lock` from the manifest: the intention, versioned in the site's repository. */
  closed: boolean;
  /** The code in force on the VM, outside the repository. Never a cryptographic secret. */
  code: string | null;
  /** The address to send to the client, code included, or null without a code. */
  url: string | null;
  /**
   * A code is in force, but not shown to whoever reads: a Viewer or a
   * Developer of the site, see src/people/view.ts. Absent for the owner.
   */
  withheld?: boolean;
};

/**
 * The common portal's door, from both sides: what the manifest asks for, and
 * what the Caddy block applies.
 *
 * The discrepancy between the two is what counts. A site that asks for the
 * portal and whose block does not carry it is served in the clear while its
 * owner believes it closed: that is the worst possible state, and findDiscrepancies()
 * reports it as an error.
 */
export type Portal = {
  /** `portal` from the manifest: the intention, versioned in the site's repository. */
  wanted: boolean;
  /** Is the portal's stanza in the fragment in service? */
  installed: boolean;
  /**
   * Does that stanza hand the site the portal's identity headers, the
   * visitor's taken off first? False for a block deployed before them, which
   * the site's next deployment upgrades. Absent from a snapshot written by a
   * collector from before them: unknown, not false.
   */
  identity?: boolean;
  /** The paths the door lets through, public and under the site's sole guard. */
  exemptions: string[];
};

export type Site = {
  slug: string;
  description: string | null;
  type: "static" | "app" | "no-manifest";
  /** Its address under the zone: the preview, except for the landing. */
  address: string;
  /**
   * The project serves no page: services, none of them public, and no
   * `publicDir`, see isHeadless in bin/cli/manifest.ts. Its address answers a
   * line saying it runs in the background, which the page says beside it
   * rather than present it as a page.
   */
  headless: boolean;
  /**
   * One of the platform's own projects, the dashboard, the portal or
   * analytics, known by its slug deployed on that project's own port,
   * `PLATFORM_PORTS` of bin/cli/services.ts. Neither a list of slugs, which
   * would hide an owner's own project named `analytics`, nor a manifest key,
   * which a token could set to hide a project from the owner. The landing is
   * the owner's site, and not one of them.
   */
  platform: boolean;
  domain: Domain | null;
  lock: Lock;
  portal: Portal;
  port: number | null;
  /** A port declared and actually listening on the loopback interface. */
  listening: boolean | null;
  /**
   * The project's main unit, the one named after it: its main service, or the
   * anchor of a project whose every service is scheduled, which runs nothing
   * and stays active (exited) to keep their timers armed. Judged the same way
   * either way: not active, the project is stopped.
   */
  service: Service | null;
  /**
   * Every process of an app, the main one first: the one above for a single
   * `start`, one per entry of `services` otherwise. Empty for a static site.
   * The anchor is not among them, being no service of the manifest's: when
   * every one is scheduled, none is `main`.
   */
  services: SiteService[];
  bytes: number | null;
  deployed: number | null;
  /**
   * What the deployed manifest says its services read, names only, never a
   * value, which does not come in here: the runtime variables' names, then
   * the store's files'. Build secrets are not among them: no service reads them.
   * Empty when the manifest declares nothing a service reads, or is unreadable.
   */
  secrets: string[];
};

/** One process of an app, as its manifest declares it and the machine runs it. */
export type SiteService = {
  /** Its name under `services`, null for a project with a single `start`. */
  name: string | null;
  /** The systemd unit, without `.service`. */
  unit: string;
  /**
   * What it is, see ServiceKind in bin/cli/manifest.ts: a server listens on
   * its port, a worker runs for good and listens on nothing, a scheduled
   * service runs at the times its schedule names and nothing between them.
   */
  kind: ServiceKind;
  /** The one the project is known by, whose unit carries its name. None is, when every service is scheduled. */
  main: boolean;
  port: number | null;
  listening: boolean | null;
  /** The paths Caddy sends it, null when it takes every path no other service claims. */
  routes: string[] | null;
  /** Reached by the project's other services alone, never by Caddy: an internal server, a worker, a scheduled service. */
  internal: boolean;
  service: Service | null;
  /** When it runs and how it ran, for a scheduled service alone. */
  schedule: Schedule | null;
};

/**
 * A scheduled service's timer and runs. Between two runs its unit is
 * inactive, which is its normal state: what says it still runs is its timer,
 * active (waiting), and what says it runs well is how its last run ended.
 */
export type Schedule = {
  /** The calendar expression, as the manifest writes it: `hourly`, `*:0/15`. */
  expression: string;
  /** How long one run may take before systemd stops it. */
  timeout: string;
  /** Its timer, as systemctl takes it: `<slug>.<name>.timer`. */
  timer: string;
  /**
   * Its timer's state, or null when the collector did not read it, one older
   * than scheduled services: unknown, and judged as nothing.
   */
  timerState: TimerState | null;
  /** When the timer last started the service, in epoch milliseconds: what is known of a run after a reboot. */
  lastTrigger: number | null;
  /** When it starts it next, null when the timer is not active. */
  next: number | null;
  /** The last run that ended, null while one runs or before the first. */
  lastRun: Run | null;
};

export type TimerState = { loaded: boolean; active: string; subState: string };

/** How a scheduled run ended, from its unit's Result and ExecMainStatus. */
export type Run = {
  /** When it ended, or started, or was last triggered, whichever systemd still knows; null when none. */
  at: number | null;
  ok: boolean;
  /** systemd's word for how it ended: `success`, `exit-code`, `signal`, `timeout`, `oom-kill`; null when not read. */
  result: string | null;
  /** The exit code, or the number of the signal that ended it. */
  status: number | null;
  /** How it failed, in a few words: "exit code 1", "stopped after its timeout of 1h". Null for a run that went well. */
  failure: string | null;
};

export type Discrepancy = {
  slug: string | null;
  severity: "error" | "warning";
  message: string;
};

export type Snapshot = {
  generated: number;
  zone: string;
  sites: Site[];
  discrepancies: Discrepancy[];
  machine: RawMachine | null;
};

/** An integer from `systemctl show`, whose absence is written in three ways. */
function readNumber(unit: RawUnit | null, key: string): number | null {
  const raw = unit?.[key];
  if (raw === undefined || raw === "" || raw === "[not set]" || raw === "infinity") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * A timestamp from `systemctl show --timestamp=unix`, which is written
 * `@1756400000`. The collector sets that format expressly: without it, systemd
 * returns a date spelled out in full, in the machine's time zone and language,
 * which would have to be parsed again here for a less certain result.
 */
function readTimestamp(unit: RawUnit, key: string): number | null {
  const raw = unit[key];
  if (raw === undefined) return null;
  // A timer's next and last elapse ignore `--timestamp=unix`: the collector
  // asks them in UTC, and they come as a date, `Tue 2026-10-13 15:30:00 UTC`.
  const date = /^[A-Z][a-z]{2} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(raw);
  if (date !== null) {
    const ms = Date.parse(`${date[1]}T${date[2]}Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (!raw.startsWith("@")) return null;
  const seconds = Number(raw.slice(1));
  // Zero is the value of a service that has never started, not a date.
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * The share of a core consumed between two readings, as a percentage.
 *
 * Returns null rather than zero when the measurement makes no sense: no
 * predecessor, a counter going backwards because the service restarted between
 * the two, or a null window. A zero displayed in those cases would read as a
 * service at rest, which is exactly the error not to induce.
 *
 * The result can go beyond one hundred: a service with several threads
 * consumes several cores, and capping it would mask what the machine load, for
 * its part, shows.
 */
export function computeCpuShare(
  nsecNow: number | null,
  nsecBefore: number | undefined,
  windowMs: number,
): number | null {
  if (nsecNow === null || nsecBefore === undefined) return null;
  if (windowMs <= 0) return null;

  const elapsed = nsecNow - nsecBefore;
  if (elapsed < 0) return null;

  // Nanoseconds of CPU over milliseconds of wall clock: the ratio comes back
  // to a percentage through a factor of one million.
  return Math.round((elapsed / (windowMs * 1_000_000)) * 1000) / 10;
}

function readService(
  name: string,
  unit: RawUnit | null,
  cpuBefore: number | undefined,
  windowMs: number,
): Service | null {
  // LoadState distinguishes the missing unit from the stopped unit: a static
  // site has no unit, and displaying it as a fallen service would be a
  // permanent false alarm.
  if (unit === null || unit.LoadState !== "loaded") return null;

  const cpu = readNumber(unit, "CPUUsageNSec");

  return {
    unit: name,
    loaded: true,
    active: unit.ActiveState ?? "unknown",
    subState: unit.SubState ?? "unknown",
    memory: readNumber(unit, "MemoryCurrent"),
    // The peak since the last startup, which systemd keeps itself: the current
    // value says nothing about the moment when the service consumed the most,
    // and it goes back to zero at every restart.
    peak: readNumber(unit, "MemoryPeak"),
    limit: readNumber(unit, "MemoryMax"),
    restarts: readNumber(unit, "NRestarts"),
    since: readTimestamp(unit, "ActiveEnterTimestamp"),
    cpuTotal: cpu === null ? null : Math.round(cpu / 1_000_000),
    cpuShare: computeCpuShare(cpu, cpuBefore, windowMs),
  };
}

/** A unit in one of these states is running, or about to run, or about to stop: a run in progress. */
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading"]);

/**
 * How a run failed, in the words of a person reading the page. systemd's
 * Result says the way, ExecMainStatus the code or the signal, and a run
 * stopped by RuntimeMaxSec ends in `timeout`.
 */
function failureOf(result: string | null, status: number | null, timeout: string): string {
  switch (result) {
    case "exit-code":
      return status === null ? "it exited with an error" : `exit code ${status}`;
    case "signal":
    case "core-dump":
      return status === null ? "killed by a signal" : `killed by signal ${status}`;
    case "timeout":
      return `stopped after its timeout of ${timeout}`;
    case "oom-kill":
      return "killed for lack of memory";
    case null:
      return "failed";
    default:
      return result;
  }
}

/**
 * The last run of a scheduled service that ended, from its unit's reading.
 *
 * None while a run is in progress: systemd resets Result as a run starts, so
 * the previous one's is gone, and the page says it is running instead. None
 * either before the first run since the unit was loaded, a reboot included.
 * The timer's last trigger is no run: a persistent timer stamps the moment
 * it was first started, at the deployment, as a trigger that ran nothing.
 */
function readRun(unit: RawUnit | null, lastTrigger: number | null, timeout: string): Run | null {
  if (unit === null || unit.LoadState !== "loaded") return null;
  const active = unit.ActiveState ?? "unknown";
  if (RUNNING_STATES.has(active)) return null;

  const result = unit.Result ?? null;
  const started = readTimestamp(unit, "ExecMainStartTimestamp");
  const ended = readTimestamp(unit, "ExecMainExitTimestamp");
  const ok = active !== "failed" && (result === null || result === "success");
  // Nothing ran: a failure that never got to start the program, such as a
  // missing account, still says so through `failed`.
  if (ok && started === null && ended === null) return null;
  const status = readNumber(unit, "ExecMainStatus");
  return {
    at: ended ?? started ?? lastTrigger,
    ok,
    result,
    status,
    failure: ok ? null : failureOf(result, status, timeout),
  };
}

/**
 * A scheduled service's timer and runs. `units` is what the collector read
 * beside the main unit: the timer missing from it was not read, which is not
 * a timer missing from the machine.
 */
function readSchedule(view: ServiceView, units: RawFolder["units"]): Schedule {
  const timer = timerUnit(view);
  const timeout = view.timeout ?? "";
  const rawTimer = units?.[timer];
  const timerState: TimerState | null =
    rawTimer === undefined
      ? null
      : {
          loaded: rawTimer !== null && rawTimer.LoadState === "loaded",
          active: rawTimer?.ActiveState ?? "unknown",
          subState: rawTimer?.SubState ?? "unknown",
        };
  const armed = timerState !== null && timerState.loaded && timerState.active === "active";
  const lastTrigger = rawTimer == null ? null : readTimestamp(rawTimer, "LastTriggerUSec");
  return {
    expression: view.schedule ?? "",
    timeout,
    timer,
    timerState,
    lastTrigger,
    next: armed && rawTimer != null ? readTimestamp(rawTimer, "NextElapseUSecRealtime") : null,
    lastRun: readRun(units?.[view.unit] ?? null, lastTrigger, timeout),
  };
}

/**
 * The domains Caddy actually routes, read in the table rather than deduced
 * from the manifests: it is the discrepancy between the two that is of
 * interest.
 *
 * The format is that of `api/src/table.ts#release`, a tabulation then
 * `<domain> <slug>`. A line that cannot be read is ignored rather than making
 * the whole reading fail: a mute dashboard is worth less than an incomplete
 * dashboard.
 */
export function readTable(content: string | null): Map<string, string> {
  const table = new Map<string, string>();
  if (content === null) return table;

  for (const line of content.split("\n")) {
    const clean = line.trim();
    if (clean === "" || clean.startsWith("#")) continue;
    const parts = clean.split(/\s+/);
    const domain = parts[0];
    const slug = parts[1];
    if (domain === undefined || slug === undefined) continue;
    table.set(domain, slug);
  }
  return table;
}

/** The codes in force. An unreadable file is a discrepancy, never a silence. */
function readCodes(content: string | null): { codes: Record<string, unknown>; error: string | null } {
  if (content === null) {
    return { codes: {}, error: "Lock code table unreadable: locks cannot be displayed" };
  }
  try {
    const object = JSON.parse(content) as unknown;
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      return { codes: {}, error: "Lock code table malformed: an object was expected" };
    }
    return { codes: object as Record<string, unknown>, error: null };
  } catch (err) {
    return { codes: {}, error: `Lock code table unreadable: ${(err as Error).message}` };
  }
}

function readManifest(raw: string | null): { manifest: Manifest | null; error: string | null } {
  if (raw === null) return { manifest: null, error: null };
  try {
    const object = JSON.parse(raw) as unknown;
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      return { manifest: null, error: "sitesolide.json does not contain an object" };
    }
    return { manifest: object as Manifest, error: null };
  } catch (err) {
    return { manifest: null, error: `sitesolide.json unreadable: ${(err as Error).message}` };
  }
}

function readDomain(manifest: Manifest | null, table: Map<string, string>): Domain | null {
  const declared = manifest?.domain;
  if (declared === undefined || typeof declared.name !== "string") return null;

  const aliases = (declared.aliases ?? []).filter((name): name is string => typeof name === "string");
  return {
    name: declared.name,
    aliases,
    active: declared.active === true,
    route: table.has(declared.name),
  };
}

function readLock(slug: string, manifest: Manifest | null, codes: Record<string, unknown>, zone: string): Lock {
  const closed = manifest?.lock === true;
  const raw = codes[slug];
  const code = isValidCode(raw) ? raw : null;
  return {
    closed,
    code,
    // The address the client receives once and that his browser then keeps in
    // a cookie. It carries the code in the clear, like the Caddy fragment.
    url: code === null ? null : `https://${codeAddress(slug, zone, manifest)}/?key=${code}`,
  };
}

function readPortal(manifest: Manifest | null, fragment: string | undefined): Portal {
  return {
    wanted: manifest !== null && isProtected(manifest),
    installed: fragment !== undefined && fragmentIsProtected(fragment),
    identity: fragment !== undefined && fragmentPassesIdentity(fragment),
    exemptions: (manifest?.portalExempt ?? []).filter((path): path is string => typeof path === "string"),
  };
}

/**
 * The names `Site.secrets` carries: its runtime variables then its files.
 * Read tolerantly, as every deployed manifest is (`secretsOf` never throws).
 */
export function declaredSecrets(manifest: Manifest): string[] {
  const declaration = secretsOf(manifest);
  return [...declaration.runtime, ...declaration.files];
}

/** The complete snapshot, sites sorted by slug and discrepancies sorted by severity. */
export function buildSnapshot(raw: Raw): Snapshot {
  const table = readTable(raw.domains);
  const { codes, error: codesError } = readCodes(raw.codes);
  const discrepancies: Discrepancy[] = [];
  const sites: Site[] = [];

  if (codesError !== null) {
    discrepancies.push({ slug: null, severity: "error", message: codesError });
  }

  const folders = [...raw.folders].sort((a, b) => a.slug.localeCompare(b.slug));

  // The window between the two readings, the one over which the CPU rates are
  // computed. Zero without a predecessor, which computeCpuShare treats as an absence.
  const windowMs = raw.previous === null ? 0 : raw.generated - raw.previous.generated;

  for (const folder of folders) {
    const { slug } = folder;
    const { manifest, error } = readManifest(folder.manifest);
    const service = readService(unitOf(slug), folder.unit, raw.previous?.cpu[slug], windowMs);

    if (error !== null) {
      // This manifest is the one the domain table and the lock generator read:
      // unreadable, it stops both.
      discrepancies.push({ slug, severity: "error", message: error });
    }

    const app = manifest !== null && isApp(manifest);
    const type: Site["type"] =
      manifest !== null
        ? app
          ? "app"
          : "static"
        : service !== null
          ? "app"
          : "no-manifest";

    // The main service's: the only one of a single `start`, the first of
    // `services` that runs for good, whose unit carries the project's name.
    // None for a worker, which listens on nothing, nor for an anchor.
    const port = manifest === null ? null : mainPort(manifest);
    const domain = readDomain(manifest, table);

    // The main service is the one read above, its unit named after the
    // project; when every service is scheduled, what was read above is the
    // anchor, and none of them is the main one. The others come from the
    // units the collector read beside it, their CPU counters keyed by unit
    // name, which a slug never matches since it carries no dot.
    const views = manifest === null || !app ? [] : servicesOf(manifest);
    const services: SiteService[] = views.map((view) => {
      const main = view.unit === manifest!.slug;
      const servicePort = typeof view.port === "number" ? view.port : null;
      return {
        name: view.name,
        unit: main ? unitOf(slug) : view.unit,
        kind: view.kind,
        main,
        port: servicePort,
        listening: servicePort === null ? null : raw.ports.includes(servicePort),
        routes: Array.isArray(view.routes) ? view.routes : null,
        internal: view.internal,
        service: main ? service : readService(view.unit, folder.units?.[view.unit] ?? null, raw.previous?.cpu[view.unit], windowMs),
        schedule: view.kind === "scheduled" ? readSchedule(view, folder.units) : null,
      };
    });

    sites.push({
      slug,
      description: typeof manifest?.description === "string" ? manifest.description : null,
      type,
      address: addressOf(slug, raw.zone),
      headless: manifest !== null && app && isHeadless(manifest),
      platform: port !== null && PLATFORM_PORTS.get(port) === slug,
      domain,
      lock: readLock(slug, manifest, codes, raw.zone),
      portal: readPortal(manifest, raw.blocks[slug]),
      port,
      listening: port === null ? null : raw.ports.includes(port),
      service,
      services,
      bytes: folder.bytes,
      deployed: folder.deployed,
      secrets: manifest === null ? [] : declaredSecrets(manifest),
    });
  }

  discrepancies.push(...findDiscrepancies(sites, raw));
  discrepancies.push(...monitorDiscrepancies(raw.monitor, raw.generated));
  const rank = { error: 0, warning: 1 };
  discrepancies.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.slug ?? "").localeCompare(b.slug ?? ""));

  return { generated: raw.generated, zone: raw.zone, sites, discrepancies, machine: raw.machine };
}

/**
 * A scheduled service, judged by its timer and its last run rather than by
 * its unit's state: inactive between two runs is what it should be.
 *
 * A timer that is not active is an error, as a fallen service is: the
 * schedule stopped, and nothing runs any more while the page would otherwise
 * show a quiet service. A run that failed is a warning, named with when and
 * how: the next run may go well, and the service is not down for it. The
 * monitor reports both too; src/monitor.ts leaves them to this function.
 */
function scheduleDiscrepancies(slug: string, name: string | null, schedule: Schedule, generated: number): Discrepancy[] {
  const { timerState, lastRun } = schedule;
  if (timerState !== null && !timerState.loaded) {
    return [{ slug, severity: "error", message: `Service ${name}: no loaded timer (${schedule.timer}), it never runs` }];
  }
  const found: Discrepancy[] = [];
  if (timerState !== null && timerState.active !== "active") {
    found.push({
      slug,
      severity: "error",
      message: `Service ${name}: its schedule is stopped, ${schedule.timer} is ${timerState.active} (${timerState.subState})`,
    });
  }
  if (lastRun !== null && !lastRun.ok) {
    const when = lastRun.at === null ? "" : ` ${duration(Math.max(0, generated - lastRun.at))} ago`;
    found.push({ slug, severity: "warning", message: `Service ${name}: last run failed${when} (${lastRun.failure})` });
  }
  return found;
}

/**
 * The discrepancies between what the repository wants and what the machine
 * does.
 *
 * It is the only part of the dashboard that teaches you something: the rest is
 * already read in git. The first two rules take up those that stop the
 * gatekeeper's generation of the preview locks (`buildFragment` in
 * api/src/locks.ts), so that a disagreement shows here before stopping a
 * change of general access on a completely different site.
 */
export function findDiscrepancies(sites: Site[], raw: Raw): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const known = new Set(sites.map((site) => site.slug));

  for (const site of sites) {
    const { slug, lock } = site;

    if (lock.closed && lock.code === null) {
      discrepancies.push({
        slug,
        severity: "error",
        message:
          "Preview code requested but none is valid: every change of a preview code will be refused until it is mended. " +
          "Choose one in its Access section"
      });
    }

    // Restricted, in both directions. The first case is the worst possible
    // state: the manifest says restricted, Caddy serves to anyone.
    const { portal } = site;
    if (portal.wanted && !portal.installed) {
      discrepancies.push({
        slug,
        severity: "error",
        message: "Restricted in sitesolide.json, public on the server: anyone can open the site. Choose one in its Access section",
      });
    }

    if (!portal.wanted && portal.installed) {
      discrepancies.push({
        slug,
        severity: "error",
        message: "Restricted on the server, public in sitesolide.json. Choose one in its Access section",
      });
    }

    if (!lock.closed && lock.code !== null) {
      discrepancies.push({
        slug,
        severity: "error",
        message:
          "Preview code in effect although sitesolide.json no longer asks for one. " +
          "Choose one in its Access section"
      });
    }

    if (site.domain !== null) {
      if (site.domain.active && !site.domain.route) {
        discrepancies.push({
          slug,
          severity: "error",
          message:
            `${site.domain.name} is active in the manifest but missing from the table: ` +
            "no routing and no certificate until bin/generate-domains.sh has run",
        });
      }
      if (!site.domain.active && site.domain.route) {
        discrepancies.push({
          slug,
          severity: "warning",
          message: `${site.domain.name} is routed although the manifest no longer activates it`,
        });
      }
    }

    // The main unit, the project's main service or the anchor of a project
    // whose every service is scheduled: either way, not active, the project is
    // stopped, timers included.
    if (site.type === "app") {
      if (site.service === null) {
        discrepancies.push({
          slug,
          severity: "error",
          message: site.headless
            ? "App project without a loaded unit: none of its services runs"
            : "App project without a loaded unit: nothing answers behind Caddy",
        });
      } else if (site.service.active !== "active") {
        discrepancies.push({
          slug,
          severity: "error",
          message: `Service ${site.service.active} (${site.service.subState})`,
        });
      }

      if (site.listening === false) {
        discrepancies.push({
          slug,
          severity: "error",
          message: `Port ${site.port} declared, but nothing listens on it on the loopback interface`,
        });
      }
    }

    // The project's other services, each judged and named, since the main
    // one's word says nothing of the process it calls.
    for (const other of site.services.filter((entry) => !entry.main)) {
      if (other.service === null) {
        discrepancies.push({
          slug,
          severity: "error",
          message: `Service ${other.name}: no loaded unit (${other.unit}.service)`,
        });
      } else if (other.schedule !== null) {
        discrepancies.push(...scheduleDiscrepancies(slug, other.name, other.schedule, raw.generated));
      } else if (other.service.active !== "active") {
        // A server or a worker runs for good: not active, it is down.
        discrepancies.push({
          slug,
          severity: "error",
          message: `Service ${other.name} ${other.service.active} (${other.service.subState})`,
        });
      }
      if (other.listening === false) {
        discrepancies.push({
          slug,
          severity: "error",
          message: `Service ${other.name}: port ${other.port} declared, but nothing listens on it on the loopback interface`,
        });
      }
    }

    const measured = site.services.length > 0 ? site.services : [{ name: null, main: true, service: site.service }];
    for (const { name, main, service: measuredService } of measured) {
      const peak = measuredService?.peak ?? null;
      const limit = measuredService?.limit ?? null;
      if (peak !== null && limit !== null && limit > 0 && peak >= limit * WORRYING_PEAK_SHARE) {
        // Unnamed for the one service of a project; named as soon as there is
        // another, or when it is not the main one, beside an anchor.
        const unnamed = name === null || (main && site.services.length === 1);
        discrepancies.push({
          slug,
          severity: "warning",
          message: `${unnamed ? "Memory" : `Service ${name}: memory`} peak at ${Math.round((peak / limit) * 100)}% of the limit`,
        });
      }
    }

    if (site.type === "no-manifest" && slug !== LANDING_FOLDER) {
      discrepancies.push({
        slug,
        severity: "warning",
        message:
          "Folder served without sitesolide.json: no lock or domain possible " +
          "until a sitesolide deploy puts one there",
      });
    }
  }

  // The portal itself, said once and not per site: stopped, all the sites that
  // pass behind it answer 502, and none of them serves anything at all.
  const protectedSites = sites.filter((site) => site.portal.wanted);
  const portalService = sites.find((site) => site.slug === PORTAL_SLUG)?.service ?? null;
  if (protectedSites.length > 0 && portalService?.active !== "active") {
    discrepancies.push({
      slug: PORTAL_SLUG,
      severity: "error",
      message:
        `${protectedSites.length} restricted site(s), and the portal that signs people in is not running: ` +
        "they answer 502 and nobody gets in",
    });
  }

  // The machine's load average, the only discrepancy the CPU deserves here.
  //
  // Nothing per service: no threshold would be defensible, a build going up to
  // one hundred percent of a core without anything going wrong. A list of
  // discrepancies that cries out for nothing stops being read. The load
  // average, for its part, says something precise: beyond the number of
  // cores, work is waiting its turn.
  const machine = raw.machine;
  if (machine?.load5 != null && machine.cores != null && machine.load5 > machine.cores) {
    discrepancies.push({
      slug: null,
      severity: "warning",
      message:
        `Load average of ${machine.load5} over five minutes for ${machine.cores} cores: ` +
        "work is waiting its turn",
    });
  }

  // A Caddy block in service that no directory claims any more. The check
  // already exists in bin/deploy-caddy.sh, which runs only at deployment;
  // this one sees it in between.
  for (const block of Object.keys(raw.blocks)) {
    if (!known.has(block)) {
      discrepancies.push({
        slug: block,
        severity: "warning",
        message: "Live Caddy fragment with no matching folder in /srv/sites",
      });
    }
  }

  return discrepancies;
}
