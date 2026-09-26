/**
 * The portal's database: the guest accesses, and nothing else.
 *
 * The owner does not appear in it: their cookie is enough on its own, and
 * their password lives in the vault. A lost database therefore only closes the
 * guests out, never the owner.
 *
 * No effect at import: `server.ts` opens the database, the tests open one of
 * their own.
 */
import { Database } from "bun:sqlite";
import type { Guest } from "./guests";

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

export type GuestStore = {
  byId: (id: string) => Guest | null;
  byHash: (hash: string) => Guest | null;
  /** Most recent first. The hash never leaves this place. */
  list: () => Guest[];
  create: (guest: Guest, hash: string) => void;
  touch: (id: string, now: number) => void;
  /** True if the access existed. */
  remove: (id: string) => boolean;
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
    create: db.query<undefined, [string, string, string, string, number, number | null]>(
      "INSERT INTO invites (id, hote, libelle, empreinte, cree_a, expire_a) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    touch: db.query<undefined, [number, string]>("UPDATE invites SET vu_a = ? WHERE id = ?"),
    remove: db.query<undefined, [string]>("DELETE FROM invites WHERE id = ?"),
  };

  return {
    byId: (id) => toGuest(queries.byId.get(id)),
    byHash: (hash) => toGuest(queries.byHash.get(hash)),
    list: () => queries.list.all().map((row) => toGuest(row)!),
    create(guest, hash) {
      queries.create.run(guest.id, guest.host, guest.label, hash, guest.createdAt, guest.expiresAt);
    },
    touch(id, now) {
      queries.touch.run(now, id);
    },
    remove: (id) => queries.remove.run(id).changes > 0,
  };
}
