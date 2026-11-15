/**
 * The portal's admin API, which only the dashboard and root call.
 *
 * ## Who can reach these routes
 *
 * They listen on the portal's port, which the loopback rule
 * (`bin/cli/loopback.ts`) reserves for Caddy, for root and for the dashboard's
 * single user. Caddy never relays them: a protected site only forwards
 * `/_portal/*` and the `forward_auth` call to `/verifier` to the portal, and
 * the portal's subdomain only `/sante` and the passkey's routes,
 * `/passkey*`, behind a 400 for any ambiguous path. `bin/tests/cli-portal.test.ts` checks
 * that no fragment aims at anything else.
 *
 * One more safety net: any request carrying `X-Forwarded-For`, which Caddy
 * sets on everything it relays, or `X-Portal-Hote`, is refused. A fragment
 * badly written one day would therefore not expose these routes to the web.
 *
 * ## Who may open a site is the steward's
 *
 * The portal keeps no list of guests: the steward holds the access registry
 * and writes the projection the portal reads (src/projection.ts).
 * `GET /admin/access` says what the portal reads, for the steward and the
 * CLI.
 */
import type { AuditStore } from "./database";
import type { AccessReader } from "./projection";

/** The admin routes' answer, never cached. */
export function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** What has come through Caddy has no business here. */
export function isRelayed(req: Request): boolean {
  return req.headers.has("x-forwarded-for") || req.headers.has("x-portal-hote");
}

export type AccessAdmin = {
  /** `GET /admin/access`: what the portal decides who may open a site from. */
  access: (req: Request) => Response;
  audit: (req: Request) => Response;
};

export function createAccessAdmin(stores: { access: Pick<AccessReader, "state">; audit: AuditStore }): AccessAdmin {
  return {
    access(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      return respond(stores.access.state());
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
