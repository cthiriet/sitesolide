/**
 * The portal's admin API, which only the dashboard and root call.
 *
 * ## Who can reach these routes
 *
 * They listen on the portal's port, which the loopback rule
 * (`bin/cli/loopback.ts`) reserves for Caddy, for root and for the dashboard's
 * single user. Caddy never relays them: a protected site only forwards
 * `/_portal/*` and the `forward_auth` call to `/verifier` to the portal, and
 * the portal's subdomain only `/sante` and the provider's routes, `/oidc/*`,
 * behind a 400 for any ambiguous path. `bin/tests/cli-portal.test.ts` checks
 * that no fragment aims at anything else.
 *
 * One more safety net: any request carrying `X-Forwarded-For`, which Caddy
 * sets on everything it relays, or `X-Portal-Hote`, is refused. A fragment
 * badly written one day would therefore not expose these routes to the web.
 *
 * ## Who may open a site is the steward's now
 *
 * The portal keeps no list of people any more: the steward holds the access
 * registry and writes the projection the portal reads (src/projection.ts).
 * The routes that changed who may open a site before it answer `410 moved`
 * to whoever asks, whatever the body: they change nothing, so there is no
 * actor to believe or refuse. Their tables stay in `portal.db`, read-only,
 * for a rollback. `GET /admin/access` says what the portal reads, for the
 * steward and the CLI.
 */
import type { AuditStore } from "./database";
import type { Settings } from "./oidc";
import type { AccessReader } from "./projection";

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** What has come through Caddy has no business here. */
function isRelayed(req: Request): boolean {
  return req.headers.has("x-forwarded-for") || req.headers.has("x-portal-hote");
}

// --- Sign-in settings -----------------------------------------------------------

/**
 * What the dashboard shows about signing in with the provider: whether it is
 * configured, under which name, where people land, and who always gets in.
 * Never the client secret, nor the client identifier, which the dashboard has
 * no use for.
 */
export type SsoView = {
  configured: boolean;
  providerName: string | null;
  portalUrl: string | null;
  admins: string[];
  allowedDomains: string[];
};

export function ssoView(settings: Settings | null): SsoView {
  if (settings === null) return { configured: false, providerName: null, portalUrl: null, admins: [], allowedDomains: [] };
  return {
    configured: true,
    providerName: settings.providerName,
    portalUrl: settings.portalOrigin,
    admins: settings.admins,
    allowedDomains: settings.allowedDomains,
  };
}

export type AccessAdmin = {
  /** `GET /admin/access`: what the portal decides who may open a site from. */
  access: (req: Request) => Response;
  /** `GET /admin/sharing`: how people sign in, which the dashboard offers on its sign-in page. */
  sso: (req: Request) => Response;
  /** The routes that changed who may open a site before the steward kept it. */
  moved: (req: Request) => Response;
  audit: (req: Request) => Response;
};

/** What the moved routes answer. */
export const MOVED = {
  error: "moved",
  message: "who may open a site is kept by the steward now: sitesolide share, or the dashboard's Access section",
};

export function createAccessAdmin(stores: { access: Pick<AccessReader, "state">; audit: AuditStore; settings: Settings | null }): AccessAdmin {
  return {
    access(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      return respond(stores.access.state());
    },

    sso(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      // `sites` stays, empty, for a dashboard from before the registry.
      return respond({ sso: ssoView(stores.settings), sites: [] });
    },

    moved(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      return respond(MOVED, 410);
    },

    /** Most recent first; `before` is the id of the last event of the previous page. */
    audit(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      const params = new URL(req.url).searchParams;
      const limit = Number(params.get("limit") ?? 100);
      const before = params.has("before") ? Number(params.get("before")) : undefined;
      if (!Number.isInteger(limit) || limit < 1 || (before !== undefined && (!Number.isInteger(before) || before < 1))) {
        return respond({ error: "invalid-page" }, 400);
      }
      return respond({ events: stores.audit.recent(limit, before) });
    },
  };
}
