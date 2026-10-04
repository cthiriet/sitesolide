/**
 * The extraction itself: the gzip stream on standard input, the tar reader of
 * tar.ts, and the files written into the staging directory.
 *
 * Run as `installer.js --extract <directory>`, by the installer, under the
 * project's own account in a transient unit that sees nothing of /srv but that
 * directory, has no network and a memory ceiling (see `extractionCommand` in
 * real.ts). What it writes is therefore bounded by that account twice over:
 * by the reader's refusals, and by what the account may write at all.
 *
 * Every file is created with `O_EXCL | O_NOFOLLOW`: nothing already there is
 * ever written through, a link least of all. The modes are 0644 and 0755, with
 * the date the archive gives, which Caddy derives its ETags from.
 *
 * It prints one line of JSON on standard output, the summary or the refusal,
 * and exits 0 or 1: the installer reads that line, never its own guess.
 */
import { closeSync, constants, futimesSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createTarReader, TarRefusal, type TarLimits } from "./tar";

export type ExtractSummary = { files: number; directories: number; bytes: number };

export type ExtractOutcome = { ok: true; summary: ExtractSummary } | { ok: false; reason: string };

/** Extracts the gzip-compressed tar `stream` into `destination`, an existing empty directory. */
export async function extract(stream: ReadableStream<Uint8Array>, destination: string, limits: TarLimits): Promise<ExtractOutcome> {
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: "the staging directory is not a plain directory" };
  if (readdirSync(destination).length > 0) return { ok: false, reason: "the staging directory is not empty" };

  let fd: number | null = null;
  let mtime = 0;
  const reader = createTarReader(
    {
      directory(path) {
        mkdirSync(join(destination, path), { mode: 0o755 });
      },
      file(path, executable, date) {
        fd = openSync(join(destination, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, executable ? 0o755 : 0o644);
        mtime = date;
      },
      data(bytes) {
        let written = 0;
        while (written < bytes.length) written += writeSync(fd!, bytes, written, bytes.length - written);
      },
      end() {
        futimesSync(fd!, mtime, mtime);
        closeSync(fd!);
        fd = null;
      },
    },
    limits,
  );

  try {
    const inflated = stream.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    for await (const chunk of inflated) reader.push(chunk as Uint8Array);
    reader.end();
    return { ok: true, summary: reader.summary() };
  } catch (error) {
    if (error instanceof TarRefusal) return { ok: false, reason: error.message };
    if (error instanceof TypeError) return { ok: false, reason: "the archive is not valid gzip, or is truncated" };
    const code = (error as { code?: unknown } | null)?.code;
    return { ok: false, reason: `the archive could not be written: ${typeof code === "string" ? code : (error as Error).name}` };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
