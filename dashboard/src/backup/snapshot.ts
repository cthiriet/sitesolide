/**
 * One snapshot of one project: the copy runs as the project (copy.ts, through
 * runner.ts), restic stores what it streams in the server's repository, and
 * root reads the stored snapshot back entirely before saying it was taken.
 *
 * **restic runs the copy itself** (`backup --stdin-from-command`), and keeps a
 * snapshot only if the copy's command line exits 0: a copy that fails, is
 * killed, or runs past its time leaves no snapshot, and neither does a restic
 * stopped by SIGTERM or SIGKILL (measured on 0.18.0 and 0.18.1). Fed through
 * a plain pipe instead, restic would store a truncated stream as a snapshot
 * the day root died before the copy ended: its documentation says it "cannot
 * detect if data read from stdin is complete or not".
 *
 * **Read back at once.** `restic dump` gives the stored tar back, and the
 * same reader as the extraction's goes through it: a snapshot reported taken
 * has been read back and accepted, which proves the restore's own path every
 * hour. One that does not read back is forgotten on the spot. The read back
 * also brings the archive's description, whose lists the copy cannot send
 * whole through restic (restic.ts).
 *
 * The repository is root's, 0700, its key 0600: the project's own account
 * never reads its backups, let alone another project's.
 *
 * The disk is watched while restic writes, every second. One disk carries
 * every site and its backups: a snapshot allowed to fill it would stop every
 * service, the very thing a backup exists to protect against.
 *
 * **Root does not measure the data.** It says how much room the disk has
 * above its reserve, and the copy, which alone sees the data, measures it and
 * refuses what would not fit twice (child.ts): still the honest worst case,
 * a first snapshot or a data folder rewritten whole. The verdict reaches the
 * status file without a figure: the size of a project's tree is that
 * project's business, and the status file is world-readable.
 *
 * **Bounded in time, whatever the copy does.** The project's service shares
 * its uid with the copy and may stop it or slow it: past its time the copy's
 * unit is killed by name, restic stopped, and root moves on; the read back
 * shares that same time. The outcome says `timeout`, which the run uses to
 * try the project again once the others have had their turn (run.ts).
 *
 * **A service that keeps a live database runs its backup command first**
 * (hooks.ts), within the same time, and the copy archives what the command
 * left in place of the live folder. The room is measured once the commands
 * are done, their copies on the disk, and what they left is removed once the
 * snapshot is over, taken or not, at best and briefly (hooks.ts). A restore's
 * own snapshot runs none: the services are stopped, and their folders are
 * archived as files.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { snapshotName, type SnapshotKind } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { liveArgument } from "./child";
import { MAX_ENTRIES, type CopySummary } from "./copy";
import { entryPlace } from "./extract";
import { discardHooks, hooksFolder, liveFolders, projectHooks, runHooks, type Hook } from "./hooks";
import { freeBytes, type Project } from "./projects";
import {
  backupArguments,
  commandFailed,
  commandLines,
  forgetByName,
  forgetSnapshots,
  localRepository,
  readBackupSummary,
  resticFailure,
  resticJournal,
  resticLines,
  snapshotPath,
  startRestic,
  watchCall,
  RESTIC_STOP_GRACE_MS,
} from "./restic";
import { preparedChild, readReport, within, type Job } from "./runner";
import { shortError } from "./status";
import { ArchiveError, readTar, type Limits, type ReadSummary } from "./tar";

/**
 * `cause`: `timeout` when the snapshot did not finish in its time, `database`
 * when a database could not be read consistently, which a restore works
 * around with a raw copy (restore.ts). Null for anything else.
 */
export type SnapshotOutcome =
  | {
      ok: true;
      name: string;
      /** restic's id of the snapshot, in the server's repository. */
      id: string;
      /** The size of the tar it holds, and what it added to the repository, as restic counted them. */
      bytes: number | null;
      added: number | null;
      /** What the copy said of the data, from the archive's own description. */
      summary: CopySummary;
      raw: boolean;
    }
  | {
      ok: false;
      error: string;
      cause: "timeout" | "database" | null;
      /** restic started, and left packs no snapshot uses: the run prunes them before it ends. */
      dirty?: boolean;
      /** Snapshots restic would not forget although unwanted: the run records them, keeps them out of everything, and forgets them later. */
      orphans?: string[];
    };

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
  /** The names the repository already holds: a second snapshot of the same second and kind is refused. */
  existing?: ReadonlySet<string>;
};

/** How long a copy that ran out of time is still listened to, for the journal's sake. */
const REPORT_GRACE_MS = 2000;

export const TIMEOUT_ERROR = "the copy did not finish in its time, see the journal of sitesolide-backup";

/** The copy stopped without saying why, its unit killed for one: restic reports its command's failure. */
export const COPY_STOPPED_ERROR = "the copy stopped before its end without saying why, see the journal of sitesolide-backup";

/** The staging folder of a project's copy: under systemd, the copy unit's own CacheDirectory. */
export function staging(config: BackupConfig, folder: string): { path: string; cacheDirectory: string | null } {
  if (config.isolation === "systemd") return { path: `/var/cache/sitesolide-backup/${folder}`, cacheDirectory: `sitesolide-backup/${folder}` };
  return { path: join(config.stagingFolder, folder), cacheDirectory: null };
}

/**
 * Reads an archive back entirely, a plain tar, writing nothing: a header that
 * does not add up, a missing end, and it throws. So does an archive with more
 * entries than an extraction accepts, more bytes than `limits` allow, or one
 * still being read at `deadline` (a time of `Date.now()`). And an entry the
 * extraction would refuse on its own (entryPlace): one outside `data/`, a
 * description too big to be read back. The description, if there is one, is
 * returned: it holds the copy's summary.
 *
 * Not a path given twice, nor a file where a folder is needed, which the
 * extraction also refuses: telling them takes every path of the archive in
 * memory, and this runs in root's process, whose memory a project's tree must
 * never set (projects.ts). The copy never writes either, walking a real
 * folder whose names are unique; only a copy forged by its own project could,
 * against its own snapshots.
 */
export async function verifyArchive(
  source: ReadableStream<Uint8Array>,
  limits: Limits = { maxEntries: MAX_ENTRIES, maxBytes: Number.MAX_SAFE_INTEGER },
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<ReadSummary & { description: Record<string, unknown> | null }> {
  let description: Record<string, unknown> | null = null;
  // A look at the clock at every chunk; a source that stops sending is the caller's to stop.
  const clocked = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (Date.now() > deadline) controller.error(new ArchiveError("the archive could not be read back in time"));
        else controller.enqueue(chunk);
      },
    }),
  );
  const read = await readTar(clocked, limits, async (entry, data) => {
    if (entryPlace(entry).kind !== "description") return;
    const chunks: Uint8Array[] = [];
    for await (const chunk of data) chunks.push(chunk);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(Bun.concatArrayBuffers(chunks))) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) description = parsed as Record<string, unknown>;
    } catch {
      // A description that does not read leaves the summary empty, nothing else.
    }
  });
  return { ...read, description };
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

  const name = snapshotName(project.folder, now, kind);
  if (options.existing?.has(name) === true) return { ok: false, error: "a snapshot was already taken this very second", cause: null };

  const atReserve = (free: number): SnapshotOutcome => {
    log(`backup ${project.folder}: ${free} bytes free, under the reserve of ${config.reserveBytes}`);
    return { ok: false, error: "not enough disk space: the disk of the repository is at its reserve", cause: null };
  };
  const before = freeBytes(config.repository);
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
    // the disk. The copy needs it for a copy of the databases and what restic
    // stores, at most as big as what it archives, and checks that.
    const free = commands ? freeBytes(config.repository) : before;
    const room = free - config.reserveBytes;
    if (room <= 0) return atReserve(free);
    return await copySnapshot(config, project, { kind, now, log, raw, stopped, deadline, room, name, place, live: liveFolders(hooks, stopped) });
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
  kind: SnapshotKind;
  now: number;
  log: (line: string) => void;
  raw: boolean;
  stopped: boolean;
  deadline: number;
  room: number;
  name: string;
  place: { path: string; cacheDirectory: string | null };
  live: ReturnType<typeof liveFolders>;
};

/** The copy itself, run by restic into the repository, then read back. */
async function copySnapshot(config: BackupConfig, project: Project, plan: CopyPlan): Promise<SnapshotOutcome> {
  const { kind, now, log, raw, stopped, deadline, room, name, place } = plan;
  const timeoutMs = Math.max(1000, deadline - Date.now());
  const repository = localRepository(config);
  const folder = project.folder;

  const job: Job = {
    mode: "copy",
    folder,
    account: project.account,
    uid: project.owner?.uid ?? null,
    // The time to the second, as the name carries it: the description says the same.
    args: [
      project.dataDir,
      place.path,
      folder,
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

  /**
   * Every failure once restic has started leaves packs no snapshot uses, which
   * the run prunes before it ends (`dirty`). A snapshot saved that is not
   * wanted is forgotten; one restic would not forget is handed back
   * (`orphans`), for the run to keep out of everything and forget later.
   */
  const failed = async (error: string, cause: "timeout" | "database" | null, unwanted: { id: string | null } | null = null): Promise<SnapshotOutcome> => {
    let orphans: string[] = [];
    if (unwanted !== null) {
      if (unwanted.id === null) orphans = await forgetByName(config, repository, folder, name, Date.now() + 60_000, log);
      else {
        const result = await forgetSnapshots(config, repository, [unwanted.id], Date.now() + 60_000, log);
        if (result !== null && result.code !== 0) {
          log(resticJournal(`backup ${folder}: restic forget of ${name}`, result));
          orphans = [unwanted.id];
        }
      }
    }
    return { ok: false, error, cause, dirty: true, ...(orphans.length === 0 ? {} : { orphans }) };
  };

  const child = preparedChild(job, config);
  const backup = startRestic(config, repository, [...backupArguments(folder, kind, now), ...child.command]);
  const watched = await watchCall(backup, deadline, () => freeBytes(config.repository) < config.reserveBytes, child.stop);
  if ("stopped" in watched) {
    const tail = watched.late === null ? "" : readReport(commandLines(watched.late.stderr)).tail;
    // restic may have been finishing as it was stopped: what it saved then goes.
    const saved = watched.late !== null && watched.late.code === 0 ? { id: readBackupSummary(watched.late.stdout)?.id ?? null } : null;
    if (watched.stopped === "disk") {
      log(`backup ${folder}: the snapshot was stopped, the disk came down to its reserve of ${config.reserveBytes} bytes${tail === "" ? "" : `: ${tail}`}`);
      return failed("stopped: the disk was about to fill", null, saved);
    }
    log(`backup ${folder}: the copy did not finish within ${Math.round(timeoutMs / 1000)} s, it was stopped${tail === "" ? "" : `: ${tail}`}`);
    return failed(TIMEOUT_ERROR, "timeout", saved);
  }

  const result = watched.ended;
  const report = readReport(commandLines(result.stderr));
  if (result.code !== 0) {
    if (report.error !== null) {
      log(
        `backup ${folder}: copy failed${report.path === null ? "" : `, at ${JSON.stringify(report.path)}`}${report.detail === null ? "" : `, ${report.detail}`}${report.tail === "" ? "" : `: ${report.tail}`}`,
      );
      return failed(shortError(report.error), report.code === "database" ? "database" : null);
    }
    log(`backup ${folder}: ${resticJournal("restic backup", { ...result, stderr: resticLines(result.stderr) })}${report.tail === "" ? "" : `; the copy said: ${report.tail}`}`);
    // The copy ended without its report, its unit killed for one: restic says
    // the command failed, which is the copy's failure, not restic's.
    if (result.code === 1 && commandFailed(result.stderr)) return failed(COPY_STOPPED_ERROR, null);
    return failed(resticFailure(result, repository), null);
  }
  const saved = readBackupSummary(result.stdout);
  if (saved === null) {
    log(`backup ${folder}: restic backup ended without naming the snapshot it saved; it is forgotten by its name`);
    return failed("the snapshot was not saved, see the journal of sitesolide-backup", null, { id: null });
  }
  // A copy that said nothing, its report lost: whatever restic saved is not trusted.
  if (report.summary === null) {
    log(`backup ${folder}: the copy ended without its report${report.tail === "" ? "" : `: ${report.tail}`}; the snapshot is forgotten`);
    return failed("the copy ended without its report, see the journal of sitesolide-backup", null, { id: saved.id });
  }

  // --- The read back
  const dump = startRestic(config, repository, ["dump", saved.id, snapshotPath(folder)], { stdout: "stream" });
  let failure: string | null = null;
  let description: Record<string, unknown> | null = null;
  try {
    // No more entries than an extraction accepts, no more bytes than the
    // room the copy was given, and within the time left.
    const read = await within(verifyArchive(dump.stdout!, { maxEntries: MAX_ENTRIES, maxBytes: room }, deadline), Math.max(0, deadline - Date.now()) + REPORT_GRACE_MS);
    if (read === null) failure = "the archive could not be read back in time";
    else description = read.value.description;
  } catch (error) {
    failure = (error as Error).message;
  }
  if (failure !== null) dump.stop();
  const dumped = await within(dump.result, failure === null ? Math.max(deadline - Date.now(), REPORT_GRACE_MS) : REPORT_GRACE_MS + RESTIC_STOP_GRACE_MS);
  if (failure === null && (dumped === null || dumped.value.code !== 0)) {
    failure = dumped === null ? "restic dump did not finish in time" : resticJournal("restic dump", dumped.value);
    dump.stop();
  }
  if (failure !== null) {
    log(`backup ${folder}: the snapshot does not read back: ${failure}; it is forgotten`);
    if (Date.now() > deadline) return failed(TIMEOUT_ERROR, "timeout", { id: saved.id });
    return failed("the snapshot written does not read back, see the journal of sitesolide-backup", null, { id: saved.id });
  }
  return { ok: true, name, id: saved.id, bytes: saved.bytes, added: saved.added, summary: summaryOf(description), raw };
}

/** The copy's summary, from the archive's description: empty lists for an archive that carries none. */
function summaryOf(description: Record<string, unknown> | null): CopySummary {
  const d = description ?? {};
  const list = (key: string) => (Array.isArray(d[key]) ? (d[key] as never[]) : []);
  const number = (key: string) => (typeof d[key] === "number" ? (d[key] as number) : 0);
  return {
    files: number("files"),
    directories: number("directories"),
    databases: list("databases"),
    bytes: number("bytes"),
    skipped: list("skipped"),
    changed: list("changed"),
    fromBackupCommand: list("fromBackupCommand"),
    liveAsFiles: list("liveAsFiles"),
    counts: typeof d.counts === "object" && d.counts !== null ? (d.counts as CopySummary["counts"]) : { databases: 0, skipped: 0, changed: 0, fromBackupCommand: 0, liveAsFiles: 0 },
  };
}
