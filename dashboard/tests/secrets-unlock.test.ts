import { describe, expect, test } from "bun:test";
import { TOLERATED_FAILURES, INITIAL_BACKOFF_MS, MAXIMUM_BACKOFF_MS, isPasswordValid } from "../src/auth";
import {
  SAFETY_FAILURES,
  INITIAL_STATE,
  wait,
  hashFrom,
  encodeRateLimit,
  attemptAccepted,
  attemptRefused,
  isValidToken,
  readRateLimit,
  hashFileRefusal,
  revoke,
  type UnlockState,
} from "../src/secrets/unlock";
import type { FileInfo } from "../src/secrets/scope";
import { UNLOCK_DURATION_MS } from "../src/secrets/protocol";
import { TOKEN_BYTES } from "../src/sessions";

const T0 = 1_789_000_000_000;

function refuse(times: number, a: number): UnlockState {
  let state = INITIAL_STATE;
  for (let i = 0; i < times; i++) state = attemptRefused(state, a);
  return state;
}

describe("rate limiting", () => {
  test("free at the start and through the tolerated failures", () => {
    expect(wait(INITIAL_STATE, T0)).toBe(0);
    expect(wait(refuse(TOLERATED_FAILURES, T0), T0)).toBe(0);
  });

  test("then 5 s doubling, capped at one hour", () => {
    expect(wait(refuse(TOLERATED_FAILURES + 1, T0), T0)).toBe(INITIAL_BACKOFF_MS);
    expect(wait(refuse(TOLERATED_FAILURES + 2, T0), T0)).toBe(INITIAL_BACKOFF_MS * 2);
    expect(wait(refuse(TOLERATED_FAILURES + 50, T0), T0)).toBe(MAXIMUM_BACKOFF_MS);
  });

  test("time elapsed since the last failure is deducted", () => {
    const state = refuse(TOLERATED_FAILURES + 1, T0);
    expect(wait(state, T0 + 2000)).toBe(INITIAL_BACKOFF_MS - 2000);
    expect(wait(state, T0 + INITIAL_BACKOFF_MS)).toBe(0);
  });

  test("a success resets the failures to zero", async () => {
    const { state } = await attemptAccepted(refuse(TOLERATED_FAILURES + 5, T0), T0);
    expect(state.failures).toBe(0);
    expect(wait(state, T0)).toBe(0);
  });

  test("the transitions do not modify the state they receive", () => {
    const before = refuse(1, T0);
    attemptRefused(before, T0 + 1);
    revoke(before);
    expect(before).toEqual({ failures: 1, lastFailureAt: T0, token: null });
  });
});

describe("token", () => {
  test("32 bytes in base64url, kept by its hash alone", async () => {
    const { state, token, expiresAt } = await attemptAccepted(INITIAL_STATE, T0, () => new Uint8Array(TOKEN_BYTES).fill(7));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(T0 + UNLOCK_DURATION_MS);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(state.token?.hash).toHaveLength(64);
  });

  test("valid up to the millisecond before the deadline, not beyond", async () => {
    const { state, token } = await attemptAccepted(INITIAL_STATE, T0);
    expect(await isValidToken(state, token, T0)).toBe(true);
    expect(await isValidToken(state, token, T0 + UNLOCK_DURATION_MS - 1)).toBe(true);
    expect(await isValidToken(state, token, T0 + UNLOCK_DURATION_MS)).toBe(false);
  });

  test("use does not extend it: the deadline stays the unlock's own", async () => {
    const { state, token } = await attemptAccepted(INITIAL_STATE, T0);
    for (let t = T0; t < T0 + UNLOCK_DURATION_MS; t += 60_000) {
      expect(await isValidToken(state, token, t)).toBe(true);
    }
    expect(state.token?.expiresAt).toBe(T0 + UNLOCK_DURATION_MS);
    expect(await isValidToken(state, token, T0 + UNLOCK_DURATION_MS)).toBe(false);
  });

  test("a wrong, empty, over-long or differently typed token is refused", async () => {
    const { state, token } = await attemptAccepted(INITIAL_STATE, T0);
    for (const submitted of [`${token}x`, token.slice(1), "", "x".repeat(10_000), undefined, null, 42, [token]]) {
      expect(await isValidToken(state, submitted, T0)).toBe(false);
    }
  });

  test("with no unlock, no token passes", async () => {
    expect(await isValidToken(INITIAL_STATE, "anything", T0)).toBe(false);
  });

  test("only one live token: the second unlock replaces the first", async () => {
    const premier = await attemptAccepted(INITIAL_STATE, T0);
    const second = await attemptAccepted(premier.state, T0 + 1000);
    expect(second.token).not.toBe(premier.token);
    expect(await isValidToken(second.state, premier.token, T0 + 1000)).toBe(false);
    expect(await isValidToken(second.state, second.token, T0 + 1000)).toBe(true);
  });

  test("a revoked token is refused", async () => {
    const { state, token } = await attemptAccepted(INITIAL_STATE, T0);
    expect(await isValidToken(revoke(state), token, T0)).toBe(false);
  });

  test("a failed attempt does not revoke the token in force", async () => {
    const { state, token } = await attemptAccepted(INITIAL_STATE, T0);
    expect(await isValidToken(attemptRefused(state, T0), token, T0)).toBe(true);
  });
});

describe("hash read from dashboard.env", () => {
  const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=2,p=1$c2Vs$aGFjaGU";

  test("the value of PASSWORD_HASH", () => {
    expect(hashFrom(`# dashboard\nPASSWORD_HASH=${PASSWORD_HASH}\n`)).toBe(PASSWORD_HASH);
    expect(hashFrom(`PASSWORD_HASH='${PASSWORD_HASH}'\n`)).toBe(PASSWORD_HASH);
  });

  test("missing, unmanaged or without the key: the empty string", () => {
    expect(hashFrom(null)).toBe("");
    expect(hashFrom("")).toBe("");
    expect(hashFrom("OTHER=1\n")).toBe("");
    expect(hashFrom(`export PASSWORD_HASH=${PASSWORD_HASH}\n`)).toBe("");
    expect(hashFrom(`PASSWORD_HASH=${PASSWORD_HASH}\r\n`)).toBe("");
  });

  test("an empty or malformed hash refuses everyone", async () => {
    expect(await isPasswordValid("an attempt", hashFrom(null))).toBe(false);
    expect(await isPasswordValid("an attempt", hashFrom("PASSWORD_HASH=$argon2id$truncated\n"))).toBe(false);
  });
});

describe("rate limiting on disk", () => {
  test("round trip: what is written is read back, the token is never in it", async () => {
    const { state, token } = await attemptAccepted(refuse(TOLERATED_FAILURES + 2, T0), T0);
    const withFailures = attemptRefused(state, T0 + 10);
    const text = encodeRateLimit(withFailures);
    expect(text).not.toContain(token);
    expect(text).not.toContain(state.token!.hash);
    expect(readRateLimit({ kind: "read", text }, T0 + 20)).toEqual({ failures: 1, lastFailureAt: T0 + 10 });
  });

  test("a missing file is a first startup: zero", () => {
    expect(readRateLimit({ kind: "absent" }, T0)).toEqual({ failures: 0, lastFailureAt: 0 });
  });

  test("unreadable or malformed: the maximum rate limit, counting from now", () => {
    const cas = [
      { kind: "unreadable" as const },
      { kind: "read" as const, text: "" },
      { kind: "read" as const, text: "{not json" },
      { kind: "read" as const, text: "null" },
      { kind: "read" as const, text: JSON.stringify({ failures: -1, lastFailureAt: T0 }) },
      { kind: "read" as const, text: JSON.stringify({ failures: 1.5, lastFailureAt: T0 }) },
      { kind: "read" as const, text: JSON.stringify({ failures: "3", lastFailureAt: T0 }) },
      { kind: "read" as const, text: JSON.stringify({ failures: 3 }) },
    ];
    for (const reading of cas) {
      const parsed = readRateLimit(reading, T0);
      expect(parsed).toEqual({ failures: SAFETY_FAILURES, lastFailureAt: T0 });
      expect(wait({ ...INITIAL_STATE, ...parsed }, T0)).toBe(MAXIMUM_BACKOFF_MS);
    }
  });

  test("a failure date in the future is brought back to now", () => {
    const text = JSON.stringify({ failures: TOLERATED_FAILURES + 1, lastFailureAt: T0 + 86_400_000 });
    const parsed = readRateLimit({ kind: "read", text }, T0);
    expect(parsed.lastFailureAt).toBe(T0);
    expect(wait({ ...INITIAL_STATE, ...parsed }, T0)).toBe(INITIAL_BACKOFF_MS);
  });
});

describe("the hash's file", () => {
  const sain: FileInfo = { link: false, regular: true, links: 1, uid: 0, gid: 0, mode: 0o600, size: 120, modifiedAt: 0 };

  test("root alone, with no bit for the group or for others", () => {
    expect(hashFileRefusal(sain, 0)).toBeNull();
    expect(hashFileRefusal({ ...sain, mode: 0o400 }, 0)).toBeNull();
  });

  test("the refusals", () => {
    // Today's shape: 0600 site-dashboard, which the dashboard would read.
    expect(hashFileRefusal({ ...sain, uid: 996, gid: 996 }, 0)).toContain("not root");
    expect(hashFileRefusal({ ...sain, mode: 0o640 }, 0)).toContain("640");
    expect(hashFileRefusal({ ...sain, mode: 0o604 }, 0)).toContain("604");
    expect(hashFileRefusal({ ...sain, link: true, regular: false }, 0)).not.toBeNull();
    expect(hashFileRefusal({ ...sain, regular: false }, 0)).not.toBeNull();
    expect(hashFileRefusal({ ...sain, links: 2 }, 0)).not.toBeNull();
  });
});
