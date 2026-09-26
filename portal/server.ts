import { readFileSync, writeFileSync } from "node:fs";
import { isPasswordValid } from "./borrowed/auth";
import { createAdmin } from "./src/admin";
import { guestStore, openDatabase } from "./src/database";
import { COOKIE_DURATION_S, PASSWORD_HASH, ONLINE, DATABASE_FILE, KEY_FILE, PORT } from "./src/config";
import { deriveKey, KEY_BYTES } from "./src/gate";
import { createRoutes } from "./src/routes";

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

const guests = guestStore(openDatabase(DATABASE_FILE));

const routes = createRoutes({
  key,
  verifyPassword: (submitted) => isPasswordValid(submitted, PASSWORD_HASH),
  online: ONLINE,
  cookieDurationS: COOKIE_DURATION_S,
  guests,
});

const admin = createAdmin(guests);

const server = Bun.serve({
  port: PORT,
  // Only Caddy and the dashboard, from the same machine, have any business
  // with this service: the loopback rule refuses every other account.
  hostname: "127.0.0.1",
  // A password and a path: nothing justifies a bigger body.
  maxRequestBodySize: 16 * 1024,

  // Without a methods object, a route would answer every verb. forward_auth
  // queries /verifier with a GET whatever the original method, which it
  // announces through X-Forwarded-Method.
  routes: {
    "/verifier": { GET: routes.verify },
    "/_portal/connexion": { POST: routes.signIn },
    "/_portal/deconnexion": { POST: routes.signOut },
    "/sante": { GET: routes.health },

    // Never relayed by Caddy: see src/admin.ts.
    "/admin/guests": { GET: admin.list, POST: admin.create },
    "/admin/invites/:id": { DELETE: (req) => admin.remove(req, req.params.id) },
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
