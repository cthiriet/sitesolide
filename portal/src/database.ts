/**
 * The portal's database: the audit of sign-ins, and two tables from before
 * the steward kept who may open a site, `invites` and `sharing`, read-only:
 * a portal that finds no projection from the steward yet decides from them
 * as it did (src/projection.ts), the steward carries them over once into
 * its registry, and a rollback finds them as they were. Nothing writes them
 * any more.
 *
 * The owner does not appear in it: their cookie is enough on its own, and
 * their password lives in the vault. A lost database loses the audit, never
 * who may open a site, which is the steward's.
 *
 * Every table is created if it is missing, at every opening, so that the
 * reads above find one even on a portal that never had them.
 *
 * No effect at import: `server.ts` opens the database, the tests open one of
 * their own.
 */
import { Database } from "bun:sqlite";
import type { Guest } from "./guests";
import { DEFAULT_POLICY, readPolicy, type Policy } from "./sharing";

/**
 * Connection settings, applied in this order. A PRAGMA does not survive the
 * connection that set it: they are therefore set again at every opening.
 *
 * `busy_timeout` first, by design: the connection must already know how to
 * wait for a lock before the journal mode changes.
 */
export const PRAGMAS = [
  "busy_timeout = 10000",
  "journal_mode = WAL",
  "journal_size_limit = 67108864",
  "synchronous = NORMAL",
  "foreign_keys = ON",
  "temp_store = MEMORY",
  "cache_size = -16000",
] as const;

export const SCHEMA = [
  // The hash is unique and indexed: the login finds the access through
  // it, without going over the others.
  `CREATE TABLE IF NOT EXISTS invites (
     id        TEXT PRIMARY KEY,
     hote      TEXT NOT NULL,
     libelle   TEXT NOT NULL,
     empreinte TEXT NOT NULL UNIQUE,
     cree_a    INTEGER NOT NULL,
     expire_a  INTEGER,
     vu_a      INTEGER
   )`,
  // One row per site whose policy was ever set; a site without a row gets
  // DEFAULT_POLICY. The lists are JSON arrays, read whole on every request of
  // an identity: a few hundred addresses at most, see PEOPLE_MAX.
  `CREATE TABLE IF NOT EXISTS sharing (
     host       TEXT PRIMARY KEY,
     mode       TEXT NOT NULL,
     people     TEXT NOT NULL,
     domains    TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // The shape every component of the repository shares, so that one Activity
  // view can read them all side by side.
  `CREATE TABLE IF NOT EXISTS audit (
     id     INTEGER PRIMARY KEY,
     at     TEXT NOT NULL,
     actor  TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS audit_at ON audit (at)",
] as const;

/**
 * `strict` throws on a missing parameter instead of silently binding it to
 * NULL and writing an incomplete row.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  for (const pragma of PRAGMAS) db.run(`PRAGMA ${pragma}`);
  for (const table of SCHEMA) db.run(table);
  return db;
}

/** The password access from before the steward kept it, read-only. */
export type GuestStore = {
  byId: (id: string) => Guest | null;
  byHash: (hash: string) => Guest | null;
  /** Most recent first. The hash never leaves this place. */
  list: () => Guest[];
};

/**
 * One row as SQLite hands it back. The names are those of the columns, which
 * stay as they were written: renaming them would call for a migration of the
 * database in service.
 */
type Row = {
  id: string;
  hote: string;
  libelle: string;
  cree_a: number;
  expire_a: number | null;
  vu_a: number | null;
};

const COLUMNS = "id, hote, libelle, cree_a, expire_a, vu_a";

function toGuest(row: Row | null): Guest | null {
  if (row === null) return null;
  return {
    id: row.id,
    host: row.hote,
    label: row.libelle,
    createdAt: row.cree_a,
    expiresAt: row.expire_a,
    seenAt: row.vu_a,
  };
}

/** The queries are prepared once, by `query` which keeps them in cache. */
export function guestStore(db: Database): GuestStore {
  const queries = {
    byId: db.query<Row, [string]>(`SELECT ${COLUMNS} FROM invites WHERE id = ?`),
    byHash: db.query<Row, [string]>(`SELECT ${COLUMNS} FROM invites WHERE empreinte = ?`),
    list: db.query<Row, []>(`SELECT ${COLUMNS} FROM invites ORDER BY cree_a DESC, id`),
  };

  return {
    byId: (id) => toGuest(queries.byId.get(id)),
    byHash: (hash) => toGuest(queries.byHash.get(hash)),
    list: () => queries.list.all().map((row) => toGuest(row)!),
  };
}

// --- Sharing ---------------------------------------------------------------------

export type SharedSite = { host: string; policy: Policy; updatedAt: number };

/** Each site's sharing from before the steward kept who may open it, read-only. */
export type SharingStore = {
  /** The site's policy, `DEFAULT_POLICY` when none was ever set. */
  get: (host: string) => Policy;
  /** The sites whose policy was set, by host. */
  list: () => SharedSite[];
};

type SharingRow = { host: string; mode: string; people: string; domains: string; updated_at: number };

function parseArray(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A stored row judged again with the rule the admin API applies. A row this
 * version cannot read, written by hand or by a later version, falls back to
 * `DEFAULT_POLICY`: closed to everyone but the admins, never open wider than
 * intended.
 */
function toPolicy(row: SharingRow | null): Policy {
  if (row === null) return DEFAULT_POLICY;
  const reading = readPolicy({ mode: row.mode, people: parseArray(row.people), domains: parseArray(row.domains) });
  return "policy" in reading ? reading.policy : DEFAULT_POLICY;
}

export function sharingStore(db: Database): SharingStore {
  const queries = {
    get: db.query<SharingRow, [string]>("SELECT host, mode, people, domains, updated_at FROM sharing WHERE host = ?"),
    list: db.query<SharingRow, []>("SELECT host, mode, people, domains, updated_at FROM sharing ORDER BY host"),
  };

  return {
    get: (host) => toPolicy(queries.get.get(host)),
    list: () => queries.list.all().map((row) => ({ host: row.host, policy: toPolicy(row), updatedAt: row.updated_at })),
  };
}

// --- Audit -----------------------------------------------------------------------

export type AuditEvent = {
  id: number;
  /** ISO 8601, UTC. */
  at: string;
  /**
   * An email, `owner` for the password holder, `password:<id>` for a
   * password access given under a name, `guest:<id>` in rows written before
   * the registry, or `anonymous` before anyone is known.
   */
  actor: string;
  /** Dotted: `portal.signin`, `portal.signin_failed`, `portal.signout`; `sharing.update`, `guest.create`, `guest.revoke` in older rows. */
  action: string;
  /** The host concerned, or null. */
  target: string | null;
  /** Never a password, a code or a token: what happened, not what opened it. */
  detail: Record<string, unknown> | null;
};

export type NewEvent = Pick<AuditEvent, "actor" | "action"> & Partial<Pick<AuditEvent, "target" | "detail">>;

export type AuditStore = {
  record: (event: NewEvent, now: number) => void;
  /** Most recent first, `limit` at most, older than the event `before` when given. */
  recent: (limit: number, before?: number) => AuditEvent[];
};

/** Beyond this, an event is forgotten: the audit answers "who got in lately", not "since when". */
export const AUDIT_RETENTION_MS = 180 * 24 * 3600 * 1000;

/**
 * And beyond this many rows, the oldest are: the writes that strangers can
 * cause are bounded where they happen, this bounds the file whatever happens.
 * A hundred thousand rows weigh a few tens of megabytes.
 */
export const AUDIT_MAX_ROWS = 100_000;

/**
 * Except the rows of the last thirty days, which the row cap never forgets.
 * Without this floor, anyone holding a cookie could sign in and out in a loop
 * and push every older event out of the cap, a revocation or a sharing change
 * included, the very rows someone would come looking for. When the cap would
 * need them, they are kept, and the file grows past it: what bounds it then is
 * the collapsing below, at most one row a minute per actor, action and site
 * for what a holder of a cookie can repeat.
 */
export const AUDIT_FLOOR_MS = 30 * 24 * 3600 * 1000;

/**
 * Sign-ins and sign-outs repeated by the same actor on the same site within a
 * minute make one row, which says how many in `detail.count`: a guest's
 * password or any valid cookie can be replayed as fast as the network allows,
 * and each replay used to be a row. The row keeps the time of the first.
 * Failed sign-ins are not collapsed: they are bounded where they happen, by
 * the rate limiting and the per-minute bound of src/sso.ts.
 */
export const COLLAPSED_ACTIONS: ReadonlySet<string> = new Set(["portal.signin", "portal.signout"]);
export const COLLAPSE_WINDOW_MS = 60 * 1000;

/** The forgetting runs at most once an hour, on the write that comes after. */
const PRUNE_EVERY_MS = 3600 * 1000;

export const AUDIT_PAGE_MAX = 500;

type AuditRow = { id: number; at: string; actor: string; action: string; target: string | null; detail: string | null };

function toEvent(row: AuditRow): AuditEvent {
  let detail: Record<string, unknown> | null = null;
  if (row.detail !== null) {
    const parsed = parseArray(row.detail);
    detail = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  }
  return { id: row.id, at: row.at, actor: row.actor, action: row.action, target: row.target, detail };
}

export function auditStore(db: Database, maxRows: number = AUDIT_MAX_ROWS): AuditStore {
  const queries = {
    insert: db.query<undefined, [string, string, string, string | null, string | null]>(
      "INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
    ),
    prune: db.query<undefined, [string]>("DELETE FROM audit WHERE at < ?"),
    trim: db.query<undefined, [number, string]>(
      "DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?) AND at < ?",
    ),
    // The `audit_at` index narrows it to the last minute's rows: a handful.
    latest: db.query<{ id: number; detail: string | null }, [string, string, string | null, string]>(
      "SELECT id, detail FROM audit WHERE actor = ? AND action = ? AND target IS ? AND at > ? ORDER BY id DESC LIMIT 1",
    ),
    count: db.query<undefined, [string, number]>("UPDATE audit SET detail = ? WHERE id = ?"),
    recent: db.query<AuditRow, [number, number]>(
      "SELECT id, at, actor, action, target, detail FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?",
    ),
  };
  let prunedAt = 0;

  /**
   * Counts this event on the row of the same actor, action, site and detail
   * written in the last minute, if there is one. JSON in JavaScript rather
   * than SQLite's JSON functions, which a system SQLite may lack.
   */
  function collapse(event: NewEvent, now: number): boolean {
    if (!COLLAPSED_ACTIONS.has(event.action)) return false;
    const since = new Date(now - COLLAPSE_WINDOW_MS).toISOString();
    const row = queries.latest.get(event.actor, event.action, event.target ?? null, since);
    if (row === null) return false;
    const stored = row.detail === null ? {} : parseArray(row.detail);
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false;
    const { count, ...rest } = stored as Record<string, unknown>;
    if (JSON.stringify(rest) !== JSON.stringify(event.detail ?? {})) return false;
    queries.count.run(JSON.stringify({ ...rest, count: (typeof count === "number" ? count : 1) + 1 }), row.id);
    return true;
  }

  return {
    record(event, now) {
      if (now - prunedAt >= PRUNE_EVERY_MS) {
        queries.prune.run(new Date(now - AUDIT_RETENTION_MS).toISOString());
        queries.trim.run(maxRows, new Date(now - AUDIT_FLOOR_MS).toISOString());
        prunedAt = now;
      }
      if (collapse(event, now)) return;
      queries.insert.run(
        new Date(now).toISOString(),
        event.actor,
        event.action,
        event.target ?? null,
        event.detail === undefined || event.detail === null ? null : JSON.stringify(event.detail),
      );
    },
    recent(limit, before = Number.MAX_SAFE_INTEGER) {
      const bounded = Math.max(1, Math.min(AUDIT_PAGE_MAX, Math.floor(limit)));
      return queries.recent.all(before, bounded).map(toEvent);
    },
  };
}
