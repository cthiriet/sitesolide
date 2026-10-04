import { describe, expect, test } from "bun:test";
import { deriveKey } from "../src/gate";
import {
  HANDOFF_MAX,
  HANDOFF_TTL_MS,
  IDENTITY_DURATION_S,
  bindingHash,
  drawBinding,
  handoffStore,
  isBinding,
  issueFlow,
  issueSession,
  issueTransaction,
  readFlow,
  readSession,
  readTransaction,
  transactionSuffix,
  type Flow,
} from "../src/handoff";
import { FLOW_DURATION_S } from "../src/oidc";

const KEY = deriveKey(new Uint8Array(32).fill(5), "$argon2id$sample")!;
const OTHER_KEY = deriveKey(new Uint8Array(32).fill(5), "$argon2id$changed")!;
const HOST = "kanban.test-zone.invalid";
const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;
const ALICE = { email: "alice@acme.test", name: "Alice" };

const BINDING = drawBinding();
const FLOW: Flow = { host: HOST, returnTo: "/board?week=3", binding: bindingHash(BINDING), chooseAccount: false };

describe("the binding", () => {
  test("is drawn fresh, 256 bits, and travels only as its hash", () => {
    expect(isBinding(BINDING)).toBe(true);
    expect(drawBinding()).not.toBe(BINDING);
    expect(bindingHash(BINDING)).not.toBe(BINDING);
    expect(isBinding(bindingHash(BINDING))).toBe(true);
  });
});

describe("the flow", () => {
  test("reads back what was sealed", () => {
    expect(readFlow(KEY, issueFlow(KEY, FLOW, NOW_S), NOW_S + 10)).toEqual(FLOW);
  });

  test("expires with the sign-in it carries", () => {
    const token = issueFlow(KEY, FLOW, NOW_S);
    expect(readFlow(KEY, token, NOW_S + FLOW_DURATION_S - 1)).not.toBeNull();
    expect(readFlow(KEY, token, NOW_S + FLOW_DURATION_S)).toBeNull();
  });

  test("falls with the password, and a forged one is refused", () => {
    expect(readFlow(OTHER_KEY, issueFlow(KEY, FLOW, NOW_S), NOW_S)).toBeNull();
    const [payload, signature] = issueFlow(KEY, FLOW, NOW_S).split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString());
    tampered.h = "evil.test-zone.invalid";
    expect(readFlow(KEY, `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`, NOW_S)).toBeNull();
  });

  test("a sealed flow still has to be sound: host, return path, binding", () => {
    // What the portal sealed it judges again: a bug in begin must not mint a
    // code for a host Caddy never announced, nor send anyone off-site.
    expect(readFlow(KEY, issueFlow(KEY, { ...FLOW, host: "Not A Host" }, NOW_S), NOW_S)).toBeNull();
    expect(readFlow(KEY, issueFlow(KEY, { ...FLOW, returnTo: "//evil.test" }, NOW_S), NOW_S)).toBeNull();
    expect(readFlow(KEY, issueFlow(KEY, { ...FLOW, binding: "short" }, NOW_S), NOW_S)).toBeNull();
  });

  test("a flow is not a transaction nor a session, with the same key", () => {
    const token = issueFlow(KEY, FLOW, NOW_S);
    expect(readTransaction(KEY, token, "s".repeat(22), NOW_S)).toBeNull();
    expect(readSession(KEY, token, NOW_S)).toBeNull();
  });
});

describe("the provider transaction", () => {
  const STATE = "S".repeat(22);
  const transaction = { state: STATE, nonce: "n".repeat(22), verifier: "v".repeat(43), flow: issueFlow(KEY, FLOW, NOW_S) };

  test("is found back for its state only", () => {
    const token = issueTransaction(KEY, transaction, NOW_S);
    expect(readTransaction(KEY, token, STATE, NOW_S + 1)).toEqual(transaction);
    expect(readTransaction(KEY, token, "T".repeat(22), NOW_S + 1)).toBeNull();
  });

  test("expires, and lives in a cookie named after its state", () => {
    expect(readTransaction(KEY, issueTransaction(KEY, transaction, NOW_S), STATE, NOW_S + FLOW_DURATION_S)).toBeNull();
    expect(transactionSuffix(STATE)).toBe(`-oidc-${STATE}`);
  });
});

describe("the portal's session", () => {
  test("remembers who signed in, for a day", () => {
    const token = issueSession(KEY, ALICE, NOW_S);
    expect(readSession(KEY, token, NOW_S + IDENTITY_DURATION_S - 1)).toEqual(ALICE);
    expect(readSession(KEY, token, NOW_S + IDENTITY_DURATION_S)).toBeNull();
    expect(readSession(OTHER_KEY, token, NOW_S)).toBeNull();
  });
});

describe("the handoff codes", () => {
  const handoff = { host: HOST, binding: bindingHash(BINDING), identity: ALICE, returnTo: "/board" };

  test("a code hands its identity over once, to the right host and browser", () => {
    const store = handoffStore();
    const code = store.mint(handoff, NOW)!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.redeem(code, HOST, BINDING, NOW + 1_000)).toEqual({ handoff });
  });

  test("replayed, it is unknown", () => {
    const store = handoffStore();
    const code = store.mint(handoff, NOW)!;
    store.redeem(code, HOST, BINDING, NOW);
    expect(store.redeem(code, HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
  });

  test("after a minute, it has expired", () => {
    const store = handoffStore();
    const code = store.mint(handoff, NOW)!;
    expect(store.redeem(code, HOST, BINDING, NOW + HANDOFF_TTL_MS)).toEqual({ refusal: "expired-code" });
  });

  test("on another host, refused, and burnt: the right host cannot use it afterwards", () => {
    const store = handoffStore();
    const code = store.mint(handoff, NOW)!;
    expect(store.redeem(code, "roster.test-zone.invalid", BINDING, NOW)).toEqual({ refusal: "wrong-host" });
    expect(store.redeem(code, HOST, BINDING, NOW)).toEqual({ refusal: "unknown-code" });
  });

  test("in another browser, refused: a link carrying someone's code signs nobody in", () => {
    const store = handoffStore();
    const code = store.mint(handoff, NOW)!;
    expect(store.redeem(code, HOST, drawBinding(), NOW)).toEqual({ refusal: "wrong-browser" });
    const again = store.mint(handoff, NOW)!;
    expect(store.redeem(again, HOST, null, NOW)).toEqual({ refusal: "wrong-browser" });
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
    for (let i = 0; i < HANDOFF_MAX; i++) expect(store.mint(handoff, NOW)).not.toBeNull();
    expect(store.mint(handoff, NOW + 1)).toBeNull();
    expect(store.mint(handoff, NOW + HANDOFF_TTL_MS)).not.toBeNull();
  });
});
