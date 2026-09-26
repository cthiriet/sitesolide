import { join } from "node:path";

/** Local port of the service. See the platform's port allocation. */
export const PORT = Number(process.env.PORT ?? 3029);

/** The only writable location: to declare as `ReadWritePaths` in the unit. */
export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");

/** Served by Caddy without going through Bun, hence the variable. */
export const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(import.meta.dir, "..", "public");

/**
 * The public address of the service, as measured sites load it.
 *
 * It only serves the startup log, where it says what measured sites call. The
 * script, for its part, does not read it: it derives the address from its own
 * tag, and keeps working if the service moves.
 */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(
  /\/+$/,
  "",
);

/**
 * The time zone that cuts the days up.
 *
 * All measurement is returned by day, and a day only makes sense in a time
 * zone: cut in UTC, in summer, a visit at 11:30 pm would land on the next day
 * in the dashboard of whoever looks at it. Measured sites are French, their
 * visitors too, and it is that cut which must be read.
 *
 * It also decides the salt: a visitor fingerprint holds for a Paris day, not
 * for a Greenwich day.
 */
export const TIME_ZONE = process.env.TIME_ZONE ?? "Europe/Paris";

/**
 * Maximum size of a request body, applied by `Bun.serve` itself.
 *
 * A page view fits in two hundred bytes. The ceiling is wide so as never to
 * have to think about it, and small next to what a malicious sender would want
 * to send: the request is refused before the body is read in full.
 */
export const BODY_MAX = Number(process.env.BODY_MAX ?? 8 * 1024);

/**
 * Page views accepted from one same visitor in one minute.
 *
 * Nothing authenticates ingestion, and nothing can: the script runs in the
 * visitor's browser, a key placed there would be readable by them. This ceiling
 * is therefore the only thing separating a measurement from a counter someone
 * inflates by hand. Sixty pages in one minute is not reading, and the visitor
 * who reached them by accident loses only a part of their page views, never
 * their visit, already counted at the first one.
 */
export const VIEWS_PER_MINUTE = Number(process.env.VIEWS_PER_MINUTE ?? 60);

/**
 * Maximum duration kept for a single page view.
 *
 * Time spent is measured by a second signal, sent when the page is left or
 * hidden. A tab left open all night would send one of several hours, which on
 * its own would shift the average of the whole site. The ceiling truncates
 * rather than discards: the page view did take place.
 */
export const MAX_DURATION_S = Number(process.env.MAX_DURATION_S ?? 30 * 60);

/**
 * Retention by age. Four hundred days: enough to compare a month to last
 * year's, without keeping a log of visits indefinitely.
 */
export const RETENTION_MS = Number(process.env.RETENTION_MS ?? 400 * 24 * 60 * 60 * 1000);

/**
 * Retention by row count, the safeguard of the previous one.
 *
 * Four hundred days bound nothing if a site is pounded: all those page views
 * are recent. It is this ceiling that protects the disk, shared with every
 * other site on the machine, and the other one that protects relevance.
 */
export const MAX_VIEWS = Number(process.env.MAX_VIEWS ?? 5_000_000);

/**
 * Days of salts kept.
 *
 * This is the value that makes this service an anonymous measurement, and it
 * only holds because it is small: while a salt exists, anyone holding the
 * database can check that a given IP address visited a site that day, by
 * recomputing its fingerprint. Two days, because a day in progress needs
 * yesterday's salt until the time zone tips over; past that delay the salt is
 * destroyed, and the fingerprints it produced attach to nobody any more.
 */
export const SALTS_KEPT = Number(process.env.SALTS_KEPT ?? 2);

/**
 * The interval at which the snapshot the dashboard reads is dropped.
 *
 * One minute, exactly the interval of the collector that comes to fetch it:
 * dropping it less often would make the numbers stale, dropping it more often
 * would write for nobody. Composing it costs a few grouped queries on a
 * database of a few megabytes.
 */
export const SNAPSHOT_STEP_MS = Number(process.env.SNAPSHOT_STEP_MS ?? 60 * 1000);

/** The interval of the purge. One hour: retention is counted in days. */
export const PURGE_STEP_MS = Number(process.env.PURGE_STEP_MS ?? 60 * 60 * 1000);

/** Rows returned by the dashboard's rankings: pages, sources, devices. */
export const RANKING_MAX = Number(process.env.RANKING_MAX ?? 10);
