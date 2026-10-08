/**
 * Signing in to the dashboard with a work account: the two admin routes the
 * dashboard calls over the loopback, on either side of the provider.
 *
 *   POST /admin/dashboard/flow    { binding, returnTo, chooseAccount, reauth } -> { start }
 *   POST /admin/dashboard/redeem  { code, binding }                            -> { assertion, returnTo, reauth }
 *
 * The dashboard has no network and cannot sit behind the portal: it cannot run
 * a sign-in itself, and must not be believed when it names someone. So the
 * portal runs the flow it runs for every protected site (src/handoff.ts says
 * how), with the dashboard's host in the place of a site's, and hands the
 * dashboard, instead of a cookie, an assertion it signed (src/assertion.ts):
 * the verified email, when the person last proved themselves, for the
 * dashboard alone, for five minutes, once. The steward checks it as root
 * before it opens a member session, with a public key it keeps itself.
 *
 * - `flow` seals a flow for the dashboard's host around a binding the
 *   dashboard drew and set as a cookie on its own host: the code that comes
 *   back is redeemed only with that cookie, by the browser that began.
 * - `redeem` burns the code, checks it was minted for the dashboard, on its
 *   host, for this binding, judges the address against the allowed domains
 *   again, and signs.
 * - `reauth`: a member unlocking their projects' secrets. The flow skips the
 *   portal's session and forces a sign-in at the provider, whose ID token
 *   must say it happened during the flow (src/sso.ts); the assertion then
 *   carries `reauth`, which the steward demands before it unlocks.
 *
 * Both answer only on the loopback, like every admin route: the request
 * Caddy relays is refused (`X-Forwarded-For`, `X-Portal-Hote`), and the
 * loopback rule leaves this port to root, Caddy and site-dashboard.
 *
 * The private key lives in `/etc/sitesolide-portal/assertion.key`, written by
 * the steward as `root:site-portal 0640`, and is read again at every
 * redemption: a key the steward lays or replaces later needs no restart.
 */
import { readFileSync } from "node:fs";
import { readPrivateKey, signAssertion, type PrivateKey } from "./assertion";
import type { AuditStore, NewEvent } from "./database";
import { bindingHash, isBinding, issueFlow, type HandoffStore } from "./handoff";
import { isAcceptableUrl, type Settings } from "./oidc";
import { isValidHost, safeReturnTo } from "./gate";
import { maySignIn } from "./sharing";

/** Where the steward lays the private key. */
export const ASSERTION_KEY_FILE = "/etc/sitesolide-portal/assertion.key";

/** The key file's size has no reason to be anywhere near this. */
const MAX_KEY_BYTES = 4096;

/**
 * The dashboard's origin. The portal's manifest names its own address
 * `https://{slug}.{zone}`, and the dashboard's is `https://dashboard.{zone}`:
 * the one follows from the other, with no setting of its own to keep equal.
 * `override` (`DASHBOARD_URL`) is for a portal whose address does not start
 * with `portal.`, and for the tests. null: no dashboard flow is offered.
 */
export function dashboardOrigin(publicUrl: string, override: string | undefined): string | null {
  const explicit = (override ?? "").trim();
  if (explicit !== "") return isAcceptableUrl(explicit) ? new URL(explicit).origin : null;
  if (!isAcceptableUrl(publicUrl)) return null;
  const url = new URL(publicUrl);
  if (!url.hostname.startsWith("portal.")) return null;
  url.hostname = `dashboard.${url.hostname.slice("portal.".length)}`;
  return url.origin;
}

/** The key the steward laid, or null when it is missing or unreadable. */
export function readKeyFile(path: string): PrivateKey | null {
  let text: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_KEY_BYTES) return null;
    text = bytes.toString("utf8");
  } catch {
    return null;
  }
  return readPrivateKey(text);
}

export type DashboardAdminOptions = {
  key: Uint8Array | null;
  settings: Settings | null;
  /** From `dashboardOrigin`; null, both routes answer `not-offered`. */
  origin: string | null;
  handoffs: HandoffStore;
  audit: AuditStore;
  /** The private key, read again at every redemption. */
  readKey: () => PrivateKey | null;
};

export type DashboardAdmin = {
  flow: (req: Request) => Promise<Response>;
  redeem: (req: Request) => Promise<Response>;
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** What has come through Caddy has no business here. */
function isRelayed(req: Request): boolean {
  return req.headers.has("x-forwarded-for") || req.headers.has("x-portal-hote");
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createDashboardAdmin(options: DashboardAdminOptions, clock: () => number = Date.now): DashboardAdmin {
  const host = options.origin === null ? null : new URL(options.origin).hostname;

  function record(event: NewEvent, now: number): void {
    try {
      options.audit.record(event, now);
    } catch (err) {
      console.error(`audit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Why nothing is offered, or null when everything a dashboard sign-in needs is there. */
  function unavailable(): Response | null {
    if (options.key === null || options.settings === null || host === null || !isValidHost(host)) {
      return respond({ error: "not-offered", message: "signing in with a company account is not configured on this portal" }, 404);
    }
    return null;
  }

  return {
    async flow(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      const refusal = unavailable();
      if (refusal !== null) return refusal;
      const body = await readBody(req);
      if (
        body === null ||
        !isBinding(body.binding) ||
        (body.chooseAccount !== undefined && typeof body.chooseAccount !== "boolean") ||
        (body.reauth !== undefined && typeof body.reauth !== "boolean")
      ) {
        return respond({ error: "invalid", message: "binding: 32 drawn bytes in base64url; chooseAccount and reauth: true or false" }, 400);
      }
      const flow = issueFlow(
        options.key!,
        {
          host: host!,
          returnTo: safeReturnTo(body.returnTo),
          binding: bindingHash(body.binding),
          chooseAccount: body.chooseAccount === true,
          audience: "dashboard",
          reauth: body.reauth === true,
        },
        Math.floor(clock() / 1000),
      );
      return respond({ start: `${options.settings!.portalOrigin}/oidc/start?${new URLSearchParams({ flow })}` });
    },

    async redeem(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      const refusal = unavailable();
      if (refusal !== null) return refusal;
      const body = await readBody(req);
      if (body === null || typeof body.code !== "string" || (body.binding !== null && typeof body.binding !== "string")) {
        return respond({ error: "invalid", message: "code and binding: the values the dashboard holds" }, 400);
      }
      const now = clock();
      const redemption = options.handoffs.redeem(body.code, host!, body.binding as string | null, now, "dashboard");
      if ("refusal" in redemption) {
        // A code that was never minted is noise, as on a site; the rest says
        // something worth reading.
        if (redemption.refusal !== "unknown-code") {
          record({ actor: "anonymous", action: "portal.signin_failed", target: host, detail: { method: "oidc", reason: redemption.refusal } }, now);
        }
        return respond({ error: redemption.refusal, message: "this sign-in link has expired or was opened in another browser" }, 400);
      }

      // The settings are judged again: an address taken off the allowed
      // domains since the code was minted does not sign in.
      const { identity, authTime, returnTo, reauth } = redemption.handoff;
      if (!maySignIn(identity.email, options.settings!.allowedDomains, options.settings!.admins)) {
        record({ actor: identity.email, action: "portal.signin_failed", target: host, detail: { method: "oidc", reason: "domain-not-allowed" } }, now);
        return respond({ error: "domain-not-allowed", message: "this account's domain isn't allowed to sign in here" }, 403);
      }
      const privateKey = options.readKey();
      if (privateKey === null) {
        return respond({ error: "no-key", message: "the portal has no key to sign with yet: the steward lays it, see dashboard/README.md" }, 503);
      }
      const assertion = await signAssertion(privateKey, { email: identity.email, name: identity.name, authTime, reauth }, Math.floor(now / 1000));
      return respond({ assertion, returnTo, reauth });
    },
  };
}
