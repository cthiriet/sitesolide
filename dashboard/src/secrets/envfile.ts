/**
 * Reading and rewriting a file that systemd loads through `EnvironmentFile=`.
 *
 * Pure: text comes in, text comes out. The steward rewrites a file only if this
 * module knows how to re-read it exactly as systemd will read it, and otherwise
 * leaves it out of management: listed, never rewritten, until it is fixed by
 * hand.
 *
 * ## What systemd 257 does
 *
 * Read in src/basic/env-file.c (`parse_env_file_internal`, a state machine with
 * PRE_KEY, KEY, PRE_VALUE, VALUE, single and double quotes, COMMENT), then
 * measured on 16 September 2026 on Debian 13 and systemd 257.13 by a witness
 * unit that copies out its environment: the bench results,
 * measurement 1, whose case numbers are taken up here.
 *
 *   1. A comment starts with `#` or `;` at the start of a line only, after any
 *      whitespace. After a value, `#` and `;` are text, even after a closing
 *      quote: `A="x" # finish` is worth `x# finish` (o05-o07).
 *   2. Without quotes, everything is literal (`$`, `` ` ``, `=`, `#`) except
 *      the backslash, which takes the next character and glues the next line on
 *      after a newline (n01, m02, m06). Trailing whitespace removed.
 *   3. Inside single quotes, everything is literal up to the next quote,
 *      newline included. No escaping at all (q01-q09).
 *   4. Inside double quotes, `\` before `"`, `\`, `` ` `` or `$` yields that
 *      character; before a newline, it eats it; before any other character,
 *      both remain (d02-d07). Nothing is expanded (e01, e02).
 *   5. After a closing quote, reading resumes: `A='x'y` is worth `xy`.
 *   6. `A=`, `A=''` and `A=""` all three set the empty string (s02, q08, d11).
 *   7. `\r` ends a line outside quotes (r04), and stays in a value inside
 *      quotes (r05, r06).
 *   8. A duplicate key: the last one wins (u01). An invalid name (`export A`)
 *      is set aside with a line in the log, the rest of the file is read (c01).
 *   9. **One invalid byte loses the whole file** (x03, x06, z04, z05). Invalid
 *      UTF-8 or a null byte, wherever it is: under `EnvironmentFile=-`, the
 *      form of the generated units, the service starts with NOT ONE variable
 *      from the file, valid lines included. The log reports it for UTF-8
 *      (`invalid UTF-8 value for key`), and says nothing at all for the null
 *      byte.
 *  10. A comment ending with `\` is not continued (o08).
 *
 * The round trip of `encodeValue` on 31 trap values is identical byte for
 * byte (at00-at30).
 *
 * ## What this module accepts: a narrow subset
 *
 * A line is empty, a comment, or `KEY=value` with no whitespace at the front
 * nor around the `=`, with a value on one line:
 *
 *   - without quotes, without whitespace, quote or backslash;
 *   - entirely inside single quotes;
 *   - entirely inside double quotes, with the four escapes of rule 4 and no
 *     others;
 *   - followed by trailing whitespace, tolerated.
 *
 * All the rest puts the file out of management, including what systemd would
 * read without flinching (`A = b`, `A='x'y`, `\n` inside double quotes): what
 * this module does not know how to rewrite identically, it does not touch.
 */

import { RESERVED_ENV } from "../../borrowed/manifest";

// --- The document ------------------------------------------------------------

export type EnvLine =
  | { kind: "empty"; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "assignment"; key: string; value: string; raw: string };

/** The lines in the file's order. A line left untouched keeps its raw text. */
export type EnvDocument = { lines: EnvLine[] };

export type EnvParse =
  | { ok: true; document: EnvDocument }
  | { ok: false; line: number; reason: string };

// --- The bounds --------------------------------------------------------------

/** A longer variable name is a mistake, not a need. */
export const MAX_KEY = 128;

/** 8 KiB in UTF-8 bytes. A PEM key fits in base64 on one line. */
export const MAX_VALUE_BYTES = 8 * 1024;

const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What is written without quotes and re-read identically, with no exception. */
const SAFE_RAW = /^[A-Za-z0-9_@%+=:,./-]*$/;

/** The only characters systemd unescapes inside double quotes. */
const ESCAPES = new Set(['"', "\\", "`", "$"]);

/**
 * The names that change the way the runtime behaves, and not what the site
 * does: `LD_PRELOAD` loads a library into the process, `HTTPS_PROXY` sends its
 * TLS traffic through a third party, `NODE_TLS_REJECT_UNAUTHORIZED` makes it
 * blind to a forged certificate. Whole families rather than a list of names:
 * the next variable of Node or of glibc will not have to be added here to be
 * refused.
 *
 * Compared without regard to case: `http_proxy` is worth `HTTP_PROXY` for curl,
 * and `Path` must not get through where `PATH` is refused.
 */
export const RESERVED_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZDIR",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "NOTIFY_SOCKET",
  "MAINPID",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "CREDENTIALS_DIRECTORY",
  "RUNTIME_DIRECTORY",
  "STATE_DIRECTORY",
  "CACHE_DIRECTORY",
  "LOGS_DIRECTORY",
  "CONFIGURATION_DIRECTORY",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "LANGUAGE",
  "TERM",
  "NO_PROXY",
];
export const RESERVED_PREFIXES = [
  "LD_",
  "BUN_",
  "NODE_",
  "NPM_",
  "PYTHON",
  "PERL",
  "RUBY",
  "JAVA_",
  "SSL_",
  "OPENSSL_",
  "GCONV_",
  "GLIBC_",
  "MALLOC_",
  "XDG_",
  "BASH_",
  "SYSTEMD_",
  "LISTEN_",
  "WATCHDOG_",
  "LC_",
];
export const RESERVED_SUFFIXES = ["_PROXY"];

const encoder = new TextEncoder();

// --- Reading -----------------------------------------------------------------

/**
 * Strict decoding, before the parsing: an invalid UTF-8 byte makes systemd
 * ignore the whole file (rule 9), and a tolerant decoding would replace it with
 * U+FFFD, which the rewriting would then carve in.
 */
export function parseEnvBytes(bytes: Uint8Array): EnvParse {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, line: 0, reason: "the file is not valid UTF-8, systemd would ignore all of it" };
  }
  return parseEnv(text);
}

/**
 * The reasons never quote the content of a line: a malformed line may be a
 * token pasted in the wrong place, and the reason is displayed.
 */
export function parseEnv(text: string): EnvParse {
  if (text.startsWith("\uFEFF")) {
    return { ok: false, line: 1, reason: "byte order mark at the start of the file" };
  }

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const document: EnvDocument = { lines: [] };
  const seen = new Set<string>();

  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    const refusal = (reason: string): EnvParse => ({ ok: false, line: number, reason });

    if (raw.includes("\0")) return refusal("null byte");
    // Outside quotes, systemd takes \r for an end of line (rule 7).
    if (raw.includes("\r")) return refusal("carriage return, the file has Windows line endings");

    if (/^[ \t]*$/.test(raw)) {
      document.lines.push({ kind: "empty", raw });
      continue;
    }

    if (/^[ \t]*[#;]/.test(raw)) {
      // Continued before systemd 254, no longer after: the discrepancy is not
      // settled here.
      if (raw.endsWith("\\")) return refusal("comment ending with a backslash");
      document.lines.push({ kind: "comment", raw });
      continue;
    }

    const equal = raw.indexOf("=");
    if (equal === -1) return refusal("neither a comment nor KEY=value");

    const key = raw.slice(0, equal);
    if (/^[ \t]/.test(key)) return refusal("whitespace before the variable name");
    if (/^export[ \t]/.test(key)) return refusal("`export` is shell syntax, systemd drops this line");
    if (/[ \t]$/.test(key)) return refusal("whitespace before `=`");
    if (!KEY_SHAPE.test(key) || key.length > MAX_KEY) return refusal("invalid variable name");
    if (seen.has(key)) return refusal(`${key} is set twice`);

    const value = decodeValue(raw.slice(equal + 1));
    if (typeof value !== "string") return refusal(value.reason);

    seen.add(key);
    document.lines.push({ kind: "assignment", key, value, raw });
  }

  return { ok: true, document };
}

function decodeValue(remaining: string): string | { reason: string } {
  if (/^[ \t]/.test(remaining)) return { reason: "whitespace after `=`" };

  // Trailing whitespace is tolerated, outside the quotes as systemd removes it
  // from a bare value (rule 2) or skips it after a closing quote.
  const body = remaining.replace(/[ \t]+$/, "");
  if (body === "") return "";

  if (body.startsWith("'")) {
    const finish = body.indexOf("'", 1);
    if (finish === -1) return { reason: "unterminated single quote" };
    if (finish !== body.length - 1) return { reason: "text after the closing quote" };
    return body.slice(1, finish);
  }

  if (body.startsWith('"')) {
    let value = "";
    for (let i = 1; i < body.length; i++) {
      const c = body[i]!;
      if (c === '"') {
        if (i !== body.length - 1) return { reason: "text after the closing quote" };
        return value;
      }
      if (c === "\\") {
        const next = body[i + 1];
        if (next === undefined) return { reason: "unterminated double quote" };
        // Before another character, systemd keeps both, unlike a shell for
        // `\n`: too ambiguous to be rewritten without surprise.
        if (!ESCAPES.has(next)) return { reason: "unsupported escape inside double quotes" };
        value += next;
        i++;
        continue;
      }
      value += c;
    }
    return { reason: "unterminated double quote" };
  }

  if (/[ \t'"\\]/.test(body)) {
    return { reason: "unquoted value with whitespace, a quote or a backslash" };
  }
  return body;
}

// --- Consultation ------------------------------------------------------------

export function keys(document: EnvDocument): string[] {
  const found: string[] = [];
  for (const line of document.lines) {
    if (line.kind === "assignment") found.push(line.key);
  }
  return found;
}

export function envValue(document: EnvDocument, key: string): string | null {
  for (const line of document.lines) {
    if (line.kind === "assignment" && line.key === key) return line.value;
  }
  return null;
}

// --- Writing rules -----------------------------------------------------------

/** Why a name is reserved, or null. */
export function reservedReason(key: string): string | null {
  // The variables the unit generator sets, borrowed and not copied out: the
  // CLI's list is authoritative.
  if (RESERVED_ENV.includes(key)) return `${key} is set by the deployment, a secret would move the service elsewhere`;
  const uppercase = key.toUpperCase();
  const reserved =
    RESERVED_NAMES.includes(uppercase) ||
    RESERVED_PREFIXES.some((prefix) => uppercase.startsWith(prefix)) ||
    RESERVED_SUFFIXES.some((suffix) => uppercase.endsWith(suffix));
  return reserved ? `${key} changes how the runtime behaves, not what the site does, and cannot be set here` : null;
}

/**
 * The reason for a refusal, or null. `setByUnit`: what the unit sets
 * through `Environment=`, which a file read by `EnvironmentFile=` would
 * overwrite without anything reporting it, `PORT` or `DATA_DIR` included.
 */
export function checkKey(key: string, setByUnit: Iterable<string> = []): string | null {
  if (key.length === 0) return "the variable name is empty";
  if (key.length > MAX_KEY) return `the variable name is longer than ${MAX_KEY} characters`;
  if (!KEY_SHAPE.test(key)) return "letters, digits and underscores, not starting with a digit";
  const reserved = reservedReason(key);
  if (reserved !== null) return reserved;
  for (const set of setByUnit) {
    if (set === key) return `${key} is set by the service unit, a secret would silently override it`;
  }
  return null;
}

/** The reason for a refusal, or null. None of them quotes the value. */
export function checkValue(value: string): string | null {
  if (value.includes("\n") || value.includes("\r")) return "the value must fit on one line";
  if (value.includes("\0")) return "the value contains a null byte";
  // A lone surrogate half would be encoded as U+FFFD: what was written would
  // not be what was typed in.
  if (!value.isWellFormed()) return "the value is not valid Unicode";
  if (encoder.encode(value).length > MAX_VALUE_BYTES) return "the value is larger than 8 KiB";
  return null;
}

// --- Writing -----------------------------------------------------------------

/**
 * The simplest form that is re-read identically: bare if nothing in it is
 * special, inside single quotes otherwise (no escaping to hold), inside double
 * quotes only if the value itself contains a single quote.
 */
export function encodeValue(value: string): string {
  if (SAFE_RAW.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/["\\`$]/g, (c) => `\\${c}`)}"`;
}

/**
 * Sets or replaces a variable. An existing key keeps its place, a new key goes
 * to the end. Throws on a malformed key or value: the steward judged them
 * beforehand, and a newline written here would add a variable nobody asked for.
 */
export function set(document: EnvDocument, key: string, value: string): EnvDocument {
  if (!KEY_SHAPE.test(key) || key.length > MAX_KEY) throw new Error("malformed variable name");
  if (checkValue(value) !== null) throw new Error("malformed value");

  const raw = `${key}=${encodeValue(value)}`;
  const fresh: EnvLine = { kind: "assignment", key, value, raw };

  let replaced = false;
  const lines = document.lines.map((line) => {
    if (line.kind === "assignment" && line.key === key) {
      replaced = true;
      return fresh;
    }
    return line;
  });
  if (!replaced) lines.push(fresh);
  return { lines };
}

/** Removes a variable without touching its neighbours, the comment above included. */
export function remove(document: EnvDocument, key: string): EnvDocument {
  return { lines: document.lines.filter((line) => !(line.kind === "assignment" && line.key === key)) };
}

/** The text, ended by a newline. An empty document returns an empty file. */
export function serialise(document: EnvDocument): string {
  if (document.lines.length === 0) return "";
  return `${document.lines.map((line) => line.raw).join("\n")}\n`;
}

// --- The unit that reads the file --------------------------------------------

export type UnitEnvFile = { path: string; optional: boolean };

export type UnitEnvironment = {
  /** The names set by `Environment=`, in the [Service] section. */
  keys: string[];
  /**
   * The values set by `Environment=`, in order. A service that opens its own
   * secrets itself finds them through one of them:
   * `SECRETS_DIR=/etc/sitesolide/<slug>-secrets`.
   */
  values: string[];
  files: UnitEnvFile[];
};

/**
 * What a unit sets and reads, extracted from its text (main file and `.d/*.conf`
 * extensions put end to end).
 *
 * Generous rather than exact on `Environment=`: one name too many only refuses
 * a key, a forgotten name would let a secret overwrite `PORT`. An empty
 * assignment resets the list to zero, as systemd does.
 */
export function unitEnvironment(text: string): UnitEnvironment {
  const keys = new Set<string>();
  const values: string[] = [];
  const files: UnitEnvFile[] = [];
  let section = "";

  // A line ending with `\` is continued on the next one.
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      section = header[1]!;
      continue;
    }
    if (section !== "Service") continue;

    const equal = line.indexOf("=");
    if (equal === -1) continue;
    const directive = line.slice(0, equal).trim();
    const value = line.slice(equal + 1).trim();

    if (directive === "Environment") {
      if (value === "") {
        keys.clear();
        values.length = 0;
        continue;
      }
      for (const word of words(value)) {
        const separator = word.indexOf("=");
        if (separator <= 0) continue;
        keys.add(word.slice(0, separator));
        values.push(word.slice(separator + 1));
      }
    } else if (directive === "EnvironmentFile") {
      if (value === "") {
        files.length = 0;
        continue;
      }
      const optional = value.startsWith("-");
      files.push({ path: optional ? value.slice(1) : value, optional });
    }
  }

  return { keys: [...keys], values, files };
}

/** The words of a directive, single and double quotes removed, `\` taking the next letter. */
function words(value: string): string[] {
  const found: string[] = [];
  let current = "";
  let inWord = false;
  let quote: string | null = null;

  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && i + 1 < value.length) {
      current += value[++i];
      inWord = true;
    } else if (quote !== null) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) found.push(current);
      current = "";
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) found.push(current);
  return found;
}
