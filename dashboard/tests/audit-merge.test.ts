import { describe, expect, test } from "bun:test";
import {
  boundDetail,
  fromJournal,
  fromTableRow,
  isAfter,
  MAX_DETAIL_DEPTH,
  MAX_DETAIL_ITEMS,
  MAX_DETAIL_KEYS,
  MAX_DETAIL_STRING,
  MAX_TEXT,
  STEWARD_ACTIONS,
} from "../src/audit/normalize";
import {
  decodeCursor,
  encodeCursor,
  fingerprint,
  matches,
  merge,
  readQuery,
  siteOf,
  siteResolver,
  type AuditQuery,
  type Scan,
} from "../src/audit/merge";
import { AUDIT_SOURCES, MAX_LIMIT, type AuditRow, type AuditSource } from "../src/audit/protocol";
import type { Snapshot } from "../src/state";

/**
 * The pure half of the Activity page's route: how each component's rows come
 * into one shape, what the query accepts, which rows match it, which site a
 * target names, the cursor, and the merge of the sources into one page.
 */

const T = Date.UTC(2026, 9, 4, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("each source's rows, in one shape", () => {
  test("a table row keeps its fields, and its id becomes its place in its source", () => {
    expect(fromTableRow("portal", { id: 7, at: iso(T), actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", detail: { method: "oidc" } })).toEqual({
      position: [7, 0],
      row: { id: "portal:7", source: "portal", at: iso(T), actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", detail: { method: "oidc" } },
    });
  });

  test("the egress proxy's detail, kept as text, reads as an object; text that is not one reads as none", () => {
    expect(fromTableRow("egress", { id: 1, at: iso(T), actor: "system", action: "connector.use", target: "shop", detail: '{"connector":"chat","count":3}' })?.row.detail).toEqual({ connector: "chat", count: 3 });
    expect(fromTableRow("egress", { id: 1, at: iso(T), actor: "system", action: "x", target: null, detail: "[1,2]" })?.row.detail).toBeNull();
    expect(fromTableRow("egress", { id: 1, at: iso(T), actor: "system", action: "x", target: null, detail: "{not json" })?.row.detail).toBeNull();
  });

  test("a row that does not read is left out, not guessed at", () => {
    const good = { id: 3, at: iso(T), actor: "system", action: "backup.run", target: null, detail: null };
    for (const bad of [
      null,
      "row",
      [good],
      { ...good, id: 0 },
      { ...good, id: 1.5 },
      { ...good, id: "3" },
      { ...good, at: "yesterday" },
      { ...good, actor: "" },
      { ...good, action: 42 },
    ]) {
      expect(fromTableRow("backups", bad)).toBeNull();
    }
    expect(fromTableRow("backups", { ...good, target: undefined })?.row.target).toBeNull();
  });

  test("the date is brought to its canonical form", () => {
    expect(fromTableRow("dashboard", { id: 1, at: "2026-10-04T14:00:00+02:00", actor: "owner", action: "token.create", target: null, detail: null })?.row.at).toBe(iso(T));
  });

  test("names are cut, and the detail is bounded in length, breadth and depth", () => {
    const long = "x".repeat(5000);
    let deep: unknown = "bottom";
    for (let level = 0; level < 10; level++) deep = { level: deep };
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`k${index}`, index]));
    const row = fromTableRow("dashboard", {
      id: 1,
      at: iso(T),
      actor: long,
      action: "token.create",
      target: long,
      detail: { long, deep, wide, items: Array.from({ length: 80 }, (_, index) => index), odd: Number.NaN, nothing: null, yes: true },
    })!.row;
    expect(row.actor.length).toBe(MAX_TEXT);
    expect(row.target!.length).toBe(MAX_TEXT);
    const detail = row.detail!;
    expect((detail.long as string).length).toBe(MAX_DETAIL_STRING);
    expect((detail.long as string).endsWith("…")).toBe(true);
    expect(Object.keys(detail.wide as object).length).toBe(MAX_DETAIL_KEYS);
    expect((detail.items as unknown[]).length).toBe(MAX_DETAIL_ITEMS);
    expect(detail).not.toHaveProperty("odd");
    expect(detail.nothing).toBeNull();
    expect(detail.yes).toBe(true);
    let level: unknown = detail.deep;
    let depth = 1;
    while (typeof level === "object" && level !== null) {
      level = (level as { level: unknown }).level;
      depth++;
    }
    // The objects of the first levels are kept, the one at MAX_DETAIL_DEPTH becomes a mark.
    expect(level).toBe("…");
    expect(depth).toBe(MAX_DETAIL_DEPTH);
  });

  test("a key named __proto__ stays a key and never becomes a prototype", () => {
    const detail = boundDetail('{"__proto__":{"polluted":true},"ok":1}')!;
    expect(Object.getPrototypeOf(detail)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(detail, "__proto__")).toBe(true);
  });

  test("the steward's journal: its operations under their action, its fields in the detail, the owner as actor", () => {
    const rows = fromJournal([
      { a: T, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "SMTP_PASSWORD", detail: null },
      { a: T, operation: "portal", result: "failure", slug: "cms", file: null, variable: null, detail: "off, failure" },
      { a: T - 1000, operation: "unlock", result: "rejects", slug: null, file: null, variable: null, detail: "wrong password" },
    ]);
    expect(rows).toEqual([
      {
        position: [T, 0],
        row: { id: `steward:${T}.0`, source: "steward", at: iso(T), actor: "owner", action: "secrets.set", target: "cms", detail: { result: "ok", file: "cms.env", variable: "SMTP_PASSWORD" } },
      },
      {
        position: [T, 1],
        row: { id: `steward:${T}.1`, source: "steward", at: iso(T), actor: "owner", action: "access.general", target: "cms", detail: { result: "failure", note: "off, failure" } },
      },
      {
        position: [T - 1000, 0],
        row: { id: `steward:${T - 1000}.0`, source: "steward", at: iso(T - 1000), actor: "owner", action: "secrets.unlock", target: null, detail: { result: "rejects", note: "wrong password" } },
      },
    ]);
  });

  test("every operation the steward journals has its action, and an unknown one is left out", () => {
    expect(Object.keys(STEWARD_ACTIONS).sort()).toEqual([
      "access.add",
      "access.change",
      "access.migrate",
      "access.remove",
      "backup.restore",
      "code",
      "create",
      "dashboard.signin",
      "dashboard.signin_failed",
      "dashboard.signout",
      "guest.create",
      "guest.revoke",
      "lock",
      "member.invite",
      "member.remove",
      "member.role",
      "member.signin",
      "member.signin_failed",
      "member.signout",
      "password",
      "people.create",
      "portal",
      "project.create",
      "project.remove",
      "read",
      "remove",
      "replace",
      "restart",
      "restore",
      "set",
      "sharing",
      "token.create",
      "token.revoke",
      "unlock",
    ]);
    expect(fromJournal([{ a: T, operation: "constructor", result: "ok", slug: null, file: null, variable: null, detail: null }])).toEqual([]);
    expect(fromJournal([{ a: "now", operation: "set" }, null, 4])).toEqual([]);
  });

  test("older means a smaller first part, or the same and a larger second", () => {
    expect(isAfter([5, 0], [6, 0])).toBe(true);
    expect(isAfter([6, 1], [6, 0])).toBe(true);
    expect(isAfter([6, 0], [6, 0])).toBe(false);
    expect(isAfter([7, 0], [6, 3])).toBe(false);
  });
});

describe("the query", () => {
  const read = (query: string) => readQuery(new URLSearchParams(query));

  test("with nothing, every source, the default page, no filter", () => {
    expect(read("")).toEqual({ sources: [...AUDIT_SOURCES], actor: null, action: null, target: null, from: null, to: null, limit: 100, cursor: null, restrict: null });
  });

  test("sources repeated or listed, kept in their fixed order", () => {
    expect((read("source=steward,portal&source=portal") as AuditQuery).sources).toEqual(["portal", "steward"]);
    expect(read("source=portal,mail")).toEqual({ error: "source: one of dashboard, portal, egress, backups, steward" });
  });

  test("the filters, trimmed and in lowercase", () => {
    expect(read("actor=%20Ada@Test-Zone.invalid%20&action=Portal.&target=CMS")).toMatchObject({ actor: "ada@test-zone.invalid", action: "portal.", target: "cms" });
    expect(read("actor=")).toMatchObject({ actor: null });
  });

  test("a range of dates, from before to", () => {
    expect(read("from=2026-10-01T00:00:00Z&to=2026-10-04T00:00:00Z")).toMatchObject({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 4) });
    expect(read("from=2026-10-04T00:00:00Z&to=2026-10-01T00:00:00Z")).toEqual({ error: "from: before to" });
    expect("error" in read("from=someday")).toBe(true);
  });

  test("the page size, bounded", () => {
    expect(read("limit=20")).toMatchObject({ limit: 20 });
    for (const limit of ["0", String(MAX_LIMIT + 1), "2.5", "ten"]) expect("error" in read(`limit=${limit}`)).toBe(true);
  });

  test("anything given twice, or too long, is refused", () => {
    expect("error" in read("actor=a&actor=b")).toBe(true);
    expect("error" in read(`target=${"x".repeat(MAX_TEXT + 1)}`)).toBe(true);
    expect("error" in read(`cursor=${"x".repeat(3000)}`)).toBe(true);
  });
});

/** A snapshot with what the resolver reads: slugs, addresses, domains. */
function snapshot(sites: { slug: string; address: string; domain?: { name: string; aliases: string[] } }[]): Snapshot {
  return { sites: sites.map((site) => ({ ...site, domain: site.domain === undefined ? null : { ...site.domain, active: true, route: true } })) } as unknown as Snapshot;
}

describe("which site a target names", () => {
  const resolve = siteResolver(
    snapshot([
      { slug: "cms", address: "cms.test-zone.invalid", domain: { name: "cms.example.invalid", aliases: ["www.cms.example.invalid"] } },
      { slug: "test-zone.invalid", address: "test-zone.invalid" },
    ]),
    "test-zone.invalid",
  );

  test("a slug, its address, its domain and its aliases", () => {
    for (const target of ["cms", "CMS", "cms.test-zone.invalid", "cms.example.invalid", "www.cms.example.invalid"]) expect(resolve(target)).toBe("cms");
    expect(resolve("test-zone.invalid")).toBe("test-zone.invalid");
  });

  test("a host the snapshot does not know names no site", () => {
    expect(resolve("other.test-zone.invalid")).toBeNull();
    expect(resolve("elsewhere.invalid")).toBeNull();
    expect(resolve("shop")).toBeNull();
  });

  test("without a snapshot, a name without a dot is a slug, and a host under the zone its first label", () => {
    const blind = siteResolver(null, "test-zone.invalid");
    expect(blind("shop")).toBe("shop");
    expect(blind("shop.test-zone.invalid")).toBe("shop");
    expect(blind("shop.example.invalid")).toBeNull();
  });

  test("a connector's change names the connector, never a site", () => {
    const named = siteResolver(snapshot([{ slug: "chat", address: "chat.test-zone.invalid" }]), "test-zone.invalid");
    const row = { id: "egress:1", source: "egress" as const, at: iso(T), actor: "owner", action: "connector.update", target: "chat", detail: null };
    expect(siteOf(row, named)).toBeNull();
    expect(siteOf({ ...row, action: "connector.grant" }, named)).toBe("chat");
  });
});

function row(partial: Partial<AuditRow> = {}): AuditRow {
  return { id: "portal:1", source: "portal", at: iso(T), actor: "ada@test-zone.invalid", action: "portal.signin", target: "cms.test-zone.invalid", site: "cms", detail: null, ...partial };
}

describe("which rows match", () => {
  const resolve = siteResolver(snapshot([{ slug: "cms", address: "cms.test-zone.invalid" }]), "test-zone.invalid");
  const none = { actor: null, action: null, target: null, from: null, to: null };

  test("an actor by any part of it, in any case", () => {
    expect(matches(row(), { ...none, actor: "ada" }, resolve)).toBe(true);
    expect(matches(row({ actor: "token:AbC" }), { ...none, actor: "token:abc" }, resolve)).toBe(true);
    expect(matches(row(), { ...none, actor: "bob" }, resolve)).toBe(false);
  });

  test("an action by its beginning", () => {
    expect(matches(row(), { ...none, action: "portal." }, resolve)).toBe(true);
    expect(matches(row({ action: "portal.signin_failed" }), { ...none, action: "portal.signin" }, resolve)).toBe(true);
    expect(matches(row(), { ...none, action: "signin" }, resolve)).toBe(false);
  });

  test("a site's filter finds its hosts, and a host finds the site's slug", () => {
    expect(matches(row(), { ...none, target: "cms" }, resolve)).toBe(true);
    expect(matches(row({ target: "cms", site: "cms", source: "steward" }), { ...none, target: "cms.test-zone.invalid" }, resolve)).toBe(true);
    expect(matches(row({ target: "github", site: null, action: "connector.update" }), { ...none, target: "github" }, resolve)).toBe(true);
    expect(matches(row(), { ...none, target: "shop" }, resolve)).toBe(false);
    expect(matches(row({ target: null, site: null }), { ...none, target: "cms" }, resolve)).toBe(false);
  });

  test("a range of dates, from inclusive, to exclusive", () => {
    expect(matches(row(), { ...none, from: T, to: T + 1 }, resolve)).toBe(true);
    expect(matches(row(), { ...none, from: T + 1 }, resolve)).toBe(false);
    expect(matches(row(), { ...none, to: T }, resolve)).toBe(false);
  });
});

describe("the cursor", () => {
  const query = { sources: ["portal", "steward"] as AuditSource[], actor: null, action: "portal.", target: null, from: null, to: null };
  const print = fingerprint(query);

  test("goes and comes back", () => {
    const cursor = encodeCursor(print, { portal: [42, 0], steward: "end" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, print, query.sources)).toEqual({ portal: [42, 0], steward: "end" });
  });

  test("made under other filters, it is refused rather than skipping what they keep", () => {
    const cursor = encodeCursor(print, { portal: [42, 0] });
    const other = fingerprint({ ...query, action: "sharing." });
    expect(other).not.toBe(print);
    expect(decodeCursor(cursor, other, query.sources)).toEqual({ error: "cursor: made under other filters, read the first page again" });
  });

  test("anything else is refused", () => {
    const refused = { error: "cursor: not one this dashboard gave, read the first page again" };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "%%%",
      encode([1]),
      encode({ v: 2, f: print, p: {} }),
      encode({ v: 1, f: print, p: { mail: "end" } }),
      encode({ v: 1, f: print, p: { egress: "end" } }),
      encode({ v: 1, f: print, p: { portal: [1] } }),
      encode({ v: 1, f: print, p: { portal: [1, -1] } }),
      encode({ v: 1, f: print, p: { portal: ["1", 0] } }),
      encode({ v: 1, f: print, p: { portal: "later" } }),
    ]) {
      expect(decodeCursor(cursor, print, query.sources)).toEqual(refused);
    }
  });
});

describe("the merge", () => {
  /** A scan whose candidates are rows at the given minutes before T, ids counting down. */
  function scan(source: AuditSource, minutes: number[], options: Partial<Pick<Scan, "end" | "failed">> & { lastMinute?: number } = {}): Scan {
    const candidates = minutes.map((minute, index) => {
      const id = 1000 - index;
      return { position: [id, 0] as const, row: row({ id: `${source}:${id}`, source, at: iso(T - minute * 60_000) }) };
    });
    const lastMinute = options.lastMinute ?? minutes.at(-1);
    const lastId = 1000 - Math.max(0, minutes.length - 1) - (options.lastMinute === undefined ? 0 : 5);
    return {
      source,
      candidates,
      last: lastMinute === undefined ? null : { position: [lastId, 0], ms: T - lastMinute * 60_000 },
      end: options.end ?? false,
      failed: options.failed ?? false,
    };
  }

  const ids = (rows: AuditRow[]) => rows.map((one) => one.id);

  test("newest first across sources, the source's order breaking a tie", () => {
    const { rows } = merge([scan("steward", [0, 5], { end: true }), scan("portal", [0, 3, 10], { end: true })], {}, 10);
    expect(ids(rows)).toEqual(["portal:1000", "steward:1000", "portal:999", "steward:999", "portal:998"]);
  });

  test("each source stands after the last row it handed over", () => {
    const { rows, standings } = merge([scan("portal", [1, 2, 3, 4]), scan("steward", [0, 5])], { portal: "start", steward: "start" }, 3);
    expect(ids(rows)).toEqual(["steward:1000", "portal:1000", "portal:999"]);
    expect(standings).toEqual({ portal: [999, 0], steward: [1000, 0] });
  });

  test("a source read to its end, with every row handed over, is done", () => {
    const { standings } = merge([scan("portal", [1], { end: true }), scan("steward", [], { end: true })], {}, 10);
    expect(standings).toEqual({ portal: "end", steward: "end" });
  });

  test("a source that matched nothing in what it read moves past it", () => {
    const { rows, standings } = merge([scan("portal", [], { lastMinute: 50 })], { portal: [2000, 0] }, 10);
    expect(rows).toEqual([]);
    expect(standings.portal).toEqual([995, 0]);
  });

  test("nothing older than what a source stopped short at goes on the page", () => {
    // Portal ran out of budget with one match, having read down to minute 20:
    // steward's row at minute 30 might be preceded by portal rows still unread.
    const { rows, standings } = merge([scan("portal", [10], { lastMinute: 20 }), scan("steward", [5, 30], { end: true })], { portal: "start", steward: "start" }, 10);
    expect(ids(rows)).toEqual(["steward:1000", "portal:1000"]);
    expect(standings.steward).toEqual([1000, 0]);
    expect(standings.portal).toEqual([995, 0]);
  });

  test("a source that failed is left out, and the cursor does not read it again", () => {
    const { rows, standings } = merge([scan("portal", [1], { failed: true }), scan("steward", [2], { end: true })], { portal: [7, 0], steward: "start" }, 10);
    expect(ids(rows)).toEqual(["steward:1000"]);
    expect(standings).toEqual({ portal: "end", steward: "end" });
  });

  test("the page never holds more than its limit", () => {
    const { rows } = merge([scan("portal", [1, 2, 3], { end: true }), scan("egress", [1, 2, 3], { end: true })], {}, 4);
    expect(rows.length).toBe(4);
  });
});
