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
 * - `<expiration>.pk.<passkey>.<signature>` for the owner signed in with a
 *   passkey, the passkey's reference entering into the signature. The gate
 *   looks it up on every request: a passkey removed closes what it opened.
 *
 * A cookie of the form a company account once received,
 * `<expiration>.id.<identity>.<signature>`, opens nothing any more: its
 * holder meets the sign-in page.
 *
 * It is only worth anything for the host that received it, which the browser
 * already guarantees through the `__Host-` prefix and which the signature
 * guarantees again should a compromised site replay it elsewhere.
 *
 * The key mixes a draw kept in the data folder and the hash of the
 * password: changing the password invalidates every cookie in circulation,
 * the guests' included, and erasing the draw does too.
 */
import { isAccessId } from "./access";
import { isPasskeyRef } from "./passkeys";

/** Size of the draw kept in the data folder. */
export const KEY_BYTES = 32;

/** The methods that change nothing, and that therefore escape the Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `__Host-` is imposed by the browser: it refuses the cookie if it is not
 * `Secure`, on `Path=/` and without `Domain`. On plain HTTP it would not even
 * be recorded, hence the second name.
 *
 * `suffix` names the passkey flow's own cookie, `-passkey`, which follows the
 * same rule: `__Host-portal-passkey`, never readable by a sibling host.
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

export function issueToken(key: Uint8Array, host: string, expiration: number, guest: string | null = null): string {
  const signature = sign(key, host, expiration, guest);
  return guest === null ? `${expiration}.${signature}` : `${expiration}.${guest}.${signature}`;
}

/** The piece that names the passkey's form. */
const PASSKEY_MARK = "pk";

/**
 * The owner's cookie when a passkey opened it: the owner's, as the first
 * form, with the passkey's reference (src/passkeys.ts) signed in. The gate
 * looks the reference up in the steward's projection of passkeys on every
 * request, so that a passkey removed closes every site it opened at the
 * next request, as a password access removed does. The literal `pk` keeps it
 * apart from any other form.
 */
function signPasskey(key: Uint8Array, host: string, expiration: number, ref: string): string {
  const hmac = new Bun.CryptoHasher("sha256", key);
  hmac.update(`${host}|${expiration}|${PASSKEY_MARK}|${ref}`);
  return hmac.digest("base64url");
}

export function issuePasskeyToken(key: Uint8Array, host: string, expiration: number, ref: string): string {
  return `${expiration}.${PASSKEY_MARK}.${ref}.${signPasskey(key, host, expiration, ref)}`;
}

/**
 * Who carries a valid token: the owner, or the named guest access. The owner
 * reads `{ guest: null }`; `passkey` names the owner's passkey when one
 * opened the cookie, which the gate checks is still registered.
 */
export type Bearer = { guest: string | null; passkey?: string };

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
  if (parts.length < 2 || parts.length > 4) return null;

  const rawExpiration = parts[0]!;
  if (!/^[0-9]{1,12}$/.test(rawExpiration)) return null;

  const expiration = Number(rawExpiration);
  if (expiration <= nowS || expiration > nowS + durationS) return null;

  const received = Buffer.from(parts[parts.length - 1]!);

  if (parts.length === 4) {
    // The passkey's form; the four pieces of a company account's cookie of
    // before open nothing.
    if (parts[1] !== PASSKEY_MARK) return null;
    const ref = parts[2]!;
    if (!isPasskeyRef(ref)) return null;
    const expected = Buffer.from(signPasskey(key, host, expiration, ref));
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
    return { guest: null, passkey: ref };
  }

  const guest = parts.length === 3 ? parts[1]! : null;
  if (guest !== null && !isAccessId(guest)) return null;

  const expected = Buffer.from(sign(key, host, expiration, guest));
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  return { guest };
}

// --- Sealed tokens ---------------------------------------------------------------

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
 * - `site` is whose accesses decide: the steward's projection files them under
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
 *
 * A WebSocket handshake is a GET and still needs the Origin: a page on a
 * sibling host opens one with the visitor's cookie, the same site again, and
 * unlike a GET's answer, which the browser keeps from that page, a socket's
 * messages are the page's to read. Every browser sends the Origin with a
 * handshake, so the site's own pages lose nothing.
 */
export function isAcceptableRequest(method: string, origin: string | null, host: string, online: boolean, handshake = false): boolean {
  return (SAFE_METHODS.has(method.toUpperCase()) && !handshake) || isAcceptableOrigin(origin, host, online);
}

/** The destinations of a document loaded inside another one. */
const FRAMED_DESTINATIONS = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/**
 * Is a protected site being loaded in a frame by a page of another origin?
 *
 * The answer to clickjacking of the protected sites, which serve the pages
 * of an app the owner or a guest is signed in to. From another site, the
 * frame already carries no cookie (`SameSite=Lax`) and shows the sign-in
 * page, which no page may frame (`doorHeaders`). From a sibling host of the
 * zone, the same site to a browser, it does carry the cookie, and a page
 * there could have the visitor click through the app. Refused here rather
 * than by a header in every block: the blocks in service need not be
 * deployed again, and the sites' own framing of themselves still works.
 *
 * Read from the `Sec-Fetch-*` headers every current browser sends and no
 * page can set; a request without them (an older browser, a script) is not
 * a frame this can tell, and goes through as before.
 */
export function isFramedElsewhere(headers: Headers): boolean {
  const destination = (headers.get("sec-fetch-dest") ?? "").toLowerCase();
  if (!FRAMED_DESTINATIONS.has(destination)) return false;
  const site = (headers.get("sec-fetch-site") ?? "").toLowerCase();
  return site !== "" && site !== "same-origin";
}

/**
 * Is this request the opening of a WebSocket? `Sec-WebSocket-Key` as much as
 * `Upgrade`: the second is a hop-by-hop header a proxy may drop on the way,
 * the first only a handshake carries, and a browser never lets a page set it.
 */
export function isWebSocketHandshake(headers: Headers): boolean {
  return headers.has("sec-websocket-key") || /\bwebsocket\b/i.test(headers.get("upgrade") ?? "");
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
    // frame-ancestors below for the browsers that read it, this for those
    // that do not: a sign-in page in another site's frame is a page whose
    // password field the visitor can be tricked into.
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
}

/**
 * The headers that tell a protected site who is in. `bin/cli/portal.ts`
 * strips these same names off every visitor's request and copies them from
 * the portal's answer with `copy_headers`, and bin/tests/cli-portal.test.ts
 * checks that the two lists agree. `user` and `name` once carried a company
 * account's verified email and name; the portal sets neither any more, and
 * the blocks in service still strip them, so that no visitor sends them to a
 * site that read them.
 */
export const IDENTITY_HEADERS = {
  user: "X-Sitesolide-User",
  name: "X-Sitesolide-User-Name",
  role: "X-Sitesolide-Role",
} as const;

/** Who came in, as `X-Sitesolide-Role` says it: the owner, or a password access. */
export type Role = "admin" | "visitor";

/** What a 200 from `/verifier` carries: the role, `admin` for the owner, `visitor` for a password access. */
export function identityHeaders(role: Role): Record<string, string> {
  return { [IDENTITY_HEADERS.role]: role };
}

/** The door's headers on the portal's own host, which is no protected site: no `X-Portal`. */
export function pageHeaders(): Record<string, string> {
  const { "X-Portal": _, ...rest } = doorHeaders();
  return rest;
}
