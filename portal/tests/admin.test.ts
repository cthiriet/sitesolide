import { describe, expect, test } from "bun:test";
import { createAccessAdmin } from "../src/admin";
import type { Reading } from "../src/projection";
import { memoryAudit } from "./memory";

const NOW = 1_800_000_000_000;
const BASE = "http://127.0.0.1:3026";

function admin(state: { reading: Reading; writtenAt: number | null } = { reading: "steward", writtenAt: NOW }) {
  const audit = memoryAudit();
  return { audit, routes: createAccessAdmin({ access: { state: () => state }, audit }) };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("what the portal reads who may open a site from", () => {
  test("GET /admin/access says where its decisions come from, and when the steward wrote them", async () => {
    const { routes } = admin();
    const response = routes.access(request("GET", "/admin/access"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ reading: "steward", writtenAt: NOW });
  });

  test("before the steward's projection, or with one it cannot believe, it says so", async () => {
    const { routes } = admin({ reading: "unreadable", writtenAt: null });
    expect(await routes.access(request("GET", "/admin/access")).json()).toEqual({ reading: "unreadable", writtenAt: null });
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
      const refused = routes.audit(request("GET", "/admin/audit", undefined, carried));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "relayed-request" });
    });
  }
});
