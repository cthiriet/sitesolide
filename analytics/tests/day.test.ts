import { describe, expect, test } from "bun:test";
import { dayWindow, dayOf, isValidDay, minusDays } from "../src/day";

/**
 * The cutting up of days carries all the rest: a report's window, the grouping
 * of visits, and the lifetime of a salt. An error of one day here moves visits
 * from one day to another without anything signalling it.
 */
describe("dayOf", () => {
  test("cuts in the requested time zone, not in the machine's", () => {
    // 10:30 pm UTC is the next day in Paris, in summer as in winter.
    const evening = Date.parse("2026-09-20T22:30:00Z");
    expect(dayOf(evening, "Europe/Paris")).toBe("2026-09-21");
    expect(dayOf(evening, "UTC")).toBe("2026-09-20");
  });

  test("holds in winter time, where the gap is no longer the same", () => {
    const evening = Date.parse("2026-12-20T22:30:00Z");
    expect(dayOf(evening, "Europe/Paris")).toBe("2026-12-20");
  });

  test("always returns AAAA-MM-JJ, which sorts like a string", () => {
    expect(dayOf(Date.parse("2026-01-05T12:00:00Z"), "Europe/Paris")).toBe("2026-01-05");
  });
});

describe("isValidDay", () => {
  test("accepts a real date", () => {
    expect(isValidDay("2026-02-28")).toBe(true);
  });

  test("refuses a date the calendar does not have", () => {
    // The pattern alone would let 30 February through: the reconstruction does
    // not.
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-13-01")).toBe(false);
  });

  test("refuses what does not have the form", () => {
    expect(isValidDay("20/09/2026")).toBe(false);
    expect(isValidDay("")).toBe(false);
  });
});

describe("minusDays", () => {
  test("crosses a change of month", () => {
    expect(minusDays("2026-03-01", 1)).toBe("2026-02-28");
  });

  test("crosses the switch to summer time without losing a day", () => {
    // The night of 29 March 2026 lasts only 23 hours in Paris. Starting from
    // noon UTC is what puts the arithmetic out of reach.
    expect(minusDays("2026-03-30", 1)).toBe("2026-03-29");
    expect(minusDays("2026-03-30", 2)).toBe("2026-03-28");
  });

  test("moves forward when given a negative number", () => {
    expect(minusDays("2026-09-20", -1)).toBe("2026-09-21");
  });
});

describe("dayWindow", () => {
  test("returns the days from oldest to most recent, the last included", () => {
    expect(dayWindow("2026-03-02", 4)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  test("returns exactly the number of days requested", () => {
    expect(dayWindow("2026-09-20", 30)).toHaveLength(30);
    expect(dayWindow("2026-09-20", 1)).toEqual(["2026-09-20"]);
  });
});
