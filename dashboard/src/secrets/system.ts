/**
 * The steward's inputs and outputs, and nothing but them.
 *
 * Everything that decides lives in the pure modules of this directory; this
 * file reads, writes and runs `systemctl`, without interpreting. `System` is
 * an interface so that the tests mount the steward on a throwaway tree, with a
 * simulated `systemctl` and a clock they advance themselves.
 *
 * **Synchronous `node:fs`, and not `Bun.file`.** What counts here does not
 * exist in `Bun.file`: `O_NOFOLLOW`, `O_EXCL`, `fchown` on the descriptor
 * before the first write, `fsync` of the file then of the directory.
 * Synchronous, because a sequence of calls without `await` cannot be
 * interleaved with another request: the log never sees two appends mixed
 * together.
 *
 * **Two capabilities only, CAP_CHOWN and CAP_DAC_READ_SEARCH**, the ones
 * the bench results keeps. Every action below follows from
 * them: root owns the directories where it writes, so creating, renaming and
 * deleting demand nothing more; but an `fchmod` on a file already handed over
 * to site-<slug> would demand CAP_FOWNER, hence the order `fchmod` then
 * `fchown`, and `link()` would demand it too under `protected_hardlinks`,
 * hence a creation by `O_EXCL` on the final name.
 *
 * A subdirectory such as `<slug>-secrets/` asks for nothing more: it belongs to
 * root, which creates and renames there by the owner's rights, and the 0400
 * mode of a file kept there is set on the descriptor already open for writing,
 * before the `fchown`. Reasoned, not yet measured: see the laboratory report to
 * come.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RateLimitRead } from "./unlock";
import {
  ACCESS_LOG_NAME,
  ACCESS_MAX_LINES,
  ACCESS_PRUNE_BYTES,
  ACCESS_PRUNE_INTERVAL_MS,
  ACCESS_RETENTION_MS,
  accessLogSeed,
  accessLogTopUp,
  inWindow,
  isAccessLogFull,
  isRecentLine,
  MAX_ENTRY_BYTES,
  reread,
  truncate,
  type AccessWindow,
} from "./log";
import {
  pathUnder,
  MAX_FILE_BYTES,
  SUBFOLDER_SUFFIX,
  subFolderOf,
  type ProjectEntry,
  type FolderInfo,
  type FileInfo,
  type Owner,
} from "./scope";
import { BACKUPS_NAME } from "../gatekeeper/instance";
import { MAX_RESULT_BYTES } from "./portal";
import { isValidFileName } from "../../borrowed/manifest";
import { MAX_STORE_ENV_BYTES, MAX_STORE_FILE_BYTES, storeFilePath, storePaths } from "../../borrowed/store";

export type SystemConfig = {
  sitesDir: string;
  secretsFolder: string;
  unitsFolder: string;
  stateFolder: string;
  hashFile: string;
  accountsFile: string;
  /** The Caddy blocks in service, `/etc/caddy/sites`, read to say whether the portal is up. */
  caddyFolder: string;
  /** Where the gatekeeper leaves its result, `/run/sitesolide-gatekeeper`. */
  gatekeeperFolder: string;
  /**
   * The preview codes in force, `/etc/caddy/locks-codes.json`, read to hand a
   * site's code to whoever may see it, never written: the gatekeeper writes it.
   */
  codesFile: string;
  /** The preview locks' fragment in service, `/etc/caddy/locks/verrous.caddy`, read to say whether a code is applied. */
  locksFragment: string;
  /** The command, `/usr/bin/systemctl` in production. */
  systemctl: string;
};

export type Account = Owner;

/**
 * `owner` null: no `fchown` either, the file stays with whoever writes
 * it. That is the case of the log and of the rate limiting, root's, and of
 * everything on the workstation.
 */
export type Permissions = { owner: Account | null; mode: number };

export type Examination =
  | { kind: "absent" }
  /** `bytes` null when the file was not opened: link, not regular, several links, too big. */
  | { kind: "present"; info: FileInfo; bytes: Uint8Array | null };

export type Command = { code: number; output: string };

export type System = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** The directories of SITES_DIR, with the text of their manifest. */
  listProjects: () => Promise<ProjectEntry[]>;
  /**
   * The files of the secrets directory, flat or one level down in a
   * `<slug>-secrets` subdirectory, as `name` or `sub/name`. Hidden names are
   * left out: they are this steward's own temporary files.
   */
  listSecrets: () => Promise<string[]>;
  /** The unit and its `.d/*.conf` extensions put end to end, null if the unit is missing. */
  readUnit: (unit: string) => Promise<string | null>;
  /** `name` under the secrets directory, flat or in a subdirectory. */
  examineSecret: (name: string) => Promise<Examination>;
  /** A subdirectory of the secrets directory, `<slug>-secrets`, without following a link. null if missing. */
  examineFolder: (name: string) => Promise<FolderInfo | null>;
  account: (name: string) => Promise<Account | null>;
  /** Replaces the file, by rename. */
  writeSecret: (name: string, bytes: Uint8Array, permissions: Permissions) => Promise<void>;
  /** Creates an empty file if it does not exist, false if it already existed. */
  createEmptySecret: (name: string, permissions: Permissions) => Promise<boolean>;
  examinePrevious: (name: string) => Promise<Examination>;
  /** To the owner of the file it was replacing, in a 0700 root directory. */
  writePrevious: (name: string, bytes: Uint8Array, owner: Account | null) => Promise<void>;
  /** Removes the previous version, `fsync` of the directory included. Missing, nothing to do. */
  removePrevious: (name: string) => Promise<void>;
  readLog: () => Promise<string>;
  appendLog: (line: string) => Promise<void>;
  /**
   * A window of the access log (log.ts, `AccessWindow`), oldest first; null
   * while there is no access log yet.
   */
  readAccessLog: (window: AccessWindow) => Promise<string | null>;
  /**
   * Appends to the access log, seeded from the journal first if it does not
   * exist yet, then pruned when the last pruning is an hour old or the file
   * has grown past its bound. `now` is the steward's clock.
   */
  appendAccessLog: (line: string, now: number) => Promise<void>;
  /**
   * At startup: the access log seeded from the journal if it does not exist
   * yet, or topped up with the journal's changes of access it lacks, then
   * pruned.
   */
  prepareAccessLog: (now: number) => Promise<void>;
  /** Does the access log hold as many rows younger than its retention as it keeps? Pruned first when due. */
  /** Does the access log, pruned, hold `share` of the rows and bytes it keeps, 1 for all of them, `reserve` rows more counted? */
  accessLogFull: (now: number, share?: number, reserve?: number) => Promise<boolean>;
  readRateLimit: () => Promise<RateLimitRead>;
  writeRateLimit: (text: string) => Promise<void>;
  /** The file that carries PASSWORD_HASH, with its rights. */
  readHash: () => Promise<Examination>;
  /** A site's Caddy block, null if it is missing or is not an ordinary file. */
  readFragment: (slug: string) => Promise<string | null>;
  /** The result the gatekeeper left for this site. */
  readGatekeeperResult: (slug: string) => Promise<Examination>;
  /** The codes file's text, null if it is missing or is not an ordinary file. */
  readCodes: () => Promise<string | null>;
  /** The preview locks' fragment in service, null if it is missing or is not an ordinary file. */
  readLocksFragment: () => Promise<string | null>;
  /**
   * Does a transaction backup remain for this site? Anything bearing its name
   * counts, link or file included: when in doubt, the site is not in a known
   * state.
   */
  gatekeeperBackup: (slug: string) => Promise<boolean>;
  /**
   * Every entry of the backups directory, whatever the site: the gatekeeper
   * refuses every action, on every site, as long as one remains, and the page
   * must say so everywhere and not only on the site named.
   */
  gatekeeperBackups: () => Promise<string[]>;
  /** The temporary files left behind by an abrupt stop, and them alone. Returns their number. */
  cleanTemporaries: () => Promise<number>;
  systemctl: (arguments_: string[], timeoutMs: number) => Promise<Command>;

  // --- A project's store, `<secrets>/projects/<slug>/` ------------------------
  //
  // Every path is built from a slug and a file name that storePaths and
  // storeFilePath (bin/cli/store.ts) throw on, and each of the three folders
  // is checked a real folder before anything is read or written below it:
  // `O_NOFOLLOW` guards the last component alone, and a link in the place of
  // `projects/<slug>` would make root read or write elsewhere.

  /**
   * The store's root, `projects`, its project folder, or its `files/`,
   * without following a link: null if missing.
   */
  examineStoreFolder: (slug: string, part: StoreFolderPart) => Promise<FolderInfo | null>;
  /** Makes the missing folders, root 0700, the previous versions dropped when the project's folder is new; "refused" with a path on a link or a non-folder. */
  ensureStore: (slug: string) => Promise<{ kind: "created" } | { kind: "present" } | { kind: "refused"; path: string }>;
  readStoreEnv: (slug: string) => Promise<Examination>;
  writeStoreEnv: (slug: string, bytes: Uint8Array) => Promise<void>;
  /** Every entry of `files/` but dot files, which systemd skips and this steward's temporaries are. */
  listStoreFiles: (slug: string) => Promise<string[]>;
  readStoreFile: (slug: string, name: string) => Promise<Examination>;
  /** The same entry without reading it, its link not followed: a listing reads no file's bytes. null if missing. */
  examineStoreFile: (slug: string, name: string) => Promise<FileInfo | null>;
  /** Written through a dot-named temporary in files/, renamed: LoadCredential= skips dot files (bench Q1). */
  writeStoreFile: (slug: string, name: string, bytes: Uint8Array) => Promise<void>;
  /** Unlinks that file alone; never the folder (I3'). */
  removeStoreFile: (slug: string, name: string) => Promise<void>;
  readStorePrevious: (slug: string, part: StorePreviousPart) => Promise<Examination>;
  writeStorePrevious: (slug: string, part: StorePreviousPart, bytes: Uint8Array) => Promise<void>;
  /** A legacy flat file removed, fsync of the folder included: retire. */
  removeLegacy: (name: string) => Promise<void>;
};

/** The store's three folders: `projects`, `projects/<slug>`, `projects/<slug>/files`. */
export type StoreFolderPart = "root" | "folder" | "files";

/** A version the steward keeps of a store's env or of one of its files. */
export type StorePreviousPart = "env" | `files/${string}`;

/** A manifest, a unit, a hash: none of them has any reason to be bigger. */
const MAX_TEXT_BYTES = 256 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const NEWLINE = new Uint8Array([10]);

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function toInfo(stat: Stats): FileInfo {
  return {
    link: stat.isSymbolicLink(),
    regular: stat.isFile(),
    links: stat.nlink,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    size: stat.size,
    // With its fraction of a millisecond: the service's startup is compared to
    // the microsecond, see restartPending. The page receives the rounding.
    modifiedAt: stat.mtimeMs,
  };
}

/**
 * The path of a name under a directory, or an exception. The steward has
 * already judged the name: this is the second lock, which holds even if the
 * first gives way. A subdirectory must be a real directory: `O_NOFOLLOW`
 * protects only the last component, and a link in the place of
 * `<slug>-secrets` would make it write elsewhere. Missing, it gets through: the
 * opening will fail by itself.
 */
function subState(folder: string, name: string): string {
  const path = pathUnder(folder, name);
  if (path === null || name.split("/").some((component) => component.startsWith("."))) {
    throw new Error("path outside its folder");
  }
  const subFolder = subFolderOf(name);
  if (subFolder !== null) {
    let isFolder = true;
    try {
      isFolder = lstatSync(join(folder, subFolder)).isDirectory();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (!isFolder) throw new Error("subfolder is not a plain folder");
  }
  return path;
}

/** A site name as it goes into a file name: never a `/`, never a `..`. */
function siteName(slug: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(slug) || slug.includes("..")) throw new Error("not a site name");
  return slug;
}

/**
 * `lstat`, then opening without following a link, then `fstat` on the
 * descriptor compared to the `lstat`: what is read really is the file that was
 * looked at. `O_NONBLOCK` so that a named pipe put in its place does not block
 * the process.
 */
export function readBounded(path: string, max: number): Examination {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return { kind: "absent" };
    throw error;
  }

  const info = toInfo(before);
  if (info.link || !info.regular || info.links > 1 || info.size > max) return { kind: "present", info, bytes: null };

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const after = fstatSync(fd);
    if (after.ino !== before.ino || after.dev !== before.dev) throw new Error("file replaced while being opened");

    const buffer = new Uint8Array(max + 1);
    let fieldsRead = 0;
    while (fieldsRead <= max) {
      const n = readSync(fd, buffer, fieldsRead, max + 1 - fieldsRead, null);
      if (n === 0) break;
      fieldsRead += n;
    }
    const infoAfter = toInfo(after);
    if (fieldsRead > max) return { kind: "present", info: infoAfter, bytes: null };
    return { kind: "present", info: infoAfter, bytes: buffer.slice(0, fieldsRead) };
  } finally {
    closeSync(fd);
  }
}

/** A line longer than this is no line of a log: visited empty, so that its reader drops it. */
const MAX_LINE_BYTES = 64 * 1024;

function joined(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Opened as readBounded opens: without following a link, and only a regular file with one name. */
function openPlain(path: string): number | "absent" | "not-plain" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    if (code === "ELOOP") return "not-plain";
    throw error;
  }
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink > 1) {
    closeSync(fd);
    return "not-plain";
  }
  return fd;
}

/**
 * Every line of a file, its newline left out, read in pieces of a megabyte
 * rather than whole: a log past what is ever read at once is gone through all
 * the same. A last line without its newline is visited too. `visit` must be
 * done with the bytes it is handed before it returns: they are reused.
 */
export function eachLine(path: string, visit: (line: Uint8Array) => void): "absent" | "not-plain" | "read" {
  const fd = openPlain(path);
  if (typeof fd === "string") return fd;
  try {
    const buffer = new Uint8Array(1024 * 1024);
    let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    let overlong = false;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      const chunk = buffer.subarray(0, n);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end);
        visit(overlong || carry.length + piece.length > MAX_LINE_BYTES ? new Uint8Array(0) : carry.length === 0 ? piece : joined(carry, piece));
        carry = new Uint8Array(0);
        overlong = false;
        start = end + 1;
      }
      const rest = chunk.subarray(start);
      if (overlong || carry.length + rest.length > MAX_LINE_BYTES) {
        overlong = true;
        carry = new Uint8Array(0);
      } else {
        carry = joined(carry, rest);
      }
    }
    if (overlong) visit(new Uint8Array(0));
    else if (carry.length > 0) visit(carry);
    return "read";
  } finally {
    closeSync(fd);
  }
}

/** Does this line hold these bytes somewhere? Each first byte found natively, the rest compared from there. */
function holds(line: Uint8Array, needle: Uint8Array): boolean {
  const last = line.length - needle.length;
  for (let at = line.indexOf(needle[0]!); at !== -1 && at <= last; at = line.indexOf(needle[0]!, at + 1)) {
    let same = true;
    for (let i = 1; i < needle.length && same; i++) same = line[at + i] === needle[i];
    if (same) return true;
  }
  return false;
}

/**
 * The newest `need` lines of a log that `keep` accepts, fewer when the file
 * holds fewer, read from its end backwards a megabyte at a time, oldest
 * first, each newline included. What is held at once is one piece of the
 * file and the lines kept, whatever the file's size. A line longer than
 * `MAX_ENTRY_BYTES` is no row of a log, and is passed over; so is one that
 * does not hold `needle`'s bytes, before it is decoded: a site's rows lie
 * apart in the file, and a walk that decoded every line on its way would
 * leave a megabyte of garbage for every megabyte of the file. Null when
 * absent.
 */
export function readWindow(path: string, need: number, keep: (line: string) => boolean, needle: Uint8Array | null = null): string | null | "not-plain" {
  const fd = openPlain(path);
  if (fd === "absent") return null;
  if (fd === "not-plain") return fd;
  try {
    const lenient = new TextDecoder();
    const buffer = new Uint8Array(1024 * 1024);
    /** Newest first, as they are met. */
    const kept: string[] = [];
    let full = need <= 0;
    /** The end of a line whose start lies further back. */
    let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    /** The line being gone through is past any entry's length: its start is passed over too. */
    let overlong = false;
    const visit = (line: Uint8Array) => {
      if (line.length === 0 || line.length > MAX_ENTRY_BYTES) return;
      if (needle !== null && needle.length > 0 && !holds(line, needle)) return;
      const text = lenient.decode(line);
      if (!keep(text)) return;
      kept.push(text);
      // Enough: the walk stops here rather than at the next line kept.
      if (kept.length >= need) full = true;
    };
    let position = fstatSync(fd).size;
    while (position > 0 && !full) {
      const from = Math.max(0, position - buffer.length);
      let read = 0;
      while (read < position - from) {
        const n = readSync(fd, buffer, read, position - from - read, from + read);
        if (n === 0) break;
        read += n;
      }
      position = from;
      const piece = buffer.subarray(0, read);
      const chunk = carry.length === 0 ? piece : joined(piece, carry);
      let end = chunk.length;
      let first = true;
      for (let newline = chunk.lastIndexOf(10, end - 1); newline !== -1 && !full; newline = end === 0 ? -1 : chunk.lastIndexOf(10, end - 1)) {
        // The first line met in a piece ends where the previous piece began:
        // when that line was overlong, this is its start, passed over too.
        if (!(first && overlong)) visit(chunk.subarray(newline + 1, end));
        first = false;
        overlong = false;
        end = newline;
      }
      if (full) break;
      const rest = chunk.subarray(0, end);
      if (first && overlong) {
        carry = new Uint8Array(0);
      } else if (rest.length > MAX_LINE_BYTES) {
        carry = new Uint8Array(0);
        overlong = true;
      } else {
        carry = rest.slice();
      }
      if (position === 0 && carry.length > 0 && !overlong) visit(carry);
    }
    return kept.length === 0 ? "" : `${kept.reverse().join("\n")}\n`;
  } finally {
    closeSync(fd);
  }
}

function boundedText(path: string): string | null {
  const examination = readBounded(path, MAX_TEXT_BYTES);
  if (examination.kind === "absent" || examination.bytes === null) return null;
  return decoder.decode(examination.bytes);
}

function syncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function randomSuffix(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The pattern of this file's temporary files, and of its alone:
 * `.<name>.<16 hex>.tmp`. The startup cleanup removes nothing else, a file put
 * by hand in /etc/sitesolide never being one of its own.
 */
export function isTemporary(name: string): boolean {
  return /^\.[A-Za-z0-9._-]+\.[0-9a-f]{16}\.tmp$/.test(name);
}

/**
 * Atomic write in the directory of the final file.
 *
 * The temporary file is created in `O_EXCL` and 0600 in root's name, receives
 * its mode, then `fchown` to the intended owner BEFORE the first write, for the
 * reason the `install` of bin/deploy-secrets.sh gives: there is no instant at
 * which the content belongs to an account other than its own. The mode before
 * the owner, because afterwards the file no longer belongs to root and an
 * `fchmod` would demand CAP_FOWNER. Then the write, `fsync`, rename, `fsync` of
 * the directory so that the rename survives a power cut.
 */
export function writeAtomically(root: string, name: string, bytes: Uint8Array, permissions: Permissions): void {
  writeAtomicallyWith(root, name, permissions, (write) => write(bytes));
}

/**
 * The same, the content handed over in pieces by `fill`, which calls `write`
 * as many times as it needs: a file bigger than anyone would hold in memory
 * at once, the access log pruned, is rewritten whole all the same.
 */
export function writeAtomicallyWith(root: string, name: string, permissions: Permissions, fill: (write: (bytes: Uint8Array) => void) => void): void {
  const final = subState(root, name);
  const folder = dirname(final);
  const temporary = join(folder, `.${basename(final)}.${randomSuffix()}.tmp`);
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );

  let place = false;
  try {
    try {
      fchmodSync(fd, permissions.mode);
      if (permissions.owner !== null) fchownSync(fd, permissions.owner.uid, permissions.owner.gid);
      fill((bytes) => {
        let written = 0;
        while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, final);
    place = true;
    syncFolder(folder);
  } finally {
    if (!place) {
      try {
        unlinkSync(temporary);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Exclusive creation of an EMPTY file, by `O_EXCL` on its final name: a file
 * already there, even dropped an instant ago by bin/deploy-secrets.sh, is never
 * replaced. Empty, it does not need the temporary file that guarantees a
 * content appears whole; it exists for an instant in root's name, in 0600,
 * which systemd, which reads these files under root, does not notice.
 */
function createEmpty(root: string, name: string, permissions: Permissions): boolean {
  const final = subState(root, name);
  const folder = dirname(final);
  let fd: number;
  try {
    fd = openSync(final, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }

  let created = false;
  try {
    fchmodSync(fd, permissions.mode);
    if (permissions.owner !== null) fchownSync(fd, permissions.owner.uid, permissions.owner.gid);
    fsyncSync(fd);
    created = true;
  } finally {
    closeSync(fd);
    if (!created) {
      try {
        unlinkSync(final);
      } catch {
        // already gone
      }
    }
  }
  syncFolder(folder);
  return true;
}

/** A file's account in /etc/passwd format, null if it is not there. */
export function readAccount(text: string, name: string): Account | null {
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name || fields.length < 4) continue;
    const uid = Number(fields[2]);
    const gid = Number(fields[3]);
    if (fields[2] === "" || fields[3] === "" || !Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { uid, gid };
  }
  return null;
}

/** A group's gid in /etc/group format, null if it is not there. */
export function readGroup(text: string, name: string): number | null {
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name || fields.length < 3 || fields[2] === "") continue;
    const gid = Number(fields[2]);
    return Number.isInteger(gid) ? gid : null;
  }
  return null;
}

/**
 * The path of a folder of the store, after checking it and every store folder
 * above it is a real folder or missing, never a link nor a file: the second
 * lock, which holds even if the steward's own judgement gave way. Throws
 * otherwise.
 */
function realFolders(paths: readonly string[]): void {
  for (const path of paths) {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("a store folder is not a plain folder");
  }
}

/** Does this folder exist, as a real folder? Throws on a link or a file in its place. */
function folderExists(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("a store folder is not a plain folder");
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * A name systemd would load from `files/`, as the steward reads it to list it
 * and count it: one path component, no dot first. Only a valid file name is
 * ever written (storeFilePath).
 */
function storeEntry(name: string): string {
  if (typeof name !== "string" || name === "" || name.length > 255 || name.startsWith(".") || name.includes("/") || name.includes("\0")) {
    throw new Error("not an entry of a store's files");
  }
  return name;
}

export function createSystem(config: SystemConfig): System {
  const previousFolder = join(config.stateFolder, "precedents");
  const storeRoot = join(config.secretsFolder, "projects");
  const storePreviousRoot = join(previousFolder, "projects");
  /** The three folders of a slug's store, the slug validated (storePaths throws). */
  const storeFolders = (slug: string) => {
    const { folder, env, files } = storePaths(slug, storeRoot);
    return { root: storeRoot, folder, env, files };
  };
  /** The folders of the versions kept of a slug's store, the slug validated. */
  const previousFolders = (slug: string) => {
    const { folder, env, files } = storePaths(slug, storePreviousRoot);
    return { root: storePreviousRoot, folder, env, files };
  };
  /** The path of a kept version, its part validated: `env`, or `files/<valid name>`. */
  const previousPath = (slug: string, part: StorePreviousPart): string => {
    const folders = previousFolders(slug);
    if (part === "env") return folders.env;
    if (!part.startsWith("files/")) throw new Error("not a part of a store");
    return storeFilePath(slug, part.slice("files/".length), storePreviousRoot);
  };
  const logFile = join(config.stateFolder, "journal.jsonl");
  const accessLogFile = join(config.stateFolder, ACCESS_LOG_NAME);
  const rateLimitFile = join(config.stateFolder, "rate-limit.json");
  const aRoot = { owner: null, mode: 0o600 };

  const prepareState = () => mkdirSync(previousFolder, { recursive: true, mode: 0o700 });

  function readJournal(): string {
    const examination = readBounded(logFile, 4 * 1024 * 1024);
    return examination.kind === "present" && examination.bytes !== null ? decoder.decode(examination.bytes) : "";
  }

  /**
   * The access log made from the journal's accepted changes of access when
   * it does not exist yet, and never again once it does: what a steward from
   * before it wrote there is not lost when the journal rotates. Written whole
   * and atomically, empty when the journal holds none, so that its existence
   * alone says the seeding is done. A journal that does not read seeds
   * nothing, as it shows nothing in `GET /log` either.
   */
  function seedAccessLog(): void {
    try {
      lstatSync(accessLogFile);
      return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    prepareState();
    writeAtomically(config.stateFolder, ACCESS_LOG_NAME, encoder.encode(accessLogSeed(readJournal())), aRoot);
  }

  /** When the access log was last pruned, by the steward's clock; null before the first time. */
  let accessPrunedAt: number | null = null;
  /** Its lines and bytes once pruned, kept as it grows: null until the first pruning reads it. */
  let accessCount: { lines: number; bytes: number } | null = null;
  /** Was it still full once pruned? Then the next pruning waits for its hour rather than the next append. */
  let fullOncePruned = false;

  /**
   * The access log pruned by age, gone through line by line rather than read
   * whole: a file past what is ever read at once is pruned all the same, and
   * never counts full for good. Rewritten only when a line goes; its lines
   * and bytes counted on the way.
   */
  function pruneAccess(now: number): void {
    accessPrunedAt = now;
    const cutoff = now - ACCESS_RETENTION_MS;
    const lenient = new TextDecoder();
    const keep = (line: Uint8Array) => isRecentLine(lenient.decode(line), cutoff);
    let lines = 0;
    let bytes = 0;
    let dropped = 0;
    const seen = eachLine(accessLogFile, (line) => {
      if (!keep(line)) {
        dropped++;
        return;
      }
      lines++;
      bytes += line.length + 1;
    });
    if (seen !== "read") {
      // Absent, nothing in it; anything but a plain file counts as full.
      accessCount = seen === "absent" ? { lines: 0, bytes: 0 } : { lines: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER };
      fullOncePruned = seen !== "absent";
      return;
    }
    if (dropped > 0) {
      writeAtomicallyWith(config.stateFolder, ACCESS_LOG_NAME, aRoot, (write) => {
        // A megabyte at a time rather than a write per line.
        let pending: Uint8Array[] = [];
        let size = 0;
        const flush = () => {
          if (size > 0) write(Buffer.concat(pending));
          pending = [];
          size = 0;
        };
        eachLine(accessLogFile, (line) => {
          if (!keep(line)) return;
          pending.push(Buffer.from(line), NEWLINE);
          size += line.length + 1;
          if (size >= 1024 * 1024) flush();
        });
        flush();
      });
    }
    accessCount = { lines, bytes };
    fullOncePruned = isAccessLogFull(accessCount);
  }

  /** A clock set back counts as an hour gone: the pruning is never put off for good. */
  function pruneDue(now: number): boolean {
    return accessPrunedAt === null || now - accessPrunedAt >= ACCESS_PRUNE_INTERVAL_MS || now < accessPrunedAt;
  }

  /**
   * The directories where a temporary file of ours can remain: each root, its
   * secrets subdirectories, and every project's store and its `files/`, with
   * the versions kept of them. `withFileTypes` does not follow links: a link
   * in a store's place is never walked into.
   */
  function tempFolders(): string[] {
    const read = (folder: string): Dirent[] => {
      try {
        return readdirSync(folder, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    const folders: string[] = [];
    for (const root of [config.secretsFolder, previousFolder]) {
      folders.push(root);
      for (const entry of read(root)) {
        if (entry.isDirectory() && entry.name.endsWith(SUBFOLDER_SUFFIX)) folders.push(join(root, entry.name));
      }
    }
    for (const root of [storeRoot, storePreviousRoot]) {
      for (const entry of read(root)) {
        if (!entry.isDirectory()) continue;
        const folder = join(root, entry.name);
        folders.push(folder);
        if (read(folder).some((inner) => inner.isDirectory() && inner.name === "files")) folders.push(join(folder, "files"));
      }
    }
    folders.push(config.stateFolder);
    return folders;
  }

  /** The kept versions' folders of a store laid, 0700, root's, never through a link. */
  function preparePrevious(slug: string): ReturnType<typeof previousFolders> {
    const folders = previousFolders(slug);
    prepareState();
    realFolders([folders.root, folders.folder, folders.files]);
    mkdirSync(folders.files, { recursive: true, mode: 0o700 });
    realFolders([folders.root, folders.folder, folders.files]);
    return folders;
  }

  return {
    now: () => Date.now(),
    wait: (ms) => Bun.sleep(ms),

    async listSecrets() {
      const names: string[] = [];
      const read = (folder: string): Dirent[] => {
        try {
          return readdirSync(folder, { withFileTypes: true });
        } catch {
          return [];
        }
      };
      for (const entry of read(config.secretsFolder)) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isFile()) names.push(entry.name);
        if (!entry.isDirectory() || !entry.name.endsWith(SUBFOLDER_SUFFIX)) continue;
        for (const inner of read(join(config.secretsFolder, entry.name))) {
          if (!inner.name.startsWith(".") && inner.isFile()) names.push(`${entry.name}/${inner.name}`);
        }
      }
      return names.sort();
    },

    async listProjects() {
      const entries: ProjectEntry[] = [];
      // withFileTypes does not follow links: a link put in /srv/sites is not a
      // project.
      for (const entry of readdirSync(config.sitesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let manifest: string | null = null;
        try {
          manifest = boundedText(join(config.sitesDir, entry.name, "sitesolide.json"));
        } catch {
          manifest = null;
        }
        entries.push({ folder: entry.name, manifest });
      }
      return entries.sort((a, b) => a.folder.localeCompare(b.folder));
    },

    async readUnit(unit) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(unit)) return null;
      const main = boundedText(join(config.unitsFolder, `${unit}.service`));
      if (main === null) return null;

      const chunks = [main];
      const extensions = join(config.unitsFolder, `${unit}.service.d`);
      let names: string[] = [];
      try {
        names = readdirSync(extensions).filter((name) => name.endsWith(".conf")).sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        const text = boundedText(join(extensions, name));
        if (text !== null) chunks.push(text);
      }
      return chunks.join("\n");
    },

    async examineSecret(name) {
      return readBounded(subState(config.secretsFolder, name), MAX_FILE_BYTES);
    },

    async examineFolder(name) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) throw new Error("not a subfolder name");
      try {
        const stat = lstatSync(join(config.secretsFolder, name));
        return { link: stat.isSymbolicLink(), folder: stat.isDirectory(), uid: stat.uid, mode: stat.mode & 0o7777 };
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },

    async account(name) {
      const text = boundedText(config.accountsFile);
      return text === null ? null : readAccount(text, name);
    },

    async writeSecret(name, bytes, permissions) {
      writeAtomically(config.secretsFolder, name, bytes, permissions);
    },

    async createEmptySecret(name, permissions) {
      return createEmpty(config.secretsFolder, name, permissions);
    },

    async examinePrevious(name) {
      return readBounded(subState(previousFolder, name), MAX_FILE_BYTES);
    },

    async writePrevious(name, bytes, owner) {
      prepareState();
      // The subdirectory of a previous version is ours, closed like precedents/.
      const subFolder = subFolderOf(name);
      if (subFolder !== null) mkdirSync(join(previousFolder, subFolder), { recursive: true, mode: 0o700 });
      writeAtomically(previousFolder, name, bytes, { owner, mode: 0o600 });
    },

    async removePrevious(name) {
      const path = subState(previousFolder, name);
      try {
        unlinkSync(path);
      } catch (error) {
        const code = errorCode(error);
        // Neither the file nor its directory: no previous version to remove.
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      // The removal must survive a power cut before the new secret is written:
      // otherwise the old version would reappear beside it.
      syncFolder(dirname(path));
    },

    async readLog() {
      return readJournal();
    },

    async appendLog(line) {
      prepareState();
      appendFileSync(logFile, line, { mode: 0o600 });
      const examination = readBounded(logFile, 4 * 1024 * 1024);
      if (examination.kind !== "present" || examination.bytes === null) return;
      const truncated = truncate(decoder.decode(examination.bytes));
      if (truncated !== null) writeAtomically(config.stateFolder, "journal.jsonl", encoder.encode(truncated), aRoot);
    },

    async readAccessLog(window) {
      // A window of it, however big it has grown (log.ts); a site's rows
      // found by the bytes of its name before any line is decoded. A line
      // counts only once it reads as an entry: one torn by a crash would
      // otherwise take a row's place, and a page would come up short.
      const needle = window.slug === null ? null : encoder.encode(window.slug);
      const read = readWindow(accessLogFile, window.need, (line) => inWindow(line, window) && reread(line).length > 0, needle);
      return read === "not-plain" ? "" : read;
    },

    async appendAccessLog(line, now) {
      seedAccessLog();
      appendFileSync(accessLogFile, line, { mode: 0o600 });
      if (accessCount !== null) accessCount = { lines: accessCount.lines + 1, bytes: accessCount.bytes + encoder.encode(line).length };
      // Past its bound, pruned at once, unless it was still full the last
      // time: then within the hour, rather than read through at every append.
      if (pruneDue(now) || (!fullOncePruned && lstatSync(accessLogFile).size > ACCESS_PRUNE_BYTES)) pruneAccess(now);
    },

    async prepareAccessLog(now) {
      let existed = true;
      try {
        lstatSync(accessLogFile);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        existed = false;
      }
      seedAccessLog();
      if (existed) {
        // Seeded by an earlier steward, whose changes of access were fewer:
        // what the journal still holds of the others joins it, once. The
        // access log gone through line by line, never held whole.
        const lenient = new TextDecoder();
        let plain = true;
        const added = accessLogTopUp(
          readJournal(),
          (visit) => {
            plain = eachLine(accessLogFile, (line) => visit(lenient.decode(line))) === "read";
          },
          now,
        );
        if (plain && added !== "") appendFileSync(accessLogFile, added, { mode: 0o600 });
      }
      pruneAccess(now);
    },

    async accessLogFull(now, share = 1, reserve = 0) {
      if (accessCount === null || pruneDue(now)) {
        seedAccessLog();
        pruneAccess(now);
      }
      const count = accessCount ?? { lines: 0, bytes: 0 };
      return isAccessLogFull({ lines: count.lines + reserve, bytes: count.bytes }, Math.floor(ACCESS_MAX_LINES * share), Math.floor(ACCESS_PRUNE_BYTES * share));
    },


    async readRateLimit() {
      try {
        const examination = readBounded(rateLimitFile, 4096);
        if (examination.kind === "absent") return { kind: "absent" };
        if (examination.bytes === null) return { kind: "unreadable" };
        return { kind: "read", text: new TextDecoder("utf-8", { fatal: true }).decode(examination.bytes) };
      } catch {
        return { kind: "unreadable" };
      }
    },

    async writeRateLimit(text) {
      prepareState();
      writeAtomically(config.stateFolder, "rate-limit.json", encoder.encode(text), aRoot);
    },

    async readHash() {
      return readBounded(config.hashFile, MAX_TEXT_BYTES);
    },

    async readFragment(slug) {
      return boundedText(join(config.caddyFolder, `${siteName(slug)}.caddy`));
    },

    async readGatekeeperResult(slug) {
      return readBounded(join(config.gatekeeperFolder, `${siteName(slug)}.json`), MAX_RESULT_BYTES);
    },

    async readCodes() {
      return boundedText(config.codesFile);
    },

    async readLocksFragment() {
      return boundedText(config.locksFragment);
    },

    async gatekeeperBackup(slug) {
      try {
        lstatSync(join(config.gatekeeperFolder, BACKUPS_NAME, siteName(slug)));
        return true;
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw error;
      }
    },

    async gatekeeperBackups() {
      try {
        return readdirSync(join(config.gatekeeperFolder, BACKUPS_NAME)).sort();
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw error;
      }
    },

    async cleanTemporaries() {
      let removed = 0;
      for (const folder of tempFolders()) {
        let names: string[];
        try {
          names = readdirSync(folder);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!isTemporary(name)) continue;
          const path = join(folder, name);
          try {
            if (!lstatSync(path).isFile()) continue;
            unlinkSync(path);
            removed++;
          } catch {
            // gone in the meantime, or unreadable: nothing more to do
          }
        }
      }
      return removed;
    },

    async examineStoreFolder(slug, part) {
      const folders = storeFolders(slug);
      const path = folders[part];
      try {
        const stat = lstatSync(path);
        return { link: stat.isSymbolicLink(), folder: stat.isDirectory(), uid: stat.uid, mode: stat.mode & 0o7777 };
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },

    async ensureStore(slug) {
      const folders = storeFolders(slug);
      let created = false;
      for (const path of [folders.root, folders.folder, folders.files]) {
        let stat: Stats | null = null;
        try {
          stat = lstatSync(path);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
        if (stat !== null) {
          if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "refused", path };
          continue;
        }
        if (path === folders.folder) {
          // A slug removed then created again must not find its
          // predecessor's previous versions to restore (createFresh in
          // steward.ts gives the same reason for a legacy file).
          realFolders([storePreviousRoot]);
          rmSync(previousFolders(slug).folder, { recursive: true, force: true });
          created = true;
        }
        mkdirSync(path, { mode: 0o700 });
        // The mode the umask may have narrowed or not, said once.
        chmodSync(path, 0o700);
        syncFolder(dirname(path));
      }
      return created ? { kind: "created" } : { kind: "present" };
    },

    async readStoreEnv(slug) {
      const folders = storeFolders(slug);
      realFolders([folders.root, folders.folder]);
      return readBounded(folders.env, MAX_STORE_ENV_BYTES);
    },

    async writeStoreEnv(slug, bytes) {
      const folders = storeFolders(slug);
      realFolders([folders.root, folders.folder]);
      if (!folderExists(folders.folder)) throw new Error("the store's folder is missing");
      writeAtomically(folders.folder, "env", bytes, aRoot);
    },

    async listStoreFiles(slug) {
      const folders = storeFolders(slug);
      realFolders([folders.root, folders.folder, folders.files]);
      let names: string[];
      try {
        names = readdirSync(folders.files);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return [];
        throw error;
      }
      return names.filter((name) => !name.startsWith(".")).sort();
    },

    async readStoreFile(slug, name) {
      const folders = storeFolders(slug);
      realFolders([folders.root, folders.folder, folders.files]);
      return readBounded(join(folders.files, storeEntry(name)), MAX_STORE_FILE_BYTES);
    },

    async examineStoreFile(slug, name) {
      const folders = storeFolders(slug);
      realFolders([folders.root, folders.folder, folders.files]);
      try {
        return toInfo(lstatSync(join(folders.files, storeEntry(name))));
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },

    async writeStoreFile(slug, name, bytes) {
      const folders = storeFolders(slug);
      // Throws on a name that is not valid: no other name is ever written.
      storeFilePath(slug, name, storeRoot);
      realFolders([folders.root, folders.folder, folders.files]);
      if (!folderExists(folders.files)) throw new Error("the store's files folder is missing");
      writeAtomically(folders.files, name, bytes, aRoot);
    },

    async removeStoreFile(slug, name) {
      const folders = storeFolders(slug);
      const path = storeFilePath(slug, name, storeRoot);
      realFolders([folders.root, folders.folder, folders.files]);
      try {
        // The entry alone: a link in its place is removed, never followed,
        // and the folder stays, empty or not.
        unlinkSync(path);
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      syncFolder(folders.files);
    },

    async readStorePrevious(slug, part) {
      const folders = previousFolders(slug);
      const path = previousPath(slug, part);
      realFolders([folders.root, folders.folder, folders.files]);
      return readBounded(path, part === "env" ? MAX_STORE_ENV_BYTES : MAX_STORE_FILE_BYTES);
    },

    async writeStorePrevious(slug, part, bytes) {
      const path = previousPath(slug, part);
      preparePrevious(slug);
      writeAtomically(dirname(path), basename(path), bytes, aRoot);
    },

    async removeLegacy(name) {
      // A flat name, as retire takes: never a subfolder's file, never a hidden one.
      if (typeof name !== "string" || name.includes("/") || name.startsWith(".")) throw new Error("not a legacy file's name");
      const path = subState(config.secretsFolder, name);
      unlinkSync(path);
      syncFolder(config.secretsFolder);
    },

    /**
     * An array of arguments, never a shell line, and a delay: a `restart` whose
     * stop drags on must not hold the lock indefinitely.
     */
    async systemctl(arguments_, timeoutMs) {
      const process = Bun.spawn([config.systemctl, ...arguments_], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      const [output, code] = await Promise.all([process.stdout.text(), process.exited]);
      return { code, output };
    },
  };
}
