/**
 * The backup component's own database: what it did, what the bucket holds,
 * and the settings the last run applied.
 *
 * - `audit`, the shared shape every component records its acts in: each run
 *   (`backup.run`, actor `system`) and each restore (`backup.restore`, actor
 *   the dashboard's session). Never a value, never a key: names, counts and
 *   verdicts.
 * - `snapshots`, what each repository held when it was last listed, the
 *   server's and the bucket's: the steward has neither restic nor the keys,
 *   and no network at all, so this table is how the dashboard learns what
 *   may be restored and from where. It is rewritten whole from restic's own
 *   listing at every run, and after a restore's snapshot; the repository
 *   stays the truth, and a restore resolves its snapshot there, refusing one
 *   the index still listed but restic no longer has.
 * - `imported`, the archives of the format before restic whose copy in the
 *   repository was verified, and when, and when retention forgot that copy:
 *   they are removed seven days later, or once forgotten (legacy.ts).
 * - `doomed`, the snapshots the run wanted forgotten and restic would not
 *   forget then (a person's live lock, for one): left out of every listing,
 *   index and copy, and forgotten at the next run's start.
 * - `settings`, the retention and the bucket's address as the last run read
 *   them from its unit, and the last checks of the repositories, for the
 *   page to say what is kept, where, and whether it was verified.
 *
 * Opened by the run and the restore, which write, and by the steward, which
 * reads: its unit makes this folder writable for it, a WAL reader having to
 * write its `-shm`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { SnapshotKind } from "../../borrowed/backups";

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
  // The bucket's objects of the format before restic, which the run listed;
  // the snapshots table replaces it.
  `DROP TABLE IF EXISTS offsite`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     store TEXT NOT NULL,
     folder TEXT NOT NULL,
     name TEXT NOT NULL,
     id TEXT NOT NULL,
     taken_at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     bytes INTEGER,
     added INTEGER,
     PRIMARY KEY (store, folder, name)
   )`,
  `CREATE TABLE IF NOT EXISTS imported (
     folder TEXT NOT NULL,
     name TEXT NOT NULL,
     source TEXT NOT NULL,
     digest TEXT,
     at INTEGER NOT NULL,
     forgotten INTEGER,
     PRIMARY KEY (folder, name)
   )`,
  `CREATE TABLE IF NOT EXISTS doomed (
     store TEXT NOT NULL,
     id TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (store, id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
] as const;

export const DATABASE_NAME = "backup.db";

/**
 * `strict` throws on a missing parameter instead of binding it to NULL.
 *
 * A reader, the steward or `sitesolide backups`, is opened read-write but
 * `query_only`: SQLite's read-only mode cannot open a WAL database whose `-wal`
 * the last writer removed on closing, which is the normal state between two
 * runs, whereas a read-write connection recreates it. `query_only` then
 * refuses every write on that connection, and the schema is only ever created
 * by a writer: a reader that finds no database creates none.
 */
export function openDatabase(path: string, options: { reader?: boolean } = {}): Database {
  const reader = options.reader === true;
  const base = new Database(path, reader ? { readwrite: true, create: false, strict: true } : { create: true, strict: true });
  for (const pragma of PRAGMAS) base.run(`PRAGMA ${pragma}`);
  if (reader) base.run("PRAGMA query_only = ON");
  else {
    for (const statement of SCHEMA) base.run(statement);
    // The first release with restic made `imported` without the column.
    const columns = base.query<{ name: string }, []>("PRAGMA table_info(imported)").all();
    if (!columns.some((column) => column.name === "forgotten")) base.run("ALTER TABLE imported ADD COLUMN forgotten INTEGER");
  }
  return base;
}

/** A reader's connection, or null when no run has created the database yet. */
export function openForReading(path: string): Database | null {
  return existsSync(path) ? openDatabase(path, { reader: true }) : null;
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
 * `before`, an id: those older than it, for a reader that pages.
 */
export function readAudit(db: Database, folder: string | null, limit: number, before: number | null = null): AuditEntry[] {
  const below = before ?? Number.MAX_SAFE_INTEGER;
  const rows =
    folder === null
      ? db.query<AuditRow, { limit: number; below: number }>("SELECT * FROM audit WHERE id < $below ORDER BY id DESC LIMIT $limit").all({ limit, below })
      : db
          .query<AuditRow, { folder: string; limit: number; below: number }>(
            "SELECT * FROM audit WHERE (target = $folder OR target IS NULL) AND id < $below ORDER BY id DESC LIMIT $limit",
          )
          .all({ folder, limit, below });
  return rows.map((row) => ({ ...row, detail: readDetail(row.detail) }));
}

/** `local`: the server's repository. `offsite`: the bucket's. */
export type Store = "local" | "offsite";

/** One snapshot as the index keeps it: restic's id, and its figures as restic counted them. */
export type IndexedSnapshot = { folder: string; name: string; id: string; takenAt: number; kind: SnapshotKind; bytes: number | null; added: number | null };

type SnapshotRow = { folder: string; name: string; id: string; taken_at: number; kind: string; bytes: number | null; added: number | null };

function fromRow(row: SnapshotRow): IndexedSnapshot | null {
  if (row.kind !== "scheduled" && row.kind !== "pre-restore") return null;
  return { folder: row.folder, name: row.name, id: row.id, takenAt: row.taken_at, kind: row.kind, bytes: row.bytes, added: row.added };
}

/** A repository's contents, every folder at once, as one listing saw them. */
export function replaceSnapshots(db: Database, store: Store, rows: readonly IndexedSnapshot[]): void {
  db.transaction(() => {
    db.query("DELETE FROM snapshots WHERE store = $store").run({ store });
    const insert = db.query(
      "INSERT OR REPLACE INTO snapshots (store, folder, name, id, taken_at, kind, bytes, added) VALUES ($store, $folder, $name, $id, $takenAt, $kind, $bytes, $added)",
    );
    for (const row of rows) insert.run({ store, folder: row.folder, name: row.name, id: row.id, takenAt: row.takenAt, kind: row.kind, bytes: row.bytes, added: row.added });
  })();
}

/** One snapshot added, a restore's own, without listing the repository again. */
export function addSnapshot(db: Database, store: Store, row: IndexedSnapshot): void {
  db.query(
    "INSERT OR REPLACE INTO snapshots (store, folder, name, id, taken_at, kind, bytes, added) VALUES ($store, $folder, $name, $id, $takenAt, $kind, $bytes, $added)",
  ).run({ store, folder: row.folder, name: row.name, id: row.id, takenAt: row.takenAt, kind: row.kind, bytes: row.bytes, added: row.added });
}

/** A folder's snapshots in one repository, newest first. */
export function readSnapshots(db: Database, store: Store, folder: string): IndexedSnapshot[] {
  return db
    .query<SnapshotRow, { store: string; folder: string }>("SELECT folder, name, id, taken_at, kind, bytes, added FROM snapshots WHERE store = $store AND folder = $folder ORDER BY taken_at DESC, name DESC")
    .all({ store, folder })
    .map(fromRow)
    .filter((row): row is IndexedSnapshot => row !== null);
}

/**
 * An archive of the format before restic whose copy was verified: `archive`
 * on the server, `object` in the bucket. `forgotten`, when retention forgot
 * that copy, which lets the archive go at once.
 */
export type Imported = { folder: string; name: string; source: "archive" | "object"; digest: string | null; at: number; forgotten: number | null };

export function recordImport(db: Database, row: Imported): void {
  db.query("INSERT OR REPLACE INTO imported (folder, name, source, digest, at, forgotten) VALUES ($folder, $name, $source, $digest, $at, $forgotten)").run(row);
}

export function readImports(db: Database): Imported[] {
  return db
    .query<Imported, []>("SELECT folder, name, source, digest, at, forgotten FROM imported ORDER BY at, folder, name")
    .all()
    .filter((row) => row.source === "archive" || row.source === "object");
}

/** Retention forgot the copy of this archive: it may go now. */
export function markForgotten(db: Database, folder: string, name: string, at: number): void {
  db.query("UPDATE imported SET forgotten = $at WHERE folder = $folder AND name = $name AND forgotten IS NULL").run({ folder, name, at });
}

/** A setting: a restore whose own snapshot failed once restic had started asks the next run to prune what it left. */
export const PRUNE_WANTED = "prune-wanted";

/** A snapshot restic would not forget when asked: kept out of every listing, forgotten at the next run. */
export function recordDoomed(db: Database, store: Store, id: string, at: number): void {
  db.query("INSERT OR IGNORE INTO doomed (store, id, at) VALUES ($store, $id, $at)").run({ store, id, at });
}

export function readDoomed(db: Database, store: Store): string[] {
  return db
    .query<{ id: string }, { store: string }>("SELECT id FROM doomed WHERE store = $store ORDER BY at")
    .all({ store })
    .map((row) => row.id);
}

export function clearDoomed(db: Database, store: Store, ids: readonly string[]): void {
  const remove = db.query("DELETE FROM doomed WHERE store = $store AND id = $id");
  db.transaction(() => {
    for (const id of ids) remove.run({ store, id });
  })();
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
