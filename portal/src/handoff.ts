/**
 * What carries a sign-in from a protected site to the portal's own host and
 * back: the flow, the provider transaction, the portal's session, and the
 * one-time code that hands an identity to a site.
 *
 * ## Why a detour through the portal's host
 *
 * An identity provider redirects to addresses registered in advance, and a
 * site cannot be registered each time one is protected. The flow therefore
 * leaves from the site, goes through one fixed callback on `portal.<zone>`,
 * and comes back to the site with a code the portal redeems once, for that
 * host alone. Nothing relies on a cookie shared across the zone, which is why
 * a customer's domain would work the same way.
 *
 * ```
 * site /_portal/oidc            binding cookie on the site, flow sealed for it
 *   -> portal /oidc/start       transaction cookie on the portal's host
 *   -> provider                 the person signs in
 *   -> portal /oidc/callback    token verified, portal session, code minted
 *   -> site /_portal/oidc/complete?code=...   code redeemed, site cookie set
 * ```
 *
 * ## What each piece defends
 *
 * - **The flow** is sealed by the portal and names the host Caddy announced
 *   when the flow began: no other host can enter it, so no code is ever minted
 *   for a host this machine does not serve behind the portal.
 * - **The binding cookie** is drawn on the site when the flow begins and
 *   travels nowhere: the flow and the code carry its hash. A code is only
 *   redeemed by the browser that began the flow, so a link carrying someone
 *   else's code, sent to a victim, signs the victim in as nobody.
 * - **The transaction cookie** ties the provider's callback to the browser
 *   that went there, with `state`, and holds the nonce and the PKCE verifier:
 *   an authorization code stolen in transit is worth nothing elsewhere.
 * - **The code** lives sixty seconds, in this process's memory only, and is
 *   gone at the first attempt to redeem it, right or wrong.
 * - **A flow mints one code**, ever: replaying `/oidc/start` with the same
 *   flow and a portal session would otherwise mint a code per request, and
 *   one account filled the codes in flight for everyone. And one email holds
 *   `HANDOFF_PER_EMAIL` codes in flight at most, whatever its flows.
 *
 * The site's cookie never outlives the portal session that vouched for the
 * person: an account closed at the provider is out of every site within a day
 * of signing in there, not a day after the last site it reached.
 *
 * ## The dashboard takes the same road
 *
 * The dashboard is never behind the portal, and has no network: it cannot
 * talk to a provider, nor read the portal's settings. Its sign-in therefore
 * runs this very flow, with the dashboard's host in the place of a site's:
 *
 * ```
 * dashboard /api/sso/begin       binding cookie on the dashboard, flow sealed over the loopback
 *   -> portal /oidc/start        as for a site
 *   -> provider, portal /oidc/callback
 *   -> dashboard /api/sso/complete?code=...   code redeemed over the loopback
 * ```
 *
 * The code says which audience it was minted for, and a code minted for the
 * dashboard is redeemed for a signed assertion only (src/dashboard.ts), never
 * for a site's cookie, nor the other way. The portal's session spares the
 * provider for the dashboard too, but only while it is younger than
 * `DASHBOARD_REAUTH_S`: a member's dashboard session lasts that long, so a
 * person closed at the provider is out of the dashboard a day after they last
 * proved themselves there, as out of every site.
 *
 * Pure apart from the store, which holds the codes in memory and takes its
 * time and its draw as parameters.
 */
import { FLOW_DURATION_S, isFlowText } from "./oidc";
import { purposeKey, readIdentity, safeReturnTo, seal, unseal, isValidHost, type Identity } from "./gate";

/** A code is redeemed within a redirect: a minute is generous. */
export const HANDOFF_TTL_MS = 60_000;

/** Beyond this many codes in flight, minting refuses rather than filling memory. */
export const HANDOFF_MAX = 10_000;

/**
 * Codes in flight for one email. A person signs in to a few sites at once at
 * most, and each code is redeemed within its redirect: ten leaves room for a
 * burst of tabs, and makes filling `HANDOFF_MAX` take a thousand accounts the
 * provider accepts rather than one.
 */
export const HANDOFF_PER_EMAIL = 10;

/**
 * The flows that minted their code are remembered until they would have
 * expired anyway, so that none mints twice. Bounded like the codes: past it,
 * minting refuses rather than forgetting, since forgetting would let a flow
 * be replayed.
 */
export const SPENT_FLOWS_MAX = 100_000;

/**
 * How long the portal remembers who signed in on its own host, so that the
 * next site skips the provider. Also the longest life of a site's identity
 * cookie, which never outlives that session: an account closed at the
 * provider loses every site within a day of signing in there, and removing
 * someone from a site's sharing closes that site at their next request.
 */
export const IDENTITY_DURATION_S = 24 * 3600;

/**
 * How old the portal's session may be for a dashboard sign-in to skip the
 * provider: beyond it, the person signs in at the provider again. The member
 * session it opens lasts as long, so that the dashboard never trusts a proof
 * more than a day old, as no site does.
 */
export const DASHBOARD_REAUTH_S = 12 * 3600;

/** A sign-out is carried from the site to the portal's host within a redirect: a minute is generous. */
export const SIGN_OUT_DURATION_S = 60;

/** 32 drawn bytes in base64url: the shape of a binding and of a code. */
const DRAWN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function draw(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** The binding drawn for one browser, 256 bits. */
export function drawBinding(): string {
  return draw(32);
}

/** What the flow and the code carry of the binding: its hash, never the value the browser holds. */
export function bindingHash(binding: string): string {
  return new Bun.CryptoHasher("sha256").update(binding).digest("base64url");
}

export function isBinding(value: unknown): value is string {
  return typeof value === "string" && DRAWN_PATTERN.test(value);
}

// --- The flow --------------------------------------------------------------------

/**
 * Who the sign-in is for. `site`: a protected site, whose own cookie the code
 * is redeemed for, on that site. `dashboard`: the machine's dashboard, which
 * is never behind the portal and redeems its code over the loopback for a
 * signed identity assertion, see src/dashboard.ts.
 */
export type Audience = "site" | "dashboard";

export type Flow = {
  /** The protected site, as Caddy announced it when the flow began; or the dashboard's host. */
  host: string;
  returnTo: string;
  /** The hash of the binding cookie set on that site, or on the dashboard. */
  binding: string;
  /** Ask the provider which account, instead of taking the one signed in. */
  chooseAccount: boolean;
  audience: Audience;
};

export function issueFlow(key: Uint8Array, flow: Flow, nowS: number): string {
  return seal(purposeKey(key, "flow"), {
    h: flow.host,
    r: flow.returnTo,
    b: flow.binding,
    a: flow.chooseAccount,
    // Only a dashboard's flow says so: a site's is sealed as it always was.
    ...(flow.audience === "dashboard" ? { d: true } : {}),
    e: nowS + FLOW_DURATION_S,
  });
}

/** The flow sealed by this portal, unexpired, every field judged again; or `null`. */
export function readFlow(key: Uint8Array, token: string | null, nowS: number): Flow | null {
  const fields = unseal(purposeKey(key, "flow"), token);
  if (fields === null) return null;
  const { h, r, b, a, d, e } = fields;
  if (typeof e !== "number" || e <= nowS || e > nowS + FLOW_DURATION_S) return null;
  if (typeof h !== "string" || !isValidHost(h)) return null;
  if (typeof r !== "string" || safeReturnTo(r) !== r) return null;
  if (!isBinding(b) || typeof a !== "boolean") return null;
  if (d !== undefined && d !== true) return null;
  return { host: h, returnTo: r, binding: b, chooseAccount: a, audience: d === true ? "dashboard" : "site" };
}

// --- The provider transaction ------------------------------------------------------

export type Transaction = { state: string; nonce: string; verifier: string; flow: string };

/** The cookie that holds one transaction is named after its state: two tabs signing in at once keep theirs. */
export function transactionSuffix(state: string): string {
  return `-oidc-${state}`;
}

export function issueTransaction(key: Uint8Array, transaction: Transaction, nowS: number): string {
  return seal(purposeKey(key, "transaction"), {
    s: transaction.state,
    n: transaction.nonce,
    v: transaction.verifier,
    f: transaction.flow,
    e: nowS + FLOW_DURATION_S,
  });
}

/** The transaction for this state, unexpired; `null` otherwise, a cookie of another state included. */
export function readTransaction(key: Uint8Array, token: string | null, state: string, nowS: number): Transaction | null {
  const fields = unseal(purposeKey(key, "transaction"), token);
  if (fields === null) return null;
  const { s, n, v, f, e } = fields;
  if (typeof e !== "number" || e <= nowS || e > nowS + FLOW_DURATION_S) return null;
  if (s !== state || !isFlowText(s) || !isFlowText(n) || !isFlowText(v) || typeof f !== "string") return null;
  return { state: s, nonce: n, verifier: v, flow: f };
}

// --- The portal's session ----------------------------------------------------------

/** Who the portal's session names, and until when, in seconds: the site's cookie lives no longer. */
export type Session = { identity: Identity; expiry: number };

export function issueSession(key: Uint8Array, identity: Identity, nowS: number): string {
  return seal(purposeKey(key, "session"), { e: identity.email, n: identity.name, x: nowS + IDENTITY_DURATION_S });
}

export function readSession(key: Uint8Array, token: string | null, nowS: number): Session | null {
  const fields = unseal(purposeKey(key, "session"), token);
  if (fields === null) return null;
  const { x } = fields;
  if (typeof x !== "number" || x <= nowS || x > nowS + IDENTITY_DURATION_S) return null;
  const identity = readIdentity(fields);
  return identity === null ? null : { identity, expiry: x };
}

// --- The sign-out ----------------------------------------------------------------

/**
 * What a site's sign-out hands the portal's host: the host it came from,
 * sealed, for a minute. Only a POST from the site's own origin mints one, so
 * a stranger can neither sign someone out of the portal nor make its host
 * send them anywhere but back to a site Caddy announced.
 */
export function issueSignOut(key: Uint8Array, host: string, nowS: number): string {
  return seal(purposeKey(key, "sign-out"), { h: host, e: nowS + SIGN_OUT_DURATION_S });
}

/** The site a sign-out came from, unexpired; or `null`. */
export function readSignOut(key: Uint8Array, token: string | null, nowS: number): string | null {
  const fields = unseal(purposeKey(key, "sign-out"), token);
  if (fields === null) return null;
  const { h, e } = fields;
  if (typeof e !== "number" || e <= nowS || e > nowS + SIGN_OUT_DURATION_S) return null;
  return typeof h === "string" && isValidHost(h) ? h : null;
}

// --- The codes -------------------------------------------------------------------

export type Handoff = {
  host: string;
  binding: string;
  identity: Identity;
  returnTo: string;
  /** When the portal session that vouched for the identity expires, in seconds. */
  sessionExpiry: number;
  /** When the person last signed in at the provider, in seconds. */
  authTime: number;
  /** What the code is redeemed for: a site's cookie, or the dashboard's assertion. */
  audience: Audience;
};

export type Redemption =
  | { handoff: Handoff }
  | { refusal: "unknown-code" | "expired-code" | "wrong-host" | "wrong-audience" | "wrong-browser" };

/**
 * A fresh code, or why none: `spent-flow` when this flow already minted its
 * own, `too-many` when too many are in flight, for everyone or for this email.
 */
export type Minting = { code: string } | { refusal: "spent-flow" | "too-many" };

export type HandoffStore = {
  mint: (handoff: Handoff, now: number) => Minting;
  /**
   * Burns the code whatever the outcome, then says whether it hands over its
   * identity here: on this host, to this browser, for this audience. A code
   * minted for the dashboard never sets a site's cookie, nor the other way.
   */
  redeem: (code: string, host: string, binding: string | null, now: number, audience?: Audience) => Redemption;
};

function codeKey(code: string): string {
  return new Bun.CryptoHasher("sha256").update(code).digest("hex");
}

/**
 * The codes in flight, kept under their hash: the map holds nothing a memory
 * dump could replay. A restart forgets them all, and the person in the middle
 * of a redirect signs in again; it forgets the spent flows too, which lets a
 * flow of the last ten minutes mint once more, nothing beyond.
 *
 * A flow is known by its binding's hash, drawn afresh for each one. Minting
 * looks only at that email's own codes, ten at most, and sweeps the whole map
 * only once it is full: a flood of mints costs no full sweep each.
 */
export function handoffStore(drawCode: () => string = () => draw(32)): HandoffStore {
  const codes = new Map<string, Handoff & { expiresAt: number }>();
  const byEmail = new Map<string, Set<string>>();
  const spent = new Map<string, number>();

  function forget(key: string): void {
    const entry = codes.get(key);
    if (entry === undefined) return;
    codes.delete(key);
    const keys = byEmail.get(entry.identity.email);
    keys?.delete(key);
    if (keys?.size === 0) byEmail.delete(entry.identity.email);
  }

  function sweep(now: number): void {
    for (const [key, entry] of codes) if (entry.expiresAt <= now) forget(key);
    for (const [binding, until] of spent) if (until <= now) spent.delete(binding);
  }

  return {
    mint(handoff, now) {
      if ((spent.get(handoff.binding) ?? 0) > now) return { refusal: "spent-flow" };
      const email = handoff.identity.email;
      for (const key of byEmail.get(email) ?? []) if (codes.get(key)!.expiresAt <= now) forget(key);
      if ((byEmail.get(email)?.size ?? 0) >= HANDOFF_PER_EMAIL) return { refusal: "too-many" };
      if (codes.size >= HANDOFF_MAX || spent.size >= SPENT_FLOWS_MAX) sweep(now);
      if (codes.size >= HANDOFF_MAX || spent.size >= SPENT_FLOWS_MAX) return { refusal: "too-many" };

      const code = drawCode();
      const key = codeKey(code);
      codes.set(key, { ...handoff, expiresAt: now + HANDOFF_TTL_MS });
      byEmail.set(email, (byEmail.get(email) ?? new Set()).add(key));
      // No flow outlives FLOW_DURATION_S from any moment it is still valid.
      spent.set(handoff.binding, now + FLOW_DURATION_S * 1000);
      return { code };
    },

    redeem(code, host, binding, now, audience = "site") {
      if (typeof code !== "string" || !DRAWN_PATTERN.test(code)) return { refusal: "unknown-code" };
      const key = codeKey(code);
      const entry = codes.get(key);
      if (entry === undefined) return { refusal: "unknown-code" };
      forget(key);
      if (entry.expiresAt <= now) return { refusal: "expired-code" };
      if (entry.audience !== audience) return { refusal: "wrong-audience" };
      if (entry.host !== host) return { refusal: "wrong-host" };
      if (binding === null || bindingHash(binding) !== entry.binding) return { refusal: "wrong-browser" };
      const { expiresAt: _, ...handoff } = entry;
      return { handoff };
    },
  };
}
