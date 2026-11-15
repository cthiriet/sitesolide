import { describe, expect, test } from "bun:test";
import {
  b64url,
  CHALLENGE_MS,
  Challenges,
  CHALLENGES_MAX,
  decodeCbor,
  fromB64url,
  RateLimit,
  Refused,
  verifyAssertion,
  verifyRegistration,
  readPostedAssertion,
  readPostedRegistration,
  OWNER_USER_HANDLE,
} from "../src/webauthn";
import { type Alg, cbor, type Item, SoftAuthenticator } from "./authenticator";

const ORIGIN = "https://portal.test-zone.invalid";
const RP_ID = "test-zone.invalid";
const CHALLENGE = b64url(crypto.getRandomValues(new Uint8Array(32)));
const ceremony = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID };
const expected = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID };

const bytes = (value: string) => {
  const out = fromB64url(value);
  if (out === null) throw new Error("not base64url");
  return out;
};

const registration = (made: Awaited<ReturnType<SoftAuthenticator["register"]>>) => ({
  clientDataJSON: bytes(made.response.clientDataJSON),
  attestationObject: bytes(made.response.attestationObject),
});

const assertion = (made: Awaited<ReturnType<SoftAuthenticator["sign"]>>) => ({
  clientDataJSON: bytes(made.response.clientDataJSON),
  authenticatorData: bytes(made.response.authenticatorData),
  signature: bytes(made.response.signature),
});

/** A registered authenticator, and what the service stores of it. */
async function enrolled(alg: Alg) {
  const key = await SoftAuthenticator.create(alg);
  const registered = await verifyRegistration(registration(await key.register(ceremony)), expected);
  return { key, stored: { publicKey: registered.publicKey, signCount: registered.signCount }, registered };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Refused);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("base64url", () => {
  test("round-trips, without padding, and refuses what is not base64url", () => {
    const sample = Uint8Array.of(0, 250, 251, 252, 253, 254, 255);
    expect(b64url(sample)).not.toMatch(/[+/=]/);
    expect(fromB64url(b64url(sample))).toEqual(sample);
    for (const bad of ["a+b", "a/b", "ab==", "a b", "a", 5, null]) expect(fromB64url(bad), String(bad)).toBeNull();
  });
});

describe("decodeCbor", () => {
  test("reads integers of every width, negative ones, strings, bytes, arrays and maps", () => {
    for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, -1, -24, -25, -256, -257, -65537]) {
      expect(decodeCbor(cbor(n)).value, String(n)).toBe(n);
    }
    expect(decodeCbor(cbor("passkey")).value).toBe("passkey");
    expect(decodeCbor(cbor(Uint8Array.of(1, 2, 3))).value).toEqual(Uint8Array.of(1, 2, 3));
    expect(decodeCbor(cbor([1, "a", [2]])).value).toEqual([1, "a", [2]]);
    const map = decodeCbor(cbor(new Map<number | string, number>([["fmt", 1], [-1, 2]]))).value as Map<unknown, unknown>;
    expect(map.get("fmt")).toBe(1);
    expect(map.get(-1)).toBe(2);
  });

  test("says where the item ended, since authenticator data may carry more after a key", () => {
    const item = cbor(new Map([[1, 2]]));
    const padded = Uint8Array.of(...item, 0xff, 0xff);
    expect(decodeCbor(padded).end).toBe(item.length);
  });

  test("refuses truncated, indefinite, tagged, float and too-deep data", () => {
    const refused = (data: number[]) => expect(() => decodeCbor(Uint8Array.from(data))).toThrow();
    refused([]);
    refused([0x19, 0x01]); // a 16-bit integer, one byte
    refused([0x44, 1, 2]); // four bytes announced, two present
    refused([0x5f, 0x41, 1, 0xff]); // an indefinite byte string
    refused([0xc1, 0x00]); // a tag
    refused([0xf9, 0x3c, 0x00]); // a half-precision float
    refused([0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x00]); // nested ten deep
    refused([0xa1, 0x81, 0x00, 0x00]); // a map keyed by an array
    refused([0x9b, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // a length beyond the data
  });
});

describe.each([[-7 as Alg, "ES256"], [-8 as Alg, "EdDSA"], [-257 as Alg, "RS256"]])("a registration and a sign-in with %p (%s)", (alg) => {
  test("a good registration returns the credential id, the COSE key and its algorithm", async () => {
    const { key, registered } = await enrolled(alg);
    expect(registered.id).toBe(key.credentialId);
    expect(registered.alg).toBe(alg);
    expect(registered.signCount).toBe(0);
  });

  test("a good assertion verifies, and the counter is the authenticator's", async () => {
    const { key, stored } = await enrolled(alg);
    const verified = await verifyAssertion(assertion(await key.sign(ceremony)), expected, stored);
    expect(verified.signCount).toBe(1);
  });

  test("a bad signature is refused: one byte changed, and another key's", async () => {
    const { key, stored } = await enrolled(alg);
    const made = assertion(await key.sign(ceremony));
    const flipped = Uint8Array.from(made.signature);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    expect(await refusal(verifyAssertion({ ...made, signature: flipped }, expected, stored))).toContain("signature");

    const other = await SoftAuthenticator.create(alg);
    const forged = assertion(await other.sign(ceremony));
    expect(await refusal(verifyAssertion(forged, expected, stored))).toContain("signature");
  });
});

describe("verifyRegistration", () => {
  test("refuses a wrong origin, a wrong rpId, a wrong challenge and the wrong ceremony", async () => {
    const key = await SoftAuthenticator.create(-7);
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, origin: "https://evil.test-zone.invalid" })), expected))).toContain("origin");
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, rpId: "evil.invalid" })), expected))).toContain("relying party");
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, challenge: b64url(new Uint8Array(32)) })), expected))).toContain("challenge");
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, type: "webauthn.get" })), expected))).toContain("ceremony");
  });

  test("refuses a user who was not verified or not present", async () => {
    const key = await SoftAuthenticator.create(-7);
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, flags: { uv: false } })), expected))).toContain("not verified");
    expect(await refusal(verifyRegistration(registration(await key.register({ ...ceremony, flags: { up: false } })), expected))).toContain("not present");
  });

  test("refuses what is not an attestation object, and a key of an algorithm it does not take", async () => {
    const key = await SoftAuthenticator.create(-7);
    const made = registration(await key.register(ceremony));
    expect(await refusal(verifyRegistration({ ...made, attestationObject: Uint8Array.of(1, 2, 3) }, expected))).toContain("attestation object");
    expect(await refusal(verifyRegistration({ ...made, attestationObject: cbor(new Map([["fmt", "none"]])) }, expected))).toContain("authenticator data");

    // A credential whose key is ES384's: well formed, and not one the service takes.
    const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(RP_ID)));
    const id = crypto.getRandomValues(new Uint8Array(16));
    const cose = cbor(new Map<number, Item>([[1, 2], [3, -35], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]));
    const authData = Uint8Array.of(...rpIdHash, 0x45, 0, 0, 0, 0, ...new Uint8Array(16), 0, id.length, ...id, ...cose);
    const odd = cbor(new Map<string, Item>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    expect(await refusal(verifyRegistration({ ...made, attestationObject: odd }, expected))).toContain("does not take");
  });
});

describe("verifyAssertion", () => {
  test("refuses a wrong origin, a wrong rpId and a wrong challenge", async () => {
    const { key, stored } = await enrolled(-7);
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, origin: "https://evil.test-zone.invalid" })), expected, stored))).toContain("origin");
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, rpId: "evil.invalid" })), expected, stored))).toContain("relying party");
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, challenge: b64url(new Uint8Array(32)) })), expected, stored))).toContain("challenge");
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, type: "webauthn.create" })), expected, stored))).toContain("ceremony");
  });

  test("refuses a user not verified (the UV flag missing), even with a valid signature", async () => {
    const { key, stored } = await enrolled(-7);
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, flags: { uv: false } })), expected, stored))).toContain("not verified");
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, flags: { up: false } })), expected, stored))).toContain("not present");
  });

  test("refuses a signature over other authenticator data: the data is covered", async () => {
    const { key, stored } = await enrolled(-8);
    const made = assertion(await key.sign(ceremony));
    const authenticatorData = Uint8Array.from(made.authenticatorData);
    authenticatorData[36] = (authenticatorData[36]! + 1) & 255; // the counter, after it was signed
    expect(await refusal(verifyAssertion({ ...made, authenticatorData }, expected, stored))).toContain("signature");
  });

  test("a counter that does not grow is refused, one that does is taken, and zeros are no counter at all", async () => {
    const { key, stored } = await enrolled(-7);
    const first = await verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 5 })), expected, stored);
    expect(first.signCount).toBe(5);
    const seen = { ...stored, signCount: first.signCount };
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 5 })), expected, seen))).toContain("counter");
    expect(await refusal(verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 3 })), expected, seen))).toContain("counter");
    expect((await verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 6 })), expected, seen)).signCount).toBe(6);
    // A synced passkey keeps none: 0 now, or 0 stored, is not compared.
    expect((await verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 0 })), expected, seen)).signCount).toBe(0);
    expect((await verifyAssertion(assertion(await key.sign({ ...ceremony, signCount: 1 })), expected, { ...seen, signCount: 0 })).signCount).toBe(1);
  });
});

describe("Challenges", () => {
  test("single use: a replayed id is nothing", () => {
    const challenges = new Challenges();
    const { id, challenge } = challenges.issue("get", 1000);
    expect(challenges.take(id, "get", 1001)).toBe(challenge);
    expect(challenges.take(id, "get", 1002)).toBeNull();
  });

  test("two minutes, and not a millisecond more", () => {
    const challenges = new Challenges();
    const { id } = challenges.issue("get", 1000);
    expect(challenges.take(id, "get", 1000 + CHALLENGE_MS)).toBeNull();
    const second = challenges.issue("get", 1000);
    expect(challenges.take(second.id, "get", 1000 + CHALLENGE_MS - 1)).toBe(second.challenge);
  });

  test("one issued for the sign-in does not serve the registration, and is spent by the attempt", () => {
    const challenges = new Challenges();
    const { id } = challenges.issue("get", 1000);
    expect(challenges.take(id, "create", 1001)).toBeNull();
    expect(challenges.take(id, "get", 1002)).toBeNull();
  });

  test("an unknown id, or one that is not a string, is nothing", () => {
    const challenges = new Challenges();
    expect(challenges.take("nope", "get", 0)).toBeNull();
    expect(challenges.take(42, "get", 0)).toBeNull();
    expect(challenges.take(undefined, "get", 0)).toBeNull();
  });

  test("holds at most CHALLENGES_MAX, the oldest evicted", () => {
    const challenges = new Challenges();
    const first = challenges.issue("get", 1000);
    const ids = [first.id];
    for (let i = 1; i < CHALLENGES_MAX + 20; i += 1) ids.push(challenges.issue("get", 1000).id);
    expect(challenges.size).toBe(CHALLENGES_MAX);
    expect(challenges.take(first.id, "get", 1001)).toBeNull();
    expect(challenges.take(ids[ids.length - 1], "get", 1001)).not.toBeNull();
  });
});

describe("RateLimit", () => {
  test("lets a key through its quota in a window, then says how long to wait", () => {
    const limit = new RateLimit(3, 100);
    for (let i = 0; i < 3; i += 1) expect(limit.hit("a", 1000)).toBe(0);
    expect(limit.hit("a", 1000)).toBe(60);
    expect(limit.hit("a", 31_000)).toBe(30);
    expect(limit.hit("b", 1000)).toBe(0);
  });

  test("a new window starts afresh", () => {
    const limit = new RateLimit(1, 100);
    expect(limit.hit("a", 0)).toBe(0);
    expect(limit.hit("a", 1)).toBeGreaterThan(0);
    expect(limit.hit("a", 60_000)).toBe(0);
  });

  test("everybody together have a quota too, whoever they are", () => {
    const limit = new RateLimit(100, 5);
    for (let i = 0; i < 5; i += 1) expect(limit.hit(`ip-${i}`, 0)).toBe(0);
    expect(limit.hit("ip-new", 0)).toBeGreaterThan(0);
  });
});

describe("Challenges bound to something", () => {
  test("a challenge bound to a link or a flow is refused with anything else, and spent by the attempt", () => {
    const challenges = new Challenges();
    const { id } = challenges.issue("register", 1000, "link-hash");
    expect(challenges.take(id, "register", 1001, "other")).toBeNull();
    expect(challenges.take(id, "register", 1002, "link-hash")).toBeNull();
    const second = challenges.issue("register", 1000, "link-hash");
    expect(challenges.take(second.id, "register", 1001)).toBeNull();
    const third = challenges.issue("register", 1000, "link-hash");
    expect(challenges.take(third.id, "register", 1001, "link-hash")).toBe(third.challenge);
  });

  test("a smaller bound evicts sooner", () => {
    const challenges = new Challenges(2);
    const first = challenges.issue("get", 0);
    challenges.issue("get", 0);
    challenges.issue("get", 0);
    expect(challenges.size).toBe(2);
    expect(challenges.take(first.id, "get", 1)).toBeNull();
  });
});

describe("what the page posts", () => {
  test("an assertion and a registration read back as bytes, with the id and rawId agreeing", async () => {
    const key = await SoftAuthenticator.create(-7);
    const read = readPostedRegistration(await key.register(ceremony));
    expect(read?.id).toBe(key.credentialId);
    expect(read?.transports).toEqual(["internal"]);
    const signed = await key.sign(ceremony);
    const posted = readPostedAssertion(signed);
    expect(posted?.id).toBe(key.credentialId);
    expect(posted?.signature).toEqual(bytes(signed.response.signature));
  });

  test("refuses another type, ids that differ, a field that is not base64url, and oversized fields", async () => {
    const key = await SoftAuthenticator.create(-7);
    const signed = await key.sign(ceremony);
    expect(readPostedAssertion({ ...signed, type: "password" })).toBeNull();
    expect(readPostedAssertion({ ...signed, id: "AAAA" })).toBeNull();
    expect(readPostedAssertion({ ...signed, response: { ...signed.response, signature: "a+b" } })).toBeNull();
    expect(readPostedAssertion({ ...signed, response: { ...signed.response, clientDataJSON: "A".repeat(20_000) } })).toBeNull();
    expect(readPostedAssertion(null)).toBeNull();
    expect(readPostedAssertion("credential")).toBeNull();
    expect(readPostedRegistration({ ...(await key.register(ceremony)), rawId: "" })).toBeNull();
  });

  test("the owner's user handle is the same bytes everywhere", () => {
    expect(new TextDecoder().decode(bytes(OWNER_USER_HANDLE))).toBe("sitesolide-owner");
  });
});
