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
 * - every other regular file as it is, read once, exactly the size `lstat`
 *   gave: a file that changes meanwhile is padded or cut, as `tar` does, and
 *   the summary says so;
 * - folders as folders, empty ones included;
 * - symbolic links, sockets, pipes and devices are left out and named in the
 *   summary: a link restored as root could point anywhere.
 *
 * The archive holds `data/` and, last, `sitesolide-backup.json`, which says
 * what was copied and what was left out. `tar -xzf` gives back `data/`.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, statSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { TarWriter, gzipSink, type EntryMeta, type Sink } from "./tar";

/** The first 16 bytes of every SQLite 3 database. */
export const SQLITE_HEADER = "SQLite format 3\u0000";

/** The files SQLite keeps beside a database, which its copy already holds. */
export const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"];

/** The archive's top folder, and the description that ends it. */
export const DATA_ROOT = "data";
export const DESCRIPTION_NAME = "sitesolide-backup.json";

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

/** Exactly `size` bytes of a file, or fewer if it shrank, in chunks of 64 KiB. */
async function* readExactly(path: string, expected: Stats, size: number): AsyncGenerator<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const seen = fstatSync(handle.fd);
    // What is read is the file that was looked at, not one swapped in since.
    if (seen.ino !== expected.ino || seen.dev !== expected.dev) throw new CopyError("a file was replaced while being copied");
    let position = 0;
    while (position < size) {
      const buffer = new Uint8Array(Math.min(64 * 1024, size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
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

/** Removes the copies a previous, interrupted run may have left in the staging folder. */
export function cleanStaging(stagingDir: string): void {
  for (const name of readdirSync(stagingDir)) {
    if (name.startsWith(COPY_PREFIX)) rmSync(join(stagingDir, name), { force: true });
  }
}

/**
 * Writes the archive of `dataDir` into `sink`, compressed. `stagingDir` takes
 * the database copies, one at a time, removed as soon as archived.
 */
export async function copyData(dataDir: string, stagingDir: string, sink: Sink, now: number = Date.now()): Promise<CopySummary> {
  const top = lstatSync(dataDir);
  if (!top.isDirectory()) throw new CopyError("the data folder is not a folder");
  cleanStaging(stagingDir);

  const summary: CopySummary = { files: 0, directories: 0, databases: [], bytes: 0, skipped: [], changed: [] };
  const tar = new TarWriter(gzipSink(sink));
  let copies = 0;

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

    const databases = new Set(entries.filter((entry) => entry.stat.isFile() && isSqlite(entry.path)).map((entry) => entry.name));

    for (const { name, path, rel, stat } of entries) {
      const archived = `${DATA_ROOT}/${rel}`;
      if (stat.isDirectory()) {
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

      if (databases.has(name)) {
        const copy = join(stagingDir, `${COPY_PREFIX}${copies++}.db`);
        try {
          vacuumInto(path, copy);
        } catch (error) {
          rmSync(copy, { force: true });
          throw new CopyError(`a database could not be copied (${describeError(error)})`, rel);
        }
        try {
          const copied = statSync(copy);
          await tar.file(archived, metaOf(stat), copied.size, readExactly(copy, copied, copied.size));
          summary.bytes += copied.size;
        } finally {
          rmSync(copy, { force: true });
        }
        summary.databases.push(rel);
        summary.files++;
        continue;
      }

      let outcome: Awaited<ReturnType<TarWriter["file"]>>;
      try {
        outcome = await tar.file(archived, metaOf(stat), stat.size, readExactly(path, stat, stat.size));
      } catch (error) {
        if (error instanceof CopyError) throw new CopyError(error.message, rel);
        throw new CopyError(`a file of the data could not be read or archived (${describeError(error)})`, rel);
      }
      if (outcome !== "exact") summary.changed.push(rel);
      summary.files++;
      summary.bytes += stat.size;
    }
  }

  await walk(dataDir, "");

  const description = new TextEncoder().encode(
    `${JSON.stringify({ format: 1, takenAt: new Date(now).toISOString(), ...summary }, null, 2)}\n`,
  );
  await tar.file(DESCRIPTION_NAME, { mode: 0o600, mtime: Math.floor(now / 1000), uid: 0, gid: 0 }, description.byteLength, description);
  await tar.end();
  return summary;
}
