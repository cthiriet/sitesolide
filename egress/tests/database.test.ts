import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, PRAGMAS } from "../src/database";
import { DATA_DIR } from "../src/config";

// tests/setup.ts must have diverted DATA_DIR before any import.
if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const db = openDatabase(join(DATA_DIR, "pragmas.db"));

/** Reads back a setting applied to the connection. */
function setting(name: string): unknown {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
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
    expect(setting("synchronous")).toBe(1);
  });

  test("checks the foreign keys, which SQLite ignores by default", () => {
    expect(setting("foreign_keys")).toBe(1);
  });

  test("keeps the temporary tables and the cache in memory", () => {
    expect(setting("temp_store")).toBe(2);
    expect(setting("cache_size")).toBe(-16000);
  });

  test("refuses a query one of whose parameters is missing", () => {
    const query = db.query<{ a: number }, { a: number }>("SELECT $a AS a");
    expect(query.get({ a: 1 })?.a).toBe(1);
    expect(() => query.get({} as { a: number })).toThrow();
  });
});
