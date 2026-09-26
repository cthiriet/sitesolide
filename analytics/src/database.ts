import { Database } from "bun:sqlite";

/**
 * Connection settings applied to every database of this site, in this order.
 *
 * `busy_timeout` comes first on purpose: the connection must already know how
 * to wait for a lock before WAL is set, otherwise another connection switching
 * the mode at the same instant makes ours fail on the spot.
 */
export const PRAGMAS = [
  // A concurrent write makes us wait up to ten seconds instead of returning
  // SQLITE_BUSY to the visitor.
  "busy_timeout = 10000",

  // Reads no longer block writes, and the database survives an abrupt stop of
  // the service.
  "journal_mode = WAL",

  // A 64 MB ceiling for the -wal file, truncated back after each checkpoint.
  // Without it, a long read that pushes the checkpoint back leaves a journal
  // that never comes down again.
  "journal_size_limit = 67108864",

  // In WAL, NORMAL is enough: a crash of the service or of the kernel corrupts
  // nothing. Only a power cut can lose the very last transactions, that is a
  // few visits here, which an audience measurement can afford where accounting
  // could not. In exchange each write spares itself an fsync, and this service
  // writes on every page view of every site on the machine.
  "synchronous = NORMAL",

  // SQLite disables them on every new connection: without this line, a foreign
  // key declared in a schema would never be checked.
  "foreign_keys = ON",

  // The planner's temporary tables and indexes in memory rather than on disk,
  // which sorts such as `ORDER BY id DESC` benefit from.
  "temp_store = MEMORY",

  // A 16 MB cache ceiling (a negative value means kibibytes), against 2 MB by
  // default. It is a ceiling, not a reservation: these databases weigh a few
  // megabytes, so they fit entirely in memory after the first reads, and
  // several sites can live together on the same machine.
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
