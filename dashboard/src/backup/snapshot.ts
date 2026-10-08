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
 *
 * **Root does not measure the data.** It says how much room the disk has
 * above its reserve, and the copy, which alone sees the data, measures it and
 * refuses what would not fit (child.ts). The verdict reaches the status file
 * without a figure: the size of a project's tree is that project's business,
 * and the status file is world-readable.
 *
 * **Bounded in time, whatever the copy does.** The project's service shares
 * its uid with the copy and may stop it or slow it: past its time the copy is
 * killed and root moves on, and the read-back shares that same time. The
 * outcome says `timeout`, which the run uses to try the project again once
 * the others have had their turn (run.ts).
 *
 * **A service that keeps a live database runs its backup command first**
 * (hooks.ts), within the same time, and the copy archives what the command
 * left in place of the live folder. The room is measured once the commands
 * are done, their copies on the disk, and what they left is removed once the
 * snapshot is over, taken or not, at best and briefly (hooks.ts). A restore's
 * own snapshot runs none: the services are stopped, and their folders are
 * archived as files.
 */
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { snapshotName, type SnapshotKind } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { liveArgument } from "./child";
import { MAX_ENTRIES, type CopySummary } from "./copy";
import { entryPlace } from "./extract";
import { discardHooks, hooksFolder, liveFolders, projectHooks, runHooks, type Hook } from "./hooks";
import { freeBytes, type Project } from "./projects";
import { startChild, within, type Job } from "./runner";
import { shortError, syncFolder } from "./status";
import { ArchiveError, gunzip, readTar, type Limits, type ReadSummary } from "./tar";

/**
 * `cause`: `timeout` when the snapshot did not finish in its time, `database`
 * when a database could not be read consistently, which a restore works
 * around with a raw copy (restore.ts). Null for anything else.
 */
export type SnapshotOutcome =
  | { ok: true; name: string; bytes: number; summary: CopySummary; raw: boolean }
  | { ok: false; error: string; cause: "timeout" | "database" | null };

export type SnapshotOptions = {
  /** The time the copy and the read-back have, together. The configured child timeout by default. */
  timeoutMs?: number;
  /** The databases copied as files: only for a restore's own snapshot, its services stopped. */
  raw?: boolean;
  /**
   * The services are stopped: a restore's own snapshot. No backup command
   * runs, there is no server to ask; the live folders, declared or found,
   * are archived as files, nothing writing them, and named in the description.
   */
  stopped?: boolean;
};

/** How often, in bytes written, the free space is measured again. */
const CHECK_EVERY = 64 * 1024 * 1024;

/** How long a copy that ran out of time is still listened to, for the journal's sake. */
const REPORT_GRACE_MS = 2000;

export const TIMEOUT_ERROR = "the copy did not finish in its time, see the journal of sitesolide-backup";

/** The staging folder of a project's copy: under systemd, the copy unit's own CacheDirectory. */
export function staging(config: BackupConfig, folder: string): { path: string; cacheDirectory: string | null } {
  if (config.isolation === "systemd") return { path: `/var/cache/sitesolide-backup/${folder}`, cacheDirectory: `sitesolide-backup/${folder}` };
  return { path: join(config.stagingFolder, folder), cacheDirectory: null };
}

/**
 * Reads an archive back entirely, writing nothing: a damaged gzip, a header
 * that does not add up, a missing end, and it throws. So does an archive with
 * more entries than an extraction accepts, more bytes than `limits` allow, or
 * one still being read at `deadline` (a time of `Date.now()`): a gigabyte of
 * compressed zeros is a terabyte to read. And an entry the extraction would
 * refuse on its own (entryPlace): one outside `data/`, a description too big
 * to be read back.
 *
 * Not a path given twice, nor a file where a folder is needed, which the
 * extraction also refuses: telling them takes every path of the archive in
 * memory, and this runs in root's process, whose memory a project's tree must
 * never set (projects.ts). The copy never writes either, walking a real
 * folder whose names are unique; only a copy forged by its own project could,
 * against its own snapshots.
 */
export async function verifyArchive(
  path: string,
  limits: Limits = { maxEntries: MAX_ENTRIES, maxBytes: Number.MAX_SAFE_INTEGER },
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<ReadSummary> {
  // The file is local and never stalls: a look at the clock at every chunk is enough.
  const clocked = gunzip(Bun.file(path).stream() as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (Date.now() > deadline) controller.error(new ArchiveError("the archive could not be read back in time"));
        else controller.enqueue(chunk);
      },
    }),
  );
  return readTar(clocked, limits, async (entry) => {
    // Nothing kept: the contents are skipped by the reader.
    entryPlace(entry);
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
  options: SnapshotOptions = {},
): Promise<SnapshotOutcome> {
  const timeoutMs = options.timeoutMs ?? config.childTimeoutMs;
  // Real time, whatever clock the caller keeps: it bounds real waits.
  const deadline = Date.now() + timeoutMs;
  const raw = options.raw === true;
  const folder = join(config.backupFolder, project.folder);
  mkdirSync(config.backupFolder, { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });

  const name = snapshotName(project.folder, now, kind);
  const final = join(folder, name);
  try {
    statSync(final);
    return { ok: false, error: "a snapshot was already taken this very second", cause: null };
  } catch {
    // free: the expected case
  }

  const atReserve = (free: number): SnapshotOutcome => {
    log(`backup ${project.folder}: ${free} bytes free, under the reserve of ${config.reserveBytes}`);
    return { ok: false, error: "not enough disk space: the disk of the archives is at its reserve", cause: null };
  };
  const before = freeBytes(config.backupFolder);
  if (before - config.reserveBytes <= 0) return atReserve(before);

  const place = staging(config, project.folder);
  if (config.isolation === "none") mkdirSync(place.path, { recursive: true, mode: 0o700 });

  const stopped = options.stopped === true;
  let hooks: Hook[] = [];
  const declared = projectHooks(project, place.path);
  if ("error" in declared) {
    // A restore saves the data it replaces whatever its manifest says: as
    // files, which the copy does for a live folder with the services stopped.
    if (!stopped) {
      log(`backup ${project.folder}: ${declared.error}`);
      return { ok: false, error: declared.error, cause: null };
    }
    log(`backup ${project.folder}: ${declared.error}; the stopped data is saved as files`);
  } else {
    hooks = declared.hooks;
  }
  const commands = !stopped && hooks.length > 0;
  // What an earlier removal left, for a project that has since dropped its
  // command or not, goes too: looked at by its name alone, never opened.
  const leftover = lstatOrNull(hooksFolder(place.path)) !== null;
  try {
    if (commands) {
      const ran = await runHooks(config, project, hooks, deadline, place.cacheDirectory, log);
      if (!ran.ok) return ran;
    }
    // The room above the reserve, measured once the commands' copies are on
    // the disk. The copy needs it for a copy of the databases and an archive
    // at most as big as what it archives, and checks that.
    const free = commands ? freeBytes(config.backupFolder) : before;
    const room = free - config.reserveBytes;
    if (room <= 0) return atReserve(free);
    return await copySnapshot(config, project, { now, log, raw, stopped, deadline, room, folder, name, final, place, live: liveFolders(hooks, stopped) });
  } finally {
    if (commands || leftover) await discardHooks(config, project, place.path, place.cacheDirectory, log);
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

type CopyPlan = {
  now: number;
  log: (line: string) => void;
  raw: boolean;
  stopped: boolean;
  deadline: number;
  room: number;
  /** The project's folder of archives, the snapshot's name and its final path. */
  folder: string;
  name: string;
  final: string;
  place: { path: string; cacheDirectory: string | null };
  live: ReturnType<typeof liveFolders>;
};

/** The copy itself, streamed into a temporary file, read back, then named. */
async function copySnapshot(config: BackupConfig, project: Project, plan: CopyPlan): Promise<SnapshotOutcome> {
  const { now, log, raw, stopped, deadline, room, folder, name, final, place } = plan;
  const timeoutMs = Math.max(1000, deadline - Date.now());

  const job: Job = {
    mode: "copy",
    folder: project.folder,
    account: project.account,
    uid: project.owner?.uid ?? null,
    // The time to the second, as the name carries it: the description says the same.
    args: [
      project.dataDir,
      place.path,
      project.folder,
      String(Math.floor(now / 1000) * 1000),
      String(room),
      ...(raw ? ["raw"] : []),
      ...(stopped ? ["stopped"] : []),
      ...plan.live.map(liveArgument),
    ],
    readWrite: [project.dataDir],
    bind: [project.dataDir],
    cacheDirectory: place.cacheDirectory,
    stdin: null,
    stdout: "pipe",
    timeoutMs,
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
    let halted: string | null = null;
    let timedOut = false;
    for (;;) {
      const next = await within(reader.read(), deadline - Date.now());
      if (next === null) {
        timedOut = true;
        break;
      }
      const { done, value } = next.value;
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) offset += writeSync(fd, value, offset, value.byteLength - offset);
      written += value.byteLength;
      if (written >= nextCheck) {
        nextCheck += CHECK_EVERY;
        if (freeBytes(config.backupFolder) < config.reserveBytes) {
          halted = "stopped: the disk was about to fill";
          break;
        }
      }
    }
    if (timedOut || halted !== null) {
      // Closing our end makes the copy's next write fail; a stopped copy is killed.
      void reader.cancel().catch(() => undefined);
      if (timedOut) child.stop();
    }
    const finished = await within(child.result, timedOut ? REPORT_GRACE_MS : Math.max(deadline - Date.now(), REPORT_GRACE_MS));
    if (timedOut || finished === null) {
      child.stop();
      log(`backup ${project.folder}: the copy did not finish within ${Math.round(timeoutMs / 1000)} s, it was stopped`);
      return { ok: false, error: TIMEOUT_ERROR, cause: "timeout" };
    }
    if (halted !== null) return { ok: false, error: halted, cause: null };
    const { code, report } = finished.value;
    if (code !== 0 || report.summary === null) {
      log(
        `backup ${project.folder}: copy failed, exit code ${code}${report.path === null ? "" : `, at ${JSON.stringify(report.path)}`}${report.detail === null ? "" : `, ${report.detail}`}${report.tail === "" ? "" : `: ${report.tail}`}`,
      );
      return {
        ok: false,
        error: shortError(report.error ?? `the copy failed with exit code ${code}, see the journal of sitesolide-backup`),
        cause: report.code === "database" ? "database" : null,
      };
    }
    fsyncSync(fd);
    closeSync(fd);
    kept = true;

    try {
      // No more entries than an extraction accepts, no more bytes than the
      // room the copy was given, and within the time left.
      await verifyArchive(temporary, { maxEntries: MAX_ENTRIES, maxBytes: room }, deadline);
    } catch (error) {
      unlinkSync(temporary);
      log(`backup ${project.folder}: the archive does not read back: ${(error as Error).message}`);
      if (Date.now() > deadline) return { ok: false, error: TIMEOUT_ERROR, cause: "timeout" };
      return { ok: false, error: "the archive written does not read back, see the journal of sitesolide-backup", cause: null };
    }
    renameSync(temporary, final);
    syncFolder(folder);
    return { ok: true, name, bytes: written, summary: report.summary as unknown as CopySummary, raw };
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
