import {
  SESSION_DURATION_MS,
  PASSWORD_HASH,
  ONLINE,
  STATE_FILE,
  PORT,
  STEWARD_SOCKET,
  PUBLIC_DIR,
  PORTAL_URL,
  EGRESS_URL,
  PUBLIC_URL,
  DATA_DIR,
  ZONE,
  missing,
} from "./src/config";
import { localPortal } from "./src/guests";
import { servePublic } from "./src/public";
import {
  applyRotation,
  closeSession,
  readAttempts,
  readSession,
  openSession,
  setAttempts,
  purgeSessions,
  touchSession,
} from "./src/database";
import { createSessionReader, createRoutes } from "./src/routes";
import { createSharingRoutes, localSharing } from "./src/sharing";
import { DEFAULT_TIMEOUTS, localSteward } from "./src/secrets/client";
import { createTokens } from "./src/secrets/tokens";
import { createSecretsRoutes } from "./src/secrets/routes";
import { localConnectorsSteward, localEgress } from "./src/connectors/client";
import { createConnectorsRoutes } from "./src/connectors/relay";
import { join } from "node:path";
import { openDatabase } from "./src/database";
import { createApiRoutes, failure } from "./src/control/api";
import { localControlSteward } from "./src/control/client";
import { createLimiter } from "./src/control/limiter";
import { SPOOL_NAME } from "./src/control/protocol";
import { createSpool } from "./src/control/spool";
import { createControlStore } from "./src/control/store";
import { createTeamRoutes } from "./src/control/team";
import { createTracker } from "./src/control/tracker";
import { localBackupSteward } from "./src/backup/client";
import { createAuditRoutes } from "./src/audit/routes";
import { createReaders } from "./src/audit/sources";
import { read } from "./src/read";

// The service starts despite an incomplete configuration, and says so. Dying
// here would make it loop on Restart=always without the log explaining
// anything; without a hash, it simply refuses everyone.
const incomplete = missing();
if (incomplete.length > 0) {
  console.warn(`incomplete configuration (${incomplete.join(", ")}): nobody will be able to sign in`);
}

// Has the password changed since the last startup? If so, the sessions opened
// under the old one fall here: they live in the database and would otherwise
// survive the rotation, which would therefore close nothing.
const closed = await applyRotation(PASSWORD_HASH);
if (closed > 0) {
  console.log(`password changed: ${closed} session(s) closed`);
}

const store = {
  openSession,
  readSession,
  touchSession,
  closeSession,
  purgeSessions,
  readAttempts,
  setAttempts,
};

// The secrets go through the same session check as the rest of the dashboard,
// and the steward's tokens live only in this process's memory. The Team page
// shares them: one unlock opens both.
const sessionReader = createSessionReader(store, { online: ONLINE, sessionDurationMs: SESSION_DURATION_MS });
const unlockTokens = createTokens();
const secrets = createSecretsRoutes({
  session: sessionReader,
  publicUrl: PUBLIC_URL,
  steward: localSteward(STEWARD_SOCKET),
  tokens: unlockTokens,
  backups: localBackupSteward(STEWARD_SOCKET),
});

// The egress proxy's connectors: written through the steward under the same
// unlock as a secret, and their activity read from the proxy itself.
const connectors = createConnectorsRoutes({
  session: sessionReader,
  steward: localConnectorsSteward(STEWARD_SOCKET),
  egress: localEgress(EGRESS_URL),
  tokens: unlockTokens,
  withToken: secrets.withToken,
});

// The control API: deployments by token, under /api/v1/, and the Team page that
// creates and revokes the tokens. The registry is the steward's; this process
// keeps the deployments it was asked for, the audit, and the archives waiting
// for the installer in its own data directory. See src/control/.
const controlSteward = localControlSteward(STEWARD_SOCKET);
const controlStore = createControlStore(openDatabase(join(DATA_DIR, "dashboard.db")));
const spool = createSpool(join(DATA_DIR, SPOOL_NAME));
const tracker = createTracker({ store: controlStore, steward: controlSteward, spool });
const api = createApiRoutes({
  steward: controlSteward,
  store: controlStore,
  spool,
  limiter: createLimiter(),
  tracker,
  stateFile: STATE_FILE,
  publicUrl: PUBLIC_URL,
  zone: ZONE,
});
const team = createTeamRoutes({ session: sessionReader, publicUrl: PUBLIC_URL, steward: controlSteward, tokens: unlockTokens, store: controlStore });
setInterval(() => void tracker.tick(), 3_000);

const routes = createRoutes(store, {
  hash: PASSWORD_HASH,
  publicUrl: PUBLIC_URL,
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  stateFile: STATE_FILE,
  portal: localPortal(PORTAL_URL),
  forgetUnlock: secrets.forgetUnlock,
});

// Who may open a site with their work account: relayed to the portal like the
// guests, behind the same session check. See src/sharing.ts.
const sharing = createSharingRoutes({
  session: createSessionReader(store, { online: ONLINE, sessionDurationMs: SESSION_DURATION_MS }),
  publicUrl: PUBLIC_URL,
  stateFile: STATE_FILE,
  portal: localSharing(PORTAL_URL),
});

// The Activity page: every component's audit, read through the very clients
// above, merged newest first. Read with the session alone. See src/audit/.
const audit = createAuditRoutes({
  session: sessionReader,
  readers: createReaders({
    store: controlStore,
    portal: localSharing(PORTAL_URL),
    egress: localEgress(EGRESS_URL),
    steward: localSteward(STEWARD_SOCKET),
    backups: localBackupSteward(STEWARD_SOCKET),
    connectors: localConnectorsSteward(STEWARD_SOCKET),
    portalDeployed: async () => {
      const reading = await read(STATE_FILE, Date.now());
      return reading.present ? reading.snapshot.sites.some((site) => site.slug === "portal") : null;
    },
  }),
  stateFile: STATE_FILE,
  zone: ZONE,
});

/**
 * The delay of the relay towards the steward, and five seconds more to answer
 * the page. It covers the longest action under its lock, `/portal`, and
 * therefore everything waiting behind, unlocking included. Bun caps this
 * setting at 255 seconds.
 */
const LONG_IDLE_S = Math.min(255, Math.ceil(DEFAULT_TIMEOUTS.longMs / 1000) + 5);

function long(
  req: Request,
  server: { timeout: (req: Request, seconds: number) => void },
  handler: (req: Request) => Promise<Response>,
): Promise<Response> {
  server.timeout(req, LONG_IDLE_S);
  return handler(req);
}

const server = Bun.serve({
  port: PORT,
  // Only Caddy, from the same machine, has any business with this service.
  hostname: "127.0.0.1",

  // The page itself is not served here: public/ is the manifest's publicDir,
  // which Caddy serves without ever waking Bun. The fragment routes only
  // /api/* to this port, and nothing sensitive therefore goes into public/.
  //
  // Without an object of methods, a route would answer every verb.
  routes: {
    "/api/session": { GET: routes.session },
    "/api/signin": { POST: routes.signIn },
    "/api/signout": { POST: routes.signOut },
    "/api/state": { GET: routes.state },
    "/api/guests": { GET: routes.guests, POST: routes.createGuest },
    "/api/invites/:id": { DELETE: (req) => routes.revokeGuest(req, req.params.id) },
    "/api/sharing": { GET: sharing.list },
    "/api/sharing/:host": { PUT: (req) => sharing.replace(req, req.params.host) },
    "/api/portal/audit": { GET: sharing.audit },
    "/api/audit": { GET: audit.list },
    "/api/secrets": { GET: secrets.dashboard },
    "/api/secrets/log": { GET: secrets.log },
    "/api/secrets/lock": { POST: secrets.lock },
    // Everything that goes through the steward's lock or through its queue of
    // verifications. It observes a unit for eight seconds after restarting it,
    // the gatekeeper can take ninety seconds, and a read or a write can wait
    // its turn behind. An unlocking, for its part, waits for the argon2id of
    // the password changes in progress. Bun cuts a connection that has stayed
    // mute for ten seconds, handler in progress included: without this delay of
    // its own, the page would lose an answer that the steward does give.
    // Measured on 16 September 2026.
    "/api/secrets/unlock": { POST: (req, server) => long(req, server, secrets.unlock) },
    "/api/secrets/value": { POST: (req, server) => long(req, server, secrets.readValue) },
    "/api/secrets/variable": {
      PUT: (req, server) => long(req, server, secrets.setVariable),
      DELETE: (req, server) => long(req, server, secrets.removeVariable),
    },
    "/api/secrets/file": { POST: (req, server) => long(req, server, secrets.createFile) },
    "/api/secrets/restore": { POST: (req, server) => long(req, server, secrets.restoreFile) },
    "/api/secrets/content": {
      POST: (req, server) => long(req, server, secrets.readContent),
      PUT: (req, server) => long(req, server, secrets.replaceContent),
    },
    "/api/secrets/password": { POST: (req, server) => long(req, server, secrets.changePassword) },
    "/api/secrets/portal": { POST: (req, server) => long(req, server, secrets.togglePortal) },
    "/api/secrets/restart": { POST: (req, server) => long(req, server, secrets.restart) },
    // The connectors: their writes wait in the steward's lock like a secret's.
    "/api/connectors": { GET: connectors.list },
    "/api/connectors/activity": { GET: connectors.activity },
    "/api/connectors/connector": {
      PUT: (req, server) => long(req, server, connectors.putConnector),
      DELETE: (req, server) => long(req, server, connectors.removeConnector),
    },
    "/api/connectors/grant": { PUT: (req, server) => long(req, server, connectors.setGrant) },

    "/api/team": { GET: team.team },
    "/api/team/tokens": { POST: team.createToken },
    "/api/team/revoke": { POST: team.revokeToken },

    // The control API. The archive streams for as long as it takes to arrive:
    // Bun's ten seconds of silence would cut a slow upload in the middle.
    "/api/v1/whoami": { GET: api.whoami },
    "/api/v1/deployments": { POST: api.createDeployment },
    "/api/v1/deployments/:id": { GET: (req) => api.readDeployment(req, req.params.id) },
    "/api/v1/deployments/:id/bundle": {
      PUT: (req, server) => {
        server.timeout(req, 255);
        return api.uploadBundle(req, req.params.id);
      },
    },
    "/api/v1/projects": { GET: api.projects },
    "/api/v1/projects/:slug": { GET: (req) => api.project(req, req.params.slug) },
    "/api/v1/projects/:slug/logs": { GET: (req) => api.projectLogs(req, req.params.slug) },
    "/api/v1/*": () => failure("not-found", "no such route: see docs/team.md for the control API's routes"),
    // The backups go through the steward too: it reads them as root, and starts
    // a restore under the same lock and the same unlocking as the secrets.
    "/api/backups": { GET: secrets.backups },
    "/api/backups/audit": { GET: secrets.backupAudit },
    "/api/backups/restore": { POST: (req, server) => long(req, server, secrets.restoreBackup) },
  },

  /**
   * In production, everything that is not /api/* is served by Caddy and never
   * gets here: the fragment routes only that family. The fallback therefore
   * exists only for `bun run dev`, where there is no Caddy to show the page,
   * and it is closed as soon as NODE_ENV is production: see src/public.ts.
   */
  fetch(req) {
    return servePublic(req, { root: PUBLIC_DIR, production: process.env.NODE_ENV === "production" });
  },

  error(err) {
    console.error(err);
    return new Response("500: server error", { status: 500 });
  },
});

console.log(`sitesolide-dashboard → ${server.url}`);
