/**
 * Which snapshots are kept, and which go.
 *
 * Pure: a list of snapshots and a policy come in, two lists of names come out.
 * Every rule that deletes a backup lives here, checked without a disk, because
 * a mistake in it is only discovered on the day the snapshot it deleted is the
 * one that was needed.
 *
 * The policy is the usual one of backup tools: for each of the last N hours
 * that have a snapshot, keep the newest of that hour; the same for days and
 * ISO weeks. "The last N hours that have a snapshot", not "the last N hours of
 * the clock": a machine stopped for three days still keeps its 24 hourly
 * snapshots from before the stop, instead of waking up to an empty history.
 *
 * Three rules hold whatever the policy says:
 *
 * - the newest snapshot of all, and the newest scheduled one, are never
 *   deleted, so a project always has at least one;
 * - a name that is not a snapshot never reaches here (bin/cli/backups.ts
 *   reads it as null), so nothing unknown is ever deleted;
 * - this runs only under the component's lock (lock.ts), so never while a
 *   restore reads one of them.
 */
import type { SnapshotKind } from "../../borrowed/backups";

export type RetentionPolicy = {
  /** Newest snapshot of each of the last N hours that have one. */
  hourly: number;
  daily: number;
  weekly: number;
  /** The last N taken just before a restore, kept apart from the calendar. */
  preRestore: number;
};

/**
 * One day of hourly snapshots, one week of daily ones, a month of weekly ones,
 * and the three last restores undoable. For a data folder of 100 MB that
 * compresses to 20, that is at most 38 archives, about 760 MB.
 */
export const DEFAULT_RETENTION: RetentionPolicy = { hourly: 24, daily: 7, weekly: 4, preRestore: 3 };

/** A count above this is a typing mistake, not a policy. */
export const MAX_KEEP = 1000;

export type Dated = { name: string; takenAt: number; kind: SnapshotKind };

export type Decision = { keep: string[]; prune: string[] };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The ISO week, `2026-W40`: Monday to Sunday, the week of the year's first Thursday being the first. */
export function isoWeek(ms: number): string {
  const date = new Date(Math.floor(ms / DAY_MS) * DAY_MS);
  // The Thursday of the same week decides the year the week belongs to.
  const weekday = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  const firstMonday = firstThursday.getTime() - firstWeekday * DAY_MS;
  const week = Math.floor((thursday.getTime() - firstMonday) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const BUCKETS: { key: keyof Omit<RetentionPolicy, "preRestore">; of: (ms: number) => string }[] = [
  { key: "hourly", of: (ms) => String(Math.floor(ms / HOUR_MS)) },
  { key: "daily", of: (ms) => String(Math.floor(ms / DAY_MS)) },
  { key: "weekly", of: isoWeek },
];

/** Newest first; on the same second, the name decides, so the order never depends on the listing. */
function newestFirst(a: Dated, b: Dated): number {
  return b.takenAt - a.takenAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
}

export function retain(snapshots: readonly Dated[], policy: RetentionPolicy): Decision {
  const ordered = [...snapshots].sort(newestFirst);
  const keep = new Set<string>();

  const newest = ordered[0];
  if (newest !== undefined) keep.add(newest.name);

  const scheduled = ordered.filter((snapshot) => snapshot.kind === "scheduled");
  const newestScheduled = scheduled[0];
  if (newestScheduled !== undefined) keep.add(newestScheduled.name);

  for (const { key, of } of BUCKETS) {
    const seen = new Set<string>();
    for (const snapshot of scheduled) {
      if (seen.size >= policy[key]) break;
      const bucket = of(snapshot.takenAt);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      keep.add(snapshot.name);
    }
  }

  for (const snapshot of ordered.filter((candidate) => candidate.kind === "pre-restore").slice(0, policy.preRestore)) {
    keep.add(snapshot.name);
  }

  return {
    keep: ordered.filter((snapshot) => keep.has(snapshot.name)).map((snapshot) => snapshot.name),
    prune: ordered.filter((snapshot) => !keep.has(snapshot.name)).map((snapshot) => snapshot.name),
  };
}

/**
 * The policy from the unit's environment, the defaults for what it does not
 * say. A value that is not a whole number between 0 and MAX_KEEP stops the
 * run rather than being read as zero, which would prune everything but one.
 */
export function policyFrom(env: Record<string, string | undefined>): RetentionPolicy | { error: string } {
  const policy = { ...DEFAULT_RETENTION };
  const names: [keyof RetentionPolicy, string][] = [
    ["hourly", "BACKUP_KEEP_HOURLY"],
    ["daily", "BACKUP_KEEP_DAILY"],
    ["weekly", "BACKUP_KEEP_WEEKLY"],
    ["preRestore", "BACKUP_KEEP_PRE_RESTORE"],
  ];
  for (const [key, variable] of names) {
    const raw = env[variable];
    if (raw === undefined || raw === "") continue;
    if (!/^[0-9]+$/.test(raw) || Number(raw) > MAX_KEEP) return { error: `${variable} must be a whole number from 0 to ${MAX_KEEP}` };
    policy[key] = Number(raw);
  }
  return policy;
}
