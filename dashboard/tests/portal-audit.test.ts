import { describe, expect, test } from "bun:test";
import { createPortalAuditRoute, localPortalAudit, type PortalAudit } from "../src/portal-audit";
import type { SessionReader } from "../src/routes";

/**
 * The portal's audit, relayed to the owner's Activity page: a session to
 * read, a page within its bounds, the portal's answer passed on as it stands,
 * and a portal that cannot be reached said so rather than a mute 500.
 */

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const NOW = 1_756_400_000_000;

const session: SessionReader = async (req) =>
  (req.headers.get("cookie") ?? "").includes("session=open") ? { hash: "h", createdAt: NOW, seenAt: NOW, identity: "owner" } : null;

function fakePortal(answer: () => Response | Promise<Response> = () => Response.json({ events: [{ id: 1, action: "portal.signin" }] })) {
  const calls: { limit: number; before: number | null }[] = [];
  const portal: PortalAudit = {
    audit: async (limit, before) => {
      calls.push({ limit, before });
      return answer();
    },
  };
  return { portal, calls };
}

function ask(route: (req: Request) => Promise<Response>, query = "", cookie = "session=open"): Promise<Response> {
  return route(new Request(`${PUBLIC_URL}/api/portal/audit${query}`, { headers: { Cookie: cookie } }));
}

describe("the portal's audit", () => {
  test("needs a session, before the portal is asked anything", async () => {
    const fake = fakePortal();
    const route = createPortalAuditRoute({ session, portal: fake.portal }, () => NOW);
    const refused = await ask(route, "", "");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "no-session" });
    expect(fake.calls).toEqual([]);
  });

  test("pages within bounds, a hundred events when none is asked", async () => {
    const fake = fakePortal();
    const route = createPortalAuditRoute({ session, portal: fake.portal }, () => NOW);
    expect((await ask(route)).status).toBe(200);
    expect((await ask(route, "?limit=20&before=40")).status).toBe(200);
    expect((await ask(route, "?limit=500")).status).toBe(200);
    for (const query of ["?limit=0", "?limit=501", "?limit=x", "?limit=1.5", "?before=0", "?before=x"]) {
      const refused = await ask(route, query);
      expect([query, refused.status]).toEqual([query, 400]);
      expect(await refused.json()).toEqual({ error: "invalid-page" });
    }
    expect(fake.calls).toEqual([
      { limit: 100, before: null },
      { limit: 20, before: 40 },
      { limit: 500, before: null },
    ]);
  });

  test("relays the portal's answer as it stands, never kept", async () => {
    const route = createPortalAuditRoute({ session, portal: fakePortal().portal }, () => NOW);
    const response = await ask(route);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ events: [{ id: 1, action: "portal.signin" }] });
  });

  test("a portal from before its audit answers 404, relayed as such for the page to say so", async () => {
    const route = createPortalAuditRoute({ session, portal: fakePortal(() => new Response("404: unknown route", { status: 404 })).portal }, () => NOW);
    expect((await ask(route)).status).toBe(404);
  });

  test("an unreachable portal is said unreachable, not a mute 500", async () => {
    const route = createPortalAuditRoute(
      {
        session,
        portal: fakePortal(() => {
          throw new TypeError("fetch failed");
        }).portal,
      },
      () => NOW,
    );
    const response = await ask(route);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "portal-unreachable" });
  });
});

describe("the client towards the portal", () => {
  test("speaks the portal's audit route, the page in the query", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}${url.search}`);
        return Response.json({ events: [] });
      },
    });
    try {
      const client = localPortalAudit(`http://127.0.0.1:${server.port}`);
      await client.audit(50, 7);
      await client.audit(100, null);
      expect(seen).toEqual(["GET /admin/audit?limit=50&before=7", "GET /admin/audit?limit=100"]);
    } finally {
      server.stop(true);
    }
  });
});
