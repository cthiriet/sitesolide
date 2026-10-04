/**
 * The archive format of the snapshots: a POSIX tar (ustar, with pax headers for
 * long names), compressed with gzip. Written and read here, as streams.
 *
 * **Why not `Bun.Archive`.** It was the first candidate, and it was measured on
 * 4 October 2026 with Bun 1.3.11, the version this repository tests with:
 *
 * - an entry given as `Bun.file(path)` is archived EMPTY, with no error: the
 *   archive looks sound and holds nothing, the worst failure a backup can have;
 * - `{ compress: "gzip" }` wrote an uncompressed archive through `Bun.write`;
 * - it builds the whole archive in memory, contents included: 200 MB of data
 *   took 546 MB of resident memory, and extracting it 747 MB, under a unit
 *   whose `MemoryMax` must stay far below the machine's;
 * - it keeps neither modes nor times, and on extraction it *normalises* a `..`
 *   rather than refusing the archive that carries it.
 *
 * A tar is 512-byte headers and padded contents: written by hand, it streams,
 * file by file, in a few hundred kilobytes, and stays readable by `tar -xzf`
 * on any machine, which is what a restore by hand needs on the day the
 * dashboard does not answer.
 *
 * **The reader trusts nothing.** An archive is rewritten by its project's own
 * account (src/backup/copy.ts runs as `site-<slug>`), so a compromised project
 * can hand over any bytes at all. The reader accepts regular files and
 * directories, refuses links, devices and anything else by name, refuses a
 * path that is absolute, climbs, or is not valid UTF-8, and stops at a number
 * of entries and of bytes given by the caller. Refusing beats normalising: a
 * `..` in an archive this component wrote is the sign of a forged one.
 */

export const BLOCK = 512;
/** GNU tar's record: 20 blocks. The end is padded to it, as `tar` itself does. */
export const RECORD = 20 * BLOCK;
/** A pax or long-name header holds a name, never a payload. */
const MAX_META_BYTES = 1024 * 1024;
/** PATH_MAX on Linux, and NAME_MAX for one component. */
export const MAX_PATH_BYTES = 4096;
export const MAX_COMPONENT_BYTES = 255;
/** What the octal size field can carry: 11 digits, 8 GiB minus one byte. Beyond, base 256. */
const OCTAL_SIZE_MAX = 0o77777777777;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

// --- Streams -------------------------------------------------------------------

/** Where bytes go: a file, a pipe, a compressor. `write` resolves once the bytes are taken. */
export type Sink = {
  write: (bytes: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * A gzip compressor in front of a sink, with backpressure: `write` waits for
 * the compressor to have room, and the compressor waits for the sink. Bounded
 * memory whatever the size of the archive. A failure of the sink fails the
 * next `write` rather than leaving it waiting forever.
 */
export function gzipSink(target: Sink): Sink {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  let failure: unknown = null;
  const pump = (async () => {
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      await target.write(value);
    }
  })().catch((error: unknown) => {
    failure = error;
    void writer.abort(error).catch(() => undefined);
  });

  return {
    async write(bytes) {
      if (failure !== null) throw failure;
      await writer.ready;
      if (failure !== null) throw failure;
      await writer.write(bytes as Uint8Array<ArrayBuffer>);
    },
    async close() {
      if (failure === null) await writer.close().catch(() => undefined);
      await pump;
      if (failure !== null) throw failure;
      await target.close();
    },
  };
}

/**
 * A stream read by exact counts: a header is 512 bytes, a content its size.
 * Bytes are pulled only as needed, so a file of any size crosses in chunks.
 */
export class ByteSource {
  private readonly reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> };
  private pending: Uint8Array[] = [];
  private available = 0;
  private finished = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(wanted: number): Promise<void> {
    while (this.available < wanted && !this.finished) {
      const { done, value } = await this.reader.read();
      if (done || value === undefined) {
        this.finished = true;
        break;
      }
      if (value.byteLength === 0) continue;
      this.pending.push(value);
      this.available += value.byteLength;
    }
  }

  /** Up to `max` bytes, at least one unless the stream is over: null then. */
  async some(max: number): Promise<Uint8Array | null> {
    await this.fill(1);
    if (this.available === 0) return null;
    const first = this.pending[0]!;
    if (first.byteLength <= max) {
      this.pending.shift();
      this.available -= first.byteLength;
      return first;
    }
    this.pending[0] = first.subarray(max);
    this.available -= max;
    return first.subarray(0, max);
  }

  /** `count` bytes, or fewer if the stream ends first: an empty array at its end. */
  async upTo(count: number): Promise<Uint8Array<ArrayBuffer>> {
    await this.fill(count);
    return (await this.exact(Math.min(count, this.available)))!;
  }

  /** Exactly `count` bytes, in an array of their own, or null if the stream ends first. */
  async exact(count: number): Promise<Uint8Array<ArrayBuffer> | null> {
    await this.fill(count);
    if (this.available < count) return null;
    const out = new Uint8Array(count);
    let position = 0;
    while (position < count) {
      const chunk = (await this.some(count - position))!;
      out.set(chunk, position);
      position += chunk.byteLength;
    }
    return out;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

// --- Paths ---------------------------------------------------------------------

/**
 * An entry's path, cleaned, or the reason it is refused. A leading `./` is
 * what `tar -czf x.tar.gz .` writes, and is dropped; a directory's trailing
 * slash too. Everything else that could leave the destination is refused, not
 * repaired.
 */
export function cleanEntryPath(raw: string): { path: string } | { refusal: string } {
  let path = raw;
  while (path.startsWith("./")) path = path.slice(2);
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" || path === ".") return { refusal: "an entry has an empty path" };
  if (path.includes("\0")) return { refusal: "an entry's path holds a null byte" };
  if (path.startsWith("/")) return { refusal: `absolute path in the archive: ${quoted(path)}` };
  if (encoder.encode(path).byteLength > MAX_PATH_BYTES) return { refusal: "an entry's path is too long" };
  for (const component of path.split("/")) {
    if (component === "" || component === ".") return { refusal: `malformed path in the archive: ${quoted(path)}` };
    if (component === "..") return { refusal: `path climbing out of the archive: ${quoted(path)}` };
    if (encoder.encode(component).byteLength > MAX_COMPONENT_BYTES) return { refusal: "an entry's name is too long" };
  }
  return { path };
}

/** A path from an archive, bounded and with control characters escaped, fit for a message. */
export function quoted(path: string): string {
  return JSON.stringify(path.length > 120 ? `${path.slice(0, 117)}...` : path);
}

// --- Headers -------------------------------------------------------------------

export type EntryType = "file" | "directory";

export type EntryMeta = {
  /** Seconds since the epoch. */
  mtime: number;
  /** Permission bits only: set-id and sticky bits are never written. */
  mode: number;
  uid: number;
  gid: number;
};

function writeText(block: Uint8Array, offset: number, length: number, bytes: Uint8Array): void {
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const digits = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  writeText(block, offset, length - 1, encoder.encode(digits));
  block[offset + length - 1] = 0;
}

/** A size beyond the octal field: GNU's base 256, which GNU tar and bsdtar read. */
function writeSize(block: Uint8Array, value: number): void {
  if (value <= OCTAL_SIZE_MAX) return writeOctal(block, 124, 12, value);
  block[124] = 0x80;
  let remaining = BigInt(value);
  for (let i = 135; i > 124; i--) {
    block[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum;
}

/** The ustar split of a path: a prefix of at most 155 bytes, a name of at most 100. Null if none fits. */
function ustarSplit(bytes: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | null {
  if (bytes.byteLength <= 100) return { prefix: new Uint8Array(0), name: bytes };
  for (let i = Math.min(bytes.byteLength - 1, 155); i > 0; i--) {
    if (bytes[i] !== 0x2f) continue;
    if (bytes.byteLength - i - 1 <= 100 && bytes.byteLength - i - 1 > 0) {
      return { prefix: bytes.subarray(0, i), name: bytes.subarray(i + 1) };
    }
  }
  return null;
}

function header(typeflag: string, nameBytes: Uint8Array, prefixBytes: Uint8Array, size: number, meta: EntryMeta): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, 100, nameBytes);
  writeOctal(block, 100, 8, meta.mode & 0o777);
  writeOctal(block, 108, 8, meta.uid <= 0o7777777 ? meta.uid : 0);
  writeOctal(block, 116, 8, meta.gid <= 0o7777777 ? meta.gid : 0);
  writeSize(block, size);
  writeOctal(block, 136, 12, Math.min(Math.max(0, meta.mtime), 0o77777777777));
  block[156] = typeflag.charCodeAt(0);
  writeText(block, 257, 6, encoder.encode("ustar\0"));
  writeText(block, 263, 2, encoder.encode("00"));
  writeText(block, 345, 155, prefixBytes);
  const sum = checksum(block).toString(8).padStart(6, "0");
  writeText(block, 148, 6, encoder.encode(sum));
  block[154] = 0;
  block[155] = 32;
  return block;
}

/** One pax record, `<length> <key>=<value>\n`, the length counting itself, in bytes. */
export function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(` ${key}=${value}\n`).byteLength;
  let length = body + 1;
  while (String(length).length + body !== length) length = String(length).length + body;
  return encoder.encode(`${length} ${key}=${value}\n`);
}

/** At most `max` bytes of a UTF-8 text, never cutting a character in two. */
function utf8Prefix(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.byteLength <= max) return bytes;
  let cut = max;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut);
}

// --- Writing -------------------------------------------------------------------

/** How a file's contents compared with the size announced in its header. */
export type Written = "exact" | "shorter" | "longer";

/**
 * Writes entries one after the other into a sink. Small writes are gathered
 * into 64 KiB before reaching the sink: thousands of small files must not mean
 * thousands of calls to the compressor.
 */
export class TarWriter {
  private buffer = new Uint8Array(64 * 1024);
  private used = 0;
  private total = 0;

  constructor(private readonly sink: Sink) {}

  private async push(bytes: Uint8Array): Promise<void> {
    this.total += bytes.byteLength;
    if (bytes.byteLength >= this.buffer.byteLength) {
      await this.flush();
      await this.sink.write(bytes);
      return;
    }
    if (this.used + bytes.byteLength > this.buffer.byteLength) await this.flush();
    this.buffer.set(bytes, this.used);
    this.used += bytes.byteLength;
  }

  private async flush(): Promise<void> {
    if (this.used === 0) return;
    const out = this.buffer.slice(0, this.used);
    this.used = 0;
    await this.sink.write(out);
  }

  private async pad(size: number): Promise<void> {
    const rest = size % BLOCK;
    if (rest !== 0) await this.push(new Uint8Array(BLOCK - rest));
  }

  private async begin(typeflag: string, path: string, size: number, meta: EntryMeta): Promise<void> {
    const cleaned = cleanEntryPath(path);
    if ("refusal" in cleaned) throw new Error(cleaned.refusal);
    const full = typeflag === "5" ? `${cleaned.path}/` : cleaned.path;
    const bytes = encoder.encode(full);
    const split = ustarSplit(bytes);
    if (split === null) {
      const record = paxRecord("path", full);
      await this.push(header("x", encoder.encode("././@PaxHeader"), new Uint8Array(0), record.byteLength, meta));
      await this.push(record);
      await this.pad(record.byteLength);
      await this.push(header(typeflag, utf8Prefix(bytes, 100), new Uint8Array(0), size, meta));
      return;
    }
    await this.push(header(typeflag, split.name, split.prefix, size, meta));
  }

  async directory(path: string, meta: EntryMeta): Promise<void> {
    await this.begin("5", path, 0, meta);
  }

  /**
   * A regular file of `size` bytes. Exactly that many are written whatever the
   * source yields, as `tar` does with a file that changes while it is read:
   * missing bytes are zeros, extra ones are dropped, and the caller is told.
   */
  async file(path: string, meta: EntryMeta, size: number, source: AsyncIterable<Uint8Array> | Uint8Array): Promise<Written> {
    await this.begin("0", path, size, meta);
    let written = 0;
    let longer = false;
    const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = source instanceof Uint8Array ? [source] : source;
    for await (const chunk of chunks) {
      if (written >= size) {
        if (chunk.byteLength > 0) longer = true;
        continue;
      }
      const room = size - written;
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      if (chunk.byteLength > room) longer = true;
      await this.push(part);
      written += part.byteLength;
    }
    let shorter = false;
    while (written < size) {
      shorter = true;
      const zeros = new Uint8Array(Math.min(64 * 1024, size - written));
      await this.push(zeros);
      written += zeros.byteLength;
    }
    await this.pad(size);
    return shorter ? "shorter" : longer ? "longer" : "exact";
  }

  /** The two zero blocks that end an archive, then up to a whole record. */
  async end(): Promise<void> {
    await this.push(new Uint8Array(2 * BLOCK));
    const rest = this.total % RECORD;
    if (rest !== 0) await this.push(new Uint8Array(RECORD - rest));
    await this.flush();
    await this.sink.close();
  }
}

// --- Reading -------------------------------------------------------------------

export type ReadEntry = { path: string; type: EntryType; size: number; mode: number; mtime: number };

export type Limits = {
  /** Beyond this many entries, the archive is refused. */
  maxEntries: number;
  /** Beyond this many bytes of contents in total, the archive is refused. */
  maxBytes: number;
};

export type Visitor = (entry: ReadEntry, data: AsyncIterable<Uint8Array>) => Promise<void>;

export type ReadSummary = { entries: number; bytes: number };

export class ArchiveError extends Error {
  override name = "ArchiveError";
}

function readField(block: Uint8Array, offset: number, length: number): Uint8Array {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

function readOctal(block: Uint8Array, offset: number, length: number, what: string): number {
  const field = block.subarray(offset, offset + length);
  if ((field[0]! & 0x80) !== 0) {
    if (field[0] !== 0x80) throw new ArchiveError(`unreadable ${what} in the archive`);
    let value = 0n;
    for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(field[i]!);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError(`${what} too large in the archive`);
    return Number(value);
  }
  const text = new TextDecoder().decode(readField(block, offset, length)).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError(`unreadable ${what} in the archive`);
  return Number.parseInt(text, 8);
}

function decodeName(bytes: Uint8Array): string {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    throw new ArchiveError("an entry's name is not valid UTF-8");
  }
}

/**
 * The pax records that matter here, `path` and `size`. Others, times and
 * owners, are ignored. Each record is `<length> <key>=<value>\n`, the length
 * counting bytes, itself included.
 */
function readPax(bytes: Uint8Array): { path?: string; size?: number } {
  const malformed = () => new ArchiveError("malformed pax header in the archive");
  const found: { path?: string; size?: number } = {};
  let position = 0;
  while (position < bytes.byteLength) {
    // Zeros after the last record pad it, and end it.
    if (bytes.subarray(position).every((byte) => byte === 0)) break;
    const space = bytes.indexOf(0x20, position);
    if (space === -1 || space - position > 10) throw malformed();
    const digits = new TextDecoder().decode(bytes.subarray(position, space));
    if (!/^[0-9]+$/.test(digits)) throw malformed();
    const length = Number(digits);
    if (length <= space - position + 1 || position + length > bytes.byteLength || bytes[position + length - 1] !== 0x0a) throw malformed();
    // A value may be binary (an extended attribute, as bsdtar writes them):
    // only the key is decoded, and the value of the two keys read here.
    const body = bytes.subarray(space + 1, position + length - 1);
    const equal = body.indexOf(0x3d);
    if (equal === -1) throw malformed();
    const key = new TextDecoder().decode(body.subarray(0, equal));
    if (key === "path") found.path = decodeName(body.subarray(equal + 1));
    if (key === "size") {
      const value = new TextDecoder().decode(body.subarray(equal + 1));
      if (!/^[0-9]+$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) throw new ArchiveError("unreadable size in the archive");
      found.size = Number(value);
    }
    position += length;
  }
  return found;
}

const TYPE_NAMES: Record<string, string> = {
  "1": "hard link",
  "2": "symbolic link",
  "3": "character device",
  "4": "block device",
  "6": "named pipe",
  K: "long link name",
};

/**
 * Reads an uncompressed tar stream, entry by entry, handing each one and its
 * contents to `visit`. The contents not read by the visitor are skipped. Any
 * refusal throws an ArchiveError naming the entry, the source is cancelled,
 * and the visitor has already been told about the entries before it only.
 */
export async function readTar(stream: ReadableStream<Uint8Array>, limits: Limits, visit: Visitor): Promise<ReadSummary> {
  const source = new ByteSource(stream);
  let entries = 0;
  let bytes = 0;
  let pending: { path?: string; size?: number } = {};
  let longName: string | null = null;

  async function readMeta(size: number, what: string): Promise<Uint8Array> {
    if (size > MAX_META_BYTES) throw new ArchiveError(`${what} too large in the archive`);
    const data = await source.exact(size);
    if (data === null) throw new ArchiveError("the archive is truncated");
    const rest = size % BLOCK;
    if (rest !== 0 && (await source.exact(BLOCK - rest)) === null) throw new ArchiveError("the archive is truncated");
    return data;
  }

  try {
    for (;;) {
      const block = await source.exact(BLOCK);
      if (block === null) throw new ArchiveError("the archive is truncated: no end marker");
      if (block.every((byte) => byte === 0)) {
        // The end: a second zero block, or the end of a stream cut there.
        const second = await source.exact(BLOCK);
        if (second !== null && !second.every((byte) => byte === 0)) throw new ArchiveError("data after a lone end block");
        return { entries, bytes };
      }

      const stored = readOctal(block, 148, 8, "checksum");
      let signed = 0;
      for (let i = 0; i < BLOCK; i++) signed += i >= 148 && i < 156 ? 32 : (block[i]! << 24) >> 24;
      if (stored !== checksum(block) && stored !== signed) throw new ArchiveError("a header's checksum does not match: the archive is damaged");
      const magic = new TextDecoder().decode(block.subarray(257, 265));
      if (magic !== "ustar\u000000" && magic !== "ustar  \u0000") throw new ArchiveError("not a ustar archive");

      const typeflag = block[156] === 0 ? "0" : String.fromCharCode(block[156]!);
      const declared = readOctal(block, 124, 12, "size");

      if (typeflag === "x") {
        pending = readPax(await readMeta(declared, "a pax header"));
        continue;
      }
      if (typeflag === "g") {
        await readMeta(declared, "a pax header");
        continue;
      }
      if (typeflag === "L") {
        longName = decodeName(readField(await readMeta(declared, "a long name"), 0, declared));
        continue;
      }

      // The ustar fields are only read when nothing longer replaces them: a
      // writer truncates them, sometimes in the middle of a character.
      let rawPath = pending.path ?? longName;
      if (rawPath === null || rawPath === undefined) {
        const name = decodeName(readField(block, 0, 100));
        const prefix = decodeName(readField(block, 345, 155));
        rawPath = prefix === "" ? name : `${prefix}/${name}`;
      }
      const size = pending.size ?? declared;
      pending = {};
      longName = null;

      if (typeflag !== "0" && typeflag !== "7" && typeflag !== "5") {
        const kind = TYPE_NAMES[typeflag] ?? `entry of type ${JSON.stringify(typeflag)}`;
        throw new ArchiveError(`${kind} in the archive: ${quoted(rawPath)}, only files and folders are restored`);
      }
      const cleaned = cleanEntryPath(rawPath);
      if ("refusal" in cleaned) throw new ArchiveError(cleaned.refusal);

      entries++;
      if (entries > limits.maxEntries) throw new ArchiveError(`more than ${limits.maxEntries} entries in the archive`);
      const type: EntryType = typeflag === "5" ? "directory" : "file";
      const contentSize = type === "directory" ? 0 : size;
      bytes += contentSize;
      if (bytes > limits.maxBytes) throw new ArchiveError("the archive holds more data than there is room for");

      let remaining = size;
      async function* data(): AsyncGenerator<Uint8Array> {
        while (remaining > 0 && type === "file") {
          const chunk = await source.some(Math.min(remaining, 64 * 1024));
          if (chunk === null) throw new ArchiveError("the archive is truncated");
          remaining -= chunk.byteLength;
          yield chunk;
        }
      }
      await visit(
        { path: cleaned.path, type, size: contentSize, mode: readOctal(block, 100, 8, "mode") & 0o777, mtime: readOctal(block, 136, 12, "time") },
        data(),
      );
      // What the visitor left, and the padding.
      while (remaining > 0) {
        const chunk = await source.some(Math.min(remaining, 64 * 1024));
        if (chunk === null) throw new ArchiveError("the archive is truncated");
        remaining -= chunk.byteLength;
      }
      const rest = size % BLOCK;
      if (rest !== 0 && (await source.exact(BLOCK - rest)) === null) throw new ArchiveError("the archive is truncated");
    }
  } catch (error) {
    await source.cancel();
    throw error;
  }
}

/** A gzip stream decompressed. A damaged or truncated one fails while being read. */
export function gunzip(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decompressor = new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return stream.pipeThrough(decompressor);
}
