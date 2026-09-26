/**
 * The audience measurement of the sites, as the dashboard shows it.
 *
 * It is produced by another service, `analytics`, which lives in the sites
 * repository: it receives the page views, aggregates them, and drops a
 * snapshot in its own data directory. That file cannot be read directly by the
 * dashboard's service, whose unit replaces `/srv` by an empty mount: it is the
 * collector, under root, that copies it into the reading, exactly as it copies
 * the domain table.
 *
 * Two judgements live here, and none elsewhere:
 *
 *   - **the host table**, host to served directory, which the collector drops
 *     at `analytics` to tell it what it has the right to write. That confined
 *     service cannot build it: it sees neither the other projects' manifests
 *     nor `/etc/caddy/domains.map`. A deployed site therefore becomes
 *     measurable with no action at all;
 *   - **the rates**, bounce and reading time, computed at display time rather
 *     than written into the snapshot: a display rule that changes is then
 *     fixed by an ordinary `sitesolide deploy`.
 *
 * Pure: receives the reading, returns numbers. Nothing in it touches the disk.
 */
import type { Raw } from "./state";

/* --- the host table ------------------------------------------------------- */

/** The landing's directory bears the name of the bare domain, never `landing`. */
export const WWW_PREFIX = "www.";

/**
 * Host to served directory, for everything the machine serves.
 *
 * Three sources, and they do not overlap:
 *
 *   - the preview subdomain, `<folder>.<zone>`, which Caddy's wildcard block
 *     serves by naming convention, without configuration;
 *   - the domain table, which carries the clients' own domains and their
 *     `www`, generated from the manifests;
 *   - the bare domain and its `www`, for the directory that bears the name of
 *     the zone. It is the repository's only asymmetric correspondence, and it
 *     is written here because the directory's name cannot be deduced from it.
 */
export function hostTable(raw: Raw): Record<string, string> {
  const table: Record<string, string> = {};
  const zone = raw.zone;

  for (const folder of raw.folders) {
    if (folder.slug === zone) {
      table[zone] = folder.slug;
      table[`${WWW_PREFIX}${zone}`] = folder.slug;
      continue;
    }
    table[`${folder.slug}.${zone}`] = folder.slug;
  }

  // `\t<domain> <folder>` per line, plus a comment at the top. A line that
  // cannot be read is skipped: this table is generated, but it is re-read here
  // without assuming that it was generated correctly.
  for (const line of (raw.domains ?? "").split("\n")) {
    const clean = line.trim();
    if (clean === "" || clean.startsWith("#")) continue;

    const [domain, folder] = clean.split(/\s+/);
    if (domain === undefined || folder === undefined) continue;
    table[domain.toLowerCase()] = folder;
  }

  return table;
}

/* --- the snapshot --------------------------------------------------------- */

/** What `analytics/src/snapshot.ts` drops. The contract fits in this type. */
export type Row = { value: string; total: number };

export type DayCount = { day: string; views: number; visits: number };

export type Totals = {
  views: number;
  visits: number;
  bounces: number;
  timedViews: number;
  seconds: number;
};

export type SiteMeasure = {
  totals: Totals;
  days: DayCount[];
  rankings: Record<string, Row[]>;
};

export type AudienceSnapshot = {
  generatedAt: number;
  timeZone: string;
  days: number;
  from: string;
  to: string;
  sites: Record<string, SiteMeasure>;
};

/* --- what the dashboard displays ------------------------------------------ */

export type Measure = {
  views: number;
  visits: number;
  /** Share of single-page visits, as a whole percentage. */
  bounceRate: number;
  /** Seconds spent on average on a page whose departure was signalled. */
  timePerPage: number;
  /** Page views per visit, to one decimal. */
  pagesPerVisit: number;
  days: DayCount[];
  rankings: Record<string, Row[]>;
};

export type Audience = {
  /** True as soon as the snapshot has been read, even without a single measured site. */
  present: boolean;
  /** The age of the snapshot in milliseconds, or null if there is none. */
  age: number | null;
  /** Beyond that, the numbers are no longer today's. See STALE_AFTER_MS. */
  stale: boolean;
  days: number;
  from: string;
  to: string;
  sites: Record<string, Measure>;
};

/**
 * Beyond what age the snapshot stops being believed.
 *
 * `analytics` drops it every minute and the collector passes every minute: ten
 * minutes without news mean that one of the two no longer runs, and that is
 * exactly what a dashboard must not keep quiet about. The threshold is wider
 * than the three minutes of the machine's reading, an audience measurement
 * five minutes old having never made anyone take a bad decision.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const empty: Audience = {
  present: false,
  age: null,
  stale: false,
  days: 0,
  from: "",
  to: "",
  sites: {},
};

/** Share of `part` in `whole`, as a whole percentage. Zero if nothing was seen. */
export function percentage(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

/** Page views per visit, to one decimal. */
export function pagesPerVisit(views: number, visits: number): number {
  if (visits <= 0) return 0;
  return Math.round((views / visits) * 10) / 10;
}

/**
 * Average time per page, over the timed views alone.
 *
 * A browser closed outright sends no departure signal: counting those views as
 * zero would drag the average down for no reason.
 */
export function averageTime(seconds: number, timedViews: number): number {
  if (timedViews <= 0) return 0;
  return Math.round(seconds / timedViews);
}

/**
 * Interprets the snapshot copied by the collector.
 *
 * A missing snapshot is not an error: it is the state of a machine where
 * `analytics` has just been deployed, or whose collector has not yet run. An
 * unreadable snapshot is not one either, and the two are said the same way,
 * `present: false`.
 */
export function buildAudience(raw: Raw, now: number): Audience {
  const content = raw.audience;
  if (typeof content !== "string" || content.trim() === "") return empty;

  let snapshot: AudienceSnapshot;
  try {
    snapshot = JSON.parse(content) as AudienceSnapshot;
  } catch {
    return empty;
  }

  if (typeof snapshot !== "object" || snapshot === null || typeof snapshot.sites !== "object") {
    return empty;
  }

  const sites: Record<string, Measure> = {};
  for (const [name, measure] of Object.entries(snapshot.sites ?? {})) {
    const totals = measure?.totals;
    if (totals === undefined) continue;

    sites[name] = {
      views: totals.views,
      visits: totals.visits,
      bounceRate: percentage(totals.bounces, totals.visits),
      timePerPage: averageTime(totals.seconds, totals.timedViews),
      pagesPerVisit: pagesPerVisit(totals.views, totals.visits),
      days: Array.isArray(measure.days) ? measure.days : [],
      rankings: measure.rankings ?? {},
    };
  }

  const generatedAt = typeof snapshot.generatedAt === "number" ? snapshot.generatedAt : 0;
  const age = now - generatedAt;

  return {
    present: true,
    age,
    stale: age > STALE_AFTER_MS,
    days: snapshot.days ?? 0,
    from: snapshot.from ?? "",
    to: snapshot.to ?? "",
    sites,
  };
}
