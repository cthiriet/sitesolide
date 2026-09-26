/**
 * The snapshot dropped for the dashboard.
 *
 * **This service has no page, and cannot have one.** The numbers are read in
 * the dashboard, which can neither open this database, its `/srv` being an
 * empty mount, nor reach this service over the loopback, which the port rule
 * reserves for Caddy and root. The only existing path is the one the dashboard
 * already uses for the state of the machine: a privileged collector passes
 * every minute, reads, and drops.
 *
 * This file is therefore written here, in this service's data directory, and
 * copied as is by that collector. It carries counts, not decisions: the bounce
 * rate, the average duration and the formatting belong to the dashboard, which
 * computes them at display time. It is the same division as that of the
 * machine's reading, and for the same reason: what changes often must not live
 * inside what is written rarely.
 *
 * It carries **no visitor fingerprint**. Fingerprints never leave this
 * database: what comes out is already aggregated, and is no longer attachable
 * to anyone even on the day the salt still exists.
 */
import { renameSync } from "node:fs";
import { RANKING_MAX, TIME_ZONE } from "./config";
import {
  RANKINGS,
  rank,
  daysOf,
  totalsOf,
  type Ranking,
  type DayCount,
  type Row,
  type Totals,
} from "./db";
import { knownHosts } from "./hosts";
import { dayWindow, dayOf } from "./day";

/**
 * The snapshot's window, in days.
 *
 * Thirty: that is the question a dashboard opened in the morning asks, and that
 * is what the curve shows. A wider window would be produced by aggregating
 * several snapshots, which nobody asks for today.
 */
export const DAYS = 30;

export type SiteMeasure = {
  totals: Totals;
  /** One entry per day of the window, empty days included. */
  days: DayCount[];
  /** The rankings, by block key: path, source, device and so on. */
  rankings: Record<string, Row[]>;
};

export type Snapshot = {
  generatedAt: number;
  timeZone: string;
  days: number;
  from: string;
  to: string;
  /** By served directory, as the collector named it in `hotes.json`. */
  sites: Record<string, SiteMeasure>;
};

/**
 * Composes the snapshot of every known site.
 *
 * The sites come from the host table, and not from the page views: a deployed
 * site that has not yet received anybody must appear with zeros, otherwise
 * nothing would say whether its tag is properly placed. It is the most frequent
 * question of the first days.
 */
export function compose(now: number): Snapshot {
  const today = dayOf(now, TIME_ZONE);
  const dates = dayWindow(today, DAYS);
  const from = dates[0] ?? today;

  const sites: Record<string, SiteMeasure> = {};
  for (const site of new Set(Object.values(knownHosts(now)))) {
    const known = new Map(daysOf(site, from, today).map((j) => [j.day, j]));

    sites[site] = {
      totals: totalsOf(site, from, today),
      // The days without a visit are restored here rather than in the
      // dashboard: the database has no row to say anything about them, and a
      // curve that skipped them would bring two points a week apart together.
      days: dates.map((day) => known.get(day) ?? { day, views: 0, visits: 0 }),
      // Every ranking the database can return: which one is displayed, and
      // under what title, belongs to the dashboard.
      rankings: Object.fromEntries(
        (Object.keys(RANKINGS) as Ranking[]).map((what) => [
          what,
          rank(what, site, from, today, RANKING_MAX),
        ]),
      ),
    };
  }

  return {
    generatedAt: now,
    timeZone: TIME_ZONE,
    days: DAYS,
    from,
    to: today,
    sites,
  };
}

/**
 * Writes the snapshot, by renaming.
 *
 * The collector can read at the very moment this service writes. An in-place
 * `write` would hand it a truncated JSON document once in a thousand, which
 * would show as an empty dashboard without anything saying why; a rename is
 * atomic, and the reader sees the old file or the new one, never half a file.
 */
export async function write(path: string, now: number): Promise<number> {
  const content = `${JSON.stringify(compose(now))}\n`;
  const temp = `${path}.tmp`;

  await Bun.write(temp, content);
  renameSync(temp, path);

  return content.length;
}
