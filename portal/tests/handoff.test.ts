import { describe, expect, test } from "bun:test";
import { FLOW_DURATION_S, HANDOFF_MAX, HANDOFF_TTL_MS, bindingHash, drawBinding, handoffStore, isBinding, type Handoff } from "../src/handoff";

const HOST = "kanban.test-zone.invalid";
const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;

const BINDING = drawBinding();

describe("the binding", () => {
  test("is drawn fresh, 256 bits, and travels only as its hash", () => {
    expect(isBinding(BINDING)).toBe(true);
    expect(drawBinding()).not.toBe(BINDING);
    expect(bindingHash(BINDING)).not.toBe(BINDING);
    expect(isBinding(bindingHash(BINDING))).toBe(true);
  });
});

describe("the handoff codes", () => {
  const handoff: Handoff = { host: HOST, binding: bindingHash(BINDING), returnTo: "/board", passkey: "a".repeat(43) };

  /** A handoff of a flow of its own, as each sign-in has. */
  const fresh = (): Handoff => ({ ...handoff, binding: bindingHash(drawBinding()) });

  /** The code of a minting that must succeed. */
  function minted(store: ReturnType<typeof handoffStore>, one = handoff, now = NOW): string {
    const minting = store.mint(one, now);
    if ("refusal" in minting) throw new Error(`refused: ${minting.refusal}`);
    return minting.code;
  }

  test("a code hands its sign-in over once, to the right host and browser", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.redeem(code, HOST, BINDING, NOW + 1_000)).toEqual({ handoff });
  });

  test("replayed, it is unknown", () => {
    const store = handoffStore();
    const code = minted(store);
    store.redeem(code, HOST, BINDING, NOW);
    expect(store.redeem(code, HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
  });

  test("after a minute, it has expired", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(store.redeem(code, HOST, BINDING, NOW + HANDOFF_TTL_MS)).toEqual({ refusal: "expired-code" });
  });

  test("on another host, refused, and burnt: the right host cannot use it afterwards", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(store.redeem(code, "roster.test-zone.invalid", BINDING, NOW)).toEqual({ refusal: "wrong-host" });
    expect(store.redeem(code, HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
  });

  test("in another browser, refused: a link carrying someone's code signs nobody in", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(store.redeem(code, HOST, drawBinding(), NOW)).toEqual({ refusal: "wrong-browser" });
    const again = minted(store, fresh());
    expect(store.redeem(again, HOST, null, NOW)).toEqual({ refusal: "wrong-browser" });
  });

  test("a flow mints one code, ever: replayed, it mints no other, redeemed or not", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(store.mint(handoff, NOW + 1)).toEqual({ refusal: "spent-flow" });
    store.redeem(code, HOST, BINDING, NOW + 2);
    expect(store.mint(handoff, NOW + HANDOFF_TTL_MS * 5)).toEqual({ refusal: "spent-flow" });
    // Once the flow itself would have expired, there is nothing left to remember.
    expect("code" in store.mint(handoff, NOW + FLOW_DURATION_S * 1000)).toBe(true);
  });

  test("a code that was never minted, or malformed, is unknown", () => {
    const store = handoffStore();
    expect(store.redeem("A".repeat(43), HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
    expect(store.redeem("", HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
    expect(store.redeem("a.b", HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
  });

  test("too many in flight, minting refuses; expired ones make room again", () => {
    let n = 0;
    const store = handoffStore(() => String(n++).padStart(43, "0"));
    for (let i = 0; i < HANDOFF_MAX; i++) minted(store, fresh());
    expect(store.mint(fresh(), NOW + 1)).toEqual({ refusal: "too-many" });
    expect("code" in store.mint(fresh(), NOW + HANDOFF_TTL_MS)).toBe(true);
  });
});
