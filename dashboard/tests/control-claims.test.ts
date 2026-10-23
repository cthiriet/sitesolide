import { describe, expect, test } from "bun:test";
import { claimOf, credited, encodeClaims, madeStore, readClaims, released, settle, withDeployment, withStoreMade, without, type Claim, type Claims } from "../src/control/claims";

/**
 * What tokens did to a name the machine did not carry, and what becomes of
 * the name: pure, every decision judged without a steward.
 */

const T = "aaaaaaaaaaaa";
const U = "bbbbbbbbbbbb";
const D = "0123456789abcdef01234567";

describe("claims.json read back", () => {
  test("what is written reads back; no file is no claim", () => {
    const claims = withDeployment(withStoreMade({}, "shop", T, 1), "cafe", U, D, 2);
    expect(readClaims(encodeClaims(claims))).toEqual(claims);
    expect(readClaims(null)).toEqual({});
  });

  test("anything else does not read, whole: no claim is ever taken from a file that does not read", () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ version: 2, claims: {} }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, claims: { "../x": { creator: T, deployer: null, deployment: null, at: 1 } } }),
      JSON.stringify({ version: 1, claims: { shop: { creator: "not-an-id", deployer: null, deployment: null, at: 1 } } }),
      JSON.stringify({ version: 1, claims: { shop: { creator: T, deployer: null, deployment: "x", at: 1 } } }),
      JSON.stringify({ version: 1, claims: { shop: { creator: T, deployer: null, deployment: null, at: "1" } } }),
    ]) {
      expect(readClaims(text)).toMatchObject({ unreadable: expect.any(String) });
    }
  });
});

describe("who a store and a name are", () => {
  test("a store is a token's own when its write made it, never because a later record names another", () => {
    const claims = withStoreMade({}, "shop", T, 1);
    expect(madeStore(claims, "shop", T)).toBe(true);
    expect(madeStore(claims, "shop", U)).toBe(false);
    expect(madeStore(claims, "cafe", T)).toBe(false);
    expect(madeStore(null, "shop", T)).toBe(false);
    // A deployment recorded after keeps who made the store, and the deployment's time.
    const deployed = withDeployment(claims, "shop", T, D, 5);
    expect(madeStore(deployed, "shop", T)).toBe(true);
    expect(withStoreMade(deployed, "shop", T, 9).shop).toEqual({ creator: T, deployer: T, deployment: D, at: 5 });
  });

  test("a project is the holder's only by its own deployment, which succeeded or failed after laying the project itself: one that failed otherwise or still runs never counts", () => {
    const ahead = claimOf(withStoreMade({}, "shop", T, 1), "shop");
    const deployed = claimOf(withDeployment({}, "shop", T, D, 2), "shop");
    expect(credited(deployed, T, "succeeded")).toBe(true);
    expect(credited(deployed, T, "laid")).toBe(true);
    expect(credited(deployed, U, "laid")).toBe(false);
    expect(credited(deployed, T, "ended")).toBe(false);
    expect(credited(deployed, T, "under-way")).toBe(false);
    expect(credited(deployed, U, "succeeded")).toBe(false);
    expect(credited(ahead, T, null)).toBe(false);
    expect(credited(null, T, "succeeded")).toBe(false);
  });

  test("a hold on a project the machine carries is released unless the holder's own deployment laid it and succeeded", () => {
    const ahead = claimOf(withStoreMade({}, "shop", T, 1), "shop");
    expect(released(ahead, true, false)).toBe(true);
    expect(released(ahead, false, false)).toBe(false);
    expect(released(ahead, true, true)).toBe(false);
    // A name held from before claims were kept stays as it was.
    expect(released(null, true, false)).toBe(false);
    expect(without(withStoreMade({}, "shop", T, 1), "shop")).toEqual({});
  });
});

describe("a name settled", () => {
  const claim = (creator: string | null, deployer: string | null): Claim => ({ creator, deployer, deployment: deployer === null ? null : D, at: 1 });
  type Facts = { onMachine: boolean; store: boolean; pending: boolean; credited: boolean };
  const facts = (part: Partial<Facts>): Facts => ({ onMachine: false, store: false, pending: false, credited: false, ...part });
  const cases: [string, Claim | null, string | null, Facts, { forget: boolean; drop: boolean }][] = [
    ["on the machine by its holder's deployment, which succeeded: kept, the claim said all it had to", claim(T, T), T, facts({ onMachine: true, credited: true }), { forget: false, drop: true }],
    ["on the machine, its holder's deployment failed: let go", claim(T, T), T, facts({ onMachine: true }), { forget: true, drop: true }],
    ["on the machine while its holder's deployment still runs: nothing settled yet", claim(null, T), T, facts({ onMachine: true, pending: true }), { forget: false, drop: false }],
    ["on the machine, never deployed by its holder: let go", claim(T, null), T, facts({ onMachine: true }), { forget: true, drop: true }],
    ["on the machine, deployed by another: let go", claim(T, U), T, facts({ onMachine: true }), { forget: true, drop: true }],
    ["on the machine, held from before claims: kept", null, T, facts({ onMachine: true }), { forget: false, drop: false }],
    ["a deployment under way: kept", claim(null, T), T, facts({ pending: true }), { forget: false, drop: false }],
    ["a store its holder made: kept", claim(T, null), T, facts({ store: true }), { forget: false, drop: false }],
    ["a store its holder did not make: let go, the claim of the one that made it kept", claim(U, null), T, facts({ store: true }), { forget: true, drop: false }],
    ["a store no write made: let go, and the claim with it", claim(null, T), T, facts({ store: true }), { forget: true, drop: true }],
    ["held from before claims, a store there: let go", null, T, facts({ store: true }), { forget: true, drop: false }],
    ["nothing under it, nothing under way: given back", claim(T, T), T, facts({}), { forget: true, drop: true }],
    ["held from before claims, nothing under it: given back", null, T, facts({}), { forget: true, drop: false }],
    ["a claim nobody holds any more, nothing under it: dropped", claim(T, null), null, facts({}), { forget: false, drop: true }],
  ];
  for (const [name, one, holder, known, expected] of cases) {
    test(name, () => {
      expect(settle(one, holder, known)).toEqual(expected);
    });
  }

  test("a slug is defined as the claims' own, never assigned through a prototype", () => {
    const claims: Claims = withStoreMade({}, "constructor", T, 1);
    expect(Object.hasOwn(claims, "constructor")).toBe(true);
    expect(madeStore(readClaims(encodeClaims(claims)) as Claims, "constructor", T)).toBe(true);
    expect(madeStore({}, "constructor", T)).toBe(false);
  });
});
