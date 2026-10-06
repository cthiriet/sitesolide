/**
 * The copy of one project's data folder into an archive, run AS THAT PROJECT:
 * `site-<slug>`, in a transient unit confined like its own service
 * (runner.ts). Root never opens a project's files: it receives a stream of
 * bytes on this process's standard output and stores it.
 *
 * Why the project's own account, and not root:
 *
 * - **SQLite's side files.** Opening a WAL database creates its `-wal` and
 *   `-shm` when they are missing. Created by root, they would belong to root,
 *   and the project's service would then fail to open its own database. Under
 *   the project's account they are exactly the files its service would create.
 * - **A hostile project.** A project can put anything in its folder, a forged
 *   database file included, which SQLite then parses. Parsed as the project,
 *   the worst a forged file obtains is what the project already had.
 *
 * What goes in, and how:
 *
 * - every SQLite database, recognised by its header and not by its name, is
 *   copied through `VACUUM INTO`: a consistent snapshot even while its service
 *   writes, taken in one read transaction, which does not block a WAL writer.
 *   Its `-wal`, `-shm` and `-journal` are not archived, the copy holds them.
 *   Measured against `serialize()` on 4 October 2026, a 196 MB database under
 *   59,000 concurrent transactions: both consistent, but `serialize()` holds
 *   the whole database in memory and writes a file still flagged WAL, which a
 *   read-only connection then cannot open; `VACUUM INTO` streams to disk, uses
 *   no extra memory and writes a plain rollback-journal file;
 * - every other regular file as it is, read once, exactly the size it had
 *   once opened: a file that changes meanwhile is padded or cut, as `tar`
 *   does, and the summary says so; one replaced whole since it was listed is
 *   archived as the version opened;
 * - folders as folders, empty ones included;
 * - symbolic links, sockets, pipes and devices are left out and named in the
 *   summary: a link restored as root could point anywhere.
 *
 * The archive holds `data/` and, last, `sitesolide-backup.json`, which says
 * what was copied and what was left out, of which project and when: the
 * extraction checks those two against the snapshot it was asked for.
 * `tar -xzf` gives back `data/`.
 *
 * **Bounded, before and during.** The folder is measured first, here, as the
 * project, never by root (measureData): a project can put millions of names
 * in its folder, and a root process listing them would be the one to run out
 * of memory, for every project at once. Here, under the project's own
 * MemoryMax, a folder too big to list costs that project its snapshot, and
 * nothing else. The copy then stops past the measured size with a margin, and
 * past the number of entries an extraction accepts: a file grown afterwards,
 * a sparse one of a terabyte for instance, cannot hold the run while it
 * archives zeros, and no snapshot is ever reported sound that a restore would
 * refuse.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { TarWriter, gzipSink, type EntryMeta, type Sink } from "./tar";

/** The first 16 bytes of every SQLite 3 database. */
export const SQLITE_HEADER = "SQLite format 3\u0000";

/** The files SQLite keeps beside a database, which its copy already holds. */
export const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"];

/** The archive's top folder, and the description that ends it. */
export const DATA_ROOT = "data";
export const DESCRIPTION_NAME = "sitesolide-backup.json";
/**
 * 2: the description names its folder and its time. 1, before, did not, and
 * an archive of that format is extracted without the check.
 */
export const DESCRIPTION_FORMAT = 2;

/**
 * The entries of an archive, `data/`, its folders, its files and the
 * description all counted. The extraction refuses beyond, so the copy stops
 * before: a snapshot taken is a snapshot that restores.
 */
export const MAX_ENTRIES = 2_000_000;

/**
 * What the data may grow by between its measure and the end of its copy: a
 * quarter, and 64 MiB at least, for a service that keeps writing. Past it,
 * the copy stops: see measureData.
 */
export const GROWTH_FLOOR = 64 * 1024 * 1024;

/** Prefix of the copies this mode leaves in its staging folder, and removes. */
const COPY_PREFIX = ".copy-";

export type Skipped = { path: string; reason: string };

export type CopySummary = {
  files: number;
  directories: number;
  databases: string[];
  bytes: number;
  skipped: Skipped[];
  /** Files that changed while being read: archived padded or cut. */
  changed: string[];
};

/**
 * A copy that gives up. The message says what went wrong and never where: it
 * ends up in the status file, which an unprivileged monitor reads, and a file's
 * name inside a project's data is that project's business (a customer's name
 * in an upload's, for one). The path travels apart, to the journal only.
 */
export class CopyError extends Error {
  override name = "CopyError";
  constructor(
    message: string,
    readonly path: string | null = null,
    /** `database`: a database could not be read consistently, which a restore may work around (restore.ts). */
    readonly code: "database" | null = null,
  ) {
    super(message);
  }
}

const strict = new TextDecoder("utf-8", { fatal: true });

function metaOf(stat: Stats): EntryMeta {
  return { mode: stat.mode & 0o777, mtime: Math.floor(stat.mtimeMs / 1000), uid: stat.uid, gid: stat.gid };
}

/**
 * The cause in a word or two: a system error's code, never its message, which
 * quotes the full path.
 */
function describeError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown error";
}

/** Does this file start like a SQLite database? Opened without following a link, never blocking. */
export function isSqlite(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const header = new Uint8Array(16);
    const read = readSync(fd, header, 0, 16, 0);
    return read === 16 && new TextDecoder().decode(header) === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

/**
 * A file opened without following a link, never blocking, and what `fstat`
 * says of what was opened: what is archived is described by the file read,
 * never by an earlier look at its name.
 */
async function openFile(path: string): Promise<{ handle: FileHandle; stat: Stats }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return { handle, stat: fstatSync(handle.fd) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Exactly `size` bytes of an open file, or fewer if it shrank, in chunks of 64 KiB. */
async function* readExactly(handle: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  let position = 0;
  while (position < size) {
    const buffer = new Uint8Array(Math.min(64 * 1024, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
  }
}

/**
 * A database copied with `VACUUM INTO`. The project's database is opened as it
 * is, read-write and never created, exactly like its service opens it, and
 * NOT through an `openDatabase` of this repository: that one would switch its
 * journal mode, and a backup changes nothing in what it saves.
 */
function vacuumInto(source: string, target: string): void {
  rmSync(target, { force: true });
  const db = new Database(source, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

/**
 * What the data weighs, in apparent bytes of its regular files, and how many
 * folders and files it holds, from `lstat` alone. Run by the copy, as the
 * project, never by root. It stops at `maxEntries`.
 *
 * One folder's names are listed at a time, and those of the folders above it
 * kept until walked: Bun reads a folder whole whatever the call (the figures
 * are in projects.ts, isEmptyFolder), so the memory follows the biggest
 * folders along one path; names as strings, the lightest of its listings. A
 * folder of millions of names can exhaust the copy's MemoryMax: that
 * project's snapshot fails, said so, and the run goes on.
 *
 * Apparent bytes, not allocated blocks: the archive holds a sparse file's
 * holes as zeros, so the disk check counts them, and a hole cannot slip under
 * it. A file made sparse and huge once measured is the copy's budget's
 * business (copyData).
 */
export function measureData(dataDir: string, maxEntries: number = MAX_ENTRIES): { bytes: number; entries: number } {
  const top = lstatSync(dataDir);
  if (!top.isDirectory()) throw new CopyError("the data folder is not a folder");
  let bytes = 0;
  let entries = 0;
  const stack: { path: string; rel: string; names: string[]; next: number }[] = [];
  const enter = (path: string, rel: string) => {
    try {
      stack.push({ path, rel, names: readdirSync(path), next: 0 });
    } catch (error) {
      throw new CopyError(`a folder of the data cannot be read (${describeError(error)})`, rel || ".");
    }
  };
  enter(dataDir, "");
  while (stack.length > 0) {
    const level = stack[stack.length - 1]!;
    if (level.next >= level.names.length) {
      stack.pop();
      continue;
    }
    const name = level.names[level.next++]!;
    const path = join(level.path, name);
    const rel = level.rel === "" ? name : `${level.rel}/${name}`;
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") continue;
      throw new CopyError(`a file of the data cannot be examined (${describeError(error)})`, rel);
    }
    if (!stat.isDirectory() && !stat.isFile()) continue;
    // `data/` and the description take two entries of the archive.
    if (++entries > maxEntries - 2) throw tooManyEntries(maxEntries);
    if (stat.isFile()) bytes += stat.size;
    else enter(path, rel);
  }
  return { bytes, entries };
}

function tooManyEntries(maxEntries: number): CopyError {
  return new CopyError(`more than ${maxEntries} files and folders in the data: a snapshot of them could not be restored, so none is taken`);
}

/** The most the copy may archive: the measure and its margin, within the room the disk has. */
export function copyBudget(measured: number, room: number): number {
  return Math.min(room, measured + Math.max(GROWTH_FLOOR, Math.ceil(measured / 4)));
}

/** Removes the copies a previous, interrupted run may have left in the staging folder. */
export function cleanStaging(stagingDir: string): void {
  for (const name of readdirSync(stagingDir)) {
    if (name.startsWith(COPY_PREFIX)) rmSync(join(stagingDir, name), { force: true });
  }
}

export type CopyOptions = {
  /** The project's folder and the snapshot's time, written into the description, checked at extraction. */
  folder: string;
  takenAt: number;
  /** At most this many bytes of contents (copyBudget): beyond, the data grew during the copy. */
  maxBytes: number;
  /** At most this many entries in the archive, everything counted. */
  maxEntries?: number;
  /**
   * Every database copied as a plain file, with its `-wal` and `-journal`
   * beside it, rather than through `VACUUM INTO`. Only for the snapshot a
   * restore takes of the data it replaces, its services stopped, when a
   * database cannot be read consistently: see restore.ts. The description
   * says so.
   */
  raw?: boolean;
};

/**
 * Writes the archive of `dataDir` into `sink`, compressed. `stagingDir` takes
 * the database copies, one at a time, removed as soon as archived.
 */
export async function copyData(dataDir: string, stagingDir: string, sink: Sink, options: CopyOptions): Promise<CopySummary> {
  const top = lstatSync(dataDir);
  if (!top.isDirectory()) throw new CopyError("the data folder is not a folder");
  cleanStaging(stagingDir);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const raw = options.raw === true;

  const summary: CopySummary = { files: 0, directories: 0, databases: [], bytes: 0, skipped: [], changed: [] };
  const tar = new TarWriter(gzipSink(sink));
  let copies = 0;
  // `data/` and the description, counted from the start.
  let entries = 2;
  const count = () => {
    if (++entries > maxEntries) throw tooManyEntries(maxEntries);
  };
  const spend = (size: number, rel: string) => {
    if (summary.bytes + size > options.maxBytes) throw new CopyError("the data grew past its measured size while being copied: copy stopped", rel);
  };

  await tar.directory(DATA_ROOT, metaOf(top));

  async function walk(dir: string, relative: string): Promise<void> {
    let names: Buffer[];
    try {
      names = readdirSync(dir, { encoding: "buffer" });
    } catch (error) {
      throw new CopyError(`a folder of the data cannot be read (${describeError(error)})`, relative || ".");
    }
    names.sort(Buffer.compare);

    const entries: { name: string; path: string; rel: string; stat: Stats }[] = [];
    for (const raw of names) {
      let name: string;
      try {
        name = strict.decode(raw);
      } catch {
        const shown = raw.toString("latin1");
        summary.skipped.push({ path: relative === "" ? shown : `${relative}/${shown}`, reason: "file name is not valid UTF-8" });
        continue;
      }
      const path = join(dir, name);
      const rel = relative === "" ? name : `${relative}/${name}`;
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw new CopyError(`a file of the data cannot be examined (${describeError(error)})`, rel);
      }
      entries.push({ name, path, rel, stat });
    }

    const databases = new Set(raw ? [] : entries.filter((entry) => entry.stat.isFile() && isSqlite(entry.path)).map((entry) => entry.name));

    for (const { name, path, rel, stat } of entries) {
      const archived = `${DATA_ROOT}/${rel}`;
      if (stat.isDirectory()) {
        count();
        await tar.directory(archived, metaOf(stat));
        summary.directories++;
        await walk(path, rel);
        continue;
      }
      if (!stat.isFile()) {
        const reason = stat.isSymbolicLink() ? "symbolic link" : stat.isSocket() ? "socket" : stat.isFIFO() ? "named pipe" : "device or special file";
        summary.skipped.push({ path: rel, reason });
        continue;
      }
      const companion = SQLITE_COMPANIONS.find((suffix) => name.endsWith(suffix));
      if (companion !== undefined && databases.has(name.slice(0, -companion.length))) continue;

      count();
      if (databases.has(name)) {
        const copy = join(stagingDir, `${COPY_PREFIX}${copies++}.db`);
        try {
          vacuumInto(path, copy);
        } catch (error) {
          rmSync(copy, { force: true });
          throw new CopyError(`a database could not be copied (${describeError(error)})`, rel, "database");
        }
        try {
          const copied = await openFile(copy);
          try {
            spend(copied.stat.size, rel);
            await tar.file(archived, metaOf(stat), copied.stat.size, readExactly(copied.handle, copied.stat.size));
            summary.bytes += copied.stat.size;
          } finally {
            await copied.handle.close();
          }
        } finally {
          rmSync(copy, { force: true });
        }
        summary.databases.push(rel);
        summary.files++;
        continue;
      }

      // Opened first, and archived as what was opened. A service that writes a
      // file whole and renames it over the old one swaps the name between the
      // listing above and this read: the dashboard's collector does so with
      // state.json every minute. Either version is complete, and the one
      // opened is the one kept. Refused instead, it failed the dashboard's
      // whole snapshot on a fresh machine, measured on 6 October 2026.
      let opened: { handle: FileHandle; stat: Stats };
      try {
        opened = await openFile(path);
      } catch (error) {
        // Gone since it was listed, like a file gone before its lstat.
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw new CopyError(`a file of the data could not be read or archived (${describeError(error)})`, rel);
      }
      let outcome: Awaited<ReturnType<TarWriter["file"]>>;
      try {
        if (!opened.stat.isFile()) throw new CopyError("a file was replaced by something other than a file while being copied", rel);
        // Before a byte is read: a file grown to a terabyte stops the copy now, not in an hour.
        spend(opened.stat.size, rel);
        outcome = await tar.file(archived, metaOf(opened.stat), opened.stat.size, readExactly(opened.handle, opened.stat.size));
      } catch (error) {
        if (error instanceof CopyError) throw error;
        throw new CopyError(`a file of the data could not be read or archived (${describeError(error)})`, rel);
      } finally {
        await opened.handle.close();
      }
      if (outcome !== "exact") summary.changed.push(rel);
      summary.files++;
      summary.bytes += opened.stat.size;
    }
  }

  await walk(dataDir, "");

  const description = new TextEncoder().encode(
    `${JSON.stringify({ format: DESCRIPTION_FORMAT, folder: options.folder, takenAt: new Date(options.takenAt).toISOString(), raw, ...summary }, null, 2)}\n`,
  );
  await tar.file(DESCRIPTION_NAME, { mode: 0o600, mtime: Math.floor(options.takenAt / 1000), uid: 0, gid: 0 }, description.byteLength, description);
  await tar.end();
  return summary;
}
