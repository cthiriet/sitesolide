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
 *   summary: a link restored as root could point anywhere;
 * - a folder a service keeps live, declared by its `backup` in the manifest,
 *   is never archived as it is: what its backup command left in its staging
 *   folder is archived in its place, under the same name (hooks.ts);
 * - a server database running on files of the data that no service declares,
 *   PostgreSQL or MongoDB, fails the copy: archived file by file while it
 *   writes, it would give a snapshot no server starts from (runningServer).
 *
 * **The substitution is written here, not mounted.** The copy's unit could
 * bind the staging folder read-only over `data/<folder>` and walk as before.
 * It does not: the copy must know the declared folders anyway, to tell them
 * from an undeclared server and to name them in the description; a bind
 * would need its mount point to exist in the project's data, created by
 * systemd as root when it does not; and it would only exist under systemd,
 * so the workstation's tests, which run this very code with no isolation,
 * would never see what the archive holds in production. Here, the walk meets
 * the declared folder and archives the staging folder under its name, the
 * same way on both.
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
  /** Folders of the data archived from what a service's backup command left, never from their live files. */
  fromBackupCommand: string[];
  /** Folders a database server keeps, archived as files because the services were stopped: a restore's own snapshot. */
  liveAsFiles: string[];
  /** How many of each there were: a list stops at LISTED_BYTES, its count does not. */
  counts: Record<Listed, number>;
};

/** The lists of a summary, each bounded, each counted in full. */
export type Listed = "databases" | "skipped" | "changed" | "fromBackupCommand" | "liveAsFiles";

/**
 * What a summary lists of each kind, at most, in bytes of JSON: beyond, a
 * name is counted and not listed. The extraction refuses a description over
 * 1 MiB (extract.ts, MAX_DESCRIPTION_BYTES), and the summary also travels in
 * the copy's report, whose last 256 KiB alone are read (runner.ts): five
 * lists of this size stay far below both, whatever a project's tree holds.
 * Measured on 8 October 2026: 16,000 symbolic links in one folder, all named
 * in the description, made it 1.1 MiB, a snapshot taken that no restore
 * would take.
 */
export const LISTED_BYTES = 16 * 1024;

/**
 * A folder of the data a service keeps live, from its manifest's `backup`:
 * `source`, the folder its backup command filled, archived in its place, or
 * null when the services are stopped and the folder is archived as it is.
 */
export type LiveFolder = { folder: string; source: string | null };

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
    /**
     * `database`: a database could not be read consistently, which a restore
     * may work around (restore.ts). `live-database`: a server database runs
     * on files of the data that no service declares.
     */
    readonly code: "database" | "live-database" | null = null,
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
export function measureData(dataDir: string, maxEntries: number = MAX_ENTRIES, skip: ReadonlySet<string> = new Set()): { bytes: number; entries: number } {
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
    // A live folder archived from its backup command's copy: that copy is measured instead.
    if (skip.has(rel)) continue;
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

/**
 * What the archive will weigh: the data without the live folders a backup
 * command saved, plus the copies those commands left, each archived as one
 * folder more. The disk check compares this with the room, and the copy
 * stops past it, as for any data (copyBudget). The staging folders are
 * already on the disk when root measures its room, after the commands ran.
 */
export function measureCopy(dataDir: string, live: readonly LiveFolder[], maxEntries: number = MAX_ENTRIES): { bytes: number; entries: number } {
  const substituted = live.filter((entry): entry is { folder: string; source: string } => entry.source !== null);
  const measured = measureData(dataDir, maxEntries, new Set(substituted.map((entry) => entry.folder)));
  let { bytes, entries } = measured;
  for (const { folder, source } of substituted) {
    let copy: { bytes: number; entries: number };
    try {
      copy = measureData(source, maxEntries);
    } catch (error) {
      if (error instanceof CopyError) throw new CopyError(`the copy a backup command left cannot be read (${error.message})`, folder);
      throw error;
    }
    bytes += copy.bytes;
    entries += copy.entries + 1;
    if (entries > maxEntries - 2) throw tooManyEntries(maxEntries);
  }
  return { bytes, entries };
}

/**
 * Does a server database run on the files of this folder? PostgreSQL leaves
 * `postmaster.pid` beside `PG_VERSION` while its server runs and removes it
 * when it stops cleanly; MongoDB's `mongod.lock`, beside `WiredTiger`, holds
 * the server's pid while it runs and is emptied when it stops. Archived file
 * by file while the server writes, such a folder gives a snapshot that
 * reports success and may not start, or start corrupt: the copy refuses it,
 * unless a service declares it with its backup command.
 *
 * The two servers whose markers this repository knows, not every one: any
 * other server keeps the same need, and the same answer, a `backup` in its
 * service's manifest (docs/manifest.md).
 */
export function runningServer(entries: readonly { name: string; stat: Stats }[]): "PostgreSQL" | "MongoDB" | null {
  const file = (name: string) => entries.find((entry) => entry.name === name && entry.stat.isFile())?.stat ?? null;
  if (file("PG_VERSION") !== null && file("postmaster.pid") !== null) return "PostgreSQL";
  const lock = file("mongod.lock");
  if (file("WiredTiger") !== null && lock !== null && lock.size > 0) return "MongoDB";
  return null;
}

/** What the status file says of an undeclared server: no folder named, the way out given. */
export function undeclaredServer(kind: string): string {
  return `a running ${kind} keeps its files in the data, which a copy file by file would archive unusable: declare a backup command for its service, see docs/manifest.md`;
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
  /**
   * The folders the services keep live, from their manifest's `backup`: each
   * archived from what its backup command left, never from its live files.
   */
  live?: readonly LiveFolder[];
  /**
   * The services are stopped: the snapshot a restore takes of the data it
   * replaces. No server writes, so a live folder, declared or found, is
   * archived as files, and named in the description; none is refused.
   */
  stopped?: boolean;
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
  const stopped = options.stopped === true;
  const live = new Map((options.live ?? []).map((entry) => [entry.folder, entry.source]));
  /** The live folders already archived, from their command's copy or as files. */
  const archivedLive = new Set<string>();

  const summary: CopySummary = {
    files: 0,
    directories: 0,
    databases: [],
    bytes: 0,
    skipped: [],
    changed: [],
    fromBackupCommand: [],
    liveAsFiles: [],
    counts: { databases: 0, skipped: 0, changed: 0, fromBackupCommand: 0, liveAsFiles: 0 },
  };
  const listedBytes: Record<Listed, number> = { databases: 2, skipped: 2, changed: 2, fromBackupCommand: 2, liveAsFiles: 2 };
  const list = <K extends Listed>(name: K, item: CopySummary[K][number]) => {
    summary.counts[name]++;
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (listedBytes[name] + size > LISTED_BYTES) return;
    listedBytes[name] += size;
    (summary[name] as unknown[]).push(item);
  };
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

  /**
   * The folder a backup command filled, archived as `data/<folder>`: its own
   * mode and owner, the project's, 0700 as the staging folder is made, which
   * PostgreSQL requires of a cluster it starts on once restored.
   */
  async function substitute(source: string, folder: string): Promise<void> {
    let stat: Stats;
    try {
      stat = lstatSync(source);
    } catch (error) {
      throw new CopyError(`the copy a backup command left cannot be read (${describeError(error)})`, folder);
    }
    if (!stat.isDirectory()) throw new CopyError("the copy a backup command left is not a folder", folder);
    count();
    await tar.directory(`${DATA_ROOT}/${folder}`, metaOf(stat));
    summary.directories++;
    archivedLive.add(folder);
    list("fromBackupCommand", folder);
    await walk(source, folder, false);
  }

  /**
   * `inData`: the data's own tree, where a declared folder is substituted and
   * a running server refused. False inside a backup command's copy or a live
   * folder archived as files: their insides are taken as they are.
   */
  async function walk(dir: string, relative: string, inData = true): Promise<void> {
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
        list("skipped", { path: relative === "" ? shown : `${relative}/${shown}`, reason: "file name is not valid UTF-8" });
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

    let below = inData;
    const server = inData ? runningServer(entries) : null;
    if (server !== null) {
      // Its services stopped, a restore saves the data it replaces as it is:
      // nothing writes it. Otherwise, the files of a running server are
      // refused rather than archived in a state no server starts from.
      if (!stopped) throw new CopyError(undeclaredServer(server), relative || ".", "live-database");
      list("liveAsFiles", relative || ".");
      below = false;
    }

    const databases = new Set(raw ? [] : entries.filter((entry) => entry.stat.isFile() && isSqlite(entry.path)).map((entry) => entry.name));

    for (const { name, path, rel, stat } of entries) {
      const archived = `${DATA_ROOT}/${rel}`;
      if (below && live.has(rel)) {
        const source = live.get(rel)!;
        if (source !== null) {
          // Whatever the live entry is, its command's copy stands for it.
          await substitute(source, rel);
          continue;
        }
        if (!stopped) throw new CopyError("a service's backup command did not run before the copy", rel);
        if (stat.isDirectory()) {
          count();
          await tar.directory(archived, metaOf(stat));
          summary.directories++;
          archivedLive.add(rel);
          list("liveAsFiles", rel);
          await walk(path, rel, false);
          continue;
        }
      }
      if (stat.isDirectory()) {
        count();
        await tar.directory(archived, metaOf(stat));
        summary.directories++;
        await walk(path, rel, below);
        continue;
      }
      if (!stat.isFile()) {
        const reason = stat.isSymbolicLink() ? "symbolic link" : stat.isSocket() ? "socket" : stat.isFIFO() ? "named pipe" : "device or special file";
        list("skipped", { path: rel, reason });
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
        list("databases", rel);
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
      if (outcome !== "exact") list("changed", rel);
      summary.files++;
      summary.bytes += opened.stat.size;
    }
  }

  await walk(dataDir, "");

  // A declared folder the walk did not meet, missing from the live data, is
  // archived all the same: the command's copy is what the snapshot is for.
  // Its parents must be folders, or nothing: the extraction would refuse a
  // folder under a file, and a snapshot is never reported that a restore refuses.
  for (const [folder, source] of live) {
    if (source === null || archivedLive.has(folder)) continue;
    const parts = folder.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/");
      let stat: Stats | null = null;
      try {
        stat = lstatSync(join(dataDir, parent));
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw new CopyError(`a file of the data cannot be examined (${describeError(error)})`, parent);
      }
      if (stat !== null && !stat.isDirectory()) throw new CopyError("a folder a backup command saves is not reached through plain folders of the data", folder);
    }
    await substitute(source, folder);
  }

  const description = new TextEncoder().encode(
    `${JSON.stringify({ format: DESCRIPTION_FORMAT, folder: options.folder, takenAt: new Date(options.takenAt).toISOString(), raw, stopped, ...summary }, null, 2)}\n`,
  );
  await tar.file(DESCRIPTION_NAME, { mode: 0o600, mtime: Math.floor(options.takenAt / 1000), uid: 0, gid: 0 }, description.byteLength, description);
  await tar.end();
  return summary;
}
