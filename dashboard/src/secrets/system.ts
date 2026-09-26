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
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RateLimitRead } from "./unlock";
import { truncate } from "./log";
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
  readRateLimit: () => Promise<RateLimitRead>;
  writeRateLimit: (text: string) => Promise<void>;
  /** The file that carries PASSWORD_HASH, with its rights. */
  readHash: () => Promise<Examination>;
  /** A site's Caddy block, null if it is missing or is not an ordinary file. */
  readFragment: (slug: string) => Promise<string | null>;
  /** The result the gatekeeper left for this site. */
  readGatekeeperResult: (slug: string) => Promise<Examination>;
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
};

/** A manifest, a unit, a hash: none of them has any reason to be bigger. */
const MAX_TEXT_BYTES = 256 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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
function readBounded(path: string, max: number): Examination {
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
function writeAtomically(root: string, name: string, bytes: Uint8Array, permissions: Permissions): void {
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
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
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

export function createSystem(config: SystemConfig): System {
  const previousFolder = join(config.stateFolder, "precedents");
  const logFile = join(config.stateFolder, "journal.jsonl");
  const rateLimitFile = join(config.stateFolder, "rate-limit.json");
  const aRoot = { owner: null, mode: 0o600 };

  const prepareState = () => mkdirSync(previousFolder, { recursive: true, mode: 0o700 });

  /** The directories where a temporary file of ours can remain: each root, and its secrets subdirectories. */
  function tempFolders(): string[] {
    const folders: string[] = [];
    for (const root of [config.secretsFolder, previousFolder]) {
      folders.push(root);
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.endsWith(SUBFOLDER_SUFFIX)) folders.push(join(root, entry.name));
      }
    }
    folders.push(config.stateFolder);
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
      const examination = readBounded(logFile, 4 * 1024 * 1024);
      return examination.kind === "present" && examination.bytes !== null ? decoder.decode(examination.bytes) : "";
    },

    async appendLog(line) {
      prepareState();
      appendFileSync(logFile, line, { mode: 0o600 });
      const examination = readBounded(logFile, 4 * 1024 * 1024);
      if (examination.kind !== "present" || examination.bytes === null) return;
      const truncated = truncate(decoder.decode(examination.bytes));
      if (truncated !== null) writeAtomically(config.stateFolder, "journal.jsonl", encoder.encode(truncated), aRoot);
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
