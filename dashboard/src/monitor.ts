/**
 * What the monitor found down, among the Issues of the home page.
 *
 * The monitor (monitor/README.md) runs every minute under an account of its
 * own and leaves a small status; the collector copies it into the reading,
 * like the audience snapshot, since this service reads nothing of the machine
 * itself. This module turns it into discrepancies, so that a site the monitor
 * sees down over HTTPS, a certificate about to expire or a failed backup sit
 * in the panel that already answers "is the machine all right", with no page
 * of their own.
 *
 * Three kinds are left out, a project's unit, the disk and the memory: the
 * dashboard already judges them from the collector's own reading, and two rows
 * for one fact would only make the list longer.
 *
 * The status is read defensively, field by field: the monitor and the
 * dashboard are deployed separately, either may be older than the other, and
 * a field this module does not know is ignored rather than refused.
 *
 * Pure: no clock, the age is measured against the collector's own reading.
 */
import type { Discrepancy } from "./state";

/**
 * Beyond that, the status no longer describes the machine. The monitor passes
 * every minute: five minutes without a new status means its timer stopped or
 * its runs fail, and what it last saw is not shown as the present.
 */
export const MONITOR_STALE_MS = 5 * 60 * 1000;

/** Judged elsewhere on this page, from the collector's own reading. */
const ALREADY_SHOWN = new Set(["unit", "disk", "memory"]);

type Problem = { kind: string; severity: string; slug: string | null; summary: string; since: number | null };

/** How long, in the largest unit that fits, as the monitor writes it. */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

function readProblem(value: unknown): Problem | null {
  const problem = value as Record<string, unknown> | null;
  if (typeof problem !== "object" || problem === null) return null;
  if (typeof problem.kind !== "string" || typeof problem.summary !== "string") return null;
  return {
    kind: problem.kind,
    severity: typeof problem.severity === "string" ? problem.severity : "warning",
    slug: typeof problem.slug === "string" ? problem.slug : null,
    summary: problem.summary,
    since: typeof problem.since === "number" ? problem.since : null,
  };
}

/**
 * The monitor's discrepancies. `content` is the file as the collector copied
 * it: undefined from a collector older than the monitor, null when the monitor
 * is not installed, two normal states that say nothing.
 */
export function monitorDiscrepancies(content: string | null | undefined, generated: number): Discrepancy[] {
  if (content === null || content === undefined) return [];

  let status: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("an object was expected");
    status = parsed as Record<string, unknown>;
  } catch (err) {
    return [{ slug: null, severity: "warning", message: `Monitor status unreadable: ${(err as Error).message}` }];
  }

  const at = typeof status.generatedAt === "number" ? status.generatedAt : null;
  if (at === null) return [{ slug: null, severity: "warning", message: "Monitor status unreadable: no date" }];
  if (generated - at > MONITOR_STALE_MS) {
    return [
      {
        slug: null,
        severity: "warning",
        message:
          `Monitor silent for ${duration(generated - at)}: sitesolide-monitor.timer no longer runs, ` +
          'or its runs fail, see "journalctl -u sitesolide-monitor"',
      },
    ];
  }

  const discrepancies: Discrepancy[] = [];
  for (const problem of (Array.isArray(status.down) ? status.down : []).map(readProblem)) {
    if (problem === null || ALREADY_SHOWN.has(problem.kind)) continue;
    const lasting = problem.since === null ? "" : `, for ${duration(Math.max(0, generated - problem.since))}`;
    discrepancies.push({
      slug: problem.slug,
      severity: problem.severity === "critical" ? "error" : "warning",
      message: `${problem.summary} (monitor${lasting})`,
    });
  }

  if (status.heartbeat === "failed") {
    discrepancies.push({
      slug: null,
      severity: "warning",
      message: "The monitor's heartbeat did not go through: its outside service will report the machine as down",
    });
  }
  // A Caddy too slow for the monitor's budget: what it could not reach keeps
  // its last state, which may be older than this page lets on.
  const unchecked = typeof status.unchecked === "number" ? status.unchecked : 0;
  if (unchecked > 0) {
    discrepancies.push({
      slug: null,
      severity: "warning",
      message:
        `${unchecked} check${unchecked === 1 ? "" : "s"} skipped by the monitor's last pass, out of time: ` +
        "they keep their last state, the next pass starts with them",
    });
  }
  const undelivered = typeof status.undelivered === "number" ? status.undelivered : 0;
  if (status.webhook === "failed" && undelivered > 0) {
    discrepancies.push({
      slug: null,
      severity: "warning",
      message: `${undelivered} monitor alert${undelivered === 1 ? "" : "s"} not delivered to the webhook, kept for its next run`,
    });
  }
  return discrepancies;
}
