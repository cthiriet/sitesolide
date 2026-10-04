import { readFileSync, writeFileSync } from "node:fs";
import { isPasswordValid } from "./borrowed/auth";
import { createAdmin, createSharingAdmin } from "./src/admin";
import { auditStore, guestStore, openDatabase, sharingStore } from "./src/database";
import { COOKIE_DURATION_S, PASSWORD_HASH, ONLINE, DATABASE_FILE, KEY_FILE, PORT, PUBLIC_URL } from "./src/config";
import { deriveKey, KEY_BYTES } from "./src/gate";
import { handoffStore } from "./src/handoff";
import { createProvider, readSettings } from "./src/oidc";
import { createRoutes } from "./src/routes";
import { createSso } from "./src/sso";

/**
 * The draw that signs the cookies, created at the first start in the data
 * folder. `wx`: a file already there is never overwritten, two simultaneous
 * starts do not each draw their own. UMask=0077 in the unit, and `mode` here
 * for the workstation.
 */
function readOrDraw(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const seed = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  writeFileSync(path, seed, { mode: 0o600, flag: "wx" });
  return seed;
}

const key = deriveKey(readOrDraw(KEY_FILE), PASSWORD_HASH);

// The service starts despite an incomplete configuration, and says so. Dying
// here would make it loop on Restart=always without the log explaining
// anything; without a hash, it simply refuses everyone.
if (key === null) console.warn("PASSWORD_HASH missing: nobody will be able to enter");

// Signing in with the identity provider is offered only when it is fully
// configured. Half configured, the portal behaves as it always has and says
// what is missing; the names are printed, never a value.
const { settings, problems } = readSettings(process.env, PUBLIC_URL);
for (const problem of problems) console.warn(`sign-in with a provider: ${problem}`);
if (settings !== null) console.log(`sign-in with ${settings.providerName} offered, callback ${settings.redirectUri}`);

const database = openDatabase(DATABASE_FILE);
const guests = guestStore(database);
const sharing = sharingStore(database);
const audit = auditStore(database);

const routes = createRoutes({
  key,
  verifyPassword: (submitted) => isPasswordValid(submitted, PASSWORD_HASH),
  online: ONLINE,
  cookieDurationS: COOKIE_DURATION_S,
  guests,
  settings,
  sharing,
  audit,
});

const sso = createSso({
  key,
  settings,
  provider: settings === null ? null : createProvider(settings),
  online: ONLINE,
  sharing,
  audit,
  handoffs: handoffStore(),
});

const admin = createAdmin(guests);
const sharingAdmin = createSharingAdmin({ sharing, audit, settings });

const server = Bun.serve({
  port: PORT,
  // Only Caddy and the dashboard, from the same machine, have any business
  // with this service: the loopback rule refuses every other account.
  hostname: "127.0.0.1",
  // A password and a path: nothing justifies a bigger body. A policy of
  // PEOPLE_MAX addresses fits too.
  maxRequestBodySize: 160 * 1024,

  // Without a methods object, a route would answer every verb. forward_auth
  // queries /verifier with a GET whatever the original method, which it
  // announces through X-Forwarded-Method.
  routes: {
    "/verifier": { GET: routes.verify },
    "/_portal/connexion": { POST: routes.signIn },
    "/_portal/deconnexion": { POST: routes.signOut },
    "/sante": { GET: routes.health },

    // Signing in with the identity provider: the first two on the protected
    // site, through /_portal/*; the last three on the portal's own host,
    // through the manifest's routes. See src/sso.ts.
    "/_portal/oidc": { GET: sso.begin },
    "/_portal/oidc/complete": { GET: sso.complete },
    "/oidc/start": { GET: sso.start },
    "/oidc/callback": { GET: sso.callback },
    "/oidc/signout": { GET: sso.signOut },

    // Never relayed by Caddy: see src/admin.ts.
    "/admin/guests": { GET: admin.list, POST: admin.create },
    "/admin/invites/:id": { DELETE: (req) => admin.remove(req, req.params.id) },
    "/admin/sharing": { GET: sharingAdmin.list },
    "/admin/sharing/:host": { PUT: (req) => sharingAdmin.replace(req, req.params.host) },
    "/admin/audit": { GET: sharingAdmin.audit },
  },

  fetch() {
    return new Response("404: unknown route", { status: 404 });
  },

  error(err) {
    console.error(err);
    return new Response("500: server error", { status: 500 });
  },
});

console.log(`sitesolide-portal → ${server.url}`);
