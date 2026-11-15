import { readFileSync, writeFileSync } from "node:fs";
import { isPasswordValid } from "./borrowed/auth";
import { createAccessAdmin } from "./src/admin";
import { PROJECTION_FILE } from "./src/access";
import { createAccessReader } from "./src/projection";
import { auditStore, openDatabase } from "./src/database";
import { COOKIE_DURATION_S, PASSWORD_HASH, ONLINE, DATABASE_FILE, KEY_FILE, PORT, PUBLIC_URL } from "./src/config";
import { deriveKey, KEY_BYTES } from "./src/gate";
import { handoffStore } from "./src/handoff";
import { createRoutes } from "./src/routes";
import { createPasskeyReader, createPasskeySignIn, passkeyPlace } from "./src/passkey-signin";
import { PASSKEYS_FILE } from "./src/passkeys";

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

// Signing in with a company account is gone: the settings it read from
// portal.env, OIDC_* among them, are left alone and read by nothing.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("OIDC_")) {
    console.warn("portal.env still carries OIDC_* settings, which nothing reads any more: see docs/upgrading.md");
    break;
  }
}

const database = openDatabase(DATABASE_FILE);
const audit = auditStore(database);

// Who may open each site: the steward's projection, read again whenever it
// changes. See src/projection.ts.
const access = createAccessReader({ file: process.env.ACCESS_FILE ?? PROJECTION_FILE });
const reading = access.state();
console.log(`access: read from ${reading.reading === "steward" ? "the steward's projection" : "nowhere: only the owner opens a site"}`);

// The owner's passkeys, the public halves the steward projects, and where
// their ceremony runs: the portal's own host, under the zone. See
// src/passkey-signin.ts.
const place = passkeyPlace(PUBLIC_URL, process.env.PASSKEY_RP_ID);
const passkeys = createPasskeyReader({ file: process.env.PASSKEYS_FILE ?? PASSKEYS_FILE });
console.log(place === null ? "passkeys not offered: the portal's address does not start with portal." : `passkeys: ceremonies on ${place.origin}, for ${place.rpId}`);

// The codes the owner's passkey sign-in hands back to a site.
const handoffs = handoffStore();

const passkeySignIn = createPasskeySignIn({ key, online: ONLINE, place, passkeys, handoffs, audit, cookieDurationS: COOKIE_DURATION_S });

const routes = createRoutes({
  passkeys: { offered: passkeySignIn.offered, known: (ref) => passkeys.byRef(ref) !== null },
  key,
  verifyPassword: (submitted) => isPasswordValid(submitted, PASSWORD_HASH),
  online: ONLINE,
  cookieDurationS: COOKIE_DURATION_S,
  access,
  audit,
});

const admin = createAccessAdmin({ access, audit });

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

    // The owner's passkey: the first two on the protected site, the last
    // three on the portal's own host, where the ceremony runs. See
    // src/passkey-signin.ts.
    "/_portal/passkey": { GET: passkeySignIn.begin },
    "/_portal/passkey/complete": { GET: passkeySignIn.complete },
    "/passkey": { GET: passkeySignIn.page },
    "/passkey/options": { POST: passkeySignIn.options },
    "/passkey/verify": { POST: passkeySignIn.verify },

    // Never relayed by Caddy: see src/admin.ts.
    "/admin/access": { GET: admin.access },
    "/admin/audit": { GET: admin.audit },
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
