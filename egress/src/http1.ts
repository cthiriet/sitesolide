/**
 * HTTP/1.1 as the connectors speak it on both sides: where a message's body
 * ends, read as it streams, and the heads the proxy writes. Pure, like
 * decide.ts: connectors.ts moves the bytes, this file says what they are.
 *
 * **Strict where two readers could disagree.** A request whose body could be
 * read two ways, a Content-Length beside a Transfer-Encoding, a chunk size
 * ended by a bare line feed, is how a second request gets smuggled to the
 * upstream behind the first, outside the connector's path. Such a request is
 * refused, and a chunked body is not even passed on as it came: the proxy
 * sends its own chunks, of the data it read, so that the upstream reads
 * exactly what the proxy did.
 */
import { HOP_BY_HOP, type RequestHead } from "./decide";

/** How a message's body is delimited (RFC 9112, section 6). */
export type Framing =
  | { kind: "none" }
  | { kind: "length"; length: number }
  | { kind: "chunked" }
  /** Until the connection closes: an answer without a length. */
  | { kind: "close" };

/** The longest Content-Length read: 2^53, past which a number is no longer exact. */
const LENGTH = /^[0-9]{1,15}$/;

/** A header's value: visible characters, spaces and tabs, and bytes past ASCII. */
export function isValidValue(value: string): boolean {
  return !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
}

function values(headers: [string, string][], name: string): string[] {
  return headers.filter(([each]) => each.toLowerCase() === name).map(([, value]) => value);
}

/** One length out of every Content-Length line, which must all say the same; null otherwise. */
function contentLength(lines: string[]): number | null {
  const all = lines.flatMap((line) => line.split(",").map((each) => each.trim()));
  if (all.length === 0 || all.some((each) => !LENGTH.test(each)) || new Set(all.map(Number)).size !== 1) return null;
  return Number(all[0]);
}

function codings(lines: string[]): string[] {
  return lines.flatMap((line) => line.split(",").map((each) => each.trim().toLowerCase())).filter((each) => each !== "");
}

/** The framing of a request's body, or why the request is refused. */
export function requestFraming(headers: [string, string][]): Framing | { status: number; message: string } {
  const transfer = values(headers, "transfer-encoding");
  const length = values(headers, "content-length");
  if (transfer.length > 0 && length.length > 0) {
    return { status: 400, message: "a request with both Content-Length and Transfer-Encoding is refused" };
  }
  if (transfer.length > 0) {
    const all = codings(transfer);
    if (all.length !== 1 || all[0] !== "chunked") return { status: 501, message: "the only transfer coding accepted is chunked" };
    return { kind: "chunked" };
  }
  if (length.length > 0) {
    const bytes = contentLength(length);
    if (bytes === null) return { status: 400, message: "Content-Length does not read" };
    return { kind: "length", length: bytes };
  }
  return { kind: "none" };
}

/** The framing of an answer's body, or why it does not read. */
export function answerFraming(method: string, status: number, headers: [string, string][]): Framing | { error: string } {
  if (method === "HEAD" || status < 200 || status === 204 || status === 304) return { kind: "none" };
  const transfer = values(headers, "transfer-encoding");
  if (transfer.length > 0) return codings(transfer).at(-1) === "chunked" ? { kind: "chunked" } : { kind: "close" };
  const length = values(headers, "content-length");
  if (length.length > 0) {
    const bytes = contentLength(length);
    return bytes === null ? { error: "its answer's Content-Length does not read" } : { kind: "length", length: bytes };
  }
  return { kind: "close" };
}

/** The head of an answer: its status line and its headers, as sent. */
export type AnswerHead = { status: number; reason: string; headers: [name: string, value: string][] };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An answer's head, or null when it is not a well-formed HTTP/1 one: folded
 * lines, bare line feeds and control characters refused, as decide.ts's
 * parseHead refuses them in a request.
 */
export function parseAnswerHead(text: string): AnswerHead | null {
  if (!text.endsWith("\r\n\r\n")) return null;
  const lines = text.slice(0, -4).split("\r\n");
  if (lines.some((line) => line.includes("\n") || line.includes("\r"))) return null;
  const status = /^HTTP\/1\.[01] ([1-9][0-9]{2})(?: (.*))?$/.exec(lines[0] ?? "");
  if (status === null || !isValidValue(status[2] ?? "")) return null;
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (!TOKEN.test(name) || !isValidValue(value)) return null;
    headers.push([name, value]);
  }
  return { status: Number(status[1]), reason: status[2] ?? "", headers };
}

/** Headers named in Connection, hop-by-hop too; never the framing, which the bytes passed on still follow. */
function namedInConnection(headers: [string, string][]): Set<string> {
  const named = new Set(codings(values(headers, "connection")));
  named.delete("content-length");
  named.delete("transfer-encoding");
  return named;
}

/**
 * The head the upstream receives: origin form under the connector's path, the
 * headers given, the body's framing as the proxy will send it, and the
 * connection closed after the answer. Headers keeps names in lower case; those
 * in `spelled`, the connector's own header as its administrator wrote it, go
 * as they are spelled there, for an upstream that minds.
 */
export function upstreamHead(method: string, path: string, headers: Headers, framing: Framing, spelled: string[] = []): string {
  const spelling = new Map(spelled.map((name) => [name.toLowerCase(), name]));
  const lines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, name) => lines.push(`${spelling.get(name) ?? name}: ${value}`));
  if (framing.kind === "chunked") lines.push("Transfer-Encoding: chunked");
  if (framing.kind === "length") lines.push(`Content-Length: ${framing.length}`);
  lines.push("Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * The head the app receives: the upstream's status and headers, the hop's own
 * removed and the proxy's namespace with them, the connector named, and the
 * connection closed after it. The body follows as the upstream framed it, so
 * its framing headers stay, but a Content-Length beside a Transfer-Encoding,
 * which the chunks override.
 *
 * The body is passed on as it came, compressed if it was: decoding it here
 * would hold, for a slow app, bytes many times what the upstream sent.
 */
export function downstreamHead(head: AnswerHead, connector: string): string {
  const named = namedInConnection(head.headers);
  const chunked = values(head.headers, "transfer-encoding").length > 0;
  const lines = [`HTTP/1.1 ${head.status} ${head.reason}`];
  for (const [name, value] of head.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.includes(lower) || named.has(lower) || lower.startsWith("x-sitesolide-")) continue;
    if (chunked && lower === "content-length") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(`X-Sitesolide-Connector: ${connector}`, "Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Whether a request asks to be told to go on before it sends its body. */
export function expectsContinue(head: RequestHead): boolean {
  return values(head.headers, "expect").some((value) => value.toLowerCase() === "100-continue");
}

/** What one read of a body gave: how many of its bytes belong to the body, the data in them, and whether the body ended. */
export type BodyRead = { used: number; data: Uint8Array[]; done: boolean } | { error: string };

export type BodyReader = {
  read: (bytes: Uint8Array) => BodyRead;
  /** Its end is the connection's close. */
  closes: boolean;
};

/** The longest chunk size line, extensions included. */
const MAX_SIZE_LINE = 4096;
/** The most trailer bytes after the last chunk. */
const MAX_TRAILERS = 16 * 1024;
/** A chunk size, and extensions the proxy reads past: 13 hex digits at most, 2^52, a number still exact. */
const SIZE_LINE = /^([0-9A-Fa-f]{1,13})[\t ]*(;[\t -~\u0080-ÿ]*)?$/;
const CR = 13;
const LF = 10;

function chunkedReader(): BodyReader {
  let state: "size" | "data" | "data-cr" | "data-lf" | "trailers" | "done" = "size";
  /** The size or trailer line under way, without its line end. */
  let line = "";
  let sawCR = false;
  let remaining = 0;
  let trailers = 0;
  return {
    closes: false,
    read(bytes) {
      // The data of every chunk in this read, copied end to end: one array per
      // read rather than a view per chunk, of which a read of one-byte chunks
      // made some 87 000: garbage, but sixteen such calls grew the process by
      // 137 MiB with views against 72 MiB without, measured.
      let out: Uint8Array | null = null;
      let length = 0;
      let i = 0;
      while (i < bytes.length && state !== "done") {
        if (state === "data") {
          const take = Math.min(remaining, bytes.length - i);
          out ??= new Uint8Array(bytes.length - i);
          // A small chunk byte by byte: a view to copy it would be garbage too.
          if (take < 64) for (let k = 0; k < take; k++) out[length + k] = bytes[i + k]!;
          else out.set(bytes.subarray(i, i + take), length);
          length += take;
          i += take;
          remaining -= take;
          if (remaining === 0) state = "data-cr";
          continue;
        }
        const byte = bytes[i++]!;
        if (state === "data-cr" || state === "data-lf") {
          if (byte !== (state === "data-cr" ? CR : LF)) return { error: "a chunk not followed by its line end" };
          state = state === "data-cr" ? "data-lf" : "size";
          continue;
        }
        // A line: a chunk's size, or a trailer, whose bytes count line ends and all.
        if (state === "trailers" && ++trailers > MAX_TRAILERS) return { error: "trailers too long" };
        if (sawCR) {
          if (byte !== LF) return { error: "a carriage return without its line feed" };
          sawCR = false;
          if (state === "size") {
            // test(), and parseInt() reading the leading digits alone: no match
            // array per chunk.
            if (!SIZE_LINE.test(line)) return { error: "a chunk size that does not read" };
            remaining = parseInt(line, 16);
            state = remaining === 0 ? "trailers" : "data";
          } else if (line === "") {
            state = "done";
          }
          line = "";
          continue;
        }
        if (byte === CR) {
          sawCR = true;
          continue;
        }
        if (byte === LF) return { error: "a line feed without its carriage return" };
        line += String.fromCharCode(byte);
        if (state === "size" && line.length > MAX_SIZE_LINE) return { error: "a chunk size line too long" };
      }
      return { used: i, data: out === null ? [] : [out.subarray(0, length)], done: state === "done" };
    },
  };
}

function lengthReader(length: number): BodyReader {
  let remaining = length;
  return {
    closes: false,
    read(bytes) {
      const take = Math.min(remaining, bytes.length);
      remaining -= take;
      return { used: take, data: take === 0 ? [] : [bytes.subarray(0, take)], done: remaining === 0 };
    },
  };
}

/** Reads a body as it streams. The data it gives are views of the bytes read, to be copied if they are kept. */
export function bodyReader(framing: Framing): BodyReader {
  switch (framing.kind) {
    case "none":
      return { closes: false, read: () => ({ used: 0, data: [], done: true }) };
    case "length":
      return lengthReader(framing.length);
    case "chunked":
      return chunkedReader();
    case "close":
      return { closes: true, read: (bytes) => ({ used: bytes.length, data: [bytes], done: false }) };
  }
}

const encoder = new TextEncoder();

const CHUNK_END = encoder.encode("\r\n");

/**
 * What one read of a body gave, in one piece: its data joined, and framed as
 * one chunk of the proxy's own when the body goes up in chunks. One piece
 * per read, whatever the app's chunks: a body of one-byte chunks was three
 * pieces a byte, each waiting in a queue on its own, counted as its few
 * bytes and costing some sixty: one call the budgets saw holding 2 MiB held
 * 80 MiB, and four took the process past the unit's 256 MiB, measured.
 */
export function onePiece(data: Uint8Array[], chunked: boolean): Uint8Array {
  const length = data.reduce((sum, each) => sum + each.length, 0);
  if (!chunked && data.length === 1) return data[0]!;
  const size = chunked ? encoder.encode(`${length.toString(16)}\r\n`) : new Uint8Array(0);
  const piece = new Uint8Array(size.length + length + (chunked ? 2 : 0));
  piece.set(size, 0);
  let at = size.length;
  for (const each of data) {
    piece.set(each, at);
    at += each.length;
  }
  if (chunked) piece.set(CHUNK_END, at);
  return piece;
}

export const LAST_CHUNK = encoder.encode("0\r\n\r\n");
