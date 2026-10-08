/**
 * What the steward reads of the backups, and the one thing it writes there:
 * a restore request. Inputs and outputs only, no rule: the rules are in
 * routes.ts and in the pure modules beside it.
 *
 * Every read is bounded and opens nothing it would follow: the snapshots are
 * the index the run writes in the component's database (the steward has
 * neither restic nor the repositories' keys), the result and the request are
 * `lstat`ed first, the database is opened read-only and closed at once.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_NAME, openForReading, readAudit, readSetting, readSnapshots, type AuditEntry, type IndexedSnapshot } from "./database";
import { checksOf, readMaintenance } from "./maintenance";
import { DATA, FAILED, INCOMING, PREVIOUS, type Present } from "./recovery";
import { MAX_REQUEST_BYTES, MAX_RESULT_BYTES, REQUESTS_NAME, RESULTS_NAME, encodeRequest, readRequest, type RestoreRequest, type ResultFile } from "./request";
import type { RetentionPolicy } from "./retention";
import { STATUS_NAME, readStatus, writeFileAtomically, type Checks, type RunStatus } from "./status";

export type BackupReaderConfig = {
  sitesDir: string;
  stateFolder: string;
  runFolder: string;
  unitsFolder: string;
};

export type Settings = {
  retention: RetentionPolicy | null;
  offsite: { target: string | null; error: string | null };
  /** The last check of each repository. */
  checks: Checks;
  /** What the server's repository takes on the disk, every project together, as the last daily check measured it. */
  repository: { bytes: number; at: string } | null;
};

const NO_SETTINGS: Settings = { retention: null, offsite: { target: null, error: null }, checks: { local: null, offsite: null }, repository: null };

export type BackupReader = {
  /** The restore's template is installed, and the component has a state folder. */
  installed: () => boolean;
  /** A folder's snapshots in the server's repository, and in the bucket's, as the last listing saw them. */
  local: (folder: string) => IndexedSnapshot[];
  status: () => RunStatus | null;
  offsite: (folder: string) => IndexedSnapshot[];
  settings: () => Settings;
  /** Newest first; `before`, an id, for the entries older than it. */
  audit: (folder: string | null, limit: number, before?: number | null) => AuditEntry[];
  result: (folder: string) => ResultFile;
  present: (folder: string) => Present;
  hasData: (folder: string) => boolean;
  /** A request written and not consumed yet, still fresh enough to be acted on. */
  pending: (folder: string, now: number) => RestoreRequest | null;
  writeRequest: (folder: string, request: RestoreRequest) => void;
  removeRequest: (folder: string) => void;
};

/** A plain file read whole, bounded, never through a link; null when missing or not one. */
function readPlain(path: string, max: number): { bytes: Uint8Array | null; info: { uid: number; mode: number; regular: boolean } } | null {
  let before;
  try {
    before = lstatSync(path);
  } catch {
    return null;
  }
  const info = { uid: before.uid, mode: before.mode & 0o7777, regular: before.isFile() && !before.isSymbolicLink() };
  if (!info.regular || before.size > max) return { bytes: null, info };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = fstatSync(fd);
    if (after.ino !== before.ino) return { bytes: null, info };
    const buffer = new Uint8Array(max + 1);
    let read = 0;
    for (;;) {
      const n = readSync(fd, buffer, read, max + 1 - read, null);
      if (n === 0) break;
      read += n;
      if (read > max) return { bytes: null, info };
    }
    return { bytes: buffer.slice(0, read), info };
  } finally {
    closeSync(fd);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isPolicy(value: unknown): value is RetentionPolicy {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["hourly", "daily", "weekly", "preRestore"].every((key) => typeof v[key] === "number" && Number.isInteger(v[key]));
}

export function createBackupReader(config: BackupReaderConfig): BackupReader {
  const database = join(config.stateFolder, DATABASE_NAME);
  const requests = join(config.stateFolder, REQUESTS_NAME);
  const withDatabase = <T>(fallback: T, read: (db: NonNullable<ReturnType<typeof openForReading>>) => T): T => {
    const db = openForReading(database);
    if (db === null) return fallback;
    try {
      return read(db);
    } catch {
      return fallback;
    } finally {
      db.close();
    }
  };

  return {
    installed: () => exists(join(config.unitsFolder, "sitesolide-restore@.service")) && exists(config.stateFolder),
    local: (folder) => withDatabase([], (db) => readSnapshots(db, "local", folder)),
    status: () => {
      const file = readPlain(join(config.stateFolder, STATUS_NAME), 4 * 1024 * 1024);
      return file === null || file.bytes === null ? null : readStatus(new TextDecoder().decode(file.bytes));
    },
    offsite: (folder) => withDatabase([], (db) => readSnapshots(db, "offsite", folder)),
    settings: () =>
      withDatabase<Settings>(NO_SETTINGS, (db) => {
        const retention = readSetting(db, "retention");
        const offsite = readSetting(db, "offsite") as { target?: unknown; error?: unknown } | null;
        const repository = readSetting(db, "repository") as { bytes?: unknown; at?: unknown } | null;
        return {
          retention: isPolicy(retention) ? retention : null,
          offsite: {
            target: typeof offsite?.target === "string" ? offsite.target : null,
            error: typeof offsite?.error === "string" ? offsite.error : null,
          },
          checks: checksOf(readMaintenance(db)),
          repository: typeof repository?.bytes === "number" && typeof repository.at === "string" ? { bytes: repository.bytes, at: repository.at } : null,
        };
      }),
    audit: (folder, limit, before = null) => withDatabase([], (db) => readAudit(db, folder, limit, before)),
    result: (folder) => readPlain(join(config.runFolder, RESULTS_NAME, `${folder}.json`), MAX_RESULT_BYTES),
    present: (folder) => {
      const root = join(config.sitesDir, folder);
      return {
        data: exists(join(root, DATA)),
        incoming: exists(join(root, INCOMING)),
        previous: exists(join(root, PREVIOUS)),
        failed: exists(join(root, FAILED)),
      };
    },
    hasData: (folder) => {
      try {
        const stat = lstatSync(join(config.sitesDir, folder, DATA));
        return stat.isDirectory() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
    pending: (folder, now) => {
      const file = readPlain(join(requests, `${folder}.json`), MAX_REQUEST_BYTES);
      if (file === null || file.bytes === null) return null;
      const read = readRequest(folder, new TextDecoder().decode(file.bytes), now);
      return "request" in read ? read.request : null;
    },
    writeRequest: (folder, request) => {
      mkdirSync(requests, { recursive: true, mode: 0o700 });
      writeFileAtomically(requests, `${folder}.json`, encodeRequest(request), 0o600);
    },
    removeRequest: (folder) => rmSync(join(requests, `${folder}.json`), { force: true }),
  };
}
