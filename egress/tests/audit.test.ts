import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createAudit, MAX_DENIED_KEYS, MAX_TRACKED_KEYS, RETENTION_DAYS } from "../src/audit";

/** A clock the test moves by hand, and a database in memory: nothing here needs a file. */
function bench(start = "2026-10-04T12:00:00.000Z") {
  let now = new Date(start);
  const db = new Database(":memory:", { strict: true });
  const audit = createAudit(db, () => now);
  return { db, audit, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("refusals", () => {
  test("counted per project and destination, then written once, with their count and their span", () => {
    const { audit, advance } = bench();
    audit.denied({ target: "shop", destination: "evil.example.net:443", reason: "not in the list" });
    advance(1000);
    audit.denied({ target: "shop", destination: "evil.example.net:443", reason: "not in the list" });
    audit.denied({ target: null, destination: "api.example.com:443", reason: "not a project", account: "root" });
    expect(audit.recent(10)).toEqual([]);
    expect(audit.flush()).toBe(2);
    const rows = audit.recent(10);
    expect(rows.map((row) => [row.action, row.actor, row.target])).toEqual([
      ["egress.denied", "system", null],
      ["egress.denied", "system", "shop"],
    ]);
    expect(JSON.parse(rows[1]!.detail!)).toEqual({
      reason: "not in the list",
      count: 2,
      first: "2026-10-04T12:00:00.000Z",
      last: "2026-10-04T12:00:01.000Z",
      destination: "evil.example.net:443",
    });
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ account: "root" });
    // The counters start again from nothing.
    expect(audit.flush()).toBe(0);
  });

  test("beyond the cap, the quietest pairs fold into one row that says how many were dropped", () => {
    const { audit } = bench();
    for (let i = 0; i < MAX_DENIED_KEYS + 10; i++) {
      for (let n = 0; n <= (i < MAX_DENIED_KEYS ? 2 : 0); n++) audit.denied({ target: "shop", destination: `h${i}.example.com:443`, reason: "not in the list" });
    }
    expect(audit.flush()).toBe(MAX_DENIED_KEYS + 1);
    const folded = audit.recent(1)[0]!;
    expect(folded.target).toBeNull();
    expect(JSON.parse(folded.detail!)).toEqual({ reason: "rate limited", pairs: 10, count: 10 });
  });
});

describe("memory", () => {
  test("a flood of distinct destinations stops growing the counters, and is still counted", () => {
    const { audit } = bench();
    for (let i = 0; i < MAX_TRACKED_KEYS + 25; i++) audit.denied({ target: "shop", destination: `h${i}.example.com:443`, reason: "not in the list" });
    expect(audit.flush()).toBe(MAX_DENIED_KEYS + 1);
    const folded = JSON.parse(audit.recent(1)[0]!.detail!);
    expect(folded).toEqual({ reason: "rate limited", pairs: MAX_TRACKED_KEYS - MAX_DENIED_KEYS, count: MAX_TRACKED_KEYS - MAX_DENIED_KEYS + 25, untracked: 25 });
  });
});

describe("reading and keeping", () => {
  test("newest first, by pages", () => {
    const { audit } = bench();
    for (let i = 0; i < 5; i++) {
      audit.denied({ target: `s${i}`, destination: "evil.example.net:443", reason: "not in the list" });
      audit.flush();
    }
    const first = audit.recent(2);
    expect(first).toHaveLength(2);
    const next = audit.recent(10, first[1]!.id);
    expect(next).toHaveLength(3);
    expect(next.every((row) => row.id < first[1]!.id)).toBe(true);
  });

  test(`rows older than ${RETENTION_DAYS} days go`, () => {
    const { audit, advance } = bench();
    audit.denied({ target: "shop", destination: "evil.example.net:443", reason: "not in the list" });
    audit.flush();
    advance((RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    audit.denied({ target: "shop", destination: "evil.example.net:443", reason: "not in the list" });
    audit.flush();
    expect(audit.prune()).toBe(1);
    expect(audit.recent(10)).toHaveLength(1);
  });
});
