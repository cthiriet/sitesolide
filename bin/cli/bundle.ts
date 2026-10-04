/**
 * The archive a deployment sends through the control API, instead of rsync.
 *
 * Over SSH, `deploy` sends two trees with rsync: the project's code into
 * `app/`, minus its exclusions, and its `publicDir` into `public/`. Through the
 * API, the same two trees travel in one tar archive, compressed with gzip,
 * whose only top-level entries are `app/` and `public/`. The installer on the
 * machine extracts it as the project's own account and refuses everything else
 * (bin/cli/bundle.ts writes, dashboard/src/installer/tar.ts reads).
 *
 * **The format is the plainest tar there is**, ustar with a pax record for a
 * path longer than its field, because the reader on the other side refuses
 * every entry it does not need: links, devices, global headers. An archive
 * written by `tar` on the workstation may carry those; this one never does.
 *
 * **Modification times travel.** rsync -a keeps them, and Caddy derives a
 * file's ETag from its size and its date: a file rewritten at the same size
 * with a date of zero would keep its old ETag, and browsers their old copy.
 *
 * **The exclusions follow rsync's rules**, since the manifest's `exclude`
 * was written for it: a name without a slash matches at any depth, a pattern
 * with a slash matches the end of the path, a leading slash anchors it at the
 * root, and `*`, `?` and `**` are wildcards.
 *
 * Pure: entries in, bytes out. Reading the disk belongs to bin/cli/remote.ts.
 */

/** One entry of the archive, already read from disk. */
export type BundleEntry =
  | { kind: "directory"; path: string; mtime: number }
  | { kind: "file"; path: string; mtime: number; executable: boolean; content: Uint8Array };

const BLOCK = 512;
const encoder = new TextEncoder();

/** A number in an octal field of `width` bytes, ended by a NUL. */
function octal(value: number, width: number): string {
  const digits = Math.max(0, Math.floor(value)).toString(8);
  if (digits.length > width - 1) throw new Error(`value too large for a tar field: ${value}`);
  return `${digits.padStart(width - 1, "0")}\0`;
}

function put(header: Uint8Array, offset: number, text: string, width: number): void {
  const bytes = encoder.encode(text);
  if (bytes.length > width) throw new Error(`field too long: ${text.slice(0, 40)}`);
  header.set(bytes, offset);
}

/**
 * One 512-byte header. `name` must fit in 100 bytes: a longer path goes into a
 * pax record before it, see `entryBlocks`.
 */
export function header(name: string, options: { type: string; mode: number; size: number; mtime: number }): Uint8Array {
  const block = new Uint8Array(BLOCK);
  put(block, 0, name, 100);
  put(block, 100, octal(options.mode, 8), 8);
  put(block, 108, octal(0, 8), 8);
  put(block, 116, octal(0, 8), 8);
  put(block, 124, octal(options.size, 12), 12);
  put(block, 136, octal(options.mtime, 12), 12);
  // The checksum is computed with its own field full of spaces.
  put(block, 148, "        ", 8);
  put(block, 156, options.type, 1);
  put(block, 257, "ustar\0", 6);
  put(block, 263, "00", 2);
  put(block, 265, "root", 32);
  put(block, 297, "root", 32);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
}

/** The data padded to a whole number of blocks. */
function padded(data: Uint8Array): Uint8Array {
  const length = Math.ceil(data.length / BLOCK) * BLOCK;
  if (length === data.length) return data;
  const out = new Uint8Array(length);
  out.set(data);
  return out;
}

/** One pax record, `<length> <key>=<value>\n`, the length counting itself. */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).length;
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return `${length}${body}`;
}

/** The blocks of one entry: a pax record when the path does not fit, the header, the data. */
export function entryBlocks(entry: BundleEntry): Uint8Array[] {
  const path = entry.kind === "directory" ? `${entry.path.replace(/\/+$/, "")}/` : entry.path;
  const blocks: Uint8Array[] = [];
  let name = path;
  if (encoder.encode(path).length > 100) {
    const record = encoder.encode(paxRecord("path", path));
    blocks.push(header("PaxHeader", { type: "x", mode: 0o644, size: record.length, mtime: entry.mtime }), padded(record));
    // A truncated name in the header itself, for a reader that ignores pax.
    name = path.slice(0, 90).replace(/[\u0080-￿]/g, "_");
  }
  if (entry.kind === "directory") {
    blocks.push(header(name, { type: "5", mode: 0o755, size: 0, mtime: entry.mtime }));
  } else {
    const mode = entry.executable ? 0o755 : 0o644;
    blocks.push(header(name, { type: "0", mode, size: entry.content.length, mtime: entry.mtime }));
    if (entry.content.length > 0) blocks.push(padded(entry.content));
  }
  return blocks;
}

/** The whole archive, uncompressed: every entry, then two empty blocks. */
export function tarArchive(entries: BundleEntry[]): Uint8Array<ArrayBuffer> {
  const blocks = entries.flatMap(entryBlocks);
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** The archive as it travels: tar, then gzip. */
export function bundle(entries: BundleEntry[]): Uint8Array {
  return Bun.gzipSync(tarArchive(entries));
}

// --- exclusions, as rsync reads them ---------------------------------------------

/** A wildcard pattern turned into a regular expression over a whole string. */
function globExpression(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern[i]!;
    if (character === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const inner = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        source += `[${inner.startsWith("!") ? `^${inner.slice(1)}` : inner}]`;
        i = end;
      }
    } else {
      source += character.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Does rsync's `--exclude <pattern>` leave out this path? `path` is relative
 * to the root sent, with `/` as separator; `directory` says whether it names a
 * directory, which a pattern ending in `/` demands.
 */
export function isExcluded(path: string, directory: boolean, pattern: string): boolean {
  let wanted = pattern.trim();
  if (wanted === "") return false;
  if (wanted.endsWith("/")) {
    if (!directory) return false;
    wanted = wanted.replace(/\/+$/, "");
  }
  if (wanted.startsWith("/")) return globExpression(wanted.slice(1)).test(path);
  if (wanted.includes("/") || wanted.includes("**")) {
    const expression = globExpression(wanted);
    const parts = path.split("/");
    // Matched against the end of the path, on a component boundary.
    for (let start = 0; start < parts.length; start++) {
      if (expression.test(parts.slice(start).join("/"))) return true;
    }
    return false;
  }
  return globExpression(wanted).test(path.slice(path.lastIndexOf("/") + 1));
}

/** Is the path left out by any of the patterns? */
export function excludedBy(path: string, directory: boolean, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => isExcluded(path, directory, pattern));
}
