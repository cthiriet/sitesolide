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
  migrateTeam,
  DEAD_TOKEN_RETENTION_MS,
  MAX_TOKEN_RECORDS,
  pruneTeam,
  readHolder,
  viewOf,
  revokeMemberTokens,
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
    expect(readTeam(null)).toEqual({ version: 2, tokens: [], owners: {} });
    expect(readTeam("{")).toHaveProperty("unreadable");
    expect(readTeam(JSON.stringify({ tokens: [{ id: "x" }], owners: {} }))).toHaveProperty("unreadable");
    expect(readTeam(JSON.stringify({ tokens: [], owners: { "../x": "000000000000" } }))).toHaveProperty("unreadable");
  });

  test("the view never carries the hash", async () => {
    const { team } = await teamWith();
    expect(JSON.stringify(views(team))).not.toContain(team.tokens[0]!.hash);
  });
});

describe("dead tokens do not pile up", () => {
  /** A registry of records written by hand: `dead` days since each was revoked, null for a live one. */
  function teamOf(records: { id: string; dead: number | null; slugs?: number }[], owners: Record<string, string> = {}): Team {
    return {
      version: 2,
      tokens: records.map((one, n) => ({
        id: one.id,
        hash: n.toString(16).padStart(64, "0"),
        label: "ci",
        email: "ada@acme.test",
        member: "ada@acme.test",
        createdAt: NOW - 400 * 86_400_000 + n,
        expiresAt: null,
        revokedAt: one.dead === null ? null : NOW - one.dead * 86_400_000,
        lastUsedAt: null,
        scope: { slugs: Array.from({ length: one.slugs ?? 0 }, (_, i) => `${"project-with-a-long-name-".repeat(2)}${String(i).padStart(3, "0")}`), create: false, outbound: false, domain: false, public: false },
      })),
      owners,
    };
  }
  const id = (n: number) => n.toString(16).padStart(12, "0");

  test("revoked or expired past their 90 days, they go at the next write; younger ones, live ones and one that created a project stay", () => {
    const team = teamOf([{ id: id(1), dead: 91 }, { id: id(2), dead: 89 }, { id: id(3), dead: null }, { id: id(4), dead: 300 }], { blog: id(4) });
    const expired = { ...team, tokens: [...team.tokens, { ...team.tokens[2]!, id: id(5), hash: "f".repeat(64), expiresAt: NOW - DEAD_TOKEN_RETENTION_MS - 1 }] };
    const kept = pruneTeam(expired, NOW, 1024 * 1024);
    expect(kept?.tokens.map((one) => one.id)).toEqual([id(2), id(3), id(4)]);
    // Nothing to drop: the same registry back.
    expect(pruneTeam(kept!, NOW, 1024 * 1024)).toBe(kept);
  });

  test("past its cap of records or of bytes, the oldest dead go first, before their time; when the live alone do not fit, the change is refused", () => {
    const many = teamOf(Array.from({ length: MAX_TOKEN_RECORDS + 3 }, (_, n) => ({ id: id(n + 1), dead: n < MAX_TOKEN_RECORDS ? 10 + (MAX_TOKEN_RECORDS - n) / 1000 : null })));
    const capped = pruneTeam(many, NOW, 8 * 1024 * 1024)!;
    expect(capped.tokens).toHaveLength(MAX_TOKEN_RECORDS);
    // The oldest revoked, the first ones, went.
    expect(capped.tokens.some((one) => one.id === id(1))).toBe(false);
    const heavy = teamOf(Array.from({ length: 200 }, (_, n) => ({ id: id(n + 1), dead: n < 150 ? 1 : null, slugs: 100 })));
    const fitted = pruneTeam(heavy, NOW, 1024 * 1024)!;
    expect(Buffer.byteLength(encodeTeam(fitted))).toBeLessThanOrEqual(1024 * 1024);
    expect(fitted.tokens.filter((one) => one.revokedAt === null)).toHaveLength(50);
    expect(readTeam(encodeTeam(fitted))).not.toHaveProperty("unreadable");
    const live = teamOf(Array.from({ length: 200 }, (_, n) => ({ id: id(n + 1), dead: null, slugs: 100 })));
    expect(pruneTeam(live, NOW, 1024 * 1024)).toBeNull();
  });
});

describe("a project removed", () => {
  test("its owner forgotten, the others and every token kept; nothing to forget is said so", () => {
    const team: Team = { version: 2, tokens: [], owners: { shop: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" } };
    expect(forgetOwnership(team, "shop")).toEqual({ team: { version: 2, tokens: [], owners: { blog: "bbbbbbbbbbbb" } }, id: "aaaaaaaaaaaa" });
    expect(forgetOwnership(team, "notes")).toBeNull();
    expect(forgetOwnership(team, "constructor")).toBeNull();
    expect(team.owners).toEqual({ shop: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" });
  });
});

describe("whose a token is", () => {
  test("the owner names a holder: owner, or a person's email, lowercase; nothing else", () => {
    expect(readHolder("owner")).toBe("owner");
    expect(readHolder(" Alice@Acme.test ")).toBe("alice@acme.test");
    for (const value of ["", "alice", "@acme.test", 42, null, "a".repeat(250) + "@x.test"]) expect(readHolder(value)).toHaveProperty("refusal");
  });

  test("the owner's own carries no person and says the owner made it; one made for a person says so; a person's own, themselves", async () => {
    const own = await createToken(EMPTY_TEAM, { label: "agent", email: "owner", expiresAt: null, scope: SCOPE }, NOW, counter());
    if ("refusal" in own) throw new Error(own.refusal);
    expect(own.view).toMatchObject({ email: "owner", member: null, by: "owner" });
    const forAlice = await createToken(own.team, { label: "laptop", email: "alice@acme.test", expiresAt: null, scope: SCOPE }, NOW, counter(), "alice@acme.test", true);
    if ("refusal" in forAlice) throw new Error(forAlice.refusal);
    expect(forAlice.view).toMatchObject({ email: "alice@acme.test", member: "alice@acme.test", by: "owner" });
    const hers = await createToken(forAlice.team, { label: "agent", email: "alice@acme.test", expiresAt: null, scope: SCOPE }, NOW, counter(), "alice@acme.test");
    if ("refusal" in hers) throw new Error(hers.refusal);
    expect(hers.view).toMatchObject({ member: "alice@acme.test", by: "alice@acme.test" });
    // The file reads back with both, and a `by` other than the owner is refused.
    expect(readTeam(encodeTeam(hers.team))).toEqual(hers.team);
    expect(readTeam(encodeTeam({ ...hers.team, tokens: [{ ...hers.team.tokens[0]!, by: "mallory@acme.test" }] }))).toHaveProperty("unreadable");
  });

  test("a person leaving takes every token of theirs, the one the owner made for them included, never the owner's own", async () => {
    let team: Team = EMPTY_TEAM;
    for (const [email, member, byOwner] of [["owner", null, false], ["alice@acme.test", "alice@acme.test", true], ["alice@acme.test", "alice@acme.test", false]] as const) {
      const made = await createToken(team, { label: "x", email, expiresAt: null, scope: SCOPE }, NOW, counter(), member, byOwner);
      if ("refusal" in made) throw new Error(made.refusal);
      team = made.team;
    }
    const revoked = revokeMemberTokens(team, "alice@acme.test", NOW + 1);
    expect(revoked.revoked.map((view) => view.by).sort()).toEqual(["alice@acme.test", "owner"]);
    expect(revoked.team.tokens.filter((record) => record.revokedAt === null).map((record) => record.email)).toEqual(["owner"]);
  });
});

describe("the tokens from before every token belonged to someone", () => {
  async function legacy(): Promise<Team> {
    let team: Team = { ...EMPTY_TEAM, version: 1 };
    for (const email of ["alice@acme.test", "Contractor@Elsewhere.test", "bot@acme.test"]) {
      const made = await createToken(team, { label: email, email, expiresAt: null, scope: SCOPE }, NOW, counter());
      if ("refusal" in made) throw new Error(made.refusal);
      team = made.team;
    }
    return team;
  }

  test("a registry from before reads as version 1, one without a version field included", async () => {
    const team = await legacy();
    const text = JSON.stringify({ tokens: team.tokens, owners: team.owners });
    expect((readTeam(text) as Team).version).toBe(1);
    expect((readTeam(encodeTeam(team)) as Team).version).toBe(1);
    expect(readTeam(JSON.stringify({ version: 3, tokens: [], owners: {} }))).toHaveProperty("unreadable");
  });

  test("an email of a person of People becomes theirs, made by the owner; any other the owner's own, its email kept as its label", async () => {
    const migrated = migrateTeam(await legacy(), (email) => email === "alice@acme.test");
    expect(migrated.team.version).toBe(2);
    const views = migrated.team.tokens.map((record) => viewOf(migrated.team, record));
    expect(views.map((view) => [view.email, view.member, view.by])).toEqual([
      ["alice@acme.test", "alice@acme.test", "owner"],
      ["Contractor@Elsewhere.test", null, "owner"],
      ["bot@acme.test", null, "owner"],
    ]);
    expect(migrated.persons.map((record) => record.id)).toEqual([migrated.team.tokens[0]!.id]);
    expect(migrated.owner).toHaveLength(2);
  });

  test("once migrated, never again: a person who signs in later does not take over the owner's token", async () => {
    const once = migrateTeam(await legacy(), () => false);
    const again = migrateTeam(once.team, () => true);
    expect(again.team).toBe(once.team);
    expect(again.persons).toEqual([]);
  });

  test("a registry begun on this code has nothing to migrate", () => {
    expect(EMPTY_TEAM.version).toBe(2);
    expect(migrateTeam(EMPTY_TEAM, () => true).team).toBe(EMPTY_TEAM);
  });
});
