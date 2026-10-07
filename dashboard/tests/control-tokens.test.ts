import { describe, expect, test } from "bun:test";
import { tokenHash } from "../src/sessions";
import {
  forgetOwnership,
  EMPTY_TEAM,
  LAST_USE_STEP_MS,
  authenticate,
  bearerOf,
  createToken,
  encodeTeam,
  isTokenShape,
  readScope,
  readTeam,
  readTokenRequest,
  recordOwnership,
  refusalMessage,
  revokeToken,
  touch,
  views,
  type Team,
} from "../src/control/tokens";

const ZONE = "test-zone.invalid";
const NOW = 1_800_000_000_000;
const SCOPE = { slugs: ["cms"], create: true, outbound: false, domain: false, public: false };

/** A random source that counts up: every draw differs, and the test is repeatable. */
function counter(): (bytes: number) => Uint8Array {
  let next = 1;
  return (bytes) => Uint8Array.from({ length: bytes }, () => next++ % 256);
}

async function teamWith(scope = SCOPE): Promise<{ team: Team; secret: string; id: string }> {
  const request = readTokenRequest({ label: "Ada's laptop", email: "Ada@Test-Zone.invalid", expiresAt: null, scope }, NOW, ZONE);
  if ("refusal" in request) throw new Error(request.refusal);
  const created = await createToken(EMPTY_TEAM, request, NOW, counter());
  if ("refusal" in created) throw new Error(created.refusal);
  return { team: created.team, secret: created.secret, id: created.view.id };
}

describe("the token's value", () => {
  test("sst_ and 43 characters of base64url, 256 bits, kept only as its SHA-256", async () => {
    const { team, secret } = await teamWith();
    expect(secret).toMatch(/^sst_[A-Za-z0-9_-]{43}$/);
    expect(isTokenShape(secret)).toBe(true);
    expect(team.tokens[0]!.hash).toBe(await tokenHash(secret));
    expect(encodeTeam(team)).not.toContain(secret);
  });

  test("anything else does not have the shape, and is never hashed", () => {
    for (const value of [undefined, null, 42, "", "sst_", "sst_short", `sk_${"a".repeat(43)}`, `sst_${"a".repeat(42)}!`, `sst_${"a".repeat(44)}`]) {
      expect(isTokenShape(value)).toBe(false);
    }
  });

  test("the Authorization header: the bearer scheme in any case, one value", () => {
    expect(bearerOf("Bearer sst_abc")).toBe("sst_abc");
    expect(bearerOf("bearer sst_abc")).toBe("sst_abc");
    expect(bearerOf(null)).toBeNull();
    expect(bearerOf("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerOf("Bearer a b")).toBeNull();
    expect(bearerOf("Bearer")).toBeNull();
  });
});

describe("what the owner asks for", () => {
  test("a label, an email lowered, an expiry in the future, a scope", () => {
    expect(readTokenRequest({ label: " Ada ", email: "ADA@test-zone.invalid", expiresAt: NOW + 1000, scope: SCOPE }, NOW, ZONE)).toEqual({
      label: "Ada",
      email: "ada@test-zone.invalid",
      expiresAt: NOW + 1000,
      scope: SCOPE,
    });
  });

  test("each malformed field is refused with what to send", () => {
    const base = { label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: SCOPE };
    const refusals: [Record<string, unknown>, string][] = [
      [{ ...base, label: "" }, "label"],
      [{ ...base, label: "a\nb" }, "label"],
      [{ ...base, label: "x".repeat(65) }, "label"],
      [{ ...base, email: "ada" }, "email"],
      [{ ...base, email: 42 }, "email"],
      [{ ...base, expiresAt: NOW }, "future"],
      [{ ...base, expiresAt: "tomorrow" }, "expiresAt"],
      [{ ...base, expiresAt: NOW + 6 * 365 * 24 * 3600 * 1000 }, "five years"],
    ];
    for (const [body, expected] of refusals) {
      const read = readTokenRequest(body, NOW, ZONE);
      expect("refusal" in read && read.refusal).toContain(expected);
    }
  });

  test("a scope: every flag a boolean, slugs that are slugs, no reserved one, no extra field", () => {
    expect(readScope({ slugs: ["b", "a", "a"], create: false, outbound: false, domain: false, public: false }, ZONE)).toEqual({
      slugs: ["a", "b"],
      create: false,
      outbound: false,
      domain: false,
      public: false,
    });
    const refused = [
      null,
      { slugs: "cms", create: false, outbound: false, domain: false, public: false },
      { slugs: [], create: "yes", outbound: false, domain: false, public: false },
      { slugs: [], outbound: false, domain: false, public: false },
      { slugs: ["Bad Slug"], create: false, outbound: false, domain: false, public: false },
      { slugs: ["dashboard"], create: false, outbound: false, domain: false, public: false },
      { slugs: [ZONE], create: false, outbound: false, domain: false, public: false },
      { slugs: [], create: false, outbound: false, domain: false, public: false, admin: true },
    ];
    for (const scope of refused) expect("refusal" in readScope(scope, ZONE)).toBe(true);
  });
});

describe("authentication", () => {
  test("the right value is accepted, with its identity", async () => {
    const { team, secret, id } = await teamWith();
    const result = await authenticate(team, secret, NOW + 1);
    expect(result).toMatchObject({ kind: "accepted", identity: { id, email: "ada@test-zone.invalid", scope: SCOPE, owned: [] } });
  });

  test("an unknown value, a revoked token, an expired token: refused with their reason", async () => {
    const { team, secret, id } = await teamWith();
    expect(await authenticate(team, `sst_${"A".repeat(43)}`, NOW)).toEqual({ kind: "refused", reason: "unknown" });
    expect(await authenticate(team, "not a token", NOW)).toEqual({ kind: "refused", reason: "unknown" });

    const revoked = revokeToken(team, id, NOW + 5);
    if ("refusal" in revoked) throw new Error(revoked.refusal);
    expect(await authenticate(revoked.team, secret, NOW + 6)).toEqual({ kind: "refused", reason: "revoked", member: false });

    const expiring = { ...team, tokens: [{ ...team.tokens[0]!, expiresAt: NOW + 10 }] };
    expect((await authenticate(expiring, secret, NOW + 9)).kind).toBe("accepted");
    expect(await authenticate(expiring, secret, NOW + 10)).toEqual({ kind: "refused", reason: "expired", member: false });
  });

  test("the message tells the holder what to do, and an unknown value learns nothing", () => {
    expect(refusalMessage({ kind: "refused", reason: "expired" })).toContain("expired");
    expect(refusalMessage({ kind: "refused", reason: "revoked" })).toContain("revoked");
    expect(refusalMessage({ kind: "refused", reason: "unknown" })).toContain("Authorization: Bearer");
    // A person's own: mint another, rather than ask the owner.
    expect(refusalMessage({ kind: "refused", reason: "revoked", member: true })).toContain("mint a new one from the dashboard's Tokens page if you still have a role there");
    expect(refusalMessage({ kind: "refused", reason: "expired", member: false })).toContain("ask the owner of the machine");
  });
});

describe("the registry", () => {
  test("revoking twice changes nothing the second time, an unknown id is refused", async () => {
    const { team, id } = await teamWith();
    const once = revokeToken(team, id, NOW + 1);
    if ("refusal" in once) throw new Error(once.refusal);
    const twice = revokeToken(once.team, id, NOW + 2);
    expect("refusal" in twice ? null : twice.team).toBe(once.team);
    expect(revokeToken(team, "000000000000", NOW)).toEqual({ refusal: "no such token" });
    expect(revokeToken(team, "../etc", NOW)).toEqual({ refusal: "not a token id" });
  });

  test("ownership is recorded once, and shows in the token's projects", async () => {
    const { team, id } = await teamWith();
    const owned = recordOwnership(team, "shop", id)!;
    expect(recordOwnership(owned, "shop", id)).toBeNull();
    expect(views(owned)[0]!.owned).toEqual(["shop"]);
  });

  test("the last use moves by whole hours, and is not rewritten within one", async () => {
    const { team, id } = await teamWith();
    const touched = touch(team, id, NOW + 10)!;
    expect(touched.tokens[0]!.lastUsedAt).toBe(NOW + 10 - ((NOW + 10) % LAST_USE_STEP_MS));
    expect(touch(touched, id, NOW + 20)).toBeNull();
  });

  test("the file round-trips, and a file that does not read refuses everyone", async () => {
    const { team } = await teamWith();
    expect(readTeam(encodeTeam(team))).toEqual(team);
    expect(readTeam(null)).toEqual({ tokens: [], owners: {} });
    expect(readTeam("{")).toHaveProperty("unreadable");
    expect(readTeam(JSON.stringify({ tokens: [{ id: "x" }], owners: {} }))).toHaveProperty("unreadable");
    expect(readTeam(JSON.stringify({ tokens: [], owners: { "../x": "000000000000" } }))).toHaveProperty("unreadable");
  });

  test("the view never carries the hash", async () => {
    const { team } = await teamWith();
    expect(JSON.stringify(views(team))).not.toContain(team.tokens[0]!.hash);
  });
});

describe("a project removed", () => {
  test("its owner forgotten, the others and every token kept; nothing to forget is said so", () => {
    const team = { tokens: [], owners: { shop: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" } };
    expect(forgetOwnership(team, "shop")).toEqual({ team: { tokens: [], owners: { blog: "bbbbbbbbbbbb" } }, id: "aaaaaaaaaaaa" });
    expect(forgetOwnership(team, "notes")).toBeNull();
    expect(forgetOwnership(team, "constructor")).toBeNull();
    expect(team.owners).toEqual({ shop: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" });
  });
});
