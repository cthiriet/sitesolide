/**
 * Access to the database. Everything that touches SQLite is here, and nothing
 * else touches it.
 *
 * **A visit is one visitor for one day**, and that is the service's only
 * definition. No thirty-minute window, no session to reopen: the salt that
 * produces the fingerprint changes every day, so a visit cannot straddle
 * midnight, and wanting to slice it more finely would produce numbers no query
 * could put back together. The `entree` column carries that definition, placed
 * at write time, and every total in the dashboard follows from it.
 *
 * **Queries are prepared once, at import time**, and kept in constants.
 * `db.prepare` and not `db.query`: the cache behind `db.query` keeps only
 * twenty queries, and this module holds more than twice that between the
 * write, the seven rankings and the dashboard's totals. An eviction would cost
 * a recompilation on every display.
 */
import type { Statement } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase } from "./database";
import { DATA_DIR } from "./config";
import { SCHEMA } from "./schema";

/** `DATA_DIR` is frozen at first import: tests/setup.ts diverts it before. */
export const db = openDatabase(join(DATA_DIR, "analytics.db"));

for (const statement of SCHEMA) {
  db.run(statement);
}

/* --- the salts ------------------------------------------------------------- */

const readSalt = db.prepare<{ valeur: string }, [string]>(
  "SELECT valeur FROM sels WHERE jour = ?",
);

const insertSalt = db.prepare<undefined, [string, string]>(
  // `DO NOTHING` rather than a replacement: two page views arriving in the same
  // millisecond each draw a salt, and the second must adopt the first one.
  // Replacing it would cut the day into two sets of fingerprints, and would
  // double the visit count for that day.
  "INSERT INTO sels (jour, valeur) VALUES (?, ?) ON CONFLICT (jour) DO NOTHING",
);

/**
 * The salt of a day, drawn on that day's first page view.
 *
 * `generate` is passed rather than imported: the tests must be able to place a
 * known salt, without which no fingerprint would be verifiable.
 */
export function saltOfDay(day: string, generate: () => string): string {
  const existing = readSalt.get(day);
  if (existing !== null) return existing.valeur;

  insertSalt.run(day, generate());
  // Read back rather than returned: if another write won the race, it is its
  // salt that counts, and that is the one to use.
  return readSalt.get(day)?.valeur ?? "";
}

const expiredSalts = db.prepare<undefined, [string]>("DELETE FROM sels WHERE jour < ?");

/**
 * Destroys the salts older than this day.
 *
 * **This is the operation that makes the measurement anonymous.** While a salt
 * exists, whoever holds the database can recompute the fingerprint of a given
 * IP address and check that it visited a site that day. Once destroyed, all
 * that remains are fingerprints that attach to nothing any more.
 */
export function purgeSalts(before: string): number {
  return expiredSalts.run(before).changes;
}

/* --- writing a page view --------------------------------------------------- */

export type ViewToWrite = {
  viewedAt: number;
  site: string;
  host: string;
  day: string;
  path: string;
  visitor: string;
  token: string;
  source: string;
  campaign: string | null;
  language: string | null;
  device: string;
  browser: string;
  system: string;
};

const alreadySeen = db.prepare<{ one: number }, [string, string]>(
  "SELECT 1 AS one FROM vues WHERE visiteur = ? AND jour = ? LIMIT 1",
);

const insertView = db.prepare<
  undefined,
  [
    number, string, string, string, string, string, string, number,
    string, string | null, string | null, string, string, string,
  ]
>(
  `INSERT INTO vues
     (vu_a, site, hote, jour, chemin, visiteur, jeton, entree,
      source, campagne, langue, appareil, navigateur, systeme)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

/**
 * Writes a page view, and says whether it opened a visit.
 *
 * Both queries sit inside an `IMMEDIATE` transaction: between the question "has
 * this visitor already been seen today" and the insert that depends on it,
 * another page view from the same visitor would slip through, and both would
 * believe themselves the first. `BEGIN` alone is deferred and would take the
 * lock only at the insert, leaving the read outside the transaction.
 */
const writeView = db.transaction((view: ViewToWrite): boolean => {
  const isEntry = alreadySeen.get(view.visitor, view.day) === null;
  insertView.run(
    view.viewedAt,
    view.site,
    view.host,
    view.day,
    view.path,
    view.visitor,
    view.token,
    isEntry ? 1 : 0,
    view.source,
    view.campaign,
    view.language,
    view.device,
    view.browser,
    view.system,
  );
  return isEntry;
});

export function recordView(view: ViewToWrite): { isEntry: boolean } {
  return { isEntry: writeView.immediate(view) };
}

const setDuration = db.prepare<undefined, [number, string, number]>(
  // `max` and not an assignment: several departure signals can arrive for the
  // same page view, a tab being able to be hidden then resumed, and it is the
  // longest one that says the time spent. `duree_s = 0` is not a condition: a
  // resumption must be able to lengthen a duration already placed.
  "UPDATE vues SET duree_s = max(duree_s, ?) WHERE jeton = ? AND vu_a >= ?",
);

/**
 * Attaches a reading time to a page view.
 *
 * The bound on `vu_a` is not an optimisation: the token comes from the browser,
 * and without it a token replayed months later would modify an old page view.
 * It limits the write to recent page views, the only ones a still-open tab
 * could have produced.
 */
export function attachDuration(token: string, seconds: number, from: number): boolean {
  return setDuration.run(seconds, token, from).changes > 0;
}

/* --- what the dashboard asks for ------------------------------------------- */

export type Totals = {
  views: number;
  visits: number;
  /** Visits that saw a single page only. */
  bounces: number;
  /** Page views whose reading time is known, and their sum in seconds. */
  timedViews: number;
  seconds: number;
};

const totalsQuery = db.prepare<
  {
    views: number;
    visits: number;
    timed_views: number;
    seconds: number;
  },
  [string, string, string]
>(
  `SELECT count(*)                      AS views,
          coalesce(sum(entree), 0)      AS visits,
          coalesce(sum(duree_s > 0), 0) AS timed_views,
          coalesce(sum(duree_s), 0)     AS seconds
     FROM vues
    WHERE site = ? AND jour >= ? AND jour <= ?`,
);

const bouncesQuery = db.prepare<{ bounces: number }, [string, string, string]>(
  // A visit that saw a single page. The group is the visitor-day pair, the very
  // one that `entree` counts: the two numbers therefore speak of the same
  // visits, and their ratio is a rate.
  `SELECT count(*) AS bounces FROM (
     SELECT visiteur, jour FROM vues
      WHERE site = ? AND jour >= ? AND jour <= ?
      GROUP BY visiteur, jour
     HAVING count(*) = 1
   )`,
);

export function totalsOf(site: string, from: string, to: string): Totals {
  const t = totalsQuery.get(site, from, to);
  return {
    views: t?.views ?? 0,
    visits: t?.visits ?? 0,
    bounces: bouncesQuery.get(site, from, to)?.bounces ?? 0,
    timedViews: t?.timed_views ?? 0,
    seconds: t?.seconds ?? 0,
  };
}

export type DayCount = { day: string; views: number; visits: number };

const perDay = db.prepare<DayCount, [string, string, string]>(
  `SELECT jour AS day, count(*) AS views, coalesce(sum(entree), 0) AS visits
     FROM vues
    WHERE site = ? AND jour >= ? AND jour <= ?
    GROUP BY jour
    ORDER BY jour`,
);

/**
 * The days that carry at least one page view.
 *
 * Empty days are missing, and it is up to the caller to fill them in: the
 * database has no row to say anything about them, and a curve that skipped them
 * would lie about its slope. `src/snapshot.ts` restores them with `dayWindow`.
 */
export function daysOf(site: string, from: string, to: string): DayCount[] {
  return perDay.all(site, from, to);
}

/** The columns the dashboard can rank, and the way to count them. */
export const RANKINGS = {
  /** Pages, counted in page views: a page seen twice in a visit was seen twice. */
  chemin: "views",
  /** The hosts served, counted in page views as well. */
  hote: "views",
  /** The referrer, counted in visits: it only holds for the first step. */
  source: "entries",
  campagne: "entries",
  /** The browser language, counted in visits like the hardware. */
  langue: "visits",
  /** The landing page, hence an entry. */
  entree: "entries",
  appareil: "visits",
  navigateur: "visits",
  systeme: "visits",
} as const;

export type Ranking = keyof typeof RANKINGS;

export type Row = { value: string; total: number };

/**
 * One query per ranking, prepared at import time.
 *
 * The column name is interpolated, which is not an injection: it comes from the
 * keys of `RANKINGS`, written just above, and the `Ranking` type forbids
 * passing any other. A name coming from an HTTP request cannot arrive here
 * without having gone through that type.
 */
const rankings: Record<Ranking, Statement<Row>> = Object.fromEntries(
  Object.entries(RANKINGS).map(([column, counted]) => {
    // `entree` is not a grouping column: the ranking of landing pages groups
    // the paths of entry page views only.
    const group = column === "entree" ? "chemin" : column;
    const filter = counted === "entries" || column === "entree" ? " AND entree = 1" : "";
    const total = counted === "visits" ? "count(DISTINCT visiteur || jour)" : "count(*)";

    return [
      column,
      db.prepare<Row, [string, string, string, number]>(
        `SELECT ${group} AS value, ${total} AS total
           FROM vues
          WHERE site = ? AND jour >= ? AND jour <= ?${filter}
            AND ${group} IS NOT NULL
          GROUP BY value
          ORDER BY total DESC, value
          LIMIT ?`,
      ),
    ];
  }),
) as Record<Ranking, Statement<Row>>;

export function rank(
  what: Ranking,
  site: string,
  from: string,
  to: string,
  limit: number,
): Row[] {
  return rankings[what].all(site, from, to, limit);
}

/* --- the purge ------------------------------------------------------------- */

/**
 * Size of a deletion batch. A `DELETE` of several million rows holds the write
 * lock for as long as it lasts and grows the WAL journal by everything it
 * erases; cutting it up bounds both.
 */
export const PURGE_BATCH = 50_000;

const deleteBeforeDate = db.prepare<undefined, [number, number]>(
  // No index on `vu_a`, and none is needed: `id` grows with time, so the rows
  // being looked for are the first ones in rowid order and the scan finds them
  // straight away. See the end of src/schema.ts.
  `DELETE FROM vues
     WHERE id IN (SELECT id FROM vues WHERE vu_a < ? LIMIT ?)`,
);

const deleteBeforeId = db.prepare<undefined, [number, number]>(
  "DELETE FROM vues WHERE id IN (SELECT id FROM vues WHERE id <= ? LIMIT ?)",
);

const countThreshold = db.prepare<{ id: number }, [number]>(
  // `OFFSET n` on a descending scan skips the n most recent ones: the first row
  // returned is therefore the most recent of those to erase.
  "SELECT id FROM vues ORDER BY id DESC LIMIT 1 OFFSET ?",
);

export type Purge = { byAge: number; byCount: number; salts: number };

/**
 * Hands control back to the server, long enough for it to serve what is
 * waiting.
 *
 * Bun has a single thread: a loop of synchronous `DELETE`s holds the scheduler
 * from start to finish, and the page views waiting would only be written once
 * the last batch had gone through. `setTimeout` and not `queueMicrotask`, which
 * runs before the scheduler picks input and output back up.
 */
const yieldToServer = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Erases what is too old, what is in excess, then the expired salts.
 *
 * The three do not protect the same thing. Retention by age protects
 * relevance, the ceiling by count protects the disk shared with the other
 * sites, and the destruction of the salts protects the visitors.
 */
export async function purge(
  now: number,
  retentionMs: number,
  maximum: number,
  saltsBefore: string,
  batch = PURGE_BATCH,
): Promise<Purge> {
  let byAge = 0;
  const limit = now - retentionMs;
  for (;;) {
    const { changes } = deleteBeforeDate.run(limit, batch);
    byAge += changes;
    if (changes < batch) break;
    await yieldToServer();
  }

  let byCount = 0;
  for (;;) {
    const threshold = countThreshold.get(maximum);
    if (threshold === null) break;
    const { changes } = deleteBeforeId.run(threshold.id, batch);
    byCount += changes;
    if (changes === 0) break;
    await yieldToServer();
  }

  const salts = purgeSalts(saltsBefore);

  if (byAge + byCount > 0) {
    // Without a checkpoint, the journal keeps the trace of everything just
    // erased: the -wal file would stay large while the database has shrunk.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    db.run("PRAGMA optimize");
  }

  return { byAge, byCount, salts };
}

/* --- the state ------------------------------------------------------------- */

export type State = {
  views: number;
  oldest: number | null;
  newest: number | null;
  salts: number;
  /** Size of the database file, in bytes, as SQLite sees it. */
  bytes: number;
};

const counted = db.prepare<
  { total: number; oldest: number | null; newest: number | null },
  []
>("SELECT count(*) AS total, min(vu_a) AS oldest, max(vu_a) AS newest FROM vues");

const saltCountQuery = db.prepare<{ total: number }, []>("SELECT count(*) AS total FROM sels");

const sizeQuery = db.prepare<{ bytes: number }, []>(
  "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
);

export function state(): State {
  const row = counted.get();
  return {
    views: row?.total ?? 0,
    oldest: row?.oldest ?? null,
    newest: row?.newest ?? null,
    salts: saltCountQuery.get()?.total ?? 0,
    bytes: sizeQuery.get()?.bytes ?? 0,
  };
}
