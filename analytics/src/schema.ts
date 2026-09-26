/**
 * The schema. Timestamps in Epoch milliseconds, `STRICT` everywhere: without
 * it, SQLite writes "tomorrow" into an INTEGER column and reads it back as is.
 *
 * **Nothing here designates a person.** A row carries a visitor's fingerprint,
 * drawn from a salt that `src/fingerprint.ts` destroys after two days; neither
 * the IP address nor the user agent that produced it are written, and once the
 * salt is gone, the fingerprint attaches to nothing any more. That is what
 * exempts measured sites from a consent banner, and it is therefore a property
 * of the schema as much as of the code: a column added here that carried the
 * IP, the raw agent or a lasting identifier would bring it down.
 */

/** The three device families, as the dashboard counts them. */
/** The values are those stored in the `appareil` column: renaming them
 * would call for a migration of the database in service. */
export const DEVICES = ["mobile", "tablette", "bureau"] as const;

export type Device = (typeof DEVICES)[number];

/** The source of a visit that came from no link. */
export const DIRECT = "direct";

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

/** Maximum lengths, applied by `src/pageview.ts` before the insert. */
export const HOST_MAX = 253;
export const PATH_MAX = 512;
export const SOURCE_MAX = 128;
/** `fr`, `pt-BR`: the primary code and its variant, never more. */
export const LANGUAGE_MAX = 8;
export const CAMPAIGN_MAX = 128;
export const SITE_MAX = 64;

export const SCHEMA = [
  /**
   * The salts, one per day of the time zone.
   *
   * They are not a datum of the measurement: they are the keys that make the
   * fingerprints incomputable, and their destruction is what makes the
   * measurement anonymous. `src/db.ts` erases them beyond `SALTS_KEPT` days,
   * and that erasure is the only thing that distinguishes this service from a
   * register of IP addresses in disguise.
   */
  `CREATE TABLE IF NOT EXISTS sels (
     jour   TEXT PRIMARY KEY,
     valeur TEXT NOT NULL
   ) STRICT`,

  /**
   * One row per page view.
   *
   * No aggregate table alongside: a showcase site counts its visits in
   * thousands per month, and SQLite groups a million rows faster than it would
   * take code to keep correct counters. The day a site changed order of
   * magnitude, this is where a monthly table would be placed, not in the
   * service.
   */
  `CREATE TABLE IF NOT EXISTS vues (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,

     -- The service's clock. The browser's cannot stand in for it: a badly set
     -- machine would move its visits by several days.
     vu_a      INTEGER NOT NULL,

     -- The site, copied from sites at write time rather than joined at read
     -- time: a host removed from the allow list must not make the visits it has
     -- already served disappear from the dashboard.
     site      TEXT    NOT NULL CHECK (length(site) BETWEEN 1 AND ${SITE_MAX}),
     hote      TEXT    NOT NULL CHECK (length(hote) BETWEEN 1 AND ${HOST_MAX}),

     -- The day of the time zone, as 'AAAA-MM-JJ'. Written rather than computed
     -- at read time: SQLite's date functions know time zones only as UTC, and a
     -- GROUP BY on an expression would use no index. It compares and sorts like
     -- a string.
     jour      TEXT    NOT NULL CHECK (length(jour) = 10),

     chemin    TEXT    NOT NULL CHECK (length(chemin) BETWEEN 1 AND ${PATH_MAX}),

     -- The visitor's fingerprint for this day and this site. See the header.
     visiteur  TEXT    NOT NULL,

     -- The identifier the browser drew for this page view, and that it sends
     -- back with the time spent. It only lives as long as the page: two views
     -- of the same page carry two different ones, and it links nothing.
     jeton     TEXT    NOT NULL,

     -- First page view of this visitor in their visit, hence one visit more.
     -- Computed at write time: deducing it at read time would take a
     -- min(id) GROUP BY visiteur over the whole window read, on every display.
     entree    INTEGER NOT NULL CHECK (entree IN (0, 1)),

     -- Where the visit comes from: a known name ('Google'), the host of the
     -- link, or 'direct'. Set on every page view, but counted on entries only:
     -- the source of a visit is that of its first step.
     source    TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND ${SOURCE_MAX}),

     -- utm_campaign, when the URL carried one.
     campagne  TEXT    CHECK (campagne IS NULL OR length(campagne) <= ${CAMPAIGN_MAX}),

     -- The browser language, reduced to its primary code. It is the only clue
     -- of geographic origin this service keeps: it asks for no geolocation
     -- database, and a language code designates nobody, where a city and an
     -- internet provider start to do so.
     langue    TEXT    CHECK (langue IS NULL OR length(langue) <= ${LANGUAGE_MAX}),

     appareil  TEXT    NOT NULL CHECK (appareil IN (${quoted(DEVICES)})),
     navigateur TEXT   NOT NULL,
     systeme   TEXT    NOT NULL,

     -- Seconds spent on the page, filled in by a second signal on departure.
     -- Zero as long as it has not come, and it does not always come: a browser
     -- killed outright sends nothing. Averages therefore count only the non
     -- zero page views, otherwise they would always say less than the truth.
     duree_s   INTEGER NOT NULL DEFAULT 0 CHECK (duree_s >= 0)
   ) STRICT`,

  // Everything the dashboard asks for starts with "this site, between these two
  // days": it is the index that carries every page of the dashboard.
  `CREATE INDEX IF NOT EXISTS vues_site ON vues (site, jour)`,

  // Two questions want it: "has this visitor already been seen today", asked on
  // every write to fill in `entree`, and the bounce rate, which counts the
  // visitors who saw a single page.
  `CREATE INDEX IF NOT EXISTS vues_visiteur ON vues (visiteur, jour)`,

  // The time spent arrives after the page view, and finds it again only there.
  `CREATE INDEX IF NOT EXISTS vues_jeton ON vues (jeton)`,

  // There is **no** index on `vu_a`, and the purge does without one: `id` grows
  // with time, so the oldest rows are the first ones in rowid order, and a scan
  // looking for `vu_a < limit LIMIT n` finds them all at the start. One more
  // index would be paid for on every page view written.
] as const;
