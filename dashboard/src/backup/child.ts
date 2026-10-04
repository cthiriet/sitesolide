/**
 * The modes that run in a transient unit of their own (runner.ts):
 *
 *   copy      as the project: measures its data folder, then writes its
 *             archive on standard output, within the room root says the disk has
 *   extract   as the project: reads an archive on standard input into a fresh folder
 *   measure   as the project: what its data folder weighs, for a restore
 *   download  as a dynamic user, with the network: a bucket's copy, decrypted,
 *             on standard output
 *
 * Each reports on standard error, one JSON line, and exits 0 only when it is
 * done.
 *
 * Before anything, each checks who it runs as. PID 1 sets the identity, and
 * this check costs nothing: a copy that found itself running as root would
 * create root-owned files in a project's folder and break its service.
 */
import { isBackupFolder, readSnapshotName } from "../../borrowed/backups";
import { CopyError, MAX_ENTRIES, copyBudget, copyData, measureData } from "./copy";
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

/**
 * `copy <data> <staging> <folder> <taken at, ms> <room, bytes> [raw]`.
 *
 * `room` is what the disk of the archives has above its reserve, measured by
 * root, which cannot see the data; the data, measured here, which cannot see
 * that disk, must fit twice in it (its database copies, then its archive).
 * Neither side ever puts the size of a project's tree in the status file:
 * the figures go to the journal (`detail`).
 */
export async function copyMain(args: string[], env: ChildEnvironment): Promise<number> {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [dataDir, stagingDir, folder, takenAt, room, flag] = args;
  if (
    dataDir === undefined ||
    stagingDir === undefined ||
    !isBackupFolder(folder) ||
    !isCount(takenAt) ||
    !isCount(room) ||
    (flag !== undefined && flag !== "raw") ||
    args.length > 6
  ) {
    emit({ event: "error", message: "usage: backup.js copy <data folder> <staging folder> <folder> <taken at> <room> [raw]" });
    return 2;
  }
  process.umask(0o077);
  try {
    const measured = measureData(dataDir);
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
      raw: flag === "raw",
    });
    emit({ event: "summary", ...summary, measured: measured.bytes, raw: flag === "raw" });
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
