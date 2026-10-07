import { describe, expect, test } from "bun:test";
import type { Identity, Scope } from "../src/control/protocol";
import { recordCreation, type Registry } from "../src/members/registry";
import { deployRefusal, installScope, mintRefusals, narrowIdentity, rightsOf, scopeText, type MemberRights } from "../src/members/tokens";

/**
 * A member's own tokens, pure: what they may mint, and what one of theirs
 * may do once their roles have moved. The steward and the installer run
 * these on the registry they read at that moment (control-members.test.ts,
 * installer-main.test.ts).
 */

const T = 1_800_000_000_000;
const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false };
const scope = (part: Partial<Scope>): Scope => ({ ...NONE, ...part });

/** Ada: a developer on alpha, a project admin on beta, a viewer on gamma, and may not create projects. */
const ADA: MemberRights = { email: "ada@acme.test", roles: { alpha: "developer", beta: "admin", gamma: "viewer" }, create: false };

describe("minting", () => {
  test("within their roles: the projects they deploy, and the options where they are project admin", () => {
    expect(mintRefusals(scope({ slugs: ["alpha"] }), ADA)).toEqual([]);
    expect(mintRefusals(scope({ slugs: ["alpha", "beta"] }), ADA)).toEqual([]);
    expect(mintRefusals(scope({ slugs: ["beta"], public: true, outbound: true, domain: true }), ADA)).toEqual([]);
  });

  test("above them: a viewed project, a project of no role, each said in the steward's words", () => {
    expect(mintRefusals(scope({ slugs: ["gamma"] }), ADA)).toEqual(["scope.slugs: ada@acme.test is a viewer on gamma: deploying it takes a developer or a project admin"]);
    expect(mintRefusals(scope({ slugs: ["delta"] }), ADA)).toEqual(["scope.slugs: ada@acme.test holds no role on delta"]);
  });

  test("the options are a project admin's: refused on a project where they are a developer, every reason at once", () => {
    const refusals = mintRefusals(scope({ slugs: ["alpha", "beta"], public: true, outbound: true }), ADA);
    expect(refusals).toEqual([
      "scope.public: ada@acme.test is a developer on alpha: deploying it in the open, without the portal, takes a project admin",
      "scope.outbound: ada@acme.test is a developer on alpha: letting it reach outside hosts takes a project admin",
    ]);
    expect(mintRefusals(scope({ slugs: ["alpha"], domain: true }), ADA)).toEqual(["scope.domain: ada@acme.test is a developer on alpha: declaring a domain for it takes a project admin"]);
  });

  test("creating projects takes the right the super admin grants", () => {
    expect(mintRefusals(scope({ create: true }), ADA)).toEqual([
      "scope.create: ada@acme.test may not create projects: creating projects is a right the super admin grants, from the Members page",
    ]);
    const creator = { ...ADA, create: true };
    expect(mintRefusals(scope({ create: true }), creator)).toEqual([]);
    // What a creator creates makes them its project admin: the options go with creating alone.
    expect(mintRefusals(scope({ create: true, public: true, outbound: true }), creator)).toEqual([]);
    // Not with a project they only develop.
    expect(mintRefusals(scope({ slugs: ["alpha"], create: true, outbound: true }), creator)).toHaveLength(1);
  });

  test("a viewer everywhere, without the create right, mints nothing; an empty scope is no token", () => {
    const viewer: MemberRights = { email: "vic@acme.test", roles: { alpha: "viewer" }, create: false };
    expect(mintRefusals(scope({ slugs: ["alpha"] }), viewer)).toEqual(["vic@acme.test is a viewer on every project and may not create projects: a viewer mints no token"]);
    expect(mintRefusals(NONE, ADA)).toEqual(["scope.slugs: choose at least one project, or creating projects"]);
    // A viewer who may create mints a token that creates, and nothing else.
    expect(mintRefusals(scope({ create: true }), { ...viewer, create: true })).toEqual([]);
    expect(mintRefusals(scope({ slugs: ["alpha"] }), { ...viewer, create: true })).toHaveLength(1);
  });
});

describe("narrowed live", () => {
  const minted: Identity = {
    id: "aaaaaaaaaaaa",
    label: "laptop",
    email: "ada@acme.test",
    expiresAt: null,
    scope: scope({ slugs: ["alpha", "beta"], create: true, outbound: true }),
    owned: ["omega"],
    member: "ada@acme.test",
  };
  const creator: MemberRights = { email: "ada@acme.test", roles: { alpha: "admin", beta: "admin", omega: "admin" }, create: true };

  test("as minted while their roles hold", () => {
    expect(narrowIdentity(minted, creator)).toEqual(minted);
  });

  test("a role lowered to viewer takes that project off, granted or created", () => {
    const narrowed = narrowIdentity(minted, { ...creator, roles: { alpha: "viewer", beta: "admin", omega: "viewer" } });
    expect(narrowed.scope.slugs).toEqual(["beta"]);
    expect(narrowed.owned).toEqual([]);
    expect(narrowed.scope.outbound).toBe(true);
  });

  test("a role lowered to developer turns the options off for the whole token, the narrower reading", () => {
    const narrowed = narrowIdentity(minted, { ...creator, roles: { alpha: "developer", beta: "admin", omega: "admin" } });
    expect(narrowed.scope).toEqual({ slugs: ["alpha", "beta"], create: true, outbound: false, domain: false, public: false });
  });

  test("the create right taken back stops creating; a token left with nothing keeps no option", () => {
    const narrowed = narrowIdentity(minted, { email: "ada@acme.test", roles: {}, create: false });
    expect(narrowed.scope).toEqual(NONE);
    expect(narrowed.owned).toEqual([]);
    expect(narrowed.member).toBe("ada@acme.test");
  });

  test("deploying a slug: the role on an existing project, the create right for a new one", () => {
    expect(deployRefusal(ADA, "alpha", true)).toBeNull();
    expect(deployRefusal(ADA, "gamma", true)).toBe("ada@acme.test is a viewer on gamma: deploying it takes a developer or a project admin");
    expect(deployRefusal(ADA, "delta", true)).toBe("ada@acme.test holds no role on delta");
    expect(deployRefusal(ADA, "fresh", false)).toContain("may not create projects");
    expect(deployRefusal({ ...ADA, create: true }, "fresh", false)).toBeNull();
  });
});

describe("in the installer", () => {
  const asked = scope({ slugs: ["alpha", "beta"], public: true, outbound: true, domain: true });

  test("a member removed since: refused, nothing changed", () => {
    expect(installScope(asked, null, "beta", false)).toEqual({ refusal: "the member who holds this token is no longer a member of this dashboard: nothing was changed" });
  });

  test("an existing project: a developer's deployment loses the options, a viewer's is refused", () => {
    expect(installScope(asked, ADA, "beta", false)).toEqual({ scope: asked });
    expect(installScope(asked, ADA, "alpha", false)).toEqual({ scope: { ...asked, public: false, outbound: false, domain: false } });
    expect(installScope(asked, ADA, "gamma", false)).toEqual({ refusal: "ada@acme.test is a viewer on gamma: deploying it takes a developer or a project admin: nothing was changed" });
  });

  test("a new project takes the create right, as it reads when the installer starts", () => {
    expect(installScope(scope({ create: true }), ADA, "fresh", true)).toEqual({ refusal: "ada@acme.test may no longer create projects: nothing was changed" });
    expect(installScope(scope({ create: true }), { ...ADA, create: true }, "fresh", true)).toEqual({ scope: scope({ create: true }) });
  });
});

describe("the registry's side", () => {
  const registry: Registry = {
    members: [{ email: "ada@acme.test", roles: { alpha: "developer", omega: "viewer" }, create: true, invitedBy: "owner", createdAt: T, updatedAt: T }],
  };

  test("rights as the registry reads them, none for a stranger", () => {
    expect(rightsOf(registry, "ada@acme.test")).toEqual({ email: "ada@acme.test", roles: { alpha: "developer", omega: "viewer" }, create: true });
    expect(rightsOf(registry, "eve@acme.test")).toBeNull();
  });

  test("a project they create makes them its project admin, whatever was written there by hand, the rest kept", () => {
    const created = recordCreation(registry, "ada@acme.test", "omega", T + 1);
    expect(created).toMatchObject({ change: "role", member: { roles: { alpha: "developer", omega: "admin" }, create: true, invitedBy: "owner", updatedAt: T + 1 } });
    expect(recordCreation(registry, "eve@acme.test", "omega", T + 1)).toEqual({ refusal: "eve@acme.test is no longer a member of this dashboard" });
  });

  test("a scope in a line, for the journal", () => {
    expect(scopeText(scope({ slugs: ["alpha"] }))).toBe("alpha");
    expect(scopeText(scope({ create: true, outbound: true }))).toBe("no project; create, outbound");
  });
});
