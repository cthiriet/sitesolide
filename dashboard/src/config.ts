import { join } from "node:path";
import { PORTAL_PORT } from "../borrowed/portal";
import { DEFAULT_SOCKET } from "./secrets/protocol";

/**
 * Local port of the service. The allocation in force: 3000 the landing, 3001
 * the shared service, 3022 this one.
 */
export const PORT = Number(process.env.PORT ?? 3022);

/**
 * The only place this service writes, declared as ReadWritePaths in its unit.
 * Frozen at first import: tests/setup.ts diverts it before anything else at
 * all loads this file, failing which the tests would write into the service's
 * production database.
 */
export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");

/**
 * The zone served by the machine, of which each project receives a subdomain.
 *
 * It has no default that designates a machine: a ready-made zone here would
 * display someone else's addresses. The unit sets it from the configuration,
 * like the port and the data directory.
 */
export const ZONE = process.env.SITESOLIDE_ZONE ?? "";

/**
 * The directory of /srv/sites that the landing serves: the one bearing the
 * name of the zone, the bare domain being covered by no subdomain.
 */
export const LANDING_FOLDER = ZONE;

/**
 * The public files, served by Caddy without ever waking Bun: this is the
 * manifest's `publicDir`, and the deployment sends them by their own rsync.
 * This process reads them only in development, for lack of Caddy to do it.
 */
export const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(import.meta.dir, "..", "public");

/**
 * The snapshot of the machine, written by `collector.ts` under root's
 * identity and read here with no privilege at all.
 *
 * That is this project's whole architecture in one line: the service exposed
 * to the web reads neither `/srv/sites`, nor `/etc/caddy`, nor systemd. Its
 * unit confines it exactly like that of any site, without a single directive
 * fewer, and a compromise therefore yields nothing beyond what the page was
 * already showing.
 */
export const STATE_FILE = process.env.STATE_FILE ?? join(DATA_DIR, "state.json");

/**
 * The exact public address. The Origin check compares it as it stands, so it
 * cannot be rebuilt from `req.url`, which behind Caddy announces
 * http://127.0.0.1:3022/.
 */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, "");

/** True on HTTPS, which the `__Host-` cookie prefix demands. */
export const ONLINE = PUBLIC_URL.startsWith("https://");

/** argon2id hash of the single password, produced by `scripts/fingerprint.ts`. */
export const PASSWORD_HASH = process.env.PASSWORD_HASH ?? "";

/**
 * The portal, on the loopback: the dashboard creates and revokes guest access
 * there. The loopback rule opens that port only to site-dashboard, among all
 * the services, see bin/cli/loopback.ts.
 */
export const PORTAL_URL = (process.env.PORTAL_URL ?? `http://127.0.0.1:${PORTAL_PORT}`).replace(/\/+$/, "");

/**
 * The steward's Unix socket, which holds the sites' secrets under root's
 * identity. A socket rather than a port: it is guarded by the permissions of
 * its directory, without a second exception to the loopback rule. See
 * PLAN-SECRETS.md.
 */
export const STEWARD_SOCKET = process.env.STEWARD_SOCKET ?? DEFAULT_SOCKET;

/** Seven days: a tool consulted nearly every day does not ask again each morning. */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What is missing, named.
 *
 * The service starts despite an incomplete configuration: dying at startup
 * would make it loop on Restart=always without ever saying why. Without a hash
 * it refuses everyone, it never opens.
 */
export function missing(): string[] {
  return PASSWORD_HASH === "" ? ["PASSWORD_HASH"] : [];
}
