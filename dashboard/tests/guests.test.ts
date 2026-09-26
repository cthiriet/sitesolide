import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { buildSnapshot, type Raw } from "../src/state";
import { invitableHosts, type Portal } from "../src/guests";
import { createRoutes, type Store } from "../src/routes";
import { tokenHash, type Session } from "../src/sessions";

test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;
const PASSWORD = "a password drawn at random";
const STATE_FILE = join(DATA_DIR, "guests-state.json");
const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";

function folder(slug: string, manifest: unknown) {
  return { slug, manifest: JSON.stringify(manifest), unit: null, bytes: 1024, deployed: NOW };
}

/**
 * kanban is behind the portal, door in place; roster asks for it but its
 * block does not carry it; showcase is an ordinary preview.
 */
const RAW: Raw = {
  generated: NOW,
  zone: "test-zone.invalid",
  folders: [
    folder("kanban", { slug: "kanban", port: 3045, start: "bun run server.ts", portal: true }),
    folder("roster", { slug: "roster", port: 3047, start: "bun run server.ts", portal: true }),
    folder("showcase", { slug: "showcase", publicDir: "public" }),
  ],
  codes: "{}",
  domains: null,
  ports: [],
  blocks: { kanban: WITH_DOOR, roster: "reverse_proxy 127.0.0.1:3047" },
  machine: null,
  previous: null,
};

beforeAll(() => writeFileSync(STATE_FILE, JSON.stringify(RAW)));
afterAll(() => rmSync(STATE_FILE, { force: true }));

test("only the sites whose door is in place get guests", () => {
  expect(invitableHosts(buildSnapshot(RAW))).toEqual(["kanban.test-zone.invalid"]);
});

type Call = { method: keyof Portal; argument: unknown };

function fakePortal(failures: Partial<Record<keyof Portal, boolean>> = {}) {
  const calls: Call[] = [];
  function note(method: keyof Portal, argument: unknown) {
    calls.push({ method, argument });
    if (failures[method]) throw new TypeError("fetch failed");
  }
  const portal: Portal = {
    async list() {
      note("list", null);
      return Response.json({ guests: [{ id: "AAAAAAAAAAAAAAA0", host: "kanban.test-zone.invalid" }] });
    },
    async create(body) {
      note("create", body);
      return Response.json({ guest: { id: "AAAAAAAAAAAAAAA0" }, password: "Ab3d-Ef4h-Jk5m-Np6q" }, { status: 201 });
    },
    async remove(id) {
      note("remove", id);
      return new Response(null, { status: 204 });
    },
  };
  return { portal, calls };
}

function createStore(): Store {
  const sessions = new Map<string, Session>();
  let attempts = { failures: 0, lastAt: 0 };
  return {
    async openSession(now) {
      const token = `token-${sessions.size}`;
      const hash = await tokenHash(token);
      sessions.set(hash, { hash, createdAt: now, seenAt: now });
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
    readAttempts: () => attempts,
    setAttempts(failures, lastAt) {
      attempts = { failures, lastAt };
    },
  };
}

let hash = "";
let fake: ReturnType<typeof fakePortal>;
let routes: ReturnType<typeof createRoutes>;
let cookie = "";

async function prepare(failures: Partial<Record<keyof Portal, boolean>> = {}) {
  if (hash === "") hash = await Bun.password.hash(PASSWORD, "argon2id");
  fake = fakePortal(failures);
  routes = createRoutes(
    createStore(),
    {
      hash,
      publicUrl: PUBLIC_URL,
      online: true,
      sessionDurationMs: 7 * 24 * 3600 * 1000,
      stateFile: STATE_FILE,
      portal: fake.portal,
    },
    () => NOW,
  );
  const response = await routes.signIn(
    new Request(`${PUBLIC_URL}/api/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: PUBLIC_URL },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const header = response.headers.get("set-cookie") ?? "";
  cookie = header.slice(0, header.indexOf(";"));
}

beforeEach(() => prepare());

function creation(body: unknown, headers: Record<string, string | null> = {}): Request {
  const with_: Record<string, string> = { "Content-Type": "application/json", Origin: PUBLIC_URL, Cookie: cookie };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete with_[name];
    else with_[name] = value;
  }
  return new Request(`${PUBLIC_URL}/api/guests`, {
    method: "POST",
    headers: with_,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function suppression(headers: Record<string, string> = { Origin: PUBLIC_URL }): Request {
  return new Request(`${PUBLIC_URL}/api/invites/AAAAAAAAAAAAAAA0`, {
    method: "DELETE",
    headers: { Cookie: cookie, ...headers },
  });
}

const VALID = { host: "kanban.test-zone.invalid", label: "Alice", durationS: 604800 };

describe("with no session, nothing comes out and nothing goes off", () => {
  test("neither the list, nor a creation, nor a revocation", async () => {
    const without = { Cookie: "" };
    expect((await routes.guests(new Request(`${PUBLIC_URL}/api/guests`))).status).toBe(401);
    expect((await routes.createGuest(creation(VALID, without))).status).toBe(401);
    expect((await routes.revokeGuest(suppression({ Origin: PUBLIC_URL, Cookie: "" }), "AAAAAAAAAAAAAAA0")).status).toBe(401);
    expect(fake.calls).toEqual([]);
  });
});

describe("a write coming from elsewhere is refused, session or not", () => {
  test("missing or foreign origin, nothing reaches the portal", async () => {
    for (const origin of [null, "https://pirate.test", "https://agency.test-zone.invalid"]) {
      expect((await routes.createGuest(creation(VALID, { Origin: origin }))).status).toBe(403);
    }
    expect((await routes.revokeGuest(suppression({}), "AAAAAAAAAAAAAAA0")).status).toBe(403);
    expect((await routes.revokeGuest(suppression({ Origin: "https://cms.test-zone.invalid" }), "AAAAAAAAAAAAAAA0")).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });
});

describe("with a session", () => {
  test("the list comes from the portal, never cached", async () => {
    const response = await routes.guests(new Request(`${PUBLIC_URL}/api/guests`, { headers: { Cookie: cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ guests: [{ id: "AAAAAAAAAAAAAAA0", host: "kanban.test-zone.invalid" }] });
  });

  test("an access is created on a site whose door is in place, and the password comes back once", async () => {
    const response = await routes.createGuest(creation({ ...VALID, intruder: "ignore" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ password: "Ab3d-Ef4h-Jk5m-Np6q" });
    // Only the three expected fields go off to the portal.
    expect(fake.calls).toEqual([{ method: "create", argument: VALID }]);
  });

  test("anywhere else, nothing goes off: site with no door in place, preview, unknown or missing host", async () => {
    for (const host of ["roster.test-zone.invalid", "showcase.test-zone.invalid", "evil.test", undefined, 42]) {
      const response = await routes.createGuest(creation({ ...VALID, host }));
      expect({ host, status: response.status }).toEqual({ host, status: 400 });
    }
    expect((await routes.createGuest(creation("not json"))).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  test("revoking relays to the portal", async () => {
    const response = await routes.revokeGuest(suppression(), "AAAAAAAAAAAAAAA0");
    expect(response.status).toBe(204);
    expect(fake.calls).toEqual([{ method: "remove", argument: "AAAAAAAAAAAAAAA0" }]);
  });

  test("portal unreachable, the dashboard says so instead of throwing", async () => {
    await prepare({ list: true, create: true, remove: true });
    for (const response of [
      await routes.guests(new Request(`${PUBLIC_URL}/api/guests`, { headers: { Cookie: cookie } })),
      await routes.createGuest(creation(VALID)),
      await routes.revokeGuest(suppression(), "AAAAAAAAAAAAAAA0"),
    ]) {
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "portal-unreachable" });
    }
  });
});
