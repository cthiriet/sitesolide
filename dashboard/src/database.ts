/**
 * The service's database: a session, a failure counter, and nothing else.
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
import { tokenHash, generateToken, isRotationDetected, type Session } from "./sessions";

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
  `CREATE TABLE IF NOT EXISTS sessions (
     empreinte TEXT PRIMARY KEY,
     cree_a    INTEGER NOT NULL,
     vue_a     INTEGER NOT NULL
   )`,

  // A single row, for ever. The rate limiting is global and not per address:
  // see src/auth.ts.
  `CREATE TABLE IF NOT EXISTS essais (
     id     INTEGER PRIMARY KEY CHECK (id = 1),
     echecs INTEGER NOT NULL,
     dernier_a INTEGER NOT NULL
   )`,

  // What the service remembers from one startup to the next. A single key
  // lives there today, the hash of the password in force, and it is the one
  // that makes the sessions fall the day it changes.
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
  sessionByHash: base.query<{ hash: string; createdAt: number; seenAt: number }, [string]>(
    "SELECT empreinte AS hash, cree_a AS createdAt, vue_a AS seenAt FROM sessions WHERE empreinte = ?",
  ),
  createSession: base.query<undefined, [string, number, number]>(
    "INSERT INTO sessions (empreinte, cree_a, vue_a) VALUES (?, ?, ?)",
  ),
  touchSession: base.query<undefined, [number, string]>(
    "UPDATE sessions SET vue_a = ? WHERE empreinte = ?",
  ),
  deleteSession: base.query<undefined, [string]>("DELETE FROM sessions WHERE empreinte = ?"),
  purgeSessions: base.query<undefined, [number]>("DELETE FROM sessions WHERE cree_a < ?"),
  attempts: base.query<{ failures: number; lastAt: number }, []>(
    "SELECT echecs AS failures, dernier_a AS lastAt FROM essais WHERE id = 1",
  ),
  setting: base.query<{ value: string }, [string]>(
    "SELECT valeur AS value FROM reglages WHERE cle = ?",
  ),
  setSetting: base.query<undefined, [string, string]>(
    `INSERT INTO reglages (cle, valeur) VALUES (?, ?)
       ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`,
  ),
  clearSessions: base.query<undefined, []>("DELETE FROM sessions"),

  setAttempts: base.query<undefined, [number, number]>(
    `INSERT INTO essais (id, echecs, dernier_a) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET echecs = excluded.echecs, dernier_a = excluded.dernier_a`,
  ),
};

export async function openSession(now: number): Promise<string> {
  const token = generateToken();
  queries.createSession.run(await tokenHash(token), now, now);
  return token;
}

export async function readSession(token: string): Promise<Session | null> {
  const row = queries.sessionByHash.get(await tokenHash(token));
  if (row === null) return null;
  return { hash: row.hash, createdAt: row.createdAt, seenAt: row.seenAt };
}

export function touchSession(hash: string, now: number): void {
  queries.touchSession.run(now, hash);
}

export function closeSession(hash: string): void {
  queries.deleteSession.run(hash);
}

/** Called at every sign-in, not on a timer. */
export function purgeSessions(before: number): void {
  queries.purgeSessions.run(before);
}

export function readAttempts(): { failures: number; lastAt: number } {
  const row = queries.attempts.get();
  return row === null ? { failures: 0, lastAt: 0 } : { failures: row.failures, lastAt: row.lastAt };
}

export function setAttempts(failures: number, lastAt: number): void {
  queries.setAttempts.run(failures, lastAt);
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
    closed = base.query<{ n: number }, []>("SELECT count(*) AS n FROM sessions").get()?.n ?? 0;
    queries.clearSessions.run();
  }

  queries.setSetting.run(PASSWORD_HASH_KEY, current);
  return closed;
}
