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
 * The routes that changed sharing and guest access answer `410 moved`, and
 * their tables stay in `portal.db`, read-only, for a rollback. `GET
 * /admin/access` says what the portal reads, for the steward and the CLI.
 *
 * ## Who may say who acts
 *
 * The routes that took an actor kept the rule they had: an email or a
 * token named as the actor is believed from root alone, recognised by the
 * uid of the connection's other end (src/peer.ts), and refused `403
 * actor-not-root` from anyone else, before the route says it moved. A
 * compromised dashboard never wrote under someone else's name here, and
 * still does not.
 */
import type { AuditStore } from "./database";
import type { Settings } from "./oidc";
import { ROOT_UID, type CallerUid } from "./peer";
import type { AccessReader } from "./projection";
import { cleanEmail } from "./sharing";

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** What has come through Caddy has no business here. */
function isRelayed(req: Request): boolean {
  return req.headers.has("x-forwarded-for") || req.headers.has("x-portal-hote");
}

// --- Sign-in settings and the actor rule ------------------------------------------

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

/**
 * Who a change names as its actor: `owner` by default; a token's `token:<id>`
 * or an email, which only root may name: anyone else naming one is refused,
 * 403 `actor-not-root`. Anything else is refused as invalid.
 */
export function readActor(actor: unknown, req: Request, callerUid: CallerUid): { actor: string } | { refusal: Response } {
  if (actor === undefined || actor === "owner") return { actor: "owner" };
  const token = typeof actor === "string" && /^token:[A-Za-z0-9_-]{1,64}$/.test(actor) ? actor : null;
  const named = token ?? cleanEmail(actor);
  if (named === null) return { refusal: respond({ error: "invalid-actor" }, 400) };
  const uid = callerUid(req);
  if (uid !== ROOT_UID) {
    // The kind of actor, never its value: an address is a person's.
    console.warn(`admin: ${token === null ? "an email" : "a token"} named as actor by uid ${uid ?? "unknown"} refused: only root names who acts`);
    return { refusal: respond({ error: "actor-not-root" }, 403) };
  }
  return { actor: named };
}

export type AccessAdmin = {
  /** `GET /admin/access`: what the portal decides who may open a site from. */
  access: (req: Request) => Response;
  /** `GET /admin/sharing`: how people sign in, which the dashboard offers on its sign-in page. */
  sso: (req: Request) => Response;
  /** The routes that changed sharing and guest access: the steward keeps access now. */
  moved: (req: Request) => Promise<Response>;
  audit: (req: Request) => Response;
};

/** What the moved routes answer, once the actor rule is satisfied. */
export const MOVED = {
  error: "moved",
  message: "who may open a site is kept by the steward now: sitesolide share, or the dashboard's Access section",
};

export function createAccessAdmin(stores: { access: Pick<AccessReader, "state">; audit: AuditStore; settings: Settings | null; callerUid?: CallerUid }): AccessAdmin {
  const callerUid: CallerUid = stores.callerUid ?? (() => null);
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

    async moved(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      const text = await req.text().catch(() => "");
      if (text !== "") {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return respond({ error: "unreadable-body" }, 400);
        }
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const reading = readActor((body as { actor?: unknown }).actor, req, callerUid);
          if ("refusal" in reading) return reading.refusal;
        }
      }
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
