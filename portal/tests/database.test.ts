import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AUDIT_FLOOR_MS, AUDIT_RETENTION_MS, COLLAPSE_WINDOW_MS, auditStore, openDatabase, PRAGMAS } from "../src/database";
import { DATA_DIR } from "../src/config";

// Safety rail: tests/setup.ts must have diverted DATA_DIR before any import,
// failing which these tests would write next to the portal's database.
if (!DATA_DIR.endsWith(".attempts")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const base = openDatabase(join(DATA_DIR, "base.db"));

/** Re-reads a setting applied to the connection. The returned column carries
 * varying names depending on the pragma, hence reading the first value. */
function setting(name: string): unknown {
  const row = base.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  return row === null ? null : Object.values(row)[0];
}

describe("openDatabase", () => {
  test("waits for a lock rather than returning SQLITE_BUSY", () => {
    expect(setting("busy_timeout")).toBe(10000);
  });

  test("sets the busy_timeout before switching to WAL", () => {
    expect(PRAGMAS[0]).toMatch(/^busy_timeout/);
    expect(PRAGMAS.findIndex((p) => p.startsWith("journal_mode"))).toBeGreaterThan(0);
  });

  test("journals in WAL, with a 64 MB ceiling", () => {
    expect(setting("journal_mode")).toBe("wal");
    expect(setting("journal_size_limit")).toBe(67108864);
  });

  test("commits without fsync, which WAL makes safe", () => {
    // 1 is NORMAL, 2 is FULL.
    expect(setting("synchronous")).toBe(1);
  });

  test("checks the foreign keys, which SQLite ignores by default", () => {
    expect(setting("foreign_keys")).toBe(1);
  });

  test("keeps the temporary tables and the cache in memory", () => {
    expect(setting("temp_store")).toBe(2);
    expect(setting("cache_size")).toBe(-16000);
  });

  test("refuses a query with a missing parameter", () => {
    const request = base.query<{ a: number }, { a: number }>("SELECT $a AS a");
    expect(request.get({ a: 1 })?.a).toBe(1);
    expect(() => request.get({} as { a: number })).toThrow();
  });
});

describe("the tables from before the steward kept who may open a site", () => {
  test("are no longer created, and a database that has them keeps them, untouched, beside the audit", () => {
    const fresh = openDatabase(join(DATA_DIR, "fresh.db"));
    expect(fresh.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "audit" }]);
    fresh.close();

    // A portal's database from before 0.4: its two tables, as it wrote them.
    const path = join(DATA_DIR, "from-before.db");
    const old = openDatabase(path);
    old.run("CREATE TABLE invites (id TEXT PRIMARY KEY, hote TEXT NOT NULL, libelle TEXT NOT NULL, empreinte TEXT NOT NULL UNIQUE, cree_a INTEGER NOT NULL, expire_a INTEGER, vu_a INTEGER)");
    old.run("CREATE TABLE sharing (host TEXT PRIMARY KEY, mode TEXT NOT NULL, people TEXT NOT NULL, domains TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    old.run("INSERT INTO invites (id, hote, libelle, empreinte, cree_a) VALUES ('AAAAAAAAAAAAAAA9', 'forum.test-zone.invalid', 'Alice', 'h', 1)");
    old.close();
    const db = openDatabase(path);
    expect(db.query("SELECT count(*) AS n FROM invites").get()).toEqual({ n: 1 });
    expect(auditStore(db).recent(10)).toEqual([]);
    db.close();
  });
});

describe("the audit store", () => {
  const db = openDatabase(join(DATA_DIR, "audit.db"));
  const store = auditStore(db);
  const DAY = 24 * 3600 * 1000;
  const START = Date.UTC(2026, 9, 4);

  test("has the columns every component shares", () => {
    const columns = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(audit)").all();
    expect(columns.map((column) => [column.name, column.notnull])).toEqual([
      ["id", 0],
      ["at", 1],
      ["actor", 1],
      ["action", 1],
      ["target", 0],
      ["detail", 0],
    ]);
  });

  test("records an event with its time in ISO 8601, UTC, and its detail as JSON", () => {
    store.record({ actor: "alice@acme.test", action: "portal.signin", target: "forum.test-zone.invalid", detail: { method: "oidc" } }, START);
    store.record({ actor: "owner", action: "portal.signout" }, START + 1_000);
    expect(store.recent(10)).toEqual([
      { id: 2, at: "2026-10-04T00:00:01.000Z", actor: "owner", action: "portal.signout", target: null, detail: null },
      {
        id: 1,
        at: "2026-10-04T00:00:00.000Z",
        actor: "alice@acme.test",
        action: "portal.signin",
        target: "forum.test-zone.invalid",
        detail: { method: "oidc" },
      },
    ]);
  });

  test("reads by pages, the most recent first", () => {
    for (let i = 0; i < 5; i++) store.record({ actor: "owner", action: "sharing.update" }, START + 2_000 + i);
    const first = store.recent(3);
    expect(first.map((event) => event.id)).toEqual([7, 6, 5]);
    expect(store.recent(3, first.at(-1)!.id).map((event) => event.id)).toEqual([4, 3, 2]);
    expect(store.recent(0).length).toBe(1);
    expect(store.recent(10_000).length).toBe(7);
  });

  test("keeps the most recent rows only, beyond its bound", () => {
    const capped = auditStore(openDatabase(join(DATA_DIR, "audit-capped.db")), 3);
    for (let i = 0; i < 5; i++) capped.record({ actor: "owner", action: `test.${i}` }, START + i);
    // The bound applies on the hourly pass, before a write, to rows past the floor.
    capped.record({ actor: "owner", action: "test.last" }, START + AUDIT_FLOOR_MS + DAY);
    expect(capped.recent(100).map((event) => event.action)).toEqual(["test.last", "test.4", "test.3", "test.2"]);
  });

  test("never forgets a row of the last thirty days to the bound, however many come after", () => {
    // A cookie replayed in a loop must not push a revocation out of the audit.
    const capped = auditStore(openDatabase(join(DATA_DIR, "audit-floor.db")), 3);
    capped.record({ actor: "owner", action: "sharing.update", target: "forum.test-zone.invalid" }, START);
    for (let i = 0; i < 5; i++) capped.record({ actor: "owner", action: `test.${i}` }, START + DAY + i);
    capped.record({ actor: "owner", action: "test.last" }, START + AUDIT_FLOOR_MS - DAY);
    expect(capped.recent(100).map((event) => event.action)).toEqual([
      "test.last",
      "test.4",
      "test.3",
      "test.2",
      "test.1",
      "test.0",
      "sharing.update",
    ]);
  });

  test("a sign-in repeated within a minute by the same actor, on the same site, is one row that counts", () => {
    const db = openDatabase(join(DATA_DIR, "audit-collapse.db"));
    const collapsing = auditStore(db);
    const visitor = { actor: "zoe@elsewhere.test", action: "portal.signin", target: "forum.test-zone.invalid", detail: { method: "password-access" } };
    for (let i = 0; i < 100; i++) collapsing.record(visitor, START + i * 500);
    // Another site, another actor, another action: rows of their own.
    collapsing.record({ ...visitor, target: "roster.test-zone.invalid" }, START + 1_000);
    collapsing.record({ ...visitor, actor: "owner", detail: { method: "password" } }, START + 1_000);
    collapsing.record({ actor: "zoe@elsewhere.test", action: "portal.signout", target: "forum.test-zone.invalid" }, START + 2_000);
    collapsing.record({ actor: "zoe@elsewhere.test", action: "portal.signout", target: "forum.test-zone.invalid" }, START + 3_000);
    expect(collapsing.recent(100).map(({ actor, action, target, detail, at }) => ({ actor, action, target, detail, at }))).toEqual([
      { actor: visitor.actor, action: "portal.signout", target: "forum.test-zone.invalid", detail: { count: 2 }, at: new Date(START + 2_000).toISOString() },
      { actor: "owner", action: "portal.signin", target: "forum.test-zone.invalid", detail: { method: "password" }, at: new Date(START + 1_000).toISOString() },
      { actor: visitor.actor, action: "portal.signin", target: "roster.test-zone.invalid", detail: { method: "password-access" }, at: new Date(START + 1_000).toISOString() },
      { actor: visitor.actor, action: "portal.signin", target: "forum.test-zone.invalid", detail: { method: "password-access", count: 100 }, at: new Date(START).toISOString() },
    ]);
  });

  test("a minute later, a new row; a failure or a different detail is never folded in", () => {
    const collapsing = auditStore(openDatabase(join(DATA_DIR, "audit-collapse-later.db")));
    const owner = { actor: "owner", action: "portal.signin", target: "forum.test-zone.invalid", detail: { method: "password" } };
    collapsing.record(owner, START);
    collapsing.record(owner, START + COLLAPSE_WINDOW_MS);
    collapsing.record({ ...owner, actor: "alice@acme.test", detail: { method: "oidc", role: "viewer" } }, START + 1);
    collapsing.record({ ...owner, actor: "alice@acme.test", detail: { method: "oidc", role: "admin" } }, START + 2);
    collapsing.record({ actor: "anonymous", action: "portal.signin_failed", target: "forum.test-zone.invalid", detail: { method: "password" } }, START + 3);
    collapsing.record({ actor: "anonymous", action: "portal.signin_failed", target: "forum.test-zone.invalid", detail: { method: "password" } }, START + 4);
    expect(collapsing.recent(100).length).toBe(6);
  });

  test("forgets what is older than the retention, at most once an hour", () => {
    const later = START + AUDIT_RETENTION_MS + DAY;
    store.record({ actor: "owner", action: "portal.signin" }, later);
    expect(store.recent(100).map((event) => event.at)).toEqual([new Date(later).toISOString()]);
  });
});
