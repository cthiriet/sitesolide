/**
 * The backup component's own database: what it did, what the bucket holds,
 * and the settings the last run applied.
 *
 * - `audit`, the shared shape every component records its acts in: each run
 *   (`backup.run`, actor `system`) and each restore (`backup.restore`, actor
 *   the dashboard's session). Never a value, never a key: names, counts and
 *   verdicts.
 * - `offsite`, the bucket's contents as the last run listed them. The steward
 *   has no network at all: this table is how the dashboard learns which
 *   snapshots also live elsewhere.
 * - `settings`, the retention and the bucket's address as the last run read
 *   them from its unit, for the page to say what is kept and where.
 *
 * The snapshots themselves are not indexed: the folder of archives is the
 * truth, listed every time, and an index would one day say otherwise.
 *
 * Opened by the run and the restore, which write, and by the steward, which
 * reads: its unit makes this folder writable for it, a WAL reader having to
 * write its `-shm`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/** The same settings as every database of this repository, in the same order: see CONTRIBUTING.md. */
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
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS audit_target ON audit (target, id)`,
  `CREATE TABLE IF NOT EXISTS offsite (
     folder TEXT NOT NULL,
     name TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     PRIMARY KEY (folder, name)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
] as const;

export const DATABASE_NAME = "backup.db";

/**
 * `strict` throws on a missing parameter instead of binding it to NULL. The
 * schema is only created by a writer: a reader that finds no database finds
 * nothing, and creates nothing.
 */
export function openDatabase(path: string, options: { readonly?: boolean } = {}): Database {
  const base = new Database(path, options.readonly === true ? { readonly: true, strict: true } : { create: true, strict: true });
  for (const pragma of PRAGMAS) {
    // A read-only connection cannot change the journal mode: the writer set it.
    if (options.readonly === true && pragma.startsWith("journal_mode")) continue;
    base.run(`PRAGMA ${pragma}`);
  }
  if (options.readonly !== true) for (const statement of SCHEMA) base.run(statement);
  return base;
}

/** A reader's connection, or null when no run has created the database yet. */
export function openForReading(path: string): Database | null {
  return existsSync(path) ? openDatabase(path, { readonly: true }) : null;
}

export type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
};

export type AuditRecord = Omit<AuditEntry, "id" | "at">;

export function recordAudit(db: Database, record: AuditRecord, now: number = Date.now()): void {
  db.query("INSERT INTO audit (at, actor, action, target, detail) VALUES ($at, $actor, $action, $target, $detail)").run({
    at: new Date(now).toISOString(),
    actor: record.actor,
    action: record.action,
    target: record.target,
    detail: record.detail === null ? null : JSON.stringify(record.detail),
  });
}

type AuditRow = { id: number; at: string; actor: string; action: string; target: string | null; detail: string | null };

function readDetail(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The latest entries, newest first: those naming this folder, plus the runs,
 * which name none and concern it all the same. Null for the whole machine.
 */
export function readAudit(db: Database, folder: string | null, limit: number): AuditEntry[] {
  const rows =
    folder === null
      ? db.query<AuditRow, { limit: number }>("SELECT * FROM audit ORDER BY id DESC LIMIT $limit").all({ limit })
      : db
          .query<AuditRow, { folder: string; limit: number }>(
            "SELECT * FROM audit WHERE target = $folder OR target IS NULL ORDER BY id DESC LIMIT $limit",
          )
          .all({ folder, limit });
  return rows.map((row) => ({ ...row, detail: readDetail(row.detail) }));
}

export type OffsiteRow = { name: string; bytes: number };

/** The bucket's contents for every folder at once, as one listing saw them. */
export function replaceOffsite(db: Database, rows: { folder: string; name: string; bytes: number }[]): void {
  db.transaction(() => {
    db.run("DELETE FROM offsite");
    const insert = db.query("INSERT OR REPLACE INTO offsite (folder, name, bytes) VALUES ($folder, $name, $bytes)");
    for (const row of rows) insert.run(row);
  })();
}

export function readOffsite(db: Database, folder: string): OffsiteRow[] {
  return db.query<OffsiteRow, { folder: string }>("SELECT name, bytes FROM offsite WHERE folder = $folder ORDER BY name DESC").all({ folder });
}

export function writeSetting(db: Database, key: string, value: unknown): void {
  db.query("INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({
    key,
    value: JSON.stringify(value),
  });
}

export function readSetting(db: Database, key: string): unknown {
  const row = db.query<{ value: string }, { key: string }>("SELECT value FROM settings WHERE key = $key").get({ key });
  if (row === null) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}
