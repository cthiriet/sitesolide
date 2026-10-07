import { describe, expect, test } from "bun:test";
import {
  ASSERTION_ISSUER,
  ASSERTION_LIFETIME_S,
  ASSERTION_TYPE,
  DASHBOARD_AUDIENCE,
  encodeKey,
  generateKeyPair,
  keyId,
  readPrivateKey,
  readPublicKey,
  samePair,
  signAssertion,
  verifyAssertion,
  type PrivateKey,
} from "../src/assertion";

/**
 * The assertion the portal hands the dashboard and the steward checks: every
 * way one can be wrong is refused with its own reason, before anything else
 * reads the email it carries.
 */

const NOW_S = 1_800_000_000;
const SUBJECT = { email: "alice@acme.test", name: "Alice Martin", authTime: NOW_S - 120 };
const expected = (nowS = NOW_S) => ({ audience: DASHBOARD_AUDIENCE, nowS });

const pair = await generateKeyPair();
const other = await generateKeyPair();

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Any claims and header, signed with the real key: what a portal gone wrong would hand over. */
async function forge(privateKey: PrivateKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const signed = `${b64({ alg: "EdDSA", typ: ASSERTION_TYPE, kid: privateKey.kid, ...header })}.${b64(claims)}`;
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: privateKey.x, d: privateKey.d }, { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(signed));
  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
}

const goodClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: ASSERTION_ISSUER,
  aud: DASHBOARD_AUDIENCE,
  email: SUBJECT.email,
  name: SUBJECT.name,
  auth_time: SUBJECT.authTime,
  iat: NOW_S,
  exp: NOW_S + ASSERTION_LIFETIME_S,
  nonce: "n".repeat(43),
  ...overrides,
});

describe("the keys", () => {
  test("a pair reads back from its files, its identifier its own", () => {
    expect(readPublicKey(encodeKey(pair.publicKey))).toEqual(pair.publicKey);
    expect(readPrivateKey(encodeKey(pair.privateKey))).toEqual(pair.privateKey);
    expect(pair.publicKey.kid).toBe(keyId(pair.publicKey.x));
    expect(samePair(pair.privateKey, pair.publicKey)).toBe(true);
    expect(samePair(pair.privateKey, other.publicKey)).toBe(false);
  });

  test("a public file is not a private key, and a file that lies about its identifier is nothing", () => {
    expect(readPrivateKey(encodeKey(pair.publicKey))).toBeNull();
    expect(readPublicKey(encodeKey({ ...pair.publicKey, kid: other.publicKey.kid }))).toBeNull();
    expect(readPublicKey("not json")).toBeNull();
    expect(readPublicKey(null)).toBeNull();
    expect(readPublicKey(JSON.stringify({ ...pair.publicKey, crv: "P-256" }))).toBeNull();
  });
});

describe("an assertion", () => {
  test("signed by the portal reads back with every claim, for the dashboard, five minutes at most", async () => {
    const token = await signAssertion(pair.privateKey, SUBJECT, NOW_S);
    const reading = await verifyAssertion(token, pair.publicKey, expected());
    expect("claims" in reading).toBe(true);
    if (!("claims" in reading)) return;
    expect(reading.claims).toMatchObject({ iss: ASSERTION_ISSUER, aud: "dashboard", email: "alice@acme.test", name: "Alice Martin", auth_time: SUBJECT.authTime });
    expect(reading.claims.exp - reading.claims.iat).toBe(ASSERTION_LIFETIME_S);
    expect(reading.claims.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("each one draws its own nonce", async () => {
    const one = await verifyAssertion(await signAssertion(pair.privateKey, SUBJECT, NOW_S), pair.publicKey, expected());
    const two = await verifyAssertion(await signAssertion(pair.privateKey, SUBJECT, NOW_S), pair.publicKey, expected());
    expect("claims" in one && "claims" in two && one.claims.nonce !== two.claims.nonce).toBe(true);
  });

  test("signed by another key is refused, whatever it claims", async () => {
    const token = await signAssertion(other.privateKey, SUBJECT, NOW_S);
    expect(await verifyAssertion(token, pair.publicKey, expected())).toEqual({ refusal: "unknown-key" });
    // The same identifier, another key: the signature gives it away.
    const posing = await forge({ ...other.privateKey, kid: pair.publicKey.kid }, goodClaims());
    expect(await verifyAssertion(posing, pair.publicKey, expected())).toEqual({ refusal: "bad-signature" });
  });

  test("changed by one byte is refused: the dashboard cannot rename the person", async () => {
    const token = await signAssertion(pair.privateKey, SUBJECT, NOW_S);
    const [header, , signature] = token.split(".");
    const renamed = `${header}.${b64(goodClaims({ email: "boss@acme.test" }))}.${signature}`;
    expect(await verifyAssertion(renamed, pair.publicKey, expected())).toEqual({ refusal: "bad-signature" });
  });

  test("for another audience, from another issuer", async () => {
    expect(await verifyAssertion(await forge(pair.privateKey, goodClaims({ aud: "site" })), pair.publicKey, expected())).toEqual({ refusal: "wrong-audience" });
    expect(await verifyAssertion(await forge(pair.privateKey, goodClaims({ iss: "someone" })), pair.publicKey, expected())).toEqual({ refusal: "wrong-issuer" });
  });

  test("expired at its fifth minute, not valid before it was made, never longer lived", async () => {
    const token = await signAssertion(pair.privateKey, SUBJECT, NOW_S);
    expect("claims" in (await verifyAssertion(token, pair.publicKey, expected(NOW_S + ASSERTION_LIFETIME_S - 1)))).toBe(true);
    expect(await verifyAssertion(token, pair.publicKey, expected(NOW_S + ASSERTION_LIFETIME_S))).toEqual({ refusal: "expired" });
    expect(await verifyAssertion(token, pair.publicKey, expected(NOW_S - 1))).toEqual({ refusal: "not-yet-valid" });
    const long = await forge(pair.privateKey, goodClaims({ exp: NOW_S + ASSERTION_LIFETIME_S + 1 }));
    expect(await verifyAssertion(long, pair.publicKey, expected())).toEqual({ refusal: "too-long-lived" });
    const later = await forge(pair.privateKey, goodClaims({ auth_time: NOW_S + 10 }));
    expect(await verifyAssertion(later, pair.publicKey, expected())).toEqual({ refusal: "not-yet-valid" });
  });

  test("an email no portal would have signed, a nonce of the wrong shape", async () => {
    for (const email of ["Alice@acme.test", "alice @acme.test", "alice", "alice@localhost", "élise@acme.test"]) {
      expect(await verifyAssertion(await forge(pair.privateKey, goodClaims({ email })), pair.publicKey, expected())).toEqual({ refusal: "bad-email" });
    }
    expect(await verifyAssertion(await forge(pair.privateKey, goodClaims({ nonce: "short" })), pair.publicKey, expected())).toEqual({ refusal: "bad-nonce" });
  });

  test("anything that is not three pieces of ours is malformed", async () => {
    for (const token of [null, 42, "", "a.b", "a.b.c.d", "x".repeat(5000), `${b64({ alg: "none" })}.${b64(goodClaims())}.`]) {
      expect(await verifyAssertion(token, pair.publicKey, expected())).toEqual({ refusal: "malformed" });
    }
    const hmac = await forge(pair.privateKey, goodClaims(), { alg: "HS256" });
    expect(await verifyAssertion(hmac, pair.publicKey, expected())).toEqual({ refusal: "malformed" });
  });
});
