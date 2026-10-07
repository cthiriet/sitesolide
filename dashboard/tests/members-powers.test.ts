import { describe, expect, test } from "bun:test";
import { machineRefusal, may, mayGrant, needsUnlock, powerRefusal, type Power } from "../src/members/powers";
import { putProjectRole, removeProjectRole, type Registry } from "../src/members/registry";
import { UNLOCK_DURATION_MS } from "../src/secrets/protocol";
import {
  attemptWait,
  countAttempt,
  EMPTY_UNLOCKS,
  failed,
  grant,
  isUnlocked,
  revokeMember,
  revokeSession,
  unlockedUntil,
  UNLOCK_ATTEMPTS_PER_MINUTE,
} from "../src/members/unlocks";

/**
 * The pure decisions behind a member's powers: the table of what each role
 * may do, a member's unlocks and their counters, and a Project admin's changes
 * to the registry. The steward applies them (tests/members-actions.test.ts).
 */

const T = 1_800_000_000_000;
const ZONE = "test-zone.invalid";

describe("what each role may do", () => {
  const all: Power[] = ["restart", "secrets.list", "secrets.write", "secrets.read", "secrets.restore", "door", "sharing", "guests", "backups", "members"];

  test("a Viewer nothing, a Developer writes without reading, a Project admin everything of the project", () => {
    expect(all.filter((power) => may("viewer", power))).toEqual([]);
    expect(all.filter((power) => may("developer", power))).toEqual(["restart", "secrets.list", "secrets.write"]);
    expect(all.filter((power) => may("admin", power))).toEqual(all);
    expect(all.filter((power) => may(null, power))).toEqual([]);
  });

  test("whatever reads or writes a secret, takes a door off, restores or gives a role asks for the member's own unlock", () => {
    expect(all.filter(needsUnlock)).toEqual(["secrets.write", "secrets.read", "secrets.restore", "door", "backups", "members"]);
  });

  test("a Project admin gives a role at most their own; nobody else gives any", () => {
    expect(mayGrant("admin", "admin")).toBe(true);
    expect(mayGrant("admin", "viewer")).toBe(true);
    expect(mayGrant("developer", "viewer")).toBe(false);
    expect(mayGrant("viewer", "viewer")).toBe(false);
    expect(mayGrant(null, "viewer")).toBe(false);
  });

  test("the refusal names the member, their role and what it would take", () => {
    expect(powerRefusal("a@acme.test", null, "blog", "door")).toBe("a@acme.test holds no role on blog");
    expect(powerRefusal("a@acme.test", "developer", "blog", "secrets.read")).toContain("never reads one");
  });

  test("the machine's own projects and files are nobody's but the super admin's", () => {
    expect(machineRefusal("dashboard", null, ZONE)).toContain("platform");
    expect(machineRefusal(ZONE, null, ZONE)).toContain("platform");
    expect(machineRefusal("blog", { name: "blog.env", expected: { owner: "site-blog" } }, ZONE)).toBeNull();
    expect(machineRefusal("blog", { name: "dashboard-monitor.env", expected: { owner: "root" } }, ZONE)).toContain("machine");
    expect(machineRefusal("blog", { name: "portal.env", expected: { owner: "site-portal" } }, ZONE)).toContain("machine");
  });
});

describe("a member's unlocks", () => {
  test("one per session, ten minutes fixed, replaced in that session alone", async () => {
    const first = await grant(EMPTY_UNLOCKS, "session-a", "a@acme.test", T);
    expect(first.expiresAt).toBe(T + UNLOCK_DURATION_MS);
    const other = await grant(first.book, "session-b", "b@acme.test", T);
    const again = await grant(other.book, "session-a", "a@acme.test", T + 1000);
    const book = again.book;
    expect(await isUnlocked(book, "session-a", "a@acme.test", first.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "a@acme.test", again.token, T + 2000)).toBe(true);
    expect(await isUnlocked(book, "session-b", "b@acme.test", other.token, T + 2000)).toBe(true);
    // Another session's token, or another member's email, opens nothing.
    expect(await isUnlocked(book, "session-b", "b@acme.test", again.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "b@acme.test", again.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "a@acme.test", again.token, again.expiresAt)).toBe(false);
    expect(unlockedUntil(book, "session-a", T)).toBe(again.expiresAt);
  });

  test("locked by session, and every one of a member at once", async () => {
    const a = await grant(EMPTY_UNLOCKS, "s1", "a@acme.test", T);
    const b = await grant(a.book, "s2", "a@acme.test", T);
    expect(await isUnlocked(revokeSession(b.book, "s1"), "s2", "a@acme.test", b.token, T)).toBe(true);
    const gone = revokeMember(b.book, "a@acme.test");
    expect(await isUnlocked(gone, "s1", "a@acme.test", a.token, T)).toBe(false);
    expect(await isUnlocked(gone, "s2", "a@acme.test", b.token, T)).toBe(false);
  });

  test("three refusals tolerated per member, then a doubling wait; a success forgets them", async () => {
    let book = EMPTY_UNLOCKS;
    for (let i = 0; i < 3; i++) book = failed(book, "a@acme.test", T);
    expect(attemptWait(book, "a@acme.test", T)).toBe(0);
    book = failed(book, "a@acme.test", T);
    expect(attemptWait(book, "a@acme.test", T)).toBeGreaterThan(0);
    expect(attemptWait(book, "b@acme.test", T)).toBe(0);
    book = (await grant(book, "s", "a@acme.test", T)).book;
    expect(attemptWait(book, "a@acme.test", T)).toBe(0);
  });

  test("a cap for the whole machine, a minute at a time", () => {
    let book = EMPTY_UNLOCKS;
    for (let i = 0; i < UNLOCK_ATTEMPTS_PER_MINUTE; i++) book = countAttempt(book, T);
    expect(attemptWait(book, "anyone@acme.test", T)).toBeGreaterThan(0);
    expect(attemptWait(book, "anyone@acme.test", T + 60_000)).toBe(0);
  });
});

describe("a Project admin's changes to the registry", () => {
  const registry: Registry = {
    members: [{ email: "b@acme.test", roles: { alpha: "developer" }, create: false, invitedBy: "owner", createdAt: T, updatedAt: T }],
  };

  test("someone new is invited with that one role, by the Project admin", () => {
    const put = putProjectRole(registry, "c@acme.test", "beta", "viewer", "a@acme.test", T + 1);
    expect(put).toMatchObject({ change: "invite", member: { email: "c@acme.test", roles: { beta: "viewer" }, invitedBy: "a@acme.test" } });
  });

  test("a member keeps their other projects and who invited them", () => {
    const put = putProjectRole(registry, "b@acme.test", "beta", "admin", "a@acme.test", T + 1);
    expect(put).toMatchObject({ change: "role", member: { roles: { alpha: "developer", beta: "admin" }, invitedBy: "owner" } });
    expect(putProjectRole(registry, "b@acme.test", "alpha", "developer", "a@acme.test", T + 1)).toMatchObject({ change: "none" });
  });

  test("a role taken away; the last one gone, the member goes", () => {
    const two = putProjectRole(registry, "b@acme.test", "beta", "viewer", "a@acme.test", T + 1);
    if ("refusal" in two) throw new Error(two.refusal);
    expect(removeProjectRole(two.registry, "b@acme.test", "beta", T + 2)).toMatchObject({ removed: false, member: { roles: { alpha: "developer" } } });
    const last = removeProjectRole(registry, "b@acme.test", "alpha", T + 2);
    expect(last).toMatchObject({ removed: true });
    expect("registry" in last && last.registry.members).toEqual([]);
    expect(removeProjectRole(registry, "b@acme.test", "beta", T + 2)).toEqual({ refusal: "b@acme.test holds no role on beta" });
  });
});
