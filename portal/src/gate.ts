/**
 * What the gate decides: does a cookie open this host, is an origin its own,
 * where to send back after login.
 *
 * Pure: no disk, no network, no clock. Everything arrives as a parameter,
 * which makes every refusal checkable without a server.
 *
 * ## The cookie
 *
 * Three forms, signed by an HMAC-SHA256:
 *
 * - `<expiration>.<signature>` for the owner, over the host and the
 *   expiration. Nothing is kept on the server side, the cookie is enough on
 *   its own;
 * - `<expiration>.<guest>.<signature>` for a guest, the identifier of their
 *   access entering into the signature. The gate then re-reads the access on
 *   every request: deleting it closes from the next one on, without waiting
 *   for the cookie;
 * - `<expiration>.id.<identity>.<signature>` for someone who signed in with
 *   the identity provider, `<identity>` being their verified email and name
 *   in base64url JSON. The gate then re-reads the site's sharing policy on
 *   every request, which is what makes removing someone immediate.
 *
 * The first two are the forms from before identities, unchanged: the cookies
 * in circulation on the machine stay valid. A portal rolled back to an older
 * version refuses the third, four pieces where it expects two or three, and
 * shows the sign-in page.
 *
 * It is only worth anything for the host that received it, which the browser
 * already guarantees through the `__Host-` prefix and which the signature
 * guarantees again should a compromised site replay it elsewhere.
 *
 * The key mixes a draw kept in the data folder and the hash of the
 * password: changing the password invalidates every cookie in circulation,
 * the guests' included, and erasing the draw does too.
 */
import { isAccessId, type Role } from "./access";
import { cleanEmail } from "./sharing";

/** Size of the draw kept in the data folder. */
export const KEY_BYTES = 32;

/** The methods that change nothing, and that therefore escape the Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `__Host-` is imposed by the browser: it refuses the cookie if it is not
 * `Secure`, on `Path=/` and without `Domain`. On plain HTTP it would not even
 * be recorded, hence the second name.
 *
 * `suffix` names the sign-in flow's own cookies, `-sso` for instance, which
 * follow the same rule: `__Host-portal-sso`, never readable by a sibling host.
 */
export function cookieName(online: boolean, suffix = ""): string {
  return online ? `__Host-portal${suffix}` : `portal${suffix}`;
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

/**
 * The identity form signs four pieces where the guest's signs three, with the
 * literal `id` between: since neither a host nor an identifier nor a base64url
 * text can carry a `|`, no token of one form is a token of another.
 */
function signIdentity(key: Uint8Array, host: string, expiration: number, payload: string): string {
  const hmac = new Bun.CryptoHasher("sha256", key);
  hmac.update(`${host}|${expiration}|${IDENTITY_MARK}|${payload}`);
  return hmac.digest("base64url");
}

export function issueToken(key: Uint8Array, host: string, expiration: number, guest: string | null = null): string {
  const signature = sign(key, host, expiration, guest);
  return guest === null ? `${expiration}.${signature}` : `${expiration}.${guest}.${signature}`;
}

/** The piece that names the third form. */
const IDENTITY_MARK = "id";

/** Beyond this, a display name is cut: it travels in a cookie and in a header. */
export const NAME_MAX = 200;

/** Someone the identity provider vouched for: an email it verified, and a name when it gave one. */
export type Identity = { email: string; name: string | null };

/**
 * A display name fit for a cookie and a header, or `null`: without a control
 * character, trimmed, cut at `NAME_MAX` characters. A line break in a name
 * would otherwise become a header of its own.
 *
 * Cut on code points, and made well formed: `slice` counts UTF-16 units, and
 * cutting `😀` in half left a lone surrogate, on which `encodeURIComponent`
 * throws. The person whose provider sent that name then got a 500 from
 * `/verifier` on every request of every site. A lone surrogate the provider
 * sent itself becomes U+FFFD the same way.
 */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.toWellFormed().replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const cleaned = Array.from(trimmed).slice(0, NAME_MAX).join("").trim();
  return cleaned === "" ? null : cleaned;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(text: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(text)) return null;
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** An identity read back from JSON, judged again rather than trusted. */
function identityFrom(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null) return null;
  const { e, n } = value as Record<string, unknown>;
  const email = cleanEmail(e);
  if (email === null || email !== e) return null;
  if (n !== null && (typeof n !== "string" || cleanName(n) !== n)) return null;
  return { email, name: n };
}

export function issueIdentityToken(key: Uint8Array, host: string, expiration: number, identity: Identity): string {
  const payload = encodeJson({ e: identity.email, n: identity.name });
  return `${expiration}.${IDENTITY_MARK}.${payload}.${signIdentity(key, host, expiration, payload)}`;
}

/**
 * Who carries a valid token: the owner, the named guest access, or, with
 * `identity`, someone the identity provider vouched for. `guest` stays the
 * field it was, so that the owner still reads `{ guest: null }`.
 */
export type Bearer = { guest: string | null; identity?: Identity };

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
  identityDurationS: number = durationS,
): Bearer | null {
  if (token === null || key === null) return null;

  const parts = token.split(".");
  if (parts.length < 2 || parts.length > 4) return null;

  const rawExpiration = parts[0]!;
  if (!/^[0-9]{1,12}$/.test(rawExpiration)) return null;

  const expiration = Number(rawExpiration);
  const longest = parts.length === 4 ? identityDurationS : durationS;
  if (expiration <= nowS || expiration > nowS + longest) return null;

  const received = Buffer.from(parts[parts.length - 1]!);

  if (parts.length === 4) {
    if (parts[1] !== IDENTITY_MARK) return null;
    const payload = parts[2]!;
    const expected = Buffer.from(signIdentity(key, host, expiration, payload));
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
    // Read only once the signature holds: a forged payload never reaches
    // JSON.parse, and what the portal signed is judged again all the same.
    const identity = identityFrom(decodeJson(payload));
    return identity === null ? null : { guest: null, identity };
  }

  const guest = parts.length === 3 ? parts[1]! : null;
  if (guest !== null && !isAccessId(guest)) return null;

  const expected = Buffer.from(sign(key, host, expiration, guest));
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  return { guest };
}

// --- Sealed tokens ---------------------------------------------------------------

/**
 * A key for one purpose, drawn from the cookie key: the sign-in flow's tokens
 * never verify as a cookie, nor the other way round, and they fall with it
 * when the password changes.
 */
export function purposeKey(key: Uint8Array, purpose: string): Uint8Array {
  return new Bun.CryptoHasher("sha256", key).update(`sitesolide-portal|${purpose}`).digest();
}

/**
 * `<payload>.<signature>`, the payload a JSON object in base64url: what the
 * sign-in flow hands to a browser to carry from one host to the other, and
 * reads back unchanged. Signed, not encrypted: nothing in it is hidden from
 * the person whose browser carries it.
 */
export function seal(key: Uint8Array, value: object): string {
  const payload = encodeJson(value);
  return `${payload}.${new Bun.CryptoHasher("sha256", key).update(payload).digest("base64url")}`;
}

/** The object sealed with this key, or `null`. Its fields are for the caller to judge. */
export function unseal(key: Uint8Array, token: string | null): Record<string, unknown> | null {
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = Buffer.from(new Bun.CryptoHasher("sha256", key).update(parts[0]!).digest("base64url"));
  const received = Buffer.from(parts[1]!);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  const value = decodeJson(parts[0]!);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An identity carried in a sealed token, judged like the cookie's. */
export function readIdentity(value: unknown): Identity | null {
  return identityFrom(value);
}

/**
 * The hash a password access is found by. A SHA-256 is enough for a password
 * drawn at random: see src/access.ts.
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
 * What a protected block announces in `X-Portal-Hote`: the host the visitor
 * asked for, then, from the block of a site's own domain, a space and the
 * site's address under the zone.
 *
 * - `host` is the browser's: it signs the cookie, checks the Origin, and is
 *   where a sign-in sends back;
 * - `site` is whose people decide: the steward's projection files them under
 *   the site's address, and a domain is not one. A preview block announces
 *   its host alone, which is both.
 *
 * Both from the one header every protected block overwrites, deployed before
 * domains could be guarded or after, never from a second header a block from
 * before would let a visitor send (announcedFor in bin/cli/portal.ts).
 * Lowercase, as the projection and the cookies are; null for anything else,
 * which opens nothing.
 */
export function readAnnounced(header: string | null): { host: string; site: string } | null {
  const names = (header ?? "").toLowerCase().split(" ");
  if (names.length > 2) return null;
  const [host = "", site = host] = names;
  return isValidHost(host) && isValidHost(site) ? { host, site } : null;
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
export function setCookie(token: string, online: boolean, durationS: number, suffix = ""): string {
  return [
    `${cookieName(online, suffix)}=${token}`,
    "Path=/",
    `Max-Age=${durationS}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(online ? ["Secure"] : []),
  ].join("; ");
}

/** The same cookie, empty and expired: logout erases rather than forgets. */
export function clearCookie(online: boolean, suffix = ""): string {
  return setCookie("", online, 0, suffix);
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

/**
 * The headers that tell a protected site who is in. `bin/cli/portal.ts`
 * copies these same names onto the request with `copy_headers`, and
 * bin/tests/cli-portal.test.ts checks that the two lists agree.
 */
export const IDENTITY_HEADERS = {
  user: "X-Sitesolide-User",
  name: "X-Sitesolide-User-Name",
  role: "X-Sitesolide-Role",
} as const;

/**
 * What a 200 from `/verifier` carries: the role always, the verified email and
 * the name when the provider gave them. A header is absent rather than empty
 * when the portal does not know: the owner's password and a guest's name
 * nobody.
 *
 * The name is percent-encoded UTF-8: a header carries bytes, and `Zoë` or
 * `李` would reach the site garbled, or not at all. `decodeURIComponent`
 * gives it back. The email needs nothing: `cleanEmail` keeps it ASCII.
 *
 * `toWellFormed` again, though `cleanName` already did it: `encodeURIComponent`
 * throws on nothing else, and this function runs on every request of every
 * protected site, where a throw is a 500 nobody can sign their way out of.
 */
export function identityHeaders(role: Role, identity: Identity | null): Record<string, string> {
  const headers: Record<string, string> = { [IDENTITY_HEADERS.role]: role };
  if (identity !== null) {
    headers[IDENTITY_HEADERS.user] = identity.email;
    if (identity.name !== null) headers[IDENTITY_HEADERS.name] = encodeURIComponent(identity.name.toWellFormed());
  }
  return headers;
}

/** The door's headers on the portal's own host, which is no protected site: no `X-Portal`. */
export function pageHeaders(): Record<string, string> {
  const { "X-Portal": _, ...rest } = doorHeaders();
  return rest;
}
