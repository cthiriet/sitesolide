/**
 * The rate limiting of members' sign-ins, beside the owner's password
 * counter, counted per client too (src/auth.ts).
 *
 * - **Per identity**: three refusals tolerated for one email, then five
 *   seconds doubling up to an hour, the password's rule. An address the
 *   registry does not name cannot keep the steward busy, and one person who
 *   was removed and keeps trying blocks nobody else. Ten sign-ins in ten
 *   minutes at most for one email, refused or not: each one opens a session.
 * - **Per client**: sixty sign-ins a minute from one address (an IPv6 one
 *   by its /64, `clientKey`), counted before the portal is asked to redeem
 *   the code. A sign-in already costs a round trip through the identity
 *   provider; beyond that, something is replaying codes, and the next minute
 *   is soon enough. Per client and not for the whole machine: a single
 *   counter let anyone with a made-up cookie keep every member out.
 *
 * In memory: a restart forgets it, and costs whoever floods one sign-in at
 * the provider per attempt anyway. Pure apart from its maps, its clock a
 * parameter.
 */
import { remainingWait } from "../auth";

export const ATTEMPTS_PER_WINDOW = 10;
export const WINDOW_MS = 10 * 60 * 1000;
export const CLIENT_PER_MINUTE = 60;
/** Identities, and clients, remembered at most; past it, the oldest are forgotten. */
export const MAX_IDENTITIES = 10_000;

export type SignInLimiter = {
  /** Milliseconds before this client may sign in again, zero when the way is clear. Counts the attempt. */
  client: (client: string, now: number) => number;
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
  const clients = new Map<string, { minute: number; count: number }>();

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
    client(client, now) {
      const current = Math.floor(now / 60_000);
      let kept = clients.get(client);
      if (kept === undefined || kept.minute !== current) {
        clients.delete(client);
        if (clients.size >= MAX_IDENTITIES) {
          for (const [key, one] of clients) if (one.minute !== current) clients.delete(key);
          while (clients.size >= MAX_IDENTITIES) clients.delete(clients.keys().next().value!);
        }
        kept = { minute: current, count: 0 };
        clients.set(client, kept);
      }
      if (kept.count >= CLIENT_PER_MINUTE) return (current + 1) * 60_000 - now;
      kept.count++;
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
