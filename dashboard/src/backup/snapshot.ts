/**
 * One snapshot of one project: the copy runs as the project (copy.ts, through
 * runner.ts), root writes what it streams into a temporary file beside the
 * final name, reads the whole archive back, and only then gives it its name.
 *
 * A snapshot that exists under its name is therefore complete and readable:
 * a run cut in the middle leaves a temporary file, never a short archive that
 * a restore would trust. The archives are root's, 0600, in a 0700 folder: the
 * project's own account never reads its backups, let alone another project.
 *
 * The disk is watched while the archive grows. One disk carries every site and
 * its backups: an archive allowed to fill it would stop every service, the
 * very thing a backup exists to protect against.
 */
import { closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { snapshotName, type SnapshotKind } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import type { CopySummary } from "./copy";
import { freeBytes, measure, type Project } from "./projects";
import { startChild, type Job } from "./runner";
import { shortError, syncFolder } from "./status";
import { gunzip, readTar } from "./tar";

export type SnapshotOutcome = { ok: true; name: string; bytes: number; summary: CopySummary } | { ok: false; error: string };

/** How often, in bytes written, the free space is measured again. */
const CHECK_EVERY = 64 * 1024 * 1024;

/** The staging folder of a project's copy: under systemd, the copy unit's own CacheDirectory. */
export function staging(config: BackupConfig, folder: string): { path: string; cacheDirectory: string | null } {
  if (config.isolation === "systemd") return { path: `/var/cache/sitesolide-backup/${folder}`, cacheDirectory: `sitesolide-backup/${folder}` };
  return { path: join(config.stagingFolder, folder), cacheDirectory: null };
}

/**
 * Reads an archive back entirely, writing nothing: a damaged gzip, a header
 * that does not add up, a missing end, and it throws.
 */
export async function verifyArchive(path: string): Promise<{ entries: number; bytes: number }> {
  return readTar(gunzip(Bun.file(path).stream() as ReadableStream<Uint8Array>), { maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }, async () => {
    // Nothing kept: the contents are skipped by the reader.
  });
}

/**
 * The outcome's error names no file inside the data and quotes no stack: it
 * reaches the status file, which an unprivileged monitor reads. What would
 * locate the problem goes to `log`, the unit's journal, root's.
 */
export async function takeSnapshot(
  config: BackupConfig,
  project: Project,
  kind: SnapshotKind,
  now: number,
  log: (line: string) => void = () => undefined,
): Promise<SnapshotOutcome> {
  const folder = join(config.backupFolder, project.folder);
  mkdirSync(config.backupFolder, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });

  const name = snapshotName(project.folder, now, kind);
  const final = join(folder, name);
  try {
    statSync(final);
    return { ok: false, error: "a snapshot was already taken this very second" };
  } catch {
    // free: the expected case
  }

  // Room for a copy of the databases and an archive at most as big as the data.
  const needed = 2 * measure(project.dataDir) + config.reserveBytes;
  const free = freeBytes(config.backupFolder);
  if (free < needed) {
    return { ok: false, error: `not enough disk space: ${Math.round(free / 1048576)} MB free, ${Math.round(needed / 1048576)} MB needed` };
  }

  const place = staging(config, project.folder);
  if (config.isolation === "none") mkdirSync(place.path, { recursive: true, mode: 0o700 });

  const job: Job = {
    mode: "copy",
    folder: project.folder,
    account: project.account,
    uid: project.owner?.uid ?? null,
    args: [project.dataDir, place.path],
    readWrite: [project.dataDir],
    bind: [project.dataDir],
    cacheDirectory: place.cacheDirectory,
    stdin: null,
    stdout: "pipe",
  };

  const temporary = join(folder, `.${name}.${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let kept = false;
  try {
    fchmodSync(fd, 0o600);
    const child = startChild(job, config);
    const reader = child.stdout!.getReader();
    let written = 0;
    let nextCheck = CHECK_EVERY;
    let stopped: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) offset += writeSync(fd, value, offset, value.byteLength - offset);
      written += value.byteLength;
      if (written >= nextCheck) {
        nextCheck += CHECK_EVERY;
        if (freeBytes(config.backupFolder) < config.reserveBytes) {
          stopped = "stopped: the disk was about to fill";
          // Closing our end makes the copy's next write fail: it stops by itself.
          await reader.cancel();
          break;
        }
      }
    }
    const { code, report } = await child.result;
    if (stopped !== null) return { ok: false, error: stopped };
    if (code !== 0 || report.summary === null) {
      log(`backup ${project.folder}: copy failed, exit code ${code}${report.path === null ? "" : `, at ${JSON.stringify(report.path)}`}${report.tail === "" ? "" : `: ${report.tail}`}`);
      return { ok: false, error: shortError(report.error ?? `the copy failed with exit code ${code}, see the journal of sitesolide-backup`) };
    }
    fsyncSync(fd);
    closeSync(fd);
    kept = true;

    try {
      await verifyArchive(temporary);
    } catch (error) {
      unlinkSync(temporary);
      log(`backup ${project.folder}: the archive does not read back: ${(error as Error).message}`);
      return { ok: false, error: "the archive written does not read back, see the journal of sitesolide-backup" };
    }
    renameSync(temporary, final);
    syncFolder(folder);
    return { ok: true, name, bytes: written, summary: report.summary as unknown as CopySummary };
  } finally {
    if (!kept) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    rmSync(temporary, { force: true });
  }
}
