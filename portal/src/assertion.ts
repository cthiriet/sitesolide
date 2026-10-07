/**
 * The identity assertion: what the portal hands the dashboard once a person
 * has signed in with the identity provider, and what the steward checks, as
 * root, before it opens a member session.
 *
 * ## Why a signature, and why this one
 *
 * The dashboard is assumed compromised everywhere in this repository. If it
 * could say "this is alice@acme.com" and be believed, it could act as any
 * member. So the portal, the one authority on identities, signs what the
 * provider proved, and the steward checks that signature with a public key it
 * keeps itself: the dashboard carries the assertion, and can neither forge one
 * nor change a byte of it.
 *
 * Ed25519, through WebCrypto: small keys, one algorithm and no parameter to
 * choose, no padding, and a signature that does not depend on a random draw
 * at signing time. The key pair is drawn by the steward, which keeps the
 * public half and lays the private half where only the portal's account reads
 * it: see dashboard/src/members/keys.ts.
 *
 * ## The shape
 *
 * Three base64url pieces, `<header>.<claims>.<signature>`, the compact shape
 * of a JWT, signed over the first two with their dot:
 *
 *   header   { "alg": "EdDSA", "typ": "sitesolide-identity", "kid": "<16 hex>" }
 *   claims   { "iss": "sitesolide-portal", "aud": "dashboard",
 *              "email": "<verified, lowercase>", "name": "<display name>" | null,
 *              "auth_time": <s>, "iat": <s>, "exp": <s>, "nonce": "<43 base64url>",
 *              "reauth": true, only after a sign-in the provider was made to ask again }
 *
 * - `aud` names the one reader: an assertion made for something else is
 *   refused, whatever it says;
 * - `exp` is five minutes after `iat` at most: an assertion is redeemed the
 *   moment it is made, never kept;
 * - `nonce` is drawn for each assertion: the steward accepts each one once;
 * - `auth_time` is when the person last proved themselves at the provider,
 *   which the portal may have remembered for a while: the steward and the
 *   dashboard bound how old it may be;
 * - `reauth` says the portal sent the person to the provider with a forced
 *   sign-in (`prompt=login`, `max_age=0`) and read back, in the provider's
 *   own ID token, that they signed in during that very flow: the steward
 *   unlocks a member's secrets on such an assertion alone. Absent from a
 *   sign-in, which may ride on the portal's session or the provider's.
 *
 * No import: the dashboard borrows this file as it stands (scripts/borrow.ts),
 * so the portal signs and the steward verifies with one and the same code.
 */

export const ASSERTION_TYPE = "sitesolide-identity";
export const ASSERTION_ISSUER = "sitesolide-portal";
export const DASHBOARD_AUDIENCE = "dashboard";

/** An assertion is redeemed within a redirect: five minutes is generous. */
export const ASSERTION_LIFETIME_S = 300;

/** A token longer than this is no assertion of ours, and is not even split. */
export const MAX_ASSERTION_LENGTH = 4096;

/** The display name, as the portal cleans it. */
export const ASSERTION_NAME_MAX = 200;

export type PublicKey = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };
export type PrivateKey = PublicKey & { d: string };

export type AssertionClaims = {
  iss: string;
  aud: string;
  email: string;
  name: string | null;
  auth_time: number;
  iat: number;
  exp: number;
  nonce: string;
  /** True for a forced sign-in at the provider, read back in its ID token; false otherwise. */
  reauth: boolean;
};

/** What the portal puts in, the rest being its own. `reauth`: a forced sign-in, see the header. */
export type AssertionSubject = { email: string; name: string | null; authTime: number; reauth?: boolean };

export type AssertionRefusal =
  | "malformed"
  | "unknown-key"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired"
  | "not-yet-valid"
  | "too-long-lived"
  | "bad-email"
  | "bad-nonce";

export type AssertionReading = { claims: AssertionClaims } | { refusal: AssertionRefusal };

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
/**
 * What an email looks like once the portal has cleaned it: lowercase ASCII, no
 * space, one `@`, a dot in the domain. The portal judges far more before it
 * signs; this only refuses what no rule of its would ever have let through.
 */
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(piece: string): Record<string, unknown> | null {
  const bytes = fromBase64url(piece);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function encodeJson(value: object): string {
  return toBase64url(encoder.encode(JSON.stringify(value)));
}

/** The key's identifier: the start of the SHA-256 of its 32 public bytes, in hex. */
export function keyId(x: string): string {
  const raw = fromBase64url(x) ?? new Uint8Array(0);
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex").slice(0, 16);
}

/** A fresh pair. The private half carries the public one, so that the pair is checked whole. */
export async function generateKeyPair(): Promise<{ privateKey: PrivateKey; publicKey: PublicKey }> {
  // An asymmetric algorithm always draws a pair; the libraries type the call for every algorithm at once.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") throw new Error("Ed25519 key without its x or d");
  const publicKey: PublicKey = { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: keyId(jwk.x) };
  return { privateKey: { ...publicKey, d: jwk.d }, publicKey };
}

/** One line of JSON, as the key files hold it. */
export function encodeKey(key: PublicKey | PrivateKey): string {
  return `${JSON.stringify(key)}\n`;
}

/** The public key a file holds, or null: every field in its shape, and the identifier its own. */
export function readPublicKey(text: string | null): PublicKey | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { kty, crv, x, kid } = value;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || !BASE64URL_32.test(x)) return null;
  if (typeof kid !== "string" || !KEY_ID.test(kid) || kid !== keyId(x)) return null;
  return { kty, crv, x, kid };
}

/** The private key a file holds, or null. */
export function readPrivateKey(text: string | null): PrivateKey | null {
  const publicKey = readPublicKey(text);
  if (publicKey === null || text === null) return null;
  const d = (JSON.parse(text) as Record<string, unknown>).d;
  if (typeof d !== "string" || !BASE64URL_32.test(d)) return null;
  return { ...publicKey, d };
}

/** Is this the private half of that public key? Compared on what each says of the public one. */
export function samePair(privateKey: PrivateKey, publicKey: PublicKey): boolean {
  return privateKey.x === publicKey.x && privateKey.kid === publicKey.kid;
}

function drawNonce(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** An assertion for the dashboard, valid from `nowS` for ASSERTION_LIFETIME_S. */
export async function signAssertion(privateKey: PrivateKey, subject: AssertionSubject, nowS: number, nonce: string = drawNonce()): Promise<string> {
  const header = encodeJson({ alg: "EdDSA", typ: ASSERTION_TYPE, kid: privateKey.kid });
  // `reauth` only when true: a sign-in's assertion is the one it always was.
  const claims = {
    iss: ASSERTION_ISSUER,
    aud: DASHBOARD_AUDIENCE,
    email: subject.email,
    name: subject.name,
    auth_time: subject.authTime,
    iat: nowS,
    exp: nowS + ASSERTION_LIFETIME_S,
    nonce,
    ...(subject.reauth === true ? { reauth: true } : {}),
  };
  const signed = `${header}.${encodeJson(claims)}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: privateKey.x, d: privateKey.d },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(signed)));
  return `${signed}.${toBase64url(signature)}`;
}

const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The claims of an assertion signed by this key, for this audience, valid at
 * `nowS`; or why not. The order is the order of what costs: the shape, the
 * key, the signature, then each claim. Whether its nonce was already seen is
 * the caller's to judge, the one place that remembers them.
 *
 * No tolerance for clocks: the portal and its readers run on one machine.
 */
export async function verifyAssertion(token: unknown, publicKey: PublicKey, expected: { audience: string; nowS: number }): Promise<AssertionReading> {
  if (typeof token !== "string" || token.length > MAX_ASSERTION_LENGTH) return { refusal: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { refusal: "malformed" };
  const [headerPiece, claimsPiece, signaturePiece] = parts as [string, string, string];
  const header = decodeJson(headerPiece);
  const claims = decodeJson(claimsPiece);
  const signature = fromBase64url(signaturePiece);
  if (header === null || claims === null || signature === null || signature.length !== 64) return { refusal: "malformed" };
  if (header.alg !== "EdDSA" || header.typ !== ASSERTION_TYPE) return { refusal: "malformed" };
  if (header.kid !== publicKey.kid) return { refusal: "unknown-key" };

  const raw = fromBase64url(publicKey.x);
  if (raw === null) return { refusal: "unknown-key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, encoder.encode(`${headerPiece}.${claimsPiece}`));
  } catch {
    valid = false;
  }
  if (!valid) return { refusal: "bad-signature" };

  const { iss, aud, email, name, auth_time, iat, exp, nonce, reauth } = claims;
  if (iss !== ASSERTION_ISSUER) return { refusal: "wrong-issuer" };
  if (aud !== expected.audience) return { refusal: "wrong-audience" };
  if (!isSeconds(iat) || !isSeconds(exp) || !isSeconds(auth_time)) return { refusal: "malformed" };
  if (exp <= iat || exp - iat > ASSERTION_LIFETIME_S) return { refusal: "too-long-lived" };
  if (iat > expected.nowS || auth_time > iat) return { refusal: "not-yet-valid" };
  if (exp <= expected.nowS) return { refusal: "expired" };
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email)) return { refusal: "bad-email" };
  if (name !== null && (typeof name !== "string" || Array.from(name).length > ASSERTION_NAME_MAX)) return { refusal: "malformed" };
  if (typeof nonce !== "string" || !BASE64URL_32.test(nonce)) return { refusal: "bad-nonce" };
  if (reauth !== undefined && reauth !== true) return { refusal: "malformed" };
  return { claims: { iss, aud, email, name, auth_time, iat, exp, nonce, reauth: reauth === true } };
}
