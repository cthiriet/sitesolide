import { readFileSync, writeFileSync } from "node:fs";
import { isPasswordValid } from "./borrowed/auth";
import { createAccessAdmin } from "./src/admin";
import { PROJECTION_FILE } from "./src/access";
import { createAccessReader } from "./src/projection";
import { ASSERTION_KEY_FILE, createDashboardAdmin, dashboardOrigin, readKeyFile } from "./src/dashboard";
import { auditStore, guestStore, openDatabase, sharingStore } from "./src/database";
import { COOKIE_DURATION_S, PASSWORD_HASH, ONLINE, DATABASE_FILE, KEY_FILE, ACCESS_MARK_FILE, PORT, PUBLIC_URL } from "./src/config";
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

// The dashboard signs in through the same flow, from its own address, which
// follows from the portal's: see src/dashboard.ts.
const dashboard = settings === null ? null : dashboardOrigin(PUBLIC_URL, process.env.DASHBOARD_URL);
if (settings !== null) {
  console.log(dashboard === null ? "dashboard sign-in not offered: the portal's address does not start with portal." : `dashboard sign-in offered, back to ${dashboard}`);
}

const database = openDatabase(DATABASE_FILE);
const audit = auditStore(database);

// Who may open each site: the steward's projection, read again whenever it
// changes; this portal's own tables, read-only, until the steward first
// writes it. See src/projection.ts.
const access = createAccessReader({
  file: process.env.ACCESS_FILE ?? PROJECTION_FILE,
  mark: ACCESS_MARK_FILE,
  legacy: { guests: guestStore(database), sharing: sharingStore(database) },
});
const reading = access.state();
console.log(`access: read from ${reading.reading === "steward" ? "the steward's projection" : reading.reading === "portal" ? "this portal's own tables, until the steward writes its projection" : "nowhere: only the owner's password and the admin emails open a site"}`);

const routes = createRoutes({
  key,
  verifyPassword: (submitted) => isPasswordValid(submitted, PASSWORD_HASH),
  online: ONLINE,
  cookieDurationS: COOKIE_DURATION_S,
  access,
  settings,
  audit,
});

// One store of codes for the sites and the dashboard: a code says which it
// was minted for, and is redeemed for nothing else.
const handoffs = handoffStore();

const sso = createSso({
  key,
  settings,
  provider: settings === null ? null : createProvider(settings),
  online: ONLINE,
  access,
  audit,
  handoffs,
  dashboardOrigin: dashboard,
});

const dashboardAdmin = createDashboardAdmin({
  key,
  settings,
  origin: dashboard,
  handoffs,
  audit,
  readKey: () => readKeyFile(process.env.ASSERTION_KEY_FILE ?? ASSERTION_KEY_FILE),
});

const admin = createAccessAdmin({ access, audit, settings });

const server = Bun.serve({
  port: PORT,
  // Only Caddy and the dashboard, from the same machine, have any business
  // with this service: the loopback rule refuses every other account.
  hostname: "127.0.0.1",
  // A password and a path: nothing justifies a bigger body.
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

    // Never relayed by Caddy: see src/admin.ts. Who may open a site is the
    // steward's: the routes that changed it answer 410.
    "/admin/access": { GET: admin.access },
    "/admin/sharing": { GET: admin.sso },
    "/admin/sharing/:host": { PUT: admin.moved },
    "/admin/guests": { GET: admin.moved, POST: admin.moved },
    "/admin/invites/:id": { DELETE: admin.moved },
    "/admin/audit": { GET: admin.audit },
    "/admin/dashboard/flow": { POST: dashboardAdmin.flow },
    "/admin/dashboard/redeem": { POST: dashboardAdmin.redeem },
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
