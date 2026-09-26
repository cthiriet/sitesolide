import { describe, expect, test } from "bun:test";
import { MESSAGE_MAX, judgeGatekeeperResult, gatekeeperUnitOf } from "../src/secrets/portal";
import type { FileInfo } from "../src/secrets/scope";
import type { Examination } from "../src/secrets/system";

/**
 * What the steward believes of the gatekeeper. Nothing counts as success by
 * default: a result that is missing, stale, badly protected or malformed is a
 * failure, and the gatekeeper's message is shown only if it is readable.
 */

const LAUNCH = 1_789_000_000_000;
const INFO: FileInfo = { link: false, regular: true, links: 1, uid: 0, gid: 0, mode: 0o644, size: 100, modifiedAt: LAUNCH };

function examination(object: unknown, info: Partial<FileInfo> = {}): Examination {
  const text = typeof object === "string" ? object : JSON.stringify(object);
  return { kind: "present", info: { ...INFO, ...info }, bytes: new TextEncoder().encode(text) };
}

const result = (others: Record<string, unknown> = {}) => ({
  a: LAUNCH + 1500,
  result: "ok",
  message: "portal installed, caddy reloaded, the site answers 401 without a cookie",
  requested: true,
  installed: true,
  ...others,
});

describe("the gatekeeper's unit", () => {
  test("the action in the template's name, the slug alone as the instance", () => {
    expect(gatekeeperUnitOf(true, "cms")).toBe("sitesolide-gatekeeper-on@cms.service");
    expect(gatekeeperUnitOf(false, "cms-tool")).toBe("sitesolide-gatekeeper-off@cms-tool.service");
  });

  test("a name that is not a slug never enters a unit name", () => {
    for (const slug of ["test-zone.invalid", "../cms", "cms;reboot", "Cms", "", "cms.service"]) expect(gatekeeperUnitOf(true, slug)).toBeNull();
  });
});

describe("the gatekeeper's result", () => {
  test("ok, refusal, failure, with their message", () => {
    expect(judgeGatekeeperResult(examination(result()), LAUNCH, 0)).toEqual({ result: "ok", message: result().message });
    expect(judgeGatekeeperResult(examination(result({ result: "rejects", message: "caddy validate failed" })), LAUNCH, 0)).toEqual({
      result: "rejects",
      message: "caddy validate failed",
    });
    expect(judgeGatekeeperResult(examination(result({ result: "failure", message: "restored" })), LAUNCH, 0)).toEqual({
      result: "failure",
      message: "restored",
    });
  });

  test("written at the very instant of the start: fresh", () => {
    expect(judgeGatekeeperResult(examination(result({ a: LAUNCH })), LAUNCH, 0).result).toBe("ok");
  });

  test("missing, stale, unreadable: failure", () => {
    expect(judgeGatekeeperResult({ kind: "absent" }, LAUNCH, 0)).toMatchObject({ result: "failure", message: expect.stringContaining("no result") });
    expect(judgeGatekeeperResult(examination(result({ a: LAUNCH - 1 })), LAUNCH, 0)).toMatchObject({
      result: "failure",
      message: expect.stringContaining("no fresh result"),
    });
    const unreadable: unknown[] = [
      "{truncated",
      "[]",
      "null",
      result({ result: "maybe" }),
      result({ a: "hier" }),
      result({ a: Number.NaN }),
      result({ message: 42 }),
      result({ requested: "yes" }),
      result({ installed: undefined }),
    ];
    for (const object of unreadable) {
      expect(judgeGatekeeperResult(examination(object), LAUNCH, 0)).toEqual({ result: "failure", message: "the gatekeeper's result is unreadable" });
    }
    const invalid: Examination = { kind: "present", info: INFO, bytes: new Uint8Array([0x7b, 0xff, 0x7d]) };
    expect(judgeGatekeeperResult(invalid, LAUNCH, 0).result).toBe("failure");
  });

  test("a file that is not regular, not owned by root or writable by others: failure, even if it says ok", () => {
    const link: Examination = { kind: "present", info: { ...INFO, link: true, regular: false }, bytes: null };
    expect(judgeGatekeeperResult(link, LAUNCH, 0).result).toBe("failure");
    expect(judgeGatekeeperResult(examination(result(), { uid: 1001 }), LAUNCH, 0).message).toContain("not owned by root");
    expect(judgeGatekeeperResult(examination(result(), { mode: 0o664 }), LAUNCH, 0).message).toContain("writable by other accounts");
    expect(judgeGatekeeperResult(examination(result(), { mode: 0o646 }), LAUNCH, null).result).toBe("failure");
    // With no account check, on the workstation, the uid does not count.
    expect(judgeGatekeeperResult(examination(result(), { uid: 1001 }), LAUNCH, null).result).toBe("ok");
  });

  test("a message too long, empty or carrying a control character is replaced", () => {
    const replace = (message: string, kind = "ok") => judgeGatekeeperResult(examination(result({ message, result: kind })), LAUNCH, 0).message;
    expect(replace("x".repeat(MESSAGE_MAX))).toBe("x".repeat(MESSAGE_MAX));
    expect(replace("x".repeat(MESSAGE_MAX + 1))).toBe("done");
    expect(replace("")).toBe("done");
    expect(replace("line\nnext", "rejects")).toBe("the gatekeeper refused the change");
    expect(replace(`efface${String.fromCharCode(0x1b)}[2J`, "failure")).toContain("the gatekeeper failed");
  });
});
