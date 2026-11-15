/**
 * The owner signs in to a restricted site with a passkey: the same passkey
 * that opens the dashboard, registered for the zone, so that one key serves
 * `dashboard.<zone>`, `portal.<zone>` and every `<slug>.<zone>`.
 *
 * ## Where the ceremony runs
 *
 * On the portal's own host, always, never on the site. A passkey answers
 * only a page whose host falls under the relying party it was registered
 * for: a site's own domain, `shop.example`, is not under the zone, and no
 * passkey of the zone signs there. The sign-in therefore goes through the
 * portal's host and comes back with a one-time code (src/handoff.ts):
 *
 * ```
 * site /_portal/passkey             binding cookie on the site, the flow sealed for that host
 *   -> portal /passkey?flow=...     the page: one button, the ceremony
 *      POST /passkey/options        a challenge, bound to this flow's binding
 *      POST /passkey/verify         the assertion verified, a one-time code minted
 *   -> site /_portal/passkey/complete?code=...   the code redeemed on that host, the owner's cookie set
 * ```
 *
 * A site under the zone and a site on its own domain take the same road, so
 * the passkey is offered on both. The site's page (src/page.ts) stays free of
 * script: the only script is the ceremony's, on the portal's host, allowed by
 * its hash.
 *
 * ## What it checks
 *
 * - **The public keys are the steward's.** It projects them into
 *   `/etc/sitesolide-portal/passkeys.json` (src/passkeys.ts), which this
 *   module reads again when it changes: a passkey removed in the dashboard
 *   no longer signs, and the cookies it opened close at their next request
 *   (the gate looks the cookie's reference up on every request).
 * - **The assertion**: its challenge, this portal's origin, the zone as
 *   relying party, the user present and verified (`userVerification:
 *   "required"`), a signature by a key the steward projected
 *   (src/webauthn.ts). The signature counter is not compared: the portal
 *   keeps none, the registry being root's, and a synced passkey has none
 *   anyway.
 * - **The flow, the binding, the code**: the flow names the host Caddy
 *   announced when it began; the code is redeemed once, within a minute, on
 *   that host, by the browser that holds the binding.
 * - **Bounded per client**: challenges and verifications per minute for each
 *   address Caddy saw, with a far higher ceiling for everyone together, so
 *   that one stranger's flood never keeps the owner out; the challenges in
 *   flight bounded, the failures recorded at most thirty a minute, and the
 *   codes in flight by the handoff store's own bounds.
 *
 * Built around its dependencies, like src/routes.ts.
 */
import { clientKey } from "../borrowed/auth";
import { recordQuietly, type AuditStore, type NewEvent } from "./database";
import {
  clearCookie,
  cookieName,
  doorHeaders,
  isValidHost,
  issuePasskeyToken,
  pageHeaders,
  purposeKey,
  readAnnounced,
  readCookie,
  safeReturnTo,
  seal,
  setCookie,
  unseal,
} from "./gate";
import { bindingHash, drawBinding, FLOW_DURATION_S, isBinding, type HandoffStore } from "./handoff";
import { passkeyPage, portalPage, signInPage } from "./page";
import { EMPTY_PASSKEYS, PASSKEYS_MAX_BYTES, passkeyRef, readPasskeyProjection, type PasskeyProjection, type ProjectedPasskey } from "./passkeys";
import { identityOf, readText, READ_RETRY_MS, type Read } from "./projection";
import { CHALLENGE_MS, Challenges, fromB64url, RateLimit, readPostedAssertion, Refused, verifyAssertion } from "./webauthn";

// --- The projection, read again when it changes --------------------------------

export type PasskeyReader = {
  /** The projection as it stands, or the empty one when it is missing or does not read. */
  current: () => PasskeyProjection;
  /** The projected passkey this cookie reference names, or null. */
  byRef: (ref: string) => ProjectedPasskey | null;
};

export type PasskeyReaderOptions = {
  file: string;
  log?: (line: string) => void;
  now?: () => number;
  read?: (path: string) => Read;
};

/**
 * One `lstat` per call when nothing moved, a read and a judgement when the
 * file did: the gate asks on every request of a site a passkey opened. A
 * file that does not read opens nothing by passkey, and is said once.
 */
export function createPasskeyReader(options: PasskeyReaderOptions): PasskeyReader {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  let seen: string | null = null;
  let failure: { identity: string; at: number } | null = null;
  let current: { projection: PasskeyProjection; refs: Map<string, ProjectedPasskey> } = { projection: EMPTY_PASSKEYS, refs: new Map() };
  let said: string | null = null;

  function say(state: string, line: string): void {
    if (said === state) return;
    said = state;
    log(line);
  }

  function refresh(): void {
    const identity = identityOf(options.file);
    if (identity === null) {
      seen = null;
      current = { projection: EMPTY_PASSKEYS, refs: new Map() };
      say("missing", "passkeys: none projected, the owner signs in to the sites with the password");
      return;
    }
    if (identity === seen) return;
    if (failure !== null && failure.identity === identity && now() - failure.at < READ_RETRY_MS) return;
    const text = (options.read ?? ((path: string) => readText(path, PASSKEYS_MAX_BYTES)))(options.file);
    if ("failed" in text) {
      failure = { identity, at: now() };
      current = { projection: EMPTY_PASSKEYS, refs: new Map() };
      say(`failed:${text.failed}`, `passkeys: ${options.file} could not be read (${text.failed}), read again in a few seconds`);
      return;
    }
    failure = null;
    seen = identity;
    const read = "refused" in text ? { unreadable: text.refused } : readPasskeyProjection(text.text);
    if ("unreadable" in read) {
      current = { projection: EMPTY_PASSKEYS, refs: new Map() };
      say(`unreadable:${identity}`, `passkeys: ${read.unreadable}, no passkey signs until the steward writes it again`);
      return;
    }
    current = { projection: read, refs: new Map(read.credentials.map((one) => [passkeyRef(one.id), one])) };
    say(`read:${read.writtenAt}`, `passkeys: ${read.credentials.length} of the owner's projected`);
  }

  return {
    current() {
      refresh();
      return current.projection;
    },
    byRef(ref) {
      refresh();
      return current.refs.get(ref) ?? null;
    },
  };
}

// --- Where the ceremony runs ----------------------------------------------------

/** RFC 6761 reserves `localhost` and every name under it for the loopback. */
function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * An address a browser may be sent to: HTTPS, or plain HTTP on the loopback
 * alone, for a workstation. Never a user and password in it, never a
 * fragment.
 */
export function isAcceptableUrl(text: unknown): text is string {
  if (typeof text !== "string" || text.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

/**
 * The portal's own origin and the zone, its relying party, from its address,
 * `https://portal.<zone>`; `rpId` (`PASSKEY_RP_ID`) for a portal whose address
 * does not start with `portal.`, and for the tests. null: no passkey is
 * offered, the portal not knowing where a ceremony could run.
 */
export function passkeyPlace(publicUrl: string, rpId?: string): { origin: string; rpId: string } | null {
  if (!isAcceptableUrl(publicUrl)) return null;
  const url = new URL(publicUrl);
  const explicit = (rpId ?? "").trim().toLowerCase();
  const zone = explicit !== "" ? explicit : url.hostname.startsWith("portal.") ? url.hostname.slice("portal.".length) : "";
  if (zone === "" || !isValidHost(zone)) return null;
  // WebAuthn's rule: the relying party is the page's host or one of its parents.
  if (url.hostname !== zone && !url.hostname.endsWith(`.${zone}`)) return null;
  return { origin: url.origin, rpId: zone };
}

// --- The flow ------------------------------------------------------------------

/** What travels from the site to the portal's host: the host to come back to, the path, the binding's hash. */
export type PasskeyFlow = { host: string; returnTo: string; binding: string };

export function issuePasskeyFlow(key: Uint8Array, flow: PasskeyFlow, nowS: number): string {
  return seal(purposeKey(key, "passkey-flow"), { h: flow.host, r: flow.returnTo, b: flow.binding, e: nowS + FLOW_DURATION_S });
}

export function readPasskeyFlow(key: Uint8Array, token: unknown, nowS: number): PasskeyFlow | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const fields = unseal(purposeKey(key, "passkey-flow"), token);
  if (fields === null) return null;
  const { h, r, b, e } = fields;
  if (typeof e !== "number" || e <= nowS || e > nowS + FLOW_DURATION_S) return null;
  if (typeof h !== "string" || !isValidHost(h)) return null;
  if (typeof r !== "string" || safeReturnTo(r) !== r) return null;
  if (!isBinding(b)) return null;
  return { host: h, returnTo: r, binding: b };
}

// --- The ceremony's script ------------------------------------------------------

/**
 * The page's one script, a constant: the flow is read from the button's
 * attribute. The Content-Security-Policy allows it by its hash and nothing
 * else, and its requests go to this host alone (`connect-src 'self'`).
 */
export const CEREMONY_SCRIPT = `(() => {
  const button = document.getElementById("passkey");
  const error = document.getElementById("passkey-error");
  const flow = button.dataset.flow;
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const text = (buffer) => {
    let binary = "";
    for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const say = (message) => {
    error.textContent = message;
    error.hidden = false;
    button.disabled = false;
  };
  const post = async (path, body) => {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { ok: response.ok, json };
  };
  if (!window.PublicKeyCredential || !navigator.credentials) {
    say("This browser can't use a passkey.");
    button.disabled = true;
    return;
  }
  button.addEventListener("click", async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      const options = await post("/passkey/options", { flow });
      if (!options.ok || options.json === null || typeof options.json.challengeId !== "string") {
        return say((options.json && options.json.message) || "The sign-in couldn't start. Go back to the site and try again.");
      }
      const asked = options.json.publicKey;
      const credential = await navigator.credentials.get({
        publicKey: { challenge: bytes(asked.challenge), rpId: asked.rpId, timeout: asked.timeout, userVerification: "required", allowCredentials: [] },
      });
      if (credential === null) return say("No passkey was chosen.");
      const response = credential.response;
      const verified = await post("/passkey/verify", {
        flow,
        challengeId: options.json.challengeId,
        credential: {
          id: credential.id,
          rawId: text(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: text(response.clientDataJSON),
            authenticatorData: text(response.authenticatorData),
            signature: text(response.signature),
            userHandle: response.userHandle === null ? null : text(response.userHandle),
          },
        },
      });
      if (verified.ok && verified.json && typeof verified.json.location === "string") {
        window.location.assign(verified.json.location);
        return;
      }
      say((verified.json && verified.json.message) || "The passkey was refused.");
    } catch (failure) {
      say(failure && failure.name === "NotAllowedError" ? "The passkey prompt was cancelled or timed out." : "This passkey can't be used here.");
    }
  });
})();`;

const SCRIPT_HASH = new Bun.CryptoHasher("sha256").update(CEREMONY_SCRIPT).digest("base64");

/** The ceremony page's headers: the door's, with its one script and its requests to this host. */
export function ceremonyHeaders(): Record<string, string> {
  return {
    ...pageHeaders(),
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-${SCRIPT_HASH}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  };
}

// --- The routes ------------------------------------------------------------------

export type PasskeySignInOptions = {
  /** `null` without a hash: nothing could be signed at the end. */
  key: Uint8Array | null;
  online: boolean;
  /** Where the ceremony runs (`passkeyPlace`); null, no passkey is offered. */
  place: { origin: string; rpId: string } | null;
  passkeys: PasskeyReader;
  handoffs: HandoffStore;
  audit?: AuditStore;
  /** The owner's cookie's life, the password's: thirty days. */
  cookieDurationS: number;
};

export type PasskeySignIn = {
  /** Is the passkey offered on a site's sign-in page, right now? */
  offered: () => boolean;
  begin: (req: Request) => Response;
  complete: (req: Request) => Response;
  page: (req: Request) => Response;
  options: (req: Request) => Promise<Response>;
  verify: (req: Request) => Promise<Response>;
};

/** The binding cookie of a passkey flow on the site. */
export const PASSKEY_BINDING_SUFFIX = "-passkey";

/**
 * Challenges asked for and assertions verified, per minute and per client: a
 * sign-in takes one of each. The ceilings for everyone together only bound
 * the work, and take a flood from dozens of addresses to reach.
 */
export const OPTIONS_PER_CLIENT = 20;
export const VERIFICATIONS_PER_CLIENT = 10;
export const OPTIONS_PER_MINUTE = 1_200;
export const VERIFICATIONS_PER_MINUTE = 600;

/** Challenges in flight at once: enough that a flood within the bounds above does not evict the owner's. */
const CHALLENGES_IN_FLIGHT = 2_000;

/** Failures recorded in the audit per minute, at most. */
const FAILURES_PER_MINUTE = 30;

/** The biggest body a ceremony posts: a flow and an assertion fit in a few kilobytes. */
const MAX_BODY_BYTES = 32 * 1024;

/** What the person reads for any refusal: the reason goes to the audit. */
const REFUSED = "This passkey can't sign in here. Use a passkey registered on this server's dashboard.";

function noStore(extra: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: noStore(extra) });
}

async function readSmallJson(req: Request): Promise<Record<string, unknown> | null> {
  const announced = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(announced) || announced > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createPasskeySignIn(options: PasskeySignInOptions, clock: () => number = Date.now): PasskeySignIn {
  const { online } = options;
  const challenges = new Challenges(CHALLENGES_IN_FLIGHT);
  const optionsRate = new RateLimit(OPTIONS_PER_CLIENT, OPTIONS_PER_MINUTE);
  const verifyRate = new RateLimit(VERIFICATIONS_PER_CLIENT, VERIFICATIONS_PER_MINUTE);
  let failures = { minute: -1, count: 0 };

  function audit(event: NewEvent, now: number): void {
    if (event.action === "portal.signin_failed") {
      const minute = Math.floor(now / 60_000);
      failures = failures.minute === minute ? { minute, count: failures.count + 1 } : { minute, count: 1 };
      if (failures.count > FAILURES_PER_MINUTE) return;
    }
    recordQuietly(options.audit, event, now);
  }

  /** The keys that may sign: the steward's, for this relying party, none otherwise. */
  function usable(): ProjectedPasskey[] {
    if (options.key === null || options.place === null) return [];
    const projection = options.passkeys.current();
    return projection.rpId === options.place.rpId ? projection.credentials : [];
  }

  const offered = () => usable().length > 0;

  function siteOrigin(host: string): string {
    return `${online ? "https" : "http"}://${host}`;
  }

  function page(status: number, title: string, message: string, back: { host: string; returnTo: string } | null, cookies: string[] = []): Response {
    const link = back === null ? null : { href: `${siteOrigin(back.host)}${back.returnTo}`, label: `Back to ${back.host}` };
    const headers = new Headers(noStore(pageHeaders()));
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(portalPage(title, message, link), { status, headers });
  }

  /** The site's sign-in page, the way back from every refusal on the site. */
  function door(returnTo: string, status: number, message: string, cookies: string[]): Response {
    const headers = new Headers(noStore(doorHeaders()));
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(signInPage(returnTo, message, offered()), { status, headers });
  }

  /** The flow of a request on the portal's host, with the Origin that must be this host's own. */
  async function ceremonyRequest(req: Request, rate: RateLimit): Promise<{ body: Record<string, unknown>; flow: PasskeyFlow; now: number } | Response> {
    if (options.key === null || options.place === null) return json({ error: "not-offered", message: "Passkeys aren't offered on this server." }, 404);
    if (req.headers.get("origin") !== options.place.origin) return json({ error: "origin-refused", message: "Origin not allowed." }, 403);
    const now = clock();
    const wait = rate.hit(clientKey(req.headers.get("x-forwarded-for")), now);
    if (wait > 0) return json({ error: "too-many-attempts", message: `Too many attempts. Try again in ${wait} s.` }, 429, { "Retry-After": String(wait) });
    const body = await readSmallJson(req);
    if (body === null) return json({ error: "invalid", message: REFUSED }, 400);
    const flow = readPasskeyFlow(options.key, body.flow, Math.floor(now / 1000));
    if (flow === null) return json({ error: "expired", message: "This sign-in has expired. Go back to the site and sign in again." }, 400);
    return { body, flow, now };
  }

  return {
    offered,

    begin(req) {
      const host = readAnnounced(req.headers.get("x-portal-hote"))?.host ?? null;
      if (host === null) return new Response("portal: unknown host", { status: 400, headers: noStore() });
      const returnTo = safeReturnTo(new URL(req.url).searchParams.get("retour"));
      if (options.key === null || options.place === null || !offered()) {
        return door(returnTo, 404, "Signing in with a passkey isn't available here.", []);
      }
      const now = clock();
      const binding = drawBinding();
      const flow = issuePasskeyFlow(options.key, { host, returnTo, binding: bindingHash(binding) }, Math.floor(now / 1000));
      return new Response(null, {
        status: 303,
        headers: (() => {
          const headers = new Headers(noStore({ Location: `${options.place!.origin}/passkey?${new URLSearchParams({ flow })}` }));
          headers.append("Set-Cookie", setCookie(binding, online, FLOW_DURATION_S, PASSKEY_BINDING_SUFFIX));
          return headers;
        })(),
      });
    },

    page(req) {
      if (options.key === null || options.place === null) return page(404, "Not available.", "Passkeys aren't offered on this server.", null);
      const sealed = new URL(req.url).searchParams.get("flow");
      const flow = readPasskeyFlow(options.key, sealed, Math.floor(clock() / 1000));
      if (sealed === null || flow === null) return page(400, "This sign-in link has expired.", "Go back to the site and sign in again.", null);
      const back = { href: `${siteOrigin(flow.host)}${flow.returnTo}`, label: `Back to ${flow.host}` };
      return new Response(passkeyPage(sealed, CEREMONY_SCRIPT, back), { status: 200, headers: noStore(ceremonyHeaders()) });
    },

    async options(req) {
      const asked = await ceremonyRequest(req, optionsRate);
      if (asked instanceof Response) return asked;
      if (!offered()) return json({ error: "not-offered", message: "No passkey is registered on this server yet." }, 404);
      const { id, challenge } = challenges.issue("portal", asked.now, asked.flow.binding);
      return json({
        challengeId: id,
        // Empty: a discoverable passkey, the authenticator offering those it
        // holds for the zone. No credential id is handed to a visitor.
        publicKey: { challenge, rpId: options.place!.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: [] },
      });
    },

    async verify(req) {
      const asked = await ceremonyRequest(req, verifyRate);
      if (asked instanceof Response) return asked;
      const { body, flow, now } = asked;
      const refuse = (reason: string): Response => {
        audit({ actor: "anonymous", action: "portal.signin_failed", target: flow.host, detail: { method: "passkey", reason } }, now);
        return json({ error: "refused", message: REFUSED }, 401);
      };
      const challenge = challenges.take(body.challengeId, "portal", now, flow.binding);
      if (challenge === null) return refuse("no-challenge");
      const posted = readPostedAssertion(body.credential);
      if (posted === null) return refuse("malformed");
      const stored = usable().find((one) => one.id === posted.id);
      if (stored === undefined) return refuse("unknown-passkey");
      const publicKey = fromB64url(stored.publicKey);
      if (publicKey === null) return refuse("unknown-passkey");
      try {
        await verifyAssertion(
          posted,
          { challenge, origin: options.place!.origin, rpId: options.place!.rpId },
          // The portal keeps no counter: zero is never compared.
          { publicKey, signCount: 0 },
        );
      } catch (error) {
        if (error instanceof Refused) return refuse(error.message);
        throw error;
      }

      const minting = options.handoffs.mint({ host: flow.host, binding: flow.binding, returnTo: flow.returnTo, passkey: passkeyRef(stored.id) }, now);
      if ("refusal" in minting) {
        return minting.refusal === "spent-flow"
          ? json({ error: "spent", message: "This sign-in link was already used. Go back to the site and sign in again." }, 400)
          : json({ error: "busy", message: "Too many sign-ins at once. Try again in a minute." }, 503);
      }
      return json({ location: `${siteOrigin(flow.host)}/_portal/passkey/complete?${new URLSearchParams({ code: minting.code })}` });
    },

    complete(req) {
      const announced = readAnnounced(req.headers.get("x-portal-hote"));
      if (announced === null) return new Response("portal: unknown host", { status: 400, headers: noStore() });
      const { host } = announced;
      if (options.key === null) return door("/", 404, "Signing in with a passkey isn't available here.", []);
      const now = clock();
      const spent = [clearCookie(online, PASSKEY_BINDING_SUFFIX)];
      const binding = readCookie(req.headers.get("cookie"), cookieName(online, PASSKEY_BINDING_SUFFIX));
      const redemption = options.handoffs.redeem(new URL(req.url).searchParams.get("code") ?? "", host, binding, now);
      if ("refusal" in redemption) {
        if (redemption.refusal !== "unknown-code") {
          audit({ actor: "anonymous", action: "portal.signin_failed", target: host, detail: { method: "passkey", reason: redemption.refusal } }, now);
        }
        return door("/", 400, "This sign-in link has expired or was opened in another browser. Sign in again.", spent);
      }
      const { returnTo, passkey } = redemption.handoff;
      // Removed between the ceremony and this redirect: nothing opens.
      if (options.passkeys.byRef(passkey) === null) {
        audit({ actor: "anonymous", action: "portal.signin_failed", target: host, detail: { method: "passkey", reason: "removed-passkey" } }, now);
        return door(returnTo, 401, "This passkey is no longer registered.", spent);
      }
      const expiration = Math.floor(now / 1000) + options.cookieDurationS;
      audit({ actor: "owner", action: "portal.signin", target: host, detail: { method: "passkey" } }, now);
      const headers = new Headers(noStore({ Location: returnTo }));
      for (const cookie of [...spent, setCookie(issuePasskeyToken(options.key, host, expiration, passkey), online, options.cookieDurationS)]) headers.append("Set-Cookie", cookie);
      return new Response(null, { status: 303, headers });
    },
  };
}

