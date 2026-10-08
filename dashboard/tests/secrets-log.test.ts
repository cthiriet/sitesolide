import { describe, expect, test } from "bun:test";
import {
  ACCESS_MAX_LINES,
  ACCESS_OPERATIONS,
  ACCESS_PRUNE_BYTES,
  ACCESS_RETENTION_MS,
  accessLogSeed,
  accessLogTopUp,
  createHistory,
  inWindow,
  isAccessChange,
  lineDate,
  type AccessWindow,
  isAccessLogFull,
  mergeLogs,
  pruneAccessLog,
  EARLIER_FIELDS,
  EARLIER_OPERATIONS,
  EARLIER_RESULTS,
  MAX_FIELD,
  OPERATIONS,
  RETURNED_ENTRIES,
  KEPT_LINES,
  MAX_LINES,
  MAX_PAGE_ENTRIES,
  latest,
  page,
  readPageQuery,
  encodeEntry,
  isValidEntry,
  reread,
  truncate,
} from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";

function entry(a: number, others: Partial<LogEntry> = {}): LogEntry {
  return { a, operation: "set", result: "ok", actor: "owner", member: null, slug: "cms", file: "cms.env", variable: "TOKEN", detail: null, ...others };
}

describe("encoding", () => {
  test("one JSON line ended by a newline, read back identical", () => {
    const line = encodeEntry(entry(1));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(reread(line)).toEqual([entry(1)]);
  });

  test("an extra field does not make it into the journal", () => {
    const withValue = { ...entry(1), value: "fake_live_secret" } as LogEntry;
    expect(encodeEntry(withValue)).not.toContain("fake_live_secret");
  });

  test("malformed entries throw", () => {
    const malformed: unknown[] = [
      entry(Number.NaN),
      entry(1, { operation: "lecture-massive" as LogEntry["operation"] }),
      entry(1, { result: "maybe" as LogEntry["result"] }),
      entry(1, { variable: "x".repeat(MAX_FIELD + 1) }),
      entry(1, { detail: "two\nlines" }),
      entry(1, { slug: 42 as unknown as string }),
    ];
    for (const bad of malformed) {
      expect(() => encodeEntry(bad as LogEntry)).toThrow();
    }
  });

  test("the length bound is inclusive", () => {
    expect(() => encodeEntry(entry(1, { detail: "x".repeat(MAX_FIELD) }))).not.toThrow();
  });
});

describe("tolerant re-reading", () => {
  test("corrupt, truncated or otherwise shaped lines are ignored", () => {
    const text = [
      encodeEntry(entry(1)).trim(),
      "{not json",
      encodeEntry(entry(2)).trim().slice(0, 30),
      JSON.stringify({ ...entry(3), unknown: true }),
      "[]",
      "null",
      "",
      encodeEntry(entry(4)).trim(),
    ].join("\n");
    expect(reread(text).map((e) => e.a)).toEqual([1, 4]);
  });

  test("an empty journal", () => {
    expect(reread("")).toEqual([]);
  });

  test("isValidEntry refuses what is not an object", () => {
    for (const value of [null, undefined, 1, "x", [entry(1)]]) {
      expect(isValidEntry(value)).toBe(false);
    }
  });
});

describe("latest", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => entry(i));

  test("the last N, the most recent first", () => {
    expect(latest(hundred, 3).map((e) => e.a)).toEqual([99, 98, 97]);
    expect(latest(hundred).length).toBe(RETURNED_ENTRIES);
    expect(latest(hundred.slice(0, 2), 50).map((e) => e.a)).toEqual([1, 0]);
    expect(latest(hundred, 0)).toEqual([]);
  });

  test("a site's own: its last N, not its own among everyone's last N", () => {
    const mixed = Array.from({ length: 100 }, (_, i) => entry(i, { slug: i % 10 === 0 ? "builder" : "cms" }));
    expect(latest(mixed, 3, "builder").map((e) => e.a)).toEqual([90, 80, 70]);
    expect(latest(mixed, 50, "builder").length).toBe(10);
    expect(latest(mixed, 50, "test-zone.invalid")).toEqual([]);
    expect(latest(mixed, 2, null).map((e) => e.a)).toEqual([99, 98]);
  });
});

/**
 * journal.jsonl on the VM outlives every deployment: the lines written before
 * the operations were translated still spell them in French, and the Activity
 * section has to keep showing them. Re-reading brings them to the current
 * names; writing never produces them again.
 */
describe("the history written before the operations were translated", () => {
  /**
   * A line exactly as the earlier steward wrote it, with no help from
   * encodeEntry: French field names as well as French values. The first
   * version of this helper wrote `file` and `result`, so every test below
   * passed while the journal in service, which spells them `fichier` and
   * `resultat`, came back empty.
   */
  const earlier = (operation: string, others: Record<string, unknown> = {}) =>
    `${JSON.stringify({ a: 1, operation, resultat: "ok", slug: "cms", fichier: "cms.env", variable: "TOKEN", detail: null, ...others })}\n`;

  test("every earlier name is read as the one that replaced it", () => {
    const expected: [string, LogEntry["operation"]][] = [
      ["deverrouillage", "unlock"],
      ["verrouillage", "lock"],
      ["lecture", "read"],
      ["pose", "set"],
      ["retrait", "remove"],
      ["creation", "create"],
      ["restauration", "restore"],
      ["remplacement", "replace"],
      ["motdepasse", "password"],
      ["redemarrage", "restart"],
      ["portail", "portal"],
    ];
    for (const [before, now] of expected) {
      const entries = reread(earlier(before));
      expect([before, entries.length]).toEqual([before, 1]);
      expect(entries[0]).toEqual({ a: 1, operation: now, result: "ok", actor: "owner", member: null, slug: "cms", file: "cms.env", variable: "TOKEN", detail: null });
    }
  });

  test("a restart's verdict is translated in the detail, the systemd state left alone", () => {
    const looping = reread(earlier("redemarrage", { detail: "boucle, activating/auto-restart, 3 restarts" }));
    expect(looping[0]).toMatchObject({ operation: "restart", detail: "looping, activating/auto-restart, 3 restarts" });
    const scheduled = reread(earlier("redemarrage", { detail: "actif, active/running, 0 restarts, scheduled" }));
    expect(scheduled[0]?.detail).toBe("active, active/running, 0 restarts, scheduled");
    // `echec` was the fourth verdict, and a refusal's detail is not a verdict.
    expect(reread(earlier("redemarrage", { detail: "echec, failed/failed, 0 restarts" }))[0]?.detail) //
      .toBe("failure, failed/failed, 0 restarts");
    expect(reread(earlier("motdepasse", { detail: "boucle" }))[0]?.detail).toBe("boucle");
  });

  test("an earlier line and a current one sit side by side, in the order they were written", () => {
    const text = earlier("pose") + encodeEntry(entry(2, { operation: "remove" }));
    expect(reread(text).map((e) => [e.a, e.operation])).toEqual([
      [1, "set"],
      [2, "remove"],
    ]);
  });

  test("the table reads, it never writes: an earlier name is still refused on encoding", () => {
    expect(() => encodeEntry(entry(1, { operation: "pose" as LogEntry["operation"] }))).toThrow();
  });

  test("no earlier name shadows a current one, and each points at a real operation", () => {
    for (const [before, now] of Object.entries(EARLIER_OPERATIONS)) {
      expect([before, OPERATIONS.includes(before as LogEntry["operation"])]).toEqual([before, false]);
      expect([before, OPERATIONS.includes(now)]).toEqual([before, true]);
    }
  });

  test("the lines of the journal in service are all read back", () => {
    // Their shapes, taken from /var/lib/sitesolide-steward/journal.jsonl on
    // 23 September 2026: 37 lines, of these five combinations, all of which
    // were dropped by the first version of the table.
    const text = [
      earlier("lecture"),
      earlier("deverrouillage"),
      earlier("deverrouillage", { resultat: "refus" }),
      earlier("verrouillage"),
      earlier("portail", { fichier: null, variable: null }),
    ].join("");
    expect(reread(text).map((e) => [e.operation, e.result])).toEqual([
      ["read", "ok"],
      ["unlock", "ok"],
      ["unlock", "rejects"],
      ["lock", "ok"],
      ["portal", "ok"],
    ]);
  });

  test("an earlier result is read as the one that replaced it", () => {
    expect(reread(earlier("redemarrage", { resultat: "echec" }))[0]?.result).toBe("failure");
  });

  test("a line carrying a field under both names stays refused", () => {
    // An earlier name only stands in for an absent current one: otherwise one
    // of the two values would be dropped without anything saying so.
    expect(reread(earlier("lecture", { file: "other.env" }))).toEqual([]);
  });

  test("every earlier field and result points at a current one", () => {
    const current = Object.keys(entry(1)).sort();
    for (const [before, now] of Object.entries(EARLIER_FIELDS)) {
      expect([before, current.includes(before), current.includes(now)]).toEqual([before, false, true]);
    }
    for (const now of Object.values(EARLIER_RESULTS)) expect(["ok", "rejects", "failure"]).toContain(now);
  });

  test("a name that is neither earlier nor current stays refused", () => {
    expect(reread(earlier("lecture-massive"))).toEqual([]);
    // And nothing is fetched from the prototype.
    expect(reread(earlier("constructor"))).toEqual([]);
    expect(reread(earlier("toString"))).toEqual([]);
  });
});

describe("the new operations", () => {
  test("replace, password and portal encode and read back", () => {
    for (const operation of ["replace", "password", "portal"] as const) {
      const line = encodeEntry(entry(1, { operation, variable: null, detail: "on, ok" }));
      expect(reread(line)[0]!.operation).toBe(operation);
    }
  });

  test("a file in a subdirectory and the landing's directory are journalled", () => {
    const line = encodeEntry(entry(1, { slug: "test-zone.invalid", file: "builder-secrets/registry" }));
    expect(reread(line)[0]).toMatchObject({ slug: "test-zone.invalid", file: "builder-secrets/registry" });
  });
});

describe("truncation", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

  test("nothing to do up to and including the limit", () => {
    expect(truncate(lines(MAX_LINES))).toBeNull();
    expect(truncate("")).toBeNull();
  });

  test("beyond it, the last lines are kept", () => {
    const truncated = truncate(lines(MAX_LINES + 1));
    expect(truncated).not.toBeNull();
    const kept = truncated!.split("\n").filter((line) => line !== "");
    expect(kept.length).toBe(KEPT_LINES);
    expect(kept[0]).toBe(`line ${MAX_LINES + 1 - KEPT_LINES}`);
    expect(kept[kept.length - 1]).toBe(`line ${MAX_LINES}`);
    expect(truncated!.endsWith("\n")).toBe(true);
  });
});

describe("pages, for the Activity page", () => {
  test("asked for nothing, the route answers as it always did", () => {
    expect(readPageQuery(new URLSearchParams("slug=cms"))).toBeNull();
  });

  test("a limit, and a date to read before, bounded", () => {
    expect(readPageQuery(new URLSearchParams("limit=200&before=1700000000000"))).toEqual({ limit: 200, before: 1_700_000_000_000 });
    expect(readPageQuery(new URLSearchParams("limit=1"))).toEqual({ limit: 1, before: null });
    for (const query of ["before=5", "limit=0", `limit=${MAX_PAGE_ENTRIES + 1}`, "limit=2.5", "limit=x", "limit=1&limit=2", "limit=1&before=-1", "limit=1&before=soon"]) {
      expect(readPageQuery(new URLSearchParams(query))).toHaveProperty("error");
    }
  });

  test("by date, newest first, the last appended first within one millisecond", () => {
    // Appended in this order; the clock went back between the second and the third.
    const entries = [entry(10, { variable: "A" }), entry(30, { variable: "B" }), entry(20, { variable: "C" }), entry(30, { variable: "D" })];
    expect(page(entries, { limit: 10, before: null }).map((one) => one.variable)).toEqual(["D", "B", "C", "A"]);
    expect(page(entries, { limit: 2, before: null }).map((one) => one.variable)).toEqual(["D", "B"]);
    expect(page(entries, { limit: 10, before: 30 }).map((one) => one.variable)).toEqual(["C", "A"]);
    expect(page(entries, { limit: 10, before: 31 }).map((one) => one.variable)).toEqual(["D", "B", "C", "A"]);
  });

  test("of one site when it is named", () => {
    const entries = [entry(1, { slug: "cms" }), entry(2, { slug: "shop" }), entry(3, { slug: "cms" })];
    expect(page(entries, { limit: 10, before: null }, "cms").map((one) => one.a)).toEqual([3, 1]);
  });
});

describe("the access log", () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = 1_800_000_000_000;
  const access = (a: number, others: Partial<LogEntry> = {}) =>
    entry(a, { operation: "access.add", actor: "owner", member: "carol@acme.test", slug: "blog", file: null, variable: null, detail: "carol@acme.test: Can open", ...others });
  const text = (entries: LogEntry[]) => entries.map(encodeEntry).join("");

  test("an accepted change of access goes there, a refusal and everything else stay in the journal", () => {
    for (const operation of ["access.add", "access.change", "access.remove", "access.migrate", "people.create", "portal", "project.create", "project.remove"] as const) {
      expect(isAccessChange(access(1, { operation }))).toBe(true);
      expect(isAccessChange(access(1, { operation, result: "rejects" }))).toBe(false);
      expect(isAccessChange(access(1, { operation, result: "failure" }))).toBe(false);
    }
    // The names an earlier steward wrote changes of access under.
    for (const operation of ["member.invite", "member.role", "member.remove", "sharing", "guest.create", "guest.revoke"] as const) {
      expect(isAccessChange(access(1, { operation }))).toBe(true);
    }
    for (const operation of ["unlock", "read", "set", "dashboard.signin", "member.signin", "token.create", "restart"] as const) {
      expect(isAccessChange(access(1, { operation }))).toBe(false);
    }
    for (const operation of ACCESS_OPERATIONS) expect(OPERATIONS).toContain(operation);
  });

  test("pruned by age: older than 180 days goes, the very day of the bound stays; nothing dropped, nothing rewritten", () => {
    const lines = [access(NOW - ACCESS_RETENTION_MS - 1, { detail: "old" }), access(NOW - ACCESS_RETENTION_MS, { detail: "bound" }), access(NOW - DAY, { detail: "recent" })];
    const pruned = pruneAccessLog(text(lines), NOW);
    expect(pruned).not.toBeNull();
    expect(reread(pruned!).map((one) => one.detail)).toEqual(["bound", "recent"]);
    expect(pruned!.endsWith("\n")).toBe(true);
    expect(pruneAccessLog(pruned!, NOW)).toBeNull();
    expect(pruneAccessLog("", NOW)).toBeNull();
    // Everything too old: an empty file, not a refusal to prune.
    expect(pruneAccessLog(text([access(NOW - 200 * DAY)]), NOW)).toBe("");
  });

  test("never pushed out young: however many rows younger than 180 days, every one stays; the steward refuses changes instead", () => {
    const lines = Array.from({ length: 30_000 }, (_, i) => access(NOW - DAY, { detail: `line ${i}` }));
    expect(pruneAccessLog(text(lines), NOW)).toBeNull();
    expect(ACCESS_MAX_LINES).toBe(20_000);
    expect(ACCESS_RETENTION_MS).toBe(180 * DAY);
    // Full by its lines, or by its bytes, the longer rows' bound.
    expect(isAccessLogFull({ lines: ACCESS_MAX_LINES - 1, bytes: 1 })).toBe(false);
    expect(isAccessLogFull({ lines: ACCESS_MAX_LINES, bytes: 1 })).toBe(true);
    expect(isAccessLogFull({ lines: 1, bytes: ACCESS_PRUNE_BYTES })).toBe(true);
  });

  test("an access log seeded by an earlier steward is topped up once with the journal's changes it lacks, general access and projects included", () => {
    const seeded = text([access(NOW - 10 * DAY, { detail: "seeded" })]);
    const journal = text([
      access(NOW - 200 * DAY, { operation: "portal", detail: "too old" }),
      access(NOW - 10 * DAY, { detail: "seeded" }),
      access(NOW - 9 * DAY, { operation: "portal", detail: "on, ok" }),
      access(NOW - 8 * DAY, { operation: "project.create", detail: "admin" }),
      access(NOW - 7 * DAY, { operation: "portal", result: "rejects", detail: "invalid" }),
      entry(NOW - 6 * DAY),
    ]);
    const added = accessLogTopUp(journal, seeded, NOW);
    expect(reread(added).map((one) => one.detail)).toEqual(["on, ok", "admin"]);
    // Topped up, nothing more to add.
    expect(accessLogTopUp(journal, seeded + added, NOW)).toBe("");
  });

  test("a line that carries no date is dropped: no reader could read it either", () => {
    const kept = access(NOW - DAY);
    const pruned = pruneAccessLog(`${encodeEntry(kept)}{"a":"soon"}\n{torn\n[]\n`, NOW);
    expect(pruned).toBe(encodeEntry(kept));
  });

  test("seeded from the journal with its accepted changes of access alone, a line from before the actor was named included", () => {
    const earlier = JSON.stringify({ a: 5, operation: "sharing", result: "ok", slug: "blog", file: null, variable: null, detail: "on" });
    const journal = [
      encodeEntry(entry(1)),
      encodeEntry(access(2)),
      encodeEntry(access(3, { result: "rejects", detail: "refused" })),
      encodeEntry(access(4, { operation: "people.create", slug: null, detail: "carol@acme.test: may create projects" })),
      `${earlier}\n`,
      "{torn",
    ].join("");
    const seed = accessLogSeed(journal);
    expect(reread(seed).map((one) => [one.a, one.operation, one.actor])).toEqual([
      [2, "access.add", "owner"],
      [4, "people.create", "owner"],
      [5, "sharing", "owner"],
    ]);
    // In the journal's very format: encoded again, read back the same.
    expect(text(reread(seed))).toBe(seed);
    expect(accessLogSeed("")).toBe("");
  });

  test("one history: by date, the journal's lines before the access log's within a millisecond, each file in its order", () => {
    const journal = [entry(10, { variable: "J1" }), entry(30, { variable: "J2" }), entry(20, { variable: "J3" }), entry(30, { variable: "J4" })];
    const accessLog = [access(15, { detail: "A1" }), access(30, { detail: "A2" }), access(30, { detail: "A3" })];
    const merged = mergeLogs(journal, accessLog);
    expect(merged.map((one) => one.variable ?? one.detail)).toEqual(["J1", "A1", "J3", "J2", "J4", "A2", "A3"]);
    // `latest` takes the end of it, `page` its dates, both newest first.
    expect(latest(merged, 3).map((one) => one.variable ?? one.detail)).toEqual(["A3", "A2", "J4"]);
    expect(page(merged, { limit: 3, before: null }).map((one) => one.variable ?? one.detail)).toEqual(["A3", "A2", "J4"]);
    expect(page(merged, { limit: 10, before: 30 }).map((one) => one.variable ?? one.detail)).toEqual(["J3", "A1", "J1"]);
    // Asked again, the same order.
    expect(mergeLogs(journal, accessLog)).toEqual(merged);
  });

  test("a change of access in both files is shown once, from the access log; one the access log lacks stays; refusals stay", () => {
    const journal = [entry(1), access(2, { detail: "seeded" }), access(3, { result: "rejects", detail: "refused" }), access(4, { operation: "portal", detail: "on, ok" })];
    const accessLog = [access(2, { detail: "seeded" }), access(5, { detail: "new" })];
    expect(mergeLogs(journal, accessLog).map((one) => one.detail ?? one.variable)).toEqual(["TOKEN", "seeded", "refused", "on, ok", "new"]);
    // No access log yet: the journal is read whole.
    expect(mergeLogs(journal, null).map((one) => one.detail ?? one.variable)).toEqual(["TOKEN", "seeded", "refused", "on, ok"]);
    // Of one site, as before.
    expect(latest(mergeLogs(journal, [...accessLog, access(5, { slug: "shop", detail: "shop" })]), 50, "shop").map((one) => one.detail)).toEqual(["shop"]);
  });
});

describe("GET /log's history, read anew for each request", () => {
  const NOW = 1_800_000_000_000;
  const row = (i: number, others: Partial<LogEntry> = {}): LogEntry => ({
    a: NOW - 3_600_000 + i,
    operation: "access.add",
    result: "ok",
    actor: "owner",
    member: `person${i}@acme.test`,
    slug: "blog",
    file: null,
    variable: null,
    detail: `person${i}@acme.test: Can open`,
    ...others,
  });

  function source(accessText: string | null) {
    const counts = { journal: 0, access: 0 };
    const windows: AccessWindow[] = [];
    return {
      counts,
      windows,
      source: {
        readJournal: async () => {
          counts.journal++;
          return encodeEntry({ ...row(0), operation: "unlock", member: null, slug: null, detail: null });
        },
        readAccessLog: async (window: AccessWindow) => {
          counts.access++;
          windows.push(window);
          return accessText;
        },
      },
    };
  }

  test("each request reads the journal and its own window of the access log, and nothing is kept between two", async () => {
    const bench = source(Array.from({ length: 60 }, (_, i) => encodeEntry(row(i))).join(""));
    const history = createHistory(bench.source);
    expect(await history.read({ before: null, slug: null, need: 50 }, (entries) => latest(entries, 50).length)).toBe(50);
    expect(await history.read({ before: NOW, slug: "blog", need: 500 }, (entries) => entries.length)).toBe(61);
    expect(bench.counts).toEqual({ journal: 2, access: 2 });
    expect(bench.windows).toEqual([
      { before: null, slug: null, need: 50 },
      { before: NOW, slug: "blog", need: 500 },
    ]);
    // No access log yet: the journal alone, as before it.
    expect(await createHistory(source(null).source).read({ before: null, slug: null, need: 50 }, (entries) => entries.map((one) => one.operation))).toEqual(["unlock"]);
  });

  test("one read at a time: a burst never runs two in parallel", async () => {
    const history = createHistory(source("").source);
    let running = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 16 }, () =>
        history.read({ before: null, slug: null, need: 50 }, async () => {
          running++;
          most = Math.max(most, running);
          await Bun.sleep(1);
          running--;
        }),
      ),
    );
    expect(most).toBe(1);
  });

  test("a line is dated where encodeEntry writes the date, without being parsed, and parsed when written otherwise", () => {
    expect(lineDate(encodeEntry(row(5)))).toBe(NOW - 3_600_000 + 5);
    expect(lineDate(JSON.stringify({ operation: "sharing", a: 42 }))).toBe(42);
    expect(lineDate('{"a":"soon"}')).toBeNull();
    expect(lineDate("{torn")).toBeNull();
    expect(lineDate("[]")).toBeNull();
  });

  test("a window takes the rows dated before its date, of its site when it names one", () => {
    const blog = encodeEntry(row(1)).trimEnd();
    const shop = encodeEntry(row(2, { slug: "shop", detail: '"slug":"blog" in a detail' })).trimEnd();
    expect(inWindow(blog, { before: null, slug: null })).toBe(true);
    expect(inWindow(blog, { before: row(1).a, slug: null })).toBe(false);
    expect(inWindow(blog, { before: row(1).a + 1, slug: "blog" })).toBe(true);
    // A slug quoted inside a detail is escaped there: it never matches.
    expect(inWindow(shop, { before: null, slug: "blog" })).toBe(false);
    expect(inWindow(shop, { before: null, slug: "shop" })).toBe(true);
    // Written in another order, by an earlier steward: parsed, and judged the same.
    const earlier = JSON.stringify({ operation: "sharing", result: "ok", slug: "blog", file: null, variable: null, detail: "on", a: 7 });
    expect(inWindow(earlier, { before: 8, slug: "blog" })).toBe(true);
    expect(inWindow(earlier, { before: 8, slug: "shop" })).toBe(false);
    expect(inWindow("not json", { before: null, slug: null })).toBe(false);
  });

  test("an access log topped up from a walk over its lines finds the same as from its text", () => {
    const seeded = encodeEntry(row(1, { detail: "seeded" }));
    const journal = encodeEntry(row(1, { detail: "seeded" })) + encodeEntry(row(2, { detail: "journal only" }));
    const lines: string[] = [];
    const walked = accessLogTopUp(journal, (visit) => seeded.split("\n").forEach((line) => (lines.push(line), visit(line))), NOW);
    expect(walked).toBe(accessLogTopUp(journal, seeded, NOW));
    expect(reread(walked).map((one) => one.detail)).toEqual(["journal only"]);
    expect(lines.length).toBeGreaterThan(0);
  });
});
