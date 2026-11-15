/**
 * The service's database: the sessions, a few settings, and nothing else.
 *
 * What the machine carries is not here and never will be: that state lives in
 * the snapshot the collector rewrites every minute, and confusing it with kept
 * data would make the dashboard display a past that it would present as a
 * present.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DATA_DIR } from "./config";
import { tokenHash, generateToken, isRotationDetected, OWNER_IDENTITY, type Session } from "./sessions";

/**
 * Connection settings, applied in this order. A PRAGMA does not survive the
 * connection that set it: they are therefore set again at every opening.
 *
 * `busy_timeout` first, on purpose: the connection must already know how to
 * wait for a lock before the log mode changes.
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
  // `identity`: `owner`. A person's email in a row from when people signed
  // in with a company account: read as no session, purged at the next sign-in.
  `CREATE TABLE IF NOT EXISTS sessions (
     empreinte TEXT PRIMARY KEY,
     cree_a    INTEGER NOT NULL,
     vue_a     INTEGER NOT NULL,
     identity  TEXT NOT NULL DEFAULT 'owner'
   )`,

  // A single row, read by nothing since the sign-in counts its failures per
  // client, in memory (src/auth.ts): kept so that a database is never
  // altered on the way. An empty table costs nothing.
  `CREATE TABLE IF NOT EXISTS essais (
     id     INTEGER PRIMARY KEY CHECK (id = 1),
     echecs INTEGER NOT NULL,
     dernier_a INTEGER NOT NULL
   )`,

  // What the service remembers from one startup to the next: the hash of the
  // password in force, which makes the sessions fall the day it changes, and
  // whether the owner was last seen holding a passkey.
  `CREATE TABLE IF NOT EXISTS reglages (
     cle    TEXT PRIMARY KEY,
     valeur TEXT NOT NULL
   )`,
] as const;

/** The key under which the hash of the password in force is kept. */
export const PASSWORD_HASH_KEY = "empreinte_mot_de_passe";

/**
 * `strict` throws on a missing parameter instead of silently binding it to
 * NULL and writing an incomplete row.
 */
export function openDatabase(path: string): Database {
  const base = new Database(path, { create: true, strict: true });
  for (const pragma of PRAGMAS) base.run(`PRAGMA ${pragma}`);
  for (const table of SCHEMA) base.run(table);
  return base;
}

// DATA_DIR is frozen at first import; tests/setup.ts diverts it beforehand.
mkdirSync(DATA_DIR, { recursive: true });

const base = openDatabase(join(DATA_DIR, "dashboard.db"));

/** Prepared once: `db.query` keeps them in cache, `db.prepare` does not. */
const queries = {
  sessionByHash: base.query<{ hash: string; createdAt: number; seenAt: number; identity: string }, [string]>(
    "SELECT empreinte AS hash, cree_a AS createdAt, vue_a AS seenAt, identity FROM sessions WHERE empreinte = ?",
  ),
  createSession: base.query<undefined, [string, number, number, string]>(
    "INSERT INTO sessions (empreinte, cree_a, vue_a, identity) VALUES (?, ?, ?, ?)",
  ),
  touchSession: base.query<undefined, [number, string]>(
    "UPDATE sessions SET vue_a = ? WHERE empreinte = ?",
  ),
  deleteSession: base.query<undefined, [string]>("DELETE FROM sessions WHERE empreinte = ?"),
  purgeSessions: base.query<undefined, [number]>("DELETE FROM sessions WHERE identity <> 'owner' OR cree_a < ?"),
  setting: base.query<{ value: string }, [string]>(
    "SELECT valeur AS value FROM reglages WHERE cle = ?",
  ),
  setSetting: base.query<undefined, [string, string]>(
    `INSERT INTO reglages (cle, valeur) VALUES (?, ?)
       ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`,
  ),
  clearSessions: base.query<undefined, []>("DELETE FROM sessions WHERE identity = 'owner'"),
  countOwnerSessions: base.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions WHERE identity = 'owner'"),
  closeOtherOwnerSessions: base.query<undefined, [string]>("DELETE FROM sessions WHERE identity = 'owner' AND empreinte <> ?"),
};

/** The owner's session, its token drawn here. */
export async function openSession(now: number): Promise<string> {
  const token = generateToken();
  queries.createSession.run(await tokenHash(token), now, now, OWNER_IDENTITY);
  return token;
}

export async function readSession(token: string): Promise<Session | null> {
  const row = queries.sessionByHash.get(await tokenHash(token));
  if (row === null) return null;
  return { hash: row.hash, createdAt: row.createdAt, seenAt: row.seenAt, identity: row.identity };
}

export function touchSession(hash: string, now: number): void {
  queries.touchSession.run(now, hash);
}

export function closeSession(hash: string): void {
  queries.deleteSession.run(hash);
}

/** Called at every sign-in, not on a timer: the sessions opened before `before`, and any row not the owner's. */
export function purgeSessions(before: number): void {
  queries.purgeSessions.run(before);
}

/** Every session of the owner's but this one: a passkey removed signs out whoever else held it. */
export function closeOtherOwnerSessions(keptHash: string): void {
  queries.closeOtherOwnerSessions.run(keptHash);
}

/**
 * Whether the owner was last seen holding a passkey, kept for when the
 * steward does not answer: the password stays refused rather than coming
 * back the moment the steward is down.
 */
export const OWNER_PASSKEYS_KEY = "owner_passkeys";

export function readOwnerPasskeys(): boolean | null {
  const value = queries.setting.get(OWNER_PASSKEYS_KEY)?.value ?? null;
  return value === null ? null : value === "1";
}

export function writeOwnerPasskeys(registered: boolean): void {
  queries.setSetting.run(OWNER_PASSKEYS_KEY, registered ? "1" : "0");
}

/* --- password rotation ---------------------------------------------------- */

/**
 * Closes every session if the password has changed since the last startup, and
 * retains the new one. Called once, at startup.
 *
 * The database keeps only a hash of the hash: the argon2id digest already comes
 * from the environment, and putting a copy of it here would make it a second
 * instance to protect without bringing anything.
 *
 * Returns the number of sessions closed, so that the log says it: a silent
 * rotation would look like an unexplained sign-out.
 */
export async function applyRotation(passwordHash: string): Promise<number> {
  if (passwordHash === "") return 0;

  const current = await tokenHash(passwordHash);
  const known = queries.setting.get(PASSWORD_HASH_KEY)?.value ?? null;

  let closed = 0;
  if (isRotationDetected(known, current)) {
    closed = queries.countOwnerSessions.get()?.n ?? 0;
    queries.clearSessions.run();
  }

  queries.setSetting.run(PASSWORD_HASH_KEY, current);
  return closed;
}
