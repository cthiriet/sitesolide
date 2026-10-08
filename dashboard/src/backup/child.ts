/**
 * The modes that run in a transient unit of their own (runner.ts):
 *
 *   copy      as the project: measures its data folder, then writes its
 *             archive on standard output, within the room root says the disk has
 *   extract   as the project: reads an archive on standard input into a fresh folder
 *   measure   as the project: what its data folder weighs, for a restore
 *   download  as a dynamic user, with the network: a bucket's copy, decrypted,
 *             on standard output
 *   hook      as the project, in its service's walls: the service's backup
 *             command, which fills an empty folder with a consistent copy
 *   discard   as the project: removes what the backup commands left
 *
 * Each reports on standard error, one JSON line, and exits 0 only when it is
 * done.
 *
 * Before anything, each checks who it runs as. PID 1 sets the identity, and
 * this check costs nothing: a copy that found itself running as root would
 * create root-owned files in a project's folder and break its service.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Subprocess } from "bun";
import { isBackupFolder, readSnapshotName } from "../../borrowed/backups";
import { isDataFolder } from "../../borrowed/manifest";
import { CopyError, MAX_ENTRIES, copyBudget, copyData, measureCopy, measureData, type LiveFolder } from "./copy";
import { extractData } from "./extract";
import { objectKey, offsiteFrom, openBucket, redact } from "./offsite";
import type { Sink } from "./tar";

export type ChildEnvironment = Record<string, string | undefined>;

function emit(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/** The identity the parent expects, checked; a message if it is not the one. */
export function identityRefusal(env: ChildEnvironment, uid: number | undefined = process.getuid?.()): string | null {
  const expected = env.BACKUP_EXPECTED_UID;
  if (expected === undefined || expected === "") return null;
  if (!/^[0-9]+$/.test(expected)) return "BACKUP_EXPECTED_UID is not a uid";
  if (uid !== Number(expected)) return `running as uid ${uid}, not the project's ${expected}: refused`;
  return null;
}

/** Standard output as a sink, waiting for the reader: memory stays bounded whatever the archive's size. */
function stdoutSink(): Sink {
  const writer = Bun.stdout.writer({ highWaterMark: 1024 * 1024 });
  return {
    async write(bytes) {
      writer.write(bytes);
      await writer.flush();
    },
    async close() {
      await writer.end();
    },
  };
}

function isCount(text: string | undefined): text is string {
  return text !== undefined && /^[0-9]{1,16}$/.test(text);
}

function emitFailure(error: unknown, what: string): void {
  // The message names no file; the path goes apart, for the journal alone.
  if (error instanceof CopyError) emit({ event: "error", message: error.message, path: error.path, ...(error.code === null ? {} : { code: error.code }) });
  else emit({ event: "error", message: `${what} failed (${(error as Error).name})` });
}

/** One `live:<folder>[=<source>]` of the copy's command line, or null. */
export function readLiveArgument(argument: string): LiveFolder | null {
  const match = /^live:([^=]+)(?:=(\/.+))?$/.exec(argument);
  if (match === null || !isDataFolder(match[1])) return null;
  return { folder: match[1]!, source: match[2] ?? null };
}

/** The other way: what snapshot.ts puts on the copy's command line. */
export function liveArgument(live: LiveFolder): string {
  return live.source === null ? `live:${live.folder}` : `live:${live.folder}=${live.source}`;
}

/**
 * `copy <data> <staging> <folder> <taken at, ms> <room, bytes> [raw] [stopped] [live:<folder>[=<source>]]...`.
 *
 * `room` is what the disk of the archives has above its reserve, measured by
 * root, which cannot see the data; the data, measured here, which cannot see
 * that disk, must fit twice in it (its database copies, then its archive).
 * The data measured is what the archive will hold: a live folder saved by a
 * backup command counts for the copy that command left, not for its live
 * files (measureCopy). Neither side ever puts the size of a project's tree
 * in the status file: the figures go to the journal (`detail`).
 *
 * `raw` and `stopped`: a restore's own snapshot, see copyData. `live:`, a
 * folder a service keeps live, with the folder its backup command filled.
 */
export async function copyMain(args: string[], env: ChildEnvironment): Promise<number> {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [dataDir, stagingDir, folder, takenAt, room, ...options] = args;
  const live = options.filter((option) => option.startsWith("live:")).map(readLiveArgument);
  const raw = options.includes("raw");
  const stopped = options.includes("stopped");
  if (
    dataDir === undefined ||
    stagingDir === undefined ||
    !isBackupFolder(folder) ||
    !isCount(takenAt) ||
    !isCount(room) ||
    live.includes(null) ||
    options.some((option) => option !== "raw" && option !== "stopped" && !option.startsWith("live:"))
  ) {
    emit({ event: "error", message: "usage: backup.js copy <data folder> <staging folder> <folder> <taken at> <room> [raw] [stopped] [live:<folder>[=<source>]]..." });
    return 2;
  }
  const declared = live as LiveFolder[];
  process.umask(0o077);
  try {
    const measured = measureCopy(dataDir, declared);
    if (2 * measured.bytes > Number(room)) {
      emit({
        event: "error",
        message: "not enough disk space for this snapshot above the reserve, see the journal of sitesolide-backup",
        code: "disk",
        detail: `${measured.bytes} bytes of data, ${room} bytes of room above the reserve`,
      });
      return 1;
    }
    const summary = await copyData(dataDir, stagingDir, stdoutSink(), {
      folder,
      takenAt: Number(takenAt),
      maxBytes: copyBudget(measured.bytes, Number(room)),
      raw,
      stopped,
      live: declared,
    });
    emit({ event: "summary", ...summary, measured: measured.bytes, raw, stopped });
    return 0;
  } catch (error) {
    emitFailure(error, "the copy");
    return 1;
  }
}

/** `measure <data>`: the weight of a data folder, as its project, for a restore to count its room. */
export function measureMain(args: string[], env: ChildEnvironment): number {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [dataDir] = args;
  if (dataDir === undefined || args.length !== 1) {
    emit({ event: "error", message: "usage: backup.js measure <data folder>" });
    return 2;
  }
  try {
    emit({ event: "summary", ...measureData(dataDir) });
    return 0;
  } catch (error) {
    emitFailure(error, "the measure");
    return 1;
  }
}

/**
 * `download <folder> <snapshot>`: the bucket's copy of a snapshot, decrypted
 * onto standard output, refused if it was sealed for another name. The
 * settings come from the environment, which PID 1 fills from the unit's file.
 */
export async function downloadMain(args: string[], env: ChildEnvironment): Promise<number> {
  const [folder, name] = args;
  if (!isBackupFolder(folder) || name === undefined || readSnapshotName(folder, name) === null || args.length !== 2) {
    emit({ event: "error", message: "usage: backup.js download <folder> <snapshot>" });
    return 2;
  }
  const setting = offsiteFrom(env);
  if (setting === null || "error" in setting) {
    emit({ event: "error", message: setting === null ? "no bucket is configured" : setting.error });
    return 1;
  }
  const sink = stdoutSink();
  try {
    const read = await openBucket(setting).download(objectKey(setting, folder, name), (bytes) => sink.write(bytes));
    await sink.close();
    emit({ event: "summary", bytes: read.bytes, version: read.version, sealed: read.sealedFor !== null });
    return 0;
  } catch (error) {
    emit({ event: "error", message: redact((error as Error).message, setting) });
    return 1;
  }
}

export async function extractMain(args: string[], env: ChildEnvironment): Promise<number> {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [destination, maxBytes, folder, takenAt] = args;
  if (destination === undefined || !isCount(maxBytes) || !isBackupFolder(folder) || !isCount(takenAt) || args.length !== 4) {
    emit({ event: "error", message: "usage: backup.js extract <destination folder> <maximum bytes> <folder> <taken at>" });
    return 2;
  }
  process.umask(0o077);
  try {
    const summary = await extractData(
      Bun.stdin.stream() as ReadableStream<Uint8Array>,
      destination,
      { maxEntries: MAX_ENTRIES, maxBytes: Number(maxBytes) },
      { folder, takenAt: Number(takenAt) },
    );
    emit({ event: "summary", files: summary.files, directories: summary.directories, bytes: summary.bytes, described: summary.description !== null });
    return 0;
  } catch (error) {
    emit({ event: "error", message: (error as Error).message });
    return 1;
  }
}

/**
 * The exit codes of the hook mode: its verdict, and the only part of what it
 * says that the parent acts on (hooks.ts). Above the 1 a crash gives and the
 * 2 of a usage or identity refusal.
 */
export const HOOK_EXIT = { prepare: 10, start: 11, failed: 12, timeout: 13, empty: 14 } as const;

/** What the journal keeps of a backup command's own output: its last lines, never its first. */
export const COMMAND_TAIL_BYTES = 8 * 1024;

/** How long the command's output is still read once it has exited: a child it left may hold the pipes. */
const OUTPUT_GRACE_MS = 500;

/**
 * Removes a folder and all it holds, as the project, whatever modes a backup
 * command left in it. A folder without write permission cannot be emptied,
 * even by its owner: one left read-only in BACKUP_DIR would have every later
 * run fail, and only root could clean it. So the owner's rights come back
 * first, to every folder from `root` down to `path` and in its tree, links
 * never followed, then everything goes.
 *
 * `chmod` by path follows a link put in a folder's place after it was looked
 * at; it runs as the project, which may only change the modes of what it
 * owns, and could have done so itself.
 */
export function removeTree(path: string, root: string): void {
  const writable = (folder: string): boolean => {
    let stat: Stats;
    try {
      stat = lstatSync(folder);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory()) return false;
    if ((stat.mode & 0o700) !== 0o700) chmodSync(folder, (stat.mode & 0o7777) | 0o700);
    return true;
  };
  // The folders above it, the staging folder included: removing a name takes
  // the right to write its parent.
  const parts = relative(root, dirname(path)).split(sep).filter((part) => part !== "");
  if (parts.includes("..")) throw new Error("the folder to remove is not under its root");
  let above = root;
  for (const part of ["", ...parts]) {
    above = part === "" ? above : join(above, part);
    if (!writable(above)) break;
  }
  const folders = [path];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    if (!writable(folder)) continue;
    for (const name of readdirSync(folder)) folders.push(join(folder, name));
  }
  rmSync(path, { recursive: true, force: true });
}

/** Reads a stream to its end, keeping its last `max` bytes alone: what a command printed last explains it best. */
async function tailOf(stream: ReadableStream<Uint8Array>, max: number, keep: (bytes: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    keep(value.byteLength > max ? value.subarray(value.byteLength - max) : value);
  }
}

/**
 * `hook <expected uid | -> <backup dir> <time, ms> <program> [<argument>...]`:
 * a service's backup command, as the project, in the walls of its service
 * (hooks.ts).
 *
 * The expected uid comes as an argument, not through the environment as for
 * the other modes: this unit alone is handed the project's `env` and secret
 * files, which could set any variable, an empty BACKUP_EXPECTED_UID included.
 *
 * The folder is emptied first, made again 0700, and handed to the command as
 * `BACKUP_DIR`; the command is started as the words it was given, with no
 * shell, PID 1 having already expanded its `$NAME` as it does for `start`.
 * Done only when the command exits 0 within its time and leaves the folder
 * non-empty.
 *
 * **The parent trusts only the exit code** (HOOK_EXIT). The command shares
 * this process's account, and may write anything, to its own output or to
 * this process's standard error through /proc: what it prints is captured,
 * its last COMMAND_TAIL_BYTES kept, and forwarded to the journal with every
 * line prefixed, so that none of it reads as a report line. The report this
 * mode writes says what happened, for the journal, and decides nothing.
 */
export async function hookMain(args: string[], env: ChildEnvironment): Promise<number> {
  const [expected, backupDir, time, ...words] = args;
  if (expected === undefined || !/^(-|[0-9]{1,10})$/.test(expected) || backupDir === undefined || !backupDir.startsWith("/") || !isCount(time) || words.length === 0) {
    emit({ event: "error", message: "usage: backup.js hook <expected uid | -> <backup folder> <time, ms> <program> [<argument>...]" });
    return 2;
  }
  const refusal = expected === "-" ? null : identityRefusal({ BACKUP_EXPECTED_UID: expected });
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  process.umask(0o077);
  // What a previous run left, a run cut short for one, goes first: the
  // command must find its folder empty, and the archive hold only its copy.
  // The staging folder is two levels up: <staging>/hooks/<unit>.
  try {
    removeTree(backupDir, dirname(dirname(backupDir)));
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    emit({ event: "error", message: "the backup folder could not be prepared", detail: (error as { code?: string }).code ?? (error as Error).name });
    return HOOK_EXIT.prepare;
  }

  const environment: ChildEnvironment = { ...env, BACKUP_DIR: backupDir };
  delete environment.BACKUP_EXPECTED_UID;
  let command: Subprocess<"ignore", "pipe", "pipe">;
  try {
    command = Bun.spawn(words, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment });
  } catch (error) {
    emit({ event: "error", message: "the backup command could not be started", detail: (error as { code?: string }).code ?? (error as Error).name });
    return HOOK_EXIT.start;
  }
  let output: Uint8Array = new Uint8Array(0);
  const keep = (bytes: Uint8Array) => {
    const joined = Bun.concatArrayBuffers([output, bytes], Infinity, true);
    output = joined.byteLength > COMMAND_TAIL_BYTES ? joined.slice(joined.byteLength - COMMAND_TAIL_BYTES) : joined;
  };
  const read = Promise.all([tailOf(command.stdout, COMMAND_TAIL_BYTES, keep), tailOf(command.stderr, COMMAND_TAIL_BYTES, keep)]).catch(() => undefined);
  // Its own time, a little shorter than the unit's, so that it is said; the
  // unit's RuntimeMaxSec stops whatever the command left behind.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    command.kill("SIGKILL");
  }, Number(time));
  const code = await command.exited;
  clearTimeout(timer);
  await Promise.race([read, Bun.sleep(OUTPUT_GRACE_MS)]);
  for (const line of new TextDecoder().decode(output).split("\n")) {
    const shown = line.replace(/[\u0000-\u001f\u007f]/g, " ").trimEnd();
    if (shown !== "") process.stderr.write(`command: ${shown}\n`);
  }

  if (timedOut) {
    emit({ event: "error", message: "the backup command did not finish in its time" });
    return HOOK_EXIT.timeout;
  }
  if (code !== 0) {
    emit({ event: "error", message: "the backup command failed", detail: command.signalCode === null ? `exit code ${code}` : `killed by ${command.signalCode}` });
    return HOOK_EXIT.failed;
  }
  let filled = false;
  try {
    const stat = lstatSync(backupDir);
    filled = stat.isDirectory() && readdirSync(backupDir).length > 0;
  } catch {
    filled = false;
  }
  if (!filled) {
    emit({ event: "error", message: "the backup command left nothing in BACKUP_DIR" });
    return HOOK_EXIT.empty;
  }
  emit({ event: "summary", done: true });
  return 0;
}

/**
 * `discard <folder>`: what the backup commands left, removed once the
 * snapshot is over, the owner's rights restored first (removeTree). Its
 * parent, the staging folder, is the root of that repair.
 */
export function discardMain(args: string[], env: ChildEnvironment): number {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [folder] = args;
  if (folder === undefined || !folder.startsWith("/") || args.length !== 1) {
    emit({ event: "error", message: "usage: backup.js discard <folder>" });
    return 2;
  }
  try {
    removeTree(folder, dirname(folder));
    emit({ event: "summary", done: true });
    return 0;
  } catch (error) {
    emit({ event: "error", message: "the backup commands' copies could not be removed", detail: (error as { code?: string }).code ?? (error as Error).name });
    return 1;
  }
}
