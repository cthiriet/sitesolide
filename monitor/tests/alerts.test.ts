import { describe, expect, test } from "bun:test";
import { FAIL_AFTER, RECOVER_AFTER, advance, isBad, isDown, type Notice, type Tracked } from "../src/alerts";
import type { Kind, Result, Verdict } from "../src/checks";

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const MINUTE = 60_000;

function result(verdict: Verdict, id = "site:cms.test-zone.invalid", kind: Kind = "site"): Result {
  return {
    id,
    kind,
    label: id.split(":")[1] ?? id,
    severity: kind === "certificate" ? "warning" : "critical",
    slug: "cms",
    verdict,
    summary: verdict === "fail" ? "https://cms.test-zone.invalid/ answered 502" : "https://cms.test-zone.invalid/ answered 200",
  };
}

/** Runs one verdict per minute through the state machine, and collects every notice. */
function replay(verdicts: Verdict[]): { notices: Notice[]; checks: Record<string, Tracked> } {
  let checks: Record<string, Tracked> = {};
  const notices: Notice[] = [];
  verdicts.forEach((verdict, minute) => {
    const next = advance(checks, [result(verdict)], T0 + minute * MINUTE);
    checks = next.checks;
    notices.push(...next.notices);
  });
  return { notices, checks };
}

const events = (notices: Notice[]) => notices.map((notice) => notice.event);

describe("the alert state machine", () => {
  test("two failures in a row before down, two successes before recovered", () => {
    expect(FAIL_AFTER).toBe(2);
    expect(RECOVER_AFTER).toBe(2);
  });

  test("down once, recovered once, nothing in between, however long it lasts", () => {
    const { notices } = replay(["ok", "fail", "fail", ...Array<Verdict>(30).fill("fail"), "ok", "ok", ...Array<Verdict>(30).fill("ok")]);
    expect(events(notices)).toEqual(["down", "recovered"]);
  });

  test("the down notice dates the failure from its first failed verdict, not from the alert", () => {
    const { notices } = replay(["ok", "fail", "fail"]);
    expect(notices[0]).toMatchObject({ event: "down", at: T0 + 2 * MINUTE, since: T0 + MINUTE, severity: "critical", slug: "cms" });
    expect(notices[0]!.summary).toBe("https://cms.test-zone.invalid/ answered 502");
  });

  test("the recovered notice says when the failure began, and the memory counts the good time anew", () => {
    const { notices, checks } = replay(["fail", "fail", "fail", "ok", "ok"]);
    const recovered = notices.find((notice) => notice.event === "recovered")!;
    expect(recovered).toMatchObject({ at: T0 + 4 * MINUTE, since: T0 });
    expect(recovered.summary).toBe("https://cms.test-zone.invalid/ answered 200");
    expect(checks["site:cms.test-zone.invalid"]).toMatchObject({ status: "ok", since: T0 + 4 * MINUTE });
  });

  test("a single failed probe, a deployment's restart, says nothing", () => {
    expect(replay(["ok", "fail", "ok", "ok", "fail", "ok"]).notices).toEqual([]);
  });

  test("a site that blinks while down stays down without a word", () => {
    const { notices, checks } = replay(["fail", "fail", "ok", "fail", "ok", "fail"]);
    expect(events(notices)).toEqual(["down"]);
    expect(checks["site:cms.test-zone.invalid"]!.status).toBe("down");
  });

  test("a check that flaps every minute costs one down, then silence, never a storm", () => {
    const flapping = Array.from({ length: 60 }, (_, minute): Verdict => (minute % 2 === 0 ? "fail" : "ok"));
    // Never two failures in a row: never down at all.
    expect(replay(flapping).notices).toEqual([]);
    const worse = Array.from({ length: 60 }, (_, minute): Verdict => (minute % 3 === 2 ? "ok" : "fail"));
    // Two failures then one success, over and over: down once, and the lone
    // success never clears it.
    expect(events(replay(worse).notices)).toEqual(["down"]);
  });

  test("an unknown verdict neither confirms nor clears", () => {
    expect(replay(["fail", "unknown", "unknown", "fail"]).notices.map((n) => [n.event, n.at])).toEqual([["down", T0 + 3 * MINUTE]]);
    const { notices, checks } = replay(["fail", "fail", "unknown", "ok", "unknown", "ok"]);
    expect(events(notices)).toEqual(["down", "recovered"]);
    expect(checks["site:cms.test-zone.invalid"]!.status).toBe("ok");
  });

  test("an unknown verdict keeps the last summary that was actually seen", () => {
    const first = advance({}, [result("fail")], T0);
    const second = advance(first.checks, [{ ...result("unknown"), summary: "not probed: Caddy is not running" }], T0 + MINUTE);
    expect(second.checks["site:cms.test-zone.invalid"]!.summary).toBe("https://cms.test-zone.invalid/ answered 502");
  });

  test("a check that was down and is no longer produced is cleared once, then forgotten", () => {
    const down = replay(["fail", "fail"]).checks;
    const gone = advance(down, [], T0 + 5 * MINUTE);
    expect(events(gone.notices)).toEqual(["cleared"]);
    expect(gone.notices[0]).toMatchObject({ id: "site:cms.test-zone.invalid", since: T0 });
    expect(gone.checks).toEqual({});
    expect(advance(gone.checks, [], T0 + 6 * MINUTE).notices).toEqual([]);
  });

  test("a check that disappears while fine goes without a word", () => {
    const fine = replay(["ok", "fail"]).checks;
    expect(advance(fine, [], T0 + 5 * MINUTE)).toEqual({ checks: {}, notices: [] });
  });

  test("a kind the run could not read as a whole is kept as it was", () => {
    const down = replay(["fail", "fail"]).checks;
    const blind = advance(down, [], T0 + 5 * MINUTE, new Set<Kind>(["site"]));
    expect(blind.notices).toEqual([]);
    expect(blind.checks).toEqual(down);
  });

  test("several checks going down in one run give one notice each, in the order of the results", () => {
    const results = [result("fail", "caddy", "caddy"), result("fail", "site:a.test-zone.invalid"), result("fail", "site:b.test-zone.invalid")];
    const first = advance({}, results, T0);
    const second = advance(first.checks, results, T0 + MINUTE);
    expect(second.notices.map((notice) => notice.id)).toEqual(["caddy", "site:a.test-zone.invalid", "site:b.test-zone.invalid"]);
    expect(advance(second.checks, results, T0 + 2 * MINUTE).notices).toEqual([]);
  });

  test("down for the outside world means alerted and not yet recovered", () => {
    const at = (status: Tracked["status"]): Tracked => ({
      kind: "site",
      label: "x",
      severity: "critical",
      slug: null,
      status,
      streak: 0,
      since: T0,
      summary: "",
    });
    expect([at("ok"), at("failing"), at("down"), at("recovering")].map(isDown)).toEqual([false, false, true, true]);
    expect([undefined, at("ok"), at("failing"), at("recovering")].map(isBad)).toEqual([false, false, true, true]);
  });
});
