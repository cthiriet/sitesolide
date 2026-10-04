/**
 * The two modes that run as a project (runner.ts): `copy`, which writes the
 * archive of its data folder on standard output, and `extract`, which reads one
 * on standard input into a fresh folder. Each reports on standard error, one
 * JSON line, and exits 0 only when it is done.
 *
 * Before anything, each checks who it runs as. PID 1 sets the identity, and
 * this check costs nothing: a copy that found itself running as root would
 * create root-owned files in a project's folder and break its service.
 */
import { CopyError, copyData } from "./copy";
import { extractData } from "./extract";
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

export async function copyMain(args: string[], env: ChildEnvironment): Promise<number> {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [dataDir, stagingDir] = args;
  if (dataDir === undefined || stagingDir === undefined || args.length !== 2) {
    emit({ event: "error", message: "usage: backup.js copy <data folder> <staging folder>" });
    return 2;
  }
  process.umask(0o077);
  try {
    const summary = await copyData(dataDir, stagingDir, stdoutSink());
    emit({ event: "summary", ...summary });
    return 0;
  } catch (error) {
    // The message names no file; the path goes apart, for the journal alone.
    if (error instanceof CopyError) emit({ event: "error", message: error.message, path: error.path });
    else emit({ event: "error", message: `the copy failed (${(error as Error).name})` });
    return 1;
  }
}

export async function extractMain(args: string[], env: ChildEnvironment): Promise<number> {
  const refusal = identityRefusal(env);
  if (refusal !== null) {
    emit({ event: "error", message: refusal });
    return 2;
  }
  const [destination, maxBytes] = args;
  if (destination === undefined || maxBytes === undefined || args.length !== 2 || !/^[0-9]+$/.test(maxBytes)) {
    emit({ event: "error", message: "usage: backup.js extract <destination folder> <maximum bytes>" });
    return 2;
  }
  process.umask(0o077);
  try {
    const summary = await extractData(Bun.stdin.stream() as ReadableStream<Uint8Array>, destination, {
      maxEntries: 2_000_000,
      maxBytes: Number(maxBytes),
    });
    emit({ event: "summary", files: summary.files, directories: summary.directories, bytes: summary.bytes, described: summary.description !== null });
    return 0;
  } catch (error) {
    emit({ event: "error", message: (error as Error).message });
    return 1;
  }
}
