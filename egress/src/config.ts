/**
 * The proxy's settings, each from an environment variable with the
 * production value as its default: the unit sets none of them, and the tests
 * and a run on the workstation set them all.
 *
 *   DATA_DIR=/tmp/egress SITES_DIR=/tmp/srv/sites CONFIG_DIR=/tmp/etc \
 *     PROXY_PORT=4128 CONNECTORS_PORT=4129 bun server.ts
 *
 * Frozen at first import: tests/setup.ts diverts them before.
 *
 * No setting names a machine. The proxy needs no zone and no server: it
 * serves the projects of whatever machine it runs on, found by their accounts
 * and their folders.
 */
import { CONNECTORS_PORT as DEFAULT_CONNECTORS_PORT, EGRESS_ADDRESS, EGRESS_PROXY_PORT } from "../../bin/cli/egress";
import { EGRESS_CONFIG_DIR } from "../../bin/cli/connectors";

export const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS ?? EGRESS_ADDRESS;
export const PROXY_PORT = Number(process.env.PROXY_PORT ?? EGRESS_PROXY_PORT);
export const CONNECTORS_PORT = Number(process.env.CONNECTORS_PORT ?? DEFAULT_CONNECTORS_PORT);

/** The projects' folders, where their deployed manifests are read. */
export const SITES_DIR = process.env.SITES_DIR ?? "/srv/sites";

/** connectors.json and grants.json, written by the steward. */
export const CONFIG_DIR = process.env.CONFIG_DIR ?? EGRESS_CONFIG_DIR;

/** The audit database, the unit's StateDirectory. */
export const DATA_DIR = process.env.DATA_DIR ?? "/var/lib/sitesolide-egress";

/** Where the kernel lists the TCP sockets, and the account database. */
export const PROC_NET = process.env.PROC_NET ?? "/proc/net";
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE ?? "/etc/passwd";

/** The account of the dashboard, the only caller of /audit and /status. */
export const DASHBOARD_ACCOUNT = process.env.DASHBOARD_ACCOUNT ?? "site-dashboard";

/** How often the counters are written, and the files checked for the audit when no request comes. */
export const FLUSH_MS = Number(process.env.FLUSH_MS ?? 60_000);
export const WATCH_MS = Number(process.env.WATCH_MS ?? 5_000);
