/** What decides that a submitted password opens a session. */

/**
 * Rate limiting after a failure, doubled each time, capped at one hour.
 *
 * The dashboard's sign-in counts it per client (`createClientLimiter`
 * below): a global counter let anyone on the Internet shut the owner out for
 * an hour, again and again. The steward's unlock keeps one counter, on disk,
 * for the owner: only a signed-in session reaches it.
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
 * Who a request comes from, for a rate limit: the last address of
 * `X-Forwarded-For`, the one Caddy saw. Caddy trusts no proxy in front of it,
 * so it replaces whatever a visitor sent in that header. An IPv6 address
 * counts by its /64, the block one subscriber holds: counting each address of
 * it would hand whoever holds one 2^64 counters. `unknown` without the
 * header, which only a test or `bun run dev` sends.
 */
export function clientKey(forwardedFor: string | null): string {
  const last = (forwardedFor ?? "").split(",").pop()?.trim().toLowerCase() ?? "";
  if (last === "" || last.length > 64) return "unknown";
  if (!last.includes(":")) return /^[0-9.]+$/.test(last) ? last : "unknown";
  const bare = last.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!/^[0-9a-f:.]+$/.test(bare)) return "unknown";
  const [head = "", tail = ""] = bare.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = bare.includes("::") ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Beyond this many clients counted at once, those whose wait has passed are forgotten, then the oldest. */
export const MAX_COUNTED_CLIENTS = 10_000;

/** Failures nobody added to for this long are forgotten. */
export const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

export type ClientLimiter = {
  /** Milliseconds this client waits before its next attempt, zero if the way is clear. */
  wait: (client: string, now: number) => number;
  failed: (client: string, now: number) => void;
  succeeded: (client: string) => void;
};

/**
 * The failures counted per client, with the backoff above: three tolerated,
 * then 5 s doubling up to an hour. Per client and not global: a global
 * counter let anyone on the Internet keep the owner out for an hour at a
 * time, for as long as they cared to send wrong passwords. Whoever guesses
 * from many addresses gets three tries per address before the wait, which a
 * passkey makes moot and a password of 24 drawn characters survives.
 * In memory, bounded: a restart forgets it.
 */
export function createClientLimiter(): ClientLimiter {
  const counts = new Map<string, { failures: number; lastAt: number }>();
  function current(client: string, now: number) {
    const kept = counts.get(client);
    if (kept === undefined || now - kept.lastAt >= FORGET_AFTER_MS) return { failures: 0, lastAt: 0 };
    return kept;
  }
  return {
    wait: (client, now) => {
      const kept = current(client, now);
      return remainingWait(kept.failures, kept.lastAt, now);
    },
    failed: (client, now) => {
      const kept = current(client, now);
      counts.delete(client);
      if (counts.size >= MAX_COUNTED_CLIENTS) {
        for (const [key, one] of counts) if (remainingWait(one.failures, one.lastAt, now) === 0) counts.delete(key);
        while (counts.size >= MAX_COUNTED_CLIENTS) counts.delete(counts.keys().next().value!);
      }
      counts.set(client, { failures: kept.failures + 1, lastAt: now });
    },
    succeeded: (client) => {
      counts.delete(client);
    },
  };
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
