/**
 * The monitor's memory between two runs: /var/lib/sitesolide-monitor/state.json.
 *
 * The timer launches a fresh process every minute; without this file every
 * run would be the first, and "alert once when it goes down" would mean
 * nothing. It holds each check's state, Caddy's last restart counter, and the
 * notices a webhook has not taken yet.
 *
 * A missing, truncated or foreign file is a fresh start, said in the journal,
 * never a crash: the worst a lost memory costs is one more alert for something
 * already down, where a monitor that stops on its own state file costs every
 * alert after it.
 *
 * Pure, the reading and writing of the file aside, which belong to the run.
 */
import type { Notice, Status, Tracked } from "./alerts";
import type { RestartMemory } from "./checks";

export const STATE_VERSION = 1;

/** Beyond that many, the oldest notices waiting for the webhook are dropped. */
export const MAX_OUTBOX = 50;

/** A notice a day old is no longer news worth delivering late. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type State = {
  version: typeof STATE_VERSION;
  checks: Record<string, Tracked>;
  restarts: RestartMemory | null;
  outbox: Notice[];
};

export function emptyState(): State {
  return { version: STATE_VERSION, checks: {}, restarts: null, outbox: [] };
}

const STATUSES: readonly Status[] = ["ok", "failing", "down", "recovering"];

function isTracked(value: unknown): value is Tracked {
  const tracked = value as Partial<Tracked> | null;
  return (
    typeof tracked === "object" &&
    tracked !== null &&
    typeof tracked.kind === "string" &&
    typeof tracked.label === "string" &&
    (tracked.severity === "critical" || tracked.severity === "warning") &&
    (tracked.slug === null || typeof tracked.slug === "string") &&
    STATUSES.includes(tracked.status as Status) &&
    Number.isInteger(tracked.streak) &&
    typeof tracked.since === "number" &&
    typeof tracked.summary === "string" &&
    (tracked.checkedAt === undefined || typeof tracked.checkedAt === "number")
  );
}

function isNotice(value: unknown): value is Notice {
  const notice = value as Partial<Notice> | null;
  return (
    typeof notice === "object" &&
    notice !== null &&
    (notice.event === "down" || notice.event === "recovered" || notice.event === "cleared") &&
    typeof notice.id === "string" &&
    typeof notice.summary === "string" &&
    typeof notice.at === "number" &&
    typeof notice.since === "number"
  );
}

/**
 * The state the file holds, or a fresh one and the reason. A single malformed
 * check is dropped rather than the whole memory: it will be read again as new.
 */
export function parseState(text: string | null): { state: State; problem: string | null } {
  if (text === null) return { state: emptyState(), problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: emptyState(), problem: "state.json is not valid JSON, starting afresh" };
  }
  const record = raw as Partial<State> | null;
  if (typeof record !== "object" || record === null || record.version !== STATE_VERSION) {
    return { state: emptyState(), problem: "state.json is from another version, starting afresh" };
  }

  const checks: Record<string, Tracked> = {};
  for (const [id, tracked] of Object.entries(record.checks ?? {})) {
    if (isTracked(tracked)) checks[id] = tracked;
  }
  const restarts = record.restarts as Partial<RestartMemory> | null | undefined;
  const validRestarts =
    typeof restarts === "object" &&
    restarts !== null &&
    Number.isInteger(restarts.count) &&
    (restarts.increasedAt === null || typeof restarts.increasedAt === "number")
      ? (restarts as RestartMemory)
      : null;
  const outbox = Array.isArray(record.outbox) ? record.outbox.filter(isNotice) : [];
  return { state: { version: STATE_VERSION, checks, restarts: validRestarts, outbox }, problem: null };
}

/** The notices still worth delivering: a day at most, fifty at most, the newest kept. */
export function trimOutbox(outbox: readonly Notice[], now: number): Notice[] {
  return outbox.filter((notice) => now - notice.at <= OUTBOX_MAX_AGE_MS).slice(-MAX_OUTBOX);
}
