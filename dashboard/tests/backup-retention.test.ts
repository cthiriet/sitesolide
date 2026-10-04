import { describe, expect, test } from "bun:test";
import { snapshotName, type SnapshotKind } from "../borrowed/backups";
import { DEFAULT_RETENTION, isoWeek, policyFrom, retain, type Dated, type RetentionPolicy } from "../src/backup/retention";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Sunday 4 October 2026, 13:00 UTC. */
const NOW = Date.UTC(2026, 9, 4, 13, 0, 0);

function snapshot(takenAt: number, kind: SnapshotKind = "scheduled"): Dated {
  return { name: snapshotName("cms", takenAt, kind), takenAt, kind };
}

/** One scheduled snapshot every hour for `hours`, the newest at NOW. */
function hourly(hours: number): Dated[] {
  return Array.from({ length: hours }, (_, i) => snapshot(NOW - i * HOUR));
}

describe("retention", () => {
  test("keeps everything while there is less than the policy", () => {
    const all = hourly(5);
    expect(retain(all, DEFAULT_RETENTION)).toEqual({ keep: all.map((s) => s.name), prune: [] });
  });

  test("a month of hourly snapshots: 24 hourly, 7 daily, 4 weekly", () => {
    const all = hourly(31 * 24);
    const { keep, prune } = retain(all, DEFAULT_RETENTION);
    expect(keep.length + prune.length).toBe(all.length);
    // The last 24 hours, every one of them.
    for (let i = 0; i < 24; i++) expect(keep).toContain(snapshotName("cms", NOW - i * HOUR, "scheduled"));
    // The newest of each of the last 7 days: 13:00 today, then 23:00 of the six days before.
    const days = new Set(keep.map((name) => all.find((s) => s.name === name)!.takenAt).map((at) => Math.floor(at / DAY)));
    expect(days.size).toBeGreaterThanOrEqual(7);
    for (let d = 1; d < 7; d++) {
      const lastOfDay = Math.floor(NOW / DAY) * DAY - (d - 1) * DAY - HOUR;
      expect(keep).toContain(snapshotName("cms", lastOfDay, "scheduled"));
    }
    // Four distinct ISO weeks, the newest of each.
    const weeks = new Set(keep.map((name) => isoWeek(all.find((s) => s.name === name)!.takenAt)));
    expect(weeks.size).toBe(4);
    // 24 hourly + 6 more days (today is already among the hours) + 3 more weeks at most.
    expect(keep.length).toBeLessThanOrEqual(24 + 7 + 4);
  });

  test("hours with a snapshot, not hours of the clock: a stop of three days keeps the history", () => {
    // 30 hourly snapshots ending three days ago, then one now.
    const before = Array.from({ length: 30 }, (_, i) => snapshot(NOW - 3 * DAY - i * HOUR));
    const all = [snapshot(NOW), ...before];
    const { keep } = retain(all, { hourly: 24, daily: 0, weekly: 0, preRestore: 0 });
    expect(keep).toHaveLength(24);
    expect(keep[0]).toBe(snapshotName("cms", NOW, "scheduled"));
    expect(keep).toContain(snapshotName("cms", NOW - 3 * DAY - 22 * HOUR, "scheduled"));
  });

  test("two snapshots in one hour: the newer one stands for it", () => {
    const all = [snapshot(NOW - 50 * 60_000), snapshot(NOW - 10 * 60_000), snapshot(NOW - 2 * HOUR)];
    const { keep, prune } = retain(all, { hourly: 24, daily: 0, weekly: 0, preRestore: 0 });
    expect(prune).toEqual([snapshotName("cms", NOW - 50 * 60_000, "scheduled")]);
    expect(keep).toEqual([snapshotName("cms", NOW - 10 * 60_000, "scheduled"), snapshotName("cms", NOW - 2 * HOUR, "scheduled")]);
  });

  test("never the newest, even with a policy of zero everywhere", () => {
    const zero: RetentionPolicy = { hourly: 0, daily: 0, weekly: 0, preRestore: 0 };
    const all = [...hourly(10), snapshot(NOW + 60_000, "pre-restore")];
    const { keep } = retain(all, zero);
    // The newest of all, a pre-restore, and the newest scheduled one.
    expect(keep).toEqual([snapshotName("cms", NOW + 60_000, "pre-restore"), snapshotName("cms", NOW, "scheduled")]);
  });

  test("pre-restore snapshots are kept apart: the last three, whatever their age", () => {
    const restores = [1, 2, 3, 4].map((weeks) => snapshot(NOW - weeks * 7 * DAY, "pre-restore"));
    const all = [...hourly(48), ...restores];
    const { keep, prune } = retain(all, DEFAULT_RETENTION);
    expect(keep).toContain(restores[0]!.name);
    expect(keep).toContain(restores[2]!.name);
    expect(prune).toContain(restores[3]!.name);
    // And they take no calendar bucket from a scheduled snapshot.
    expect(keep.filter((name) => !name.includes("pre-restore"))).toHaveLength(retain(hourly(48), DEFAULT_RETENTION).keep.length);
  });

  test("the order of the listing changes nothing", () => {
    const all = hourly(100);
    const shuffled = [...all].reverse();
    expect(retain(shuffled, DEFAULT_RETENTION)).toEqual(retain(all, DEFAULT_RETENTION));
  });

  test("nothing listed, nothing decided", () => {
    expect(retain([], DEFAULT_RETENTION)).toEqual({ keep: [], prune: [] });
  });

  test("ISO weeks start on Monday, and the year's first holds its Thursday", () => {
    expect(isoWeek(Date.UTC(2026, 9, 4))).toBe("2026-W40");
    expect(isoWeek(Date.UTC(2026, 9, 5))).toBe("2026-W41");
    // 1 January 2027 is a Friday: it belongs to the last week of 2026.
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01");
  });
});

describe("the policy from the unit's environment", () => {
  test("defaults for what is not said", () => {
    expect(policyFrom({})).toEqual(DEFAULT_RETENTION);
    expect(policyFrom({ BACKUP_KEEP_HOURLY: "48", BACKUP_KEEP_WEEKLY: "0" })).toEqual({ ...DEFAULT_RETENTION, hourly: 48, weekly: 0 });
  });

  test("a value that is not a count stops the run rather than pruning everything", () => {
    for (const value of ["-1", "ten", "1.5", "1001", " 3"]) {
      expect(policyFrom({ BACKUP_KEEP_DAILY: value })).toEqual({ error: "BACKUP_KEEP_DAILY must be a whole number from 0 to 1000" });
    }
  });
});
