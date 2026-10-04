/**
 * What the dashboard is handed: /var/lib/sitesolide-monitor/status.json.
 *
 * The dashboard cannot read the machine, by design (dashboard/README.md): its
 * collector, under root, copies this file into the snapshot it already drops
 * every minute, the way it copies the audience measurement. The dashboard then
 * judges it in dashboard/src/monitor.ts and shows what is down among its
 * Issues.
 *
 * It is the contract between the two, kept small and additive: a field is
 * added, never renamed, and the dashboard reads each one defensively, since
 * either side may be deployed before the other. It holds what is down and how
 * the alerting fared, never an alerting address.
 *
 * Pure.
 */
import { isDown, type Tracked } from "./alerts";
import type { Kind, Severity } from "./checks";

export const STATUS_VERSION = 1;

export type StatusProblem = {
  id: string;
  kind: Kind;
  label: string;
  severity: Severity;
  slug: string | null;
  summary: string;
  /** When the failure started, in epoch milliseconds. */
  since: number;
};

/**
 * `unconfigured`: no address set, the journal is the only output. `idle`: a
 * webhook is set and this run had nothing to say. `failed`: the last attempt
 * did not go through; for the webhook, the notices wait for the next run.
 */
export type ChannelState = "ok" | "failed" | "unconfigured" | "idle";

export type MonitorStatus = {
  version: typeof STATUS_VERSION;
  /** When the run that wrote it began, in epoch milliseconds. */
  generatedAt: number;
  zone: string;
  /** How many checks the monitor follows. */
  checks: number;
  /** What is down, an alert having left: critical first. */
  down: StatusProblem[];
  heartbeat: Exclude<ChannelState, "idle">;
  webhook: ChannelState;
  /** Notices kept for a webhook that did not take them. */
  undelivered: number;
};

export function buildStatus(options: {
  now: number;
  zone: string;
  checks: Readonly<Record<string, Tracked>>;
  heartbeat: MonitorStatus["heartbeat"];
  webhook: ChannelState;
  undelivered: number;
}): MonitorStatus {
  const down = Object.entries(options.checks)
    .filter(([, tracked]) => isDown(tracked))
    .map(([id, tracked]) => ({
      id,
      kind: tracked.kind,
      label: tracked.label,
      severity: tracked.severity,
      slug: tracked.slug,
      summary: tracked.summary,
      since: tracked.since,
    }))
    .sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === "critical" ? -1 : 1));
  return {
    version: STATUS_VERSION,
    generatedAt: options.now,
    zone: options.zone,
    checks: Object.keys(options.checks).length,
    down,
    heartbeat: options.heartbeat,
    webhook: options.webhook,
    undelivered: options.undelivered,
  };
}
