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
 * not check out is taken again, a few times; then the migration waits for
 * the next start.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION_NAME } from "../../borrowed/access";
import { readBounded, readGroup, writeAtomically } from "../secrets/system";
import type { PortalRows, SharingRow, InviteRow } from "./migrate";
import { LEGACY_REGISTRY_NAME, PORTAL_DATABASE, REGISTRY_NAME } from "./protocol";

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

/** The registry, a few hundred entries per project: never near this. */
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
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
    if (!info.isFile() || info.nlink !== 1) throw new Error(`${source} is not a plain file`);
    if (uid !== null && info.uid !== uid) throw new Error(`${source} is not the portal's`);
    if (info.size > MAX_DATABASE_BYTES) throw new Error(`${source} is larger than a portal's database ever is`);
    const out = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = new Uint8Array(1024 * 1024);
      let total = 0;
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, null);
        if (n === 0) break;
        total += n;
        if (total > MAX_DATABASE_BYTES) throw new Error(`${source} grew past what a portal's database ever is`);
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

function hasTable(db: Database, name: string): boolean {
  return db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

/** The copy, opened, checked and read: its two tables, either missing on a portal from before them. */
function readCopy(path: string): PortalRows | { reason: string } {
  // A private copy read once and deleted: it needs none of openDatabase's
  // settings but the wait for a lock, which no one else holds on it.
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    const check = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
    if (check?.quick_check !== "ok") return { reason: "the copy of the portal's database does not check out" };
    const sharing = hasTable(db, "sharing")
      ? db.query<SharingRow, []>("SELECT host, mode, people, domains, updated_at FROM sharing ORDER BY host").all()
      : [];
    const invites = hasTable(db, "invites")
      ? db.query<InviteRow, []>("SELECT id, hote, libelle, empreinte, cree_a, expire_a FROM invites ORDER BY cree_a, id").all()
      : [];
    return { sharing, invites };
  } finally {
    db.close();
  }
}

export function createAccessSystem(config: AccessSystemConfig, checkOwner: boolean): AccessSystem {
  const registryFile = join(config.stateFolder, REGISTRY_NAME);
  const prepare = () => mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });

  return {
    now: () => Date.now(),

    readRegistry: async () => readRootFile(registryFile, MAX_REGISTRY_BYTES),
    async writeRegistry(text) {
      prepare();
      writeAtomically(config.stateFolder, REGISTRY_NAME, encoder.encode(text), ROOT_ONLY);
    },

    readLegacyMembers: async () => readRootFile(join(config.stateFolder, LEGACY_REGISTRY_NAME), MAX_REGISTRY_BYTES),

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
        return { kind: "unreadable", reason: `the portal's data folder cannot be read (${errorCode(error) ?? "unknown"})` };
      }
      if (!folder.isDirectory() || folder.isSymbolicLink()) return { kind: "unreadable", reason: "the portal's data folder is not a folder" };
      const uid = checkOwner ? folder.uid : null;
      if (uid === 0) return { kind: "unreadable", reason: "the portal's data folder is root's, not the portal's" };
      const source = join(config.portalDataFolder, PORTAL_DATABASE);
      let last = "the portal's database kept changing while it was copied";
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
          last = error instanceof Error ? error.message : String(error);
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
