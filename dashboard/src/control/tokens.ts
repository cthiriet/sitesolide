/**
 * The team's tokens: one per person, created and revoked by the owner, held by
 * the steward in `/var/lib/sitesolide-steward/team.json`.
 *
 * **Only a SHA-256 of each token is kept**, for the reason portal/README.md
 * gives for guest passwords: argon2id slows down whoever guesses a password a
 * human chose; a token is 256 random bits, there is nothing to guess, and a
 * fast hash finds it by lookup instead of checking every record at 64 MiB each.
 * The value is shown once, at creation, and never again: lost, it is revoked
 * and another is created.
 *
 * **A token deploys what its scope allows, and the projects it created.** The
 * ownership is recorded at the start of a project's first deployment, before
 * anything is written on the machine: a first deployment that fails half way
 * leaves a directory its creator can still deploy again, and nobody else can
 * take.
 *
 * Pure: the registry comes in as a value, a new one goes out; the clock and the
 * random source are parameters. Reading and writing the file belong to
 * system.ts.
 */
import { generateToken, tokenHash, type RandomSource } from "../sessions";
import { reservedReason } from "./policy";
import {
  EMAIL_MAX,
  LABEL_MAX,
  MAX_EXPIRY_MS,
  MAX_TOKENS,
  TOKEN_PREFIX,
  type Identity,
  type Scope,
  type TokenView,
} from "./protocol";
import { isValidSlug } from "../../borrowed/manifest";

/**
 * What the registry keeps of a token: its view without `owned`, and its hash.
 * `member` is written for a member's token alone, so that an owner's token
 * reads as it always did.
 */
export type TokenRecord = Omit<TokenView, "owned" | "member"> & { hash: string; member?: string };

export type Team = {
  tokens: TokenRecord[];
  /** slug -> id of the token that created it. */
  owners: Record<string, string>;
};

export const EMPTY_TEAM: Team = { tokens: [], owners: {} };

/** Slugs one token may be granted. A longer list is a team sharing one token. */
export const MAX_GRANTED = 100;

/** The registry's last-use date moves by whole hours, so that a busy token does not rewrite it on every call. */
export const LAST_USE_STEP_MS = 60 * 60 * 1000;

const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const ID_SHAPE = /^[0-9a-f]{12}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;
/** The value's shape: the prefix, then base64url without padding. */
const TOKEN_SHAPE = /^sst_[A-Za-z0-9_-]{43}$/;

export type Refusal = { refusal: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Has the value the shape of a token? Checked before any hash is computed. */
export function isTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/**
 * The bearer of an `Authorization` header, or null. The scheme is matched
 * without regard to case, as HTTP says; the value is not trimmed beyond the
 * single space that separates it.
 */
export function bearerOf(header: string | null): string | null {
  if (header === null) return null;
  const found = /^bearer ([^\s]+)$/i.exec(header.trim());
  return found === null ? null : found[1]!;
}

// --- reading what the owner asks for ----------------------------------------------

/**
 * A scope as the page sends it, or the refusal. Every flag must be a boolean:
 * a missing one is not taken for false, it is a page out of step with this
 * file, and the owner would grant something other than what they saw.
 */
export function readScope(value: unknown, zone: string): Scope | Refusal {
  if (!isObject(value)) return { refusal: "scope must be an object" };
  const allowed = ["slugs", "create", "outbound", "domain", "public"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return { refusal: "unexpected field in the scope" };
  const { slugs, create, outbound, domain } = value;
  const isPublic = value.public;
  if (!Array.isArray(slugs)) return { refusal: "scope.slugs must be a list of slugs" };
  if (slugs.length > MAX_GRANTED) return { refusal: `a token may be granted ${MAX_GRANTED} projects at most` };
  const seen: string[] = [];
  for (const slug of slugs) {
    if (typeof slug !== "string" || !isValidSlug(slug)) return { refusal: `scope.slugs: ${JSON.stringify(String(slug)).slice(0, 70)} is not a slug` };
    const reserved = reservedReason(slug, zone);
    if (reserved !== null) return { refusal: `scope.slugs: ${reserved}` };
    if (!seen.includes(slug)) seen.push(slug);
  }
  for (const [name, flag] of Object.entries({ create, outbound, domain, public: isPublic })) {
    if (typeof flag !== "boolean") return { refusal: `scope.${name} must be true or false` };
  }
  return {
    slugs: seen.sort(),
    create: create as boolean,
    outbound: outbound as boolean,
    domain: domain as boolean,
    public: isPublic as boolean,
  };
}

export type TokenRequest = { label: string; email: string; expiresAt: number | null; scope: Scope };

/** What the owner asks for, judged: label, email, expiry, scope. */
export function readTokenRequest(body: Record<string, unknown>, now: number, zone: string): TokenRequest | Refusal {
  const { label, email, expiresAt, scope } = body;
  if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
    return { refusal: `label: one line of text, ${LABEL_MAX} characters at most` };
  }
  if (typeof email !== "string" || email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email.trim())) {
    return { refusal: "email: the address of the person who will hold this token" };
  }
  if (expiresAt !== null) {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { refusal: "expiresAt: a date in milliseconds, or null" };
    if (expiresAt <= now) return { refusal: "expiresAt: the expiry must be in the future" };
    if (expiresAt - now > MAX_EXPIRY_MS) return { refusal: "expiresAt: five years at most, or no expiry" };
  }
  const readScopeResult = readScope(scope, zone);
  if ("refusal" in readScopeResult) return readScopeResult;
  return { label: label.trim(), email: email.trim().toLowerCase(), expiresAt, scope: readScopeResult };
}

// --- the registry -------------------------------------------------------------------

function isScope(value: unknown): value is Scope {
  if (!isObject(value)) return false;
  return (
    Array.isArray(value.slugs) &&
    value.slugs.every((slug) => typeof slug === "string" && isValidSlug(slug)) &&
    typeof value.create === "boolean" &&
    typeof value.outbound === "boolean" &&
    typeof value.domain === "boolean" &&
    typeof value.public === "boolean"
  );
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOptionalDate = (value: unknown): value is number | null => value === null || isDate(value);

function isRecord(value: unknown): value is TokenRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    ID_SHAPE.test(value.id) &&
    typeof value.hash === "string" &&
    HASH_SHAPE.test(value.hash) &&
    typeof value.label === "string" &&
    typeof value.email === "string" &&
    isDate(value.createdAt) &&
    isOptionalDate(value.expiresAt) &&
    isOptionalDate(value.revokedAt) &&
    isOptionalDate(value.lastUsedAt) &&
    isScope(value.scope) &&
    (value.member === undefined || (typeof value.member === "string" && EMAIL_SHAPE.test(value.member)))
  );
}

/**
 * The registry's file, read. A missing file is an empty team. A file that does
 * not read is not guessed at: every token is refused until a human looks, which
 * is the safe failure for a list of who may deploy.
 */
export function readTeam(text: string | null): Team | { unreadable: string } {
  if (text === null) return { tokens: [], owners: {} };
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "team.json is not JSON" };
  }
  if (!isObject(object) || !Array.isArray(object.tokens) || !isObject(object.owners)) {
    return { unreadable: "team.json does not have the expected shape" };
  }
  if (!object.tokens.every(isRecord)) return { unreadable: "a token of team.json does not have the expected shape" };
  const owners: Record<string, string> = {};
  for (const [slug, id] of Object.entries(object.owners)) {
    if (!isValidSlug(slug) || typeof id !== "string" || !ID_SHAPE.test(id)) {
      return { unreadable: "an owner of team.json does not have the expected shape" };
    }
    owners[slug] = id;
  }
  return { tokens: object.tokens as TokenRecord[], owners };
}

export function encodeTeam(team: Team): string {
  return `${JSON.stringify({ tokens: team.tokens, owners: team.owners }, null, 2)}\n`;
}

/** The projects a token created, sorted. */
export function ownedBy(team: Team, id: string): string[] {
  return Object.entries(team.owners)
    .filter(([, owner]) => owner === id)
    .map(([slug]) => slug)
    .sort();
}

export function viewOf(team: Team, record: TokenRecord): TokenView {
  const { hash: _hash, member, ...view } = record;
  return { ...view, scope: { ...record.scope, slugs: [...record.scope.slugs] }, owned: ownedBy(team, record.id), member: member ?? null };
}

/** The holder as minted. A member's token is narrowed to the member's rights before anyone reads it (src/people/tokens.ts). */
export function identityOf(team: Team, record: TokenRecord): Identity {
  return {
    id: record.id,
    label: record.label,
    email: record.email,
    expiresAt: record.expiresAt,
    scope: { ...record.scope, slugs: [...record.scope.slugs] },
    owned: ownedBy(team, record.id),
    member: record.member ?? null,
  };
}

/** Is this token still able to deploy, for a cap counted on live tokens? */
function isLive(record: TokenRecord, now: number): boolean {
  return record.revokedAt === null && (record.expiresAt === null || now < record.expiresAt);
}

/** The live tokens a member minted. */
export function liveTokensOf(team: Team, email: string, now: number): TokenRecord[] {
  return team.tokens.filter((record) => record.member === email && isLive(record, now));
}

/** Newest first: the page lists them that way. */
export function views(team: Team): TokenView[] {
  return [...team.tokens].sort((a, b) => b.createdAt - a.createdAt).map((record) => viewOf(team, record));
}

function newId(team: Team, random: RandomSource): string {
  for (;;) {
    const id = [...random(6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!team.tokens.some((record) => record.id === id)) return id;
  }
}

/**
 * A new token. The value lives only in what is returned: the registry keeps
 * its hash.
 */
export async function createToken(
  team: Team,
  request: TokenRequest,
  now: number,
  random: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  member: string | null = null,
): Promise<{ team: Team; view: TokenView; secret: string } | Refusal> {
  const alive = team.tokens.filter((record) => record.revokedAt === null).length;
  if (alive >= MAX_TOKENS) return { refusal: `${MAX_TOKENS} live tokens at most: revoke the ones nobody uses` };
  const secret = `${TOKEN_PREFIX}${generateToken(random)}`;
  const record: TokenRecord = {
    id: newId(team, random),
    label: request.label,
    email: request.email,
    createdAt: now,
    expiresAt: request.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    scope: request.scope,
    hash: await tokenHash(secret),
    ...(member === null ? {} : { member }),
  };
  const next: Team = { tokens: [...team.tokens, record], owners: { ...team.owners } };
  return { team: next, view: viewOf(next, record), secret };
}

/**
 * Revokes a token. Its projects stay where they are, and stay recorded as its
 * own: granting them to someone else is a new token's scope.
 */
export function revokeToken(team: Team, id: unknown, now: number): { team: Team; view: TokenView } | Refusal {
  if (typeof id !== "string" || !ID_SHAPE.test(id)) return { refusal: "not a token id" };
  const record = team.tokens.find((candidate) => candidate.id === id);
  if (record === undefined) return { refusal: "no such token" };
  if (record.revokedAt !== null) return { team, view: viewOf(team, record) };
  const revoked = { ...record, revokedAt: now };
  const next: Team = { tokens: team.tokens.map((candidate) => (candidate.id === id ? revoked : candidate)), owners: team.owners };
  return { team: next, view: viewOf(next, revoked) };
}

/**
 * Every live token a member minted, revoked: the member was removed. Their
 * projects stay where they are, as for any revoked token.
 */
export function revokeMemberTokens(team: Team, email: string, now: number): { team: Team; revoked: TokenView[] } {
  const ids = new Set(team.tokens.filter((record) => record.member === email && record.revokedAt === null).map((record) => record.id));
  if (ids.size === 0) return { team, revoked: [] };
  const next: Team = { tokens: team.tokens.map((record) => (ids.has(record.id) ? { ...record, revokedAt: now } : record)), owners: team.owners };
  return { team: next, revoked: next.tokens.filter((record) => ids.has(record.id)).map((record) => viewOf(next, record)) };
}

export type Authentication =
  | { kind: "accepted"; record: TokenRecord; identity: Identity }
  | { kind: "refused"; reason: "unknown" | "expired" | "revoked"; member?: boolean };

/**
 * Who holds this bearer. Found by its hash; expired or revoked, refused with a
 * reason the caller may tell the holder, since the holder already has the
 * value. An unknown value learns nothing.
 */
export async function authenticate(team: Team, bearer: unknown, now: number): Promise<Authentication> {
  if (!isTokenShape(bearer)) return { kind: "refused", reason: "unknown" };
  const hash = await tokenHash(bearer);
  const record = team.tokens.find((candidate) => candidate.hash === hash);
  if (record === undefined) return { kind: "refused", reason: "unknown" };
  const member = record.member !== undefined;
  if (record.revokedAt !== null) return { kind: "refused", reason: "revoked", member };
  if (record.expiresAt !== null && now >= record.expiresAt) return { kind: "refused", reason: "expired", member };
  return { kind: "accepted", record, identity: identityOf(team, record) };
}

/** What the holder is told: the reason, and what to do about it. A member mints their own again, from the Tokens page. */
export function refusalMessage(reason: Authentication & { kind: "refused" }): string {
  const another = reason.member === true ? "mint a new one from the dashboard's Tokens page if you still have a role there" : "ask the owner of the machine for a new one";
  switch (reason.reason) {
    case "expired":
      return `this token has expired: ${another}, then run sitesolide login again`;
    case "revoked":
      return `this token was revoked: ${another}, then run sitesolide login again`;
    default:
      return "missing or unknown token: send Authorization: Bearer <token>, the value shown once when the owner created it";
  }
}

/** The registry with the last use moved forward, or null when it would not change. */
export function touch(team: Team, id: string, now: number): Team | null {
  const rounded = now - (now % LAST_USE_STEP_MS);
  const record = team.tokens.find((candidate) => candidate.id === id);
  if (record === undefined || record.lastUsedAt === rounded) return null;
  return {
    tokens: team.tokens.map((candidate) => (candidate.id === id ? { ...candidate, lastUsedAt: rounded } : candidate)),
    owners: team.owners,
  };
}

/**
 * The registry with this slug no longer anyone's, and whose it was; null when
 * no token owned it. For a project removed from the machine: another token
 * may then create a project of that name. Its tokens stay as they are.
 */
export function forgetOwnership(team: Team, slug: string): { team: Team; id: string } | null {
  if (!Object.hasOwn(team.owners, slug)) return null;
  const owners = { ...team.owners };
  const id = owners[slug]!;
  delete owners[slug];
  return { team: { tokens: team.tokens, owners }, id };
}

/** The registry with this slug recorded as the token's, or null when it already is. */
export function recordOwnership(team: Team, slug: string, id: string): Team | null {
  if (team.owners[slug] === id) return null;
  return { tokens: team.tokens, owners: { ...team.owners, [slug]: id } };
}
