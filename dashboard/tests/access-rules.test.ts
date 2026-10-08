import { describe, expect, test } from "bun:test";
import { readProjection, type Role } from "../borrowed/access";
import {
  EMPTY_REGISTRY,
  dashboardRolesOf,
  encodeRegistry,
  entryViews,
  isDashboardPerson,
  peopleViews,
  projectionOf,
  putEntry,
  readRegistry,
  readWho,
  recordCreation,
  removeEntry,
  removePerson,
  rightsOf,
  setCreate,
  type Registry,
} from "../src/access/registry";
import { grantCeiling, judgeGrant, judgeRemoval, projectRefusal, readDuration, type Granter } from "../src/access/rules";
import type { SignInSettings } from "../src/access/protocol";

/**
 * The access rules, pure: who may give whom which role, what the registry
 * reads back as, and what the portal is handed. The routes that apply them,
 * as root, are in access-steward.test.ts.
 */

const NOW = 1_800_000_000_000;
const SSO: SignInSettings = { configured: true, allowedDomains: ["acme.test"], admins: ["boss@elsewhere.test"], providerName: null };
const NO_SSO: SignInSettings = { configured: false, allowedDomains: [], admins: [], providerName: null };
const OWNER: Granter = { kind: "owner" };
const PASSWORD = { id: "AAAAAAAAAAAAAAAA", hash: "a".repeat(64), expiresAt: NOW + 1000 };

/** A registry with these entries on these projects. */
function registry(projects: Record<string, [string, "visitor" | "viewer" | "developer" | "admin"][]>, creators: string[] = []): Registry {
  let next: Registry = EMPTY_REGISTRY;
  for (const [slug, entries] of Object.entries(projects)) {
    for (const [who, role] of entries) {
      const put = putEntry(next, slug, who, role, "owner", NOW);
      if ("refusal" in put) throw new Error(put.refusal);
      next = put.registry;
    }
  }
  for (const email of creators) {
    const set = setCreate(next, email, true, "owner", NOW);
    if ("refusal" in set) throw new Error(set.refusal);
    next = set.registry;
  }
  return next;
}

const admin = (email: string, role: Role | null): Granter => ({ kind: "admin", email, role });

describe("who may be named", () => {
  test("an email or a whole domain written with its @, cleaned by the portal's rules", () => {
    expect(readWho(" Alice@ACME.test ")).toEqual({ kind: "person", who: "alice@acme.test", email: "alice@acme.test" });
    expect(readWho("@Acme.Test")).toEqual({ kind: "domain", who: "@acme.test", domain: "acme.test" });
  });

  test("a bare domain is said to need its @; anything else is refused", () => {
    expect(readWho("acme.test")).toMatchObject({ refusal: expect.stringContaining("@acme.test") });
    expect(readWho("not an address")).toMatchObject({ refusal: expect.any(String) });
    expect(readWho("@com")).toMatchObject({ refusal: expect.any(String) });
    expect(readWho(42)).toMatchObject({ refusal: expect.any(String) });
  });
});

describe("the role ladder and who may give what", () => {
  test("the owner grants anything, an admin at most their own, others nothing", () => {
    expect(grantCeiling(OWNER)).toBe("admin");
    expect(grantCeiling(admin("ann@acme.test", "admin"))).toBe("admin");
    expect(grantCeiling(admin("dev@acme.test", "developer"))).toBeNull();
    expect(grantCeiling(admin("viewer@acme.test", "viewer"))).toBeNull();
    expect(grantCeiling(admin("nobody@acme.test", null))).toBeNull();
  });

  test("a token gives Can open alone, and only when its person is the project's Admin", () => {
    expect(grantCeiling({ kind: "token", id: "t1", email: null, role: null })).toBe("visitor");
    expect(grantCeiling({ kind: "token", id: "t2", email: "ann@acme.test", role: "admin" })).toBe("visitor");
    expect(grantCeiling({ kind: "token", id: "t3", email: "dev@acme.test", role: "developer" })).toBeNull();
  });

  test("an admin grants up to Admin on their project, the owner too; a developer grants nothing", () => {
    const empty = registry({});
    for (const role of ["visitor", "viewer", "developer", "admin"] as const) {
      expect(judgeGrant(empty, "blog", "new@acme.test", role, OWNER, SSO)).toMatchObject({ role, password: false });
      expect(judgeGrant(empty, "blog", "new@acme.test", role, admin("ann@acme.test", "admin"), SSO)).toMatchObject({ role });
    }
    expect(judgeGrant(empty, "blog", "new@acme.test", "visitor", admin("dev@acme.test", "developer"), SSO)).toMatchObject({ code: "out-of-scope" });
  });

  test("a token never gives more than Can open", () => {
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    expect(judgeGrant(registry({}), "blog", "new@acme.test", "visitor", token, SSO)).toMatchObject({ role: "visitor" });
    expect(judgeGrant(registry({}), "blog", "new@acme.test", "viewer", token, SSO)).toMatchObject({ refusal: expect.stringContaining("Can open alone"), code: "out-of-scope" });
  });

  test("nobody lowers or keeps someone above what they may give", () => {
    const current = registry({ blog: [["top@acme.test", "admin"]] });
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    expect(judgeGrant(current, "blog", "top@acme.test", "visitor", token, SSO)).toMatchObject({ code: "out-of-scope" });
    expect(judgeGrant(current, "blog", "top@acme.test", "viewer", admin("ann@acme.test", "admin"), SSO)).toMatchObject({ role: "viewer", unlock: false });
  });

  test("raising someone above Can open asks for the unlock; Can open, lowering and keeping do not", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"], ["see@acme.test", "visitor"]] });
    expect(judgeGrant(current, "blog", "new@acme.test", "viewer", OWNER, SSO)).toMatchObject({ unlock: true });
    expect(judgeGrant(current, "blog", "see@acme.test", "developer", OWNER, SSO)).toMatchObject({ unlock: true });
    expect(judgeGrant(current, "blog", "dev@acme.test", "viewer", OWNER, SSO)).toMatchObject({ unlock: false });
    expect(judgeGrant(current, "blog", "dev@acme.test", "developer", OWNER, SSO)).toMatchObject({ unlock: false });
    expect(judgeGrant(current, "blog", "new@acme.test", "visitor", OWNER, SSO)).toMatchObject({ unlock: false });
    expect(judgeGrant(current, "blog", "@acme.test", "visitor", OWNER, SSO)).toMatchObject({ unlock: false });
  });
});

describe("domains", () => {
  test("a domain is Can open only", () => {
    expect(judgeGrant(registry({}), "blog", "@acme.test", "visitor", OWNER, SSO)).toMatchObject({ who: { kind: "domain" }, role: "visitor" });
    expect(judgeGrant(registry({}), "blog", "@acme.test", "viewer", OWNER, SSO)).toMatchObject({ refusal: expect.stringContaining("Can open"), code: "invalid" });
    expect(judgeGrant(registry({}), "blog", "@acme.test", "admin", OWNER, SSO)).toMatchObject({ code: "invalid" });
  });

  test("without company sign-in a domain could open nothing, and is refused", () => {
    expect(judgeGrant(registry({}), "blog", "@acme.test", "visitor", OWNER, NO_SSO)).toMatchObject({ refusal: expect.stringContaining("not set up"), code: "invalid" });
  });

  test("with the company's domains listed, a domain is one of them for everyone, the owner included", () => {
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    for (const granter of [OWNER, admin("ann@acme.test", "admin"), token]) {
      expect(judgeGrant(registry({}), "blog", "@other.test", "visitor", granter, SSO)).toMatchObject({ refusal: expect.stringContaining("not among the company's domains (acme.test)"), code: "invalid" });
      expect(judgeGrant(registry({}), "blog", "@acme.test", "visitor", granter, SSO)).toMatchObject({ role: "visitor", unlock: false });
    }
  });

  test("with none listed, a whole domain is a wide door: given under the unlock, never with a token", () => {
    const open = { ...SSO, allowedDomains: [] };
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    expect(judgeGrant(registry({}), "blog", "@other.test", "visitor", OWNER, open)).toMatchObject({ role: "visitor", unlock: true });
    expect(judgeGrant(registry({}), "blog", "@other.test", "visitor", admin("ann@acme.test", "admin"), open)).toMatchObject({ role: "visitor", unlock: true });
    expect(judgeGrant(registry({}), "blog", "@acme.test", "visitor", token, open)).toMatchObject({ code: "out-of-scope", refusal: expect.stringContaining("never with a token") });
    // One already there is kept without an unlock.
    expect(judgeGrant(registry({ blog: [["@other.test", "visitor"]] }), "blog", "@other.test", "visitor", admin("ann@acme.test", "admin"), open)).toMatchObject({ unlock: false });
  });

  test("a domain already there is not widened by being kept", () => {
    const current = registry({ blog: [["@other.test", "visitor"]] });
    expect(judgeGrant(current, "blog", "@other.test", "visitor", admin("ann@acme.test", "admin"), SSO)).toMatchObject({ role: "visitor" });
  });
});

describe("lowering is always allowed", () => {
  test("someone whose domain left the company's since is lowered to any lower role, not only Can open", () => {
    const current = registry({ blog: [["dev@gone.test", "admin"]] });
    for (const role of ["developer", "viewer", "visitor"] as const) {
      expect(judgeGrant(current, "blog", "dev@gone.test", role, OWNER, SSO)).toMatchObject({ role, unlock: false, password: false });
      expect(judgeGrant(current, "blog", "dev@gone.test", role, admin("ann@acme.test", "admin"), SSO)).toMatchObject({ role, unlock: false });
    }
    // Raising them again is not lowering: refused, they no longer sign in with their account.
    const lowered = registry({ blog: [["dev@gone.test", "viewer"]] });
    expect(judgeGrant(lowered, "blog", "dev@gone.test", "developer", OWNER, SSO)).toMatchObject({ code: "invalid" });
  });

  test("without company sign-in any more, lowering still goes through", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"]] });
    expect(judgeGrant(current, "blog", "dev@acme.test", "viewer", OWNER, NO_SSO)).toMatchObject({ role: "viewer", password: false });
  });
});

describe("what never reads back is never accepted", () => {
  test("an address longer than an email may be is refused, by its length, before anything else", () => {
    for (const length of [255, 300, 5000]) {
      const long = `${"a".repeat(64)}@${"b".repeat(length - 65 - 5)}.test`;
      expect(judgeGrant(registry({}), "blog", long, "visitor", OWNER, SSO)).toMatchObject({ code: "invalid", refusal: expect.stringContaining("254 characters at most") });
    }
  });

  test("a dotted or misshapen slug is refused, as the registry would refuse to read it", () => {
    const machine = { zone: "test-zone.invalid", exists: () => true };
    for (const slug of ["blog.old", "a.b", "-blog", "blog-", "Blog", "a".repeat(64)]) expect(projectRefusal(slug, machine, true)).toMatchObject({ code: "invalid" });
  });
});

describe("people outside the company's domains: password access", () => {
  test("Can open only, with a password drawn for them", () => {
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "visitor", OWNER, SSO)).toMatchObject({ password: true, role: "visitor" });
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "visitor", admin("ann@acme.test", "admin"), SSO)).toMatchObject({ password: true, role: "visitor" });
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "viewer", OWNER, SSO)).toMatchObject({ refusal: expect.stringContaining("password access"), code: "invalid" });
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "admin", admin("ann@acme.test", "admin"), SSO)).toMatchObject({ code: "invalid" });
  });

  test("giving it asks for the unlock, since it lets someone from outside the company in, though it raises nobody", () => {
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "visitor", OWNER, SSO)).toMatchObject({ password: true, unlock: true });
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "visitor", admin("ann@acme.test", "admin"), SSO)).toMatchObject({ password: true, unlock: true });
    expect(judgeGrant(registry({}), "blog", "alice@acme.test", "visitor", OWNER, NO_SSO)).toMatchObject({ password: true, unlock: true });
  });

  test("without company sign-in, everyone is outside: Can open with a password, nothing higher", () => {
    expect(judgeGrant(registry({}), "blog", "alice@acme.test", "visitor", OWNER, NO_SSO)).toMatchObject({ password: true });
    expect(judgeGrant(registry({}), "blog", "alice@acme.test", "developer", OWNER, NO_SSO)).toMatchObject({ refusal: expect.stringContaining("not set up") });
  });

  test("an admin email signs in with its account whatever its domain", () => {
    expect(judgeGrant(registry({}), "blog", "boss@elsewhere.test", "admin", OWNER, SSO)).toMatchObject({ password: false, role: "admin" });
  });

  test("with no list of the company's domains, anyone the provider vouches for signs in", () => {
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "developer", OWNER, { ...SSO, allowedDomains: [] })).toMatchObject({ password: false, role: "developer" });
  });

  test("a token never gives a password", () => {
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    expect(judgeGrant(registry({}), "blog", "guest@example.org", "visitor", token, SSO)).toMatchObject({ refusal: expect.stringContaining("never with a token"), code: "out-of-scope" });
  });

  test("password access opens the site and nothing more: it is given once, never raised", () => {
    const put = putEntry(EMPTY_REGISTRY, "blog", "guest@example.org", "visitor", "owner", NOW, PASSWORD);
    if ("refusal" in put) throw new Error(put.refusal);
    // Kept as it is, it draws nothing and lets nobody new in: no unlock.
    expect(judgeGrant(put.registry, "blog", "guest@example.org", "visitor", OWNER, SSO)).toMatchObject({ password: false, unlock: false });
    expect(judgeGrant(put.registry, "blog", "guest@example.org", "viewer", OWNER, SSO)).toMatchObject({ code: "out-of-scope" });
    expect(putEntry(put.registry, "blog", "guest@example.org", "viewer", "owner", NOW)).toMatchObject({ code: "out-of-scope" });
  });

  test("the four durations, seven days when none is chosen", () => {
    expect(readDuration(undefined)).toBe(7 * 24 * 3600);
    expect([readDuration(86400), readDuration(604800), readDuration(2592000), readDuration(null)]).toEqual([86400, 604800, 2592000, null]);
    expect(readDuration(3600)).toMatchObject({ code: "invalid" });
    expect(readDuration("7d")).toMatchObject({ code: "invalid" });
  });
});

describe("the projects", () => {
  const machine = { zone: "test-zone.invalid", exists: (slug: string) => ["blog", "dashboard"].includes(slug) };

  test("never the platform's own, never one not deployed unless its entries are kept", () => {
    expect(projectRefusal("blog", machine, false)).toBeNull();
    expect(projectRefusal("dashboard", machine, false)).toMatchObject({ code: "out-of-scope" });
    expect(projectRefusal("portal", machine, false)).toMatchObject({ code: "out-of-scope" });
    // The zone's own folder, the landing's, is no project's slug at all.
    expect(projectRefusal("test-zone.invalid", machine, false)).toMatchObject({ code: "invalid" });
    expect(projectRefusal("gone", machine, false)).toMatchObject({ code: "not-found" });
    expect(projectRefusal("gone", machine, true)).toBeNull();
    expect(projectRefusal("../x", machine, false)).toMatchObject({ code: "invalid" });
  });
});

describe("removing", () => {
  test("anyone who manages the project removes what they could give; a token, Can open entries alone", () => {
    const current = registry({ blog: [["top@acme.test", "admin"], ["see@acme.test", "visitor"], ["@acme.test", "visitor"]] });
    const token: Granter = { kind: "token", id: "t1", email: null, role: null };
    expect(judgeRemoval(current, "blog", "top@acme.test", OWNER)).toMatchObject({ entry: { who: "top@acme.test" } });
    expect(judgeRemoval(current, "blog", "top@acme.test", admin("ann@acme.test", "admin"))).toMatchObject({ entry: { who: "top@acme.test" } });
    expect(judgeRemoval(current, "blog", "top@acme.test", token)).toMatchObject({ code: "out-of-scope" });
    expect(judgeRemoval(current, "blog", "SEE@acme.test", token)).toMatchObject({ entry: { who: "see@acme.test" } });
    expect(judgeRemoval(current, "blog", "@ACME.test", token)).toMatchObject({ entry: { who: "@acme.test" } });
    expect(judgeRemoval(current, "blog", "nobody@acme.test", OWNER)).toMatchObject({ code: "not-found" });
    expect(judgeRemoval(current, "blog", "see@acme.test", admin("dev@acme.test", "developer"))).toMatchObject({ code: "out-of-scope" });
  });

  test("a name carried over from before the registry is removed as it stands", () => {
    const put = putEntry(EMPTY_REGISTRY, "blog", "Client Bob", "visitor", "migration", NOW, PASSWORD);
    if ("refusal" in put) throw new Error(put.refusal);
    expect(judgeRemoval(put.registry, "blog", "Client Bob", OWNER)).toMatchObject({ entry: { who: "Client Bob" } });
  });
});

describe("the registry", () => {
  test("an entry added, its role changed, nothing changed, removed", () => {
    const added = putEntry(EMPTY_REGISTRY, "blog", "alice@acme.test", "viewer", "owner", NOW);
    expect(added).toMatchObject({ change: "add", entry: { who: "alice@acme.test", role: "viewer", by: "owner" } });
    if ("refusal" in added) return;
    const raised = putEntry(added.registry, "blog", "alice@acme.test", "admin", "ann@acme.test", NOW + 1);
    expect(raised).toMatchObject({ change: "role", entry: { role: "admin", by: "owner", updatedAt: NOW + 1 } });
    if ("refusal" in raised) return;
    expect(putEntry(raised.registry, "blog", "alice@acme.test", "admin", "owner", NOW + 2)).toMatchObject({ change: "none" });
    const removed = removeEntry(raised.registry, "blog", "alice@acme.test");
    expect(removed).toMatchObject({ entry: { who: "alice@acme.test" } });
    if ("refusal" in removed) return;
    expect(removed.registry.projects).toEqual({});
    expect(removeEntry(removed.registry, "blog", "alice@acme.test")).toMatchObject({ code: "not-found" });
  });

  test("reads back what it wrote, and refuses what it would not write", () => {
    const current = registry({ blog: [["alice@acme.test", "admin"], ["@acme.test", "visitor"]], shop: [["bob@acme.test", "developer"]] }, ["carol@acme.test"]);
    const put = putEntry(current, "blog", "guest@example.org", "visitor", "owner", NOW, PASSWORD);
    if ("refusal" in put) throw new Error(put.refusal);
    expect(readRegistry(encodeRegistry(put.registry))).toEqual(put.registry);
    expect(readRegistry("{")).toMatchObject({ unreadable: expect.any(String) });
    expect(readRegistry(JSON.stringify({ version: 2, projects: {}, creators: [] }))).toMatchObject({ unreadable: expect.any(String) });
    const entry = { role: "visitor", by: "owner", createdAt: 1, updatedAt: 1 };
    // A domain above Can open, a password access above it, a person twice: none is guessed at.
    expect(readRegistry(JSON.stringify({ version: 1, projects: { blog: [{ ...entry, who: "@acme.test", role: "admin" }] }, creators: [] }))).toMatchObject({ unreadable: expect.any(String) });
    expect(readRegistry(JSON.stringify({ version: 1, projects: { blog: [{ ...entry, who: "g@x.test", role: "viewer", password: PASSWORD }] }, creators: [] }))).toMatchObject({ unreadable: expect.any(String) });
    expect(readRegistry(JSON.stringify({ version: 1, projects: { blog: [{ ...entry, who: "a@x.test" }, { ...entry, who: "a@x.test" }] }, creators: [] }))).toMatchObject({ unreadable: expect.stringContaining("twice") });
    expect(readRegistry(JSON.stringify({ version: 1, projects: { "../x": [] }, creators: [] }))).toMatchObject({ unreadable: expect.any(String) });
  });

  test("who signs in to the dashboard: a role above Can open somewhere, or the create right", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"], ["see@acme.test", "visitor"]] }, ["maker@acme.test"]);
    expect(isDashboardPerson(current, "dev@acme.test")).toBe(true);
    expect(isDashboardPerson(current, "see@acme.test")).toBe(false);
    expect(isDashboardPerson(current, "maker@acme.test")).toBe(true);
    expect(dashboardRolesOf(current, "dev@acme.test")).toEqual({ blog: "developer" });
    expect(dashboardRolesOf(current, "see@acme.test")).toEqual({});
    expect(rightsOf(current, "see@acme.test")).toBeNull();
    expect(rightsOf(current, "maker@acme.test")).toEqual({ email: "maker@acme.test", roles: {}, create: true });
  });

  test("projects and roles read in slug order, whatever the order of the changes", () => {
    const current = registry({ shop: [["dev@acme.test", "admin"]], blog: [["dev@acme.test", "developer"]] });
    expect(Object.keys(current.projects)).toEqual(["blog", "shop"]);
    expect(JSON.stringify(dashboardRolesOf(current, "dev@acme.test"))).toBe(JSON.stringify({ blog: "developer", shop: "admin" }));
  });

  test("a person taken off everywhere, the create right with them", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"]], shop: [["dev@acme.test", "admin"]] }, ["dev@acme.test"]);
    const result = removePerson(current, "dev@acme.test");
    expect(result.removed.map((one) => one.slug)).toEqual(["blog", "shop"]);
    expect(result.create).toBe(true);
    expect(isDashboardPerson(result.registry, "dev@acme.test")).toBe(false);
  });

  test("a project created by a person's token makes them its Admin, password access replaced", () => {
    const current = registry({}, ["maker@acme.test"]);
    expect(recordCreation(current, "maker@acme.test", "fresh", NOW)).toMatchObject({ change: "add", entry: { role: "admin" } });
    expect(recordCreation(current, "stranger@acme.test", "fresh", NOW)).toMatchObject({ code: "out-of-scope" });
  });

  test("the list shows the highest roles first, then domains and password access, never a hash", () => {
    const current = registry({ blog: [["see@acme.test", "visitor"], ["@acme.test", "visitor"], ["top@acme.test", "admin"]] });
    const put = putEntry(current, "blog", "guest@example.org", "visitor", "owner", NOW, { ...PASSWORD, expiresAt: NOW - 1 });
    if ("refusal" in put) throw new Error(put.refusal);
    const views = entryViews(put.registry.projects.blog!, NOW);
    expect(views.map((view) => [view.who, view.kind])).toEqual([
      ["top@acme.test", "person"],
      ["see@acme.test", "person"],
      ["@acme.test", "domain"],
      ["guest@example.org", "password"],
    ]);
    expect(views[3]!.password).toEqual({ expiresAt: NOW - 1, expired: true });
    expect(JSON.stringify(views)).not.toContain(PASSWORD.hash);
    expect(JSON.stringify(views)).not.toContain(PASSWORD.id);
  });

  test("People: everyone across projects, their create right, the admin emails, the domains apart", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"], ["@acme.test", "visitor"]], shop: [["dev@acme.test", "viewer"]] }, ["maker@acme.test"]);
    const { people, domains } = peopleViews(current, ["boss@elsewhere.test"], NOW);
    expect(people).toEqual([
      { who: "boss@elsewhere.test", roles: {}, create: false, passwords: [], admin: true },
      { who: "dev@acme.test", roles: { blog: "developer", shop: "viewer" }, create: false, passwords: [], admin: false },
      { who: "maker@acme.test", roles: {}, create: true, passwords: [], admin: false },
    ]);
    expect(domains).toEqual([{ slug: "blog", domain: "@acme.test" }]);
  });
});

describe("the portal's projection", () => {
  test("each project's people by host, its domains, its password access with hash and expiry, which the portal reads back", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"], ["@acme.test", "visitor"]], dashboard: [] });
    const put = putEntry(current, "blog", "guest@example.org", "visitor", "owner", NOW, PASSWORD);
    if ("refusal" in put) throw new Error(put.refusal);
    const projection = projectionOf(put.registry, (slug) => `${slug}.test-zone.invalid`, NOW);
    expect(projection).toEqual({
      version: 1,
      writtenAt: NOW,
      sites: {
        "blog.test-zone.invalid": {
          slug: "blog",
          people: { "dev@acme.test": "developer", "guest@example.org": "visitor" },
          domains: ["acme.test"],
          passwords: [{ id: PASSWORD.id, who: "guest@example.org", hash: PASSWORD.hash, expiresAt: PASSWORD.expiresAt }],
        },
      },
    });
    expect(readProjection(JSON.stringify(projection))).toEqual(projection);
  });

  test("lowering or removing someone is in the very next projection", () => {
    const before = registry({ blog: [["dev@acme.test", "developer"], ["see@acme.test", "visitor"]] });
    const lowered = putEntry(before, "blog", "dev@acme.test", "visitor", "owner", NOW);
    if ("refusal" in lowered) throw new Error(lowered.refusal);
    const removed = removeEntry(lowered.registry, "blog", "see@acme.test");
    if ("refusal" in removed) throw new Error(removed.refusal);
    const site = projectionOf(removed.registry, (slug) => `${slug}.test-zone.invalid`, NOW).sites["blog.test-zone.invalid"]!;
    expect(site.people).toEqual({ "dev@acme.test": "visitor" });
  });

  test("a project without a host, the platform's, is left out", () => {
    const current = registry({ blog: [["dev@acme.test", "developer"]] });
    expect(projectionOf(current, () => null, NOW).sites).toEqual({});
  });
});
