import { describe, expect, test } from "bun:test";
import { backupFolder, readLaunch, gatekeeperUnit } from "../src/gatekeeper/instance";
import { HOLDERS, STALE_LOCK_MS, judgeLock, readHolder, holderText } from "../src/gatekeeper/machine";

/**
 * The start is the gatekeeper's only input, and its slug ends up in paths
 * written as root: anything that does not have exactly the expected shape is
 * refused, and the action has to be the unit file's own.
 */
describe("readLaunch", () => {
  test("the unit name (%n) and the file's action", () => {
    expect(readLaunch(["sitesolide-gatekeeper-on@cms.service"], "on")).toEqual({
      ok: true,
      instance: { slug: "cms", active: true },
    });
    expect(readLaunch(["sitesolide-gatekeeper-off@cms.service"], "off")).toEqual({
      ok: true,
      instance: { slug: "cms", active: false },
    });
    expect(readLaunch(["sitesolide-gatekeeper-on@sample-api.service"], "on")).toMatchObject({
      instance: { slug: "sample-api" },
    });
  });

  test("an action that does not match the unit file is refused", () => {
    // An -off@ copied from -on@ without changing its Environment= line.
    expect(readLaunch(["sitesolide-gatekeeper-off@cms.service"], "on")).toEqual({
      ok: false,
      reason: "GATEKEEPER_ACTION=on does not match the off unit",
    });
    expect(readLaunch(["sitesolide-gatekeeper-on@cms.service"], "off")).toMatchObject({ ok: false });
  });

  test("a missing or malformed action is refused", () => {
    for (const action of [undefined, "", "ON", "yes", "on\n", "on off"]) {
      expect({ action, ok: readLaunch(["sitesolide-gatekeeper-on@cms.service"], action).ok }).toEqual({ action, ok: false });
    }
  });

  test("a malformed unit name or slug is refused", () => {
    for (const name of [
      "",
      "cms",
      "on-cms",
      "sitesolide-gatekeeper@on-cms.service",
      "sitesolide-gatekeeper-on@.service",
      "sitesolide-gatekeeper-on@cms",
      "sitesolide-gatekeeper-on@cms.service.d",
      "sitesolide-gatekeeper-on@cms.timer",
      "sitesolide-gatekeeper-on@Cms.service",
      "sitesolide-gatekeeper-on@cms-.service",
      "sitesolide-gatekeeper-on@..service",
      "sitesolide-gatekeeper-on@...service",
      "sitesolide-gatekeeper-on@test-zone.invalid.service",
      "sitesolide-gatekeeper-on@cms/../etc.service",
      "sitesolide-gatekeeper-on@cms@x.service",
      "sitesolide-gatekeeper-on@cms\\x2f.service",
      `sitesolide-gatekeeper-on@${"a".repeat(64)}.service`,
      "sitesolide-gatekeeper-on@cms.service\n",
      "xsitesolide-gatekeeper-on@cms.service",
    ]) {
      expect({ name, ok: readLaunch([name], "on").ok }).toEqual({ name, ok: false });
    }
  });

  test("exactly one argument, no more and no less", () => {
    expect(readLaunch([], "on").ok).toBe(false);
    expect(readLaunch(["sitesolide-gatekeeper-on@cms.service", "extra"], "on").ok).toBe(false);
  });

  test("gatekeeperUnit is the inverse of readLaunch", () => {
    for (const [slug, active] of [["cms", true], ["sample-api", false]] as const) {
      const unit = gatekeeperUnit(slug, active)!;
      expect(readLaunch([unit], active ? "on" : "off")).toEqual({ ok: true, instance: { slug, active } });
    }
    expect(gatekeeperUnit("cms", true)).toBe("sitesolide-gatekeeper-on@cms.service");
    expect(gatekeeperUnit("../etc", true)).toBeNull();
  });

  test("the backup's path, stable for the steward", () => {
    expect(backupFolder("cms")).toBe("/run/sitesolide-gatekeeper/sauvegardes/cms");
    expect(backupFolder("cms", "/tmp/run")).toBe("/tmp/run/sauvegardes/cms");
    expect(() => backupFolder("..")).toThrow("invalid slug");
  });
});

describe("the holder of Caddy's lock", () => {
  test("one line `<who> <pid> <ms>`, read as it is written", () => {
    for (const who of HOLDERS) {
      const holder = { who, pid: 4242, a: 1_789_650_000_000 };
      expect(holderText(holder)).toBe(`${who} 4242 1789650000000\n`);
      expect(readHolder(holderText(holder))).toEqual(holder);
    }
    // With no trailing newline: `echo -n` from a workstation tool.
    expect(readHolder("deploy 12 1789650000000")).toEqual({ who: "deploy", pid: 12, a: 1_789_650_000_000 });
  });

  test("everything else is unreadable", () => {
    for (const text of [
      "",
      "\n",
      "gatekeeper",
      "gatekeeper 12",
      '{"pid":12,"a":1789650000000}',
      "gatekeeper 0 1789650000000",
      "gatekeeper -1 1789650000000",
      "gatekeeper 12 1789650000000 extra",
      "gatekeeper  12 1789650000000",
      "Gatekeeper 12 1789650000000",
      "gatekeeper 12 1789650000000\n\n",
      "gatekeeper 12 17896500000.5",
      `${"a".repeat(40)} 12 1789650000000`,
      "gate\u0000keeper 12 1789650000000",
    ]) {
      expect({ text, parsed: readHolder(text) }).toEqual({ text, parsed: null });
    }
  });
});

describe("judgeLock", () => {
  const now = 1_800_000_000_000;
  const alive = () => true;
  const dead = () => false;
  const holder = (who: string, a: number, pid = 42) => holderText({ who, pid, a });

  test("a recent lock holds, whoever it belongs to", () => {
    for (const who of HOLDERS) {
      const judgement = judgeLock(holder(who, now - 60_000), now - 60_000, now, alive);
      expect(judgement).toMatchObject({ kind: "held", holder: { who }, since: now - 60_000 });
    }
  });

  test("stale beyond fifteen minutes, even if the pid seems alive", () => {
    const old = now - STALE_LOCK_MS - 1;
    expect(STALE_LOCK_MS).toBe(15 * 60 * 1000);
    expect(judgeLock(holder("deploy-caddy", old), old, now, alive)).toMatchObject({
      kind: "stale",
      reason: "older than 15 minutes",
    });
    const exactly = now - STALE_LOCK_MS;
    expect(judgeLock(holder("deploy-caddy", exactly), exactly, now, alive).kind).toBe("held");
  });

  test("unreadable or with no holder: held, not free, as long as the directory is recent", () => {
    for (const text of [null, "", "anything at all", "gatekeeper 12"]) {
      expect(judgeLock(text, now - 1000, now, dead)).toMatchObject({
        kind: "held",
        holder: null,
        since: now - 1000,
      });
    }
  });

  test("unreadable and stale by the directory's date: taken over", () => {
    const old = now - STALE_LOCK_MS - 1;
    expect(judgeLock(null, old, now, alive)).toMatchObject({ kind: "stale", holder: null });
    expect(judgeLock("unreadable", old, now, alive).kind).toBe("stale");
  });

  test("a holder dated in the future does not hold forever: the directory's date counts", () => {
    const old = now - STALE_LOCK_MS - 1;
    expect(judgeLock(holder("lock", now + 86_400_000), old, now, alive).kind).toBe("stale");
    // And a holder date earlier than the directory's is what counts.
    expect(judgeLock(holder("lock", old), now - 1000, now, alive).kind).toBe("stale");
  });

  test("a dead gatekeeper is taken over at once; a workstation tool, never before fifteen minutes", () => {
    const recent = now - 5000;
    expect(judgeLock(holder("gatekeeper", recent, 99), recent, now, dead)).toMatchObject({
      kind: "stale",
      reason: "gatekeeper 99 is gone",
    });
    expect(judgeLock(holder("gatekeeper", recent, 99), recent, now, alive).kind).toBe("held");
    // A workstation tool's pid is that of an ssh command, dead well before its action ends.
    for (const who of ["deploy-caddy", "lock", "deploy"]) {
      expect(judgeLock(holder(who, recent, 99), recent, now, dead).kind).toBe("held");
    }
  });
});
