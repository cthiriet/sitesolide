import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { createSessionReader, createRoutes, type Store } from "../src/routes";
import { DEFAULT_TIMEOUTS, RELAY_MARGIN_MS, localSteward, type Steward } from "../src/secrets/client";
import { createTokens, type Tokens } from "../src/secrets/tokens";
import { UNLOCK_DURATION_MS, MAX_PORTAL_MS, MAX_RESTART_MS, type FileView, type ProjectView } from "../src/secrets/protocol";
import { MAX_BODY_BYTES, MAX_LOG_SLUG, createSecretsRoutes, type SecretsRoutes } from "../src/secrets/routes";
import { tokenHash, generateToken, type Session } from "../src/sessions";

// No database is opened here, but the redirection is checked rather than
// assumed: see tests/setup.ts.
test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;
const SESSION_DURATION_MS = 7 * 24 * 3600 * 1000;
const PASSWORD = "Xith-G4r4-nRJs-uDMV-KhsD-mzuK";
const EXPIRE_A = NOW + UNLOCK_DURATION_MS;

const FILE: FileView = {
  name: "dashboard-monitor.env",
  state: "managed",
  reason: null,
  expected: "root:root 0600",
  variables: ["HEARTBEAT_URL"],
  passwords: [],
  modifiedAt: NOW,
  previous: true,
  restartPending: true,
};

const PORTAL = { requested: true, installed: true, modifiable: true, reason: null };

/** The dashboard: a platform file, no store. Not a literal of the type, which gains `store` with the steward's view of it. */
const DASHBOARD_PROJECT = {
  slug: "dashboard",
  service: { unit: "dashboard.service", state: "active", subState: "running", startedAt: NOW - 60_000 },
  files: [FILE],
  portal: PORTAL,
  store: null,
};

const PROJECTS: ProjectView[] = [DASHBOARD_PROJECT];

/** The dashboard's password retyped, and a brand new one: neither comes back out. */
const NEW_PASSWORD = "a-brand-new-password-for-the-portal";
const DRAWN_PASSWORD = "Ab3d-Ef4g-Hj5k-Mn6p-Qr7s-Tu8v";

const VERDICT = { kind: "active", state: "active", subState: "running", restarts: 0 };

/** A store as the steward lists it to the owner: names and states, never a value. */
const STORE = {
  slug: "cms",
  exists: true,
  state: "managed",
  reason: null,
  variables: [{ name: "API_KEY", source: "store", declared: true }],
  missing: [],
  files: [{ name: "gcp.json", state: "set", declared: true, reason: null, bytes: 120, modifiedAt: NOW, restartPending: false }],
  build: [],
  public: [],
  unitReadsStore: true,
  modifiedAt: NOW,
  restartPending: true,
  previous: true,
  may: { write: true, reveal: true, restore: true },
};
const STORE_CHANGE = { store: STORE, created: false, set: ["API_KEY"], generated: [], removed: [], absent: [], files: { set: [], removed: [] } };
/** The one answer of the store that carries a value: a reveal, the owner's. */
const REVEALED = "revealed-store-value-4d1e";

type Method = keyof Steward;
type Responder = (requested: unknown) => Response | Promise<Response>;

let clock = NOW;

/**
 * A steward that records every call and by default returns what the real one
 * would. `issued` keeps every token issued, which `read` looks for in every
 * answer.
 */
function fakeSteward() {
  const calls: { method: Method; requested: unknown }[] = [];
  const issued: string[] = [];
  const responses: Partial<Record<Method, Responder>> = {};

  const defaults: Record<Method, Responder> = {
    readProjects: () => Response.json({ projects: PROJECTS }),
    readLog: () =>
      Response.json({
        entries: [{ a: NOW, operation: "set", result: "ok", slug: "cms", file: "store", variable: "API_KEY", detail: null }],
      }),
    unlock: () => {
      const token = generateToken();
      issued.push(token);
      return Response.json({ token, expiresAt: clock + UNLOCK_DURATION_MS });
    },
    lock: () => new Response(null, { status: 204 }),
    readValue: () => Response.json({ value: "fake_live_value" }),
    setVariable: () => Response.json({ file: FILE }),
    removeVariable: () => Response.json({ file: FILE }),
    createFile: () => Response.json({ file: FILE }),
    restoreFile: () => Response.json({ file: FILE }),
    changePassword: () => Response.json({ file: FILE, password: DRAWN_PASSWORD }),
    togglePortal: () => Response.json({ portal: PORTAL, detail: "portal installed" }),
    restart: () => Response.json({ verdict: VERDICT }),
    readStore: () => Response.json({ store: STORE }),
    setStoreVariable: () => Response.json(STORE_CHANGE),
    removeStoreVariables: () => Response.json(STORE_CHANGE),
    generateStoreVariable: () => Response.json(STORE_CHANGE),
    setStoreFile: () => Response.json(STORE_CHANGE),
    removeStoreFile: () => Response.json(STORE_CHANGE),
    restoreStore: () => Response.json({ ...STORE_CHANGE, appeared: [], disappeared: [], restored: true }),
    revealStoreValue: () => Response.json({ value: REVEALED }),
  };

  async function call(method: Method, requested: unknown): Promise<Response> {
    calls.push({ method, requested });
    return (responses[method] ?? defaults[method])(requested);
  }

  const steward: Steward = {
    readProjects: () => call("readProjects", null),
    readLog: (slug) => call("readLog", slug),
    unlock: (requested) => call("unlock", requested),
    lock: (requested) => call("lock", requested),
    readValue: (requested) => call("readValue", requested),
    setVariable: (requested) => call("setVariable", requested),
    removeVariable: (requested) => call("removeVariable", requested),
    createFile: (requested) => call("createFile", requested),
    restoreFile: (requested) => call("restoreFile", requested),
    changePassword: (requested) => call("changePassword", requested),
    togglePortal: (requested) => call("togglePortal", requested),
    restart: (requested) => call("restart", requested),
    readStore: (slug) => call("readStore", slug),
    setStoreVariable: (requested) => call("setStoreVariable", requested),
    removeStoreVariables: (requested) => call("removeStoreVariables", requested),
    generateStoreVariable: (requested) => call("generateStoreVariable", requested),
    setStoreFile: (requested) => call("setStoreFile", requested),
    removeStoreFile: (requested) => call("removeStoreFile", requested),
    restoreStore: (requested) => call("restoreStore", requested),
    revealStoreValue: (requested) => call("revealStoreValue", requested),
  };

  return { steward, calls, issued, responses };
}

function createStore(): Store & { sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();
  return {
    sessions,
    async openSession(now) {
      const token = generateToken();
      const hash = await tokenHash(token);
      sessions.set(hash, { hash, createdAt: now, seenAt: now, identity: "owner" });
      return token;
    },
    async readSession(token) {
      return sessions.get(await tokenHash(token)) ?? null;
    },
    touchSession() {},
    closeSession(hash) {
      sessions.delete(hash);
    },
    purgeSessions() {},
    readAttempts: () => ({ failures: 0, lastAt: 0 }),
    setAttempts() {},
  };
}

let store: ReturnType<typeof createStore>;
let fake: ReturnType<typeof fakeSteward>;
let tokens: Tokens;
let secrets: SecretsRoutes;
let routes: ReturnType<typeof createRoutes>;

/** Wired like server.ts: same session reading, sign-out that forgets. */
function mount(steward?: Steward) {
  store = createStore();
  fake = fakeSteward();
  tokens = createTokens(() => clock);
  secrets = createSecretsRoutes(
    {
      session: createSessionReader(store, { online: true, sessionDurationMs: SESSION_DURATION_MS }),
      publicUrl: PUBLIC_URL,
      steward: steward ?? fake.steward,
      tokens,
    },
    () => clock,
  );
  routes = createRoutes(
    store,
    {
      hash: "",
      publicUrl: PUBLIC_URL,
      online: true,
      sessionDurationMs: SESSION_DURATION_MS,
      stateFile: "/nonexistent/state.json",
      forgetUnlock: secrets.forgetUnlock,
    },
    () => clock,
  );
}

beforeEach(() => {
  clock = NOW;
  mount();
});

type Opened = { cookie: string; hash: string };

async function openSession(): Promise<Opened> {
  const token = await store.openSession(clock);
  return { cookie: `__Host-session=${token}`, hash: await tokenHash(token) };
}

type Send = {
  method?: string;
  body?: unknown;
  raw?: string;
  cookie?: string | null;
  origin?: string | null;
};

function requested(path: string, send: Send = {}): Request {
  const headers: Record<string, string> = {};
  const origin = send.origin === undefined ? PUBLIC_URL : send.origin;
  if (origin !== null) headers.Origin = origin;
  if (send.cookie) headers.Cookie = send.cookie;
  const body = send.raw ?? (send.body === undefined ? undefined : JSON.stringify(send.body));
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`${PUBLIC_URL}/api/secrets${path}`, {
    method: send.method ?? "POST",
    headers: headers,
    body: body,
  });
}

type Lu = { status: number; body: any; headers: Headers };

/**
 * Every answer goes through here, and two invariants are checked on the raw
 * text: no token issued comes out of it, and nothing is kept in cache.
 */
async function read(response: Response | Promise<Response>): Promise<Lu> {
  const received = await response;
  const text = await received.text();
  for (const token of fake.issued) expect(text).not.toContain(token);
  expect(received.headers.get("cache-control")).toBe("no-store");
  return { status: received.status, body: text === "" ? null : JSON.parse(text), headers: received.headers };
}

async function unlock(open: Opened): Promise<string> {
  const parsed = await read(secrets.unlock(requested("/unlock", { cookie: open.cookie, body: { password: PASSWORD } })));
  expect(parsed.status).toBe(200);
  return fake.issued.at(-1)!;
}

type TokenRouteName =
  | "readValue"
  | "setVariable"
  | "removeVariable"
  | "createFile"
  | "restoreFile"
  | "changePassword"
  | "togglePortal"
  | "restart"
  | "setStoreVariable"
  | "removeStoreVariables"
  | "generateStoreVariable"
  | "setStoreFile"
  | "removeStoreFile"
  | "restoreStore"
  | "revealStoreValue";

type TokenRoute = { route: TokenRouteName; http: string; path: string; body: Record<string, unknown>; texts?: string[] };

/** `texts`: the fields that have to be strings, and whose absence reads "Missing or non-text field". */
const TOKEN_ROUTES: Required<TokenRoute>[] = ([] as TokenRoute[]).concat([
  { route: "readValue", http: "POST", path: "/value", body: { slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" } },
  { route: "setVariable", http: "PUT", path: "/variable", body: { slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL", value: "https://hc.example.test/new" } },
  { route: "removeVariable", http: "DELETE", path: "/variable", body: { slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" } },
  { route: "createFile", http: "POST", path: "/file", body: { slug: "dashboard", file: "dashboard-monitor.env" } },
  { route: "restoreFile", http: "POST", path: "/restore", body: { slug: "dashboard", file: "dashboard-monitor.env" } },
  {
    route: "changePassword",
    http: "POST",
    path: "/password",
    body: { slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null },
    texts: ["slug", "file", "variable"],
  },
  { route: "togglePortal", http: "POST", path: "/portal", body: { slug: "cms", active: false, confirmation: "cms" }, texts: ["slug", "confirmation"] },
  { route: "restart", http: "POST", path: "/restart", body: { slug: "cms" } },
  { route: "setStoreVariable", http: "PUT", path: "/store/variable", body: { slug: "cms", name: "API_KEY", value: "a-store-value-set-77c1" } },
  { route: "removeStoreVariables", http: "DELETE", path: "/store/variable", body: { slug: "cms", names: ["API_KEY", "OLD"] }, texts: ["slug"] },
  { route: "generateStoreVariable", http: "POST", path: "/store/generate", body: { slug: "cms", name: "SESSION_KEY", format: "base64url", bytes: 48, replace: true }, texts: ["slug", "name"] },
  { route: "setStoreFile", http: "PUT", path: "/store/file", body: { slug: "cms", name: "gcp.json", content: "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50In0=" } },
  { route: "removeStoreFile", http: "DELETE", path: "/store/file", body: { slug: "cms", name: "gcp.json" } },
  { route: "restoreStore", http: "POST", path: "/store/restore", body: { slug: "cms", dryRun: true }, texts: ["slug"] },
  { route: "revealStoreValue", http: "POST", path: "/store/value", body: { slug: "cms", name: "API_KEY" } },
]).map((route) => ({ ...route, texts: route.texts ?? Object.keys(route.body) }));

const EXPECTED_RESPONSES: Record<TokenRouteName, unknown> = {
  readValue: { value: "fake_live_value" },
  setVariable: { file: FILE },
  removeVariable: { file: FILE },
  createFile: { file: FILE },
  restoreFile: { file: FILE },
  changePassword: { file: FILE, password: DRAWN_PASSWORD },
  togglePortal: { portal: PORTAL, detail: "portal installed" },
  restart: { verdict: VERDICT },
  setStoreVariable: STORE_CHANGE,
  removeStoreVariables: STORE_CHANGE,
  generateStoreVariable: STORE_CHANGE,
  setStoreFile: STORE_CHANGE,
  removeStoreFile: STORE_CHANGE,
  restoreStore: { ...STORE_CHANGE, appeared: [], disappeared: [], restored: true },
  revealStoreValue: { value: REVEALED },
};

/** Every route that is not a GET, with a valid body. */
function writes(): { name: string; call: (send: Send) => Promise<Response> }[] {
  return [
    { name: "unlock", call: (send) => secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, ...send })) },
    { name: "lock", call: (send) => secrets.lock(requested("/lock", send)) },
    ...TOKEN_ROUTES.map(({ route, http, path, body }) => ({
      name: route,
      call: (send: Send) => secrets[route](requested(path, { method: http, body, ...send })),
    })),
  ];
}

describe("the origin before everything else", () => {
  test("refused with no session, and even with an unlocked session, sending nothing to the steward", async () => {
    const open = await openSession();
    await unlock(open);
    fake.calls.length = 0;

    for (const { name, call } of writes()) {
      for (const origin of [null, "https://pirate.test", "https://cms.test-zone.invalid", `${PUBLIC_URL}/`]) {
        for (const cookie of [null, open.cookie]) {
          const parsed = await read(call({ origin, cookie }));
          expect({ name, origin, cookie, status: parsed.status, body: parsed.body }).toEqual({
            name,
            origin,
            cookie,
            status: 403,
            body: { error: "origin-refused" },
          });
        }
      }
    }
    expect(fake.calls).toEqual([]);
    // Refusing forgot nothing: the session stays unlocked.
    expect(tokens.read(open.hash)).not.toBeNull();
  });
});

describe("the session next", () => {
  test("missing, made up or expired: 401 everywhere, and nothing goes off", async () => {
    const open = await openSession();
    clock = NOW + SESSION_DURATION_MS;

    const readings = [
      (send: Send) => secrets.dashboard(requested("", { method: "GET", ...send })),
      (send: Send) => secrets.log(requested("/log", { method: "GET", ...send })),
    ];
    for (const cookie of [null, "__Host-session=made-up", "session=other", open.cookie]) {
      for (const call of [...readings, ...writes().map((e) => e.call)]) {
        const parsed = await read(call({ cookie }));
        expect(parsed.status).toBe(401);
        expect(parsed.body).toEqual({ error: "no-session" });
      }
    }
    expect(fake.calls).toEqual([]);
  });

  test("a read does not require an origin", async () => {
    const open = await openSession();
    expect((await read(secrets.dashboard(requested("", { method: "GET", origin: null, cookie: open.cookie })))).status).toBe(200);
    expect((await read(secrets.log(requested("/log", { method: "GET", origin: null, cookie: open.cookie })))).status).toBe(200);
  });
});

describe("the body, of which only the shape is judged", () => {
  test("unreadable, not an object or too big: 400, even unlocked, and nothing goes off", async () => {
    const open = await openSession();
    await unlock(open);
    fake.calls.length = 0;

    const raws = ["not json", "", "[]", "null", "42", '"string"', "{", `{"slug":"${"x".repeat(MAX_BODY_BYTES)}"}`];
    for (const { route, http, path } of TOKEN_ROUTES) {
      for (const raw of raws) {
        const parsed = await read(secrets[route](requested(path, { method: http, raw, cookie: open.cookie })));
        expect({ route, raw: raw.slice(0, 20), status: parsed.status }).toEqual({ route, raw: raw.slice(0, 20), status: 400 });
        expect(parsed.body.error).toBe("invalid");
      }
      // No body at all.
      const without = await read(secrets[route](requested(path, { method: http, cookie: open.cookie })));
      expect(without.status).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });

  test("an expected field missing or not a string: a 400 that names it", async () => {
    const open = await openSession();
    await unlock(open);
    fake.calls.length = 0;

    for (const { route, http, path, body, texts } of TOKEN_ROUTES) {
      for (const field of texts) {
        for (const wrong of [undefined, 42, null, true, {}, ["cms"]]) {
          const parsed = await read(secrets[route](requested(path, { method: http, body: { ...body, [field]: wrong }, cookie: open.cookie })));
          expect({ route, field, wrong, status: parsed.status }).toEqual({ route, field, wrong, status: 400 });
          expect(parsed.body).toEqual({ error: "invalid", message: `Missing or non-text field: ${field}.` });
        }
      }
    }
    expect(fake.calls).toEqual([]);
  });

  test("the cap is exact: at the limit the request goes off, one byte beyond it is refused", async () => {
    const open = await openSession();
    await unlock(open);
    fake.calls.length = 0;

    const base = { slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL", value: "" };
    // Two-byte characters: the limit really does count in bytes.
    const remaining = MAX_BODY_BYTES - new TextEncoder().encode(JSON.stringify(base)).byteLength;
    const value = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    const exact = JSON.stringify({ ...base, value });
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_BODY_BYTES);

    const passe = await read(secrets.setVariable(requested("/variable", { method: "PUT", raw: exact, cookie: open.cookie })));
    expect(passe.status).toBe(200);
    expect(fake.calls).toHaveLength(1);

    const excess = await read(secrets.setVariable(requested("/variable", { method: "PUT", raw: `${exact} `, cookie: open.cookie })));
    expect(excess.status).toBe(400);
    expect(fake.calls).toHaveLength(1);

    // Announced too big, refused before any read, whatever the body holds.
    const announced = requested("/value", { body: TOKEN_ROUTES[0]!.body, cookie: open.cookie });
    announced.headers.set("Content-Length", String(MAX_BODY_BYTES + 1));
    expect((await read(secrets.readValue(announced))).status).toBe(400);
    expect(fake.calls).toHaveLength(1);
  });

  test("values the dashboard does not judge go off as they are", async () => {
    const open = await openSession();
    const token = await unlock(open);
    fake.calls.length = 0;

    const body = { slug: "", file: "../../etc/passwd", variable: "PATH", value: " $x \\ ' \" # ; = é " };
    const parsed = await read(secrets.setVariable(requested("/variable", { method: "PUT", body, cookie: open.cookie })));
    expect(parsed.status).toBe(200);
    expect(fake.calls).toEqual([{ method: "setVariable", requested: { ...body, token } }]);
  });

  test("unlocking: password missing, empty, too long or not a string, 400 with no call", async () => {
    const open = await openSession();
    for (const body of [{}, { password: "" }, { password: "x".repeat(257) }, { password: 42 }, { password: null }]) {
      const parsed = await read(secrets.unlock(requested("/unlock", { body, cookie: open.cookie })));
      expect(parsed.status).toBe(400);
      expect(parsed.body.error).toBe("invalid");
    }
    expect((await read(secrets.unlock(requested("/unlock", { raw: "password", cookie: open.cookie })))).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

describe("with no live token", () => {
  test("423 on every route that requires it, without disturbing the steward", async () => {
    const open = await openSession();
    for (const { route, http, path, body } of TOKEN_ROUTES) {
      const parsed = await read(secrets[route](requested(path, { method: http, body, cookie: open.cookie })));
      expect(parsed.status).toBe(423);
      expect(parsed.body).toEqual({ error: "locked", message: "Unlock secrets first." });
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("unlocked", () => {
  test("unlocking yields the deadline, keeps the token, and passes on only the password", async () => {
    const open = await openSession();
    const parsed = await read(
      secrets.unlock(requested("/unlock", { body: { password: PASSWORD, token: "x", intruder: 1 }, cookie: open.cookie })),
    );
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({ until: EXPIRE_A });
    expect(fake.calls).toEqual([{ method: "unlock", requested: { password: PASSWORD } }]);
    expect(tokens.read(open.hash)).toEqual({ token: fake.issued[0]!, expiresAt: EXPIRE_A });
  });

  test("every route adds the session's token and relays only the expected fields", async () => {
    const open = await openSession();
    const token = await unlock(open);

    for (const { route, http, path, body } of TOKEN_ROUTES) {
      fake.calls.length = 0;
      // A token supplied by the page does not replace the dashboard's own.
      const sent = { ...body, token: "token-from-the-page", intruder: "ignore" };
      const parsed = await read(secrets[route](requested(path, { method: http, body: sent, cookie: open.cookie })));
      expect(parsed.status).toBe(200);
      expect(parsed.body).toEqual(EXPECTED_RESPONSES[route]);
      expect(fake.calls).toEqual([{ method: route, requested: { ...body, token } }]);
    }
  });

  test("a locked 401 from the steward becomes a 423, and the token is forgotten", async () => {
    const open = await openSession();
    await unlock(open);
    fake.responses.readValue = () => Response.json({ error: "locked", message: "Token expired." }, { status: 401 });

    const route = TOKEN_ROUTES[0]!;
    const parsed = await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })));
    expect(parsed.status).toBe(423);
    expect(parsed.body).toEqual({ error: "locked", message: "Unlock secrets first." });
    expect(tokens.read(open.hash)).toBeNull();

    // What follows no longer disturbs the steward, and the page knows it is locked.
    fake.calls.length = 0;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(423);
    expect(fake.calls).toEqual([]);
    expect((await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })))).body.until).toBeNull();
  });

  test("a fresh unlock during the call is not forgotten along with the old one", async () => {
    const open = await openSession();
    await unlock(open);
    fake.responses.readValue = () => {
      tokens.set(open.hash, { token: "new-token-from-another-tab", expiresAt: EXPIRE_A });
      return Response.json({ error: "locked", message: "Token revoked." }, { status: 401 });
    };

    const route = TOKEN_ROUTES[0]!;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(423);
    expect(tokens.read(open.hash)?.token).toBe("new-token-from-another-tab");
  });

  test("the deadline is exact: one millisecond before, the request goes off; at the instant, 423", async () => {
    const open = await openSession();
    await unlock(open);
    const route = TOKEN_ROUTES[0]!;
    fake.calls.length = 0;

    clock = EXPIRE_A - 1;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(200);
    expect((await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })))).body.until).toBe(EXPIRE_A);
    expect(fake.calls.map((a) => a.method)).toEqual(["readValue", "readProjects"]);

    clock = EXPIRE_A;
    fake.calls.length = 0;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(423);
    expect((await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })))).body.until).toBeNull();
    expect(fake.calls.map((a) => a.method)).toEqual(["readProjects"]);
  });

  test("two sessions never have the same token", async () => {
    const a = await openSession();
    const b = await openSession();
    const tokenA = await unlock(a);
    const route = TOKEN_ROUTES[0]!;

    fake.calls.length = 0;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: b.cookie })))).status).toBe(423);
    expect(fake.calls).toEqual([]);

    clock = NOW + 60_000;
    const tokenB = await unlock(b);
    expect(tokenB).not.toBe(tokenA);

    fake.calls.length = 0;
    await read(secrets.readValue(requested(route.path, { body: route.body, cookie: a.cookie })));
    await read(secrets.readValue(requested(route.path, { body: route.body, cookie: b.cookie })));
    expect(fake.calls.map((call) => (call.requested as { token: string }).token)).toEqual([tokenA, tokenB]);

    expect((await read(secrets.dashboard(requested("", { method: "GET", cookie: a.cookie })))).body.until).toBe(EXPIRE_A);
    expect((await read(secrets.dashboard(requested("", { method: "GET", cookie: b.cookie })))).body.until).toBe(EXPIRE_A + 60_000);
  });
});

describe("the steward's refusals go back out as they are", () => {
  test("with their status and their message", async () => {
    const open = await openSession();
    await unlock(open);

    const refusal = [
      { status: 400, body: { error: "invalid", message: "Variable names use letters, digits and underscores." } },
      { status: 403, body: { error: "out-of-scope", message: "This file is not managed here." } },
      { status: 404, body: { error: "not-found", message: "No such variable." } },
      { status: 409, body: { error: "unmanaged", message: "Fix this file by hand first." } },
      { status: 409, body: { error: "already-present", message: "The file already exists." } },
      { status: 500, body: { error: "failure", message: "Could not write the file." } },
    ];
    for (const { route, http, path, body } of TOKEN_ROUTES) {
      for (const expected of refusal) {
        fake.responses[route] = () => Response.json(expected.body, { status: expected.status });
        const parsed = await read(secrets[route](requested(path, { method: http, body, cookie: open.cookie })));
        expect({ route, status: parsed.status, body: parsed.body }).toEqual({ route, ...expected });
      }
    }
    // None of these refusals locks.
    expect(tokens.read(open.hash)).not.toBeNull();
  });

  test("wrong password: the refusing 401 is relayed, nothing is kept", async () => {
    const open = await openSession();
    fake.responses.unlock = () => Response.json({ error: "refused", message: "Wrong password." }, { status: 401 });

    const parsed = await read(secrets.unlock(requested("/unlock", { body: { password: "wrong" }, cookie: open.cookie })));
    expect(parsed.status).toBe(401);
    expect(parsed.body).toEqual({ error: "refused", message: "Wrong password." });
    expect(tokens.read(open.hash)).toBeNull();
  });

  test("too many attempts: the 429 is relayed, with Retry-After", async () => {
    const open = await openSession();
    const body = { error: "too-many-attempts", message: "Too many attempts.", wait: 12.2 };
    fake.responses.unlock = () => Response.json(body, { status: 429 });

    const parsed = await read(secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie })));
    expect(parsed.status).toBe(429);
    expect(parsed.body).toEqual(body);
    expect(parsed.headers.get("retry-after")).toBe("13");

    // With no `wait`, the steward's header is taken over.
    fake.responses.unlock = () =>
      Response.json({ error: "too-many-attempts", message: "Too many attempts." }, { status: 429, headers: { "Retry-After": "40" } });
    const without = await read(secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie })));
    expect(without.headers.get("retry-after")).toBe("40");
  });
});

describe("steward unreachable or unreadable: 502", () => {
  const UNREACHABLE = { error: "failure", message: "Can't reach the server's secrets." };
  const UNREADABLE = { error: "failure", message: "The server sent an unreadable answer." };

  const failures: [string, () => never][] = [
    ["rejection", () => { throw new TypeError("fetch failed"); }],
    ["timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }],
  ];

  for (const [name, failure] of failures) {
    test(`${name}: every route says so instead of throwing, and the token stays`, async () => {
      const open = await openSession();
      await unlock(open);
      for (const method of Object.keys(fake.steward) as Method[]) fake.responses[method] = failure;

      const fieldsRead = [
        await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie }))),
        await read(secrets.log(requested("/log", { method: "GET", cookie: open.cookie }))),
        await read(secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie }))),
      ];
      for (const { route, http, path, body } of TOKEN_ROUTES) {
        fieldsRead.push(await read(secrets[route](requested(path, { method: http, body, cookie: open.cookie }))));
      }
      for (const parsed of fieldsRead) {
        expect(parsed.status).toBe(502);
        expect(parsed.body).toEqual(UNREACHABLE);
      }
      // A passing failure does not lock.
      expect(tokens.read(open.hash)?.token).toBe(fake.issued[0]!);
    });
  }

  test("an answer the page would not know how to read", async () => {
    const open = await openSession();
    await unlock(open);
    const route = TOKEN_ROUTES[0]!;

    const unreadable: (() => Response)[] = [
      () => new Response("<html>502 Bad Gateway</html>", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => Response.json(["value"]),
      () => Response.json(null),
      () => Response.json({ oops: true }, { status: 500 }),
      () => Response.json({ error: "invalid" }, { status: 400 }),
      () => new Response(null, { status: 302, headers: { Location: "http://elsewhere.invalid/" } }),
    ];
    for (const response of unreadable) {
      fake.responses.readValue = response;
      const parsed = await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })));
      expect(parsed.status).toBe(502);
      expect(parsed.body).toEqual(UNREADABLE);
    }
  });

  test("an answer that copies the token back does not come out", async () => {
    const open = await openSession();
    await unlock(open);
    const route = TOKEN_ROUTES[0]!;

    fake.responses.readValue = (received) =>
      Response.json({ error: "invalid", message: `Bad request: ${JSON.stringify(received)}` }, { status: 400 });
    const parsed = await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })));
    expect(parsed.status).toBe(502);
    expect(parsed.body).toEqual(UNREADABLE);

    fake.responses.readValue = (received) => Response.json({ value: (received as { token: string }).token });
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(502);
  });

  test("an unlock with no token or no readable deadline is not kept", async () => {
    const open = await openSession();
    for (const body of [{}, { token: "", expiresAt: EXPIRE_A }, { token: 42, expiresAt: EXPIRE_A }, { token: "abc", expiresAt: "tomorrow" }, { token: "abc" }]) {
      fake.responses.unlock = () => Response.json(body);
      const parsed = await read(secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie })));
      expect(parsed.status).toBe(502);
      expect(parsed.body).toEqual(UNREADABLE);
      expect(tokens.read(open.hash)).toBeNull();
    }
    fake.responses.unlock = () => new Response(null, { status: 204 });
    expect((await read(secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie })))).status).toBe(502);
  });

  test("a project list with no projects", async () => {
    const open = await openSession();
    for (const body of [{}, { projects: "cms" }, { projects: null }]) {
      fake.responses.readProjects = () => Response.json(body);
      const parsed = await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })));
      expect(parsed.status).toBe(502);
      expect(parsed.body).toEqual(UNREADABLE);
    }
  });
});

describe("GET /api/secrets and the journal", () => {
  test("with no token, the projects and until null", async () => {
    const open = await openSession();
    const parsed = await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })));
    expect(parsed.status).toBe(200);
    expect(parsed.body).toEqual({ projects: PROJECTS, until: null });
    expect(fake.calls).toEqual([{ method: "readProjects", requested: null }]);
  });

  test("with a token, this session's deadline", async () => {
    const open = await openSession();
    await unlock(open);
    const parsed = await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })));
    expect(parsed.body).toEqual({ projects: PROJECTS, until: EXPIRE_A });
  });

  test("a refusal from the steward goes back out with its status", async () => {
    const open = await openSession();
    fake.responses.readProjects = () => Response.json({ error: "failure", message: "Could not read /srv/sites." }, { status: 500 });
    const parsed = await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })));
    expect(parsed.status).toBe(500);
    expect(parsed.body).toEqual({ error: "failure", message: "Could not read /srv/sites." });
  });

  test("the journal is relayed as it is", async () => {
    const open = await openSession();
    const parsed = await read(secrets.log(requested("/log", { method: "GET", cookie: open.cookie })));
    expect(parsed.status).toBe(200);
    expect(parsed.body.entries).toHaveLength(1);
    expect(fake.calls).toEqual([{ method: "readLog", requested: null }]);
  });
});

describe("locking and signing out", () => {
  test("locking revokes at the steward, forgets, and returns 204", async () => {
    const open = await openSession();
    const token = await unlock(open);
    fake.calls.length = 0;

    const parsed = await read(secrets.lock(requested("/lock", { cookie: open.cookie })));
    expect(parsed.status).toBe(204);
    expect(parsed.body).toBeNull();
    expect(fake.calls).toEqual([{ method: "lock", requested: { token } }]);
    expect(tokens.read(open.hash)).toBeNull();

    const route = TOKEN_ROUTES[0]!;
    fake.calls.length = 0;
    expect((await read(secrets.readValue(requested(route.path, { body: route.body, cookie: open.cookie })))).status).toBe(423);
    expect(fake.calls).toEqual([]);
  });

  test("locking with no token, or a silent steward: 204 all the same", async () => {
    const open = await openSession();
    expect((await read(secrets.lock(requested("/lock", { cookie: open.cookie })))).status).toBe(204);
    expect(fake.calls).toEqual([]);

    await unlock(open);
    fake.responses.lock = () => { throw new TypeError("fetch failed"); };
    expect((await read(secrets.lock(requested("/lock", { cookie: open.cookie })))).status).toBe(204);
    expect(tokens.read(open.hash)).toBeNull();
  });

  test("signing out forgets its session's token, revokes it, and leaves the others", async () => {
    const a = await openSession();
    const b = await openSession();
    const tokenA = await unlock(a);
    const tokenB = await unlock(b);
    fake.calls.length = 0;

    const output = await routes.signOut(
      new Request(`${PUBLIC_URL}/api/signout`, { method: "POST", headers: { Origin: PUBLIC_URL, Cookie: a.cookie } }),
    );
    expect(output.status).toBe(200);
    expect(output.headers.get("set-cookie")).toContain("Max-Age=0");
    const text = await output.text();
    expect(text).not.toContain(tokenA);

    expect(fake.calls).toEqual([{ method: "lock", requested: { token: tokenA } }]);
    expect(tokens.read(a.hash)).toBeNull();
    expect(tokens.read(b.hash)?.token).toBe(tokenB);
  });

  test("signing out succeeds even if the steward does not answer", async () => {
    const open = await openSession();
    await unlock(open);
    fake.responses.lock = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };

    const output = await routes.signOut(
      new Request(`${PUBLIC_URL}/api/signout`, { method: "POST", headers: { Origin: PUBLIC_URL, Cookie: open.cookie } }),
    );
    expect(output.status).toBe(200);
    expect(output.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(tokens.read(open.hash)).toBeNull();
    expect(store.sessions.size).toBe(0);
  });

  test("a sign-out with no unlock does not disturb the steward", async () => {
    const open = await openSession();
    const output = await routes.signOut(
      new Request(`${PUBLIC_URL}/api/signout`, { method: "POST", headers: { Origin: PUBLIC_URL, Cookie: open.cookie } }),
    );
    expect(output.status).toBe(200);
    expect(fake.calls).toEqual([]);
  });
});

describe("a site's journal", () => {
  test("the name goes to the steward as it is, and the steward judges it", async () => {
    const open = await openSession();
    for (const slug of ["cms", "test-zone.invalid", "../cms"]) {
      fake.calls.length = 0;
      const url = `/log?${new URLSearchParams({ slug })}`;
      const parsed = await read(secrets.log(requested(url, { method: "GET", cookie: open.cookie })));
      expect(parsed.status).toBe(200);
      expect(fake.calls).toEqual([{ method: "readLog", requested: slug }]);
    }
  });

  test("empty, too long or named twice: 400, and nothing goes off", async () => {
    const open = await openSession();
    for (const query of ["?slug=", `?slug=${"a".repeat(MAX_LOG_SLUG + 1)}`, "?slug=cms&slug=builder"]) {
      const parsed = await read(secrets.log(requested(`/log${query}`, { method: "GET", cookie: open.cookie })));
      expect(parsed.status).toBe(400);
      expect(parsed.body.error).toBe("invalid");
    }
    expect(fake.calls).toEqual([]);
    // At the limit, it goes off.
    const limit = await read(secrets.log(requested(`/log?slug=${"a".repeat(MAX_LOG_SLUG)}`, { method: "GET", cookie: open.cookie })));
    expect(limit.status).toBe(200);
  });

  test("a refusal from the steward goes back out with its status", async () => {
    const open = await openSession();
    fake.responses.readLog = () => Response.json({ error: "invalid", message: "not a site name" }, { status: 400 });
    const parsed = await read(secrets.log(requested("/journal?slug=CMS", { method: "GET", cookie: open.cookie })));
    expect(parsed).toMatchObject({ status: 400, body: { error: "invalid", message: "not a site name" } });
  });
});

/**
 * The routes the relay waits on with the long timeout: everything that goes
 * through the steward's exclusion lock or through its queue of argon2id
 * verifications.
 */
const LONG_ROUTES = ["/unlock", "/value", "/variable", "/file", "/restore", "/password", "/portal", "/restart"];

describe("localSteward, on a real Unix socket", () => {
  let folder = "";
  let socket = "";
  let stop: () => Promise<void> = async () => {};
  const received: { method: string; path: string; type: string | null; body: string; query?: string }[] = [];
  const slow = new Set<string>();
  const redirected = new Set<string>();
  const serverToken = generateToken();

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "socket-"));
    socket = join(folder, "s.sock");

    const note = (response: (body: string) => Response) => async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = await req.text();
      received.push({ method: req.method, path, type: req.headers.get("content-type"), body, ...(url.search === "" ? {} : { query: url.search }) });
      if (redirected.has(path)) return new Response(null, { status: 307, headers: { Location: "http://steward/vol" } });
      if (slow.has(path)) await Bun.sleep(300);
      return response(body);
    };

    const server = Bun.serve({
      unix: socket,
      routes: {
        "/projects": { GET: note(() => Response.json({ projects: PROJECTS })) },
        "/log": { GET: note(() => Response.json({ entries: [] })) },
        "/unlock": { POST: note(() => Response.json({ token: serverToken, expiresAt: EXPIRE_A })) },
        "/lock": { POST: note(() => new Response(null, { status: 204 })) },
        "/value": { POST: note(() => Response.json({ value: "fake_live_value" })) },
        "/variable": {
          PUT: note(() => Response.json({ file: FILE }, { status: 201 })),
          DELETE: note(() => Response.json({ file: FILE })),
        },
        "/file": { POST: note(() => Response.json({ file: FILE })) },
        "/restore": { POST: note(() => Response.json({ file: FILE })) },
        "/password": { POST: note(() => Response.json({ file: FILE, password: null })) },
        "/portal": { POST: note(() => Response.json({ portal: PORTAL, detail: "done" })) },
        "/restart": { POST: note(() => Response.json({ verdict: VERDICT })) },
        "/vol": { POST: note(() => Response.json({ stolen: true })) },
      },
      fetch: () => new Response("404", { status: 404 }),
    });
    stop = () => server.stop(true);
  });

  afterAll(async () => {
    await stop();
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(() => {
    received.length = 0;
    slow.clear();
    redirected.clear();
  });

  test("every method aims at its route, with its verb, and the body as JSON", async () => {
    const steward = localSteward(socket);
    const token = "token";
    const variable = { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" };
    const password = { slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null };

    const responses = [
      await steward.readProjects(),
      await steward.readLog(null),
      await steward.unlock({ password: PASSWORD }),
      await steward.lock({ token }),
      await steward.readValue(variable),
      await steward.setVariable({ ...variable, value: "a b\\c\"é" }),
      await steward.removeVariable(variable),
      await steward.createFile({ token, slug: "dashboard", file: "dashboard-monitor.env" }),
      await steward.restoreFile({ token, slug: "dashboard", file: "dashboard-monitor.env" }),
      await steward.restart({ token, slug: "cms" }),
      await steward.readLog("test-zone.invalid"),
      await steward.readLog("cms&slug=x/../y"),
      await steward.changePassword({ ...password, token }),
      await steward.togglePortal({ token, slug: "cms", active: true, confirmation: "" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 204, 200, 201, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(await responses[4]!.json()).toEqual({ value: "fake_live_value" });

    const json = "application/json";
    expect(received).toEqual([
      { method: "GET", path: "/projects", type: null, body: "" },
      { method: "GET", path: "/log", type: null, body: "" },
      { method: "POST", path: "/unlock", type: json, body: JSON.stringify({ password: PASSWORD }) },
      { method: "POST", path: "/lock", type: json, body: JSON.stringify({ token }) },
      { method: "POST", path: "/value", type: json, body: JSON.stringify(variable) },
      { method: "PUT", path: "/variable", type: json, body: JSON.stringify({ ...variable, value: "a b\\c\"é" }) },
      { method: "DELETE", path: "/variable", type: json, body: JSON.stringify(variable) },
      { method: "POST", path: "/file", type: json, body: JSON.stringify({ token, slug: "dashboard", file: "dashboard-monitor.env" }) },
      { method: "POST", path: "/restore", type: json, body: JSON.stringify({ token, slug: "dashboard", file: "dashboard-monitor.env" }) },
      { method: "POST", path: "/restart", type: json, body: JSON.stringify({ token, slug: "cms" }) },
      { method: "GET", path: "/log", type: null, body: "", query: "?slug=test-zone.invalid" },
      // Encoded: the name changes neither the path nor the parameters.
      { method: "GET", path: "/log", type: null, body: "", query: "?slug=cms%26slug%3Dx%2F..%2Fy" },
      { method: "POST", path: "/password", type: json, body: JSON.stringify({ ...password, token }) },
      { method: "POST", path: "/portal", type: json, body: JSON.stringify({ token, slug: "cms", active: true, confirmation: "" }) },
    ]);
  });

  test("the short timeout cuts a listing; everything going through the lock or the verification queue gets the long one", async () => {
    const steward = localSteward(socket, { shortMs: 50, longMs: 2_000 });
    for (const path of ["/projects", ...LONG_ROUTES]) slow.add(path);

    const coupe = await steward.readProjects().then(
      () => null,
      (error: Error) => error.name,
    );
    expect(coupe).toBe("TimeoutError");

    // A write can wait its turn behind a restart: cutting at the short
    // timeout would return a 502 for a request that ran to completion.
    const variable = { token: "j", slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" };
    const file = { token: "j", slug: "dashboard", file: "dashboard-monitor.env" };
    const responses = await Promise.all([
      // An unlock waits on the argon2id of the password changes.
      steward.unlock({ password: PASSWORD }),
      steward.readValue(variable),
      steward.setVariable({ ...variable, value: "x" }),
      steward.removeVariable(variable),
      steward.createFile(file),
      steward.restoreFile(file),
      steward.restart({ token: "j", slug: "cms" }),
      steward.changePassword({ ...variable, dashboardPassword: "m", newPassword: null }),
      steward.togglePortal({ token: "j", slug: "cms", active: true, confirmation: "" }),
    ]);
    expect(responses.every((response) => response.status < 300)).toBe(true);
    expect(await responses[6]!.json()).toEqual({ verdict: VERDICT });
  });

  test("server.ts keeps open, for the whole long timeout, every route the relay waits long on", () => {
    const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    for (const path of LONG_ROUTES) {
      const start = source.indexOf(`"/api/secrets${path}": {`);
      expect(start).toBeGreaterThan(-1);
      const tail = source.slice(start + 1);
      const finish = tail.search(/\n\s*"\/api\/|\n\s*\},\n/);
      const entry = tail.slice(0, finish === -1 ? undefined : finish);
      const verbes = entry.match(/\b(GET|POST|PUT|DELETE):/g) ?? [];
      expect(verbes.length).toBeGreaterThan(0);
      // Every verb of the route goes through `long`, which sets the idle
      // timeout: the super admin's handler, and a member's beside it where
      // `either()` gives one that waits on the steward's lock.
      expect({ path, enough: (entry.match(/long\(req, server, /g)?.length ?? 0) >= verbes.length }).toEqual({ path, enough: true });
    }
  });

  test("the long timeout covers the longest action under the lock, the portal", () => {
    expect(DEFAULT_TIMEOUTS.longMs).toBe(Math.max(MAX_PORTAL_MS, MAX_RESTART_MS) + RELAY_MARGIN_MS);
    expect(DEFAULT_TIMEOUTS.longMs).toBeGreaterThan(MAX_PORTAL_MS);
    // Bun caps the idle timeout at 255 seconds: server.ts cannot promise more.
    expect(Math.ceil(DEFAULT_TIMEOUTS.longMs / 1000) + 5).toBeLessThanOrEqual(255);
  });

  test("a redirect is not followed: the token does not go off elsewhere", async () => {
    redirected.add("/value");
    const steward = localSteward(socket);
    await expect(steward.readValue({ token: "j", slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" })).rejects.toThrow();
    expect(received.map((r) => r.path)).toEqual(["/value"]);
  });

  test("socket missing: the client rejects, and the dashboard returns 502", async () => {
    const incomplete = localSteward(join(folder, "missing.sock"));
    await expect(incomplete.readProjects()).rejects.toThrow();

    mount(incomplete);
    const open = await openSession();
    const parsed = await read(secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })));
    expect(parsed.status).toBe(502);
    expect(parsed.body).toEqual({ error: "failure", message: "Can't reach the server's secrets." });
  });

  test("end to end: the token goes to the steward and never to the browser", async () => {
    mount(localSteward(socket));
    const open = await openSession();

    const responses = [
      await secrets.unlock(requested("/unlock", { body: { password: PASSWORD }, cookie: open.cookie })),
      await secrets.dashboard(requested("", { method: "GET", cookie: open.cookie })),
      await secrets.removeVariable(
        requested("/variable", { method: "DELETE", body: { slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL" }, cookie: open.cookie }),
      ),
      await secrets.lock(requested("/lock", { cookie: open.cookie })),
    ];
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 204]);
    for (const text of texts) expect(text).not.toContain(serverToken);
    expect(JSON.parse(texts[1]!).until).toBe(EXPIRE_A);

    expect(received.map((r) => r.path)).toEqual(["/unlock", "/projects", "/variable", "/lock"]);
    expect(JSON.parse(received[2]!.body)).toEqual({ slug: "dashboard", file: "dashboard-monitor.env", variable: "HEARTBEAT_URL", token: serverToken });
    expect(JSON.parse(received[3]!.body)).toEqual({ token: serverToken });
  });
});

describe("a project's store, the owner's", () => {
  test("a value set or a file's content that an answer copies back does not come out, quoted in JSON or as it stands", async () => {
    const open = await openSession();
    await unlock(open);
    const value = 'a-value-with-"quotes"-and-\\-9e1f';
    fake.responses.setStoreVariable = () => Response.json({ ...STORE_CHANGE, set: [value] });
    expect((await read(secrets.setStoreVariable(requested("/store/variable", { method: "PUT", body: { slug: "cms", name: "API_KEY", value }, cookie: open.cookie })))).status).toBe(502);
    const line = '{"private_key":"-----BEGIN PRIVATE KEY-----"}';
    const content = Buffer.from(`${line}\n`).toString("base64");
    fake.responses.setStoreFile = () => Response.json({ ...STORE_CHANGE, reason: line });
    expect((await read(secrets.setStoreFile(requested("/store/file", { method: "PUT", body: { slug: "cms", name: "gcp.json", content }, cookie: open.cookie })))).status).toBe(502);
    fake.responses.setStoreFile = () => Response.json({ ...STORE_CHANGE, reason: content });
    expect((await read(secrets.setStoreFile(requested("/store/file", { method: "PUT", body: { slug: "cms", name: "gcp.json", content }, cookie: open.cookie })))).status).toBe(502);
  });

  test("a reveal's value goes to the owner's page as the steward answers it, under the session's unlock alone", async () => {
    const open = await openSession();
    const token = await unlock(open);
    fake.calls.length = 0;
    const parsed = await read(secrets.revealStoreValue(requested("/store/value", { body: { slug: "cms", name: "API_KEY", token: "from-the-page" }, cookie: open.cookie })));
    expect(parsed).toMatchObject({ status: 200, body: { value: REVEALED } });
    expect(fake.calls).toEqual([{ method: "revealStoreValue", requested: { slug: "cms", name: "API_KEY", token } }]);
  });

  test("each field of its type, a list where a list goes; nothing goes off otherwise, and a file takes a content's cap", async () => {
    const open = await openSession();
    await unlock(open);
    fake.calls.length = 0;
    for (const [route, path, method, body, message] of [
      ["removeStoreVariables", "/store/variable", "DELETE", { slug: "cms", names: "API_KEY" }, "Missing or non-list field: names."],
      ["removeStoreVariables", "/store/variable", "DELETE", { slug: "cms", names: ["A", 1] }, "Missing or non-list field: names."],
      ["generateStoreVariable", "/store/generate", "POST", { slug: "cms", name: "A", format: 42 }, "Non-string field: format."],
      ["generateStoreVariable", "/store/generate", "POST", { slug: "cms", name: "A", bytes: "32" }, "Non-number field: bytes."],
      ["generateStoreVariable", "/store/generate", "POST", { slug: "cms", name: "A", replace: "true" }, "Non-boolean field: replace."],
      ["restoreStore", "/store/restore", "POST", { slug: "cms", dryRun: 1 }, "Non-boolean field: dryRun."],
    ] as const) {
      const parsed = await read(secrets[route](requested(path, { method, body, cookie: open.cookie })));
      expect({ route, status: parsed.status, body: parsed.body }).toEqual({ route, status: 400, body: { error: "invalid", message } });
    }
    expect(fake.calls).toEqual([]);
    // Only the fields each takes go off, of their types: a generate without its options.
    const generated = await read(secrets.generateStoreVariable(requested("/store/generate", { body: { slug: "cms", name: "SESSION_KEY", value: "x" }, cookie: open.cookie })));
    expect(generated.status).toBe(200);
    expect(fake.calls.at(-1)).toMatchObject({ method: "generateStoreVariable", requested: { slug: "cms", name: "SESSION_KEY" } });
    expect(Object.keys(fake.calls.at(-1)!.requested as object).sort()).toEqual(["name", "slug", "token"]);
    // 64 KiB of a file in base64 is well past a variable's cap.
    const content = Buffer.alloc(64 * 1024).toString("base64");
    expect((await read(secrets.setStoreFile(requested("/store/file", { method: "PUT", body: { slug: "cms", name: "big.bin", content }, cookie: open.cookie })))).status).toBe(200);
    expect((await read(secrets.setStoreVariable(requested("/store/variable", { method: "PUT", body: { slug: "cms", name: "A", value: content }, cookie: open.cookie })))).status).toBe(400);
  });

  test("server.ts: reading a store's value back and the platform's own files answer a person 403 before any handler; the store's writes and its restore are relayed for a person too, each with the long delay", () => {
    const source = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const entry = (path: string) => {
      const start = source.indexOf(`"/api/secrets${path}": {`);
      expect(start).toBeGreaterThan(-1);
      const tail = source.slice(start + 1);
      const finish = tail.search(/\n\s*"\/api\/|\n\s*\},\n/);
      return tail.slice(0, finish === -1 ? undefined : finish);
    };
    for (const path of ["/store/value", "/value", "/file", "/restore", "/password"]) {
      const text = entry(path);
      expect(text).toContain("POST: owner((req, server) => long(req, server, secrets.");
      expect(text).not.toContain("memberRelay");
    }
    const variable = entry("/variable");
    expect(variable).toContain("PUT: owner((req, server) => long(req, server, secrets.setVariable))");
    expect(variable).toContain("DELETE: owner((req, server) => long(req, server, secrets.removeVariable))");
    expect(variable).not.toContain("memberRelay");
    // A file's whole content is no route any more.
    expect(source).not.toContain(`"/api/secrets/content"`);
    for (const [path, verbs] of [
      ["/store/variable", 2],
      ["/store/generate", 1],
      ["/store/file", 2],
      ["/store/restore", 1],
    ] as const) {
      const text = entry(path);
      expect({ path, either: text.match(/either\(/g)?.length ?? 0, member: text.match(/memberRelay\.\w+/g)?.length ?? 0, long: text.match(/long\(req, server, /g)?.length ?? 0 }).toEqual({
        path,
        either: verbs,
        member: verbs,
        long: 2 * verbs,
      });
    }
  });
});

describe("localSteward's store routes, on a real Unix socket", () => {
  test("every method aims at its route, with its verb, the body as JSON, the slug of a listing encoded; every write and the reveal wait the long delay", async () => {
    const folder = mkdtempSync(join(tmpdir(), "socket-store-"));
    const socket = join(folder, "s.sock");
    const received: { method: string; path: string; query: string; body: string }[] = [];
    const server = Bun.serve({
      unix: socket,
      async fetch(req) {
        const url = new URL(req.url);
        received.push({ method: req.method, path: url.pathname, query: url.search, body: await req.text() });
        if (url.pathname !== "/store") await Bun.sleep(150);
        return Response.json({ ok: true });
      },
    });
    try {
      const steward = localSteward(socket, { shortMs: 100, longMs: 5_000 });
      const token = "unlock-token";
      const calls = [
        steward.setStoreVariable({ token, slug: "cms", name: "A", value: "v" }),
        steward.removeStoreVariables({ token, slug: "cms", names: ["A"] }),
        steward.generateStoreVariable({ token, slug: "cms", name: "K", format: "hex", bytes: 32 }),
        steward.setStoreFile({ token, slug: "cms", name: "gcp.json", content: "e30=" }),
        steward.removeStoreFile({ token, slug: "cms", name: "gcp.json" }),
        steward.restoreStore({ token, slug: "cms", dryRun: true }),
        steward.revealStoreValue({ token, slug: "cms", name: "A" }),
      ];
      expect((await Promise.all(calls)).map((response) => response.status)).toEqual(Array(7).fill(200));
      expect((await steward.readStore("cms&slug=x/../y")).status).toBe(200);
      expect(received.map(({ method, path }) => `${method} ${path}`).sort()).toEqual(
        [
          "PUT /store/variable",
          "DELETE /store/variable",
          "POST /store/generate",
          "PUT /store/file",
          "DELETE /store/file",
          "POST /store/restore",
          "POST /store/value",
          "GET /store",
        ].sort(),
      );
      expect(received.find((one) => one.path === "/store/generate")!.body).toBe(JSON.stringify({ token, slug: "cms", name: "K", format: "hex", bytes: 32 }));
      const listing = received.find((one) => one.method === "GET")!;
      expect(listing).toEqual({ method: "GET", path: "/store", query: "?slug=cms%26slug%3Dx%2F..%2Fy", body: "" });
    } finally {
      await server.stop(true);
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
