/**
 * The steward's unlocking: the rate limiting of the attempts and the token.
 *
 * Pure, clock as a parameter: every transition returns a new state and is
 * checked to the millisecond without waiting ten minutes. The verification of
 * the password stays outside (`isPasswordValid` of src/auth.ts), this module
 * decides only what surrounds it.
 *
 * The token lives in the steward's memory and nowhere else: a restart locks
 * everything. The rate limiting, for its part, survives the restart. A
 * compromised dashboard can bring the steward down for want of memory, and
 * Restart=always relaunches it at once: a counter in memory would go back to
 * zero each time, that is of the order of 130,000 attempts a day instead of 24.
 * It is therefore written into STATE_FOLDER before every verification, and
 * re-read at startup.
 */
import { remainingWait, TOLERATED_FAILURES } from "../auth";
import { tokenHash, generateToken, type RandomSource } from "../sessions";
import { parseEnv, envValue } from "./envfile";
import type { FileInfo } from "./scope";
import { UNLOCK_DURATION_MS } from "./protocol";

export type UnlockState = {
  failures: number;
  lastFailureAt: number;
  /**
   * A single live token, kept by its hash: a dump of the process's memory does
   * not yield a usable token.
   */
  token: { hash: string; expiresAt: number } | null;
};

export const INITIAL_STATE: UnlockState = { failures: 0, lastFailureAt: 0, token: null };

/** Milliseconds before the next permitted attempt, zero if the way is clear. */
export function wait(state: UnlockState, now: number): number {
  return remainingWait(state.failures, state.lastFailureAt, now);
}

/**
 * A wrong password. The token in force is not revoked: a failed attempt by
 * somebody else must not close the session of whoever unlocked.
 */
export function attemptRefused(state: UnlockState, now: number): UnlockState {
  return { ...state, failures: state.failures + 1, lastFailureAt: now };
}

/**
 * The right password: a new token, which replaces the old one, and the failure
 * counter back to zero. The token in the clear lives only in the returned value.
 */
export async function attemptAccepted(
  state: UnlockState,
  now: number,
  random?: RandomSource,
): Promise<{ state: UnlockState; token: string; expiresAt: number }> {
  const token = generateToken(random);
  const expiresAt = now + UNLOCK_DURATION_MS;
  return {
    state: { ...state, failures: 0, lastFailureAt: 0, token: { hash: await tokenHash(token), expiresAt } },
    token,
    expiresAt,
  };
}

/** Cap on a submitted token: 32 bytes in base64url make 43 characters. */
const MAX_TOKEN = 128;

/**
 * True if the token is the one that lives and it has not expired. The expiry
 * falls at the millisecond `expiresAt` included, and use does not push it back.
 */
export async function isValidToken(state: UnlockState, submitted: unknown, now: number): Promise<boolean> {
  if (state.token === null) return false;
  if (typeof submitted !== "string" || submitted.length === 0 || submitted.length > MAX_TOKEN) return false;
  if (now >= state.token.expiresAt) return false;
  // Comparing hashes rather than the tokens: the comparison time then tells
  // only about a hash, from which one does not go back to the token.
  return (await tokenHash(submitted)) === state.token.hash;
}

export function revoke(state: UnlockState): UnlockState {
  return { ...state, token: null };
}

/**
 * The password's hash, read in the dashboard's file, re-read on every attempt:
 * a rotation then counts for the unlocking with no other action.
 *
 * Returns the empty string on a file that is missing, out of management or
 * without `PASSWORD_HASH`, and `isPasswordValid` then refuses everyone. The
 * steward never opens for want of configuration.
 */
export function hashFrom(text: string | null): string {
  if (text === null) return "";
  const parsed = parseEnv(text);
  if (!parsed.ok) return "";
  return envValue(parsed.document, "PASSWORD_HASH") ?? "";
}

// --- Rate limiting on disk ---------------------------------------------------

export type RateLimitRead = { kind: "absent" } | { kind: "read"; text: string } | { kind: "unreadable" };

/**
 * Enough failures to reach the one-hour cap whatever the doubling:
 * 5 s x 2^31 goes far beyond it.
 */
export const SAFETY_FAILURES = TOLERATED_FAILURES + 32;

export function encodeRateLimit(state: UnlockState): string {
  return `${JSON.stringify({ failures: state.failures, lastFailureAt: state.lastFailureAt })}\n`;
}

/**
 * The rate limiting re-read at startup. A missing file is a first startup:
 * zero. A file that is unreadable or malformed is not guessed at: maximal rate
 * limiting, out of caution, counting from now. An hour closed is worth more
 * than a counter that an abrupt stop at the right moment would set back to
 * zero.
 */
export function readRateLimit(reading: RateLimitRead, now: number): { failures: number; lastFailureAt: number } {
  if (reading.kind === "absent") return { failures: 0, lastFailureAt: 0 };
  const caution = { failures: SAFETY_FAILURES, lastFailureAt: now };
  if (reading.kind === "unreadable") return caution;

  let object: unknown;
  try {
    object = JSON.parse(reading.text);
  } catch {
    return caution;
  }
  const { failures, lastFailureAt } = (object ?? {}) as Record<string, unknown>;
  if (typeof failures !== "number" || !Number.isSafeInteger(failures) || failures < 0) return caution;
  if (typeof lastFailureAt !== "number" || !Number.isFinite(lastFailureAt) || lastFailureAt < 0) return caution;
  // A date in the future, the clock having gone back since, would lengthen the
  // wait beyond the cap: it is brought back to now.
  return { failures, lastFailureAt: Math.min(lastFailureAt, now) };
}

// --- The hash's file ---------------------------------------------------------

/**
 * Why the file that carries PASSWORD_HASH must not serve, or null.
 *
 * The hash opens every secret of the scope. Readable by site-dashboard, a
 * compromised dashboard would read it and try offline, with neither rate
 * limiting nor log. It must therefore belong to root alone, with no bit at all
 * for the group nor for the others: the dashboard does not need it, systemd
 * passes it to it through its environment by reading the file under root.
 */
export function hashFileRefusal(info: FileInfo, expectedUid: number): string | null {
  if (info.link || !info.regular) return "not a regular file";
  if (info.links > 1) return "several hard links";
  if (info.uid !== expectedUid) return `owned by uid ${info.uid}, not ${expectedUid === 0 ? "root" : `uid ${expectedUid}`}`;
  if ((info.mode & 0o7077) !== 0) return `mode ${info.mode.toString(8).padStart(3, "0")} opens it beyond root`;
  return null;
}
