/**
 * The extraction of a snapshot into a fresh folder, run AS THE PROJECT whose
 * data it is, like the copy (copy.ts): the files come out owned by
 * `site-<slug>` with nothing to `chown`, and a flaw in the reading of a forged
 * archive yields the project's own rights, not root's.
 *
 * The archive arrives on standard input, compressed. Everything it holds is
 * checked by the reader (tar.ts) before a byte is written; on top of that,
 * here:
 *
 * - only `data/` and the description are accepted, nothing beside them;
 * - every file is created with `O_EXCL | O_NOFOLLOW`: nothing is overwritten,
 *   no link is followed, and the same path twice refuses the archive;
 * - a parent folder is created by this process or refused: never one found in
 *   place, which could be a link planted between two entries;
 * - the destination must be an empty folder;
 * - a description of format 2 or later must name the project and the time of
 *   the snapshot asked for. A snapshot is bound to its name by nothing else
 *   on the server's disk, and an archive of another project copied under
 *   this one's name would hand its data to the wrong service. It is the last
 *   entry: the check refuses the archive once its files are written, into a
 *   folder the restore then deletes, before anything is stopped.
 *
 * A refusal leaves a half-filled folder that the restore deletes: the data in
 * service has not been touched yet at that point.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, DESCRIPTION_NAME } from "./copy";
import { syncFolder } from "./status";
import { ArchiveError, gunzip, quoted, readTar, type Limits } from "./tar";

export type ExtractSummary = {
  files: number;
  directories: number;
  bytes: number;
  /** The archive's own description, if it had one: archives made by hand may not. */
  description: Record<string, unknown> | null;
};

/** A description bigger than this is not one of ours. */
const MAX_DESCRIPTION_BYTES = 1024 * 1024;

/** The snapshot an extraction was asked for: its project's folder and its time, to the second. */
export type Expected = { folder: string; takenAt: number };

/**
 * Why a description does not match the snapshot asked for, or null. A
 * description of format 1, or none, names neither and is not judged: those
 * archives were written before the check, or by hand.
 */
export function descriptionMismatch(description: Record<string, unknown>, expected: Expected): string | null {
  if (typeof description.format !== "number" || description.format < 2) return null;
  if (description.folder !== expected.folder) return "the archive is a snapshot of another site than the one being restored";
  const takenAt = typeof description.takenAt === "string" ? Date.parse(description.takenAt) : Number.NaN;
  if (!Number.isFinite(takenAt) || Math.floor(takenAt / 1000) !== Math.floor(expected.takenAt / 1000)) {
    return "the archive was taken at another time than its name says";
  }
  return null;
}

export async function extractData(source: ReadableStream<Uint8Array>, destination: string, limits: Limits, expected: Expected | null = null): Promise<ExtractSummary> {
  const top = lstatSync(destination);
  if (!top.isDirectory()) throw new ArchiveError("the destination is not a folder");
  if (readdirSync(destination).length > 0) throw new ArchiveError("the destination folder is not empty");

  const summary: ExtractSummary = { files: 0, directories: 0, bytes: 0, description: null };
  /** Every path made here, folders and files: a second entry for one of them refuses the archive. */
  const made = new Map<string, "file" | "directory">();
  /** Folders and the mode and time their entry asked for, applied at the end, deepest first. */
  const folders: { path: string; mode: number; mtime: number }[] = [];

  function makeFolder(relative: string): void {
    const known = made.get(relative);
    if (known === "directory") return;
    if (known === "file") throw new ArchiveError(`a file and a folder share a path: ${quoted(relative)}`);
    const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : null;
    if (parent !== null) makeFolder(parent);
    try {
      mkdirSync(join(destination, relative), { mode: 0o700 });
    } catch (error) {
      // Found in place rather than made here: not to be trusted.
      if ((error as { code?: string }).code === "EEXIST") throw new ArchiveError(`unexpected entry in the destination: ${quoted(relative)}`);
      throw error;
    }
    made.set(relative, "directory");
  }

  await readTar(gunzip(source), limits, async (entry, data) => {
    if (entry.path === DESCRIPTION_NAME && entry.type === "file") {
      if (entry.size > MAX_DESCRIPTION_BYTES) throw new ArchiveError("the archive's description is too large");
      const chunks: Uint8Array[] = [];
      for await (const chunk of data) chunks.push(chunk);
      try {
        const parsed = JSON.parse(new TextDecoder().decode(Bun.concatArrayBuffers(chunks))) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) summary.description = parsed as Record<string, unknown>;
      } catch {
        // A description that does not read is not a reason to refuse the data.
      }
      const mismatch = summary.description === null || expected === null ? null : descriptionMismatch(summary.description, expected);
      if (mismatch !== null) throw new ArchiveError(mismatch);
      return;
    }
    if (entry.path === DATA_ROOT && entry.type === "directory") return;
    if (!entry.path.startsWith(`${DATA_ROOT}/`)) throw new ArchiveError(`entry outside ${DATA_ROOT}/ in the archive: ${quoted(entry.path)}`);
    const relative = entry.path.slice(DATA_ROOT.length + 1);

    if (entry.type === "directory") {
      makeFolder(relative);
      folders.push({ path: relative, mode: entry.mode, mtime: entry.mtime });
      summary.directories++;
      return;
    }

    if (made.has(relative)) throw new ArchiveError(`the same path twice in the archive: ${quoted(relative)}`);
    if (relative.includes("/")) makeFolder(relative.slice(0, relative.lastIndexOf("/")));
    const fd = openSync(join(destination, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    made.set(relative, "file");
    try {
      for await (const chunk of data) {
        let written = 0;
        while (written < chunk.byteLength) written += writeSync(fd, chunk, written, chunk.byteLength - written);
      }
      fchmodSync(fd, entry.mode & 0o777);
      futimesSync(fd, entry.mtime, entry.mtime);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    summary.files++;
    summary.bytes += entry.size;
  });

  // Deepest first: setting a folder's time and then writing into it would move
  // the time again. The owner keeps the right to go through its own folders.
  for (const folder of folders.sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
    const path = join(destination, folder.path);
    const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new ArchiveError(`unexpected entry in the destination: ${quoted(folder.path)}`);
    // Through a descriptor opened without following a link: the mode lands on
    // the folder made here, or nowhere.
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fchmodSync(fd, (folder.mode & 0o777) | 0o700);
    } finally {
      closeSync(fd);
    }
    utimesSync(path, folder.mtime, folder.mtime);
  }
  syncFolder(destination);
  return summary;
}
