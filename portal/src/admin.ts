/**
 * The administration of the guest accesses, which only the dashboard calls.
 *
 * ## Who can reach these routes
 *
 * They listen on the portal's port, which the loopback rule
 * (`bin/cli/loopback.ts`) reserves for Caddy, for root and for the dashboard's
 * single user. Caddy never relays them: a protected site only forwards
 * `/_portal/*` and the `forward_auth` call to `/verifier` to the portal, and
 * the portal's subdomain only `/sante`. `bin/tests/cli-portal.test.ts` checks
 * that no fragment aims at anything else.
 *
 * One more safety net: any request carrying `X-Forwarded-For`, which Caddy
 * sets on everything it relays, or `X-Portal-Hote`, is refused. A fragment
 * badly written one day would therefore not expose these routes to the web.
 *
 * No shared secret: it would protect against nothing more, the only accounts
 * that reach this port being the ones that would hold it.
 */
import { generatePassword } from "../borrowed/password";
import type { GuestStore } from "./database";
import { isValidDuration, GUEST_PASSWORD_GROUPS, isValidId, cleanLabel, type Guest } from "./guests";
import { guestHash, generateId, isValidHost } from "./gate";

export type Admin = {
  list: (req: Request) => Response;
  create: (req: Request) => Promise<Response>;
  remove: (req: Request, id: string) => Response;
};

export type AdminTools = {
  drawPassword: () => string;
  drawId: () => string;
};

const TOOLS: AdminTools = {
  drawPassword: () => generatePassword(undefined, GUEST_PASSWORD_GROUPS),
  drawId: () => generateId(),
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** What has come through Caddy has no business here. */
function isRelayed(req: Request): boolean {
  return req.headers.has("x-forwarded-for") || req.headers.has("x-portal-hote");
}

export function createAdmin(
  guests: GuestStore,
  clock: () => number = Date.now,
  tools: AdminTools = TOOLS,
): Admin {
  return {
    list(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      return respond({ guests: guests.list() });
    },

    /**
     * The password comes out only once, in this response. The database keeps
     * only its fingerprint: lost, it gets revoked and another one gets drawn.
     */
    async create(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);

      let body: { host?: unknown; label?: unknown; durationS?: unknown } | null;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return respond({ error: "unreadable-body" }, 400);
      }

      const host = typeof body?.host === "string" ? body.host.toLowerCase() : "";
      if (!isValidHost(host)) return respond({ error: "invalid-host" }, 400);

      const label = cleanLabel(body?.label);
      if (label === null) return respond({ error: "invalid-label" }, 400);

      // `undefined` is not "no deadline": the absence of a choice must not
      // produce the longest access.
      const durationS = body?.durationS;
      if (!isValidDuration(durationS)) return respond({ error: "invalid-duration" }, 400);

      const now = clock();
      const password = tools.drawPassword();
      const guest: Guest = {
        id: tools.drawId(),
        host,
        label,
        createdAt: now,
        expiresAt: durationS === null ? null : now + durationS * 1000,
        seenAt: null,
      };
      guests.create(guest, guestHash(password));

      return respond({ guest, password }, 201);
    },

    /** Immediate: the gate re-reads the access on every request, the next one is refused. */
    remove(req, id) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      if (!isValidId(id) || !guests.remove(id)) return respond({ error: "unknown-access" }, 404);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    },
  };
}
