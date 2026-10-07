import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import type { Raw } from "../src/state";
import { createSharingRoutes, localSharing, type SharingPortal } from "../src/sharing";
import type { SessionReader } from "../src/routes";

/**
 * The Sharing relay, held to the rules of the guest relay: a session to read,
 * the dashboard's origin then a session to change, and only a host whose
 * block in service carries the portal. What reaches the portal is rebuilt key
 * by key.
 */
test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;
const STATE_FILE = join(DATA_DIR, "sharing-state.json");
const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";

function folder(slug: string, manifest: unknown) {
  return { slug, manifest: JSON.stringify(manifest), unit: null, bytes: 1024, deployed: NOW };
}

/** kanban carries the portal; roster asks for it without its block carrying it; showcase is open. */
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

const session: SessionReader = async (req) =>
  (req.headers.get("cookie") ?? "").includes("session=open") ? { hash: "h", createdAt: NOW, seenAt: NOW, identity: "owner" } : null;

function fakePortal(fail = false) {
  const calls: { method: string; argument: unknown }[] = [];
  const answer = (method: string, argument: unknown, body: unknown) => {
    calls.push({ method, argument });
    if (fail) throw new TypeError("fetch failed");
    return Response.json(body);
  };
  const portal: SharingPortal = {
    list: async () => answer("list", null, { sso: { configured: true }, sites: [] }),
    replace: async (host, body) => answer("replace", { host, body }, { host, policy: body }),
    audit: async (limit, before) => answer("audit", { limit, before }, { events: [] }),
  };
  return { portal, calls };
}

function routes(fail = false) {
  const fake = fakePortal(fail);
  return { fake, routes: createSharingRoutes({ session, publicUrl: PUBLIC_URL, stateFile: STATE_FILE, portal: fake.portal }, () => NOW) };
}

function put(host: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}/api/sharing/${host}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: PUBLIC_URL, Cookie: "session=open", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("reading the policies", () => {
  test("needs a session, then relays the portal's answer as it stands", async () => {
    const { fake, routes: r } = routes();
    expect((await r.list(new Request(`${PUBLIC_URL}/api/sharing`))).status).toBe(401);
    expect(fake.calls).toEqual([]);
    const response = await r.list(new Request(`${PUBLIC_URL}/api/sharing`, { headers: { Cookie: "session=open" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ sso: { configured: true }, sites: [] });
  });

  test("a portal from before sharing answers 404, relayed as such for the page to say so", async () => {
    const old: SharingPortal = {
      list: async () => new Response("404: unknown route", { status: 404 }),
      replace: async () => new Response("404: unknown route", { status: 404 }),
      audit: async () => new Response("404: unknown route", { status: 404 }),
    };
    const r = createSharingRoutes({ session, publicUrl: PUBLIC_URL, stateFile: STATE_FILE, portal: old }, () => NOW);
    const response = await r.list(new Request(`${PUBLIC_URL}/api/sharing`, { headers: { Cookie: "session=open" } }));
    expect(response.status).toBe(404);
  });

  test("an unreachable portal is said unreachable, not a mute 500", async () => {
    const { routes: r } = routes(true);
    const response = await r.list(new Request(`${PUBLIC_URL}/api/sharing`, { headers: { Cookie: "session=open" } }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "portal-unreachable" });
  });
});

describe("changing a site's policy", () => {
  test("relays only the policy's three keys, and names the owner", async () => {
    const { fake, routes: r } = routes();
    const body = { mode: "people", people: ["alice@acme.test"], domains: [], actor: "ceo@acme.test", extra: "x" };
    const response = await r.replace(put("kanban.test-zone.invalid", body), "kanban.test-zone.invalid");
    expect(response.status).toBe(200);
    expect(fake.calls).toEqual([
      {
        method: "replace",
        argument: {
          host: "kanban.test-zone.invalid",
          body: { mode: "people", people: ["alice@acme.test"], domains: [], actor: "owner" },
        },
      },
    ]);
  });

  test("the origin first, before the session: another page cannot change who gets in", async () => {
    const { fake, routes: r } = routes();
    for (const origin of ["https://agency.test-zone.invalid", "null"]) {
      expect((await r.replace(put("kanban.test-zone.invalid", { mode: "admins" }, { Origin: origin }), "kanban.test-zone.invalid")).status).toBe(403);
    }
    const noOrigin = new Request(`${PUBLIC_URL}/api/sharing/kanban.test-zone.invalid`, { method: "PUT", headers: { Cookie: "session=open" }, body: "{}" });
    expect((await r.replace(noOrigin, "kanban.test-zone.invalid")).status).toBe(403);
    expect((await r.replace(put("kanban.test-zone.invalid", { mode: "admins" }, { Cookie: "" }), "kanban.test-zone.invalid")).status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  test("only a site whose block carries the portal: elsewhere a policy would close nothing", async () => {
    const { fake, routes: r } = routes();
    for (const host of ["roster.test-zone.invalid", "showcase.test-zone.invalid", "elsewhere.test"]) {
      const response = await r.replace(put(host, { mode: "domain", domains: ["acme.test"] }), host);
      expect({ host, status: response.status }).toEqual({ host, status: 400 });
      expect(await response.json()).toEqual({ error: "no-portal" });
    }
    expect(fake.calls).toEqual([]);
  });

  test("an unreadable body is refused before the portal", async () => {
    const { fake, routes: r } = routes();
    expect((await r.replace(put("kanban.test-zone.invalid", "{"), "kanban.test-zone.invalid")).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

describe("the portal's audit", () => {
  test("needs a session, and pages within bounds", async () => {
    const { fake, routes: r } = routes();
    const ask = (query: string, cookie = "session=open") =>
      r.audit(new Request(`${PUBLIC_URL}/api/portal/audit${query}`, { headers: { Cookie: cookie } }));
    expect((await ask("", "")).status).toBe(401);
    expect((await ask("")).status).toBe(200);
    expect((await ask("?limit=20&before=40")).status).toBe(200);
    for (const query of ["?limit=0", "?limit=501", "?limit=x", "?before=0"]) expect((await ask(query)).status).toBe(400);
    expect(fake.calls).toEqual([
      { method: "audit", argument: { limit: 100, before: null } },
      { method: "audit", argument: { limit: 20, before: 40 } },
    ]);
  });
});

describe("the client towards the portal", () => {
  test("speaks the portal's admin routes, the host encoded", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}${url.search} ${req.method === "PUT" ? await req.text() : ""}`.trim());
        return Response.json({});
      },
    });
    try {
      const client = localSharing(`http://127.0.0.1:${server.port}`);
      await client.list();
      await client.replace("kanban.test-zone.invalid", { mode: "admins", people: [], domains: [], actor: "owner" });
      await client.audit(50, 7);
      expect(seen).toEqual([
        "GET /admin/sharing",
        'PUT /admin/sharing/kanban.test-zone.invalid {"mode":"admins","people":[],"domains":[],"actor":"owner"}',
        "GET /admin/audit?limit=50&before=7",
      ]);
    } finally {
      server.stop(true);
    }
  });
});
