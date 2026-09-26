import { beforeEach, describe, expect, test } from "bun:test";
import { DATA_DIR } from "../src/config";
import { TOLERATED_FAILURES, INITIAL_BACKOFF_MS } from "../src/auth";
import { createRoutes, type Store, type Options } from "../src/routes";
import { tokenHash, type Session } from "../src/sessions";

// The redirection from tests/setup.ts, checked here rather than assumed:
// without it the tests would open the production service's database.
test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;
const PASSWORD = "a password drawn at random";

/** An in-memory store: the routes need no database to be judged. */
function createStore(): Store & { sessions: Map<string, Session>; attempts: { failures: number; lastAt: number } } {
  const sessions = new Map<string, Session>();
  const state = { attempts: { failures: 0, lastAt: 0 } };

  return {
    sessions,
    get attempts() {
      return state.attempts;
    },
    async openSession(now) {
      const token = `token-${sessions.size}`;
      sessions.set(await tokenHash(token), {
        hash: await tokenHash(token),
        createdAt: now,
        seenAt: now,
      });
      return token;
    },
    async readSession(token) {
      return sessions.get(await tokenHash(token)) ?? null;
    },
    touchSession(hash, now) {
      const session = sessions.get(hash);
      if (session !== undefined) session.seenAt = now;
    },
    closeSession(hash) {
      sessions.delete(hash);
    },
    purgeSessions(before) {
      for (const [key, session] of sessions) if (session.createdAt < before) sessions.delete(key);
    },
    readAttempts() {
      return state.attempts;
    },
    setAttempts(failures, lastAt) {
      state.attempts = { failures, lastAt };
    },
  };
}

let hash = "";
let store: ReturnType<typeof createStore>;
let routes: ReturnType<typeof createRoutes>;
let clock = NOW;

function options(remaining: Partial<Options> = {}): Options {
  return {
    hash,
    publicUrl: PUBLIC_URL,
    online: true,
    sessionDurationMs: 7 * 24 * 3600 * 1000,
    stateFile: "/nonexistent/state.json",
    // Guest access has its own tests in guests.test.ts; here, the portal
    // must never be called.
    portal: {
      list: () => Promise.reject(new Error("portal called")),
      create: () => Promise.reject(new Error("portal called")),
      remove: () => Promise.reject(new Error("portal called")),
    },
    ...remaining,
  };
}

function signIn(body: unknown, origin: string | null = PUBLIC_URL): Request {
  return new Request(`${PUBLIC_URL}/api/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin === null ? {} : { Origin: origin }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  if (hash === "") hash = await Bun.password.hash(PASSWORD, "argon2id");
  clock = NOW;
  store = createStore();
  routes = createRoutes(store, options(), () => clock);
});

describe("sign-in", () => {
  test("a missing origin is refused before any attempt", async () => {
    const response = await routes.signIn(signIn({ password: PASSWORD }, null));
    expect(response.status).toBe(403);
    // Nothing was counted: otherwise a third-party page would shut the door
    // on the real user with failed attempts made in their name.
    expect(store.attempts.failures).toBe(0);
  });

  test("another origin is refused", async () => {
    const response = await routes.signIn(signIn({ password: PASSWORD }, "https://pirate.test"));
    expect(response.status).toBe(403);
  });

  test("a missing password is a 400, not a counted failure", async () => {
    const response = await routes.signIn(signIn({}));
    expect(response.status).toBe(400);
    expect(store.attempts.failures).toBe(0);
  });

  test("a wrong password is refused and counted", async () => {
    const response = await routes.signIn(signIn({ password: "wrong" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "refused" });
    expect(store.attempts.failures).toBe(1);
  });

  test("the right password sets a session cookie and resets the counter to zero", async () => {
    store.setAttempts(2, NOW);
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(store.attempts.failures).toBe(0);
    expect(store.sessions.size).toBe(1);
  });

  test("past the tolerated failures, even the right password waits", async () => {
    store.setAttempts(TOLERATED_FAILURES + 1, NOW);
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(INITIAL_BACKOFF_MS / 1000));
    expect(store.sessions.size).toBe(0);
  });

  test("a burst goes through one attempt at a time: rate limiting stops it at the threshold", async () => {
    // Launched at once, with no queue, the ten attempts would all read a
    // counter at zero, all pass, and run ten argon2id at the same time.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => routes.signIn(signIn({ password: "wrong" }))),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(TOLERATED_FAILURES + 1);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10 - (TOLERATED_FAILURES + 1));
    expect(store.attempts.failures).toBe(TOLERATED_FAILURES + 1);
  });

  test("an attempt that throws does not block the queue", async () => {
    const fragile = createStore();
    let premier = true;
    fragile.readAttempts = () => {
      if (premier) {
        premier = false;
        throw new Error("database unavailable");
      }
      return { failures: 0, lastAt: 0 };
    };
    const withFailure = createRoutes(fragile, options(), () => clock);
    await expect(withFailure.signIn(signIn({ password: PASSWORD }))).rejects.toThrow("database unavailable");
    expect((await withFailure.signIn(signIn({ password: PASSWORD }))).status).toBe(200);
  });

  test("with no hash, nobody gets in", async () => {
    const without = createRoutes(store, options({ hash: "" }), () => clock);
    const response = await without.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(401);
  });
});

describe("state", () => {
  async function withSession(): Promise<string> {
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    const header = response.headers.get("set-cookie") ?? "";
    return header.slice(0, header.indexOf(";"));
  }

  function request(cookie: string | null): Request {
    return new Request(`${PUBLIC_URL}/api/state`, {
      headers: cookie === null ? {} : { Cookie: cookie },
    });
  }

  test("with no session, nothing comes out", async () => {
    expect((await routes.state(request(null))).status).toBe(401);
    expect((await routes.state(request("__Host-session=made-up"))).status).toBe(401);
  });

  test("with a session, the snapshot comes out, never cached", async () => {
    const response = await routes.state(request(await withSession()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The queue does not exist in this test: the route has to say so, not throw.
    expect(await response.json()).toMatchObject({ present: false });
  });

  test("an expired session is closed, not merely refused", async () => {
    const cookie = await withSession();
    clock = NOW + 8 * 24 * 3600 * 1000;
    expect((await routes.state(request(cookie))).status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });
});

describe("sign-out and session", () => {
  test("signing out closes the session and clears the cookie", async () => {
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    const header = response.headers.get("set-cookie") ?? "";
    const cookie = header.slice(0, header.indexOf(";"));

    const output = await routes.signOut(
      new Request(`${PUBLIC_URL}/api/signout`, {
        method: "POST",
        headers: { Origin: PUBLIC_URL, Cookie: cookie },
      }),
    );
    expect(output.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.sessions.size).toBe(0);
  });

  test("a sign-out from an unknown origin is refused", async () => {
    const output = await routes.signOut(
      new Request(`${PUBLIC_URL}/api/signout`, { method: "POST" }),
    );
    expect(output.status).toBe(403);
  });

  test("the session's state can be read with no session", async () => {
    const response = await routes.session(new Request(`${PUBLIC_URL}/api/session`));
    expect(await response.json()).toEqual({ open: false, configured: true });
  });
});
