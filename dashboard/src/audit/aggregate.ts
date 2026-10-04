/**
 * One page of the machine's audit: every source asked for its rows within a
 * budget, at the same time, then merged (merge.ts).
 *
 * Built around its readers, like the dashboard's routes around their
 * correspondents: the tests drive it with simulated sources, slow, down or
 * answering garbage, with neither socket nor port.
 *
 * Everything is bounded. A source is asked for `fetchSize` rows at a time and
 * at most `maxFetches` times per page; the whole page has `deadlineMs`, under
 * the ten seconds after which Bun cuts a silent connection; the page holds
 * `limit` rows at most, MAX_LIMIT at the very most. A source that fails,
 * stalls or answers something unreadable is said so in `sources`, and the
 * others are shown all the same: one component down never empties the log.
 */
import { isAfter, type Position, type SourceRow } from "./normalize";
import { decodeCursor, encodeCursor, fingerprint, finished, matches, merge, siteOf, type AuditQuery, type Scan, type SiteResolver, type Standings } from "./merge";
import type { AuditResponse, AuditSource, SourceState, SourceStatus } from "./protocol";

export type ReaderResult =
  | {
      kind: "rows";
      /** After the position asked for, newest first. */
      rows: SourceRow[];
      /** Nothing older can be read from this source. */
      end: boolean;
      /** The route only exposes the source's latest `window` entries: `end` is then the end of those. */
      window: number | null;
    }
  | { kind: "failed"; state: Exclude<SourceState, "ok">; message: string };

export type AuditReader = {
  /** The rows after `after`, null for the newest, `size` at most. Never rejects. */
  read: (after: Position | null, size: number) => Promise<ReaderResult>;
};

export type Readers = Record<AuditSource, AuditReader>;

export type Budget = {
  /** Rows asked of a source at once. */
  fetchSize: number;
  /** Times a source is asked, per page. */
  maxFetches: number;
  /** For the whole page, every source together. */
  deadlineMs: number;
};

/**
 * A thousand rows per source and per page, five thousand at most in all, in
 * eight seconds. Filters that match one row in ten thousand page through
 * empty answers rather than holding a request for a minute: the page asks
 * again, and every answer goes further.
 */
export const BUDGET: Budget = { fetchSize: 250, maxFetches: 4, deadlineMs: 8_000 };

/** A promise or null once `ms` have passed, without leaving a timer behind. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function safely(reader: AuditReader, after: Position | null, size: number): Promise<ReaderResult> {
  try {
    return await reader.read(after, size);
  } catch {
    return { kind: "failed", state: "unavailable", message: "The dashboard could not read this source." };
  }
}

type ScanOutcome = { scan: Scan; status: SourceStatus; scanned: number };

async function scanSource(
  source: AuditSource,
  reader: AuditReader,
  after: Position | null,
  query: AuditQuery,
  resolve: SiteResolver,
  budget: Budget,
  deadline: number,
  clock: () => number,
): Promise<ScanOutcome> {
  const scan: Scan = { source, candidates: [], last: null, end: false, failed: false };
  const status: SourceStatus = { name: source, state: "ok", message: null, window: null };
  let position = after;
  let scanned = 0;
  let window: number | null = null;

  for (let fetch = 0; fetch < budget.maxFetches && scan.candidates.length < query.limit && !scan.end; fetch++) {
    const remaining = deadline - clock();
    const result = remaining <= 0 ? null : await within(safely(reader, position, budget.fetchSize), remaining);
    if (result === null || result.kind === "failed") {
      status.state = result === null ? "unavailable" : result.state;
      status.message = result === null ? "Didn't answer in time." : result.message;
      // Rows already read stand; a source that gave nothing is left out of
      // this page and of the cursor.
      if (fetch === 0) scan.failed = true;
      break;
    }
    window = result.window;
    let fresh = 0;
    for (const { position: rowPosition, row } of result.rows) {
      // A source that ignored where to start hands back rows already read.
      if (position !== null && !isAfter(rowPosition, position)) continue;
      fresh++;
      scanned++;
      const ms = Date.parse(row.at);
      position = rowPosition;
      scan.last = { position: rowPosition, ms };
      // Newest first: past `from`, nothing older can match.
      if (query.from !== null && ms < query.from) {
        scan.end = true;
        break;
      }
      const full = { ...row, site: siteOf(row, resolve) };
      if (matches(full, query, resolve)) scan.candidates.push({ position: rowPosition, row: full });
    }
    if (result.end || fresh === 0) scan.end = true;
  }

  if (scan.end && window !== null) status.window = window;
  return { scan, status, scanned };
}

/**
 * The page the query asks for, or what is wrong with its cursor. `now` is the
 * clock the deadline is measured on, a parameter for the tests.
 */
export async function aggregate(
  query: AuditQuery,
  readers: Readers,
  resolve: SiteResolver,
  budget: Budget = BUDGET,
  clock: () => number = Date.now,
): Promise<AuditResponse | { error: string }> {
  const print = fingerprint(query);
  let starting: Standings = {};
  if (query.cursor !== null) {
    const decoded = decodeCursor(query.cursor, print, query.sources);
    if ("error" in decoded) return decoded;
    starting = decoded;
  }

  const deadline = clock() + budget.deadlineMs;
  const pending = query.sources
    .filter((source) => starting[source] !== "end")
    .map((source) => {
      const standing = starting[source] ?? "start";
      const after = standing === "start" || standing === "end" ? null : standing;
      return scanSource(source, readers[source], after, query, resolve, budget, deadline, clock);
    });
  const outcomes = await Promise.all(pending);

  const fromStart: Standings = {};
  for (const source of query.sources) fromStart[source] = starting[source] ?? "start";
  const { rows, standings } = merge(
    outcomes.map((outcome) => outcome.scan),
    fromStart,
    query.limit,
  );

  return {
    rows,
    sources: outcomes.map((outcome) => outcome.status),
    cursor: finished(standings, query.sources) ? null : encodeCursor(print, standings),
    scanned: outcomes.reduce((sum, outcome) => sum + outcome.scanned, 0),
  };
}
