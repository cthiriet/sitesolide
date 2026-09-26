import { describe, expect, test } from "bun:test";
import {
  EARLIER_FIELDS,
  EARLIER_OPERATIONS,
  EARLIER_RESULTS,
  MAX_FIELD,
  OPERATIONS,
  RETURNED_ENTRIES,
  KEPT_LINES,
  MAX_LINES,
  latest,
  encodeEntry,
  isValidEntry,
  reread,
  truncate,
} from "../src/secrets/log";
import type { LogEntry } from "../src/secrets/protocol";

function entry(a: number, others: Partial<LogEntry> = {}): LogEntry {
  return { a, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "TOKEN", detail: null, ...others };
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
      expect(entries[0]).toEqual({ a: 1, operation: now, result: "ok", slug: "cms", file: "cms.env", variable: "TOKEN", detail: null });
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
