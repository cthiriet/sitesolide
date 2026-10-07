import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReaders, MAX_ANSWER_BYTES, STEWARD_WINDOW, type AuditDependencies } from "../src/audit/sources";
import { createAuditRoutes } from "../src/audit/routes";
import type { ReaderResult } from "../src/audit/aggregate";
import type { AuditResponse } from "../src/audit/protocol";
import { AUDIT_ENTRIES } from "../src/backup/routes";
import { localBackupSteward } from "../src/backup/client";
import { localConnectorsSteward, localEgress } from "../src/connectors/client";
import { createControlStore } from "../src/control/store";
import { openDatabase } from "../src/database";
import type { SessionReader } from "../src/routes";
import { localSteward } from "../src/secrets/client";
import { latest, page, RETURNED_ENTRIES } from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";
import { aggregate } from "../src/audit/aggregate";
import { readQuery, siteResolver } from "../src/audit/merge";
import { localPortalAudit } from "../src/portal-audit";
import type { Raw } from "../src/state";

/**
 * Each source read as the dashboard reaches it, judged on what it answers:
 * rows in the shared shape, or one of the three states that say why not. Then
 * the whole route, against a portal and an egress proxy on real ports and a
 * steward on a real Unix socket.
 */

const T = Date.UTC(2026, 9, 4, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const root = mkdtempSync(join(tmpdir(), "audit-sources-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
const refuse = () => Promise.reject(new TypeError("connection refused"));

function store() {
  return createControlStore(openDatabase(join(mkdtempSync(join(root, "db-")), "dashboard.db")));
}

/** Every dependency answering an empty audit, each test replacing what it judges. */
function dependencies(partial: Partial<AuditDependencies> = {}): AuditDependencies {
  return {
    store: store(),
    portal: { audit: () => json({ events: [] }) },
    egress: { audit: () => json({ rows: [] }) },
    steward: { readLog: () => json({ entries: [] }) },
    backups: { readBackupAudit: () => json({ entries: [] }), readBackups: () => json({ backups: { installed: true } }) },
    connectors: { read: () => json({ installed: true, connectors: [], grants: [] }) },
    portalDeployed: async () => true,
    ...partial,
  };
}

const failure = (result: ReaderResult) => (result.kind === "failed" ? { state: result.state, message: result.message } : null);

describe("the dashboard's own audit", () => {
  test("read by id, newest first, its detail decoded", async () => {
    const control = store();
    for (let index = 0; index < 3; index++) {
      control.recordAudit({ at: T + index, actor: "owner", action: "token.create", target: null, detail: { id: `t${index}` } });
    }
    const reader = createReaders(dependencies({ store: control })).dashboard;
    const first = await reader.read(null, 2);
    expect(first).toMatchObject({ kind: "rows", end: false });
    if (first.kind !== "rows") throw new Error("no rows");
    expect(first.rows.map((row) => [row.row.id, row.row.detail])).toEqual([
      ["dashboard:3", { id: "t2" }],
      ["dashboard:2", { id: "t1" }],
    ]);
    const second = await reader.read(first.rows[1]!.position, 2);
    expect(second).toMatchObject({ kind: "rows", end: true });
    expect(second.kind === "rows" && second.rows.map((row) => row.row.id)).toEqual(["dashboard:1"]);
  });

  test("a database that throws is a source unavailable", async () => {
    const reader = createReaders(dependencies({ store: { readAudit: () => { throw new Error("SQLITE_BUSY"); } } })).dashboard;
    expect(failure(await reader.read(null, 10))).toEqual({ state: "unavailable", message: "The dashboard's database could not be read." });
  });
});

describe("the portal", () => {
  const event = { id: 5, at: iso(T), actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", detail: { method: "oidc", role: "member" } };

  test("asked by pages of at most five hundred, after the last id read", async () => {
    const asked: [number, number | null][] = [];
    const reader = createReaders(dependencies({ portal: { audit: (limit, before) => (asked.push([limit, before]), json({ events: [event] })) } })).portal;
    const result = await reader.read([9, 0], 1000);
    expect(asked).toEqual([[500, 9]]);
    expect(result).toMatchObject({ kind: "rows", end: true, window: null });
    expect(result.kind === "rows" && result.rows[0]!.row).toEqual({ ...event, id: "portal:5", source: "portal" });
  });

  test("down, or never deployed, as the snapshot says", async () => {
    expect(failure(await createReaders(dependencies({ portal: { audit: refuse } })).portal.read(null, 10))).toEqual({ state: "unavailable", message: "Can't reach the portal." });
    expect(failure(await createReaders(dependencies({ portal: { audit: refuse }, portalDeployed: async () => null })).portal.read(null, 10))?.state).toBe("unavailable");
    expect(failure(await createReaders(dependencies({ portal: { audit: refuse }, portalDeployed: async () => false })).portal.read(null, 10))).toEqual({
      state: "not-installed",
      message: "The portal isn't deployed on this server.",
    });
  });

  test("an older portal, which answers its plain 404, is outdated", async () => {
    const reader = createReaders(dependencies({ portal: { audit: () => Promise.resolve(new Response("404: unknown route", { status: 404 })) } })).portal;
    expect(failure(await reader.read(null, 10))?.state).toBe("outdated");
  });

  test("garbage is a source unavailable, never a crash", async () => {
    for (const answer of [
      () => Promise.resolve(new Response("<html>", { status: 200 })),
      () => json({ events: "many" }),
      () => json({ events: [{ id: "x" }, null, 3] }),
      () => json([1, 2]),
      () => json({ error: "relayed-request" }, 403),
    ]) {
      const result = await createReaders(dependencies({ portal: { audit: answer } })).portal.read(null, 10);
      expect(failure(result)?.state).toBe("unavailable");
    }
  });

  test("an answer larger than any page is refused while it streams", async () => {
    const huge = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
    });
    const reader = createReaders(dependencies({ portal: { audit: () => Promise.resolve(new Response(huge)) } })).portal;
    expect(failure(await reader.read(null, 10))).toEqual({ state: "unavailable", message: "The portal sent an unreadable answer." });
    expect(MAX_ANSWER_BYTES).toBe(4 * 1024 * 1024);
  });

  test("the rows that read are kept, those that do not are left out", async () => {
    const reader = createReaders(dependencies({ portal: { audit: () => json({ events: [event, { id: -1 }] }) } })).portal;
    const result = await reader.read(null, 10);
    expect(result.kind === "rows" && result.rows.map((row) => row.row.id)).toEqual(["portal:5"]);
  });
});

describe("the egress proxy", () => {
  test("asked after the last id read, its text detail decoded", async () => {
    const asked: [number, number | null | undefined][] = [];
    const egress = {
      audit: (limit: number, before?: number | null) => (
        asked.push([limit, before]), json({ rows: [{ id: 3, at: iso(T), actor: "system", action: "egress.denied", target: "shop", detail: '{"destination":"pastebin.invalid:443","count":2}' }] })
      ),
    };
    const result = await createReaders(dependencies({ egress })).egress.read([4, 0], 100);
    expect(asked).toEqual([[100, 4]]);
    expect(result.kind === "rows" && result.rows[0]!.row.detail).toEqual({ destination: "pastebin.invalid:443", count: 2 });
  });

  test("down, or not installed, as the steward says", async () => {
    expect(failure(await createReaders(dependencies({ egress: { audit: refuse } })).egress.read(null, 10))).toEqual({ state: "unavailable", message: "Can't reach the egress proxy." });
    const absent = dependencies({ egress: { audit: refuse }, connectors: { read: () => json({ installed: false, connectors: [], grants: [] }) } });
    expect(failure(await createReaders(absent).egress.read(null, 10))).toEqual({ state: "not-installed", message: "The egress proxy isn't installed on this server." });
    const stewardDown = dependencies({ egress: { audit: refuse }, connectors: { read: refuse } });
    expect(failure(await createReaders(stewardDown).egress.read(null, 10))?.state).toBe("unavailable");
  });

  test("its refusal is quoted", async () => {
    const reader = createReaders(dependencies({ egress: { audit: () => json({ error: "refused", message: "only the dashboard reads this" }, 403) } })).egress;
    expect(failure(await reader.read(null, 10))).toEqual({ state: "unavailable", message: "The egress proxy refused the dashboard: only the dashboard reads this." });
  });
});

describe("the backups", () => {
  const entries = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: count - index, at: iso(T - index * 3_600_000), actor: "system", action: "backup.run", target: null, detail: { ok: true } }));

  test("the latest fifty, after the position read, and the window said once they are read", async () => {
    const reader = createReaders(dependencies({ backups: { readBackupAudit: () => json({ entries: entries(50) }), readBackups: () => json({}) } })).backups;
    const result = await reader.read([40, 0], 100);
    expect(result).toMatchObject({ kind: "rows", end: true, window: STEWARD_WINDOW });
    expect(result.kind === "rows" && result.rows.map((row) => row.row.id)).toEqual(Array.from({ length: 39 }, (_, index) => `backups:${39 - index}`));
    const few = await createReaders(dependencies({ backups: { readBackupAudit: () => json({ entries: entries(3) }), readBackups: () => json({}) } })).backups.read(null, 2);
    expect(few).toMatchObject({ kind: "rows", end: false, window: null });
  });

  test("not set up, as the view of the dashboard's own site says; merely empty otherwise", async () => {
    const absent = dependencies({ backups: { readBackupAudit: () => json({ entries: [] }), readBackups: (slug) => json({ backups: { slug, installed: false } }) } });
    expect(failure(await createReaders(absent).backups.read(null, 10))?.state).toBe("not-installed");
    const empty = await createReaders(dependencies()).backups.read(null, 10);
    expect(empty).toEqual({ kind: "rows", rows: [], end: true, window: null });
  });

  test("a steward from before the backups answers `no such route`: outdated", async () => {
    const old = dependencies({ backups: { readBackupAudit: () => json({ error: "not-found", message: "no such route" }, 404), readBackups: () => json({}) } });
    expect(failure(await createReaders(old).backups.read(null, 10))).toEqual({ state: "outdated", message: "The steward on this server predates backups. Run sitesolide upgrade." });
  });

  test("a steward that cannot be reached is unavailable", async () => {
    expect(failure(await createReaders(dependencies({ backups: { readBackupAudit: refuse, readBackups: refuse } })).backups.read(null, 10))).toEqual({
      state: "unavailable",
      message: "Can't reach the steward.",
    });
  });
});

describe("the steward's journal", () => {
  test("its latest entries, as rows, after the position read", async () => {
    const log = [
      { a: T, operation: "restart", result: "ok", slug: "cms", file: null, variable: null, detail: "active" },
      { a: T, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "TOKEN", detail: null },
      { a: T - 5, operation: "unlock", result: "ok", slug: null, file: null, variable: null, detail: null },
    ];
    const reader = createReaders(dependencies({ steward: { readLog: () => json({ entries: log }) } })).steward;
    const result = await reader.read([T, 0], 10);
    expect(result.kind === "rows" && result.rows.map((row) => [row.row.action, row.row.target])).toEqual([
      ["secrets.set", "cms"],
      ["secrets.unlock", null],
    ]);
  });

  test("lines appended after the clock was set back are read whole, in the order of time", async () => {
    const log = [
      { a: T - 10, operation: "lock", result: "ok", slug: null, file: null, variable: null, detail: null },
      // Appended after the line above, but the clock had gone back in between.
      { a: T + 50, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "TOKEN", detail: null },
      { a: T, operation: "unlock", result: "ok", slug: null, file: null, variable: null, detail: null },
    ];
    const reader = createReaders(dependencies({ steward: { readLog: () => json({ entries: log }) } })).steward;
    const all = await reader.read(null, 10);
    expect(all.kind === "rows" && all.rows.map((row) => row.row.action)).toEqual(["secrets.set", "secrets.unlock", "secrets.lock"]);
    const rest = await reader.read([T + 50, 0], 10);
    expect(rest.kind === "rows" && rest.rows.map((row) => row.row.action)).toEqual(["secrets.unlock", "secrets.lock"]);
  });

  test("garbage, or a refusal, is unavailable", async () => {
    for (const readLog of [() => json({ entries: [{ a: "soon" }] }), () => json({ nothing: true }), () => json({ error: "failure", message: "disk full" }, 500)]) {
      expect(failure(await createReaders(dependencies({ steward: { readLog } })).steward.read(null, 10))?.state).toBe("unavailable");
    }
  });

  test("the window is the steward's: its two routes still hand over fifty", () => {
    expect(STEWARD_WINDOW).toBe(RETURNED_ENTRIES);
    expect(STEWARD_WINDOW).toBe(AUDIT_ENTRIES);
  });
});

// --- A steward that pages --------------------------------------------------------

describe("a steward updated since the Activity page: both its audits read whole", () => {
  /** Every page of one source, through the aggregation, as the page would follow them. */
  async function everything(readers: ReturnType<typeof createReaders>, source: "steward" | "backups") {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 200; pages++) {
      const query = readQuery(new URLSearchParams(`source=${source}&limit=7`));
      if ("error" in query) throw new Error(query.error);
      const answer = await aggregate({ ...query, cursor }, readers, siteResolver(null, "test-zone.invalid"), { fetchSize: 10, maxFetches: 2, deadlineMs: 5_000 });
      if ("error" in answer) throw new Error(answer.error);
      expect(answer.sources.every((status) => status.window === null)).toBe(true);
      seen.push(...answer.rows.map((row) => row.id));
      cursor = answer.cursor;
      if (cursor === null) return seen;
    }
    throw new Error("the cursor does not end");
  }

  test("the journal, past its latest fifty, every line once, lines of one millisecond included", async () => {
    // 120 lines, three to a millisecond every fourth one: page boundaries fall inside them.
    const log: LogEntry[] = [];
    for (let index = 0; index < 120; index++) {
      const a = T - Math.floor(index / 3) * 1000;
      log.unshift({ a, operation: "read", result: "ok", actor: "owner", member: null, slug: "cms", file: "cms.env", variable: `V${index}`, detail: null });
    }
    const asked: (string | null)[] = [];
    const steward = {
      readLog: (_slug: string | null, wanted?: { limit: number; before: number | null }) => {
        asked.push(wanted === undefined ? null : `${wanted.limit}/${wanted.before}`);
        return wanted === undefined ? json({ entries: latest(log) }) : json({ entries: page(log, wanted), paged: true });
      },
    };
    const seen = await everything(createReaders(dependencies({ steward })), "steward");
    expect(seen.length).toBe(120);
    expect(new Set(seen).size).toBe(120);
    expect(asked[0]).toBe("10/null");
  });

  test("the backups' audit, past its latest fifty", async () => {
    const entries = Array.from({ length: 130 }, (_, index) => ({ id: 130 - index, at: iso(T - index * 3_600_000), actor: "system", action: "backup.run", target: null, detail: { ok: true } }));
    const backups = {
      readBackupAudit: (_slug: string | null, wanted?: { limit: number; before: number | null }) =>
        wanted === undefined
          ? json({ entries: entries.slice(0, 50) })
          : json({ entries: entries.filter((entry) => entry.id < (wanted.before ?? Infinity)).slice(0, wanted.limit), paged: true }),
      readBackups: () => json({ backups: { installed: true } }),
    };
    const seen = await everything(createReaders(dependencies({ backups })), "backups");
    expect(seen).toEqual(entries.map((entry) => `backups:${entry.id}`));
  });

  test("an older steward, which ignores the page asked for, is read as its latest fifty", async () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({ id: 60 - index, at: iso(T - index * 1000), actor: "system", action: "backup.run", target: null, detail: null }));
    const backups = { readBackupAudit: () => json({ entries: entries.slice(0, 50) }), readBackups: () => json({ backups: { installed: true } }) };
    const result = await createReaders(dependencies({ backups })).backups.read(null, 500);
    expect(result).toMatchObject({ kind: "rows", end: true, window: 50 });
  });
});

// --- The whole route, on real correspondents ---------------------------------------

describe("GET /api/audit, against a portal, an egress proxy and a steward that really listen", () => {
  const stateFile = join(root, "state.json");
  const raw: Raw = {
    generated: T,
    zone: "test-zone.invalid",
    folders: [
      { slug: "cms", manifest: JSON.stringify({ slug: "cms", port: 3045, start: "bun run server.ts", portal: true }), unit: null, bytes: 1, deployed: T },
      { slug: "portal", manifest: JSON.stringify({ slug: "portal", port: 3026, start: "bun run server.ts" }), unit: null, bytes: 1, deployed: T },
    ],
    codes: "{}",
    domains: null,
    ports: [],
    blocks: {},
    machine: null,
    previous: null,
  };
  writeFileSync(stateFile, JSON.stringify(raw));

  const portal = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/admin/audit": {
        GET: (req) => {
          const before = Number(new URL(req.url).searchParams.get("before") ?? Infinity);
          const events = [
            { id: 2, at: iso(T - 60_000), actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", detail: { method: "oidc" } },
            { id: 1, at: iso(T - 120_000), actor: "anonymous", action: "portal.signin_failed", target: "cms.test-zone.invalid", detail: { method: "password" } },
          ].filter((event) => event.id < before);
          return Response.json({ events });
        },
      },
    },
  });
  const socket = join(root, "steward.sock");
  const steward = Bun.serve({
    unix: socket,
    routes: {
      "/log": { GET: () => Response.json({ entries: [{ a: T - 30_000, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "SMTP_PASSWORD", detail: null }] }) },
      "/backups/audit": { GET: () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 }) },
      "/connectors": { GET: () => Response.json({ installed: false, connectors: [], grants: [] }) },
    },
    fetch: () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 }),
  });
  afterAll(() => {
    portal.stop(true);
    steward.stop(true);
  });

  const control = store();
  control.recordAudit({ at: T, actor: "token:abc", action: "deploy.success", target: "cms", detail: { email: "ada@test-zone.invalid", deployment: "d1" } });

  const signedIn: SessionReader = async (req) => (req.headers.get("cookie") === "session=yes" ? { hash: "h", createdAt: 0, seenAt: 0, identity: "owner" } : null);
  const routes = createAuditRoutes({
    session: signedIn,
    readers: createReaders({
      store: control,
      portal: localPortalAudit(`http://127.0.0.1:${portal.port}`),
      // Nothing listens there: the proxy is not installed, as the steward says.
      egress: localEgress("http://127.0.0.1:9", 1_000),
      steward: localSteward(socket),
      backups: localBackupSteward(socket),
      connectors: localConnectorsSteward(socket),
      portalDeployed: async () => true,
    }),
    stateFile,
    zone: "test-zone.invalid",
  });
  const get = (query: string, cookie = "session=yes") => routes.list(new Request(`http://127.0.0.1:3022/api/audit${query}`, { headers: { cookie } }));

  test("needs a session, and nothing more", async () => {
    const response = await get("", "session=no");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "no-session" });
  });

  test("every source, newest first, the down and the outdated said so", async () => {
    const response = await get("");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as AuditResponse;
    expect(body.rows.map((row) => [row.source, row.action, row.target, row.site])).toEqual([
      ["dashboard", "deploy.success", "cms", "cms"],
      ["steward", "secrets.set", "cms", "cms"],
      ["portal", "portal.signin", "cms.test-zone.invalid", "cms"],
      ["portal", "portal.signin_failed", "cms.test-zone.invalid", "cms"],
    ]);
    expect(body.sources.map((source) => [source.name, source.state])).toEqual([
      ["dashboard", "ok"],
      ["portal", "ok"],
      ["egress", "not-installed"],
      ["backups", "outdated"],
      ["steward", "ok"],
    ]);
    expect(body.cursor).toBeNull();
  });

  test("a site's filter finds its rows in every source, its hosts included", async () => {
    const body = (await (await get("?target=cms&action=portal.signin_failed")).json()) as AuditResponse;
    expect(body.rows.map((row) => row.id)).toEqual(["portal:1"]);
  });

  test("pages follow one another to the end", async () => {
    const first = (await (await get("?limit=3")).json()) as AuditResponse;
    expect(first.rows.length).toBe(3);
    const second = (await (await get(`?limit=3&cursor=${first.cursor}`)).json()) as AuditResponse;
    expect(second.rows.map((row) => row.id)).toEqual(["portal:1"]);
    expect(second.cursor).toBeNull();
  });

  test("a query that does not read is refused with what is wrong", async () => {
    const response = await get("?limit=9000");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", message: "limit: a whole number from 1 to 500" });
    expect((await get("?cursor=nonsense")).status).toBe(400);
  });
});
