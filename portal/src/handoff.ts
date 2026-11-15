/**
 * What carries the owner's passkey sign-in from the portal's own host back to
 * a protected site: the binding the site draws, and the one-time code the
 * site redeems for the owner's cookie.
 *
 * ## Why a detour through the portal's host
 *
 * A passkey answers only a page whose host falls under the zone it was
 * registered for, and a site's own domain is not under it. The ceremony
 * therefore runs on `portal.<zone>` (src/passkey-signin.ts), and the site
 * learns of it through a code the portal mints there and the site redeems
 * once, for that host alone. Nothing relies on a cookie shared across the
 * zone, which is why a customer's domain works the same way.
 *
 * ## What each piece defends
 *
 * - **The binding cookie** is drawn on the site when the flow begins and
 *   travels nowhere: the flow and the code carry its hash. A code is only
 *   redeemed by the browser that began the flow, so a link carrying someone
 *   else's code, sent to a victim, signs the victim in as nobody.
 * - **The code** lives sixty seconds, in this process's memory only, and is
 *   gone at the first attempt to redeem it, right or wrong.
 * - **A flow mints one code**, ever: replaying a verified ceremony's flow
 *   would otherwise mint a code per request.
 *
 * Pure apart from the store, which holds the codes in memory and takes its
 * time and its draw as parameters.
 */

/** A code is redeemed within a redirect: a minute is generous. */
export const HANDOFF_TTL_MS = 60_000;

/** Beyond this many codes in flight, minting refuses rather than filling memory. */
export const HANDOFF_MAX = 10_000;

/**
 * How long a flow, from the site to the portal's host and back, may take:
 * the ceremony, and the person choosing their passkey.
 */
export const FLOW_DURATION_S = 10 * 60;

/**
 * The flows that minted their code are remembered until they would have
 * expired anyway, so that none mints twice. Bounded like the codes: past it,
 * minting refuses rather than forgetting, since forgetting would let a flow
 * be replayed.
 */
export const SPENT_FLOWS_MAX = 100_000;

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

// --- The codes -------------------------------------------------------------------

export type Handoff = {
  host: string;
  binding: string;
  returnTo: string;
  /** The reference of the passkey that signed (src/passkeys.ts). */
  passkey: string;
};

export type Redemption = { handoff: Handoff } | { refusal: "unknown-code" | "expired-code" | "wrong-host" | "wrong-browser" };

/**
 * A fresh code, or why none: `spent-flow` when this flow already minted its
 * own, `too-many` when too many are in flight.
 */
export type Minting = { code: string } | { refusal: "spent-flow" | "too-many" };

export type HandoffStore = {
  mint: (handoff: Handoff, now: number) => Minting;
  /** Burns the code whatever the outcome, then says whether it hands over its sign-in here: on this host, to this browser. */
  redeem: (code: string, host: string, binding: string | null, now: number) => Redemption;
};

function codeKey(code: string): string {
  return new Bun.CryptoHasher("sha256").update(code).digest("hex");
}

/**
 * The codes in flight, kept under their hash: the map holds nothing a memory
 * dump could replay. A restart forgets them all, and the owner in the middle
 * of a redirect signs in again; it forgets the spent flows too, which lets a
 * flow of the last ten minutes mint once more, nothing beyond.
 *
 * A flow is known by its binding's hash, drawn afresh for each one. The map
 * is swept only once it is full: a flood of mints costs no full sweep each.
 */
export function handoffStore(drawCode: () => string = () => draw(32)): HandoffStore {
  const codes = new Map<string, Handoff & { expiresAt: number }>();
  const spent = new Map<string, number>();

  function sweep(now: number): void {
    for (const [key, entry] of codes) if (entry.expiresAt <= now) codes.delete(key);
    for (const [binding, until] of spent) if (until <= now) spent.delete(binding);
  }

  return {
    mint(handoff, now) {
      if ((spent.get(handoff.binding) ?? 0) > now) return { refusal: "spent-flow" };
      if (codes.size >= HANDOFF_MAX || spent.size >= SPENT_FLOWS_MAX) sweep(now);
      if (codes.size >= HANDOFF_MAX || spent.size >= SPENT_FLOWS_MAX) return { refusal: "too-many" };

      const code = drawCode();
      codes.set(codeKey(code), { ...handoff, expiresAt: now + HANDOFF_TTL_MS });
      // No flow outlives FLOW_DURATION_S from any moment it is still valid.
      spent.set(handoff.binding, now + FLOW_DURATION_S * 1000);
      return { code };
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
