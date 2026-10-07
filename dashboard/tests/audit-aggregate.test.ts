import { describe, expect, test } from "bun:test";
import { aggregate, type AuditReader, type Budget, type Readers, type ReaderResult } from "../src/audit/aggregate";
import { readQuery, siteResolver, type AuditQuery } from "../src/audit/merge";
import { fromTableRow, isAfter, type SourceRow } from "../src/audit/normalize";
import { AUDIT_SOURCES, type AuditResponse, type AuditRow, type AuditSource } from "../src/audit/protocol";

/**
 * One page of the machine's audit, with simulated sources: merged newest
 * first, paged by a cursor that never skips nor repeats a row, filtered, and
 * shown whole when a source is down, slow or answering garbage.
 */

const T = Date.UTC(2026, 9, 4, 12, 0, 0);
const MINUTE = 60_000;
const resolve = siteResolver(null, "test-zone.invalid");

type Fake = { id: number; minute: number; actor?: string; action?: string; target?: string | null; detail?: unknown };

/** Rows in a source's shape, newest first, from rows given at minutes before T. */
function rowsOf(source: AuditSource, fakes: Fake[]): SourceRow[] {
  return fakes
    .map((fake) =>
      fromTableRow(source, {
        id: fake.id,
        at: new Date(T - fake.minute * MINUTE).toISOString(),
        actor: fake.actor ?? "system",
        action: fake.action ?? `${source}.event`,
        target: fake.target ?? null,
        detail: fake.detail ?? null,
      }),
    )
    .filter((row): row is SourceRow => row !== null)
    .sort((a, b) => b.position[0] - a.position[0]);
}

/** A source paged by id, like the portal's and the egress proxy's audits. Counts the calls it gets. */
function paged(rows: () => SourceRow[], pageMax = 500): AuditReader & { calls: number } {
  const reader = {
    calls: 0,
    async read(after: readonly [number, number] | null, size: number): Promise<ReaderResult> {
      reader.calls++;
      const left = rows().filter((row) => after === null || isAfter(row.position, after));
      const taken = left.slice(0, Math.min(size, pageMax));
      return { kind: "rows", rows: taken, end: taken.length === left.length, window: null };
    },
  };
  return reader;
}

/** A source that only hands over its latest entries, like the steward's routes. */
function windowed(rows: SourceRow[], window: number): AuditReader {
  return {
    async read(after, size) {
      const latest = rows.slice(0, window);
      const left = latest.filter((row) => after === null || isAfter(row.position, after));
      return { kind: "rows", rows: left.slice(0, size), end: left.length <= size, window: rows.length >= window ? window : null };
    },
  };
}

const empty: AuditReader = { read: async () => ({ kind: "rows", rows: [], end: true, window: null }) };

function readers(partial: Partial<Readers>): Readers {
  return Object.fromEntries(AUDIT_SOURCES.map((source) => [source, partial[source] ?? empty])) as Readers;
}

function query(text = ""): AuditQuery {
  const read = readQuery(new URLSearchParams(text));
  if ("error" in read) throw new Error(read.error);
  return read;
}

async function page(q: AuditQuery, all: Readers, budget?: Budget): Promise<AuditResponse> {
  const answer = await aggregate(q, all, resolve, budget);
  if ("error" in answer) throw new Error(answer.error);
  return answer;
}

/** Every page, following the cursor, and the rows in the order they came. */
async function everything(text: string, all: Readers, budget?: Budget): Promise<{ rows: AuditRow[]; pages: AuditResponse[] }> {
  const pages: AuditResponse[] = [];
  let cursor: string | null = null;
  do {
    const answer = await page({ ...query(text), cursor }, all, budget);
    pages.push(answer);
    cursor = answer.cursor;
    if (pages.length > 2_000) throw new Error("the cursor does not end");
  } while (cursor !== null);
  return { rows: pages.flatMap((one) => one.rows), pages };
}

/** A fixed pseudo-random sequence, so that a failure always reproduces. */
function sequence(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

/** Rows for every source, at minutes that interleave and collide. */
function machine(count: number, seed = 7): Record<AuditSource, SourceRow[]> {
  const random = sequence(seed);
  return Object.fromEntries(
    AUDIT_SOURCES.map((source) => {
      let minute = 0;
      const fakes: Fake[] = [];
      for (let index = 0; index < count; index++) {
        minute += Math.floor(random() * 4);
        fakes.push({ id: count - index, minute, action: random() < 0.3 ? "portal.signin" : `${source}.other`, actor: random() < 0.5 ? "ada@test-zone.invalid" : "system" });
      }
      return [source, rowsOf(source, fakes)];
    }),
  ) as Record<AuditSource, SourceRow[]>;
}

function sorted(rows: AuditRow[]): AuditRow[] {
  const order = new Map(AUDIT_SOURCES.map((source, index) => [source, index]));
  return [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || order.get(a.source)! - order.get(b.source)! || Number(b.id.split(":")[1]) - Number(a.id.split(":")[1]));
}

describe("one page of the whole machine", () => {
  test("every source merged newest first, each row with its source and its site", async () => {
    const answer = await page(
      query(),
      readers({
        dashboard: paged(() => rowsOf("dashboard", [{ id: 2, minute: 1, actor: "token:abc", action: "deploy.success", target: "shop" }])),
        portal: paged(() => rowsOf("portal", [{ id: 9, minute: 0, actor: "ada@test-zone.invalid", action: "portal.signin", target: "shop.test-zone.invalid" }])),
        egress: paged(() => rowsOf("egress", [{ id: 4, minute: 3, action: "connector.update", target: "chat" }])),
      }),
    );
    expect(answer.rows.map((row) => [row.id, row.site])).toEqual([
      ["portal:9", "shop"],
      ["dashboard:2", "shop"],
      ["egress:4", null],
    ]);
    expect(answer.sources.map((source) => [source.name, source.state])).toEqual(AUDIT_SOURCES.map((source) => [source, "ok"]));
    expect(answer.cursor).toBeNull();
    expect(answer.scanned).toBe(3);
  });

  test("page after page, every row once, newest first, whatever the page size", async () => {
    const rows = machine(60);
    const all = readers(Object.fromEntries(AUDIT_SOURCES.map((source) => [source, paged(() => rows[source], 7)])));
    const expected = sorted(Object.values(rows).flatMap((list) => list.map((one) => ({ ...one.row, site: null }))));
    for (const limit of [1, 13, 100, 500]) {
      const { rows: seen } = await everything(`limit=${limit}`, all, { fetchSize: 9, maxFetches: 2, deadlineMs: 5_000 });
      expect(seen.map((one) => one.id)).toEqual(expected.map((one) => one.id));
    }
  });

  test("with filters, exactly the rows they keep, still once each", async () => {
    const rows = machine(80, 11);
    const all = readers(Object.fromEntries(AUDIT_SOURCES.map((source) => [source, paged(() => rows[source], 10)])));
    const expected = sorted(
      Object.values(rows)
        .flat()
        .map((one) => ({ ...one.row, site: null }))
        .filter((one) => one.action.startsWith("portal.") && one.actor.includes("ada")),
    );
    expect(expected.length).toBeGreaterThan(10);
    const { rows: seen } = await everything("action=portal.&actor=ADA&limit=5", all, { fetchSize: 6, maxFetches: 2, deadlineMs: 5_000 });
    expect(seen.map((one) => one.id)).toEqual(expected.map((one) => one.id));
  });

  test("rows recorded between two pages neither repeat nor push an older one out", async () => {
    const list = rowsOf("portal", [
      { id: 3, minute: 3 },
      { id: 2, minute: 4 },
      { id: 1, minute: 5 },
    ]);
    const all = readers({ portal: paged(() => list) });
    const first = await page(query("limit=2"), all);
    expect(first.rows.map((row) => row.id)).toEqual(["portal:3", "portal:2"]);
    list.unshift(...rowsOf("portal", [{ id: 4, minute: 0 }]));
    const second = await page({ ...query("limit=2"), cursor: first.cursor }, all);
    expect(second.rows.map((row) => row.id)).toEqual(["portal:1"]);
    expect(second.cursor).toBeNull();
  });

  test("a source read to its end is not asked again on the next pages", async () => {
    const steward = paged(() => rowsOf("steward", [{ id: 1, minute: 0 }]));
    const portal = paged(() => rowsOf("portal", Array.from({ length: 6 }, (_, index) => ({ id: 6 - index, minute: index }))));
    const all = readers({ steward, portal });
    const { pages } = await everything("source=portal,steward&limit=2", all);
    expect(pages.length).toBe(4);
    expect(steward.calls).toBe(1);
    expect(pages.at(-1)!.sources.map((source) => source.name)).toEqual(["portal"]);
  });

  test("a range of dates: rows before `from` end the source's reading", async () => {
    const portal = paged(() => rowsOf("portal", Array.from({ length: 50 }, (_, index) => ({ id: 50 - index, minute: index * 10 }))), 5);
    const answer = await page(query(`source=portal&from=${new Date(T - 25 * MINUTE).toISOString()}&to=${new Date(T - 5 * MINUTE).toISOString()}`), readers({ portal }));
    expect(answer.rows.map((row) => row.id)).toEqual(["portal:49", "portal:48"]);
    expect(answer.cursor).toBeNull();
    expect(portal.calls).toBe(1);
  });

  test("a route that only exposes its latest entries says so once read to their end", async () => {
    const list = rowsOf("steward", Array.from({ length: 60 }, (_, index) => ({ id: 60 - index, minute: index })));
    const answer = await page(query("source=steward"), readers({ steward: windowed(list, 50) }));
    expect(answer.rows.length).toBe(50);
    expect(answer.sources).toEqual([{ name: "steward", state: "ok", message: null, window: 50 }]);
    const short = await page(query("source=steward"), readers({ steward: windowed(list.slice(0, 10), 50) }));
    expect(short.sources[0]!.window).toBeNull();
  });

  test("a cursor made under other filters is refused", async () => {
    const all = readers({ portal: paged(() => rowsOf("portal", Array.from({ length: 5 }, (_, index) => ({ id: 5 - index, minute: index })))) });
    const first = await page(query("limit=2"), all);
    expect(await aggregate({ ...query("limit=2&actor=ada"), cursor: first.cursor }, all, resolve)).toEqual({ error: "cursor: made under other filters, read the first page again" });
  });
});

describe("when a source lets the page down", () => {
  const portal = () => paged(() => rowsOf("portal", [{ id: 1, minute: 1 }]));

  test("a source down is said so, and the others are shown", async () => {
    const answer = await page(
      query(),
      readers({ portal: portal(), egress: { read: async () => ({ kind: "failed", state: "unavailable", message: "Can't reach the egress proxy." }) } }),
    );
    expect(answer.rows.map((row) => row.id)).toEqual(["portal:1"]);
    expect(answer.sources.find((source) => source.name === "egress")).toEqual({ name: "egress", state: "unavailable", message: "Can't reach the egress proxy.", window: null });
    // Not read again under this cursor: the page says it is down, and a refresh asks again.
    expect(answer.cursor).toBeNull();
  });

  test("a source not installed, or too old, is said so in the same way", async () => {
    const answer = await page(
      query("source=backups,steward"),
      readers({
        backups: { read: async () => ({ kind: "failed", state: "not-installed", message: "Backups aren't set up on this server." }) },
        steward: { read: async () => ({ kind: "failed", state: "outdated", message: "Run sitesolide upgrade." }) },
      }),
    );
    expect(answer.sources.map((source) => [source.name, source.state])).toEqual([
      ["backups", "not-installed"],
      ["steward", "outdated"],
    ]);
    expect(answer.rows).toEqual([]);
  });

  test("a reader that throws is a source unavailable, not a failed page", async () => {
    const answer = await page(query(), readers({ portal: portal(), steward: { read: () => Promise.reject(new Error("boom")) } }));
    expect(answer.rows.length).toBe(1);
    expect(answer.sources.find((source) => source.name === "steward")).toMatchObject({ state: "unavailable", message: "The dashboard could not read this source." });
  });

  test("a source that does not answer in time is left behind; the page answers within its deadline", async () => {
    const stalled: AuditReader = { read: () => new Promise(() => undefined) };
    const started = performance.now();
    const answer = await page(query(), readers({ portal: portal(), backups: stalled }), { fetchSize: 250, maxFetches: 4, deadlineMs: 150 });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(answer.rows.map((row) => row.id)).toEqual(["portal:1"]);
    expect(answer.sources.find((source) => source.name === "backups")).toMatchObject({ state: "unavailable", message: "Didn't answer in time." });
  });

  test("a source that fails after a first page keeps what it gave, and the next page goes on from there", async () => {
    let calls = 0;
    const list = rowsOf("portal", Array.from({ length: 6 }, (_, index) => ({ id: 6 - index, minute: index })));
    const flaky: AuditReader = {
      async read(after, size) {
        calls++;
        if (calls === 2) return { kind: "failed", state: "unavailable", message: "Can't reach the portal." };
        const left = list.filter((row) => after === null || isAfter(row.position, after));
        return { kind: "rows", rows: left.slice(0, Math.min(size, 2)), end: left.length <= 2, window: null };
      },
    };
    const first = await page(query("source=portal"), readers({ portal: flaky }));
    expect(first.rows.map((row) => row.id)).toEqual(["portal:6", "portal:5"]);
    expect(first.sources[0]).toMatchObject({ state: "unavailable" });
    const { rows } = await everything("source=portal", readers({ portal: flaky }));
    expect(rows.map((row) => row.id)).toEqual(list.map((row) => row.row.id));
  });

  test("a source that ignores where to start cannot loop: rows already read end it", async () => {
    const list = rowsOf("portal", [
      { id: 2, minute: 0 },
      { id: 1, minute: 1 },
    ]);
    const stubborn: AuditReader = { read: async () => ({ kind: "rows", rows: list, end: false, window: null }) };
    const { rows, pages } = await everything("source=portal&limit=1", readers({ portal: stubborn }));
    expect(rows.map((row) => row.id)).toEqual(["portal:2", "portal:1"]);
    expect(pages.length).toBeLessThanOrEqual(3);
  });
});

describe("the budget", () => {
  test("a source that matches little is read within its budget, and the page waits for it rather than misordering", async () => {
    // Portal: one match every 20 rows. Steward: a match a minute, ended.
    const portalRows = rowsOf(
      "portal",
      Array.from({ length: 100 }, (_, index) => ({ id: 100 - index, minute: index, action: index % 20 === 0 ? "portal.signin" : "portal.signout" })),
    );
    const stewardRows = rowsOf("steward", Array.from({ length: 10 }, (_, index) => ({ id: 10 - index, minute: index * 10, action: "portal.signin" })));
    const portal = paged(() => portalRows, 10);
    const all = readers({ portal, steward: paged(() => stewardRows) });
    const budget = { fetchSize: 10, maxFetches: 2, deadlineMs: 5_000 };

    const first = await page(query("action=portal.signin&limit=50"), all, budget);
    // Portal read 20 rows, down to minute 19: nothing older is shown yet.
    expect(portal.calls).toBe(2);
    expect(first.scanned).toBe(20 + 10);
    expect(first.rows.every((row) => Date.parse(row.at) >= T - 19 * MINUTE)).toBe(true);
    expect(first.cursor).not.toBeNull();

    const { rows } = await everything("action=portal.signin&limit=50", all, budget);
    const expected = sorted([...portalRows, ...stewardRows].map((one) => ({ ...one.row, site: null })).filter((one) => one.action === "portal.signin"));
    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
  });

  test("a page never holds more rows than its limit, nor asks a source more than its budget", async () => {
    const rows = machine(300, 3);
    const counted = Object.fromEntries(AUDIT_SOURCES.map((source) => [source, paged(() => rows[source], 50)])) as Record<AuditSource, ReturnType<typeof paged>>;
    const answer = await page(query("limit=500"), readers(counted), { fetchSize: 50, maxFetches: 3, deadlineMs: 5_000 });
    expect(answer.rows.length).toBeLessThanOrEqual(500);
    for (const source of AUDIT_SOURCES) expect(counted[source].calls).toBeLessThanOrEqual(3);
    expect(answer.scanned).toBeLessThanOrEqual(5 * 150);
  });
});
