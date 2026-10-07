/**
 * Where the portal reads who may open a site from: the steward's projection,
 * `/etc/sitesolide-portal/access.json` (src/access.ts), read again as soon as
 * it changes, so that someone removed or lowered is refused at their next
 * request.
 *
 * **Read again when it changes, judged before use.** Every decision looks at
 * the file's identity, its inode, size and modification time, one `stat`
 * and nothing more when it has not moved; a file that moved is read whole
 * and judged by `readProjection`. One that does not read opens nothing but
 * what needs no list: the owner's password and `OIDC_ADMIN_EMAILS`. It is
 * said once in the journal, and read again at the next change.
 *
 * **Before the steward writes it.** A portal deployed before the steward
 * that keeps the registry finds no file, and decides from its own tables as
 * it did, so that the order of an upgrade opens and closes nothing. The
 * first time it reads a projection it leaves a mark in its data folder:
 * from then on, a missing file opens nothing either, and its old tables, kept
 * read-only, are never read again.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import {
  EMPTY_PROJECTION,
  PROJECTION_MAX_BYTES,
  emailRole,
  grantOpens,
  passwordIndex,
  readProjection,
  type PasswordGrant,
  type Projection,
  type Role,
} from "./access";
import type { GuestStore, SharingStore } from "./database";
import { guestOpens, type Guest } from "./guests";
import { DEFAULT_POLICY, identityRole } from "./sharing";

/** What the portal decides from: the steward's projection, its own tables before it, or nothing. */
export type Reading = "steward" | "portal" | "unreadable";

export type AccessReader = {
  /** Where the decisions come from now, and when the steward wrote what is read. */
  state: () => { reading: Reading; writtenAt: number | null };
  /** The role this verified email holds on this host, or null when it may not open it. */
  roleOf: (host: string, email: string, admins: readonly string[]) => Role | null;
  /** The password access this hash opens on this host, right now. */
  passwordByHash: (hash: string, host: string, now: number) => PasswordGrant | null;
  /** The password access a cookie names, still in place and unexpired on this host. */
  passwordById: (host: string, id: string, now: number) => PasswordGrant | null;
};

export type AccessReaderOptions = {
  /** The steward's projection. */
  file: string;
  /** The mark left in the portal's data folder once a projection was read. */
  mark: string;
  /** The tables from before the steward kept access, read-only. */
  legacy: { guests: Pick<GuestStore, "byId" | "byHash">; sharing: Pick<SharingStore, "get"> } | null;
  log?: (line: string) => void;
};

/**
 * The file's identity: what changes when the steward writes it again, or when
 * its rights are repaired (the change time). Read without following a link:
 * a link in its place is no projection, dangling or not.
 */
function identityOf(path: string): string | null {
  try {
    const info = lstatSync(path);
    return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return null;
  }
}

/** The file's text, opened without following a link, bounded. */
function readText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > PROJECTION_MAX_BYTES) return null;
    const buffer = new Uint8Array(info.size + 1);
    let read = 0;
    while (read <= info.size) {
      const n = readSync(fd, buffer, read, buffer.length - read, null);
      if (n === 0) break;
      read += n;
    }
    if (read > info.size) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.slice(0, read));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function legacyGrant(guest: Guest | null, host: string, now: number): PasswordGrant | null {
  if (!guestOpens(guest, host, now)) return null;
  // The hash is never read back here: the cookie names the access, the
  // sign-in found it by its hash already.
  return { id: guest.id, who: guest.label, hash: "", expiresAt: guest.expiresAt };
}

export function createAccessReader(options: AccessReaderOptions): AccessReader {
  const log = options.log ?? ((line: string) => console.log(line));
  let seen: string | null = null;
  let current: { reading: Reading; projection: Projection; index: ReturnType<typeof passwordIndex> } = {
    reading: "unreadable",
    projection: EMPTY_PROJECTION,
    index: new Map(),
  };
  let said: string | null = null;

  function say(state: string, line: string): void {
    if (said === state) return;
    said = state;
    log(line);
  }

  function refresh(): void {
    const identity = identityOf(options.file);
    if (identity === null) {
      seen = null;
      if (existsSync(options.mark) || options.legacy === null) {
        current = { reading: "unreadable", projection: EMPTY_PROJECTION, index: new Map() };
        say("missing", `access: ${options.file} is missing: only the owner's password and the admin emails open a site until the steward writes it again`);
      } else {
        current = { reading: "portal", projection: EMPTY_PROJECTION, index: new Map() };
        say("portal", "access: no projection from the steward yet, deciding from this portal's own tables as before");
      }
      return;
    }
    if (identity === seen) return;
    seen = identity;
    const text = readText(options.file);
    const read = text === null ? { unreadable: `${options.file} cannot be read` } : readProjection(text);
    if ("unreadable" in read) {
      current = { reading: "unreadable", projection: EMPTY_PROJECTION, index: new Map() };
      say(`unreadable:${identity}`, `access: ${read.unreadable}: only the owner's password and the admin emails open a site until the steward writes it again`);
      return;
    }
    current = { reading: "steward", projection: read, index: passwordIndex(read) };
    if (!existsSync(options.mark)) {
      try {
        writeFileSync(options.mark, `${new Date().toISOString()}\n`, { mode: 0o600 });
      } catch (e) {
        log(`access: the mark ${options.mark} could not be written (${(e as Error).name})`);
      }
    }
    say(`steward:${read.writtenAt}`, `access: projection of ${new Date(read.writtenAt).toISOString()} read, ${Object.keys(read.sites).length} site(s)`);
  }

  return {
    state() {
      refresh();
      return { reading: current.reading, writtenAt: current.reading === "steward" ? current.projection.writtenAt : null };
    },

    roleOf(host, email, admins) {
      refresh();
      if (current.reading === "portal" && options.legacy !== null) {
        const role = identityRole(email, options.legacy.sharing.get(host) ?? DEFAULT_POLICY, admins);
        return role === null ? null : role === "admin" ? "admin" : "visitor";
      }
      return emailRole(current.projection.sites[host], email, admins);
    },

    passwordByHash(hash, host, now) {
      refresh();
      if (current.reading === "portal" && options.legacy !== null) return legacyGrant(options.legacy.guests.byHash(hash), host, now);
      const found = current.index.get(hash);
      return found !== undefined && found.host === host && grantOpens(found.grant, now) ? found.grant : null;
    },

    passwordById(host, id, now) {
      refresh();
      if (current.reading === "portal" && options.legacy !== null) return legacyGrant(options.legacy.guests.byId(id), host, now);
      const grant = current.projection.sites[host]?.passwords.find((one) => one.id === id);
      return grantOpens(grant, now) ? grant : null;
    },
  };
}
