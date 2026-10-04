import { describe, expect, test } from "bun:test";
import type { ConnectorsSteward, EgressReader } from "../src/connectors/client";
import { createConnectorsRoutes } from "../src/connectors/relay";
import type { Steward } from "../src/secrets/client";
import { createSecretsRoutes } from "../src/secrets/routes";
import { createTokens } from "../src/secrets/tokens";
import type { Session } from "../src/sessions";

/**
 * The relay with a simulated steward and a simulated proxy: what it checks
 * itself (session, origin, unlock, the shape of a body) and what it refuses to
 * pass back (a value). The rules on a connector are the steward's, tested
 * there.
 */
const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const SESSION: Session = { hash: "session-hash", createdAt: 0, seenAt: 0 };
const VALUE = "Bearer relay-test-value-0123456789";
const VIEW = { installed: true, state: "managed", reason: null, connectors: [], grants: [], requests: [], sites: ["shop"] };

function bench(overrides: { steward?: Partial<ConnectorsSteward>; egress?: Partial<EgressReader> } = {}) {
  const sent: { route: string; body: unknown }[] = [];
  const steward: ConnectorsSteward = {
    read: async () => Response.json(VIEW),
    put: async (requested) => (sent.push({ route: "put", body: requested }), Response.json(VIEW)),
    remove: async (requested) => (sent.push({ route: "remove", body: requested }), Response.json(VIEW)),
    grant: async (requested) => (sent.push({ route: "grant", body: requested }), Response.json(VIEW)),
    ...overrides.steward,
  };
  const egress: EgressReader = {
    audit: async () => Response.json({ rows: [{ id: 1, at: "2026-10-04T12:00:00.000Z", actor: "system", action: "egress.denied", target: "shop", detail: "{}" }] }),
    status: async () => Response.json({ connectors: 1, grants: 0, errors: [] }),
    ...overrides.egress,
  };
  const tokens = createTokens(() => 1_000);
  const session = async (req: Request) => (req.headers.get("cookie") === "s=1" ? SESSION : null);
  // The secrets' routes are real: their checks are the ones under test here.
  const secrets = createSecretsRoutes({ session, publicUrl: PUBLIC_URL, steward: {} as Steward, tokens }, () => 1_000);
  const routes = createConnectorsRoutes({ session, steward, egress, tokens, withToken: secrets.withToken }, () => 1_000);
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:3022/api/connectors", {
      method,
      headers: { cookie: "s=1", origin: PUBLIC_URL, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const unlock = () => tokens.set(SESSION.hash, { token: "steward-token-0123456789abcdef0123456789", expiresAt: 600_000 });
  return { routes, request, sent, unlock };
}

describe("reading", () => {
  test("needs a session, and says until when this session is unlocked", async () => {
    const { routes, request, unlock } = bench();
    expect((await routes.list(request("GET", undefined, { cookie: "" }))).status).toBe(401);
    expect(await (await routes.list(request("GET"))).json()).toEqual({ ...VIEW, until: null });
    unlock();
    expect(await (await routes.list(request("GET"))).json()).toMatchObject({ until: 600_000 });
  });

  test("a steward that predates the connectors is named as such", async () => {
    const { routes, request } = bench({
      steward: { read: async () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 }) },
    });
    const response = await routes.list(request("GET"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toContain("run bin/deploy-steward.sh");
  });

  test("an unreachable steward or an answer the page could not read is a 502", async () => {
    const down = bench({ steward: { read: async () => Promise.reject(new Error("ENOENT")) } });
    expect((await down.routes.list(down.request("GET"))).status).toBe(502);
    const odd = bench({ steward: { read: async () => Response.json({ connectors: "no" }) } });
    expect((await odd.routes.list(odd.request("GET"))).status).toBe(502);
  });
});

describe("writing", () => {
  const put = { name: "chat", baseUrl: "https://chat.test-zone.invalid", header: "Authorization", value: VALUE };

  test("needs the origin, the session and the unlock, then relays with the token the service holds", async () => {
    const { routes, request, sent, unlock } = bench();
    expect((await routes.putConnector(request("PUT", put, { origin: "https://elsewhere.test-zone.invalid" }))).status).toBe(403);
    expect((await routes.putConnector(request("PUT", put))).status).toBe(423);
    unlock();
    const response = await routes.putConnector(request("PUT", { ...put, token: "page-token" }));
    expect(response.status).toBe(200);
    expect(sent).toEqual([{ route: "put", body: { ...put, token: "steward-token-0123456789abcdef0123456789" } }]);
  });

  test("a response that would carry the value back is refused", async () => {
    const { routes, request, unlock } = bench({ steward: { put: async () => Response.json({ ...VIEW, oops: VALUE }) } });
    unlock();
    const response = await routes.putConnector(request("PUT", put));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(VALUE);
  });

  test("the shapes the page must send, and nothing judged beyond them", async () => {
    const { routes, request, unlock } = bench();
    unlock();
    expect((await routes.putConnector(request("PUT", { ...put, value: 3 }))).status).toBe(400);
    expect((await routes.putConnector(request("PUT", { ...put, value: null }))).status).toBe(200);
    expect((await routes.putConnector(request("PUT", { ...put, baseUrl: 1 }))).status).toBe(400);
    expect((await routes.setGrant(request("PUT", { slug: "shop", connector: "chat", granted: "yes" }))).status).toBe(400);
    expect((await routes.setGrant(request("PUT", { slug: "shop", connector: "chat", granted: true }))).status).toBe(200);
    expect((await routes.removeConnector(request("DELETE", { name: "chat" }))).status).toBe(400);
    expect((await routes.removeConnector(request("DELETE", { name: "chat", confirmation: "chat" }))).status).toBe(200);
  });

  test("the steward's refusal reaches the page as it came", async () => {
    const { routes, request, unlock } = bench({
      steward: { grant: async () => Response.json({ error: "out-of-scope", message: "not a site deployed under /srv/sites" }, { status: 403 }) },
    });
    unlock();
    const response = await routes.setGrant(request("PUT", { slug: "ghost", connector: "chat", granted: true }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "out-of-scope", message: "not a site deployed under /srv/sites" });
  });
});

describe("the activity", () => {
  test("read from the egress proxy, rows and state", async () => {
    const { routes, request } = bench();
    const response = await routes.activity(request("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ action: "egress.denied" }], status: { connectors: 1 } });
    expect((await routes.activity(request("GET", undefined, { cookie: "" }))).status).toBe(401);
  });

  test("a proxy that is not there, or that refuses the dashboard, says so", async () => {
    const down = bench({ egress: { audit: async () => Promise.reject(new Error("ECONNREFUSED")) } });
    const unreachable = await down.routes.activity(down.request("GET"));
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { message: string }).message).toBe("Can't reach the egress proxy.");
    const refusing = bench({ egress: { audit: async () => Response.json({ error: "refused", message: "only the dashboard reads this" }, { status: 403 }) } });
    const refused = await refusing.routes.activity(refusing.request("GET"));
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { message: string }).message).toContain("only the dashboard reads this");
  });
});
