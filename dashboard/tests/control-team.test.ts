import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import type { SessionReader } from "../src/routes";
import { createTokens } from "../src/secrets/tokens";
import type { ControlSteward } from "../src/control/client";
import { createControlStore } from "../src/control/store";
import { createTeamRoutes, NOT_AVAILABLE_REASON } from "../src/control/team";

/**
 * The Team page's routes, with a simulated steward: what the dashboard checks
 * before relaying (origin, session, unlock), what it records (the audit), and
 * what it says when the steward does not carry the routes yet.
 */

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const SESSION = "session-hash";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const view = { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", createdAt: 1, expiresAt: null, revokedAt: null, lastUsedAt: null, scope: { slugs: [], create: true, outbound: false, domain: false, public: false }, owned: [] };

function setup(options: { signedIn?: boolean; old?: boolean; stewardLocked?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "control-team-"));
  toClean.push(root);
  const store = createControlStore(openDatabase(join(root, "dashboard.db")));
  const tokens = createTokens();
  const sent: unknown[] = [];
  const old = () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
  const steward = {
    listTokens: async () => (options.old ? old() : Response.json({ tokens: [view] })),
    createToken: async (requested: unknown) => {
      sent.push(requested);
      if (options.stewardLocked) return Response.json({ error: "locked", message: "locked, unlock again" }, { status: 401 });
      return Response.json({ token: view, secret: "sst_the-value-shown-once" }, { status: 201 });
    },
    revokeToken: async () => Response.json({ token: { ...view, revokedAt: 5 } }),
  } as unknown as ControlSteward;
  const session: SessionReader = async () => (options.signedIn === false ? null : { hash: SESSION, createdAt: 0, seenAt: 0, identity: "owner" });
  const routes = createTeamRoutes({ session, publicUrl: PUBLIC_URL, steward, tokens, store });
  return { routes, tokens, store, sent };
}

const post = (path: string, body: unknown, origin = PUBLIC_URL) =>
  new Request(`http://127.0.0.1:3022${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });

const REQUEST = { label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: view.scope };

describe("the Team page's routes", () => {
  test("the list needs a session, and says when the steward is too old", async () => {
    expect((await setup({ signedIn: false }).routes.team(new Request("http://x/api/tokens"))).status).toBe(401);
    expect(await (await setup().routes.team(new Request("http://x/api/tokens"))).json()).toMatchObject({ available: true, tokens: [view], until: null });
    expect(await (await setup({ old: true }).routes.team(new Request("http://x/api/tokens"))).json()).toMatchObject({ available: false, reason: NOT_AVAILABLE_REASON });
  });

  test("creating: the exact origin, a session, the dashboard unlocked", async () => {
    const s = setup();
    expect((await s.routes.createToken(post("/api/tokens", REQUEST, "https://evil.test-zone.invalid"))).status).toBe(403);
    expect((await s.routes.createToken(post("/api/tokens", REQUEST))).status).toBe(423);
    expect(s.sent).toEqual([]);

    s.tokens.set(SESSION, { token: "unlock-token", expiresAt: Date.now() + 60_000 });
    const response = await s.routes.createToken(post("/api/tokens", REQUEST));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ token: view, secret: "sst_the-value-shown-once" });
    expect(s.sent).toEqual([{ token: "unlock-token", ...REQUEST }]);
    const [entry] = s.store.listAudit(5);
    expect(entry).toMatchObject({ actor: "owner", action: "token.create", detail: { id: view.id, email: view.email } });
    expect(JSON.stringify(entry)).not.toContain("sst_");
  });

  test("an unlock the steward forgot is forgotten here too", async () => {
    const s = setup({ stewardLocked: true });
    s.tokens.set(SESSION, { token: "stale", expiresAt: Date.now() + 60_000 });
    expect((await s.routes.createToken(post("/api/tokens", REQUEST))).status).toBe(423);
    expect(s.tokens.read(SESSION)).toBeNull();
  });

  test("revoking needs a session and the origin, not the unlock, and is audited", async () => {
    const s = setup();
    expect((await s.routes.revokeToken(post("/api/tokens/revoke", { id: view.id }, "null"))).status).toBe(403);
    const response = await s.routes.revokeToken(post("/api/tokens/revoke", { id: view.id }));
    expect(response.status).toBe(200);
    expect(s.store.listAudit(5)[0]).toMatchObject({ actor: "owner", action: "token.revoke", detail: { id: view.id } });
  });

  test("what the Activity page reads of a creation and a revocation carries neither the token nor the unlock", async () => {
    const s = setup();
    s.tokens.set(SESSION, { token: "unlock-token-never-audited", expiresAt: Date.now() + 60_000 });
    expect((await s.routes.createToken(post("/api/tokens", REQUEST))).status).toBe(201);
    expect((await s.routes.revokeToken(post("/api/tokens/revoke", { id: view.id }))).status).toBe(200);
    const rows = s.store.readAudit(null, 10);
    expect(rows.map((row) => row.action)).toEqual(["token.revoke", "token.create"]);
    const handed = JSON.stringify(rows);
    for (const value of ["sst_the-value-shown-once", "the-value-shown-once", "unlock-token-never-audited"]) expect(handed).not.toContain(value);
  });
});
