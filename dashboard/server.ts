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
  readAttempts,
  readSession,
  openSession,
  recordSession,
  setAttempts,
  purgeSessions,
  touchSession,
} from "./src/database";
import { createSessionReader, createRoutes, ownerSessions } from "./src/routes";
import { isMemberSession } from "./src/sessions";
import { localDashboardPortal, localMembersSteward } from "./src/people/client";
import { createIdentityResolver } from "./src/people/identity";
import { createSignInLimiter } from "./src/people/limiter";
import { MEMBER_SESSION_DURATION_MS } from "./src/people/protocol";
import { createMembersRoutes } from "./src/people/routes";
import { createMemberRelay } from "./src/people/relay";
import { createPortalAuditRoute, localPortalAudit } from "./src/portal-audit";
import { localAccessSteward } from "./src/access/client";
import { createAccessRoutes } from "./src/access/routes";
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

// One reader for every session, the owner's and the members'; the super
// admin's routes take the owner's alone, so that a member reads as nobody
// there even where a route forgot to ask. See src/people/.
const sessionReader = createSessionReader(store, {
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  memberSessionDurationMs: MEMBER_SESSION_DURATION_MS,
});
const ownerReader = ownerSessions(sessionReader);

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
});

// The egress proxy's connectors: written through the steward under the same
// unlock as a secret, and their activity read from the proxy itself.
const connectors = createConnectorsRoutes({
  session: ownerReader,
  steward: localConnectorsSteward(STEWARD_SOCKET),
  egress: localEgress(EGRESS_URL),
  tokens: unlockTokens,
  withToken: secrets.withToken,
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
const team = createTeamRoutes({ session: ownerReader, publicUrl: PUBLIC_URL, steward: controlSteward, tokens: unlockTokens, store: controlStore });
setInterval(() => void tracker.tick(), 3_000);

// The people who sign in: with the portal's provider, the steward opens their
// sessions and judges their writes, and this process shows each of them
// their own projects. See src/people/.
const membersSteward = localMembersSteward(STEWARD_SOCKET);
const identity = createIdentityResolver({ session: sessionReader, online: ONLINE, steward: membersSteward, closeSession });
// A member's own unlock tokens, by session hash: never the owner's store,
// so that neither evicts the other.
const memberUnlocks = createTokens();
const members = createMembersRoutes({
  publicUrl: PUBLIC_URL,
  online: ONLINE,
  passwordConfigured: PASSWORD_HASH !== "",
  steward: membersSteward,
  portal: localDashboardPortal(PORTAL_URL),
  store: { recordSession, purgeSessions, closeSession },
  resolve: identity,
  unlocks: memberUnlocks,
  limiter: createSignInLimiter(),
  ownerDurationMs: SESSION_DURATION_MS,
  memberDurationMs: MEMBER_SESSION_DURATION_MS,
});

// What a person reaches of a site's Secrets, general access and Backups: the
// same addresses as the owner's, relayed to the steward with their session
// and unlock. See src/people/relay.ts.
const memberRelay = createMemberRelay({
  publicUrl: PUBLIC_URL,
  resolve: identity,
  closeSession,
  steward: membersSteward,
  tokens: memberUnlocks,
  secrets: localSteward(STEWARD_SOCKET),
  backups: localBackupSteward(STEWARD_SOCKET),
  control: controlStore,
});

const routes = createRoutes(store, {
  hash: PASSWORD_HASH,
  publicUrl: PUBLIC_URL,
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  memberSessionDurationMs: MEMBER_SESSION_DURATION_MS,
  stateFile: STATE_FILE,
  forgetUnlock: secrets.forgetUnlock,
  roles: members.roles,
  memberSignOut: async (token) => {
    await memberRelay.forgetUnlock(token);
    await members.signOut(token);
  },
});

// The portal's audit, read with the owner's session. See src/portal-audit.ts.
const portalAudit = createPortalAuditRoute({ session: ownerReader, portal: localPortalAudit(PORTAL_URL) });

// The Activity page: every component's audit, read through the very clients
// above, merged newest first. Read with the session alone. See src/audit/.
const audit = createAuditRoutes({
  session: sessionReader,
  // A member reads the rows of their projects, and their own.
  restriction: members.restriction,
  readers: createReaders({
    store: controlStore,
    portal: localPortalAudit(PORTAL_URL),
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

/**
 * The routes a member's session may reach: their session, their sign-in and
 * sign-out, the snapshot and the audit, both filtered to their projects,
 * their restart, a site's Secrets, Access, Sharing, Guests and Backups, and
 * their own tokens on the Tokens page, which `either()` sends to
 * src/people/relay.ts, where the steward judges each by role. Every other route is the owner's: `owner()` answers a
 * member 403 before its handler runs, and the handler itself reads the
 * owner's sessions alone (`ownerReader`), so that a route forgetting the
 * first still refuses a member. The control API is reached with a team
 * token, never a session.
 */
const ownerOnly = () =>
  Response.json({ error: "owner-only", message: "This part of the dashboard is the owner's." }, { status: 403, headers: { "Cache-Control": "no-store" } });

function owner<R extends Request, S extends { timeout: (req: Request, seconds: number) => void }>(
  handler: (req: R, server: S) => Response | Promise<Response>,
): (req: R, server: S) => Promise<Response> {
  return either(handler, () => ownerOnly());
}

/**
 * One address, two handlers: the owner's, which reads the owner's
 * sessions alone, and a member's, which relays to the steward with their
 * session (src/people/relay.ts). The page asks the same routes whoever is
 * signed in; what a member may do there, the steward decides.
 */
function either<R extends Request, S extends { timeout: (req: Request, seconds: number) => void }>(
  ownerHandler: (req: R, server: S) => Response | Promise<Response>,
  memberHandler: (req: R, server: S) => Response | Promise<Response>,
): (req: R, server: S) => Promise<Response> {
  return async (req, server) => {
    const found = await sessionReader(req, Date.now());
    return found !== null && isMemberSession(found) ? memberHandler(req, server) : ownerHandler(req, server);
  };
}

// Who may do what on each project, and the People page: the steward's access
// registry, relayed with the session and its unlock. See src/access/.
const accessRoutes = createAccessRoutes({
  publicUrl: PUBLIC_URL,
  zone: ZONE,
  stateFile: STATE_FILE,
  steward: localAccessSteward(STEWARD_SOCKET),
  members: membersSteward,
  resolve: identity,
  ownerSession: ownerReader,
  tokens: unlockTokens,
  unlocks: memberUnlocks,
  providerName: members.providerName,
  togglePortal: (req) => either(secrets.togglePortal, memberRelay.togglePortal)(req, { timeout: () => undefined }),
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
    "/api/session": { GET: members.session },
    "/api/signin": { POST: routes.signIn },
    "/api/signout": { POST: routes.signOut },
    "/api/state": { GET: routes.state },
    // A project's general access and people with access, for the owner and its
    // Admins, and the machine's People, the owner's: the steward judges.
    "/api/access": { GET: accessRoutes.list },
    "/api/access/entry": { PUT: accessRoutes.put, DELETE: accessRoutes.remove },
    "/api/access/general": { PUT: (req, server) => long(req, server, accessRoutes.general) },
    "/api/people": { GET: owner(accessRoutes.people) },
    "/api/people/person": { PUT: owner(accessRoutes.putPerson), DELETE: owner(accessRoutes.removePerson) },
    "/api/portal/audit": { GET: owner(portalAudit) },
    "/api/audit": { GET: audit.list },
    "/api/secrets": { GET: either(secrets.dashboard, memberRelay.secrets) },
    "/api/secrets/log": { GET: either(secrets.log, memberRelay.secretsLog) },
    "/api/secrets/lock": { POST: either(secrets.lock, memberRelay.lock) },
    // Everything that goes through the steward's lock or through its queue of
    // verifications. It observes a unit for eight seconds after restarting it,
    // the gatekeeper can take ninety seconds, and a read or a write can wait
    // its turn behind. An unlocking, for its part, waits for the argon2id of
    // the password changes in progress. Bun cuts a connection that has stayed
    // mute for ten seconds, handler in progress included: without this delay of
    // its own, the page would lose an answer that the steward does give.
    // Measured on 16 September 2026.
    // A member unlocks through a forced sign-in, never with a password: see
    // /api/sso/begin?reauth=1. The rest relays their session and unlock.
    "/api/secrets/unlock": { POST: either((req, server) => long(req, server, secrets.unlock), memberRelay.unlock) },
    "/api/secrets/value": { POST: either((req, server) => long(req, server, secrets.readValue), (req, server) => long(req, server, memberRelay.readValue)) },
    "/api/secrets/variable": {
      PUT: either((req, server) => long(req, server, secrets.setVariable), (req, server) => long(req, server, memberRelay.setVariable)),
      DELETE: either((req, server) => long(req, server, secrets.removeVariable), (req, server) => long(req, server, memberRelay.removeVariable)),
    },
    "/api/secrets/file": { POST: either((req, server) => long(req, server, secrets.createFile), (req, server) => long(req, server, memberRelay.createFile)) },
    "/api/secrets/restore": { POST: either((req, server) => long(req, server, secrets.restoreFile), (req, server) => long(req, server, memberRelay.restoreFile)) },
    "/api/secrets/content": {
      POST: either((req, server) => long(req, server, secrets.readContent), (req, server) => long(req, server, memberRelay.readContent)),
      PUT: either((req, server) => long(req, server, secrets.replaceContent), (req, server) => long(req, server, memberRelay.replaceContent)),
    },
    // A password hash changes with the dashboard's own password: the owner's alone.
    "/api/secrets/password": { POST: owner((req, server) => long(req, server, secrets.changePassword)) },
    "/api/secrets/portal": { POST: either((req, server) => long(req, server, secrets.togglePortal), (req, server) => long(req, server, memberRelay.togglePortal)) },
    "/api/secrets/restart": { POST: either((req, server) => long(req, server, secrets.restart), (req, server) => long(req, server, members.restart)) },
    // The connectors: their writes wait in the steward's lock like a secret's.
    "/api/connectors": { GET: owner(connectors.list) },
    "/api/connectors/activity": { GET: owner(connectors.activity) },
    "/api/connectors/connector": {
      PUT: owner((req, server) => long(req, server, connectors.putConnector)),
      DELETE: owner((req, server) => long(req, server, connectors.removeConnector)),
    },
    "/api/connectors/grant": { PUT: owner((req, server) => long(req, server, connectors.setGrant)) },

    // The owner sees and revokes every token; a member, their own, minted
    // within their roles and judged by the steward (src/people/relay.ts).
    "/api/tokens": { GET: either(team.team, memberRelay.team), POST: either(team.createToken, memberRelay.createToken) },
    "/api/tokens/revoke": { POST: either(team.revokeToken, memberRelay.revokeToken) },

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
    "/api/v1/projects/:slug/access": {
      GET: (req) => api.projectAccess(req, req.params.slug),
      PUT: (req) => api.putProjectAccess(req, req.params.slug),
      DELETE: (req) => api.removeProjectAccess(req, req.params.slug),
    },
    "/api/v1/*": () => failure("not-found", "no such route: see docs/access.md for the control API's routes"),
    // The backups go through the steward too: it reads them as root, and starts
    // a restore under the same lock and the same unlocking as the secrets.
    "/api/backups": { GET: either(secrets.backups, memberRelay.backups) },
    "/api/backups/audit": { GET: either(secrets.backupAudit, memberRelay.backupAudit) },
    "/api/backups/restore": { POST: either((req, server) => long(req, server, secrets.restoreBackup), (req, server) => long(req, server, memberRelay.restoreBackup)) },

    // Signing in with the provider, and a person's restart, which the steward judges.
    "/api/sso/begin": { GET: members.begin },
    "/api/sso/complete": { GET: members.complete },
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
