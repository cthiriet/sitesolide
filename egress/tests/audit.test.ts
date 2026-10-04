import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EMPTY_CONNECTORS, EMPTY_GRANTS, putConnector, removeConnector, setGrant, type ConnectorsFile, type GrantsFile } from "../../bin/cli/connectors";
import { createAudit, MAX_DENIED_KEYS, RETENTION_DAYS } from "../src/audit";

/** A clock the test moves by hand, and a database in memory: nothing here needs a file. */
function bench(start = "2026-10-04T12:00:00.000Z") {
  let now = new Date(start);
  const db = new Database(":memory:", { strict: true });
  const audit = createAudit(db, () => now);
  return { db, audit, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const VALUE = "Bearer test-value-0123456789";

function connectors(baseUrl = "https://chat.example.com", value = VALUE, at = "2026-10-04T11:00:00.000Z"): ConnectorsFile {
  const result = putConnector(EMPTY_CONNECTORS, { name: "chat", baseUrl, header: "Authorization", value }, at, "owner");
  if ("error" in result) throw new Error(result.error);
  return result.file;
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

describe("connector uses", () => {
  test("counted per project and connector, with their statuses, never a row per request", () => {
    const { audit } = bench();
    audit.used("shop", "chat", 200);
    audit.used("shop", "chat", 201);
    audit.used("shop", "chat", 502);
    audit.used("shop", "chat", null);
    audit.used("blog", "chat", 404);
    expect(audit.flush()).toBe(2);
    const rows = audit.recent(10);
    const shop = rows.find((row) => row.target === "shop")!;
    expect(shop.action).toBe("connector.use");
    expect(JSON.parse(shop.detail!)).toMatchObject({ connector: "chat", count: 4, failures: 2, statuses: { "2xx": 2, "5xx": 1, unreachable: 1 } });
  });
});

describe("changes to the connectors and their grants", () => {
  test("a creation, a change, a rotation and a removal, each once, with the author the file names", () => {
    const { audit } = bench();
    expect(audit.observe(connectors(), EMPTY_GRANTS)).toBe(1);
    // Seen again unchanged: nothing.
    expect(audit.observe(connectors(), EMPTY_GRANTS)).toBe(0);
    const moved = putConnector(connectors(), { name: "chat", baseUrl: "https://chat.example.com/v2", header: "Authorization", value: null }, "2026-10-04T13:00:00.000Z", "owner");
    if ("error" in moved) throw new Error(moved.error);
    expect(audit.observe(moved.file, EMPTY_GRANTS)).toBe(1);
    const rotated = putConnector(moved.file, { name: "chat", baseUrl: "https://chat.example.com/v2", header: "Authorization", value: "Bearer rotated-0123" }, "2026-10-04T14:00:00.000Z", "owner");
    if ("error" in rotated) throw new Error(rotated.error);
    expect(audit.observe(rotated.file, EMPTY_GRANTS)).toBe(1);
    const removed = removeConnector(rotated.file, EMPTY_GRANTS, "chat", "2026-10-04T15:00:00.000Z", "owner");
    if ("error" in removed) throw new Error(removed.error);
    expect(audit.observe(removed.connectors, removed.grants)).toBe(1);

    const rows = audit.recent(10).reverse();
    expect(rows.map((row) => [row.actor, row.action, row.target])).toEqual([
      ["owner", "connector.update", "chat"],
      ["owner", "connector.update", "chat"],
      ["owner", "connector.update", "chat"],
      ["owner", "connector.update", "chat"],
    ]);
    expect(rows.map((row) => JSON.parse(row.detail!).change)).toEqual(["created", "updated", "updated", "removed"]);
    expect(JSON.parse(rows[1]!.detail!)).toMatchObject({ changed: ["baseUrl"], valueReplaced: false });
    expect(JSON.parse(rows[2]!.detail!)).toMatchObject({ changed: [], valueReplaced: true });
  });

  test("a grant and its withdrawal, the project as target", () => {
    const { audit } = bench();
    const file = connectors();
    const granted = setGrant(EMPTY_GRANTS, file, "shop", "chat", true, "2026-10-04T12:00:00.000Z", "owner") as { file: GrantsFile };
    audit.observe(file, EMPTY_GRANTS);
    expect(audit.observe(file, granted.file)).toBe(1);
    const withdrawn = setGrant(granted.file, file, "shop", "chat", false, "2026-10-04T12:05:00.000Z", "owner") as { file: GrantsFile };
    expect(audit.observe(file, withdrawn.file)).toBe(1);
    const rows = audit.recent(2).reverse();
    expect(rows.map((row) => [row.action, row.target, JSON.parse(row.detail!)])).toEqual([
      ["connector.grant", "shop", { connector: "chat", granted: true }],
      ["connector.grant", "shop", { connector: "chat", granted: false }],
    ]);
  });

  test("no row, no state kept, ever carries a credential's value", () => {
    const { db, audit } = bench();
    audit.observe(connectors(), EMPTY_GRANTS);
    audit.used("shop", "chat", 200);
    audit.flush();
    const everything = JSON.stringify([db.query("SELECT * FROM audit").all(), db.query("SELECT * FROM seen").all()]);
    expect(everything).not.toContain(VALUE);
    expect(everything).not.toContain("test-value");
  });
});

describe("reading and keeping", () => {
  test("newest first, by pages", () => {
    const { audit } = bench();
    for (let i = 0; i < 5; i++) audit.used(`s${i}`, "chat", 200);
    audit.flush();
    const first = audit.recent(2);
    expect(first).toHaveLength(2);
    const next = audit.recent(10, first[1]!.id);
    expect(next).toHaveLength(3);
    expect(next.every((row) => row.id < first[1]!.id)).toBe(true);
  });

  test(`rows older than ${RETENTION_DAYS} days go`, () => {
    const { audit, advance } = bench();
    audit.used("shop", "chat", 200);
    audit.flush();
    advance((RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
    audit.used("shop", "chat", 200);
    audit.flush();
    expect(audit.prune()).toBe(1);
    expect(audit.recent(10)).toHaveLength(1);
  });
});
