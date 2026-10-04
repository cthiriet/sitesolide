/**
 * What a run is told, from its environment.
 *
 * Every path comes from a variable whose default is where the machine keeps
 * it, so that the same code runs on a test tree; none names a machine. The
 * zone is the exception that has no default at all: a ready-made zone here
 * would be the one of this file's author, and the monitor would probe his
 * sites from somebody else's machine. It comes from /etc/caddy/sitesolide.env,
 * the file Caddy reads, through the unit's EnvironmentFile, so that the two
 * can never disagree on what is served.
 *
 * The alerting addresses come from /etc/sitesolide/dashboard-monitor.env, set
 * from the dashboard. An address that is not one is reported as a problem of
 * the monitor itself, never quoted, and the channel stays silent.
 *
 * Pure: receives the environment, returns the configuration or why there is
 * none.
 */
import { alertUrl, webhookFormat, type WebhookFormat } from "./notify";

export type ProbeConfig = {
  /** Where Caddy listens: the loopback and 443 on the machine. */
  address: string;
  port: number;
  /** A test authority's certificate, null for the system's store. */
  ca: string | null;
  /** One probe, at most. */
  timeoutMs: number;
};

export type Config = {
  zone: string;
  sitesDir: string;
  domainsFile: string;
  stateDir: string;
  backupFile: string;
  /** The filesystems to watch, by a path on each; duplicates are merged by device. */
  diskPaths: string[];
  probe: ProbeConfig;
  /** How many probes run at once. */
  concurrency: number;
  /** All the probes of a run together, at most: past it, the rest are unknown. */
  probeBudgetMs: number;
  heartbeatUrl: string | null;
  webhookUrl: string | null;
  webhookFormat: WebhookFormat;
  /** What is wrong with the configuration itself, reported as a check. */
  problems: string[];
};

/**
 * The unit's TimeoutStartSec is 50 s, and the heartbeat must leave before it:
 * the readings take 5 s at most (SYSTEMCTL_TIMEOUT_MS), the probes 25, the
 * heartbeat and the webhook 10 together, which leaves 10 to spare.
 */
export const PROBE_BUDGET_MS = 25_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const CONCURRENCY = 8;

export function readConfig(env: Record<string, string | undefined>): { config: Config } | { error: string } {
  const zone = (env.SITESOLIDE_ZONE ?? "").trim();
  if (zone === "") {
    return { error: "SITESOLIDE_ZONE is missing, and no zone is assumed here: is /etc/caddy/sitesolide.env in place?" };
  }

  const problems: string[] = [];
  // Optional all three: absent, the channel is silent and the journal alone
  // hears. bin/tests/units-env.test.ts reads `?? null` as exactly that.
  const heartbeat = alertUrl("HEARTBEAT_URL", env.HEARTBEAT_URL ?? null);
  const webhook = alertUrl("ALERT_WEBHOOK_URL", env.ALERT_WEBHOOK_URL ?? null);
  const format = webhookFormat(env.ALERT_WEBHOOK_FORMAT ?? null, webhook.url);
  for (const problem of [heartbeat.problem, webhook.problem, format.problem]) {
    if (problem !== null) problems.push(problem);
  }

  const port = Number(env.PROBE_PORT ?? "443");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: "PROBE_PORT is not a port" };

  return {
    config: {
      zone,
      sitesDir: env.SITES_DIR ?? "/srv/sites",
      domainsFile: env.DOMAINS_FILE ?? "/etc/caddy/domaines.map",
      // systemd sets STATE_DIRECTORY from the unit's StateDirectory=.
      stateDir: env.STATE_DIRECTORY ?? "/var/lib/sitesolide-monitor",
      backupFile: env.BACKUP_STATUS_FILE ?? "/var/lib/sitesolide-backup/last-run.json",
      diskPaths: (env.DISK_PATHS ?? "/,/srv,/var").split(",").map((path) => path.trim()).filter((path) => path !== ""),
      probe: { address: env.PROBE_ADDRESS ?? "127.0.0.1", port, ca: null, timeoutMs: PROBE_TIMEOUT_MS },
      concurrency: CONCURRENCY,
      probeBudgetMs: PROBE_BUDGET_MS,
      heartbeatUrl: heartbeat.url,
      webhookUrl: webhook.url,
      webhookFormat: format.format,
      problems,
    },
  };
}
