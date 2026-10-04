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
 * How long the portal remembers who signed in on its own host, so that the
 * next site skips the provider. Also the life of a site's identity cookie: an
 * account closed at the provider loses every site within a day, and removing
 * someone from a site's sharing closes that site at their next request.
 */
export const IDENTITY_DURATION_S = 24 * 3600;

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

export type Flow = {
  /** The protected site, as Caddy announced it when the flow began. */
  host: string;
  returnTo: string;
  /** The hash of the binding cookie set on that site. */
  binding: string;
  /** Ask the provider which account, instead of taking the one signed in. */
  chooseAccount: boolean;
};

export function issueFlow(key: Uint8Array, flow: Flow, nowS: number): string {
  return seal(purposeKey(key, "flow"), {
    h: flow.host,
    r: flow.returnTo,
    b: flow.binding,
    a: flow.chooseAccount,
    e: nowS + FLOW_DURATION_S,
  });
}

/** The flow sealed by this portal, unexpired, every field judged again; or `null`. */
export function readFlow(key: Uint8Array, token: string | null, nowS: number): Flow | null {
  const fields = unseal(purposeKey(key, "flow"), token);
  if (fields === null) return null;
  const { h, r, b, a, e } = fields;
  if (typeof e !== "number" || e <= nowS || e > nowS + FLOW_DURATION_S) return null;
  if (typeof h !== "string" || !isValidHost(h)) return null;
  if (typeof r !== "string" || safeReturnTo(r) !== r) return null;
  if (!isBinding(b) || typeof a !== "boolean") return null;
  return { host: h, returnTo: r, binding: b, chooseAccount: a };
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

export function issueSession(key: Uint8Array, identity: Identity, nowS: number): string {
  return seal(purposeKey(key, "session"), { e: identity.email, n: identity.name, x: nowS + IDENTITY_DURATION_S });
}

export function readSession(key: Uint8Array, token: string | null, nowS: number): Identity | null {
  const fields = unseal(purposeKey(key, "session"), token);
  if (fields === null) return null;
  const { x } = fields;
  if (typeof x !== "number" || x <= nowS || x > nowS + IDENTITY_DURATION_S) return null;
  return readIdentity(fields);
}

// --- The codes -------------------------------------------------------------------

export type Handoff = { host: string; binding: string; identity: Identity; returnTo: string };

export type Redemption =
  | { handoff: Handoff }
  | { refusal: "unknown-code" | "expired-code" | "wrong-host" | "wrong-browser" };

export type HandoffStore = {
  /** A fresh code for this handoff, or `null` when too many are in flight. */
  mint: (handoff: Handoff, now: number) => string | null;
  /** Burns the code whatever the outcome, then says whether it hands over its identity here. */
  redeem: (code: string, host: string, binding: string | null, now: number) => Redemption;
};

function codeKey(code: string): string {
  return new Bun.CryptoHasher("sha256").update(code).digest("hex");
}

/**
 * The codes in flight, kept under their hash: the map holds nothing a memory
 * dump could replay. A restart forgets them all, and the person in the middle
 * of a redirect signs in again.
 */
export function handoffStore(drawCode: () => string = () => draw(32)): HandoffStore {
  const codes = new Map<string, Handoff & { expiresAt: number }>();

  function sweep(now: number): void {
    for (const [key, entry] of codes) if (entry.expiresAt <= now) codes.delete(key);
  }

  return {
    mint(handoff, now) {
      if (codes.size >= HANDOFF_MAX) sweep(now);
      if (codes.size >= HANDOFF_MAX) return null;
      const code = drawCode();
      codes.set(codeKey(code), { ...handoff, expiresAt: now + HANDOFF_TTL_MS });
      return code;
    },

    redeem(code, host, binding, now) {
      if (typeof code !== "string" || !DRAWN_PATTERN.test(code)) return { refusal: "unknown-code" };
      const key = codeKey(code);
      const entry = codes.get(key);
      if (entry === undefined) return { refusal: "unknown-code" };
      codes.delete(key);
      if (entry.expiresAt <= now) return { refusal: "expired-code" };
      if (entry.host !== host) return { refusal: "wrong-host" };
      if (binding === null || bindingHash(binding) !== entry.binding) return { refusal: "wrong-browser" };
      const { expiresAt: _, ...handoff } = entry;
      return { handoff };
    },
  };
}
