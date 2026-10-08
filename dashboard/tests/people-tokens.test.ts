import { describe, expect, test } from "bun:test";
import type { Identity, Scope } from "../src/control/protocol";
import { recordCreation, rightsOf, rolesText } from "../src/access/registry";
import { deployRefusal, installScope, mintRefusals, narrowIdentity, scopeText, type MemberRights } from "../src/people/tokens";
import { registryOf } from "./registry-fixtures";

/**
 * A person's own tokens, pure: what they may mint, and what one of theirs
 * may do once their roles have moved. The steward and the installer run
 * these on the access registry they read at that moment
 * (control-people.test.ts, installer-main.test.ts).
 */

const T = 1_800_000_000_000;
const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false };
const scope = (part: Partial<Scope>): Scope => ({ ...NONE, ...part });

/** Ada: a Developer on alpha, an Admin on beta, a Viewer on gamma, and may not create projects. */
const ADA: MemberRights = { email: "ada@acme.test", roles: { alpha: "developer", beta: "admin", gamma: "viewer" }, create: false };

describe("minting", () => {
  test("within their roles: the projects they deploy, and the options where they are Admin", () => {
    expect(mintRefusals(scope({ slugs: ["alpha"] }), ADA)).toEqual([]);
    expect(mintRefusals(scope({ slugs: ["alpha", "beta"] }), ADA)).toEqual([]);
    expect(mintRefusals(scope({ slugs: ["beta"], public: true, outbound: true, domain: true }), ADA)).toEqual([]);
  });

  test("above them: a viewed project, a project of no role, each said in the steward's words", () => {
    expect(mintRefusals(scope({ slugs: ["gamma"] }), ADA)).toEqual(["scope.slugs: ada@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin"]);
    expect(mintRefusals(scope({ slugs: ["delta"] }), ADA)).toEqual(["scope.slugs: ada@acme.test holds no role on delta"]);
  });

  test("the options are an Admin's: refused on a project where they are a Developer, every reason at once", () => {
    const refusals = mintRefusals(scope({ slugs: ["alpha", "beta"], public: true, outbound: true }), ADA);
    expect(refusals).toEqual([
      "scope.public: ada@acme.test is a Developer on alpha: deploying it in the open, its general access public, takes an Admin",
      "scope.outbound: ada@acme.test is a Developer on alpha: letting it reach outside hosts takes an Admin",
    ]);
    expect(mintRefusals(scope({ slugs: ["alpha"], domain: true }), ADA)).toEqual(["scope.domain: ada@acme.test is a Developer on alpha: declaring a domain for it takes an Admin"]);
  });

  test("creating projects takes the right the owner grants", () => {
    expect(mintRefusals(scope({ create: true }), ADA)).toEqual([
      "scope.create: ada@acme.test may not create projects: creating projects is a right the owner grants, from the People page",
    ]);
    const creator = { ...ADA, create: true };
    expect(mintRefusals(scope({ create: true }), creator)).toEqual([]);
    // What a creator creates makes them its Admin: the options go with creating alone.
    expect(mintRefusals(scope({ create: true, public: true, outbound: true }), creator)).toEqual([]);
    // Not with a project they only develop.
    expect(mintRefusals(scope({ slugs: ["alpha"], create: true, outbound: true }), creator)).toHaveLength(1);
  });

  test("a Viewer everywhere, without the create right, mints nothing; an empty scope is no token", () => {
    const viewer: MemberRights = { email: "vic@acme.test", roles: { alpha: "viewer" }, create: false };
    expect(mintRefusals(scope({ slugs: ["alpha"] }), viewer)).toEqual(["vic@acme.test is a Viewer on every project and may not create projects: a Viewer mints no token"]);
    expect(mintRefusals(NONE, ADA)).toEqual(["scope.slugs: choose at least one project, or creating projects"]);
    // A Viewer who may create mints a token that creates, and nothing else.
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

  test("a role lowered to Viewer takes that project off, granted or created", () => {
    const narrowed = narrowIdentity(minted, { ...creator, roles: { alpha: "viewer", beta: "admin", omega: "viewer" } });
    expect(narrowed.scope.slugs).toEqual(["beta"]);
    expect(narrowed.owned).toEqual([]);
    expect(narrowed.scope.outbound).toBe(true);
  });

  test("a role lowered to Developer turns the options off for the whole token, the narrower reading", () => {
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
    expect(deployRefusal(ADA, "gamma", true)).toBe("ada@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin");
    expect(deployRefusal(ADA, "delta", true)).toBe("ada@acme.test holds no role on delta");
    expect(deployRefusal(ADA, "fresh", false)).toContain("may not create projects");
    expect(deployRefusal({ ...ADA, create: true }, "fresh", false)).toBeNull();
  });
});

describe("in the installer", () => {
  const asked = scope({ slugs: ["alpha", "beta"], public: true, outbound: true, domain: true });

  test("a person with no role left since: refused, nothing changed", () => {
    expect(installScope(asked, null, "beta", false)).toEqual({ refusal: "the person who holds this token no longer has a role on this dashboard: nothing was changed" });
  });

  test("an existing project: a Developer's deployment loses the options, a Viewer's is refused", () => {
    expect(installScope(asked, ADA, "beta", false)).toEqual({ scope: asked });
    expect(installScope(asked, ADA, "alpha", false)).toEqual({ scope: { ...asked, public: false, outbound: false, domain: false } });
    expect(installScope(asked, ADA, "gamma", false)).toEqual({ refusal: "ada@acme.test is a Viewer on gamma: deploying it takes a Developer or an Admin: nothing was changed" });
  });

  test("a new project takes the create right, as it reads when the installer starts", () => {
    expect(installScope(scope({ create: true }), ADA, "fresh", true)).toEqual({ refusal: "ada@acme.test may no longer create projects: nothing was changed" });
    expect(installScope(scope({ create: true }), { ...ADA, create: true }, "fresh", true)).toEqual({ scope: scope({ create: true }) });
  });
});

describe("the access registry's side", () => {
  /** Ada: a Developer on alpha, a Viewer on omega, Can open on beta, and may create projects; Carol can only open beta. */
  const registry = registryOf({ "ada@acme.test": { alpha: "developer", omega: "viewer", beta: "visitor" }, "carol@acme.test": { beta: "visitor" } }, ["ada@acme.test"], T);

  test("rights as the registry reads them, Can open left out; none for a stranger, nor for someone who can only open sites", () => {
    expect(rightsOf(registry, "ada@acme.test")).toEqual({ email: "ada@acme.test", roles: { alpha: "developer", omega: "viewer" }, create: true });
    expect(rightsOf(registry, "eve@acme.test")).toBeNull();
    expect(rightsOf(registry, "carol@acme.test")).toBeNull();
    // The create right alone is enough to sign in, with no project yet.
    expect(rightsOf(registryOf({}, ["dan@acme.test"]), "dan@acme.test")).toEqual({ email: "dan@acme.test", roles: {}, create: true });
  });

  test("a project they create makes them its Admin, whatever was written there by hand, the rest kept", () => {
    const created = recordCreation(registry, "ada@acme.test", "omega", T + 1);
    if ("refusal" in created) throw new Error(created.refusal);
    expect(created.change).toBe("role");
    expect(created.entry).toMatchObject({ who: "ada@acme.test", role: "admin", createdAt: T, updatedAt: T + 1 });
    expect(rightsOf(created.registry, "ada@acme.test")).toEqual({ email: "ada@acme.test", roles: { alpha: "developer", omega: "admin" }, create: true });
    const fresh = recordCreation(registry, "ada@acme.test", "zeta", T + 1);
    expect(fresh).toMatchObject({ change: "add", entry: { who: "ada@acme.test", role: "admin", by: "ada@acme.test" } });
    expect(recordCreation(registry, "eve@acme.test", "omega", T + 1)).toEqual({ refusal: "eve@acme.test no longer signs in to this dashboard", code: "out-of-scope" });
    expect(recordCreation(registry, "carol@acme.test", "omega", T + 1)).toMatchObject({ code: "out-of-scope" });
  });

  test("roles and a scope in a line, for the journal", () => {
    expect(rolesText({ shop: "viewer", blog: "developer" })).toBe("blog: developer, shop: viewer");
    expect(rolesText({})).toBe("no project");
    expect(scopeText(scope({ slugs: ["alpha"] }))).toBe("alpha");
    expect(scopeText(scope({ create: true, outbound: true }))).toBe("no project; create, outbound");
  });
});
