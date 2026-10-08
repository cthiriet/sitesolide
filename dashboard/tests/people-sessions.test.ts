import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { applyRotation, closeSession, openDatabase, openSession, purgeSessions, readSession, recordSession } from "../src/database";
import { createSignInLimiter, ATTEMPTS_PER_WINDOW, GLOBAL_PER_MINUTE } from "../src/people/limiter";
import { createIdentityResolver } from "../src/people/identity";
import { MEMBER_SESSION_DURATION_MS } from "../src/people/protocol";
import { createSessionReader, ownerSessions } from "../src/routes";
import { generateToken, isMemberSession, isSessionAlive, type Session } from "../src/sessions";

/**
 * The dashboard's side of a member's session: the identity its row carries,
 * its half day, what a rotation of the owner's password does to it, the
 * steward asked who it is, and the rate limiting of member sign-ins.
 */

test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const WEEK = 7 * 24 * 60 * 60 * 1000;

describe("the identity a session carries", () => {
  test("a database from before members gains the column, its sessions the owner's", () => {
    const folder = mkdtempSync(join(tmpdir(), "sessions-"));
    try {
      const path = join(folder, "dashboard.db");
      const before = new Database(path, { create: true });
      before.run("CREATE TABLE sessions (empreinte TEXT PRIMARY KEY, cree_a INTEGER NOT NULL, vue_a INTEGER NOT NULL)");
      before.run("INSERT INTO sessions VALUES ('h', 1, 1)");
      before.close();
      const after = openDatabase(path);
      expect(after.query("SELECT identity FROM sessions WHERE empreinte = 'h'").get()).toEqual({ identity: "owner" });
      // Opened twice, as server.ts does, it is not added twice.
      after.close();
      expect(() => openDatabase(path).close()).not.toThrow();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a member's session reads back with its email, the owner's with `owner`", async () => {
    const owner = await openSession(1000);
    const member = generateToken();
    await recordSession(member, "alice@acme.test", 1000);
    expect((await readSession(owner))?.identity).toBe("owner");
    expect((await readSession(member))?.identity).toBe("alice@acme.test");
    expect(isMemberSession((await readSession(member))!)).toBe(true);
    closeSession((await readSession(owner))!.hash);
    closeSession((await readSession(member))!.hash);
  });

  test("a member's session lasts half a day, the owner's a week", () => {
    const session = (identity: string): Session => ({ hash: "h", createdAt: 0, seenAt: 0, identity });
    expect(isSessionAlive(session("owner"), WEEK, MEMBER_SESSION_DURATION_MS, MEMBER_SESSION_DURATION_MS)).toBe(true);
    expect(isSessionAlive(session("alice@acme.test"), WEEK, MEMBER_SESSION_DURATION_MS, MEMBER_SESSION_DURATION_MS)).toBe(false);
    expect(isSessionAlive(session("alice@acme.test"), WEEK, MEMBER_SESSION_DURATION_MS - 1, MEMBER_SESSION_DURATION_MS)).toBe(true);
  });

  test("the purge at sign-in takes each kind at its own age", async () => {
    const owner = await openSession(0);
    const member = generateToken();
    await recordSession(member, "alice@acme.test", 0);
    purgeSessions(-1, 1);
    expect(await readSession(owner)).not.toBeNull();
    expect(await readSession(member)).toBeNull();
    closeSession((await readSession(owner))!.hash);
  });

  test("a new owner's password closes the owner's sessions, never a member's", async () => {
    await applyRotation("$argon2id$members-first");
    const owner = await openSession(1000);
    const member = generateToken();
    await recordSession(member, "alice@acme.test", 1000);
    expect(await applyRotation("$argon2id$members-second")).toBe(1);
    expect(await readSession(owner)).toBeNull();
    expect(await readSession(member)).not.toBeNull();
    closeSession((await readSession(member))!.hash);
  });
});

describe("the owner's routes read the owner's sessions alone", () => {
  test("a member's session reads as none there", async () => {
    const sessions = new Map<string, Session>([
      ["owner-token", { hash: "o", createdAt: 0, seenAt: 0, identity: "owner" }],
      ["member-token", { hash: "m", createdAt: 0, seenAt: 0, identity: "alice@acme.test" }],
    ]);
    const reader = createSessionReader(
      { readSession: async (token) => sessions.get(token) ?? null, touchSession: () => {}, closeSession: () => {} },
      { online: false, sessionDurationMs: WEEK, memberSessionDurationMs: MEMBER_SESSION_DURATION_MS },
    );
    const request = (token: string) => new Request("http://dashboard/api/x", { headers: { Cookie: `session=${token}` } });
    expect((await reader(request("member-token"), 1))?.identity).toBe("alice@acme.test");
    expect(await ownerSessions(reader)(request("member-token"), 1)).toBeNull();
    expect((await ownerSessions(reader)(request("owner-token"), 1))?.identity).toBe("owner");
  });
});

describe("who a member is, asked of the steward", () => {
  const member: Session = { hash: "m", createdAt: 0, seenAt: 0, identity: "alice@acme.test" };
  const request = new Request("http://dashboard/api/x", { headers: { Cookie: "session=member-token" } });

  function resolver(answer: () => Promise<Response>) {
    const closed: string[] = [];
    let asked = 0;
    const resolve = createIdentityResolver({
      session: async () => member,
      online: false,
      steward: {
        whoami: async () => {
          asked++;
          return answer();
        },
      },
      closeSession: (hash) => closed.push(hash),
    });
    return { resolve, closed, asked: () => asked };
  }

  test("the steward's answer, kept a few seconds", async () => {
    const { resolve, asked } = resolver(async () => Response.json({ identity: { kind: "person", email: "alice@acme.test", name: null, roles: { blog: "viewer" } }, expiresAt: 5 }));
    const first = await resolve(request, 1000);
    expect(first !== null && first !== "unreachable" && first.identity).toMatchObject({ kind: "person", roles: { blog: "viewer" } });
    await resolve(request, 2000);
    expect(asked()).toBe(1);
    await resolve(request, 1000 + 6000);
    expect(asked()).toBe(2);
  });

  test("a session the steward closed is closed here too", async () => {
    const { resolve, closed } = resolver(async () => Response.json({ error: "signed-out", message: "gone" }, { status: 401 }));
    expect(await resolve(request, 1)).toBeNull();
    expect(closed).toEqual(["m"]);
  });

  test("a mute steward signs nobody out, and an answer about someone else is no answer", async () => {
    const mute = resolver(async () => {
      throw new Error("no socket");
    });
    expect(await mute.resolve(request, 1)).toBe("unreachable");
    expect(mute.closed).toEqual([]);
    const other = resolver(async () => Response.json({ identity: { kind: "person", email: "boss@acme.test", name: null, roles: { blog: "admin" } }, expiresAt: 5 }));
    expect(await other.resolve(request, 1)).toBe("unreachable");
  });
});

describe("the rate limiting of member sign-ins", () => {
  test("three refusals for one email tolerated, then a wait; the others are not held back", () => {
    const limiter = createSignInLimiter();
    for (let i = 0; i < 4; i++) {
      expect(limiter.identity("eve@acme.test", 1000)).toBe(0);
      limiter.refused("eve@acme.test", 1000);
    }
    expect(limiter.identity("eve@acme.test", 1000)).toBeGreaterThan(0);
    expect(limiter.identity("alice@acme.test", 1000)).toBe(0);
  });

  test("ten sign-ins in ten minutes for one email, refused or not", () => {
    const limiter = createSignInLimiter();
    for (let i = 0; i < ATTEMPTS_PER_WINDOW; i++) expect(limiter.identity("alice@acme.test", i)).toBe(0);
    expect(limiter.identity("alice@acme.test", 100)).toBeGreaterThan(0);
  });

  test("sixty a minute for the whole machine", () => {
    const limiter = createSignInLimiter();
    for (let i = 0; i < GLOBAL_PER_MINUTE; i++) expect(limiter.global(60_000)).toBe(0);
    expect(limiter.global(60_001)).toBe(59_999);
    expect(limiter.global(120_000)).toBe(0);
  });
});
