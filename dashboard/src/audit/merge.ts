/**
 * What the Activity page's route decides, pure: the query it accepts, which
 * rows match it, which site a target names, the cursor, and the merge of the
 * sources' rows into one page, newest first.
 *
 * ## Why the cursor carries one position per source
 *
 * No two components share an id, a clock or a page size, and none of them can
 * be asked for "the rows older than this date": the portal, the egress proxy
 * and the backups page by their own ids, the steward's journal by date, and an
 * older steward hands over its latest entries and nothing more.
 * What each one does guarantee is an order of its own, newest first. So the
 * merge reads each source as a stream, takes the newest head among them, and
 * remembers, per source, the last row it handed over. The next page asks each
 * source for what comes after that row, and no row is ever skipped nor shown
 * twice, whatever arrived in between.
 *
 * ## Why a page may hold fewer rows than asked
 *
 * A source is read within a budget. One that runs out of it before finding
 * enough matching rows has older rows still unread, and a row of another
 * source older than the last one it read could be newer than those: it waits
 * for the next page. The source that stopped the page has been read to the end
 * of its budget, so the next page always goes further.
 */
import type { Snapshot } from "../state";
import { isAfter, MAX_TEXT, type Position } from "./normalize";
import { AUDIT_SOURCES, DEFAULT_LIMIT, MAX_LIMIT, type AuditRow, type AuditSource } from "./protocol";

// --- The query ----------------------------------------------------------------------

export type AuditQuery = {
  /** In the order of AUDIT_SOURCES, every one when the query names none. */
  sources: AuditSource[];
  /** Lowercase; a row matches when its actor contains it. */
  actor: string | null;
  /** Lowercase; a row matches when its action starts with it. */
  action: string | null;
  /** Lowercase; a slug or a host, see `matches`. */
  target: string | null;
  /** Milliseconds, inclusive. */
  from: number | null;
  /** Milliseconds, exclusive. */
  to: number | null;
  limit: number;
  cursor: string | null;
  /**
   * What a member may read: the rows of their projects, and their own. Never
   * from the address: the route sets it from the session, and null is the
   * owner's whole machine.
   */
  restrict: Restriction | null;
};

/** A member's view of the audit: the sites they hold a role on, and the rows they are the actor of. */
export type Restriction = { sites: string[]; actor: string };

/** Long enough for a page's positions, short enough to stay a parameter. */
export const MAX_CURSOR = 2048;

function single(params: URLSearchParams, key: string): string | null | { error: string } {
  const values = params.getAll(key);
  if (values.length > 1) return { error: `${key}: give it once` };
  const value = values[0]?.trim() ?? "";
  if (value === "") return null;
  if (value.length > MAX_TEXT) return { error: `${key}: ${MAX_TEXT} characters at most` };
  return value;
}

function instant(params: URLSearchParams, key: string): number | null | { error: string } {
  const value = single(params, key);
  if (value === null || typeof value === "object") return value;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : { error: `${key}: a date, such as 2026-10-04T00:00:00Z` };
}

/** The query of `GET /api/audit`, or what is wrong with it, in words the page can show. */
export function readQuery(params: URLSearchParams): AuditQuery | { error: string } {
  const named = params
    .getAll("source")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const unknown = named.find((value) => !(AUDIT_SOURCES as readonly string[]).includes(value));
  if (unknown !== undefined) return { error: `source: one of ${AUDIT_SOURCES.join(", ")}` };
  const sources = named.length === 0 ? [...AUDIT_SOURCES] : AUDIT_SOURCES.filter((source) => named.includes(source));

  const actor = single(params, "actor");
  const action = single(params, "action");
  const target = single(params, "target");
  const from = instant(params, "from");
  const to = instant(params, "to");
  for (const value of [actor, action, target, from, to]) {
    if (value !== null && typeof value === "object") return value;
  }
  if (typeof from === "number" && typeof to === "number" && from >= to) return { error: "from: before to" };

  const limitText = single(params, "limit");
  if (limitText !== null && typeof limitText === "object") return limitText;
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `limit: a whole number from 1 to ${MAX_LIMIT}` };

  const cursors = params.getAll("cursor");
  if (cursors.length > 1) return { error: "cursor: give it once" };
  const cursor = cursors[0] ?? null;
  if (cursor !== null && (cursor === "" || cursor.length > MAX_CURSOR)) return { error: "cursor: not one this dashboard gave" };

  const lower = (value: string | null | { error: string }) => (typeof value === "string" ? value.toLowerCase() : null);
  return {
    sources,
    actor: lower(actor),
    action: lower(action),
    target: lower(target),
    from: typeof from === "number" ? from : null,
    to: typeof to === "number" ? to : null,
    limit,
    cursor,
    restrict: null,
  };
}

// --- Sites ------------------------------------------------------------------------

/** The site a target names, or null: the slug itself, a host of the site, or `<slug>.<zone>`. */
export type SiteResolver = (target: string) => string | null;

/**
 * Built from the snapshot: the slugs it lists, and every host it routes to
 * one of them, the address under the zone, the domain and its aliases.
 * Without a snapshot, a target with no dot is taken for a slug, and a host
 * under the zone for its first label.
 */
export function siteResolver(snapshot: Snapshot | null, zone: string): SiteResolver {
  const slugs = new Set(snapshot?.sites.map((site) => site.slug.toLowerCase()) ?? []);
  const hosts = new Map<string, string>();
  for (const site of snapshot?.sites ?? []) {
    const slug = site.slug.toLowerCase();
    for (const host of [site.address, site.domain?.name ?? null, ...(site.domain?.aliases ?? [])]) {
      if (host !== null && host !== "") hosts.set(host.toLowerCase(), slug);
    }
  }
  const suffix = zone === "" ? null : `.${zone.toLowerCase()}`;
  return (raw) => {
    const target = raw.toLowerCase();
    if (slugs.has(target)) return target;
    const routed = hosts.get(target);
    if (routed !== undefined) return routed;
    if (suffix !== null && target.endsWith(suffix)) {
      const label = target.slice(0, -suffix.length);
      if (label !== "" && !label.includes(".") && (snapshot === null || slugs.has(label))) return label;
    }
    if (snapshot === null && !target.includes(".")) return target;
    return null;
  };
}

/**
 * The site of a row. A connector's change names the connector, which is no
 * site even when a site bears the same name.
 */
export function siteOf(row: Omit<AuditRow, "site">, resolve: SiteResolver): string | null {
  if (row.target === null || row.action === "connector.update") return null;
  return resolve(row.target);
}

// --- Filters ----------------------------------------------------------------------

/**
 * A target matches the row that names it, and every row of the site it names:
 * `cms` finds the portal's sign-ins on `cms.<zone>` and on the site's own
 * domain, and the host finds the steward's operations on `cms`.
 */
export function matches(
  row: AuditRow,
  query: Pick<AuditQuery, "actor" | "action" | "target" | "from" | "to"> & { restrict?: Restriction | null },
  resolve: SiteResolver,
): boolean {
  const restrict = query.restrict ?? null;
  if (restrict !== null && row.actor !== restrict.actor && (row.site === null || !restrict.sites.includes(row.site))) return false;
  if (query.actor !== null && !row.actor.toLowerCase().includes(query.actor)) return false;
  if (query.action !== null && !row.action.toLowerCase().startsWith(query.action)) return false;
  if (query.target !== null) {
    const named = row.target?.toLowerCase() === query.target;
    const site = row.site !== null && (row.site === query.target || row.site === resolve(query.target));
    if (!named && !site) return false;
  }
  const ms = Date.parse(row.at);
  if (query.from !== null && ms < query.from) return false;
  if (query.to !== null && ms >= query.to) return false;
  return true;
}

// --- The cursor -------------------------------------------------------------------

/** Where a source stands: nothing handed over yet, after a row, or read to its end. */
export type Standing = "start" | "end" | Position;

export type Standings = Partial<Record<AuditSource, Standing>>;

/**
 * The filters a cursor was made under. A cursor read under others would skip
 * rows that the new filters keep: it is refused instead.
 */
export function fingerprint(query: Pick<AuditQuery, "sources" | "actor" | "action" | "target" | "from" | "to"> & { restrict?: Restriction | null }): string {
  const { sources, actor, action, target, from, to } = query;
  // A member's cursor is no one else's: their restriction is part of it.
  const restrict = query.restrict ?? null;
  const scope = restrict === null ? [] : [[...restrict.sites].sort(), restrict.actor];
  return Bun.hash(JSON.stringify([sources, actor, action, target, from, to, ...scope])).toString(36);
}

export function encodeCursor(print: string, standings: Standings): string {
  return Buffer.from(JSON.stringify({ v: 1, f: print, p: standings })).toString("base64url");
}

function isStanding(value: unknown): value is Standing {
  if (value === "start" || value === "end") return true;
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "number" && Number.isSafeInteger(part)) &&
    (value[1] as number) >= 0
  );
}

/** The standings a cursor carries, or why it will not do. */
export function decodeCursor(cursor: string, print: string, sources: readonly AuditSource[]): Standings | { error: string } {
  const refused = { error: "cursor: not one this dashboard gave, read the first page again" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return refused;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refused;
  const { v, f, p } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof p !== "object" || p === null || Array.isArray(p)) return refused;
  if (f !== print) return { error: "cursor: made under other filters, read the first page again" };
  const standings: Standings = {};
  for (const [key, value] of Object.entries(p)) {
    if (!(sources as readonly string[]).includes(key) || !isStanding(value)) return refused;
    standings[key as AuditSource] = value;
  }
  return standings;
}

// --- The merge --------------------------------------------------------------------

/** What reading one source gave, for one page. */
export type Scan = {
  source: AuditSource;
  /** The rows matching the filters, in the source's order. */
  candidates: { position: Position; row: AuditRow }[];
  /** The last row read, matching or not, and its time; null when none was. */
  last: { position: Position; ms: number } | null;
  /** Nothing older is left to read for this query. */
  end: boolean;
  /** The source did not answer: none of its rows count, and the cursor does not read it again. */
  failed: boolean;
};

const ORDER = new Map(AUDIT_SOURCES.map((source, index) => [source, index]));

/** True when `a` comes before `b` on the page: newer, then by source, then newer in its source. */
function precedes(a: { source: AuditSource; ms: number; position: Position }, b: { source: AuditSource; ms: number; position: Position }): boolean {
  if (a.ms !== b.ms) return a.ms > b.ms;
  if (a.source !== b.source) return ORDER.get(a.source)! < ORDER.get(b.source)!;
  return isAfter(b.position, a.position);
}

/**
 * The page, newest first, and where each source stands after it.
 *
 * `starting`: where each scanned source stood before this page.
 */
export function merge(scans: readonly Scan[], starting: Standings, limit: number): { rows: AuditRow[]; standings: Standings } {
  // A source that stopped short of `limit` matches without reaching its end
  // has older rows unread: nothing older than the last row it read goes on
  // this page.
  let cutoff = -Infinity;
  for (const scan of scans) {
    const short = !scan.failed && !scan.end && scan.candidates.length < limit;
    if (short && scan.last !== null) cutoff = Math.max(cutoff, scan.last.ms);
  }

  const heads = scans.map(() => 0);
  const times = scans.map((scan) => scan.candidates.map((candidate) => Date.parse(candidate.row.at)));
  const rows: AuditRow[] = [];
  while (rows.length < limit) {
    let chosen = -1;
    for (let index = 0; index < scans.length; index++) {
      const scan = scans[index]!;
      const head = heads[index]!;
      if (scan.failed || head >= scan.candidates.length) continue;
      const ms = times[index]![head]!;
      if (ms < cutoff) continue;
      if (chosen === -1) {
        chosen = index;
        continue;
      }
      const best = scans[chosen]!;
      const contender = { source: scan.source, ms, position: scan.candidates[head]!.position };
      const current = { source: best.source, ms: times[chosen]![heads[chosen]!]!, position: best.candidates[heads[chosen]!]!.position };
      if (precedes(contender, current)) chosen = index;
    }
    if (chosen === -1) break;
    rows.push(scans[chosen]!.candidates[heads[chosen]!]!.row);
    heads[chosen]! += 1;
  }

  const standings: Standings = { ...starting };
  scans.forEach((scan, index) => {
    const head = heads[index]!;
    if (scan.failed) standings[scan.source] = "end";
    else if (head === scan.candidates.length) {
      // Every match handed over: what was read past them matched nothing.
      if (scan.end) standings[scan.source] = "end";
      else if (scan.last !== null) standings[scan.source] = scan.last.position;
    } else if (head > 0) standings[scan.source] = scan.candidates[head - 1]!.position;
  });
  return { rows, standings };
}

/** True when the cursor has nothing left to read. */
export function finished(standings: Standings, sources: readonly AuditSource[]): boolean {
  return sources.every((source) => standings[source] === "end");
}
