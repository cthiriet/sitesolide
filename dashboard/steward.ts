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
 *   E=$(mktemp -d) && mkdir -p $E/sites $E/secrets $E/units $E/state $E/run $E/owner $E/caddy $E/gatekeeper $E/portal-key
 *   SITES_DIR=$E/sites SECRETS_FOLDER=$E/secrets UNITS_FOLDER=$E/units \
 *     STATE_FOLDER=$E/state CADDY_FOLDER=$E/caddy GATEKEEPER_FOLDER=$E/gatekeeper \
 *     BACKUP_FOLDER=$E/backups BACKUP_STATE_FOLDER=$E/backup-state BACKUP_RUN_FOLDER=$E/backup-run \
 *     SOCKET=$E/run/steward.sock OWNER_SOCKET=$E/owner/owner.sock PORTAL_KEY_FOLDER=$E/portal-key \
 *     PORTAL_RELAY_SOCKET= SOCKET_GROUP= OWNERS= SYSTEMCTL=false \
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
import { createConnectorStore } from "./src/connectors/store";
import { EGRESS_ACCOUNT, EGRESS_CONFIG_DIR } from "./borrowed/connectors";
import { createControlSteward, isControlPath } from "./src/control/steward";
import { createControlSystem } from "./src/control/system";
import { INSTALLER_RUN_FOLDER } from "./src/control/protocol";
import { BACKUP_FOLDER } from "./borrowed/backups";
import { createBackupReader } from "./src/backup/reader";
import { createMembersSystem } from "./src/people/system";
import { createAccessSystem } from "./src/access/system";
import { OWNER_SOCKET, PORTAL_KEY_FOLDER } from "./src/people/protocol";
import { PORTAL_RELAY_SOCKET, relayedPortal } from "./src/people/portal";

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
/** Where the installer leaves its results, read to relay a deployment's progress. */
const INSTALLER_FOLDER = process.env.INSTALLER_FOLDER ?? INSTALLER_RUN_FOLDER;
const JOURNALCTL = process.env.JOURNALCTL ?? "/usr/bin/journalctl";

/**
 * The egress proxy's connectors and grants, and the group that reads them. The
 * folder is created by bin/deploy-egress.sh, which `sitesolide setup` runs;
 * missing, the Connectors page says the proxy is not installed and nothing is
 * written.
 */
const EGRESS_FOLDER = process.env.EGRESS_FOLDER ?? EGRESS_CONFIG_DIR;
const EGRESS_GROUP = process.env.EGRESS_GROUP ?? EGRESS_ACCOUNT;

/** The only group allowed to open the socket. Empty: no chgrp, for the workstation. */
const SOCKET_GROUP = process.env.SOCKET_GROUP ?? "site-dashboard";

/**
 * The owner's socket, which only root opens: `sitesolide share` and
 * `sitesolide people` reach the access registry there, over the owner's SSH.
 * Its folder is a runtime directory of its own, root's, since the dashboard's
 * socket needs a folder of its own (src/secrets/socket.ts). Empty: no
 * owner's socket.
 */
const OWNER_SOCKET_PATH = process.env.OWNER_SOCKET ?? OWNER_SOCKET;

/**
 * Where the portal's private key is laid, and the portal's group, which reads
 * it. The folder is bin/deploy-steward.sh's; missing, members cannot sign in
 * yet and the dashboard says so.
 */
const PORTAL_KEY_DIR = process.env.PORTAL_KEY_FOLDER ?? PORTAL_KEY_FOLDER;
const PORTAL_GROUP = process.env.PORTAL_GROUP ?? "site-portal";

/**
 * The relay to the portal's admin API, asked whether the portal reads the
 * access projection: a Unix socket root's alone, behind which
 * systemd-socket-proxyd reaches the portal's port on the loopback. This unit
 * keeps no network. Empty: no relay, and the portal is not asked.
 */
const PORTAL_RELAY = process.env.PORTAL_RELAY_SOCKET ?? PORTAL_RELAY_SOCKET;

/**
 * The portal's own data folder, read once, as a checked copy, when the access
 * registry is made from the stores before it: see src/access/system.ts.
 */
const PORTAL_DATA_FOLDER = process.env.PORTAL_DATA_FOLDER ?? `${SITES_DIR}/portal/data`;

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

// The egress proxy's connectors, in their own folder, handed to the proxy's
// group. The group is read on every call: the proxy may be installed after
// this steward started, and until then the page says it is not.
const connectors = createConnectorStore({
  folder: EGRESS_FOLDER,
  owners:
    OWNERS === ""
      ? null
      : {
          rootUid: 0,
          gid: () => {
            try {
              return readGroup(readFileSync(GROUPS_FILE, "utf8"), EGRESS_GROUP);
            } catch {
              return null;
            }
          },
        },
});
const leftovers = connectors.clean();
if (leftovers > 0) console.log(`steward: ${leftovers} temporary connectors file(s) left by an abrupt stop removed`);
// The backup component's folders, read for the Backups section; the restore
// requests are written into its state folder, which the unit makes writable.
// Missing, the section says backups are not set up, and nothing else changes.
const backups = createBackupReader({
  sitesDir: SITES_DIR,
  backupFolder: process.env.BACKUP_FOLDER ?? BACKUP_FOLDER,
  stateFolder: process.env.BACKUP_STATE_FOLDER ?? "/var/lib/sitesolide-backup",
  runFolder: process.env.BACKUP_RUN_FOLDER ?? "/run/sitesolide-backup",
  unitsFolder: UNITS_FOLDER,
});

// The control routes are built after this handler, and the members routes
// ask them to revoke the tokens of someone who no longer signs in: the call
// is filled in below.
let revokeMemberTokens: (email: string, actor: string) => Promise<number> = async () => 0;

const handler = createSteward(system, {
  secretsFolder: SECRETS_FOLDER,
  checkAccounts: OWNERS !== "",
  connectors,
  backups,
  // Access: the registry of who may do what on each project, the portal's
  // projection of it, the sessions of the people who sign in, the key pair
  // the portal signs with. See src/access/ and src/people/.
  members: {
    system: createMembersSystem({
      stateFolder: STATE_FOLDER,
      sitesDir: SITES_DIR,
      secretsFolder: SECRETS_FOLDER,
      portalKeyFolder: PORTAL_KEY_DIR,
      groupsFile: GROUPS_FILE,
      portalGroup: OWNERS === "" ? "" : PORTAL_GROUP,
    }),
    access: createAccessSystem(
      {
        stateFolder: STATE_FOLDER,
        portalKeyFolder: PORTAL_KEY_DIR,
        groupsFile: GROUPS_FILE,
        portalGroup: OWNERS === "" ? "" : PORTAL_GROUP,
        portalDataFolder: PORTAL_DATA_FOLDER,
      },
      OWNERS !== "",
    ),
    zone: process.env.SITESOLIDE_ZONE ?? "",
    portal: PORTAL_RELAY === "" ? null : relayedPortal(PORTAL_RELAY),
    revokeTokens: (email, actor) => revokeMemberTokens(email, actor),
  },
});

// The key pair, laid now if it is missing: the portal reads its half at every
// sign-in, and needs no restart for it. A portal not deployed yet is said, and
// the pair is laid at the first sign-in asked for once it is.
const keys = await handler.ensureMemberKeys().catch((e: unknown) => ({ kind: "unavailable" as const, reason: (e as Error).name }));
if (keys !== null) {
  console.log(keys.kind === "ready" ? `steward: dashboard sign-in key ${keys.publicKey.kid} in place` : `steward: nobody signs in to the dashboard with an account yet, ${keys.reason}`);
}

// The control API's routes, under /tokens/ and /control/: the token registry and
// the start of the installer. They share the socket and its permissions, and
// ask the secrets routes whether a token is the live unlock, the members
// routes who a person is and what they may do now, for a person's own
// tokens, and the access routes for a token's changes of access. See
// src/control/steward.ts.
const control = createControlSteward(
  createControlSystem({
    stateFolder: STATE_FOLDER,
    sitesDir: SITES_DIR,
    unitsFolder: UNITS_FOLDER,
    installerFolder: INSTALLER_FOLDER,
    systemctl: SYSTEMCTL,
    journalctl: JOURNALCTL,
  }),
  {
    zone: process.env.SITESOLIDE_ZONE ?? "",
    isUnlocked: handler.isUnlocked,
    uidRoot: OWNERS === "" ? null : 0,
    members: handler.memberAuthority ?? undefined,
    access: handler.accessForToken,
    forgetAccess: handler.forgetProjectAccess,
  },
);
revokeMemberTokens = control.revokeMember;

// The access registry: made from members.json and the portal's database at the
// first start on this code, then its projection written again for the portal.
// In the background, never in the sockets' way: until it is done the access
// routes answer `migrating`, and an attempt that fails is tried again later
// and later. Then, once, every token made someone's.
void handler
  .startAccess()
  .then(async () => {
    for (let wait = 5_000; !(await control.migrateTokens()); wait = Math.min(wait * 2, 600_000)) {
      console.log(`steward: tokens not made someone's yet, tried again in ${Math.round(wait / 1000)} s`);
      await Bun.sleep(wait);
    }
  })
  .catch((e: unknown) => console.error(`steward: access registry not ready (${(e as Error).name})`));

// A person becomes Admin of what their token created once its installer has
// succeeded: the dashboard's tracker reads every result within seconds, which
// settles it; this settles it too when nobody reads.
setInterval(() => void control.settleCreations().catch((e: unknown) => console.error(`steward: creations not settled (${(e as Error).name})`)), 30_000);

/**
 * A restart is observed for eight seconds, a portal takes up to ninety, and a
 * write can wait behind either one: Bun.serve's default ten seconds of
 * inactivity would cut the answer off. `idleTimeout` is not typed for a Unix
 * socket, hence the per-request setting. Bun caps it at 255 seconds.
 */
const IDLE_S = Math.min(255, Math.ceil((MAX_PORTAL_MS + MAX_RESTART_MS) / 1000) + 10);

// The owner's socket: the access registry for root, over the owner's SSH. No
// group: the folder and the socket stay root's alone.
// Its folder missing, a unit older than this code, the dashboard's socket
// opens all the same: the owner's is said missing, and `sitesolide share`
// says to upgrade.
const ownerServer =
  OWNER_SOCKET_PATH === ""
    ? null
    : (() => {
        const ownerRefusal = prepareFolder(OWNER_SOCKET_PATH);
        if (ownerRefusal !== null) {
          console.error(`steward: no owner's socket, ${ownerRefusal}`);
          return null;
        }
        return openSocket(
          OWNER_SOCKET_PATH,
          null,
          (path) =>
            Bun.serve({
              unix: path,
              // The access registry, and the token ownership of a project removed.
              fetch: (req) => (isControlPath(new URL(req.url).pathname) ? control.owner(req) : handler.owner(req)),
              development: false,
              error: () => Response.json({ error: "failure", message: "unexpected error" }, { status: 500 }),
              maxRequestBodySize: 64 * 1024,
            }),
          { folder: 0o700, socket: 0o600 },
        );
      })();

const server = openSocket(SOCKET, gid, (path) =>
  Bun.serve({
    unix: path,
    fetch(req, server) {
      server.timeout(req, IDLE_S);
      return isControlPath(new URL(req.url).pathname) ? control(req) : handler(req);
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
    `owner's socket ${ownerServer === null ? "none" : OWNER_SOCKET_PATH}`,
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
  await Promise.all([server.stop(), ownerServer?.stop()]);
  closeSocket(SOCKET);
  if (ownerServer !== null) closeSocket(OWNER_SOCKET_PATH);
  process.exit(0);
}

process.on("SIGTERM", () => void shutDown("SIGTERM"));
process.on("SIGINT", () => void shutDown("SIGINT"));
