import { Database } from "bun:sqlite";

/**
 * Connection settings applied to every database of this component, in this
 * order. The same as every other component's, see CONTRIBUTING.md.
 *
 * `busy_timeout` comes first on purpose: the connection must already know how
 * to wait for a lock before WAL is set, otherwise another connection switching
 * the mode at the same instant makes ours fail on the spot.
 */
export const PRAGMAS = [
  // A concurrent reader makes the flush wait up to ten seconds instead of
  // failing with SQLITE_BUSY.
  "busy_timeout = 10000",

  // Reads no longer block writes, and the database survives an abrupt stop of
  // the service.
  "journal_mode = WAL",

  // A 64 MB ceiling for the -wal file, truncated back after each checkpoint.
  "journal_size_limit = 67108864",

  // In WAL, NORMAL is enough: a crash of the service or of the kernel corrupts
  // nothing. A power cut can lose the last flush, that is one minute of
  // counters, which an audit of refusals and uses can afford.
  "synchronous = NORMAL",

  // SQLite disables them on every new connection.
  "foreign_keys = ON",

  // Sorts such as `ORDER BY id DESC` in memory rather than on disk.
  "temp_store = MEMORY",

  // A 16 MB cache ceiling (a negative value means kibibytes), against 2 MB by
  // default. A ceiling, not a reservation.
  "cache_size = -16000",
] as const;

/**
 * Opens a SQLite database with the repository's settings.
 *
 * `strict` raises an error on a missing query parameter, instead of silently
 * binding it to NULL and writing an incomplete row.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });

  for (const pragma of PRAGMAS) {
    db.run(`PRAGMA ${pragma}`);
  }

  return db;
}
