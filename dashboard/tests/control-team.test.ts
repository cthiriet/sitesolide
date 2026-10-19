import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import type { SessionReader } from "../src/routes";
import { createTokens } from "../src/secrets/tokens";
import type { ControlSteward } from "../src/control/client";
import { createControlStore } from "../src/control/store";
import { createTeamRoutes, NOT_AVAILABLE_REASON, WORK_ENTRIES, WORK_ROWS } from "../src/control/team";
import type { TeamPageResponse } from "../src/control/protocol";
import { createMemberRelay, TOKENS_OUTDATED } from "../src/people/relay";
import type { IdentityResolver } from "../src/people/identity";
import type { LogEntry } from "../src/secrets/protocol";

/**
 * The Team page's routes, with a simulated steward: what the dashboard checks
 * before relaying (origin, session, unlock), what it records (the audit), and
 * what it says when the steward does not carry the routes yet. Token
 * activity: what tokens did through the steward, read from its journal, a
 * person's own tokens' alone.
 */

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const SESSION = "session-hash";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const view = { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", createdAt: 1, expiresAt: null, revokedAt: null, lastUsedAt: null, scope: { slugs: [], create: true, outbound: false, domain: false, public: false }, owned: [] };

/** The steward's journal as `GET /log` answers it, newest first. */
type Journal = { entries: unknown[] } | "mute";

function journalOf(journal: Journal, asked: unknown[] = []) {
  return {
    readLog: async (...args: unknown[]) => {
      asked.push(args);
      if (journal === "mute") throw new Error("the steward did not answer");
      return Response.json(journal);
    },
  };
}

function setup(options: { signedIn?: boolean; old?: boolean; stewardLocked?: boolean; journal?: Journal } = {}) {
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
  const asked: unknown[] = [];
  const journal = journalOf(options.journal ?? { entries: [] }, asked);
  const routes = createTeamRoutes({ session, publicUrl: PUBLIC_URL, steward, tokens, store, journal });
  return { routes, tokens, store, sent, asked };
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

// --- Token activity ----------------------------------------------------------------

const AT = 1_800_000_000_000;
const OWNERS = "aaaaaaaaaaaa";
const ADAS = "bbbbbbbbbbbb";
const ZOES = "cccccccccccc";
const ADA = "ada@test-zone.invalid";

function line(a: number, partial: Partial<LogEntry>): LogEntry {
  return { a, operation: "set", result: "ok", actor: "owner", member: null, slug: "cms", file: "cms.env", variable: null, detail: null, ...partial };
}

/**
 * Newest first, as the steward answers. The owner's own change and a
 * person's from their session are no token's; one line carries a field the
 * journal never writes, a value, which must not cross.
 */
const JOURNAL: LogEntry[] = [
  line(AT + 6000, { operation: "restart", actor: `token:${OWNERS}`, file: null, detail: "active, active/running, 0 restarts" }),
  line(AT + 5000, { actor: "owner", variable: "SMTP_URL" }),
  line(AT + 4000, { actor: `token:${ZOES}`, member: "zoe@test-zone.invalid", slug: "blog", file: "blog.env", variable: "ZOE_KEY" }),
  line(AT + 3000, { result: "rejects", actor: `token:${ADAS}`, member: ADA, slug: "shop", file: "shop.env", detail: "role viewer" }),
  { ...line(AT + 2000, { actor: `token:${OWNERS}`, variable: "API_KEY" }), value: "hunter2-never-shown" } as LogEntry,
  line(AT + 1000, { actor: ADA, member: ADA, slug: "shop", file: "shop.env", variable: "SESSION_SECRET" }),
];

describe("Token activity", () => {
  test("the owner's page carries what every token did through the steward, newest first, in the Activity page's shape", async () => {
    const s = setup({ journal: { entries: JOURNAL } });
    const page = (await (await s.routes.team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
    expect(s.asked).toEqual([[null, { limit: WORK_ENTRIES, before: null }]]);
    expect(page.work).toEqual([
      {
        id: `steward:${AT + 6000}.0`,
        source: "steward",
        at: new Date(AT + 6000).toISOString(),
        actor: `token:${OWNERS}`,
        action: "service.restart",
        target: "cms",
        site: null,
        detail: { result: "ok", note: "active, active/running, 0 restarts" },
      },
      expect.objectContaining({ actor: `token:${ZOES}`, action: "secrets.set", target: "blog", detail: { result: "ok", file: "blog.env", variable: "ZOE_KEY", member: "zoe@test-zone.invalid" } }),
      expect.objectContaining({ actor: `token:${ADAS}`, action: "secrets.set", target: "shop", detail: { result: "rejects", file: "shop.env", note: "role viewer", member: ADA } }),
      expect.objectContaining({ actor: `token:${OWNERS}`, action: "secrets.set", target: "cms", detail: { result: "ok", file: "cms.env", variable: "API_KEY" } }),
    ]);
    expect(JSON.stringify(page)).not.toContain("hunter2-never-shown");
    // The dashboard's own audit is still there beside it.
    expect(page.audit).toEqual([]);
  });

  test("a journal that does not answer, or does not read, leaves the page whole, with no row of it", async () => {
    const journals: Journal[] = ["mute", { entries: "garbage" } as unknown as Journal];
    for (const journal of journals) {
      const response = await setup({ journal }).routes.team(new Request("http://x/api/tokens"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true, tokens: [view], work: [] });
    }
    // A steward too old for tokens: the page says so, and still reads its journal.
    expect(await (await setup({ old: true, journal: { entries: JOURNAL } }).routes.team(new Request("http://x/api/tokens"))).json()).toMatchObject({
      available: false,
      work: expect.arrayContaining([expect.objectContaining({ actor: `token:${OWNERS}` })]),
    });
  });

  test("the latest rows alone, however many lines the tokens wrote", async () => {
    const many = Array.from({ length: WORK_ROWS + 10 }, (_, index) => line(AT - index, { actor: `token:${OWNERS}`, variable: `NAME_${index}` }));
    const page = (await (await setup({ journal: { entries: many } }).routes.team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
    expect(page.work).toHaveLength(WORK_ROWS);
    expect(page.work[0]?.detail?.variable).toBe("NAME_0");
  });

  describe("a person's page", () => {
    const own = { ...view, id: ADAS, email: ADA, member: ADA, by: ADA };

    function relay(journal: Journal, options: { old?: boolean } = {}) {
      const root = mkdtempSync(join(tmpdir(), "control-team-"));
      toClean.push(root);
      const resolve = Object.assign(
        (async () => ({
          session: { hash: "ada-session-hash", createdAt: 0, seenAt: 0, identity: ADA },
          token: "ada-session",
          identity: { kind: "person", email: ADA, name: null, roles: { shop: "developer" }, create: false, expiresAt: AT },
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
        secrets: journalOf(journal),
        backups: { readBackups: unreachable, readBackupAudit: unreachable },
        control: createControlStore(openDatabase(join(root, "dashboard.db"))),
      });
    }

    test("their own tokens' rows alone: never the owner's tokens nor another person's", async () => {
      const page = (await (await relay({ entries: JOURNAL }).team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
      expect(page.tokens.map((token) => token.id)).toEqual([ADAS]);
      expect(page.work.map((row) => [row.actor, row.action, row.target])).toEqual([[`token:${ADAS}`, "secrets.set", "shop"]]);
      const handed = JSON.stringify(page);
      for (const other of [OWNERS, ZOES, "API_KEY", "ZOE_KEY", "SESSION_SECRET", "SMTP_URL"]) expect(handed).not.toContain(other);
    });

    test("kept to their ids before the rows are counted: other tokens' newer lines do not push theirs out", async () => {
      const busy = Array.from({ length: WORK_ROWS + 10 }, (_, index) => line(AT + 100 - index, { actor: `token:${OWNERS}`, variable: `NAME_${index}` }));
      const entries = [...busy, line(AT, { actor: `token:${ADAS}`, member: ADA, slug: "shop", file: "shop.env", variable: "ADA_KEY" })];
      const page = (await (await relay({ entries }).team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
      expect(page.work.map((row) => row.detail?.variable)).toEqual(["ADA_KEY"]);
    });

    test("a steward that predates personal tokens: no row, whatever the journal holds", async () => {
      const page = (await (await relay({ entries: JOURNAL }, { old: true }).team(new Request("http://x/api/tokens"))).json()) as TeamPageResponse;
      expect(page).toMatchObject({ available: false, reason: TOKENS_OUTDATED, work: [] });
    });
  });
});
