import { beforeEach, describe, expect, test } from "bun:test";
import { accept, WINDOW_MS, forgetAll, MAX_TRACKED, tracked } from "../src/rate";

/**
 * The rate limit is the only thing separating a measurement from a number
 * someone inflates by hand: nothing authenticates ingestion, and nothing can.
 */
beforeEach(() => forgetAll());

describe("accept", () => {
  test("lets through up to the ceiling, then refuses", () => {
    const start = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(accept("visitor", start + i, 5)).toBe(true);
    }
    expect(accept("visitor", start + 6, 5)).toBe(false);
  });

  test("reopens at the next window", () => {
    const start = 1_000_000;
    accept("visitor", start, 1);
    expect(accept("visitor", start + 1, 1)).toBe(false);
    expect(accept("visitor", start + WINDOW_MS, 1)).toBe(true);
  });

  test("counts each visitor separately", () => {
    // The fingerprint already carries the address and the host: two visitors of
    // one same site must not get in each other's way, nor must the same visitor
    // multiply themselves by changing page.
    const start = 1_000_000;
    expect(accept("one", start, 1)).toBe(true);
    expect(accept("two", start, 1)).toBe(true);
    expect(accept("one", start, 1)).toBe(false);
  });

  test("does not accumulate fingerprints without end", () => {
    // It is the classic memory leak of a rate counter: without a ceiling, the
    // table grows with the number of distinct visitors and never comes down
    // again.
    const start = 1_000_000;
    for (let i = 0; i < MAX_TRACKED + 500; i++) {
      accept(`visitor-${i}`, start, 10);
    }
    expect(tracked()).toBeLessThanOrEqual(MAX_TRACKED);
  });

  test("forgets the closed windows when the table is full", () => {
    const start = 1_000_000;
    for (let i = 0; i < MAX_TRACKED; i++) accept(`old-${i}`, start, 10);

    // One window later, the old ones no longer have any reason to be tracked.
    accept("new", start + WINDOW_MS, 10);
    expect(tracked()).toBeLessThan(MAX_TRACKED);
  });
});
