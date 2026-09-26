/**
 * A visitor's fingerprint: what replaces the cookie.
 *
 * Counting visitors means recognising the same browser from one page to the
 * next. A cookie would do it, at the price of a consent banner on every
 * measured site, and of an identifier that would follow the visitor for
 * months. Here the identity is recomputed on every page view from what the
 * request already carries, with a salt that changes every day:
 *
 *     fingerprint = HMAC-SHA256(salt of the day, host | IP address | agent)
 *
 * Three properties follow from it, and each one counts:
 *
 * - **nothing that served to compute it is kept.** Neither the IP address nor
 *   the user agent enters the database; the fingerprint alone does;
 * - **the salt dies after two days.** While it exists, whoever holds the
 *   database can check that a given address visited a site; afterwards nothing
 *   ties the fingerprint to anything at all any more, and the data stops being
 *   personal;
 * - **the host is part of the calculation**, so the same visitor has a
 *   different fingerprint on each measured site. Nothing allows following them
 *   from one customer to the next, and that is what separates this measurement
 *   from an ad network.
 *
 * It is also what lets measured sites do without a banner: the CNIL exempts
 * audience measurement that serves only that, cross-references nothing and
 * identifies nobody. Modifying this file means touching that exemption.
 *
 * Pure: the salt is given, never read here. `src/db.ts` draws it and destroys
 * it.
 */

/** 32 bytes, that is 256 bits, in base64url. A salt is drawn like a key. */
export const SALT_BYTES = 32;

export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandomSource: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

export function generateSalt(randomSource: RandomSource = defaultRandomSource): string {
  const bytes = randomSource(SALT_BYTES);
  if (bytes.length < SALT_BYTES) {
    throw new Error(`randomness source too short: ${bytes.length} bytes`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Length of the fingerprint kept, in hexadecimal characters.
 *
 * Sixteen bytes out of the digest's thirty-two. The rest would only make the
 * database heavier: a collision here is counted between visitors of one same
 * site on one same day, that is a few thousand values against 2^128.
 */
export const FINGERPRINT_LENGTH = 32;

/**
 * A visitor's fingerprint, for one site and one day.
 *
 * The three parts are separated by a vertical bar, which appears neither in a
 * host nor in an IP address: without a separator, two different visitors could
 * compose the same string.
 */
export function computeFingerprint(salt: string, host: string, ip: string, agent: string): string {
  return new Bun.CryptoHasher("sha256", salt)
    .update(`${host}|${ip}|${agent}`)
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * The visitor's address, as Caddy reports it: **the last** value of
 * `X-Forwarded-For`, never the first.
 *
 * A proxy appends to that header, it does not replace it. A visitor who sends
 * `X-Forwarded-For: 192.0.2.1` therefore has Caddy pass on `192.0.2.1, <their real
 * address>`: reading the first value means reading what the visitor wrote.
 * Anyone could then give themselves one address per page and count for as many
 * visitors, or worse, take someone else's fingerprint by guessing theirs.
 *
 * The last value is the one the last proxy placed, and that last proxy is
 * Caddy, on the same machine. There is no proxy after it.
 *
 * **A site put behind Cloudflare's proxy would be the exception**, and there is
 * none today: the zone is `proxied = false`, and customers' own domains go
 * through a certificate issued on demand, which presupposes that DNS points at
 * the machine. If one of them switched, the last value would become the address
 * of a Cloudflare node and all its visitors would carry the same fingerprint,
 * so a single visit per day. The symptom shows in the dashboard, many page
 * views for one visit, and the fix is not to trust `CF-Connecting-IP`: that
 * header is forged in one line of `curl` as long as nothing checks that the
 * request really comes from Cloudflare, and trusting it would make anyone's
 * fingerprint choosable.
 */
export function clientAddress(xffHeader: string | null, fallback: string): string {
  if (xffHeader === null) return fallback;
  const parts = xffHeader.split(",");
  const last = parts[parts.length - 1]?.trim() ?? "";
  return last === "" ? fallback : last;
}
