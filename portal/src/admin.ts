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
import type { AuditStore, GuestStore, SharingStore } from "./database";
import { isValidDuration, GUEST_PASSWORD_GROUPS, isValidId, cleanLabel, type Guest } from "./guests";
import { guestHash, generateId, isValidHost } from "./gate";
import type { Settings } from "./oidc";
import { cleanEmail, readPolicy, type Policy } from "./sharing";

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

// --- Sharing and audit -----------------------------------------------------------

export type SharingAdmin = {
  list: (req: Request) => Response;
  replace: (req: Request, host: string) => Promise<Response>;
  audit: (req: Request) => Response;
};

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
 * Who made a change, as the dashboard says: `owner` by default, the one
 * password it knows, or an email or a `token:<id>` once something else speaks
 * through it. Anything else is refused rather than written into the audit.
 */
function readActor(actor: unknown): string | null {
  if (actor === undefined || actor === "owner") return "owner";
  if (typeof actor === "string" && /^token:[A-Za-z0-9_-]{1,64}$/.test(actor)) return actor;
  return cleanEmail(actor);
}

/** What changed between two lists, for the audit: the additions and the removals, not the whole list again. */
function difference(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((one) => !before.includes(one)), removed: before.filter((one) => !after.includes(one)) };
}

/**
 * The sharing policies and the audit, which only the dashboard calls, on the
 * same port and behind the same rule as the guest accesses: see the header.
 *
 * Replacing a policy touches the portal's database and nothing else, never
 * Caddy: the gate reads the policy on every request, so the change holds from
 * the next one. The host is not checked against the sites the portal guards,
 * which it does not know: the dashboard confronts it with its snapshot first,
 * as for a guest access, and a policy for a host nobody routes here opens
 * nothing.
 */
export function createSharingAdmin(
  stores: { sharing: SharingStore; audit: AuditStore; settings: Settings | null },
  clock: () => number = Date.now,
): SharingAdmin {
  return {
    list(req) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      return respond({ sso: ssoView(stores.settings), sites: stores.sharing.list() });
    },

    async replace(req, rawHost) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      const host = rawHost.toLowerCase();
      if (!isValidHost(host)) return respond({ error: "invalid-host" }, 400);

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return respond({ error: "unreadable-body" }, 400);
      }
      const reading = readPolicy(body);
      if ("error" in reading) return respond({ error: reading.error }, 400);
      const actor = readActor((body as { actor?: unknown }).actor);
      if (actor === null) return respond({ error: "invalid-actor" }, 400);

      const now = clock();
      const before: Policy = stores.sharing.get(host);
      const policy = reading.policy;
      stores.sharing.set(host, policy, now);

      const people = difference(before.people, policy.people);
      const domains = difference(before.domains, policy.domains);
      try {
        stores.audit.record(
          {
            actor,
            action: "sharing.update",
            target: host,
            detail: {
              mode: policy.mode,
              previousMode: before.mode,
              peopleAdded: people.added,
              peopleRemoved: people.removed,
              domainsAdded: domains.added,
              domainsRemoved: domains.removed,
            },
          },
          now,
        );
      } catch (err) {
        console.error(`audit: ${err instanceof Error ? err.message : String(err)}`);
      }
      return respond({ host, policy, updatedAt: now });
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
