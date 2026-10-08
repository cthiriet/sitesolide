import { describe, expect, test } from "bun:test";
import { createAccessAdmin, MOVED } from "../src/admin";
import { readSettings, type Settings } from "../src/oidc";
import type { Reading } from "../src/projection";
import { memoryAudit } from "./memory";

const NOW = 1_800_000_000_000;
const HOST = "forum.test-zone.invalid";
const BASE = "http://127.0.0.1:3026";

const SETTINGS = readSettings(
  {
    OIDC_ISSUER: "https://idp.test-zone.invalid",
    OIDC_CLIENT_ID: "client-id-the-dashboard-never-sees",
    OIDC_CLIENT_SECRET: "secret-the-dashboard-never-sees",
    OIDC_ALLOWED_DOMAINS: "acme.test",
    OIDC_ADMIN_EMAILS: "owner@acme.test",
    OIDC_PROVIDER_NAME: "Acme",
  },
  "https://portal.test-zone.invalid",
).settings!;

function admin(settings: Settings | null = SETTINGS, state: { reading: Reading; writtenAt: number | null } = { reading: "steward", writtenAt: NOW }) {
  const audit = memoryAudit();
  return { audit, routes: createAccessAdmin({ access: { state: () => state }, audit, settings }) };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Every route that changed who may open a site, each as the dashboard or the relay called it. */
const MOVED_ROUTES: { name: string; ask: (body?: unknown, headers?: Record<string, string>) => Request }[] = [
  { name: "PUT /admin/sharing/:host", ask: (body, headers) => request("PUT", `/admin/sharing/${HOST}`, body, headers) },
  { name: "GET /admin/guests", ask: (_, headers) => request("GET", "/admin/guests", undefined, headers) },
  { name: "POST /admin/guests", ask: (body, headers) => request("POST", "/admin/guests", body, headers) },
  { name: "DELETE /admin/invites/:id", ask: (body, headers) => request("DELETE", "/admin/invites/AAAAAAAAAAAAAAA0", body, headers) },
];

describe("what the portal reads who may open a site from", () => {
  test("GET /admin/access says where its decisions come from, and when the steward wrote them", async () => {
    const { routes } = admin();
    const response = routes.access(request("GET", "/admin/access"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ reading: "steward", writtenAt: NOW });
  });

  test("before the steward's projection, or with one it cannot believe, it says so", async () => {
    for (const reading of ["portal", "unreadable"] as const) {
      const { routes } = admin(SETTINGS, { reading, writtenAt: null });
      expect(await routes.access(request("GET", "/admin/access")).json()).toEqual({ reading, writtenAt: null });
    }
  });
});

describe("how people sign in", () => {
  test("GET /admin/sharing says how people sign in, never the client's secret nor its identifier, and no site", async () => {
    const { routes } = admin();
    const response = routes.sso(request("GET", "/admin/sharing"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      sso: {
        configured: true,
        providerName: "Acme",
        portalUrl: "https://portal.test-zone.invalid",
        admins: ["owner@acme.test"],
        allowedDomains: ["acme.test"],
      },
      sites: [],
    });
    expect(JSON.stringify(body)).not.toInclude("never-sees");
  });

  test("without a provider, it says so", async () => {
    const { routes } = admin(null);
    const body = (await routes.sso(request("GET", "/admin/sharing")).json()) as { sso: unknown; sites: unknown };
    expect(body).toEqual({ sso: { configured: false, providerName: null, portalUrl: null, admins: [], allowedDomains: [] }, sites: [] });
  });
});

describe("the routes that changed who may open a site before the steward kept it", () => {
  for (const route of MOVED_ROUTES) {
    test(`${route.name} answers that it moved, and records nothing`, async () => {
      const { audit, routes } = admin();
      const response = routes.moved(route.ask());
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(MOVED);
      expect(audit.events).toEqual([]);
    });
  }

  test("what they answer points to where access is kept now", () => {
    expect(MOVED.error).toBe("moved");
    expect(MOVED.message).toInclude("sitesolide share");
  });

  test("whatever the body names, an actor or nothing, from whichever account, the answer is the same: moved", async () => {
    const { audit, routes } = admin();
    for (const route of MOVED_ROUTES) {
      for (const body of [{ mode: "admins" }, { actor: "owner" }, { actor: "token:abc_1" }, { actor: "Alice@acme.test" }, { actor: "root; drop" }, [], "null", '"text"', "{"]) {
        const response = routes.moved(route.ask(body));
        expect({ route: route.name, body, status: response.status }).toEqual({ route: route.name, body, status: 410 });
      }
    }
    expect(audit.events).toEqual([]);
  });
});

describe("the audit", () => {
  test("reads by pages", async () => {
    const { audit, routes } = admin();
    for (let i = 0; i < 5; i++) audit.record({ actor: "owner", action: "portal.signin" }, NOW + i);
    const page = (await routes.audit(request("GET", "/admin/audit?limit=2")).json()) as { events: { id: number }[] };
    expect(page.events.map((event) => event.id)).toEqual([5, 4]);
    const next = (await routes.audit(request("GET", "/admin/audit?limit=2&before=4")).json()) as { events: { id: number }[] };
    expect(next.events.map((event) => event.id)).toEqual([3, 2]);
    for (const query of ["limit=0", "limit=x", "before=-1", "limit=1.5"]) {
      expect(routes.audit(request("GET", `/admin/audit?${query}`)).status).toBe(400);
    }
  });
});

describe("a request that came through Caddy reaches nothing", () => {
  for (const header of ["X-Forwarded-For", "X-Portal-Hote"]) {
    test(`refused if it carries ${header}`, async () => {
      const { routes } = admin();
      const carried = { [header]: "203.0.113.7" };
      expect(routes.access(request("GET", "/admin/access", undefined, carried)).status).toBe(403);
      expect(routes.sso(request("GET", "/admin/sharing", undefined, carried)).status).toBe(403);
      expect(routes.audit(request("GET", "/admin/audit", undefined, carried)).status).toBe(403);
      for (const route of MOVED_ROUTES) {
        const refused = routes.moved(route.ask({ actor: "alice@acme.test" }, carried));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({ error: "relayed-request" });
      }
    });
  }
});
