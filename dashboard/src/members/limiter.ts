/**
 * The rate limiting of members' sign-ins, beside the owner's password
 * counter, which stays global (src/auth.ts).
 *
 * - **Per identity**: three refusals tolerated for one email, then five
 *   seconds doubling up to an hour, the password's rule. An address the
 *   registry does not name cannot keep the steward busy, and one person who
 *   was removed and keeps trying blocks nobody else. Ten sign-ins in ten
 *   minutes at most for one email, refused or not: each one opens a session.
 * - **For everyone**: sixty sign-ins a minute, the whole machine together. A
 *   sign-in already costs a round trip through the identity provider; beyond
 *   that, something is replaying codes, and the next minute is soon enough.
 *
 * In memory: a restart forgets it, and costs whoever floods one sign-in at
 * the provider per attempt anyway. Pure apart from its maps, its clock a
 * parameter.
 */
import { remainingWait } from "../auth";

export const ATTEMPTS_PER_WINDOW = 10;
export const WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_PER_MINUTE = 60;
/** Identities remembered at most; past it, the oldest are forgotten. */
export const MAX_IDENTITIES = 10_000;

export type SignInLimiter = {
  /** Milliseconds before anyone may sign in again, zero when the way is clear. Counts the attempt. */
  global: (now: number) => number;
  /** Milliseconds before this email may sign in again, zero when the way is clear. Counts the attempt. */
  identity: (email: string, now: number) => number;
  /** A refusal for this email: not a member, a sign-in too old. */
  refused: (email: string, now: number) => void;
  /** A session opened: the refusals of this email are forgotten. */
  succeeded: (email: string) => void;
};

type Record_ = { failures: number; lastFailureAt: number; attempts: number[] };

export function createSignInLimiter(): SignInLimiter {
  const identities = new Map<string, Record_>();
  let minute = -1;
  let count = 0;

  function recordOf(email: string): Record_ {
    let record = identities.get(email);
    if (record === undefined) {
      if (identities.size >= MAX_IDENTITIES) identities.delete(identities.keys().next().value!);
      record = { failures: 0, lastFailureAt: 0, attempts: [] };
      identities.set(email, record);
    }
    return record;
  }

  return {
    global(now) {
      const current = Math.floor(now / 60_000);
      if (current !== minute) {
        minute = current;
        count = 0;
      }
      if (count >= GLOBAL_PER_MINUTE) return (current + 1) * 60_000 - now;
      count++;
      return 0;
    },

    identity(email, now) {
      const record = recordOf(email);
      const wait = remainingWait(record.failures, record.lastFailureAt, now);
      if (wait > 0) return wait;
      record.attempts = record.attempts.filter((at) => now - at < WINDOW_MS);
      if (record.attempts.length >= ATTEMPTS_PER_WINDOW) return record.attempts[0]! + WINDOW_MS - now;
      record.attempts.push(now);
      return 0;
    },

    refused(email, now) {
      const record = recordOf(email);
      record.failures++;
      record.lastFailureAt = now;
    },

    succeeded(email) {
      const record = identities.get(email);
      if (record !== undefined) {
        record.failures = 0;
        record.lastFailureAt = 0;
      }
    },
  };
}
