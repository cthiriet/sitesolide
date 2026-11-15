import { beforeEach, describe, expect, test } from "bun:test";
import { DATA_DIR } from "../src/config";
import { TOLERATED_FAILURES, INITIAL_BACKOFF_MS, createClientLimiter, type ClientLimiter } from "../src/auth";
import { createRoutes, type Store, type Options } from "../src/routes";
import { OWNER_IDLE_MS, tokenHash, type Session } from "../src/sessions";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The redirection from tests/setup.ts, checked here rather than assumed:
// without it the tests would open the production service's database.
test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;
const PASSWORD = "a password drawn at random";

/** An in-memory store: the routes need no database to be judged. */
function createStore(): Store & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();

  return {
    sessions,
    async openSession(now) {
      const token = `token-${sessions.size}`;
      sessions.set(await tokenHash(token), {
        hash: await tokenHash(token),
        createdAt: now,
        seenAt: now,
        identity: "owner",
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
  };
}

/** The per-client limiter, its failures counted for the tests. */
function countingLimiter(): ClientLimiter & { failures: Map<string, number> } {
  const inner = createClientLimiter();
  const failures = new Map<string, number>();
  return {
    failures,
    wait: (client, now) => inner.wait(client, now),
    failed(client, now) {
      failures.set(client, (failures.get(client) ?? 0) + 1);
      inner.failed(client, now);
    },
    succeeded(client) {
      failures.delete(client);
      inner.succeeded(client);
    },
  };
}

let hash = "";
let store: ReturnType<typeof createStore>;
let limiter: ReturnType<typeof countingLimiter>;
let routes: ReturnType<typeof createRoutes>;
let clock = NOW;

const STRANGER = "203.0.113.66";
const OWNER = "198.51.100.7";
const failuresOf = (client = OWNER) => limiter.failures.get(client) ?? 0;

function options(remaining: Partial<Options> = {}): Options {
  return {
    hash,
    publicUrl: PUBLIC_URL,
    online: true,
    sessionDurationMs: 7 * 24 * 3600 * 1000,
    stateFile: "/nonexistent/state.json",
    limiter,
    ...remaining,
  };
}

function signIn(body: unknown, origin: string | null = PUBLIC_URL, from = OWNER): Request {
  return new Request(`${PUBLIC_URL}/api/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Caddy appends the address it saw: the last entry is the one counted.
      "X-Forwarded-For": `10.0.0.1, ${from}`,
      ...(origin === null ? {} : { Origin: origin }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  if (hash === "") hash = await Bun.password.hash(PASSWORD, "argon2id");
  clock = NOW;
  store = createStore();
  limiter = countingLimiter();
  routes = createRoutes(store, options(), () => clock);
});


describe("sign-in", () => {
  test("a missing origin is refused before any attempt", async () => {
    const response = await routes.signIn(signIn({ password: PASSWORD }, null));
    expect(response.status).toBe(403);
    // Nothing was counted: otherwise a third-party page would shut the door
    // on the real user with failed attempts made in their name.
    expect(failuresOf()).toBe(0);
  });

  test("another origin is refused", async () => {
    const response = await routes.signIn(signIn({ password: PASSWORD }, "https://pirate.test"));
    expect(response.status).toBe(403);
  });

  test("a missing password is a 400, not a counted failure", async () => {
    const response = await routes.signIn(signIn({}));
    expect(response.status).toBe(400);
    expect(failuresOf()).toBe(0);
  });

  test("a body far larger than any password is refused without being read whole", async () => {
    // The one body read before there is a session, by anyone who sets the
    // Origin header, which a script outside a browser does: read whole, a
    // hundred megabytes of it get the service killed under its 128M.
    const MIB = 1024 * 1024;
    let pulled = 0;
    const padding = new TextEncoder().encode("a".repeat(MIB));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          const head = new TextEncoder().encode('{"password":"');
          pulled += head.byteLength;
          controller.enqueue(head);
        } else if (pulled < 64 * MIB) {
          pulled += padding.byteLength;
          controller.enqueue(padding);
        } else {
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        }
      },
    });
    const flooding = new Request(`${PUBLIC_URL}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: PUBLIC_URL },
      body: stream,
    });
    const response = await routes.signIn(flooding);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(4 * MIB);
    expect(failuresOf()).toBe(0);

    // Announced too long, it is not read at all.
    const announced = new Request(`${PUBLIC_URL}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: PUBLIC_URL, "Content-Length": String(64 * MIB) },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect((await routes.signIn(announced)).status).toBe(413);
  });

  test("a wrong password is refused and counted", async () => {
    const response = await routes.signIn(signIn({ password: "wrong" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "refused" });
    expect(failuresOf()).toBe(1);
  });

  test("the right password sets a session cookie and resets the counter to zero", async () => {
    limiter.failed(OWNER, NOW);
    limiter.failed(OWNER, NOW);
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(failuresOf()).toBe(0);
    expect(store.sessions.size).toBe(1);
  });

  test("past the tolerated failures, even the right password waits", async () => {
    for (let i = 0; i <= TOLERATED_FAILURES; i += 1) limiter.failed(OWNER, NOW);
    const response = await routes.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(INITIAL_BACKOFF_MS / 1000));
    expect(store.sessions.size).toBe(0);
  });

  test("a stranger's wrong passwords make the stranger wait, never the owner", async () => {
    // A single counter for everyone let anyone on the Internet keep the
    // owner out for an hour at a time.
    for (let i = 0; i < 20; i += 1) await routes.signIn(signIn({ password: "wrong" }, PUBLIC_URL, STRANGER));
    expect((await routes.signIn(signIn({ password: PASSWORD }, PUBLIC_URL, STRANGER))).status).toBe(429);
    expect((await routes.signIn(signIn({ password: PASSWORD }))).status).toBe(200);
  });

  test("once the owner holds a passkey, the password signs nobody in, and is not even read", async () => {
    let asked = 0;
    const passkeyOnly = createRoutes(store, options({ passwordSignIn: async () => (asked++, false) }), () => clock);
    const response = await passkeyOnly.signIn(signIn({ password: PASSWORD }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "passkey-only" });
    expect(asked).toBe(1);
    expect(failuresOf()).toBe(0);
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
    expect(failuresOf()).toBe(TOLERATED_FAILURES + 1);
  });

  test("an attempt that throws does not block the queue", async () => {
    let first = true;
    const fragile: ClientLimiter = {
      ...createClientLimiter(),
      wait: () => {
        if (first) {
          first = false;
          throw new Error("database unavailable");
        }
        return 0;
      },
    };
    const withFailure = createRoutes(store, options({ limiter: fragile }), () => clock);
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

  test("the owner's session left unused for its idle time is closed, one in use lives on", async () => {
    routes = createRoutes(store, options({ ownerIdleMs: OWNER_IDLE_MS }), () => clock);
    const cookie = await withSession();
    // Used every few hours: alive past the idle time counted from sign-in.
    for (let hours = 4; hours <= 20; hours += 4) {
      clock = NOW + hours * 3600 * 1000;
      expect((await routes.state(request(cookie))).status).toBe(200);
    }
    clock += OWNER_IDLE_MS;
    expect((await routes.state(request(cookie))).status).toBe(401);
    expect(store.sessions.size).toBe(0);
  });

  test("a declared secret the store lacks joins the snapshot's discrepancies, and a mute steward leaves it as it was", async () => {
    const stateFile = join(DATA_DIR, "routes-state.json");
    const manifest = { slug: "cms", port: 3040, start: "bun run server.ts", secrets: ["DATABASE_KEY"] };
    const unit = { LoadState: "loaded", ActiveState: "active", SubState: "running" };
    writeFileSync(
      stateFile,
      JSON.stringify({
        generated: NOW,
        zone: "test-zone.invalid",
        folders: [{ slug: "cms", manifest: JSON.stringify(manifest), unit, bytes: 1, deployed: NOW }],
        codes: "{}",
        domains: null,
        ports: [3040],
        blocks: {},
        machine: null,
        previous: null,
      }),
    );
    const read = async (missing: Options["missingSecrets"]) => {
      routes = createRoutes(store, options({ stateFile, missingSecrets: missing }), () => clock);
      const body = (await (await routes.state(request(await withSession()))).json()) as { snapshot: { discrepancies: { slug: string; label: string }[] } };
      return body.snapshot.discrepancies.map((discrepancy) => [discrepancy.slug, discrepancy.label]);
    };
    expect(await read(async () => new Map([["cms", { runtime: ["DATABASE_KEY"], files: [] }]]))).toEqual([["cms", "Secret not set"]]);
    expect(await read(async () => null)).toEqual([]);
    expect(await read(undefined)).toEqual([]);
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
