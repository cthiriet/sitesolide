/**
 * The archive a token sends, read strictly.
 *
 * This reader runs as the project's own account, inside a transient unit that
 * can write the staging directory and nothing else (src/installer/real.ts):
 * root never parses an archive. It is strict all the same, because what a
 * bug in it would let through is decided here and nowhere else:
 *
 *   - only regular files and directories: a symbolic link, a hard link, a
 *     device or a named pipe is refused, never skipped, so that an archive
 *     that tried says so;
 *   - a path is relative, has no `..`, no `.`, no empty component, no
 *     backslash, and starts with `app/` or `public/`, the two trees a
 *     deployment carries;
 *   - a path appears once: a file given twice, or a file then a directory of
 *     the same name, is the classic way of writing through what the first
 *     entry created;
 *   - sizes, entries and path lengths are capped, the data counted as it is
 *     read, so that a compression bomb stops at the cap and not at the disk;
 *   - every header's checksum is verified: a corrupt archive is refused, not
 *     half extracted.
 *
 * The format is ustar, with the two ways of carrying a long path that the
 * common writers use: a pax record (`x`) and GNU's long name (`L`). A global
 * pax header (`g`) is accepted only when it changes no path, which is what
 * `git archive` writes.
 *
 * Pure: chunks in, events out to a sink. The sink writes; see extract.ts.
 */

export type TarLimits = { maxBytes: number; maxEntries: number; maxPathBytes: number };

export type TarSink = {
  directory: (path: string) => void;
  /** A file starts: its data follows through `data`, then `end`. */
  file: (path: string, executable: boolean, mtime: number, size: number) => void;
  data: (bytes: Uint8Array) => void;
  end: () => void;
};

/** A refusal, whose message names the entry and the rule, in English. */
export class TarRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarRefusal";
  }
}

const BLOCK = 512;
/** A pax or long-name record has no reason to be any bigger. */
const MAX_RECORD_BYTES = 64 * 1024;
/** The two trees a deployment carries. */
export const TOP_LEVEL = ["app", "public"] as const;

const decoder = new TextDecoder("utf-8", { fatal: true });

const KIND_NAMES: Record<string, string> = {
  "1": "a hard link",
  "2": "a symbolic link",
  "3": "a character device",
  "4": "a block device",
  "6": "a named pipe",
  "7": "a contiguous file",
  K: "a long link name",
  S: "a sparse file",
  V: "a volume header",
  M: "a multi-volume continuation",
};

function text(block: Uint8Array, offset: number, width: number): Uint8Array {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

/** An octal field. Base-256 (a first byte with its high bit set) is refused: no entry here needs it. */
function octal(block: Uint8Array, offset: number, width: number, what: string): number {
  if ((block[offset]! & 0x80) !== 0) throw new TarRefusal(`${what} is too large`);
  const raw = new TextDecoder().decode(text(block, offset, width)).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new TarRefusal(`corrupt archive: ${what} is not a number`);
  return parseInt(raw, 8);
}

function checksumMatches(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  const raw = new TextDecoder().decode(text(block, 148, 8)).trim();
  return /^[0-7]+$/.test(raw) && parseInt(raw, 8) === sum;
}

function isZero(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function decodePath(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new TarRefusal("a path is not valid UTF-8");
  }
}

/**
 * The path as the archive gives it, checked, and normalised: no leading `./`,
 * no trailing `/`. null for the archive's root itself (`./`), which carries
 * nothing.
 */
export function checkPath(raw: string, limits: TarLimits): string | null {
  const shown = JSON.stringify(raw.slice(0, 80));
  if (new TextEncoder().encode(raw).length > limits.maxPathBytes) throw new TarRefusal(`path too long: ${shown}`);
  if (raw.includes("\0")) throw new TarRefusal(`a path carries a NUL byte: ${shown}`);
  if (raw.includes("\\")) throw new TarRefusal(`a path carries a backslash: ${shown}`);
  if (raw.startsWith("/")) throw new TarRefusal(`absolute path refused: ${shown}`);
  let path = raw.startsWith("./") ? raw.slice(2) : raw;
  path = path.replace(/\/$/, "");
  if (path === "" || path === ".") return null;
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "..") throw new TarRefusal(`path climbing out of the archive refused: ${shown}`);
    if (part === "" || part === ".") throw new TarRefusal(`path with an empty or "." component refused: ${shown}`);
    if (new TextEncoder().encode(part).length > 255) throw new TarRefusal(`path component too long: ${shown}`);
  }
  if (!(TOP_LEVEL as readonly string[]).includes(parts[0]!)) {
    throw new TarRefusal(`unexpected entry ${shown}: the archive holds app/ and public/ and nothing else`);
  }
  return path;
}

/** The records of a pax header, `<length> <key>=<value>\n` each. */
export function paxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes[offset] === 0) break;
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) throw new TarRefusal("corrupt archive: malformed pax record");
    const length = Number(new TextDecoder().decode(bytes.subarray(offset, space)));
    if (!Number.isInteger(length) || length <= space - offset || offset + length > bytes.length) {
      throw new TarRefusal("corrupt archive: malformed pax record");
    }
    const record = bytes.subarray(space + 1, offset + length);
    if (record[record.length - 1] !== 0x0a) throw new TarRefusal("corrupt archive: malformed pax record");
    const equals = record.indexOf(0x3d);
    if (equals === -1) throw new TarRefusal("corrupt archive: malformed pax record");
    const key = new TextDecoder().decode(record.subarray(0, equals));
    records.set(key, decodePath(record.subarray(equals + 1, record.length - 1)));
    offset += length;
  }
  return records;
}

type Pending = { path?: string; size?: number; mtime?: number };

export type TarReader = { push: (chunk: Uint8Array) => void; end: () => void; summary: () => { files: number; directories: number; bytes: number } };

export function createTarReader(sink: TarSink, limits: TarLimits): TarReader {
  const kinds = new Map<string, "file" | "directory">();
  let header = new Uint8Array(BLOCK);
  let headerFill = 0;
  let zeros = 0;
  let finished = false;
  /** The entry whose data is being read: a file for the sink, or a record kept here. */
  let current: { kind: "file" | "record"; remaining: number; padding: number; record?: Uint8Array; recordFill?: number; type?: string } | null = null;
  let pending: Pending = {};
  let entries = 0;
  let files = 0;
  let directories = 0;
  let dataBytes = 0;
  let streamBytes = 0;
  const maxStream = limits.maxBytes + (limits.maxEntries * 3 + 16) * BLOCK + MAX_RECORD_BYTES;

  function count(): void {
    entries++;
    if (entries > limits.maxEntries) throw new TarRefusal(`too many entries: ${limits.maxEntries} at most`);
  }

  /** Every ancestor must be a directory; one met for the first time is announced to the sink. */
  function ancestors(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      const kind = kinds.get(ancestor);
      if (kind === "file") throw new TarRefusal(`${JSON.stringify(path.slice(0, 80))} sits under a file`);
      if (kind === undefined) {
        count();
        kinds.set(ancestor, "directory");
        directories++;
        sink.directory(ancestor);
      }
    }
  }

  function onHeader(block: Uint8Array): void {
    if (!checksumMatches(block)) throw new TarRefusal("corrupt archive: a header's checksum does not match");
    const magic = new TextDecoder().decode(block.subarray(257, 263));
    const posix = magic === "ustar\0";
    const gnu = magic === "ustar ";
    if (!posix && !gnu) throw new TarRefusal("not a ustar archive: write it with sitesolide deploy, or tar --format=ustar");
    const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156]!);
    const size = pending.size ?? octal(block, 124, 12, "an entry's size");
    const mtime = pending.mtime ?? octal(block, 136, 12, "an entry's date");

    if (type === "x" || type === "g" || type === "L") {
      if (size > MAX_RECORD_BYTES) throw new TarRefusal("an extended header is too large");
      current = { kind: "record", remaining: size, padding: (BLOCK - (size % BLOCK)) % BLOCK, record: new Uint8Array(size), recordFill: 0, type };
      if (size === 0) finishRecord();
      return;
    }
    if (Object.hasOwn(KIND_NAMES, type)) {
      throw new TarRefusal(`${KIND_NAMES[type]} refused: ${JSON.stringify(decodePath(text(block, 0, 100)).slice(0, 80))}`);
    }
    if (type !== "0" && type !== "5") throw new TarRefusal(`unknown entry type ${JSON.stringify(type)} refused`);

    let raw = pending.path;
    if (raw === undefined) {
      const name = decodePath(text(block, 0, 100));
      const prefix = posix ? decodePath(text(block, 345, 155)) : "";
      raw = prefix === "" ? name : `${prefix}/${name}`;
    }
    pending = {};
    const path = checkPath(raw, limits);

    if (type === "5") {
      if (size !== 0) throw new TarRefusal("corrupt archive: a directory with a size");
      if (path === null) return;
      ancestors(path);
      const kind = kinds.get(path);
      if (kind === "file") throw new TarRefusal(`${JSON.stringify(path.slice(0, 80))} is both a file and a directory`);
      if (kind === undefined) {
        count();
        kinds.set(path, "directory");
        directories++;
        sink.directory(path);
      }
      return;
    }

    if (path === null) throw new TarRefusal("corrupt archive: a file without a name");
    if (!path.includes("/")) throw new TarRefusal(`${path} must be a directory`);
    ancestors(path);
    if (kinds.has(path)) throw new TarRefusal(`${JSON.stringify(path.slice(0, 80))} appears twice`);
    count();
    if (dataBytes + size > limits.maxBytes) throw new TarRefusal(`the archive holds more than ${limits.maxBytes} bytes once extracted`);
    dataBytes += size;
    kinds.set(path, "file");
    files++;
    const mode = octal(block, 100, 8, "an entry's mode");
    sink.file(path, (mode & 0o111) !== 0, mtime, size);
    current = { kind: "file", remaining: size, padding: (BLOCK - (size % BLOCK)) % BLOCK };
    if (size === 0) {
      sink.end();
      current = null;
    }
  }

  function finishRecord(): void {
    const record = current!;
    current = record.padding > 0 ? { kind: "record", remaining: 0, padding: record.padding, type: "done" } : null;
    const bytes = record.record!;
    if (record.type === "L") {
      const end = bytes.indexOf(0);
      pending.path = decodePath(end === -1 ? bytes : bytes.subarray(0, end));
      return;
    }
    const records = paxRecords(bytes);
    if (records.has("linkpath")) throw new TarRefusal("a link refused: an extended header carries linkpath");
    if (record.type === "g") {
      if (records.has("path") || records.has("size")) throw new TarRefusal("a global header that changes paths or sizes is refused");
      return;
    }
    const path = records.get("path");
    if (path !== undefined) pending.path = path;
    const size = records.get("size");
    if (size !== undefined) {
      if (!/^[0-9]{1,15}$/.test(size)) throw new TarRefusal("corrupt archive: malformed size in an extended header");
      pending.size = Number(size);
    }
    const mtime = records.get("mtime");
    if (mtime !== undefined && /^[0-9]{1,15}(\.[0-9]+)?$/.test(mtime)) pending.mtime = Math.floor(Number(mtime));
  }

  function push(chunk: Uint8Array): void {
    streamBytes += chunk.length;
    if (streamBytes > maxStream) throw new TarRefusal(`the archive holds more than ${limits.maxBytes} bytes once extracted`);
    let offset = 0;
    while (offset < chunk.length) {
      if (finished) return;
      if (current !== null) {
        if (current.remaining > 0) {
          const take = Math.min(current.remaining, chunk.length - offset);
          const piece = chunk.subarray(offset, offset + take);
          if (current.kind === "file") sink.data(piece);
          else {
            current.record!.set(piece, current.recordFill!);
            current.recordFill! += take;
          }
          current.remaining -= take;
          offset += take;
          if (current.remaining === 0) {
            if (current.kind === "file") sink.end();
            else if (current.type !== "done") {
              finishRecord();
              continue;
            }
          }
          continue;
        }
        if (current.padding > 0) {
          const take = Math.min(current.padding, chunk.length - offset);
          current.padding -= take;
          offset += take;
          if (current.padding > 0) continue;
        }
        current = null;
        continue;
      }
      const take = Math.min(BLOCK - headerFill, chunk.length - offset);
      header.set(chunk.subarray(offset, offset + take), headerFill);
      headerFill += take;
      offset += take;
      if (headerFill < BLOCK) continue;
      headerFill = 0;
      const block = header;
      header = new Uint8Array(BLOCK);
      if (isZero(block)) {
        zeros++;
        if (zeros === 2) finished = true;
        continue;
      }
      if (zeros > 0) throw new TarRefusal("corrupt archive: data after an end-of-archive block");
      onHeader(block);
    }
  }

  function end(): void {
    if (current !== null && (current.remaining > 0 || current.padding > 0)) throw new TarRefusal("the archive is truncated");
    if (headerFill !== 0) throw new TarRefusal("the archive is truncated");
    if (!finished && zeros < 1) throw new TarRefusal("the archive is truncated: no end-of-archive block");
    if (pending.path !== undefined || pending.size !== undefined) throw new TarRefusal("the archive ends on an extended header");
  }

  return { push, end, summary: () => ({ files, directories, bytes: dataBytes }) };
}
