/**
 * The session, decided and computed. This module opens no database: reading
 * and writing belong to `base.ts`, which makes every rule checkable without a
 * file.
 *
 * ## No anti-CSRF token, and that is a decision
 *
 * Four requests change something: signing in, signing out, and since 15
 * September 2026 the creation and the revocation of a guest access. All of
 * them demand the dashboard's exact Origin, and the cookie is SameSite=Strict.
 * A third-party page therefore obtains nothing: Strict holds the cookie back
 * outside the site, and the Origin refuses what comes from another subdomain
 * of the zone, which the browser holds to be the same site.
 *
 * A token drawn at random and kept in the session row would add nothing that
 * these two checks do not cover: it is exactly the protection the portal gives
 * the apps behind it, which write far more. The
 * question comes up again the day a button from here would touch Caddy or a
 * service, which guest access does not.
 */

const encoder = new TextEncoder();

/** 32 bytes, that is 256 bits. */
export const TOKEN_BYTES = 32;

export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

/** base64url: the token travels in a cookie. */
export function generateToken(random: RandomSource = defaultRandom): string {
  const bytes = random(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) {
    throw new Error(`random source too short: ${bytes.length} bytes`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The database keeps only the hash: a backup that leaks must not yield a single
 * usable session.
 */
export async function tokenHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type Session = {
  hash: string;
  createdAt: number;
  seenAt: number;
};

export function isSessionAlive(session: Session, durationMs: number, now: number): boolean {
  return now - session.createdAt < durationMs;
}

/**
 * True when the open sessions must fall, the password having changed.
 *
 * Without this check, changing the password would close nothing: the sessions
 * live in the database and survive the service restarting, so a rotation done
 * out of precaution would let in a browser that still has its cookie. That is
 * precisely the case where one wants the rotation to serve.
 *
 * Two refusals are worth naming, because each of them avoids a purge made in
 * error:
 *
 * - an empty hash is not a new password, it is a secret that has not arrived.
 *   Nobody can get in any more in any case, and signing everybody out would
 *   make the user pay for a configuration failure;
 * - at the first startup, nothing is known and there is nothing to purge.
 */
export function isRotationDetected(known: string | null, current: string): boolean {
  if (current === "") return false;
  if (known === null) return false;
  return known !== current;
}

/**
 * `__Host-` is imposed by the browser: it refuses the cookie if it is not
 * Secure, on Path=/ and without Domain. On plain HTTP on the workstation, it
 * would not even be recorded, hence the parameter.
 */
export function cookieName(online: boolean): string {
  return online ? "__Host-session" : "session";
}

/**
 * The Set-Cookie header returned as it stands. SameSite=Strict rather than
 * Lax: nothing leads here from an outside link, and the page reloads its data
 * itself once open, so the cookie goes back out on the request that counts.
 */
export function setCookie(token: string, online: boolean, durationMs: number): string {
  const attributes = [
    `${cookieName(online)}=${token}`,
    "Path=/",
    `Max-Age=${Math.floor(durationMs / 1000)}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(online ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

/** The same cookie, empty and expired: signing out erases rather than forgets. */
export function clearCookie(online: boolean): string {
  return [
    `${cookieName(online)}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(online ? ["Secure"] : []),
  ].join("; ");
}

/**
 * The token read in the Cookie header. An exact name comparison, never an
 * inclusion: a cookie named `trapsession` must not pass for ours.
 */
export function readCookie(header: string | null, online: boolean): string | null {
  if (header === null) return null;
  const sought = cookieName(online);

  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator === -1) continue;
    if (chunk.slice(0, separator).trim() !== sought) continue;
    const value = chunk.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * The origin, which the browser sets and which a third-party page cannot
 * forge. Its absence is refused: every current browser sets one on the
 * requests that change a state.
 */
export function isAcceptableOrigin(origin: string | null, publicUrl: string): boolean {
  if (origin === null) return false;
  return origin === publicUrl;
}
