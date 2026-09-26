import { describe, expect, test } from "bun:test";
import { createTokens } from "../src/secrets/tokens";
import { UNLOCK_DURATION_MS } from "../src/secrets/protocol";

const NOW = 1_756_400_000_000;
const EXPIRE_A = NOW + UNLOCK_DURATION_MS;

function mount() {
  const clock = { now: NOW };
  return { clock, tokens: createTokens(() => clock.now) };
}

describe("an unlock is kept per session", () => {
  test("nothing is kept as long as nothing is set", () => {
    const { tokens } = mount();
    expect(tokens.read("session-a")).toBeNull();
    expect(tokens.forget("session-a")).toBeNull();
  });

  test("once set, it reads back as it is", () => {
    const { tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });
    expect(tokens.read("session-a")).toEqual({ token: "token-a", expiresAt: EXPIRE_A });
  });

  test("two sessions share nothing", () => {
    const { tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });
    expect(tokens.read("session-b")).toBeNull();

    tokens.set("session-b", { token: "token-b", expiresAt: EXPIRE_A });
    tokens.forget("session-a");
    expect(tokens.read("session-a")).toBeNull();
    expect(tokens.read("session-b")?.token).toBe("token-b");
  });

  test("a new unlock replaces the old one", () => {
    const { tokens } = mount();
    tokens.set("session-a", { token: "older", expiresAt: EXPIRE_A });
    tokens.set("session-a", { token: "newer", expiresAt: EXPIRE_A + 1000 });
    expect(tokens.read("session-a")).toEqual({ token: "newer", expiresAt: EXPIRE_A + 1000 });
  });

  test("what is read is a copy, which extends nothing", () => {
    const { clock, tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });
    const parsed = tokens.read("session-a")!;
    parsed.expiresAt = EXPIRE_A + UNLOCK_DURATION_MS;
    clock.now = EXPIRE_A;
    expect(tokens.read("session-a")).toBeNull();
  });
});

describe("the deadline, to the millisecond", () => {
  test("alive one millisecond before, dead at the exact instant", () => {
    const { clock, tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });

    clock.now = EXPIRE_A - 1;
    expect(tokens.read("session-a")?.token).toBe("token-a");

    clock.now = EXPIRE_A;
    expect(tokens.read("session-a")).toBeNull();
  });

  test("expired, it is forgotten and not merely hidden", () => {
    const { clock, tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });

    clock.now = EXPIRE_A;
    expect(tokens.read("session-a")).toBeNull();
    // A clock that goes backwards does not bring it back: it is kept no more.
    clock.now = NOW;
    expect(tokens.read("session-a")).toBeNull();
  });
});

describe("forgetting", () => {
  test("gives back the still live token, so it can be revoked, then forgets it", () => {
    const { tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });
    expect(tokens.forget("session-a")).toEqual({ token: "token-a", expiresAt: EXPIRE_A });
    expect(tokens.read("session-a")).toBeNull();
    expect(tokens.forget("session-a")).toBeNull();
  });

  test("an expired token is not given back: the steward already refuses it", () => {
    const { clock, tokens } = mount();
    tokens.set("session-a", { token: "token-a", expiresAt: EXPIRE_A });
    clock.now = EXPIRE_A;
    expect(tokens.forget("session-a")).toBeNull();
  });
});
