import { describe, expect, test } from "bun:test";
import { MAX_SESSIONS_PER_MEMBER, MEMBER_SESSION_DURATION_MS } from "../src/members/protocol";
import {
  encodeRegistry,
  judgeEmail,
  mayRestart,
  putMember,
  readRegistry,
  readRoles,
  removeMember,
  roleOf,
  rolesText,
  type Registry,
} from "../src/members/registry";
import { dropMember, encodeBook, EMPTY_BOOK, findSession, openMemberSession, readBook, spendNonce } from "../src/members/sessions";
import { memberReading } from "../src/members/view";
import type { Reading } from "../src/read";

/**
 * The pure rules of the members: who may be invited with which roles, what
 * the registry and the sessions read back as, and what a member sees of the
 * snapshot. The routes that apply them, as root, are in members-steward.test.ts.
 */

const NOW = 1_800_000_000_000;
const MACHINE = { zone: "test-zone.invalid", exists: (slug: string) => ["blog", "shop", "notes", "dashboard"].includes(slug) };
const SETTINGS = { allowedDomains: ["acme.test"], admins: ["boss@elsewhere.test"] };

describe("the roles a member may be given", () => {
  test("viewer, developer or admin, on deployed projects", () => {
    expect(readRoles({ blog: "developer", shop: "viewer" }, MACHINE)).toEqual({ blog: "developer", shop: "viewer" });
  });

  test("never on the platform's own projects, nor the landing, nor a project not deployed", () => {
    expect(readRoles({ dashboard: "viewer" }, MACHINE)).toMatchObject({ refusal: expect.stringContaining("platform") });
    expect(readRoles({ "test-zone.invalid": "viewer" }, MACHINE)).toMatchObject({ refusal: expect.any(String) });
    expect(readRoles({ portal: "admin" }, MACHINE)).toMatchObject({ refusal: expect.stringContaining("platform") });
    expect(readRoles({ gone: "viewer" }, MACHINE)).toMatchObject({ refusal: "roles: gone is not deployed on this machine" });
    expect(readRoles({ blog: "owner" }, MACHINE)).toMatchObject({ refusal: expect.stringContaining("viewer, developer or admin") });
    expect(readRoles({ "../x": "viewer" }, MACHINE)).toMatchObject({ refusal: expect.stringContaining("not a project slug") });
    expect(readRoles(["blog"], MACHINE)).toMatchObject({ refusal: expect.any(String) });
  });

  test("a role on a project since removed is kept when it is not touched", () => {
    expect(readRoles({ gone: "viewer", blog: "admin" }, MACHINE, { gone: "viewer" })).toEqual({ gone: "viewer", blog: "admin" });
    expect(readRoles({ gone: "admin" }, MACHINE, { gone: "viewer" })).toMatchObject({ refusal: expect.any(String) });
  });

  test("a developer and a project admin restart, a viewer does not", () => {
    expect([mayRestart("viewer"), mayRestart("developer"), mayRestart("admin"), mayRestart(null)]).toEqual([false, true, true, false]);
  });
});

describe("the address of an invitation", () => {
  test("cleaned by the portal's rule, and at a domain the portal admits", () => {
    expect(judgeEmail(" Alice@ACME.test ", SETTINGS)).toBe("alice@acme.test");
    expect(judgeEmail("eve@elsewhere.test", SETTINGS)).toMatchObject({ refusal: expect.stringContaining("admits only acme.test") });
    // The portal lets its admin emails in by name: so does an invitation.
    expect(judgeEmail("boss@elsewhere.test", SETTINGS)).toBe("boss@elsewhere.test");
    expect(judgeEmail("not an address", SETTINGS)).toMatchObject({ refusal: expect.any(String) });
  });

  test("any domain when the portal admits any", () => {
    expect(judgeEmail("eve@elsewhere.test", { allowedDomains: [], admins: [] })).toBe("eve@elsewhere.test");
  });
});

describe("the registry", () => {
  test("an invitation, a change, nothing to change, a removal", () => {
    const invited = putMember({ members: [] }, "alice@acme.test", { blog: "developer" }, "owner", NOW);
    if ("refusal" in invited) throw new Error(invited.refusal);
    expect(invited.change).toBe("invite");
    expect(invited.member).toEqual({ email: "alice@acme.test", roles: { blog: "developer" }, invitedBy: "owner", createdAt: NOW, updatedAt: NOW });

    const same = putMember(invited.registry, "alice@acme.test", { blog: "developer" }, "owner", NOW + 1);
    expect("change" in same && same.change).toBe("none");

    const changed = putMember(invited.registry, "alice@acme.test", { blog: "viewer", shop: "admin" }, "owner", NOW + 2);
    if ("refusal" in changed) throw new Error(changed.refusal);
    expect(changed.change).toBe("role");
    expect(changed.member).toMatchObject({ createdAt: NOW, updatedAt: NOW + 2 });
    expect(roleOf(changed.registry, "alice@acme.test", "shop")).toBe("admin");
    expect(roleOf(changed.registry, "alice@acme.test", "notes")).toBeNull();
    expect(roleOf(changed.registry, "bob@acme.test", "shop")).toBeNull();

    const removed = removeMember(changed.registry, "Alice@acme.test");
    expect("registry" in removed && removed.registry.members).toEqual([]);
    expect(removeMember(changed.registry, "bob@acme.test")).toEqual({ refusal: "bob@acme.test is not a member" });
  });

  test("reads back what it wrote, and a file that does not read is no registry", () => {
    const registry: Registry = { members: [{ email: "alice@acme.test", roles: { blog: "viewer" }, invitedBy: "owner", createdAt: 1, updatedAt: 2 }] };
    expect(readRegistry(encodeRegistry(registry))).toEqual(registry);
    expect(readRegistry(null)).toEqual({ members: [] });
    expect(readRegistry("{")).toMatchObject({ unreadable: expect.any(String) });
    const twice = { members: [registry.members[0], registry.members[0]] };
    expect(readRegistry(JSON.stringify(twice))).toMatchObject({ unreadable: "members.json names one email twice" });
    const wrongRole = { members: [{ ...registry.members[0], roles: { blog: "root" } }] };
    expect(readRegistry(JSON.stringify(wrongRole))).toMatchObject({ unreadable: expect.any(String) });
    const upper = { members: [{ ...registry.members[0], email: "Alice@acme.test" }] };
    expect(readRegistry(JSON.stringify(upper))).toMatchObject({ unreadable: expect.any(String) });
  });

  test("roles read in words, for the journal and the command line", () => {
    expect(rolesText({ shop: "viewer", blog: "developer" })).toBe("blog: developer, shop: viewer");
    expect(rolesText({})).toBe("no project");
  });
});

describe("the member sessions", () => {
  test("half a day, found by the token alone, gone with the member", async () => {
    const opened = await openMemberSession(EMPTY_BOOK, "alice@acme.test", NOW);
    expect(opened.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.record.expiresAt).toBe(NOW + MEMBER_SESSION_DURATION_MS);
    // Only the hash is kept.
    expect(encodeBook(opened.book)).not.toContain(opened.token);
    expect(await findSession(opened.book, opened.token, NOW + 1)).toEqual(opened.record);
    expect(await findSession(opened.book, opened.token, NOW + MEMBER_SESSION_DURATION_MS)).toBeNull();
    expect(await findSession(opened.book, "x".repeat(43), NOW)).toBeNull();
    expect(await findSession(dropMember(opened.book, "alice@acme.test"), opened.token, NOW)).toBeNull();
    expect(await findSession(readBook(encodeBook(opened.book)), opened.token, NOW)).toEqual(opened.record);
  });

  test("a member holds ten at most, the oldest giving its place", async () => {
    let book = EMPTY_BOOK;
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_MEMBER; i++) {
      const opened = await openMemberSession(book, "alice@acme.test", NOW + i);
      book = opened.book;
      tokens.push(opened.token);
    }
    expect(book.sessions.length).toBe(MAX_SESSIONS_PER_MEMBER);
    expect(await findSession(book, tokens[0], NOW + 20)).toBeNull();
    expect(await findSession(book, tokens.at(-1), NOW + 20)).not.toBeNull();
  });

  test("an assertion's nonce is spent once, until it would have expired", () => {
    const nonce = "n".repeat(43);
    const spent = spendNonce(EMPTY_BOOK, nonce, NOW + 300_000, NOW);
    if (typeof spent === "string") throw new Error(spent);
    expect(spendNonce(spent, nonce, NOW + 300_000, NOW + 1)).toBe("replayed");
    expect(spendNonce(readBook(encodeBook(spent)), nonce, NOW + 300_000, NOW + 1)).toBe("replayed");
    expect(typeof spendNonce(spent, nonce, NOW + 600_000, NOW + 300_000)).toBe("object");
  });

  test("a file that does not read is an empty book: everyone signs in again", () => {
    expect(readBook("not json")).toEqual(EMPTY_BOOK);
    expect(readBook(JSON.stringify({ sessions: [{ hash: "short" }], nonces: {} }))).toEqual(EMPTY_BOOK);
  });
});

describe("what a member sees of the snapshot", () => {
  const site = (slug: string) => ({ slug }) as never;
  const reading = {
    present: true,
    age: 1,
    stale: false,
    snapshot: {
      generated: NOW,
      zone: "test-zone.invalid",
      sites: [site("blog"), site("shop"), site("secret-project")],
      discrepancies: [
        { slug: "blog", severity: "error", message: "blog is down" },
        { slug: "secret-project", severity: "error", message: "secret-project is down" },
        { slug: null, severity: "warning", message: "disk at 91%" },
      ],
      machine: { memoryTotal: 1, memoryAvailable: 1, diskTotal: 1, diskFree: 1, load1: 1, load5: 1, load15: 1, cores: 1 },
    },
    audience: { present: true, age: 1, stale: false, days: 30, from: "", to: "", sites: { blog: {} as never, "secret-project": {} as never } },
  } as Reading;

  test("their projects alone, and nothing of the machine's own figures", () => {
    const seen = memberReading(reading, { blog: "viewer", shop: "developer" });
    if (!seen.present) throw new Error("absent");
    expect(seen.snapshot.sites.map((one) => one.slug)).toEqual(["blog", "shop"]);
    expect(seen.snapshot.discrepancies.map((one) => one.message)).toEqual(["blog is down"]);
    expect(seen.snapshot.machine).toBeNull();
    expect(Object.keys(seen.audience.sites)).toEqual(["blog"]);
    expect(JSON.stringify(seen)).not.toContain("secret-project");
  });
});
