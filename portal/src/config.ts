import { join } from "node:path";

/**
 * Local port of the portal. `bin/cli/portal.ts` carries the same one, to write
 * it into the fragment of every protected site, and
 * bin/tests/cli-portal.test.ts checks that the two do not diverge.
 */
export const PORT = Number(process.env.PORT ?? 3026);

/**
 * The only location this service writes to: the cookie signing key and its
 * database, the audit. Frozen at the first import, and that is why
 * tests/setup.ts diverts it before anything loads this file.
 */
export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");

export const KEY_FILE = join(DATA_DIR, "key");

export const DATABASE_FILE = join(DATA_DIR, "portal.db");

/**
 * Left once the portal has read the steward's access projection: from then
 * on, a missing projection opens nothing, and the tables from before it are
 * never read again (src/projection.ts).
 */
export const ACCESS_MARK_FILE = join(DATA_DIR, "access-from-steward");

/**
 * In production, the portal only answers through Caddy, therefore on HTTPS:
 * which is what the `__Host-` prefix and the `Secure` attribute require. The
 * manifest sets `NODE_ENV=production`; a local lab on plain HTTP does not set
 * it, failing which the browser would not even record the cookie.
 */
export const ONLINE = process.env.NODE_ENV === "production";

/** argon2id hash of the single password, set from the dashboard: Secrets, portal.env, Change password. */
export const PASSWORD_HASH = process.env.PASSWORD_HASH ?? "";

/**
 * The address to ask a code from, shown to the visitor of a closed preview.
 *
 * No default value: the software author's address belongs to nobody else, and
 * a visitor would write to a stranger. Absent, the line disappears from the
 * page, which stays usable for whoever already has their code.
 */
export const CONTACT = process.env.SITESOLIDE_CONTACT ?? "";

/** Thirty days: one logs in once a month and per site, not every morning. */
export const COOKIE_DURATION_S = 30 * 24 * 60 * 60;

/**
 * The portal's own address, `https://portal.<zone>`, written by the manifest
 * as `https://{slug}.{zone}` and substituted at deployment. A sign-in with the
 * identity provider leaves from it and comes back to it, and the provider must
 * know `<PUBLIC_URL>/oidc/callback` in advance. No default value: an address
 * guessed here would send people to someone else's portal.
 */
export const PUBLIC_URL = process.env.PUBLIC_URL ?? "";
