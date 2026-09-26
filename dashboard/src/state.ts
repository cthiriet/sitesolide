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
 * which also decides what Caddy accepts, and `isApp` from
 * `bin/cli/manifest.ts`, which decides what the CLI generates. A dashboard
 * that rewrites these rules ends up displaying a state the machine denies, and
 * that is the reason the `dashboard/` folder is in this repository rather than
 * in a neighbouring one.
 *
 * The import goes through `borrowed/`, where `scripts/borrow.ts` copies these
 * two files before every build: the deployment's rsync carries only
 * `dashboard/`, and an import climbing higher makes the service fail on the VM
 * after a deployment that otherwise succeeded.
 */
import { isApp, isProtected, PORTAL_SLUG, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import { isValidCode, previewHost } from "../borrowed/locks";

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
  /** The paths the door lets through, public and under the site's sole guard. */
  exemptions: string[];
};

export type Site = {
  slug: string;
  description: string | null;
  type: "static" | "app" | "no-manifest";
  /** Its address under the zone: the preview, except for the landing. */
  address: string;
  domain: Domain | null;
  lock: Lock;
  portal: Portal;
  port: number | null;
  /** A port declared and actually listening on the loopback interface. */
  listening: boolean | null;
  service: Service | null;
  bytes: number | null;
  deployed: number | null;
  /** Names of the declared secrets. Never their content, which does not come in here. */
  secrets: string[];
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
  if (raw === undefined || !raw.startsWith("@")) return null;
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
  slug: string,
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
    unit: unitOf(slug),
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
    url: code === null ? null : `https://${addressOf(slug, zone)}/?key=${code}`,
  };
}

function readPortal(manifest: Manifest | null, fragment: string | undefined): Portal {
  return {
    wanted: manifest !== null && isProtected(manifest),
    installed: fragment !== undefined && fragmentIsProtected(fragment),
    exemptions: (manifest?.portalExempt ?? []).filter((path): path is string => typeof path === "string"),
  };
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
    const service = readService(slug, folder.unit, raw.previous?.cpu[slug], windowMs);

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

    const port = typeof manifest?.port === "number" ? manifest.port : null;
    const domain = readDomain(manifest, table);

    sites.push({
      slug,
      description: typeof manifest?.description === "string" ? manifest.description : null,
      type,
      address: addressOf(slug, raw.zone),
      domain,
      lock: readLock(slug, manifest, codes, raw.zone),
      portal: readPortal(manifest, raw.blocks[slug]),
      port,
      listening: port === null ? null : raw.ports.includes(port),
      service,
      bytes: folder.bytes,
      deployed: folder.deployed,
      secrets: (manifest?.secrets ?? []).filter((name): name is string => typeof name === "string"),
    });
  }

  discrepancies.push(...findDiscrepancies(sites, raw));
  const rank = { error: 0, warning: 1 };
  discrepancies.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.slug ?? "").localeCompare(b.slug ?? ""));

  return { generated: raw.generated, zone: raw.zone, sites, discrepancies, machine: raw.machine };
}

/**
 * The discrepancies between what the repository wants and what the machine
 * does.
 *
 * It is the only part of the dashboard that teaches you something: the rest is
 * already read in git. The first two rules take up those that stop
 * `api/scripts/generate-locks.ts`, so that a disagreement shows here before
 * stopping the regeneration triggered by a completely different site.
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
          "Lock requested without a valid code: the next regeneration will fail, " +
          `lock it again with "bin/lock.sh enable ${slug}"`,
      });
    }

    // The portal's door, in both directions. The first case is the worst
    // possible state: the manifest says closed, Caddy serves in the clear.
    const { portal } = site;
    if (portal.wanted && !portal.installed) {
      discrepancies.push({
        slug,
        severity: "error",
        message:
          "Portal requested but missing from the live Caddy block: the site is " +
          "served unprotected. Redeploy with \"sitesolide deploy --force\" from its folder",
      });
    }

    if (!portal.wanted && portal.installed) {
      discrepancies.push({
        slug,
        severity: "error",
        message:
          "Portal in the live Caddy block although the manifest no longer asks for it: " +
          "the site stays closed, and nobody knows which of the two is authoritative",
      });
    }

    if (!lock.closed && lock.code !== null) {
      discrepancies.push({
        slug,
        severity: "error",
        message:
          "Code in effect without a lock requested: the manifest lost its lock, " +
          `remove the code with "bin/lock.sh disable ${slug}"`,
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

    if (site.type === "app") {
      if (site.service === null) {
        discrepancies.push({
          slug,
          severity: "error",
          message: "App project without a loaded unit: nothing answers behind Caddy",
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

    const peak = site.service?.peak ?? null;
    const limit = site.service?.limit ?? null;
    if (peak !== null && limit !== null && limit > 0 && peak >= limit * WORRYING_PEAK_SHARE) {
      discrepancies.push({
        slug,
        severity: "warning",
        message: `Memory peak at ${Math.round((peak / limit) * 100)}% of the limit`,
      });
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
        `${protectedSites.length} site(s) behind the portal, whose service is not running: ` +
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
