/**
 * The database the three services share, in the project's data folder.
 *
 * Each service opens its own connection: the page reads, the worker and the
 * scheduled run write. In WAL the page reads while one of them writes, and
 * busy_timeout makes a writer wait for the other rather than fail.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

/**
 * Applied to every connection, in this order: a PRAGMA lasts as long as the
 * connection that set it, never longer. busy_timeout comes first, so that the
 * connection already waits for a lock when another one switches the journal
 * to WAL at the same instant.
 */
const PRAGMAS = [
  "busy_timeout = 10000",
  "journal_mode = WAL",
  "journal_size_limit = 67108864",
  "synchronous = NORMAL",
  "foreign_keys = ON",
  "temp_store = MEMORY",
  "cache_size = -16000",
];

export function openDatabase(): Database {
  // The generated unit sets DATA_DIR, a folder that exists and is the only one
  // the service may write to. On a workstation, ./data stands in for it.
  const folder = process.env.DATA_DIR ?? "./data";
  if (process.env.DATA_DIR === undefined) mkdirSync(folder, { recursive: true });

  // strict: a missing parameter is an error, never a NULL written in its place.
  const db = new Database(`${folder}/background.sqlite`, { create: true, strict: true });
  for (const pragma of PRAGMAS) db.run(`PRAGMA ${pragma}`);

  db.run("CREATE TABLE IF NOT EXISTS worker (id INTEGER PRIMARY KEY CHECK (id = 1), beats INTEGER NOT NULL, last_beat TEXT)");
  db.run("INSERT OR IGNORE INTO worker (id, beats) VALUES (1, 0)");
  db.run("CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, beats INTEGER NOT NULL)");
  return db;
}
