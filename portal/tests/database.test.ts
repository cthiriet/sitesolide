import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AUDIT_FLOOR_MS, AUDIT_RETENTION_MS, COLLAPSE_WINDOW_MS, auditStore, guestStore, openDatabase, PRAGMAS, sharingStore } from "../src/database";
import { DATA_DIR } from "../src/config";
import type { Guest } from "../src/database";
import { DEFAULT_POLICY } from "../src/sharing";

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

describe("the guest access store, read-only", () => {
  const db = openDatabase(join(DATA_DIR, "guests.db"));
  const store = guestStore(db);

  /** A row as the portal wrote it before the steward kept access: nothing writes one any more. */
  function lay(guest: Guest, hash: string, seenAt: number | null = null): void {
    db.query("INSERT INTO invites (id, hote, libelle, empreinte, cree_a, expire_a, vu_a) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      guest.id,
      guest.host,
      guest.label,
      hash,
      guest.createdAt,
      guest.expiresAt,
      seenAt,
    );
  }

  function guest(id: string, rest: Partial<Guest> = {}): Guest {
    return { id, host: "forum.test-zone.invalid", label: "Alice", createdAt: 1_000, expiresAt: null, seenAt: null, ...rest };
  }

  test("an access is found back by its identifier and by its hash, never by the password", () => {
    const laid = guest("AAAAAAAAAAAAAAA1", { expiresAt: 5_000 });
    lay(laid, "e".repeat(64));
    expect(store.byId(laid.id)).toEqual(laid);
    expect(store.byHash("e".repeat(64))).toEqual(laid);
    expect(store.byHash("f".repeat(64))).toBeNull();
    expect(store.byId("AAAAAAAAAAAAAAAZ")).toBeNull();
  });

  test("two accesses never shared a hash", () => {
    lay(guest("AAAAAAAAAAAAAAA2"), "2".repeat(64), 7_000);
    expect(() => lay(guest("AAAAAAAAAAAAAAA3"), "2".repeat(64))).toThrow();
    expect(store.byId("AAAAAAAAAAAAAAA2")?.seenAt).toBe(7_000);
  });

  test("the list goes from the most recent to the oldest, without a hash", () => {
    lay(guest("AAAAAAAAAAAAAAA4", { createdAt: 9_000 }), "4".repeat(64));
    const rows = store.list();
    expect(rows[0]!.id).toBe("AAAAAAAAAAAAAAA4");
    expect(JSON.stringify(rows)).not.toInclude("4".repeat(64));
  });

  test("offers nothing that writes", () => {
    expect(Object.keys(store).sort()).toEqual(["byHash", "byId", "list"]);
  });
});

describe("a database from before sharing", () => {
  test("gains its tables at the next opening, and keeps its guests", () => {
    // The state of a database in service today: the invites table alone.
    const path = join(DATA_DIR, "before-sharing.db");
    const old = openDatabase(path);
    old.run("DROP TABLE sharing");
    old.run("DROP TABLE audit");
    old.run(
      "INSERT INTO invites (id, hote, libelle, empreinte, cree_a) VALUES ('AAAAAAAAAAAAAAA9', 'forum.test-zone.invalid', 'Alice', 'h', 1)",
    );
    expect(old.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "invites" }]);
    old.close();

    const db = openDatabase(path);
    expect(guestStore(db).byId("AAAAAAAAAAAAAAA9")?.label).toBe("Alice");
    expect(sharingStore(db).get("forum.test-zone.invalid")).toEqual(DEFAULT_POLICY);
    expect(auditStore(db).recent(10)).toEqual([]);
  });
});

describe("the sharing store, read-only", () => {
  const db = openDatabase(join(DATA_DIR, "sharing.db"));
  const store = sharingStore(db);
  const HOST = "forum.test-zone.invalid";

  test("a site never shared gets the narrowest policy", () => {
    expect(store.get("never.test-zone.invalid")).toEqual(DEFAULT_POLICY);
  });

  test("reads back a policy as the portal wrote it before the steward kept access", () => {
    db.run(
      `INSERT INTO sharing (host, mode, people, domains, updated_at) VALUES ('${HOST}', 'domain', '["bob@acme.test"]', '["acme.test"]', 2000)`,
    );
    expect(store.get(HOST)).toEqual({ mode: "domain", people: ["bob@acme.test"], domains: ["acme.test"] });
    expect(store.list()).toEqual([
      { host: HOST, policy: { mode: "domain", people: ["bob@acme.test"], domains: ["acme.test"] }, updatedAt: 2_000 },
    ]);
  });

  test("a row this version cannot read falls back to the admins alone, never wider", () => {
    db.run("INSERT INTO sharing (host, mode, people, domains, updated_at) VALUES ('odd.test-zone.invalid', 'everyone', '[]', '[]', 1)");
    db.run("INSERT INTO sharing (host, mode, people, domains, updated_at) VALUES ('broken.test-zone.invalid', 'people', 'not json', '[]', 1)");
    expect(store.get("odd.test-zone.invalid")).toEqual(DEFAULT_POLICY);
    expect(store.get("broken.test-zone.invalid")).toEqual(DEFAULT_POLICY);
  });

  test("offers nothing that writes", () => {
    expect(Object.keys(store).sort()).toEqual(["get", "list"]);
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
