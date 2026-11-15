import { describe, expect, test } from "bun:test";
import { readProjection } from "../borrowed/access";
import { EMPTY_REGISTRY, encodeRegistry, entryViews, projectionOf, putEntry, readRegistry, readWho, removeEntry, type PasswordRecord, type Registry } from "../src/access/registry";
import { projectRefusal, readDuration } from "../src/access/rules";

/**
 * The access rules, pure: who may be named, what the registry reads back as,
 * and what the portal is handed. The routes that apply them, as root, are in
 * access-steward.test.ts.
 */

const NOW = 1_800_000_000_000;
let drawn = 0;
/** A password access, its identifier new each time. */
const password = (expiresAt: number | null = NOW + 1000): PasswordRecord => ({ id: `guest${String(++drawn).padStart(11, "0")}`, hash: "a".repeat(64), expiresAt });

/** A registry with these guests on these projects. */
function registry(projects: Record<string, string[]>): Registry {
  let next: Registry = EMPTY_REGISTRY;
  for (const [slug, guests] of Object.entries(projects)) {
    for (const who of guests) {
      const put = putEntry(next, slug, who, "owner", NOW, () => password());
      if ("refusal" in put) throw new Error(put.refusal);
      next = put.registry;
    }
  }
  return next;
}

describe("who may be named", () => {
  test("an email, cleaned by the portal's rules", () => {
    expect(readWho(" Alice@ACME.test ")).toBe("alice@acme.test");
  });

  test("a whole domain is named no more; anything else is refused", () => {
    expect(readWho("@acme.test")).toMatchObject({ refusal: expect.stringContaining("one by one"), code: "invalid" });
    expect(readWho("not an address")).toMatchObject({ code: "invalid" });
    expect(readWho(42)).toMatchObject({ code: "invalid" });
  });

  test("an address longer than an email may be is refused by its length", () => {
    for (const length of [255, 300, 5000]) {
      const long = `${"a".repeat(64)}@${"b".repeat(length - 65 - 5)}.test`;
      expect(readWho(long)).toMatchObject({ code: "invalid", refusal: expect.stringContaining("254 characters at most") });
    }
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

  test("a dotted or misshapen slug is refused, as the registry would refuse to read it", () => {
    const always = { zone: "test-zone.invalid", exists: () => true };
    for (const slug of ["blog.old", "a.b", "-blog", "blog-", "Blog", "a".repeat(64)]) expect(projectRefusal(slug, always, true)).toMatchObject({ code: "invalid" });
  });
});

describe("password access", () => {
  test("the four durations, seven days when none is chosen", () => {
    expect(readDuration(undefined)).toBe(7 * 24 * 3600);
    expect([readDuration(86400), readDuration(604800), readDuration(2592000), readDuration(null)]).toEqual([86400, 604800, 2592000, null]);
    expect(readDuration(3600)).toMatchObject({ code: "invalid" });
    expect(readDuration("7d")).toMatchObject({ code: "invalid" });
  });

  test("given once: asked again, the guest keeps their password and nothing is drawn", () => {
    const added = putEntry(EMPTY_REGISTRY, "blog", "guest@example.org", "owner", NOW, () => password());
    if ("refusal" in added) throw new Error(added.refusal);
    expect(added.change).toBe("add");
    let drew = false;
    const again = putEntry(added.registry, "blog", "guest@example.org", "owner", NOW + 1, () => ((drew = true), password()));
    expect(again).toMatchObject({ change: "none", registry: added.registry, entry: added.entry });
    expect(drew).toBe(false);
  });

  test("removed, then not found", () => {
    const current = registry({ blog: ["alice@acme.test"] });
    const removed = removeEntry(current, "blog", "alice@acme.test");
    if ("refusal" in removed) throw new Error(removed.refusal);
    expect(removed.registry.projects).toEqual({});
    expect(removeEntry(removed.registry, "blog", "alice@acme.test")).toMatchObject({ code: "not-found" });
  });

  test("the list is by name, never a hash nor an identifier, an expiry passed said", () => {
    const current = registry({ blog: ["see@acme.test"] });
    const put = putEntry(current, "blog", "guest@example.org", "owner", NOW, () => password(NOW - 1));
    if ("refusal" in put) throw new Error(put.refusal);
    const views = entryViews(put.registry.projects.blog!, NOW);
    expect(views.map((view) => [view.who, view.expired])).toEqual([
      ["guest@example.org", true],
      ["see@acme.test", false],
    ]);
    expect(JSON.stringify(views)).not.toContain("a".repeat(64));
    expect(JSON.stringify(views)).not.toContain("guest0000");
  });
});

describe("the registry's file", () => {
  test("reads back what it wrote, and refuses what it would not write", () => {
    const current = registry({ blog: ["alice@acme.test", "guest@example.org"], shop: ["bob@acme.test"] });
    expect(readRegistry(encodeRegistry(current))).toEqual({ registry: current, leftOut: 0 });
    expect(readRegistry("{")).toMatchObject({ unreadable: expect.any(String) });
    expect(readRegistry(JSON.stringify({ version: 2, projects: {} }))).toMatchObject({ unreadable: expect.any(String) });
    const entry = { who: "g@x.test", by: "owner", createdAt: 1, updatedAt: 1, password: password() };
    // A password access above Can open, a guest twice, a bad slug: none is guessed at.
    expect(readRegistry(JSON.stringify({ version: 1, projects: { blog: [{ ...entry, role: "viewer" }] } }))).toMatchObject({ unreadable: expect.any(String) });
    expect(readRegistry(JSON.stringify({ version: 1, projects: { blog: [entry, entry] } }))).toMatchObject({ unreadable: expect.stringContaining("twice") });
    expect(readRegistry(JSON.stringify({ version: 1, projects: { "../x": [] } }))).toMatchObject({ unreadable: expect.any(String) });
  });

  test("one of company sign-in: its people, domains and creators left out and counted, its guests kept", () => {
    const guest = { who: "Client Bob", role: "visitor", by: "migration", createdAt: 1, updatedAt: 1, password: password() };
    const text = JSON.stringify({
      version: 1,
      projects: { blog: [{ who: "dev@acme.test", role: "developer", by: "owner", createdAt: 1, updatedAt: 1 }, { who: "@acme.test", role: "visitor", by: "owner", createdAt: 1, updatedAt: 1 }, guest] },
      creators: [{ email: "maker@acme.test", by: "owner", at: 1 }],
      migration: null,
    });
    const { role: _, ...kept } = guest;
    expect(readRegistry(text)).toEqual({ registry: { version: 1, projects: { blog: [kept] } }, leftOut: 3 });
    // A name carried over from before the registry is removed as it stands.
    const read = readRegistry(text);
    if ("unreadable" in read) throw new Error(read.unreadable);
    expect(removeEntry(read.registry, "blog", "Client Bob")).toMatchObject({ entry: { who: "Client Bob" } });
  });

  test("projects read in slug order, whatever the order of the changes", () => {
    expect(Object.keys(registry({ shop: ["dev@acme.test"], blog: ["dev@acme.test"] }).projects)).toEqual(["blog", "shop"]);
  });
});

describe("the portal's projection", () => {
  test("each project's password accesses by host, with hash and expiry, which the portal reads back", () => {
    const put = putEntry(EMPTY_REGISTRY, "blog", "guest@example.org", "owner", NOW, () => ({ id: "AAAAAAAAAAAAAAAA", hash: "b".repeat(64), expiresAt: NOW + 5 }));
    if ("refusal" in put) throw new Error(put.refusal);
    const projection = projectionOf(put.registry, (slug) => `${slug}.test-zone.invalid`, NOW);
    expect(projection).toEqual({
      version: 1,
      writtenAt: NOW,
      sites: { "blog.test-zone.invalid": { slug: "blog", passwords: [{ id: "AAAAAAAAAAAAAAAA", who: "guest@example.org", hash: "b".repeat(64), expiresAt: NOW + 5 }] } },
    });
    expect(readProjection(JSON.stringify(projection))).toEqual(projection);
  });

  test("removing someone is in the very next projection", () => {
    const removed = removeEntry(registry({ blog: ["dev@acme.test", "see@acme.test"] }), "blog", "see@acme.test");
    if ("refusal" in removed) throw new Error(removed.refusal);
    const site = projectionOf(removed.registry, (slug) => `${slug}.test-zone.invalid`, NOW).sites["blog.test-zone.invalid"]!;
    expect(site.passwords.map((one) => one.who)).toEqual(["dev@acme.test"]);
  });

  test("a project without a host, the platform's, is left out", () => {
    expect(projectionOf(registry({ blog: ["dev@acme.test"] }), () => null, NOW).sites).toEqual({});
  });
});
