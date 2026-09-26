import {
  SESSION_DURATION_MS,
  PASSWORD_HASH,
  ONLINE,
  STATE_FILE,
  PORT,
  STEWARD_SOCKET,
  PUBLIC_DIR,
  PORTAL_URL,
  PUBLIC_URL,
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
import { DEFAULT_TIMEOUTS, localSteward } from "./src/secrets/client";
import { createTokens } from "./src/secrets/tokens";
import { createSecretsRoutes } from "./src/secrets/routes";

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
// and the steward's tokens live only in this process's memory.
const secrets = createSecretsRoutes({
  session: createSessionReader(store, { online: ONLINE, sessionDurationMs: SESSION_DURATION_MS }),
  publicUrl: PUBLIC_URL,
  steward: localSteward(STEWARD_SOCKET),
  tokens: createTokens(),
});

const routes = createRoutes(store, {
  hash: PASSWORD_HASH,
  publicUrl: PUBLIC_URL,
  online: ONLINE,
  sessionDurationMs: SESSION_DURATION_MS,
  stateFile: STATE_FILE,
  portal: localPortal(PORTAL_URL),
  forgetUnlock: secrets.forgetUnlock,
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
