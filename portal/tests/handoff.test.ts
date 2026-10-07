import { describe, expect, test } from "bun:test";
import { deriveKey, purposeKey, seal, type Identity } from "../src/gate";
import {
  HANDOFF_MAX,
  HANDOFF_PER_EMAIL,
  HANDOFF_TTL_MS,
  IDENTITY_DURATION_S,
  SIGN_OUT_DURATION_S,
  bindingHash,
  drawBinding,
  handoffStore,
  isBinding,
  issueFlow,
  issueSession,
  issueSignOut,
  issueTransaction,
  readFlow,
  readSession,
  readSignOut,
  readTransaction,
  transactionSuffix,
  type Flow,
  type Handoff,
} from "../src/handoff";
import { FLOW_DURATION_S } from "../src/oidc";

const KEY = deriveKey(new Uint8Array(32).fill(5), "$argon2id$sample")!;
const OTHER_KEY = deriveKey(new Uint8Array(32).fill(5), "$argon2id$changed")!;
const HOST = "kanban.test-zone.invalid";
const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;
const ALICE = { email: "alice@acme.test", name: "Alice" };

const BINDING = drawBinding();
const FLOW: Flow = { host: HOST, returnTo: "/board?week=3", binding: bindingHash(BINDING), chooseAccount: false, audience: "site" };
const DASHBOARD_HOST = "dashboard.test-zone.invalid";

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

  test("a dashboard's flow reads back as the dashboard's, a site's as a site's", () => {
    const dashboard: Flow = { ...FLOW, host: DASHBOARD_HOST, audience: "dashboard" };
    expect(readFlow(KEY, issueFlow(KEY, dashboard, NOW_S), NOW_S)).toEqual(dashboard);
    expect(readFlow(KEY, issueFlow(KEY, FLOW, NOW_S), NOW_S)?.audience).toBe("site");
  });

  test("a site's flow sealed before audiences existed reads as a site's", () => {
    // What a portal from before the dashboard's sign-in sealed: no `d` at all.
    const earlier = seal(purposeKey(KEY, "flow"), { h: HOST, r: "/", b: bindingHash(BINDING), a: false, e: NOW_S + 60 });
    expect(readFlow(KEY, earlier, NOW_S)?.audience).toBe("site");
    const forged = seal(purposeKey(KEY, "flow"), { h: HOST, r: "/", b: bindingHash(BINDING), a: false, d: "yes", e: NOW_S + 60 });
    expect(readFlow(KEY, forged, NOW_S)).toBeNull();
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
  test("remembers who signed in, for a day, and says until when", () => {
    const token = issueSession(KEY, ALICE, NOW_S);
    expect(readSession(KEY, token, NOW_S + IDENTITY_DURATION_S - 1)).toEqual({ identity: ALICE, expiry: NOW_S + IDENTITY_DURATION_S });
    expect(readSession(KEY, token, NOW_S + IDENTITY_DURATION_S)).toBeNull();
    expect(readSession(OTHER_KEY, token, NOW_S)).toBeNull();
  });
});

describe("the sign-out ticket", () => {
  test("names the site it came from, for a minute", () => {
    const ticket = issueSignOut(KEY, HOST, NOW_S);
    expect(readSignOut(KEY, ticket, NOW_S + SIGN_OUT_DURATION_S - 1)).toBe(HOST);
    expect(readSignOut(KEY, ticket, NOW_S + SIGN_OUT_DURATION_S)).toBeNull();
  });

  test("is no flow, no session, and nothing forged or from another key", () => {
    expect(readSignOut(KEY, issueFlow(KEY, FLOW, NOW_S), NOW_S)).toBeNull();
    expect(readSignOut(KEY, issueSession(KEY, ALICE, NOW_S), NOW_S)).toBeNull();
    expect(readSession(KEY, issueSignOut(KEY, HOST, NOW_S), NOW_S)).toBeNull();
    expect(readSignOut(OTHER_KEY, issueSignOut(KEY, HOST, NOW_S), NOW_S)).toBeNull();
    expect(readSignOut(KEY, issueSignOut(KEY, "Not A Host", NOW_S), NOW_S)).toBeNull();
    expect(readSignOut(KEY, null, NOW_S)).toBeNull();
  });
});

describe("the handoff codes", () => {
  const handoff: Handoff = {
    host: HOST,
    binding: bindingHash(BINDING),
    identity: ALICE,
    returnTo: "/board",
    sessionExpiry: NOW_S + 60,
    authTime: NOW_S - 30,
    audience: "site",
  };

  /** A handoff of a flow of its own, as each sign-in has. */
  const fresh = (identity: Identity = ALICE) => ({ ...handoff, identity, binding: bindingHash(drawBinding()) });

  /** The code of a minting that must succeed. */
  function minted(store: ReturnType<typeof handoffStore>, one = handoff, now = NOW): string {
    const minting = store.mint(one, now);
    if ("refusal" in minting) throw new Error(`refused: ${minting.refusal}`);
    return minting.code;
  }

  test("a code hands its identity over once, to the right host and browser, with the session's end", () => {
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

  test("a code minted for the dashboard is redeemed for the dashboard only, and the other way round", () => {
    const store = handoffStore();
    const forDashboard: Handoff = { ...fresh(), host: DASHBOARD_HOST, audience: "dashboard" };
    const binding = drawBinding();
    const code = minted(store, { ...forDashboard, binding: bindingHash(binding) });
    // Redeemed as a site's cookie on the dashboard's host: refused, and burnt.
    expect(store.redeem(code, DASHBOARD_HOST, binding, NOW)).toEqual({ refusal: "wrong-audience" });
    expect(store.redeem(code, DASHBOARD_HOST, binding, NOW, "dashboard")).toEqual({ refusal: "unknown-code" });

    const siteBinding = drawBinding();
    const siteCode = minted(store, { ...handoff, binding: bindingHash(siteBinding) });
    expect(store.redeem(siteCode, HOST, siteBinding, NOW, "dashboard")).toEqual({ refusal: "wrong-audience" });

    const again = drawBinding();
    const good = minted(store, { ...forDashboard, binding: bindingHash(again) });
    const redeemed = store.redeem(good, DASHBOARD_HOST, again, NOW, "dashboard");
    expect("handoff" in redeemed && redeemed.handoff.authTime).toBe(NOW_S - 30);
  });

  test("in another browser, refused: a link carrying someone's code signs nobody in", () => {
    const store = handoffStore();
    const code = minted(store);
    expect(store.redeem(code, HOST, drawBinding(), NOW)).toEqual({ refusal: "wrong-browser" });
    const again = minted(store, fresh());
    expect(store.redeem(again, HOST, null, NOW)).toEqual({ refusal: "wrong-browser" });
  });

  test("a flow mints one code, ever: replayed, it mints no other, redeemed or not", () => {
    // One account replaying one flow at /oidc/start used to mint a code per
    // request, until no sign-in was left for anyone.
    const store = handoffStore();
    const code = minted(store);
    expect(store.mint(handoff, NOW + 1)).toEqual({ refusal: "spent-flow" });
    store.redeem(code, HOST, BINDING, NOW + 2);
    expect(store.mint(handoff, NOW + HANDOFF_TTL_MS * 5)).toEqual({ refusal: "spent-flow" });
    // Once the flow itself would have expired, there is nothing left to remember.
    expect("code" in store.mint(handoff, NOW + FLOW_DURATION_S * 1000)).toBe(true);
  });

  test("one email holds ten codes in flight at most, whatever its flows; others are not held back", () => {
    const store = handoffStore();
    for (let i = 0; i < HANDOFF_PER_EMAIL; i++) minted(store, fresh());
    expect(store.mint(fresh(), NOW)).toEqual({ refusal: "too-many" });
    minted(store, fresh({ email: "bob@acme.test", name: null }));
    // Redeemed or expired, a code gives its place back.
    expect("code" in store.mint(fresh(), NOW + HANDOFF_TTL_MS)).toBe(true);
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
    // A thousand accounts, ten codes each.
    for (let i = 0; i < HANDOFF_MAX; i++) minted(store, fresh({ email: `p${Math.floor(i / HANDOFF_PER_EMAIL)}@acme.test`, name: null }));
    expect(store.mint(fresh({ email: "late@acme.test", name: null }), NOW + 1)).toEqual({ refusal: "too-many" });
    expect("code" in store.mint(fresh({ email: "late@acme.test", name: null }), NOW + HANDOFF_TTL_MS)).toBe(true);
  });
});
