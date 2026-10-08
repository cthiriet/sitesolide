import { describe, expect, test } from "bun:test";
import { generalNeedsUnlock, machineRefusal, may, mayRestart, needsUnlock, powerRefusal, roleDetail, type Power } from "../src/people/powers";
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
} from "../src/people/unlocks";

/**
 * The pure decisions behind a person's powers: the table of what each role
 * may do, the refusals it says, and a person's unlocks and their counters.
 * The steward applies them (tests/people-actions.test.ts); who may give
 * whom which role is the access rules' (src/access/rules.ts).
 */

const T = 1_800_000_000_000;
const ZONE = "test-zone.invalid";

describe("what each role may do", () => {
  const all: Power[] = [
    "restart",
    "secrets.list",
    "secrets.write",
    "secrets.read",
    "secrets.restore",
    "general",
    "access",
    "backups",
    "deploy",
    "deploy.public",
    "deploy.domain",
    "deploy.outbound",
  ];

  test("Can open and a Viewer nothing, a Developer writes and deploys without reading, an Admin everything of the project", () => {
    expect(all.filter((power) => may("visitor", power))).toEqual([]);
    expect(all.filter((power) => may("viewer", power))).toEqual([]);
    expect(all.filter((power) => may("developer", power))).toEqual(["restart", "secrets.list", "secrets.write", "deploy"]);
    expect(all.filter((power) => may("admin", power))).toEqual(all);
    expect(all.filter((power) => may(null, power))).toEqual([]);
  });

  test("a Developer and an Admin restart, Can open and a Viewer do not", () => {
    expect([mayRestart("visitor"), mayRestart("viewer"), mayRestart("developer"), mayRestart("admin"), mayRestart(null)]).toEqual([false, false, true, true, false]);
  });

  test("whatever reads or writes a secret, or restores, asks for the person's own unlock; general access only to make a site public", () => {
    expect(all.filter(needsUnlock)).toEqual(["secrets.write", "secrets.read", "secrets.restore", "backups"]);
    expect(generalNeedsUnlock(false)).toBe(true);
    expect(generalNeedsUnlock(true)).toBe(false);
    // People with access ask for it only to give a role above Can open, which the access rules judge.
    expect(needsUnlock("access")).toBe(false);
  });

  test("the refusal names the person, their role and what it would take, in the words of the page", () => {
    expect(powerRefusal("a@acme.test", null, "blog", "general")).toBe("a@acme.test holds no role on blog");
    expect(powerRefusal("a@acme.test", "visitor", "blog", "general")).toBe("a@acme.test can open blog and nothing more: changing its general access takes an Admin");
    expect(powerRefusal("a@acme.test", "viewer", "blog", "access")).toBe("a@acme.test is a Viewer on blog: its people with access are its Admin's");
    expect(powerRefusal("a@acme.test", "developer", "blog", "secrets.read")).toBe(
      "a@acme.test is a Developer on blog: reading a value back takes an Admin: a Developer sets, replaces and removes values, and never reads one",
    );
    expect(powerRefusal("a@acme.test", "developer", "blog", "deploy.public")).toBe("a@acme.test is a Developer on blog: deploying it in the open, its general access public, takes an Admin");
  });

  test("the journal says the role and nothing more", () => {
    expect([roleDetail(null), roleDetail("visitor"), roleDetail("admin")]).toEqual(["no role", "role visitor", "role admin"]);
  });

  test("the machine's own projects and files are nobody's but the owner's", () => {
    expect(machineRefusal("dashboard", null, ZONE)).toContain("platform");
    expect(machineRefusal(ZONE, null, ZONE)).toContain("platform");
    expect(machineRefusal("blog", { name: "blog.env", expected: { owner: "site-blog" } }, ZONE)).toBeNull();
    expect(machineRefusal("blog", { name: "dashboard-monitor.env", expected: { owner: "root" } }, ZONE)).toContain("machine");
    expect(machineRefusal("blog", { name: "portal.env", expected: { owner: "site-portal" } }, ZONE)).toContain("machine");
  });
});

describe("a person's unlocks", () => {
  test("one per session, ten minutes fixed, replaced in that session alone", async () => {
    const first = await grant(EMPTY_UNLOCKS, "session-a", "a@acme.test", T);
    expect(first.expiresAt).toBe(T + UNLOCK_DURATION_MS);
    const other = await grant(first.book, "session-b", "b@acme.test", T);
    const again = await grant(other.book, "session-a", "a@acme.test", T + 1000);
    const book = again.book;
    expect(await isUnlocked(book, "session-a", "a@acme.test", first.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "a@acme.test", again.token, T + 2000)).toBe(true);
    expect(await isUnlocked(book, "session-b", "b@acme.test", other.token, T + 2000)).toBe(true);
    // Another session's token, or another person's email, opens nothing.
    expect(await isUnlocked(book, "session-b", "b@acme.test", again.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "b@acme.test", again.token, T + 2000)).toBe(false);
    expect(await isUnlocked(book, "session-a", "a@acme.test", again.token, again.expiresAt)).toBe(false);
    expect(unlockedUntil(book, "session-a", T)).toBe(again.expiresAt);
  });

  test("locked by session, and every one of a person at once", async () => {
    const a = await grant(EMPTY_UNLOCKS, "s1", "a@acme.test", T);
    const b = await grant(a.book, "s2", "a@acme.test", T);
    expect(await isUnlocked(revokeSession(b.book, "s1"), "s2", "a@acme.test", b.token, T)).toBe(true);
    const gone = revokeMember(b.book, "a@acme.test");
    expect(await isUnlocked(gone, "s1", "a@acme.test", a.token, T)).toBe(false);
    expect(await isUnlocked(gone, "s2", "a@acme.test", b.token, T)).toBe(false);
  });

  test("three refusals tolerated per person, then a doubling wait; a success forgets them", async () => {
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
