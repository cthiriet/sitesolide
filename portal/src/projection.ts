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
 * **Before the steward writes it**, on a machine being set up, a missing
 * file is read the same way: nothing opens but what needs no list.
 *
 * **A failed read is tried again.** A file judged and refused stays refused
 * until it changes: reading it again would refuse it again. A read that
 * failed on the way, too many open files or an I/O error, says nothing of
 * the file: the file is not marked seen, and is read again a few seconds
 * later, so that a passing error does not keep every restricted site closed
 * until the steward writes again.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
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

/** What the portal decides from: the steward's projection, or nothing. */
export type Reading = "steward" | "unreadable";

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
  log?: (line: string) => void;
  /** Milliseconds; the tests hand their own. */
  now?: () => number;
  /** How the file is read: `readText`, unless a test hands a read that fails. */
  read?: (path: string) => Read;
};

/** How long a read that failed on the way waits before the file is read again. */
export const READ_RETRY_MS = 3_000;

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

/**
 * The file's text, opened without following a link, bounded; `refused`, with
 * why, for a file that is no projection whatever happens to it next (a link,
 * not a plain file, too big, not UTF-8); `failed` for a read that broke on the
 * way and may well succeed in a moment.
 */
export type Read = { text: string } | { refused: string } | { failed: string };

function errorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}

export function readText(path: string): Read {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // A link in its place is refused by O_NOFOLLOW: no projection, whatever comes.
    return errorName(error) === "ELOOP" ? { refused: "access.json is a link" } : { failed: errorName(error) };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { refused: "access.json is not a plain file" };
    if (info.size > PROJECTION_MAX_BYTES) return { refused: "access.json is larger than a projection ever is" };
    const buffer = new Uint8Array(info.size + 1);
    let done = 0;
    while (done <= info.size) {
      const n = readSync(fd, buffer, done, buffer.length - done, null);
      if (n === 0) break;
      done += n;
    }
    // Grown while it was read: written again in the meantime, read again.
    if (done > info.size) return { failed: "changing" };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.slice(0, done)) };
    } catch {
      return { refused: "access.json is not UTF-8" };
    }
  } catch (error) {
    return { failed: errorName(error) };
  } finally {
    closeSync(fd);
  }
}

export function createAccessReader(options: AccessReaderOptions): AccessReader {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  let seen: string | null = null;
  /** A read that failed on the way: the identity it was for, and when, so that it is tried again a few seconds later and not at every request. */
  let failure: { identity: string; at: number } | null = null;
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
      current = { reading: "unreadable", projection: EMPTY_PROJECTION, index: new Map() };
      say("missing", `access: ${options.file} is missing: only the owner's password and the admin emails open a site until the steward writes it again`);
      return;
    }
    if (identity === seen) return;
    if (failure !== null && failure.identity === identity && now() - failure.at < READ_RETRY_MS) return;
    const text = (options.read ?? readText)(options.file);
    if ("failed" in text) {
      // Nothing is known of the file: nothing opens from it for now, and it is
      // read again in a few seconds, changed or not.
      failure = { identity, at: now() };
      current = { reading: "unreadable", projection: EMPTY_PROJECTION, index: new Map() };
      say(`failed:${text.failed}`, `access: ${options.file} could not be read (${text.failed}): only the owner's password and the admin emails open a site, read again in a few seconds`);
      return;
    }
    failure = null;
    // Judged from here on: a file refused stays refused until it changes.
    seen = identity;
    const read = "refused" in text ? { unreadable: text.refused } : readProjection(text.text);
    if ("unreadable" in read) {
      current = { reading: "unreadable", projection: EMPTY_PROJECTION, index: new Map() };
      say(`unreadable:${identity}`, `access: ${read.unreadable}: only the owner's password and the admin emails open a site until the steward writes it again`);
      return;
    }
    current = { reading: "steward", projection: read, index: passwordIndex(read) };
    say(`steward:${read.writtenAt}`, `access: projection of ${new Date(read.writtenAt).toISOString()} read, ${Object.keys(read.sites).length} site(s)`);
  }

  return {
    state() {
      refresh();
      return { reading: current.reading, writtenAt: current.reading === "steward" ? current.projection.writtenAt : null };
    },

    roleOf(host, email, admins) {
      refresh();
      return emailRole(current.projection.sites[host], email, admins);
    },

    passwordByHash(hash, host, now) {
      refresh();
      const found = current.index.get(hash);
      return found !== undefined && found.host === host && grantOpens(found.grant, now) ? found.grant : null;
    },

    passwordById(host, id, now) {
      refresh();
      const grant = current.projection.sites[host]?.passwords.find((one) => one.id === id);
      return grantOpens(grant, now) ? grant : null;
    },
  };
}
