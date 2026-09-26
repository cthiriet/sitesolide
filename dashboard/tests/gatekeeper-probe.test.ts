import { describe, expect, test } from "bun:test";
import {
  alreadySilent,
  servedHosts,
  judgeTarget,
  isPortalReady,
  regressions,
  answers,
  fromPortal,
  type ProbeResponse,
} from "../src/gatekeeper/probe";

/**
 * What the sites have to answer after a reload. The case that matters most: a
 * site that was meant to go behind the portal and answers 200, or a 401 that is
 * not the portal's, both have to trigger a restore.
 */
const ok: ProbeResponse = { code: 200, door: false, body: "" };
const portal: ProbeResponse = { code: 401, door: true, body: "<html>" };
const lock: ProbeResponse = { code: 401, door: false, body: "<html>" };
const incomplete: ProbeResponse = { code: 404, door: false, body: "" };
const badGateway: ProbeResponse = { code: 502, door: false, body: "" };
const unreachable: ProbeResponse = { error: "ECONNREFUSED" };

describe("judgeTarget", () => {
  test("portal on: only the portal's 401 will do", () => {
    expect(judgeTarget(true, "cms.test-zone.invalid", portal)).toBeNull();
    for (const response of [ok, lock, incomplete, badGateway, unreachable]) {
      expect(judgeTarget(true, "cms.test-zone.invalid", response)).toContain("should answer the portal's 401");
    }
  });

  test("portal off: the site answers, and no longer through the portal", () => {
    expect(judgeTarget(false, "cms.test-zone.invalid", ok)).toBeNull();
    expect(judgeTarget(false, "cms.test-zone.invalid", lock)).toBeNull();
    expect(judgeTarget(false, "cms.test-zone.invalid", portal)).toContain("still answers the portal");
    expect(judgeTarget(false, "cms.test-zone.invalid", badGateway)).toContain("does not answer, got 502");
    expect(judgeTarget(false, "cms.test-zone.invalid", unreachable)).toContain("ECONNREFUSED");
  });

  test("answers and fromPortal", () => {
    expect([ok, portal, lock].every(answers)).toBe(true);
    expect([incomplete, badGateway, unreachable].some(answers)).toBe(false);
    expect(fromPortal(portal)).toBe(true);
    expect(fromPortal(lock)).toBe(false);
  });
});

describe("isPortalReady", () => {
  test("200 and configure: true, nothing else", () => {
    expect(isPortalReady({ code: 200, door: false, body: '{"ok":true,"configure":true}' })).toBe(true);
    expect(isPortalReady({ code: 200, door: false, body: '{"ok":true,"configure":false}' })).toBe(false);
    expect(isPortalReady({ code: 200, door: false, body: "<html>" })).toBe(false);
    expect(isPortalReady({ code: 502, door: false, body: '{"configure":true}' })).toBe(false);
    expect(isPortalReady(unreachable)).toBe(false);
  });
});

describe("servedHosts", () => {
  test("the bare domain, www, then each served slug, without the landing's directory", () => {
    expect(servedHosts("test-zone.invalid", ["test-zone.invalid", "cms", "calendar", "Not_A_Slug", "a.b"])).toEqual([
      "test-zone.invalid",
      "www.test-zone.invalid",
      "calendar.test-zone.invalid",
      "cms.test-zone.invalid",
    ]);
  });
});

describe("regressions", () => {
  const target = "cms.test-zone.invalid";
  const before = new Map<string, ProbeResponse>([
    ["test-zone.invalid", ok],
    ["calendar.test-zone.invalid", portal],
    ["vineyard.test-zone.invalid", incomplete],
    [target, ok],
  ]);

  test("a site that answered and no longer answers is lost", () => {
    const after = new Map<string, ProbeResponse>([
      ["test-zone.invalid", ok],
      ["calendar.test-zone.invalid", badGateway],
    ]);
    expect(regressions(before, after, target)).toEqual(["calendar.test-zone.invalid"]);
  });

  test("a site that was already silent is not a regression, it is named", () => {
    const after = new Map<string, ProbeResponse>([
      ["test-zone.invalid", ok],
      ["calendar.test-zone.invalid", portal],
      ["vineyard.test-zone.invalid", unreachable],
    ]);
    expect(regressions(before, after, target)).toEqual([]);
    expect(alreadySilent(before, target)).toEqual(["vineyard.test-zone.invalid"]);
  });

  test("a site not queried afterwards counts as lost, the target has its own rule", () => {
    const after = new Map<string, ProbeResponse>([[target, unreachable]]);
    expect(regressions(before, after, target)).toEqual(["test-zone.invalid", "calendar.test-zone.invalid"]);
  });
});
