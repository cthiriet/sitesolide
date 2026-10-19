/**
 * A token's change of secrets, read: the dashboard reads it to refuse early,
 * the steward again before anything is judged. Pure.
 *
 * **Never a value in a message.** A refusal names a variable only when the
 * name already has a variable name's shape, and says "entry 3" otherwise: a
 * value pasted in a name's place would be quoted back, into a terminal, an
 * agent's context or a log. A value is never named at all, the reasons of
 * `checkValue` (src/secrets/envfile.ts) quote none.
 *
 * **Never an assignment into an object.** `set` arrives as an object, whose
 * keys are read with `Object.entries` into a list of pairs: `"__proto__"` is
 * a valid variable name, and assigning it into a plain object would change
 * that object's prototype instead of naming a variable.
 */
import { checkValue, MAX_KEY } from "../secrets/envfile";
import { MAX_SECRET_NAMES } from "./protocol";

/** The change, judged: every pair and every name once, set and removed never the same one. */
export type SecretsChange = { set: [string, string][]; remove: string[] };

/** A change as the steward hands it to the secrets routes, its project and file named. */
export type TokenSecretsChange = SecretsChange & { slug: string; file: string };

/** The shape `checkKey` accepts, before any rule on which names are reserved. */
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Has this the shape of a variable name? Only then may a message name it. */
export function isVariableName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY && NAME_SHAPE.test(value);
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

/**
 * `set` and `remove` as a request carries them, each optional, or the
 * refusal. Every name's shape and every value are judged here, all before any
 * is written; which names a project may set (reserved, set by its unit, a
 * password hash) is the steward's to judge, on the machine.
 */
export function readSecretsChange(set: unknown, remove: unknown): SecretsChange | { refusal: string } {
  if (set !== undefined && !isObject(set)) return { refusal: "set: an object of variable names and their values" };
  if (remove !== undefined && !Array.isArray(remove)) return { refusal: "remove: a list of variable names" };
  const pairs = set === undefined ? [] : Object.entries(set);
  const names = remove ?? [];
  if (pairs.length + names.length > MAX_SECRET_NAMES) {
    return { refusal: `${MAX_SECRET_NAMES} variable names at most in one change, set and removed together: split it` };
  }
  const written: [string, string][] = [];
  for (const [index, [name, value]] of pairs.entries()) {
    if (!isVariableName(name)) return { refusal: `set: entry ${index + 1} is not a variable name: letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most` };
    if (typeof value !== "string") return { refusal: `set: ${name}: the value must be a string` };
    const reason = checkValue(value);
    if (reason !== null) return { refusal: variableRefusal("set", name, reason) };
    written.push([name, value]);
  }
  const removed: string[] = [];
  for (const [index, name] of names.entries()) {
    if (!isVariableName(name)) return { refusal: `remove: entry ${index + 1} is not a variable name: letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most` };
    if (removed.includes(name)) return { refusal: `remove: ${name} is named twice` };
    if (written.some(([key]) => key === name)) return { refusal: `${name} is both set and removed: name it in one list` };
    removed.push(name);
  }
  return { set: written, remove: removed };
}
