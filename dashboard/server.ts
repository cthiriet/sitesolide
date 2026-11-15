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
import { servePublic } from "./src/public";
import {
  applyRotation,
  closeSession,
  readSession,
  openSession,
  purgeSessions,
  touchSession,
  closeOtherOwnerSessions,
  readOwnerPasskeys,
  writeOwnerPasskeys,
} from "./src/database";
import { createSessionReader, createRoutes, ownerSessionOpener } from "./src/routes";
import { OWNER_IDLE_MS } from "./src/sessions";
import { localPasskeySteward } from "./src/passkeys/client";
import { createPasskeyRoutes } from "./src/passkeys/routes";
import { createPasskeyState } from "./src/passkeys/state";
import { localPortalAudit } from "./src/portal-audit";
import { localAccessSteward } from "./src/access/client";
import { createAccessRoutes } from "./src/access/routes";
import { DEFAULT_TIMEOUTS, localSteward } from "./src/secrets/client";
import { createPasswordVerifier, stewardPasswordCall } from "./src/password-check";
import { readMissingSecrets } from "./src/secrets/missing";
import { createTokens } from "./src/secrets/tokens";
import { createSecretsRoutes } from "./src/secrets/routes";
import { localEgressAudit } from "./src/egress-audit";
import { join } from "node:path";
import { openDatabase } from "./src/database";
import { createApiRoutes, failure, restartRoutes, STEWARD_IDLE_S, storeRoutes } from "./src/control/api";
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
};

// The owner's sessions, the one person who signs in.
const ownerReader = createSessionReader(store, {
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  // Twelve hours unused and the owner signs in again, whatever is left of the week.
  ownerIdleMs: OWNER_IDLE_MS,
});

// The secrets go through the same session check as the rest of the dashboard,
// and the steward's tokens live only in this process's memory. The Tokens page
// shares them: one unlock opens both.
const unlockTokens = createTokens();
const secrets = createSecretsRoutes({
  session: ownerReader,
  publicUrl: PUBLIC_URL,
  steward: localSteward(STEWARD_SOCKET),
  tokens: unlockTokens,
  backups: localBackupSteward(STEWARD_SOCKET),
  // The password changed: the sessions opened with the old one close now,
  // rather than at the next restart (applyRotation below catches the rest).
  passwordChanged: (kept) => closeOtherOwnerSessions(kept),
});

// The control API: deployments by token, under /api/v1/, and the Tokens page that
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
const team = createTeamRoutes({
  session: ownerReader,
  publicUrl: PUBLIC_URL,
  steward: controlSteward,
  tokens: unlockTokens,
  store: controlStore,
});
setInterval(() => void tracker.tick(), 3_000);

// The owner's passkeys: every ceremony verified by the steward, which keeps
// the registry; once one exists, the password signs nobody in. See
// src/passkeys/.
const passkeySteward = localPasskeySteward(STEWARD_SOCKET);
const passkeyState = createPasskeyState({
  steward: passkeySteward,
  passwordConfigured: PASSWORD_HASH !== "",
  readRemembered: readOwnerPasskeys,
  remember: writeOwnerPasskeys,
});
const passkeys = createPasskeyRoutes({
  publicUrl: PUBLIC_URL,
  steward: passkeySteward,
  session: ownerReader,
  tokens: unlockTokens,
  openOwnerSession: ownerSessionOpener(store, { online: ONLINE, sessionDurationMs: SESSION_DURATION_MS }),
  closeOtherOwnerSessions,
  state: passkeyState,
});

// The names the stores lack, read from the steward's listing beside every
// snapshot: the collector never reads the store, and the verdict, the Sites
// rows and the badges must count them as the Secrets section does. A steward
// slow to list holds the snapshot back two seconds at most.
const listing = localSteward(STEWARD_SOCKET, { ...DEFAULT_TIMEOUTS, shortMs: 2_000 });

const routes = createRoutes(store, {
  hash: PASSWORD_HASH,
  // The steward verifies the password against the hash as it stands: a
  // change signs the old one out at once. See src/password-check.ts.
  verifyPassword: createPasswordVerifier(stewardPasswordCall(STEWARD_SOCKET, DEFAULT_TIMEOUTS.longMs), PASSWORD_HASH),
  publicUrl: PUBLIC_URL,
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  stateFile: STATE_FILE,
  zone: ZONE,
  passkeys: passkeyState.offer,
  ownerIdleMs: OWNER_IDLE_MS,
  passwordSignIn: passkeyState.passwordSignIn,
  missingSecrets: () => readMissingSecrets(listing),
  forgetUnlock: secrets.forgetUnlock,
});

// The Activity page: every component's audit, read through the very clients
// above, merged newest first. Read with the session alone. See src/audit/.
const audit = createAuditRoutes({
  session: ownerReader,
  readers: createReaders({
    store: controlStore,
    portal: localPortalAudit(PORTAL_URL),
    egress: localEgressAudit(EGRESS_URL),
    steward: localSteward(STEWARD_SOCKET),
    backups: localBackupSteward(STEWARD_SOCKET),
    portalDeployed: async () => {
      const reading = await read(STATE_FILE, Date.now());
      return reading.present ? reading.snapshot.sites.some((site) => site.slug === "portal") : null;
    },
  }),
  stateFile: STATE_FILE,
  zone: ZONE,
});

/**
 * A route that waits on the steward: the delay of the relay towards it, and
 * five seconds more to answer the page (`STEWARD_IDLE_S`). It covers the
 * longest action under its lock, a general access changed through the
 * gatekeeper, and therefore everything waiting behind, unlocking included. Bun caps this setting at 255 seconds.
 */
function long(
  req: Request,
  server: { timeout: (req: Request, seconds: number) => void },
  handler: (req: Request) => Promise<Response>,
): Promise<Response> {
  server.timeout(req, STEWARD_IDLE_S);
  return handler(req);
}

// Each project's general access and guests: the steward's access registry,
// relayed with the session and its unlock. See src/access/.
const accessRoutes = createAccessRoutes({
  publicUrl: PUBLIC_URL,
  stateFile: STATE_FILE,
  steward: localAccessSteward(STEWARD_SOCKET),
  session: ownerReader,
  tokens: unlockTokens,
});

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
    // The owner's passkeys, every ceremony relayed to the steward.
    "/api/passkeys": { GET: passkeys.list },
    "/api/passkeys/challenge": { POST: passkeys.challenge },
    "/api/passkeys/signin": { POST: passkeys.signIn },
    "/api/passkeys/register": { POST: passkeys.register },
    "/api/passkeys/credential": { DELETE: passkeys.remove },
    "/api/state": { GET: routes.state },
    // A project's general access and guests, the owner's: the steward judges.
    "/api/access": { GET: accessRoutes.list },
    "/api/access/entry": { PUT: accessRoutes.put, DELETE: accessRoutes.remove },
    "/api/access/general": { PUT: (req, server) => long(req, server, accessRoutes.general) },
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
    // A password hash changes with the dashboard's own password.
    "/api/secrets/password": { POST: (req, server) => long(req, server, secrets.changePassword) },
    "/api/secrets/restart": { POST: (req, server) => long(req, server, secrets.restart) },
    // A project's store: the owner's writes under the session's unlock.
    "/api/secrets/store/variable": {
      PUT: (req, server) => long(req, server, secrets.setStoreVariable),
      DELETE: (req, server) => long(req, server, secrets.removeStoreVariables),
    },
    "/api/secrets/store/generate": { POST: (req, server) => long(req, server, secrets.generateStoreVariable) },
    "/api/secrets/store/file": {
      PUT: (req, server) => long(req, server, secrets.setStoreFile),
      DELETE: (req, server) => long(req, server, secrets.removeStoreFile),
    },
    "/api/secrets/store/restore": { POST: (req, server) => long(req, server, secrets.restoreStore) },
    "/api/secrets/store/value": { POST: (req, server) => long(req, server, secrets.revealStoreValue) },

    // The owner sees, mints and revokes every token.
    "/api/tokens": { GET: team.team, POST: team.createToken },
    "/api/tokens/revoke": { POST: team.revokeToken },
    // A project renamed: the machine's run stops, moves, reloads, starts and
    // probes, which the longest delay Bun allows covers. A project turned
    // off, on, or removed, as long.
    "/api/projects/lifecycle": {
      POST: (req, server) => {
        server.timeout(req, 255);
        return team.projectLifecycle(req);
      },
    },
    "/api/projects/rename": {
      POST: (req, server) => {
        server.timeout(req, 255);
        return team.renameProject(req);
      },
    },

    // The control API. The archive streams for as long as it takes to arrive:
    // Bun's ten seconds of silence would cut a slow upload in the middle.
    "/api/v1/whoami": { GET: api.whoami },
    "/api/v1/deployments": { POST: api.createDeployment },
    // A dry run: judged and planned on the machine, nothing written.
    "/api/v1/deployments/plan": { POST: api.planDeployment },
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
    // The owner's token for every project takes a name back: deploy --adopt.
    "/api/v1/projects/:slug/claim": { DELETE: (req) => api.takeBackClaim(req, req.params.slug) },
    // A token's restart, observed for eight seconds: the long delay, as for
    // the Secrets page.
    ...restartRoutes(api),
    // A token's work on a project's store, every write waiting its turn under
    // the steward's lock: twice the long delay for a change with its restart.
    ...storeRoutes(api),
    "/api/v1/*": () => failure("not-found", "no such route: see docs/access.md for the control API's routes"),
    // The backups go through the steward too: it reads them as root, and starts
    // a restore under the same lock and the same unlocking as the secrets.
    "/api/backups": { GET: secrets.backups },
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
