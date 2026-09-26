import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { guestStore, openDatabase, PRAGMAS } from "../src/database";
import { DATA_DIR } from "../src/config";
import type { Guest } from "../src/guests";

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

describe("the guest access store", () => {
  const store = guestStore(openDatabase(join(DATA_DIR, "guests.db")));

  function guest(id: string, rest: Partial<Guest> = {}): Guest {
    return { id, host: "forum.test-zone.invalid", label: "Alice", createdAt: 1_000, expiresAt: null, seenAt: null, ...rest };
  }

  test("a created access is found back by its identifier and by its hash, never by the password", () => {
    const created = guest("AAAAAAAAAAAAAAA1", { expiresAt: 5_000 });
    store.create(created, "e".repeat(64));
    expect(store.byId(created.id)).toEqual(created);
    expect(store.byHash("e".repeat(64))).toEqual(created);
    expect(store.byHash("f".repeat(64))).toBeNull();
    expect(store.byId("AAAAAAAAAAAAAAAZ")).toBeNull();
  });

  test("two accesses never share a hash", () => {
    store.create(guest("AAAAAAAAAAAAAAA2"), "2".repeat(64));
    expect(() => store.create(guest("AAAAAAAAAAAAAAA3"), "2".repeat(64))).toThrow();
  });

  test("the list goes from the most recent to the oldest, without a hash", () => {
    store.create(guest("AAAAAAAAAAAAAAA4", { createdAt: 9_000 }), "4".repeat(64));
    const rows = store.list();
    expect(rows[0]!.id).toBe("AAAAAAAAAAAAAAA4");
    expect(JSON.stringify(rows)).not.toInclude("4".repeat(64));
  });

  test("the last visit is noted", () => {
    store.touch("AAAAAAAAAAAAAAA2", 7_000);
    expect(store.byId("AAAAAAAAAAAAAAA2")?.seenAt).toBe(7_000);
  });

  test("deleting says whether the access existed", () => {
    expect(store.remove("AAAAAAAAAAAAAAA2")).toBe(true);
    expect(store.byId("AAAAAAAAAAAAAAA2")).toBeNull();
    expect(store.remove("AAAAAAAAAAAAAAA2")).toBe(false);
  });
});
