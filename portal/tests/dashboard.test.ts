import { describe, expect, test } from "bun:test";
import { DASHBOARD_AUDIENCE, generateKeyPair, verifyAssertion } from "../src/assertion";
import { createDashboardAdmin, dashboardOrigin } from "../src/dashboard";
import { deriveKey } from "../src/gate";
import { bindingHash, drawBinding, handoffStore, readFlow, type HandoffStore } from "../src/handoff";
import type { Settings } from "../src/oidc";
import { memoryAudit } from "./memory";

/**
 * The two admin routes the dashboard calls on either side of the provider,
 * judged without a server: the flow they seal, the code they redeem, and every
 * refusal in between. The whole road, through real HTTP and a provider, is in
 * sso.test.ts.
 */

const KEY = deriveKey(new Uint8Array(32).fill(7), "$argon2id$sample")!;
const NOW = 1_800_000_000_000;
const ORIGIN = "https://dashboard.test-zone.invalid";
const HOST = "dashboard.test-zone.invalid";
const SETTINGS: Settings = {
  issuer: "https://login.test-zone.invalid",
  clientId: "client",
  clientSecret: "secret",
  allowedDomains: ["acme.test"],
  admins: [],
  providerName: "Acme",
  redirectUri: "https://portal.test-zone.invalid/oidc/callback",
  portalOrigin: "https://portal.test-zone.invalid",
};

const pair = await generateKeyPair();

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3026/admin/dashboard/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function admin(overrides: Partial<Parameters<typeof createDashboardAdmin>[0]> = {}, handoffs: HandoffStore = handoffStore()) {
  const audit = memoryAudit();
  const routes = createDashboardAdmin({ key: KEY, settings: SETTINGS, origin: ORIGIN, handoffs, audit, readKey: () => pair.privateKey, ...overrides }, () => NOW);
  return { routes, audit, handoffs };
}

/** A code minted for the dashboard, as the callback would. */
function mint(handoffs: HandoffStore, binding: string, email = "alice@acme.test", audience: "site" | "dashboard" = "dashboard", reauth = false): string {
  const minting = handoffs.mint(
    { host: HOST, binding: bindingHash(binding), identity: { email, name: "Alice" }, returnTo: "/", sessionExpiry: NOW / 1000 + 3600, authTime: NOW / 1000 - 60, audience, reauth },
    NOW,
  );
  if ("refusal" in minting) throw new Error(minting.refusal);
  return minting.code;
}

describe("the dashboard's address", () => {
  test("follows from the portal's", () => {
    expect(dashboardOrigin("https://portal.test-zone.invalid", undefined)).toBe(ORIGIN);
    expect(dashboardOrigin("https://portal.test-zone.invalid/", "")).toBe(ORIGIN);
  });

  test("is unknown for a portal elsewhere, unless named", () => {
    expect(dashboardOrigin("https://doors.test-zone.invalid", undefined)).toBeNull();
    expect(dashboardOrigin("", undefined)).toBeNull();
    expect(dashboardOrigin("https://doors.test-zone.invalid", "https://board.test-zone.invalid/x")).toBe("https://board.test-zone.invalid");
    expect(dashboardOrigin("https://portal.test-zone.invalid", "http://board.test-zone.invalid")).toBeNull();
  });
});

describe("POST /admin/dashboard/flow", () => {
  test("seals a flow for the dashboard's host around the dashboard's binding", async () => {
    const binding = drawBinding();
    const response = await admin().routes.flow(post({ binding, returnTo: "/site/?s=blog", chooseAccount: false }));
    expect(response.status).toBe(200);
    const start = new URL(((await response.json()) as { start: string }).start);
    expect(start.origin + start.pathname).toBe("https://portal.test-zone.invalid/oidc/start");
    const flow = readFlow(KEY, start.searchParams.get("flow"), NOW / 1000);
    expect(flow).toEqual({ host: HOST, returnTo: "/site/?s=blog", binding: bindingHash(binding), chooseAccount: false, audience: "dashboard", reauth: false });
  });

  test("a return path that leads elsewhere comes back home", async () => {
    const response = await admin().routes.flow(post({ binding: drawBinding(), returnTo: "//evil.test" }));
    const start = new URL(((await response.json()) as { start: string }).start);
    expect(readFlow(KEY, start.searchParams.get("flow"), NOW / 1000)?.returnTo).toBe("/");
  });

  test("refuses a binding of the wrong shape, a request Caddy relayed, and a portal with nothing to offer", async () => {
    expect((await admin().routes.flow(post({ binding: "short" }))).status).toBe(400);
    expect((await admin().routes.flow(post({ binding: drawBinding() }, { "X-Forwarded-For": "203.0.113.9" }))).status).toBe(403);
    expect((await admin({ settings: null }).routes.flow(post({ binding: drawBinding() }))).status).toBe(404);
    expect((await admin({ origin: null }).routes.flow(post({ binding: drawBinding() }))).status).toBe(404);
    expect((await admin({ key: null }).routes.flow(post({ binding: drawBinding() }))).status).toBe(404);
  });
});

describe("POST /admin/dashboard/redeem", () => {
  test("hands over an assertion the steward can verify, once", async () => {
    const { routes, handoffs } = admin();
    const binding = drawBinding();
    const code = mint(handoffs, binding);
    const response = await routes.redeem(post({ code, binding }));
    expect(response.status).toBe(200);
    const { assertion, returnTo } = (await response.json()) as { assertion: string; returnTo: string };
    expect(returnTo).toBe("/");
    const reading = await verifyAssertion(assertion, pair.publicKey, { audience: DASHBOARD_AUDIENCE, nowS: NOW / 1000 });
    expect("claims" in reading && reading.claims).toMatchObject({ email: "alice@acme.test", name: "Alice", auth_time: NOW / 1000 - 60 });

    const replay = await routes.redeem(post({ code, binding }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "unknown-code" });
  });

  test("another browser's binding burns the code, and is recorded", async () => {
    const { routes, handoffs, audit } = admin();
    const code = mint(handoffs, drawBinding());
    const response = await routes.redeem(post({ code, binding: drawBinding() }));
    expect(await response.json()).toMatchObject({ error: "wrong-browser" });
    expect(audit.events.at(-1)).toMatchObject({ action: "portal.signin_failed", target: HOST, detail: { reason: "wrong-browser" } });
  });

  test("a site's code is never redeemed for an assertion", async () => {
    const { routes, handoffs } = admin();
    const binding = drawBinding();
    const code = mint(handoffs, binding, "alice@acme.test", "site");
    expect(await (await routes.redeem(post({ code, binding }))).json()).toMatchObject({ error: "wrong-audience" });
  });

  test("an address taken off the allowed domains since is refused", async () => {
    const { routes, handoffs, audit } = admin();
    const binding = drawBinding();
    const code = mint(handoffs, binding, "eve@elsewhere.test");
    const response = await routes.redeem(post({ code, binding }));
    expect(response.status).toBe(403);
    expect(audit.events.at(-1)).toMatchObject({ actor: "eve@elsewhere.test", detail: { reason: "domain-not-allowed" } });
  });

  test("without the steward's key, nothing is signed", async () => {
    const { routes, handoffs } = admin({ readKey: () => null });
    const binding = drawBinding();
    const response = await routes.redeem(post({ code: mint(handoffs, binding), binding }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "no-key" });
  });

  test("refuses a request Caddy relayed", async () => {
    const { routes } = admin();
    expect((await routes.redeem(post({ code: "x", binding: "y" }, { "X-Portal-Hote": HOST }))).status).toBe(403);
  });
});
