/**
 * The access registry's inputs and outputs: the registry itself, the
 * portal's projection beside the assertion key, and, once, the stores before
 * it, `members.json` and the portal's database. An interface, so that the
 * tests run the routes and the migration on a throwaway tree.
 *
 * **The portal's database is read by root, as a copy.** The migration runs
 * at the first start of the steward on this code, before the portal itself
 * may have been upgraded, so it cannot wait for a route the running portal
 * may not have; and the steward keeps no network, so a route handing over
 * password hashes would be one more door on the loopback, open long after
 * the one read it was made for. The steward already reads `/srv/sites` with
 * `CAP_DAC_READ_SEARCH`, under `ProtectSystem=strict`. What it does not do is
 * let SQLite open a file another account can change under it: the portal's
 * account owns its data folder, and could put a link where the database is.
 * So the database and its write-ahead log are opened without following a
 * link, only as regular files with a single name owned by the folder's
 * owner, copied into a folder of the steward's own, checked whole by SQLite
 * there, and read from that copy, which is then deleted. A copy that does
 * not check out is taken again, a few times; then the migration is tried
 * again later.
 *
 * **A database the portal's account could have written is read as hostile.**
 * The two tables read must carry exactly the portal's own definitions
 * (`sqlite_master.sql`, against `EXPECTED_TABLES`), nothing else hung on
 * them, no trigger, no index of their own, no generated column; the schema
 * is not trusted to run functions (`trusted_schema = OFF`); the rows are
 * counted, and their sizes measured without being read, each and all of a
 * table together, before any is read (`octet_length`). Anything else stops
 * the migration, which the owner can
 * finish without the portal's database. The reasons are error names, never
 * a path or a message that could quote one.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION_NAME } from "../../borrowed/access";
import { readBounded, readGroup, writeAtomically } from "../secrets/system";
import type { PortalRows, SharingRow, InviteRow } from "./migrate";
import { LEGACY_REGISTRY_NAME, PORTAL_DATABASE, REGISTRY_MAX_BYTES, REGISTRY_NAME } from "./protocol";

export type AccessSystemConfig = {
  /** /var/lib/sitesolide-steward */
  stateFolder: string;
  /** /etc/sitesolide-portal, where the projection lies beside the assertion key. */
  portalKeyFolder: string;
  /** /etc/group, to find the portal's group. */
  groupsFile: string;
  /** `site-portal`; empty, no `chown`, for the workstation. */
  portalGroup: string;
  /** /srv/sites/portal/data, the portal's own folder. */
  portalDataFolder: string;
};

export type ProjectionWrite = "written" | "no-folder" | "no-group";

export type PortalReading = { kind: "absent" } | { kind: "read"; rows: PortalRows } | { kind: "unreadable"; reason: string };

export type AccessSystem = {
  now: () => number;
  /** The projection's identity as it lies, inode, size and times; null when it is not there. */
  projectionStamp: () => string | null;
  /** The registry's text, null when there is none yet. Throws when it is there but cannot be read whole. */
  readRegistry: () => Promise<string | null>;
  writeRegistry: (text: string) => Promise<void>;
  /** `members.json`, null when absent. Throws when it is there but cannot be read whole. */
  readLegacyMembers: () => Promise<string | null>;
  /** The portal's sharing and password access, read from a checked copy of its database. */
  readPortalDatabase: () => Promise<PortalReading>;
  /** Lays the portal's projection, unless its folder or the portal's group is missing. */
  writeProjection: (text: string) => Promise<ProjectionWrite>;
};

/** The portal's database: its audit is bounded to a few tens of megabytes. */
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const ROOT_ONLY = { owner: null, mode: 0o600 };

function readRootFile(path: string, max: number): string | null {
  const examination = readBounded(path, max);
  if (examination.kind === "absent") return null;
  if (examination.bytes === null) throw new Error(`${path} is not a plain file of a reasonable size`);
  return decoder.decode(examination.bytes);
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** A copy refused for what the file is, named: never a message that could quote its path. */
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** What a failure is called in an answer and the log: its name, its code, never its message. */
function reasonOf(error: unknown): string {
  if (error instanceof Refused) return error.reason;
  return errorCode(error) ?? (error instanceof Error ? error.name : "unknown");
}

/**
 * One file of the portal's folder copied to `destination`, or `absent`: opened
 * without following a link, a regular file with one name, owned by `uid`.
 * Returns its size and modification time as it was opened, to tell whether
 * the portal wrote while it was copied.
 */
function copyOwnedFile(source: string, destination: string, uid: number | null): { size: number; mtimeMs: number } | "absent" {
  let fd: number;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Refused("not-a-plain-file");
    if (uid !== null && info.uid !== uid) throw new Refused("not-the-portals");
    if (info.size > MAX_DATABASE_BYTES) throw new Refused("too-large");
    const out = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = new Uint8Array(1024 * 1024);
      let total = 0;
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (n === 0) break;
        total += n;
        if (total > MAX_DATABASE_BYTES) throw new Refused("too-large");
        let written = 0;
        while (written < n) written += writeSync(out, buffer, written, n - written);
      }
    } finally {
      closeSync(out);
    }
    return { size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function sameAsCopied(path: string, copied: { size: number; mtimeMs: number } | "absent"): boolean {
  try {
    const now = statSync(path);
    return copied !== "absent" && now.size === copied.size && now.mtimeMs === copied.mtimeMs;
  } catch (error) {
    return errorCode(error) === "ENOENT" && copied === "absent";
  }
}

/** A statement as SQLite keeps it, its spaces and line breaks collapsed, none around a parenthesis or a comma: what is compared. */
export function normalizedSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/ ?([(),]) ?/g, "$1")
    .trim();
}

/**
 * The portal's own definitions of the two tables read, as `sqlite_master`
 * keeps them (portal/src/database.ts, `IF NOT EXISTS` dropped by SQLite): the
 * only one either table ever had.
 */
export const EXPECTED_TABLES: Readonly<Record<"sharing" | "invites", string>> = {
  sharing: normalizedSql(`CREATE TABLE sharing (
     host       TEXT PRIMARY KEY,
     mode       TEXT NOT NULL,
     people     TEXT NOT NULL,
     domains    TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`),
  invites: normalizedSql(`CREATE TABLE invites (
     id        TEXT PRIMARY KEY,
     hote      TEXT NOT NULL,
     libelle   TEXT NOT NULL,
     empreinte TEXT NOT NULL UNIQUE,
     cree_a    INTEGER NOT NULL,
     expire_a  INTEGER,
     vu_a      INTEGER
   )`),
};

/** Rows read at most: a hundred sites shared, a few thousand password access. */
export const MAX_SHARING_ROWS = 10_000;
export const MAX_INVITE_ROWS = 50_000;

/**
 * The bytes of one table's values read at most, all its rows together: a
 * table within every bound of a row and of a count could still hold more than
 * the steward's 128M, the product of the two.
 */
export const MAX_TABLE_BYTES = 16 * 1024 * 1024;

/**
 * Each value's type and size, in bytes, before any is read: a value bigger
 * than any the portal ever wrote stops the migration rather than filling the
 * steward's memory. `octet_length` reads a value's size from its record,
 * without loading it.
 */
const SHARING_BOUNDS =
  "typeof(host) = 'text' AND octet_length(host) <= 253 AND typeof(mode) = 'text' AND octet_length(mode) <= 16 " +
  "AND typeof(people) = 'text' AND octet_length(people) <= 262144 AND typeof(domains) = 'text' AND octet_length(domains) <= 32768 " +
  "AND typeof(updated_at) = 'integer'";
const INVITE_BOUNDS =
  "typeof(id) = 'text' AND octet_length(id) <= 16 AND typeof(hote) = 'text' AND octet_length(hote) <= 253 " +
  "AND typeof(libelle) = 'text' AND octet_length(libelle) <= 1024 AND typeof(empreinte) = 'text' AND octet_length(empreinte) = 64 " +
  "AND typeof(cree_a) = 'integer' AND (expire_a IS NULL OR typeof(expire_a) = 'integer')";

/** The bytes of a row's text values, read as `octet_length` reads them: from the record, without loading them. */
const SHARING_SIZE = "octet_length(host) + octet_length(mode) + octet_length(people) + octet_length(domains)";
const INVITE_SIZE = "octet_length(id) + octet_length(hote) + octet_length(libelle) + octet_length(empreinte)";

/** Why a table may not be read, or null; "absent" for a portal from before it. */
function tableRefusal(db: Database, name: "sharing" | "invites", maxRows: number, bounds: string, size: string): string | null | "absent" {
  const objects = db
    .query<{ type: string; name: string; sql: string | null }, [string, string]>("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? OR name = ? LIMIT 16")
    .all(name, name);
  const table = objects.find((one) => one.type === "table" && one.name === name);
  if (table === undefined) return objects.length === 0 ? "absent" : "unexpected-schema";
  if (typeof table.sql !== "string" || normalizedSql(table.sql) !== EXPECTED_TABLES[name]) return "unexpected-schema";
  // Its primary key's and its UNIQUE's own indexes, which SQLite makes and
  // keeps no statement for; nothing else.
  for (const one of objects) {
    if (one === table) continue;
    if (one.type !== "index" || one.sql !== null || !one.name.startsWith(`sqlite_autoindex_${name}_`)) return "unexpected-schema";
  }
  const rows = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${name}`).get()?.n ?? 0;
  if (rows > maxRows) return "too-many-rows";
  const outside = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${name} WHERE NOT (${bounds})`).get()?.n ?? 0;
  if (outside > 0) return "oversized-rows";
  const total = db.query<{ n: number }, []>(`SELECT coalesce(sum(${size}), 0) AS n FROM ${name}`).get()?.n ?? 0;
  if (total > MAX_TABLE_BYTES) return "oversized-table";
  return null;
}

/** The copy, opened, checked and read: its two tables, either missing on a portal from before them. */
export function readCopy(path: string): PortalRows | { reason: string } {
  // A private copy read once and deleted: it needs none of openDatabase's
  // settings but the wait for a lock, which no one else holds on it, and a
  // schema that runs no function of its own.
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.run("PRAGMA trusted_schema = OFF");
    const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (check?.quick_check !== "ok") return { reason: "check-failed" };
    const sharing = tableRefusal(db, "sharing", MAX_SHARING_ROWS, SHARING_BOUNDS, SHARING_SIZE);
    if (sharing !== null && sharing !== "absent") return { reason: sharing };
    const invites = tableRefusal(db, "invites", MAX_INVITE_ROWS, INVITE_BOUNDS, INVITE_SIZE);
    if (invites !== null && invites !== "absent") return { reason: invites };
    return {
      sharing: sharing === "absent" ? [] : db.query<SharingRow, []>(`SELECT host, mode, people, domains, updated_at FROM sharing ORDER BY host LIMIT ${MAX_SHARING_ROWS}`).all(),
      invites: invites === "absent" ? [] : db.query<InviteRow, []>(`SELECT id, hote, libelle, empreinte, cree_a, expire_a FROM invites ORDER BY cree_a, id LIMIT ${MAX_INVITE_ROWS}`).all(),
    };
  } catch (error) {
    return { reason: errorCode(error) ?? (error instanceof Error ? error.name : "unknown") };
  } finally {
    db.close();
  }
}

export function createAccessSystem(config: AccessSystemConfig, checkOwner: boolean): AccessSystem {
  const registryFile = join(config.stateFolder, REGISTRY_NAME);
  const prepare = () => mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });

  const projectionFile = join(config.portalKeyFolder, PROJECTION_NAME);

  return {
    now: () => Date.now(),

    projectionStamp() {
      try {
        const info = lstatSync(projectionFile);
        return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch {
        return null;
      }
    },

    readRegistry: async () => readRootFile(registryFile, REGISTRY_MAX_BYTES),
    async writeRegistry(text) {
      prepare();
      writeAtomically(config.stateFolder, REGISTRY_NAME, encoder.encode(text), ROOT_ONLY);
    },

    readLegacyMembers: async () => readRootFile(join(config.stateFolder, LEGACY_REGISTRY_NAME), REGISTRY_MAX_BYTES),

    async readPortalDatabase() {
      // A copy left by a stop in the middle of a read goes first.
      try {
        for (const name of readdirSync(config.stateFolder)) {
          if (name.startsWith(".portal-copy-")) rmSync(join(config.stateFolder, name), { recursive: true, force: true });
        }
      } catch {
        // No state folder yet: nothing left behind either.
      }
      let folder;
      try {
        folder = lstatSync(config.portalDataFolder);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { kind: "absent" };
        return { kind: "unreadable", reason: `folder-${reasonOf(error)}` };
      }
      if (!folder.isDirectory() || folder.isSymbolicLink()) return { kind: "unreadable", reason: "folder-not-a-folder" };
      const uid = checkOwner ? folder.uid : null;
      if (uid === 0) return { kind: "unreadable", reason: "folder-root-owned" };
      const source = join(config.portalDataFolder, PORTAL_DATABASE);
      let last = "kept-changing";
      for (let attempt = 0; attempt < 5; attempt++) {
        prepare();
        const copy = join(config.stateFolder, `.portal-copy-${crypto.randomUUID()}`);
        mkdirSync(copy, { mode: 0o700 });
        try {
          const database = copyOwnedFile(source, join(copy, PORTAL_DATABASE), uid);
          if (database === "absent") return { kind: "absent" };
          const wal = copyOwnedFile(`${source}-wal`, join(copy, `${PORTAL_DATABASE}-wal`), uid);
          if (!sameAsCopied(source, database) || !sameAsCopied(`${source}-wal`, wal)) continue;
          const rows = readCopy(join(copy, PORTAL_DATABASE));
          if ("reason" in rows) {
            last = rows.reason;
            continue;
          }
          return { kind: "read", rows };
        } catch (error) {
          last = reasonOf(error);
        } finally {
          rmSync(copy, { recursive: true, force: true });
        }
        await Bun.sleep(200 * (attempt + 1));
      }
      return { kind: "unreadable", reason: last };
    },

    async writeProjection(text) {
      // The folder is bin/deploy-steward.sh's: a link or anything but a
      // folder there, and nothing is written.
      try {
        const folder = lstatSync(config.portalKeyFolder);
        if (!folder.isDirectory() || folder.isSymbolicLink()) return "no-folder";
      } catch {
        return "no-folder";
      }
      let owner: { uid: number; gid: number } | null = null;
      if (config.portalGroup !== "") {
        let gid: number | null = null;
        try {
          gid = readGroup(readFileSync(config.groupsFile, "utf8"), config.portalGroup);
        } catch {
          gid = null;
        }
        if (gid === null) return "no-group";
        owner = { uid: 0, gid };
      }
      writeAtomically(config.portalKeyFolder, PROJECTION_NAME, encoder.encode(text), { owner, mode: 0o640 });
      return "written";
    },
  };
}
