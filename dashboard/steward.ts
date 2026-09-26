#!/usr/bin/env bun
/**
 * The steward: holds /etc/sitesolide under root's identity, and listens only on
 * a Unix socket that only site-dashboard can open.
 *
 * This file does nothing but wire things up: configuration, cleanup, socket,
 * stop. The routes are in src/secrets/steward.ts, the rules in the pure
 * modules of src/secrets/, the inputs and outputs in src/secrets/system.ts,
 * the socket in src/secrets/socket.ts. See PLAN-SECRETS.md, and
 * the bench results for what has been measured.
 *
 * Unlike the collector, it does NOT travel with the dashboard's code: a root
 * daemon that writes secrets is not updated by an ordinary `sitesolide deploy`.
 * bin/deploy-steward.sh builds it into a single file and installs it under
 * /usr/local/lib/sitesolide/, as root:root.
 *
 * Each path comes from a variable, with the production default. On the
 * workstation, a test tree, with no account or group to check:
 *
 *   E=$(mktemp -d) && mkdir -p $E/sites $E/secrets $E/units $E/state $E/run $E/caddy $E/gatekeeper
 *   SITES_DIR=$E/sites SECRETS_FOLDER=$E/secrets UNITS_FOLDER=$E/units \
 *     STATE_FOLDER=$E/state CADDY_FOLDER=$E/caddy GATEKEEPER_FOLDER=$E/gatekeeper \
 *     SOCKET=$E/run/steward.sock SOCKET_GROUP= OWNERS= SYSTEMCTL=false \
 *     bun steward.ts
 *   curl --unix-socket $E/run/steward.sock http://steward/projects
 *
 * The files it manages follow from the deployed manifests and from the names
 * present in the secrets directory: see src/secrets/scope.ts. Nothing is
 * embedded at build time any more.
 */
import { existsSync, readFileSync } from "node:fs";
import { GATEKEEPER_FOLDER } from "./src/secrets/portal";
import { prepareFolder, closeSocket, openSocket } from "./src/secrets/socket";
import { MAX_PORTAL_MS, MAX_RESTART_MS, DEFAULT_SOCKET } from "./src/secrets/protocol";
import { MAX_CONTENT_BODY_BYTES, createSteward } from "./src/secrets/steward";
import { createSystem, readGroup } from "./src/secrets/system";

const SITES_DIR = process.env.SITES_DIR ?? "/srv/sites";
const SECRETS_FOLDER = process.env.SECRETS_FOLDER ?? "/etc/sitesolide";
const UNITS_FOLDER = process.env.UNITS_FOLDER ?? "/etc/systemd/system";
const STATE_FOLDER = process.env.STATE_FOLDER ?? "/var/lib/sitesolide-steward";
const SOCKET = process.env.SOCKET ?? DEFAULT_SOCKET;
const HASH_FILE = process.env.HASH_FILE ?? `${SECRETS_FOLDER}/dashboard.env`;
// An absolute path: under PrivateNetwork and a minimal PATH, nothing to look for.
const SYSTEMCTL = process.env.SYSTEMCTL ?? "/usr/bin/systemctl";
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE ?? "/etc/passwd";
const GROUPS_FILE = process.env.GROUPS_FILE ?? "/etc/group";
/** Read to say whether a site's portal is up, never written. */
const CADDY_FOLDER = process.env.CADDY_FOLDER ?? "/etc/caddy/sites";
const GATEKEEPER_RESULTS = process.env.GATEKEEPER_FOLDER ?? GATEKEEPER_FOLDER;

/** The only group allowed to open the socket. Empty: no chgrp, for the workstation. */
const SOCKET_GROUP = process.env.SOCKET_GROUP ?? "site-dashboard";

/**
 * The check of the owners. Empty: neither uid check nor chown, and no check at
 * all of the hash's file, of the subdirectories nor of the gatekeeper's result,
 * for the workstation, where those accounts do not exist. Any other value
 * enables it; the expected account is `site-<slug>`, root for the dashboard's
 * hash.
 */
const OWNERS = process.env.OWNERS ?? "site-";

function die(message: string): never {
  console.error(`steward: ${message}`);
  process.exit(1);
}

const refusal = prepareFolder(SOCKET);
if (refusal !== null) die(refusal);

let gid: number | null = null;
if (SOCKET_GROUP !== "") {
  gid = readGroup(readFileSync(GROUPS_FILE, "utf8"), SOCKET_GROUP);
  if (gid === null) die(`group ${SOCKET_GROUP} not found, deploy the dashboard first`);
}

const system = createSystem({
  sitesDir: SITES_DIR,
  secretsFolder: SECRETS_FOLDER,
  unitsFolder: UNITS_FOLDER,
  stateFolder: STATE_FOLDER,
  hashFile: HASH_FILE,
  accountsFile: ACCOUNTS_FILE,
  caddyFolder: CADDY_FOLDER,
  gatekeeperFolder: GATEKEEPER_RESULTS,
  systemctl: SYSTEMCTL,
});

// Before listening: a temporary file left behind by an abrupt stop in the
// middle of a write is of no further use, and only those of our own pattern go.
const removed = await system.cleanTemporaries();
if (removed > 0) console.log(`steward: ${removed} temporary file(s) left by an abrupt stop removed`);

const handler = createSteward(system, {
  secretsFolder: SECRETS_FOLDER,
  checkAccounts: OWNERS !== "",
});

/**
 * A restart is observed for eight seconds, a portal takes up to ninety, and a
 * write can wait behind either one: Bun.serve's default ten seconds of
 * inactivity would cut the answer off. `idleTimeout` is not typed for a Unix
 * socket, hence the per-request setting. Bun caps it at 255 seconds.
 */
const IDLE_S = Math.min(255, Math.ceil((MAX_PORTAL_MS + MAX_RESTART_MS) / 1000) + 10);

const server = openSocket(SOCKET, gid, (path) =>
  Bun.serve({
    unix: path,
    fetch(req, server) {
      server.timeout(req, IDLE_S);
      return handler(req);
    },
    // Never the detailed error page of development mode: it would quote a
    // stack, and the handler already catches everything.
    development: false,
    error: () => Response.json({ error: "failure", message: "unexpected error" }, { status: 500 }),
    // The biggest body, that of a replacement of content. Each route bounds its
    // own lower down.
    maxRequestBodySize: MAX_CONTENT_BODY_BYTES,
  }),
);

console.log(
  [
    `steward listening on ${SOCKET}`,
    `group ${SOCKET_GROUP === "" ? "unchanged" : SOCKET_GROUP}`,
    `sites ${SITES_DIR}`,
    `secrets ${SECRETS_FOLDER}`,
    `owners ${OWNERS === "" ? "unchecked" : "checked"}`,
  ].join(", "),
);
if (!existsSync(HASH_FILE)) {
  console.log(`${HASH_FILE} missing: no unlocking possible`);
}
if (OWNERS !== "" && process.getuid?.() !== 0) {
  console.log("owners checked outside root: every write will fail");
}

/**
 * The requests in progress run to their end: cutting a write in the middle
 * would leave a temporary file, cutting a restart would leave the page without
 * a verdict. systemd waits 90 seconds by default before killing.
 */
let stopping = false;
async function shutDown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`steward: ${signal}, stopping`);
  await server.stop();
  closeSocket(SOCKET);
  process.exit(0);
}

process.on("SIGTERM", () => void shutDown("SIGTERM"));
process.on("SIGINT", () => void shutDown("SIGINT"));
