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
 * It also holds what the collector lets through, `statusFileRefusal` and
 * `copyMonitorStatus`: the collector reads the file as root in a directory the
 * monitor's account owns, and what it may copy into the reading is a rule of
 * this module's, tested without root, the collector only running it.
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

/** The longest string kept from the monitor's status: a summary, a label. */
const MAX_FIELD = 1000;

/** The most problems kept from it: past that, the panel says nothing more. */
const MAX_PROBLEMS = 1000;

const HEARTBEAT_STATES = new Set(["ok", "failed", "unconfigured"]);
const WEBHOOK_STATES = new Set(["ok", "failed", "unconfigured", "idle"]);
const SEVERITIES = new Set(["critical", "warning"]);

/**
 * What the collector puts in place of a status it would not copy: an object
 * that says why, which `monitorDiscrepancies` shows. Silence would read as
 * "no monitor installed", and a refused status may be a monitor broken into.
 */
export function monitorRefusal(reason: string): string {
  return JSON.stringify({ refused: reason });
}

/** What the collector learns of status.json before opening it, or after. */
export type StatusFileInfo = { link: boolean; regular: boolean; links: number; uid: number; size: number };

/**
 * Why the collector, root, must not copy this file, or null.
 *
 * The monitor's directory belongs to its own account, so whatever stands at
 * status.json was put there by that account. A symbolic link would have
 * root read any file it can, /etc/sitesolide/*.env among them, into a reading
 * site-dashboard reads; a hard link to a file of root's keeps root as its
 * owner, and two names are refused anyway; a named pipe would hang the
 * collector; a file of a gigabyte would fill its memory. What passes is a
 * small regular file of the directory's owner, with a single name: written by
 * the monitor, holding nothing the monitor did not already know.
 */
export function statusFileRefusal(info: StatusFileInfo, folderUid: number, maxBytes: number): string | null {
  if (info.link) return "status.json is a symbolic link";
  if (!info.regular) return "status.json is not a regular file";
  if (info.links > 1) return "status.json has more than one name";
  if (info.uid !== folderUid) return "status.json does not belong to the owner of its directory";
  if (info.size > maxBytes) return `status.json is larger than ${maxBytes} bytes`;
  return null;
}

function field(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_FIELD) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The status as the collector writes it into the reading: parsed, then written
 * anew from the fields this module reads, each of the type it expects, strings
 * cut, words outside their list dropped. Never the bytes as they were: even a
 * file that passed `statusFileRefusal` comes from an account that is not
 * root's, and only what this page shows has any reason to cross over. A field
 * the monitor adds reaches the page once this function names it, which is
 * when the page can show it anyway.
 */
export function copyMonitorStatus(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return monitorRefusal("status.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return monitorRefusal("status.json is not an object");
  const status = parsed as Record<string, unknown>;
  const generatedAt = count(status.generatedAt);
  if (generatedAt === undefined) return monitorRefusal("status.json has no date");

  const down = (Array.isArray(status.down) ? status.down : []).slice(0, MAX_PROBLEMS).flatMap((value) => {
    const problem = value as Record<string, unknown> | null;
    if (typeof problem !== "object" || problem === null) return [];
    const kind = field(problem.kind);
    const summary = field(problem.summary);
    if (kind === undefined || summary === undefined) return [];
    return [
      {
        id: field(problem.id),
        kind,
        label: field(problem.label),
        severity: SEVERITIES.has(problem.severity as string) ? (problem.severity as string) : undefined,
        slug: field(problem.slug) ?? null,
        summary,
        since: count(problem.since),
      },
    ];
  });
  return JSON.stringify({
    version: count(status.version),
    generatedAt,
    zone: field(status.zone),
    checks: count(status.checks),
    down,
    heartbeat: HEARTBEAT_STATES.has(status.heartbeat as string) ? status.heartbeat : undefined,
    webhook: WEBHOOK_STATES.has(status.webhook as string) ? status.webhook : undefined,
    undelivered: count(status.undelivered),
    unchecked: count(status.unchecked),
  });
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

  if (typeof status.refused === "string") {
    return [{ slug: null, severity: "warning", message: `Monitor status refused by the collector: ${status.refused}` }];
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
