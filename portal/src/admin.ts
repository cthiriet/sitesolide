/**
 * The administration of the guest accesses, which only the dashboard calls.
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
 * No shared secret: it would protect against nothing more, the only accounts
 * that reach this port being the ones that would hold it.
 *
 * ## Who may say who acts
 *
 * A change records its actor: `owner` by default, the dashboard's own calls.
 * A Project admin's email or a team token's `token:<id>` is believed from
 * root alone, recognised by the uid of the connection's other end
 * (src/peer.ts): the steward, through its relay, and `sitesolide share` over
 * the owner's SSH both run as root, the dashboard does not. A compromised
 * dashboard can still change a site's sharing or guests, as the owner, as it
 * always could; it can no longer write that someone else did.
 */
import { generatePassword } from "../borrowed/password";
import type { AuditStore, GuestStore, SharingStore } from "./database";
import { isValidDuration, GUEST_PASSWORD_GROUPS, isValidId, cleanLabel, type Guest } from "./guests";
import { guestHash, generateId, isValidHost } from "./gate";
import type { Settings } from "./oidc";
import { ROOT_UID, type CallerUid } from "./peer";
import { cleanEmail, readPolicy, type Policy } from "./sharing";

export type Admin = {
  list: (req: Request) => Response;
  create: (req: Request) => Promise<Response>;
  remove: (req: Request, id: string) => Promise<Response>;
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

/**
 * `callerUid`: whose account opened the connection, for the actor rule; the
 * server reads it from the kernel. Without it nobody is root, and only `owner`
 * is accepted, the safe failure.
 */
export function createAdmin(
  guests: GuestStore,
  clock: () => number = Date.now,
  tools: AdminTools = TOOLS,
  audit: AuditStore | null = null,
  callerUid: CallerUid = () => null,
): Admin {
  /**
   * Who may see a site changes here as much as in the sharing: a guest access
   * is a door handed to one person. The actor is the caller's word, as for a
   * sharing: `owner` from the dashboard's own session, a Project admin's
   * email from the steward, which checked their role and speaks for them as
   * root (dashboard/README.md, "Members"), and only root may name one. The
   * label is a name, never the password.
   */
  function record(action: "guest.create" | "guest.revoke", guest: Guest, now: number, actor: string): void {
    if (audit === null) return;
    try {
      audit.record(
        {
          actor,
          action,
          target: guest.host,
          detail: { guest: guest.id, label: guest.label, expiresAt: guest.expiresAt },
        },
        now,
      );
    } catch (err) {
      console.error(`audit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

      let body: { host?: unknown; label?: unknown; durationS?: unknown; actor?: unknown } | null;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return respond({ error: "unreadable-body" }, 400);
      }
      const reading = readActor(body?.actor, req, callerUid);
      if ("refusal" in reading) return reading.refusal;
      const { actor } = reading;

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
      record("guest.create", guest, now, actor);

      return respond({ guest, password }, 201);
    },

    /**
     * Immediate: the gate re-reads the access on every request, the next one is
     * refused. A body is optional, `{ actor }` alone, the dashboard sending none.
     */
    async remove(req, id) {
      if (isRelayed(req)) return respond({ error: "relayed-request" }, 403);
      let actor = "owner";
      const text = await req.text().catch(() => "");
      if (text !== "") {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return respond({ error: "unreadable-body" }, 400);
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return respond({ error: "invalid-actor" }, 400);
        const reading = readActor((body as { actor?: unknown }).actor, req, callerUid);
        if ("refusal" in reading) return reading.refusal;
        actor = reading.actor;
      }
      const guest = isValidId(id) ? guests.list().find((one) => one.id === id) : undefined;
      if (guest === undefined || !guests.remove(id)) return respond({ error: "unknown-access" }, 404);
      record("guest.revoke", guest, clock(), actor);
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
 * Who made a change, as the caller says: `owner` by default, the one password
 * the dashboard knows; a team token's `token:<id>` or a member's email, which
 * the steward sends once it has judged the token or checked the role, and
 * which only root may send: anyone else naming one is refused, 403
 * `actor-not-root`, and nothing changes. Anything else is refused rather than
 * written into the audit.
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
  stores: { sharing: SharingStore; audit: AuditStore; settings: Settings | null; callerUid?: CallerUid },
  clock: () => number = Date.now,
): SharingAdmin {
  const callerUid: CallerUid = stores.callerUid ?? (() => null);
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
      const named = readActor((body as { actor?: unknown } | null)?.actor, req, callerUid);
      if ("refusal" in named) return named.refusal;
      const { actor } = named;
      const reading = readPolicy(body);
      if ("error" in reading) return respond({ error: reading.error }, 400);

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
