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
import type { TeamPageResponse } from "../src/control/protocol";
import { createMemberRelay, TOKENS_OUTDATED } from "../src/people/relay";
import type { IdentityResolver } from "../src/people/identity";

/**
 * The Team page's routes, with a simulated steward: what the dashboard checks
 * before relaying (origin, session, unlock), what it records (the audit), and
 * what it says when the steward does not carry the routes yet. The list is
 * the tokens alone: what they did is Activity's.
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

const REQUEST = { label: "Ada", holder: "owner", expiresAt: null, scope: view.scope };

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

// --- The tokens alone -----------------------------------------------------------------

const ADAS = "bbbbbbbbbbbb";
const ADA = "ada@test-zone.invalid";

describe("the list is the tokens alone", () => {
  test("the owner's page: the tokens and the unlock, nothing the page would not show", async () => {
    const s = setup();
    s.store.recordAudit({ at: 1, actor: "owner", action: "token.create", target: null, detail: { id: view.id } });
    const keys = async (routes: ReturnType<typeof setup>["routes"]) => Object.keys((await (await routes.team(new Request("http://x/api/tokens"))).json()) as object).sort();
    expect(await keys(s.routes)).toEqual(["available", "member", "reason", "tokens", "until"]);
    expect(await keys(setup({ old: true }).routes)).toEqual(["available", "member", "reason", "tokens", "until"]);
  });

  describe("a person's page", () => {
    const own = { ...view, id: ADAS, email: ADA, member: ADA, by: ADA };

    function relay(options: { old?: boolean } = {}) {
      const resolve = Object.assign(
        (async () => ({
          session: { hash: "ada-session-hash", createdAt: 0, seenAt: 0, identity: ADA },
          token: "ada-session",
          identity: { kind: "person", email: ADA, name: null, roles: { shop: "developer" }, create: false, expiresAt: 1_800_000_000_000 },
        })) as IdentityResolver,
        { forget: () => undefined },
      );
      const steward = {
        act: async (_method: string, path: string) => {
          if (options.old) return Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
          if (path !== "/tokens/person/list") return Response.json({ error: "not-found", message: "unexpected" }, { status: 404 });
          return Response.json({ tokens: [own], rights: { roles: { shop: "developer" }, create: false } });
        },
        lock: async () => new Response(null, { status: 204 }),
      };
      const unreachable = async () => Response.json({ error: "failure", message: "not in this test" }, { status: 500 });
      return createMemberRelay({
        publicUrl: PUBLIC_URL,
        resolve,
        closeSession: () => undefined,
        steward,
        tokens: createTokens(),
        secrets: { readLog: unreachable },
        backups: { readBackups: unreachable, readBackupAudit: unreachable },
      });
    }

    test("their own tokens and their rights, the journal never read for it", async () => {
      const page = (await (await relay().team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
      expect(page.tokens.map((token) => token.id)).toEqual([ADAS]);
      expect(page.member).toEqual({ email: ADA, roles: { shop: "developer" }, create: false });
      expect(Object.keys(page).sort()).toEqual(["available", "member", "reason", "tokens", "until"]);
    });

    test("a steward that predates personal tokens is said", async () => {
      const page = (await (await relay({ old: true }).team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
      expect(page).toMatchObject({ available: false, reason: TOKENS_OUTDATED, tokens: [] });
    });
  });
});
