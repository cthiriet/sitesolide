/**
 * The rate limiting of failed authentications on the control API.
 *
 * **Per address, unlike the dashboard's sign-in.** The sign-in counts globally
 * because the dashboard has one user (src/auth.ts): changing address would
 * sidestep a per-address counter, and an attacker locking the owner out for an
 * hour is a price an internal tool pays. Here there are as many holders as
 * tokens, and a global counter would let anyone lock the whole team out with a
 * few wrong guesses. Guessing a token is hopeless anyway, 256 random bits: what
 * this stops is the noise, and the steward's work for nothing.
 *
 * The schedule is the sign-in's (`remainingWait`): three failures tolerated,
 * then five seconds doubling up to an hour. The address is the one Caddy puts
 * in `X-Forwarded-For`, and only Caddy reaches this port (the loopback rule):
 * see clientAddress for which one of its values.
 *
 * In memory, bounded: a restart forgets, which costs an attacker nothing he
 * could not get by waiting, and the table never grows past `MAX_ADDRESSES`.
 */
import { remainingWait } from "../auth";

export const MAX_ADDRESSES = 10_000;

export type Limiter = {
  /** Milliseconds before this address may try again, zero if it may now. */
  wait: (address: string) => number;
  failure: (address: string) => void;
  success: (address: string) => void;
};

export function createLimiter(clock: () => number = Date.now, max = MAX_ADDRESSES): Limiter {
  const failures = new Map<string, { count: number; lastAt: number }>();
  return {
    wait(address) {
      const entry = failures.get(address);
      return entry === undefined ? 0 : remainingWait(entry.count, entry.lastAt, clock());
    },
    failure(address) {
      const entry = failures.get(address) ?? { count: 0, lastAt: 0 };
      failures.delete(address);
      // Reinserted last: the oldest entry is the first the map returns.
      failures.set(address, { count: entry.count + 1, lastAt: clock() });
      while (failures.size > max) failures.delete(failures.keys().next().value as string);
    },
    success(address) {
      failures.delete(address);
    },
  };
}

/**
 * The client's address as Caddy gives it: **the last** value of
 * `X-Forwarded-For`, or a fixed key when there is no Caddy in front
 * (development).
 *
 * Measured on Caddy 2.11.4, a client sending `X-Forwarded-For: 192.0.2.1`
 * through a `reverse_proxy`: with no `trusted_proxies`, the dashboard receives
 * the peer's address alone, the client's value discarded; with
 * `trusted_proxies` covering the peer, it receives `192.0.2.1, <peer>`, the
 * client's value kept in front. The generated dashboard block and the
 * Caddyfile configure no `trusted_proxies` today, so the first value and the
 * last are the same. The last is read all the same: it is the one Caddy
 * itself appends in both configurations, and the first would let anyone
 * choose their address, and someone else's wait, the day a proxy is trusted.
 */
export function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const last = forwarded?.split(",").at(-1)?.trim() ?? "";
  return last === "" ? "direct" : last.slice(0, 64);
}
