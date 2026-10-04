/**
 * When to speak: once when a check goes down, once when it recovers, never in
 * between.
 *
 * Pure: receives what was remembered, what this run saw and the time, returns
 * what to remember and what to say. The run calls it once a minute and nothing
 * else decides whether an alert leaves.
 *
 * Four states per check:
 *
 *   ok          nothing to say
 *   failing     failed, not yet for long enough to wake anybody
 *   down        alerted; stays so while it fails
 *   recovering  down, answering again, not yet for long enough to say so
 *
 * Two failures in a row before `down`, two successes in a row before `ok`
 * again. A deployment restarts its service and may miss one probe; a site that
 * blinks once must not cost two messages. The price is a minute of delay, on a
 * monitor that runs every minute and on a machine where the restart policy
 * already brings Caddy back within seconds.
 *
 * Or three failures among the last five verdicts. Counted in a row only, a
 * site that fails every other pass, half its visitors refused, never reached
 * two and was never reported. Three in five catches it within five minutes,
 * while a deployment's blink, one failure, and two of them minutes apart,
 * still say nothing. Between failures that do not yet make an alert, the
 * check stays `failing`, dated from the first, until the last failure has
 * left the five; a recovery starts the count afresh, its failures having
 * already cost their alert.
 *
 * An `unknown` verdict changes nothing, not even the streak: a reading that
 * could not be taken neither confirms nor clears a failure. A check this run
 * did not produce at all is gone, a removed site, a unit systemd unloaded: it
 * is forgotten, and if it was down, one last notice says it is no longer
 * checked, so that nobody waits for a recovery that will never be announced.
 * Except for the kinds the run declares unknown as a whole: when `systemctl`
 * did not answer, every unit is missing from the run without any of them
 * having gone anywhere.
 */
import type { Kind, Result, Severity } from "./checks";

export const FAIL_AFTER = 2;
export const RECOVER_AFTER = 2;
/** Or this many failures among the last WINDOW verdicts. */
export const FAIL_WITHIN = 3;
export const WINDOW = 5;

export type Status = "ok" | "failing" | "down" | "recovering";

export type Tracked = {
  kind: Kind;
  label: string;
  severity: Severity;
  slug: string | null;
  status: Status;
  /** Consecutive verdicts pushing towards the next status. */
  streak: number;
  /**
   * When the check last went from good to bad, or back: what "down for" and
   * "recovered after" count from.
   */
  since: number;
  /** What the last known verdict said. */
  summary: string;
  /**
   * When the check last had a verdict that was not `unknown`: the probes of a
   * run short of time start with the least recently checked. Absent from a
   * memory written before it existed, which reads as never checked.
   */
  checkedAt?: number;
  /**
   * The last WINDOW verdicts that were not `unknown`, oldest first, `f` for a
   * failure and `o` for a success. Absent from a memory written before it
   * existed, which reads as no failure yet.
   */
  recent?: string;
};

export type Event = "down" | "recovered" | "cleared";

export type Notice = {
  event: Event;
  id: string;
  kind: Kind;
  label: string;
  severity: Severity;
  slug: string | null;
  summary: string;
  /** When this run saw it. */
  at: number;
  /** When the failure started: the first failed verdict, not the alert. */
  since: number;
};

/** Down for the outside world: an alert has left and no recovery yet. */
export function isDown(tracked: Tracked): boolean {
  return tracked.status === "down" || tracked.status === "recovering";
}

/** Not ok, for whatever reason: what a hysteresis threshold reads. */
export function isBad(tracked: Tracked | undefined): boolean {
  return tracked !== undefined && tracked.status !== "ok";
}

function notice(event: Event, id: string, tracked: Tracked, now: number): Notice {
  return {
    event,
    id,
    kind: tracked.kind,
    label: tracked.label,
    severity: tracked.severity,
    slug: tracked.slug,
    summary: tracked.summary,
    at: now,
    since: tracked.since,
  };
}

/**
 * One check, one verdict. `since` moves when a failure starts and when a
 * failure that never became an alert ends; on a recovery it is left to the
 * caller, which still needs the start of the failure for the notice.
 */
function step(previous: Tracked, result: Result, now: number): { tracked: Tracked; event: Event | null } {
  const tracked: Tracked = {
    ...previous,
    kind: result.kind,
    label: result.label,
    severity: result.severity,
    slug: result.slug,
  };
  if (result.verdict === "unknown") return { tracked, event: null };
  tracked.summary = result.summary;
  tracked.checkedAt = now;
  const failed = result.verdict === "fail";
  tracked.recent = `${previous.recent ?? ""}${failed ? "f" : "o"}`.slice(-WINDOW);
  const failures = tracked.recent.split("").filter((verdict) => verdict === "f").length;

  if (previous.status === "ok" || previous.status === "failing") {
    if (!failed) {
      // A failure still among the last five may be the first of a site that
      // fails every other pass: still failing, still dated from it.
      if (failures > 0 && previous.status === "failing") {
        return { tracked: { ...tracked, status: "failing", streak: 0 }, event: null };
      }
      const since = previous.status === "ok" ? previous.since : now;
      return { tracked: { ...tracked, status: "ok", streak: 0, since }, event: null };
    }
    const streak = previous.status === "ok" ? 1 : previous.streak + 1;
    const since = previous.status === "ok" ? now : previous.since;
    if (streak >= FAIL_AFTER || failures >= FAIL_WITHIN) {
      return { tracked: { ...tracked, status: "down", streak: 0, since }, event: "down" };
    }
    return { tracked: { ...tracked, status: "failing", streak, since }, event: null };
  }

  // down or recovering
  if (failed) return { tracked: { ...tracked, status: "down", streak: 0 }, event: null };
  const streak = previous.status === "down" ? 1 : previous.streak + 1;
  if (streak >= RECOVER_AFTER) return { tracked: { ...tracked, status: "ok", streak: 0, recent: "" }, event: "recovered" };
  return { tracked: { ...tracked, status: "recovering", streak }, event: null };
}

/**
 * The next memory and the notices of this run, in the order of the results.
 * A recovered notice carries the time the failure began, so that the message
 * can say how long it lasted; the memory then starts counting the good time.
 */
export function advance(
  previous: Readonly<Record<string, Tracked>>,
  results: readonly Result[],
  now: number,
  unknownKinds: ReadonlySet<Kind> = new Set(),
): { checks: Record<string, Tracked>; notices: Notice[] } {
  const checks: Record<string, Tracked> = {};
  const notices: Notice[] = [];

  for (const result of results) {
    if (checks[result.id] !== undefined) continue;
    const before: Tracked = previous[result.id] ?? {
      kind: result.kind,
      label: result.label,
      severity: result.severity,
      slug: result.slug,
      status: "ok",
      streak: 0,
      since: now,
      summary: result.summary,
    };
    const { tracked, event } = step(before, result, now);
    if (event !== null) notices.push(notice(event, result.id, tracked, now));
    checks[result.id] = event === "recovered" ? { ...tracked, since: now } : tracked;
  }

  for (const [id, tracked] of Object.entries(previous)) {
    if (checks[id] !== undefined) continue;
    if (unknownKinds.has(tracked.kind)) {
      checks[id] = tracked;
      continue;
    }
    if (isDown(tracked)) notices.push(notice("cleared", id, tracked, now));
  }

  return { checks, notices };
}
