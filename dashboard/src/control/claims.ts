/**
 * What tokens did to a name the machine did not carry: who made its store of
 * secrets ahead of any deployment, and whose deployment of it was accepted.
 * `claims.json`, in the steward's state folder, root's, written by the
 * control routes alone, in the tokens' queue (src/control/steward.ts).
 *
 * **The registry's `owners` says whose a name is; this says why.** A token
 * that only asked for a write writes nothing until the store answers that it
 * made the folder: an owner recorded before that, a removal of a name the
 * store never held or a refused set, reserved the name for good with
 * nothing on disk, and the owner's own project of that name, deployed over
 * SSH, which never reads the tokens' registry, then counted as the token's.
 * So:
 *
 *   - a store is a token's own because that token's write made it
 *     (`creator`), never because the registry names the token;
 *   - a name is kept by a token that wrote its store ahead only until a
 *     project of that name appears on the machine: deployed by that token
 *     (`deployer`), it stays its own; deployed by anyone else, the owner over
 *     SSH above all, the token's claim is released (`released`);
 *   - a name with no project, no store and no deployment under way is given
 *     back (`settle` in the steward).
 *
 * Pure: the steward reads and writes the file, this decides.
 */
import { isValidSlug } from "../../borrowed/manifest";
import { DEPLOYMENT_ID_SHAPE } from "./protocol";

/** One name's history: ids of tokens, never a token. */
export type Claim = {
  /** The token whose write made the store's folder, ahead of any deployment; null when none did. */
  creator: string | null;
  /** The token whose deployment of the name was accepted while the machine did not carry it; null before any. */
  deployer: string | null;
  /** That deployment, whose end says whether one is still under way; null before any. */
  deployment: string | null;
  /** When that deployment was accepted, or, before any, when the store was made: a deployment's end is judged against it. */
  at: number;
};

export type Claims = Record<string, Claim>;

export const CLAIMS_NAME = "claims.json";

/**
 * As many as tokens may hold names the machine does not carry, every one of
 * them (200 tokens of 20 names each): a claim goes once its project is on
 * the machine, or once nothing is left under its name.
 */
export const MAX_CLAIMS = 4_000;

/** A token's id, as tokens.ts draws them. */
const TOKEN_ID = /^[0-9a-f]{12}$/;

const isId = (value: unknown): value is string | null => value === null || (typeof value === "string" && TOKEN_ID.test(value));

/** The file's text read, null for no file: every entry checked, an unreadable one refuses the whole. */
export function readClaims(text: string | null): Claims | { unreadable: string } {
  if (text === null) return {};
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "claims.json is not JSON" };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return { unreadable: "claims.json is not an object" };
  const { version, claims } = object as { version?: unknown; claims?: unknown };
  if (version !== 1 || typeof claims !== "object" || claims === null || Array.isArray(claims)) return { unreadable: "claims.json has no claims" };
  const read: Claims = {};
  for (const [slug, claim] of Object.entries(claims as Record<string, unknown>)) {
    if (!isValidSlug(slug) || typeof claim !== "object" || claim === null) return { unreadable: "claims.json names something that is no slug" };
    const { creator, deployer, deployment, at } = claim as Record<string, unknown>;
    const isDeployment = deployment === null || (typeof deployment === "string" && DEPLOYMENT_ID_SHAPE.test(deployment));
    if (!isId(creator) || !isId(deployer) || !isDeployment || typeof at !== "number" || !Number.isFinite(at)) return { unreadable: `claims.json: the claim on ${slug} does not read` };
    // Defined as the object's own: a slug is never `__proto__`, but no key is assigned blindly.
    Object.defineProperty(read, slug, { value: { creator, deployer, deployment, at }, enumerable: true, writable: true, configurable: true });
  }
  return read;
}

export function encodeClaims(claims: Claims): string {
  return `${JSON.stringify({ version: 1, claims }, null, 2)}\n`;
}

const claimOf = (claims: Claims, slug: string): Claim | null => (Object.hasOwn(claims, slug) ? claims[slug]! : null);

/** This token's write made the store of a name the machine does not carry. */
export function withStoreMade(claims: Claims, slug: string, token: string, at: number): Claims {
  const before = claimOf(claims, slug);
  if (before !== null && before.deployment !== null) return { ...claims, [slug]: { ...before, creator: token } };
  return { ...claims, [slug]: { creator: token, deployer: null, deployment: null, at } };
}

/** This token's deployment of a name the machine does not carry was accepted. */
export function withDeployment(claims: Claims, slug: string, token: string, deployment: string, at: number): Claims {
  return { ...claims, [slug]: { creator: claimOf(claims, slug)?.creator ?? null, deployer: token, deployment, at } };
}

export function without(claims: Claims, slug: string): Claims {
  if (!Object.hasOwn(claims, slug)) return claims;
  const next = { ...claims };
  delete next[slug];
  return next;
}

/** Did this token's write make the store there? The one reason a store is a token's own. */
export function madeStore(claims: Claims | null, slug: string, token: string): boolean {
  return claims !== null && claimOf(claims, slug)?.creator === token;
}

/**
 * Is this token's hold on a project the machine carries released? It is when
 * the token claimed the name ahead of the project, and the project came by
 * anyone else's deployment: that token never deployed it. A name the token
 * holds from before these claims were kept, with no claim, stays as it was.
 */
export function released(claims: Claims | null, slug: string, token: string, onMachine: boolean): boolean {
  if (!onMachine || claims === null) return false;
  const claim = claimOf(claims, slug);
  return claim !== null && claim.deployer !== token;
}

/**
 * What becomes of a name in the tokens' registry once settled, and of its
 * claim. `holder`: the token the registry names, null for none. `store`:
 * the store's folder is there, or cannot be told (counted as there).
 * `pending`: a deployment of the name is under way: its installer active, a
 * person's creation noted, or the claim's own deployment not ended.
 */
export type Settlement = { forget: boolean; drop: boolean };

export function settle(claim: Claim | null, holder: string | null, facts: { onMachine: boolean; store: boolean; pending: boolean }): Settlement {
  if (facts.onMachine) {
    // The project is there: a claim has said all it had to. The holder that
    // never deployed it lets go of it.
    if (claim === null) return { forget: false, drop: false };
    return { forget: holder !== null && claim.deployer !== holder, drop: true };
  }
  if (facts.pending) return { forget: false, drop: false };
  if (facts.store) {
    // A store its holder's write made stays the holder's, to deploy it. One
    // no write of the holder made keeps no name: a leftover, which no token
    // may then create over (src/control/policy.ts), its claim kept only for
    // the token that made it.
    const made = claim !== null && claim.creator !== null;
    return { forget: holder !== null && claim?.creator !== holder, drop: claim !== null && !made };
  }
  // Nothing on the machine, nothing under way: the name is free again.
  return { forget: holder !== null, drop: claim !== null };
}
