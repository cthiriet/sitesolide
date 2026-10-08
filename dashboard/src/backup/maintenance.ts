/**
 * Once a day, inside a run: restic's `prune`, which gives back the room of
 * the snapshots retention forgot, and a check of part of each repository,
 * whose verdict the status file carries to the monitor.
 *
 * - **Prune once a day, not every hour.** A forget costs nothing on disk until
 *   a prune, and a prune holds an exclusive lock. On the server, the default
 *   tolerance of unused data (5%), and no more data repacked than a quarter
 *   of the room above the reserve: prune writes what it repacks before it
 *   deletes, and one disk carries every site. On the bucket, 10% tolerated:
 *   repacking there means downloading and uploading again.
 * - **Check a part every day, the whole in a cycle.** `check
 *   --read-data-subset=n/t` reads the packs of group n out of t: the server's
 *   repository in seven groups, the whole read every week; the bucket's in
 *   twenty-eight, every pack within the four weeks the policy keeps, a
 *   twenty-eighth of the bucket downloaded a day. A part whose check failed,
 *   or was cut short, is read again the next day.
 * - **Inside the run rather than a unit of its own**: one holder of the lock,
 *   one writer of the status, nothing more to install or confine. It starts
 *   only early in a run, and every call stops at the run's offsite deadline:
 *   prune and check may be interrupted at any point (restic's documentation),
 *   a check cut so is reported failed, and the next day reads its part again.
 *   An operator has the next run maintain at once with
 *   `bin/deploy-backup.sh check` (MAINTENANCE_NOW).
 *
 * The first run on a fresh installation starts the clock and checks
 * nothing: a repository of one snapshot has nothing to prune, and its first
 * check comes a day later.
 */
import type { Database } from "bun:sqlite";
import type { BackupConfig } from "./config";
import { readSetting, writeSetting } from "./database";
import { freeBytes } from "./projects";
import { resticFailure, resticJournal, runExclusive, runRestic, type Repository } from "./restic";
import type { Check, Checks } from "./status";

export const MAINTENANCE_EVERY_MS = 24 * 60 * 60 * 1000;
/** No maintenance starts this long after the run's start: it would eat the time of the bucket and the status. */
export const MAINTENANCE_START_MS = 30 * 60 * 1000;
export const LOCAL_SUBSETS = 7;
export const OFFSITE_SUBSETS = 28;
export const OFFSITE_MAX_UNUSED = "10%";

/**
 * What the component's database keeps: when the last maintenance began; when
 * checks of the server's repository were first due (the first run) and of the
 * bucket's (the first run that had one); each repository's last check; and
 * the last part each check read whole, the next day reading the next one, a
 * part cut short being read again.
 */
export type Maintenance = {
  at: number;
  since: number;
  offsiteSince: number | null;
  local: Check | null;
  offsite: Check | null;
  parts: { local: number; offsite: number };
};

export const MAINTENANCE_SETTING = "maintenance";

/**
 * A file the operator lays in the state folder, root's, to have the next run
 * maintain at once: `bin/deploy-backup.sh check` lays it and starts a run.
 */
export const MAINTENANCE_NOW = "maintenance-now";

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.at === "string" && typeof v.ok === "boolean" && (v.error === null || typeof v.error === "string");
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The record, a record of the first release with restic read as well: its clock started when it was first written. */
export function readMaintenance(db: Database): Maintenance | null {
  const value = readSetting(db, MAINTENANCE_SETTING) as Record<string, unknown> | null;
  if (value === null || typeof value.at !== "number") return null;
  const parts = typeof value.parts === "object" && value.parts !== null ? (value.parts as Record<string, unknown>) : {};
  return {
    at: value.at,
    since: typeof value.since === "number" ? value.since : value.at,
    offsiteSince: typeof value.offsiteSince === "number" ? value.offsiteSince : isCheck(value.offsite) ? value.at : null,
    local: isCheck(value.local) ? value.local : null,
    offsite: isCheck(value.offsite) ? value.offsite : null,
    parts: { local: count(parts.local), offsite: count(parts.offsite) },
  };
}

/** The checks as the status file carries them, with when each was first due. */
export function checksOf(maintenance: Maintenance | null): Checks {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    local: maintenance?.local ?? null,
    offsite: maintenance?.offsite ?? null,
    since: iso(maintenance?.since ?? null),
    offsiteSince: iso(maintenance?.offsiteSince ?? null),
  };
}

/** The part of `subsets` a check reads after the last it read whole: every one in turn. */
export function nextPart(last: number, subsets: number): number {
  return (last % subsets) + 1;
}

export type MaintenanceOutcome = { ran: boolean; record: Maintenance };

/** The bucket's side of a maintenance: its repository when it answered this run, and a journal that redacts its credentials. */
export type OffsiteMaintenance = { configured: boolean; repository: Repository | null; log: (line: string) => void };

/**
 * The day's maintenance if it is due, or at once when `force`, under the
 * run's lock. On a day the bucket did not answer, its last check is kept as
 * it was, the monitor judging its age.
 */
export async function maintain(
  dependencies: { config: BackupConfig; now: () => number; log: (line: string) => void },
  db: Database,
  repositories: { local: Repository; offsite: OffsiteMaintenance },
  startedAt: number,
  stopAt: number,
  force = false,
): Promise<MaintenanceOutcome> {
  const { config, now, log } = dependencies;
  const previous = readMaintenance(db);
  const offsiteSince = repositories.offsite.configured ? (previous?.offsiteSince ?? now()) : null;
  if (previous === null && !force) {
    const record: Maintenance = { at: now(), since: now(), offsiteSince, local: null, offsite: null, parts: { local: 0, offsite: 0 } };
    writeSetting(db, MAINTENANCE_SETTING, record);
    return { ran: false, record };
  }
  const base: Maintenance = previous ?? { at: now(), since: now(), offsiteSince, local: null, offsite: null, parts: { local: 0, offsite: 0 } };
  const current: Maintenance = { ...base, offsiteSince, offsite: repositories.offsite.configured ? base.offsite : null };
  const due = force || (now() - base.at >= MAINTENANCE_EVERY_MS && now() - startedAt <= MAINTENANCE_START_MS);
  if (!due) {
    if (current.offsiteSince !== base.offsiteSince || current.offsite !== base.offsite) writeSetting(db, MAINTENANCE_SETTING, current);
    return { ran: false, record: current };
  }

  const at = now();
  const check = async (repository: Repository, prune: string[], part: number, subsets: number, journal: (line: string) => void): Promise<Check> => {
    const stamp = new Date(now()).toISOString();
    const pruned = await runExclusive(config, repository, ["prune", "-q", ...prune], stopAt, journal);
    if (pruned.code !== 0) {
      journal(resticJournal(`backup: restic prune on the ${repository.store} repository`, pruned));
      return { at: stamp, ok: false, error: `the prune failed: ${resticFailure(pruned, repository)}` };
    }
    const checked = await runExclusive(config, repository, ["check", "-q", `--read-data-subset=${part}/${subsets}`], stopAt, journal);
    if (checked.code === 0) return { at: stamp, ok: true, error: null };
    journal(resticJournal(`backup: restic check on the ${repository.store} repository`, checked));
    return {
      at: stamp,
      ok: false,
      error:
        checked.code === 1
          ? `the check of the ${repository.store === "local" ? "server's" : "bucket's"} repository found errors, see the journal of sitesolide-backup`
          : resticFailure(checked, repository),
    };
  };

  // What prune may repack on the server: a quarter of the room above the reserve.
  const room = Math.max(0, freeBytes(config.repository) - config.reserveBytes);
  const localPart = nextPart(current.parts.local, LOCAL_SUBSETS);
  const local = await check(repositories.local, ["--max-repack-size", String(Math.floor(room / 4))], localPart, LOCAL_SUBSETS, log);
  const offsitePart = nextPart(current.parts.offsite, OFFSITE_SUBSETS);
  const offsite =
    repositories.offsite.repository === null
      ? current.offsite
      : await check(repositories.offsite.repository, ["--max-unused", OFFSITE_MAX_UNUSED], offsitePart, OFFSITE_SUBSETS, repositories.offsite.log);
  const record: Maintenance = {
    ...current,
    at,
    local,
    offsite,
    parts: {
      local: local.ok ? localPart : current.parts.local,
      offsite: repositories.offsite.repository !== null && offsite?.ok === true ? offsitePart : current.parts.offsite,
    },
  };
  writeSetting(db, MAINTENANCE_SETTING, record);

  // The size of the whole repository, for the page: one figure for every site, which deduplication shares.
  const stats = await runRestic(config, repositories.local, ["stats", "--mode", "raw-data", "--json", "-q"], stopAt);
  try {
    const size = (JSON.parse(stats.stdout) as { total_size?: unknown }).total_size;
    if (stats.code === 0 && typeof size === "number") writeSetting(db, "repository", { bytes: size, at: new Date(at).toISOString() });
  } catch {
    log(resticJournal("backup: restic stats on the local repository", stats));
  }
  return { ran: true, record };
}
