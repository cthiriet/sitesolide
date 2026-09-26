/** What decides that a submitted password opens a session. */

/**
 * Rate limiting after a failure, doubled each time, capped at one hour.
 *
 * The counter is global rather than per address: this site has a single user,
 * and an attacker who changes address would bypass a per-IP counter for free.
 * In exchange he can shut the door on us for an hour, which an internal tool
 * puts up with.
 */
export const TOLERATED_FAILURES = 3;
export const INITIAL_BACKOFF_MS = 5_000;
export const MAXIMUM_BACKOFF_MS = 60 * 60 * 1000;

/** Milliseconds to wait before the next attempt, zero if the way is clear. */
export function remainingWait(failures: number, lastAt: number, now: number): number {
  if (failures <= TOLERATED_FAILURES) return 0;

  const power = failures - TOLERATED_FAILURES - 1;
  const rateLimit = Math.min(INITIAL_BACKOFF_MS * 2 ** power, MAXIMUM_BACKOFF_MS);
  const remaining = lastAt + rateLimit - now;
  return remaining > 0 ? remaining : 0;
}

/**
 * Returns `false` rather than throwing on a missing or malformed hash: a badly
 * configured service refuses everyone, it never opens.
 */
export async function isPasswordValid(submitted: string, hash: string): Promise<boolean> {
  if (hash === "" || submitted === "") return false;
  try {
    return await Bun.password.verify(submitted, hash);
  } catch {
    return false; // truncated hash, or in an unknown format
  }
}

/**
 * The cap is not a password policy: argon2id works in proportion to what it is
 * given, and a megabyte would be enough to tie up the process.
 */
export const PASSWORD_MAX = 256;

export function isAcceptableSubmission(submitted: unknown): submitted is string {
  return typeof submitted === "string" && submitted.length > 0 && submitted.length <= PASSWORD_MAX;
}
