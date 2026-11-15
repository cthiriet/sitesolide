import { describe, expect, test } from "bun:test";
import {
  TOLERATED_FAILURES,
  INITIAL_BACKOFF_MS,
  MAXIMUM_BACKOFF_MS,
  PASSWORD_MAX,
  remainingWait,
  isPasswordValid,
  isAcceptableSubmission,
  clientKey,
  createClientLimiter,
  FORGET_AFTER_MS,
} from "../src/auth";

describe("rate limiting", () => {
  test("the first failures do not rate limit", () => {
    for (let failures = 0; failures <= TOLERATED_FAILURES; failures++) {
      expect(remainingWait(failures, 1000, 1000)).toBe(0);
    }
  });

  test("the first failure too many waits the initial delay", () => {
    expect(remainingWait(TOLERATED_FAILURES + 1, 1000, 1000)).toBe(INITIAL_BACKOFF_MS);
  });

  test("the delay doubles on every failure", () => {
    expect(remainingWait(TOLERATED_FAILURES + 2, 0, 0)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(remainingWait(TOLERATED_FAILURES + 3, 0, 0)).toBe(INITIAL_BACKOFF_MS * 4);
  });

  test("the delay caps at one hour", () => {
    expect(remainingWait(TOLERATED_FAILURES + 40, 0, 0)).toBe(MAXIMUM_BACKOFF_MS);
  });

  test("time already elapsed is deducted, and the way reopens", () => {
    const start = 10_000;
    expect(remainingWait(TOLERATED_FAILURES + 1, start, start + 2000)).toBe(INITIAL_BACKOFF_MS - 2000);
    expect(remainingWait(TOLERATED_FAILURES + 1, start, start + INITIAL_BACKOFF_MS)).toBe(0);
  });
});

describe("submission", () => {
  test("refuses what is not a string, the empty and the too long", () => {
    expect(isAcceptableSubmission(undefined)).toBe(false);
    expect(isAcceptableSubmission(42)).toBe(false);
    expect(isAcceptableSubmission("")).toBe(false);
    expect(isAcceptableSubmission("x".repeat(PASSWORD_MAX + 1))).toBe(false);
    expect(isAcceptableSubmission("x".repeat(PASSWORD_MAX))).toBe(true);
  });
});

describe("verification", () => {
  test("a missing hash refuses everyone", async () => {
    expect(await isPasswordValid("anything at all", "")).toBe(false);
  });

  test("a malformed hash refuses instead of throwing", async () => {
    expect(await isPasswordValid("anything at all", "$argon2id$truncated")).toBe(false);
  });

  test("the right password passes, another does not", async () => {
    const hash = await Bun.password.hash("the right one", "argon2id");
    expect(await isPasswordValid("the right one", hash)).toBe(true);
    expect(await isPasswordValid("the right one ", hash)).toBe(false);
    expect(await isPasswordValid("", hash)).toBe(false);
  });
});

describe("clientKey", () => {
  test("takes the last address, the one Caddy saw, and an IPv6 address by its /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("198.51.100.1, 203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::9")).toBe(clientKey("2001:db8:1:2:ffff::1"));
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("[2001:0db8:0001:0002::1]")).toBe("2001:db8:1:2::/64");
    expect(clientKey(null)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
    expect(clientKey("not an address")).toBe("unknown");
  });
});

describe("createClientLimiter", () => {
  test("one client's failures make that client wait, and nobody else", () => {
    const limiter = createClientLimiter();
    for (let i = 0; i < TOLERATED_FAILURES; i += 1) limiter.failed("a", 0);
    expect(limiter.wait("a", 0)).toBe(0);
    limiter.failed("a", 0);
    expect(limiter.wait("a", 0)).toBe(INITIAL_BACKOFF_MS);
    expect(limiter.wait("b", 0)).toBe(0);
    limiter.succeeded("a");
    expect(limiter.wait("a", 0)).toBe(0);
  });

  test("failures nobody added to for a day are forgotten", () => {
    const limiter = createClientLimiter();
    for (let i = 0; i < 20; i += 1) limiter.failed("a", 0);
    expect(limiter.wait("a", 1000)).toBe(MAXIMUM_BACKOFF_MS - 1000);
    limiter.failed("a", FORGET_AFTER_MS);
    expect(limiter.wait("a", FORGET_AFTER_MS)).toBe(0);
  });
});
