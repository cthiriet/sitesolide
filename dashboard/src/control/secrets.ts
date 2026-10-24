/**
 * A change of a project's store, read: the dashboard reads it to refuse
 * early, the steward again before anything is judged. Pure.
 *
 * **Never a value in a message.** A refusal names a variable only when the
 * name already has a variable name's shape, and says "entry 3" otherwise: a
 * value pasted in a name's place would be quoted back, into a terminal, an
 * agent's context or a log. A value is never named at all, the reasons of
 * `checkValue` (bin/cli/variables.ts) quote none. A name that starts like a
 * provider's key, `sk_live_...`, has a variable name's shape and is a value
 * all the same: it is never quoted either, and the store refuses it as a name.
 *
 * **Never an assignment into an object.** `set` arrives as an object, whose
 * keys are read with `Object.entries` into a list of pairs: `"__proto__"` is
 * a valid variable name, and assigning it into a plain object would change
 * that object's prototype instead of naming a variable.
 */
import { checkValue, isVariableName, MAX_KEY, VALUE_LIKE_PREFIXES } from "../../borrowed/variables";
import { isValidFileName } from "../../borrowed/manifest";
import { GENERATE_FORMATS, GENERATE_MAX_BYTES, GENERATE_MIN_BYTES, MAX_STORE_FILE_BYTES, type GenerateFormat } from "../../borrowed/store";
import { MAX_SECRET_NAMES } from "./protocol";

/** The change, judged: every pair and every name once, set and removed never the same one. */
export type SecretsChange = { set: [string, string][]; remove: string[] };

/** Does this start like a provider's key, or Stripe's publishable one? A value, never a name. */
export function isValueLike(name: string): boolean {
  return VALUE_LIKE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** May a message quote this name? Only a variable name's shape that does not start like a key. */
export function isQuotable(name: unknown): name is string {
  return isVariableName(name) && !isValueLike(name);
}

/**
 * The refusal of one name, worded so that a name is quoted only once: the
 * reasons of `checkKey` that name the variable start with it.
 */
export function variableRefusal(list: "set" | "remove", name: string, reason: string): string {
  return reason.startsWith(`${name} `) ? `${list}: ${reason}` : `${list}: ${name}: ${reason}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_A_NAME = `letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most`;
const LIKE_A_KEY = "starts like a secret key, not a variable name: a value never goes in a name's place";

/**
 * `set` and `remove` as a request carries them, each optional, or the
 * refusal. Every name's shape and every value are judged here, all before any
 * is written; which names a project may set (reserved, set by its unit, a
 * password hash) is the steward's to judge, on the machine.
 *
 * A store's names are listed to every Developer of the project and
 * journaled for good: a name that starts like a key is refused, as the
 * manifest refuses it (bin/cli/manifest.ts), since a value pasted in a
 * name's place would become a name. It is never quoted.
 */
export function readSecretsChange(set: unknown, remove: unknown): SecretsChange | { refusal: string } {
  if (set !== undefined && !isObject(set)) return { refusal: "set: an object of variable names and their values" };
  if (remove !== undefined && !Array.isArray(remove)) return { refusal: "remove: a list of variable names" };
  const pairs = set === undefined ? [] : Object.entries(set);
  const names = remove ?? [];
  if (pairs.length + names.length > MAX_SECRET_NAMES) {
    return { refusal: `${MAX_SECRET_NAMES} variable names at most in one change, set and removed together: split it` };
  }
  const label = (name: string, index: number) => (isQuotable(name) ? name : `entry ${index + 1}`);
  const written: [string, string][] = [];
  for (const [index, [name, value]] of pairs.entries()) {
    if (!isVariableName(name)) return { refusal: `set: entry ${index + 1} is not a variable name: ${NOT_A_NAME}` };
    if (isValueLike(name)) return { refusal: `set: entry ${index + 1} ${LIKE_A_KEY}` };
    if (typeof value !== "string") return { refusal: `set: ${label(name, index)}: the value must be a string` };
    const reason = checkValue(value);
    if (reason !== null) return { refusal: variableRefusal("set", label(name, index), reason) };
    written.push([name, value]);
  }
  const removed: string[] = [];
  for (const [index, name] of names.entries()) {
    if (!isVariableName(name)) return { refusal: `remove: entry ${index + 1} is not a variable name: ${NOT_A_NAME}` };
    if (removed.includes(name)) return { refusal: `remove: ${label(name, index)} is named twice` };
    if (written.some(([key]) => key === name)) return { refusal: `${label(name, index)} is both set and removed: name it in one list` };
    removed.push(name);
  }
  return { set: written, remove: removed };
}

/** A value drawn on the machine, as a request asks for it. Never a value: the steward draws it. */
export type GenerateAsk = { name: string; format?: GenerateFormat; bytes?: number; replace?: boolean };

/**
 * A generate request's fields, or the refusal: the name a variable's and not
 * a key's, the format one of two, the size within the bounds. The steward
 * judges again which names a project may set.
 */
export function readGenerate(name: unknown, format: unknown, bytes: unknown, replace: unknown): GenerateAsk | { refusal: string } {
  if (!isVariableName(name)) return { refusal: `name: not a variable name: ${NOT_A_NAME}` };
  if (isValueLike(name)) return { refusal: `name: ${LIKE_A_KEY}` };
  if (format !== undefined && !GENERATE_FORMATS.includes(format as GenerateFormat)) return { refusal: `format: ${GENERATE_FORMATS.join(" or ")}` };
  if (bytes !== undefined && (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < GENERATE_MIN_BYTES || bytes > GENERATE_MAX_BYTES)) {
    return { refusal: `bytes: a whole number between ${GENERATE_MIN_BYTES} and ${GENERATE_MAX_BYTES}` };
  }
  if (replace !== undefined && typeof replace !== "boolean") return { refusal: "replace must be true or false" };
  return {
    name,
    ...(format === undefined ? {} : { format: format as GenerateFormat }),
    ...(bytes === undefined ? {} : { bytes: bytes as number }),
    ...(replace === undefined ? {} : { replace }),
  };
}

/** The refusal of a store file's name, which never quotes it: a value may sit in a URL's place too. */
export const FILE_NAME_REFUSAL = "the file's name: letters, digits, dots, dashes and underscores, not starting with a dot, 64 characters at most, no `..`";

/** The shape of standard base64, padded: what `content` is, decoded strictly. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A store file's content as a request carries it, its bytes in base64, or
 * the refusal: standard base64 with its padding and nothing else, no line
 * break, 64 KiB at most once decoded. Its size, and the budget of every file
 * of the project together, are the steward's to judge again.
 */
export function readFileContent(content: unknown): Uint8Array | { refusal: string } {
  if (typeof content !== "string") return { refusal: "content: the file's bytes in base64" };
  // A first bound on the text itself, before anything is decoded.
  if (content.length > Math.ceil(MAX_STORE_FILE_BYTES / 3) * 4) return { refusal: `content: a file is ${MAX_STORE_FILE_BYTES / 1024} KiB at most` };
  if (!BASE64.test(content)) return { refusal: "content: the file's bytes in base64, padded, without line breaks" };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(content, { lastChunkHandling: "strict" });
  } catch {
    return { refusal: "content: the file's bytes in base64, padded, without line breaks" };
  }
  if (bytes.byteLength > MAX_STORE_FILE_BYTES) return { refusal: `content: a file is ${MAX_STORE_FILE_BYTES / 1024} KiB at most` };
  return bytes;
}

/** A store file's name, or the refusal, which does not quote it. */
export function readFileName(name: unknown): string | { refusal: string } {
  return isValidFileName(name) ? name : { refusal: FILE_NAME_REFUSAL };
}

/**
 * The strings of a request a relay must never send back: the values set and
 * the content of a file, and that content decoded when it is text, as a
 * steward copying a request by mistake could quote either.
 */
export function withheldOf(values: readonly string[], content: string | null = null): string[] {
  const withheld = [...values];
  if (content !== null) {
    withheld.push(content);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.fromBase64(content));
      for (const line of text.split("\n")) if (line.trim() !== "") withheld.push(line.trim());
    } catch {
      // Bytes that are not text: the base64 alone stands for them.
    }
  }
  return withheld;
}
