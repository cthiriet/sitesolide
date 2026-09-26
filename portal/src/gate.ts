/**
 * What the gate decides: does a cookie open this host, is an origin its own,
 * where to send back after login.
 *
 * Pure: no disk, no network, no clock. Everything arrives as a parameter,
 * which makes every refusal checkable without a server.
 *
 * ## The cookie
 *
 * Two forms, signed by an HMAC-SHA256:
 *
 * - `<expiration>.<signature>` for the owner, over the host and the
 *   expiration. Nothing is kept on the server side, the cookie is enough on
 *   its own;
 * - `<expiration>.<guest>.<signature>` for a guest, the identifier of their
 *   access entering into the signature. The gate then re-reads the access on
 *   every request: deleting it closes from the next one on, without waiting
 *   for the cookie.
 *
 * It is only worth anything for the host that received it, which the browser
 * already guarantees through the `__Host-` prefix and which the signature
 * guarantees again should a compromised site replay it elsewhere.
 *
 * The key mixes a draw kept in the data folder and the hash of the
 * password: changing the password invalidates every cookie in circulation,
 * the guests' included, and erasing the draw does too.
 */
import { isValidId } from "./guests";

/** Size of the draw kept in the data folder. */
export const KEY_BYTES = 32;

/** Bytes of a guest access identifier: 16 characters in base64url. */
const ID_BYTES = 12;

/** The methods that change nothing, and that therefore escape the Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `__Host-` is imposed by the browser: it refuses the cookie if it is not
 * `Secure`, on `Path=/` and without `Domain`. On plain HTTP it would not even
 * be recorded, hence the second name.
 */
export function cookieName(online: boolean): string {
  return online ? "__Host-portal" : "portal";
}

/**
 * The signing key. `null` without a hash: a badly configured portal
 * signs nothing, therefore recognizes nobody. It never opens.
 */
export function deriveKey(seed: Uint8Array, hash: string): Uint8Array | null {
  if (hash === "" || seed.length < KEY_BYTES) return null;
  const hmac = new Bun.CryptoHasher("sha256", seed);
  hmac.update(hash);
  return hmac.digest();
}

/**
 * The signed text. The owner and the guest do not sign the same one: a token
 * of one does not turn into a token of the other by removing or adding a
 * piece. `|` can appear neither in a host nor in an identifier, so the two
 * forms are never confused.
 */
function sign(key: Uint8Array, host: string, expiration: number, guest: string | null): string {
  const hmac = new Bun.CryptoHasher("sha256", key);
  hmac.update(guest === null ? `${host}|${expiration}` : `${host}|${expiration}|${guest}`);
  return hmac.digest("base64url");
}

export function issueToken(key: Uint8Array, host: string, expiration: number, guest: string | null = null): string {
  const signature = sign(key, host, expiration, guest);
  return guest === null ? `${expiration}.${signature}` : `${expiration}.${guest}.${signature}`;
}

/** Who carries a valid token: the owner, or the named guest access. */
export type Bearer = { guest: string | null };

/**
 * Does the token open this host, right now, and for whom?
 *
 * An expiration further out than the duration in force is refused: shortening
 * `COOKIE_DURATION_S` must take effect on the cookies already issued, not only on
 * the following ones.
 *
 * For a guest, that is only half the answer: the access must still exist and
 * not have lapsed, which only the database knows.
 */
export function readToken(
  token: string | null,
  key: Uint8Array | null,
  host: string,
  nowS: number,
  durationS: number,
): Bearer | null {
  if (token === null || key === null) return null;

  const parts = token.split(".");
  if (parts.length !== 2 && parts.length !== 3) return null;

  const rawExpiration = parts[0]!;
  if (!/^[0-9]{1,12}$/.test(rawExpiration)) return null;

  const expiration = Number(rawExpiration);
  if (expiration <= nowS || expiration > nowS + durationS) return null;

  const guest = parts.length === 3 ? parts[1]! : null;
  if (guest !== null && !isValidId(guest)) return null;

  const expected = Buffer.from(sign(key, host, expiration, guest));
  const received = Buffer.from(parts[parts.length - 1]!);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  return { guest };
}

/** The identifier of a new guest access, which will travel in its cookie. */
export function generateId(
  randomSource: (bytes: number) => Uint8Array = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
): string {
  return Buffer.from(randomSource(ID_BYTES)).toString("base64url");
}

/**
 * The hash under which the database keeps a guest password. A SHA-256
 * is enough for a randomly drawn password: see `guests.ts`.
 */
export function guestHash(password: string): string {
  return new Bun.CryptoHasher("sha256").update(password).digest("hex");
}

/**
 * The host as Caddy announces it through `X-Portal-Hote`, set by `header_up`
 * and therefore never by the visitor. It signs the cookie and serves as the
 * reference for the Origin: whatever does not have the shape of a host name is
 * refused.
 */
export function isValidHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
  );
}

/**
 * The token read from the Cookie header. An exact name comparison, never an
 * inclusion: a cookie named `trapportal` must not pass for ours.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * `SameSite=Lax` rather than `Strict`: a link received by SMS or by email
 * towards a protected site must open it directly. What `Strict` would have
 * added, the Origin covers, see `isAcceptableRequest`.
 */
export function setCookie(token: string, online: boolean, durationS: number): string {
  return [
    `${cookieName(online)}=${token}`,
    "Path=/",
    `Max-Age=${durationS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(online ? ["Secure"] : []),
  ].join("; ");
}

/** The same cookie, empty and expired: logout erases rather than forgets. */
export function clearCookie(online: boolean): string {
  return setCookie("", online, 0);
}

/**
 * Is the origin the host's own? Its absence is refused: every current browser
 * sets one on a request that changes a state. The port is not compared, the
 * machine only exposing 80 and 443, and the first one redirects.
 */
export function isAcceptableOrigin(origin: string | null, host: string, online: boolean): boolean {
  if (origin === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null", what an isolated iframe sets
  }
  if (url.hostname !== host) return false;
  return url.protocol === "https:" || (!online && url.protocol === "http:");
}

/**
 * Does a request carrying a good cookie get through? Yes, unless it changes a
 * state from another origin.
 *
 * This is the CSRF protection of every protected site, which they no longer
 * have to write. It counts because another subdomain of the zone is, to the
 * browser, the same site: `SameSite`, `Lax` as much as `Strict`, would let
 * through a POST coming from a client's preview. The Origin does not.
 */
export function isAcceptableRequest(method: string, origin: string | null, host: string, online: boolean): boolean {
  return SAFE_METHODS.has(method.toUpperCase()) || isAcceptableOrigin(origin, host, online);
}

/**
 * Where to send back after login. A path of the same host and nothing else:
 * `//elsewhere.test` and `/\elsewhere.test` are absolute addresses to a browser, and
 * making one the target of a redirect would open the gate to any site at all.
 * The portal's own paths lead back to the home page, where the gate would
 * otherwise send them back in a loop.
 */
export function safeReturnTo(returnTo: unknown): string {
  if (typeof returnTo !== "string" || returnTo.length === 0 || returnTo.length > 2048) return "/";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.startsWith("/\\")) return "/";
  if (/[\x00-\x1f\x7f]/.test(returnTo)) return "/";
  if (returnTo.startsWith("/_portal/")) return "/";
  return returnTo;
}

/** The return is only remembered for a requested page: a refused POST is not replayed. */
export function returnForRequest(method: string, uri: string | null): string {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? safeReturnTo(uri) : "/";
}

/**
 * The headers of every response from the gate.
 *
 * `no-store` as an overwrite: Caddy's `(commun)` snippet sets a one year cache
 * on `*.ico` and `*.png` by default, and the login page served at the icon's
 * address would otherwise stay in the browser long after login. `X-Portal`
 * tells this 401 apart from a preview lock, for the CLI as much as for a
 * site's front end, which reloads the page on seeing it.
 *
 * `img-src data:` for the page's icon, in `data:` like the rest: nothing loads
 * from anywhere else.
 */
export function doorHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Portal": "connexion",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
}
