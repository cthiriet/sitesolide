/**
 * The dashboard's routes, as a member reaches them: a site's Secrets, Access,
 * Sharing, Guests and Backups, and a project's members for its Project
 * admins. The same addresses as the super admin's, which server.ts sends here
 * when the session is a member's: the page asks the same routes, whoever is
 * signed in.
 *
 * **The dashboard decides nothing a member could use to do more.** It checks
 * the origin, the session and the shape of a request, adds the member's
 * session and unlock token, and relays to the steward, which judges every
 * write and every secret read by role (src/members/actions.ts) and names the
 * member in its journal. What the dashboard does decide is what a member
 * sees of what it already holds: the portal's guests and policies, the
 * backups, the registry, each reduced to the projects where their role shows
 * it (powers.ts, the steward's own table). A compromised dashboard reads all
 * of it anyway, as it always could; it never reads a secret value a member's
 * role does not reach, which only the steward hands out.
 *
 * **A member's unlock token is the steward's**, drawn when a forced sign-in
 * checks out (routes.ts, `complete`), kept here in memory by the session's
 * hash, as the super admin's is, and never sent to the browser.
 */
import { invitableHosts } from "../guests";
import { read } from "../read";
import { tokenHash } from "../sessions";
import { isAcceptableOrigin } from "../sessions";
import { fields, reach, relay, type Extraction, type Received } from "../secrets/routes";
import type { Steward } from "../secrets/client";
import type { Tokens } from "../secrets/tokens";
import type { BackupSteward } from "../backup/client";
import type { MembersSteward } from "./client";
import type { Identity, IdentityResolver, Resolved } from "./identity";
import { may, type Power } from "./powers";
import type { ProjectMembersResponse, Role, Roles } from "./protocol";

type Handler = (req: Request) => Promise<Response>;

export type MemberRelayDependencies = {
  publicUrl: string;
  resolve: IdentityResolver & { forget: (hash: string) => void };
  closeSession: (hash: string) => void;
  steward: Pick<MembersSteward, "act" | "lock" | "list">;
  /** The members' unlock tokens, by session hash: never the super admin's store. */
  tokens: Tokens;
  stateFile: string;
  /** The portal's lists, as the dashboard already reads them. */
  portal: { guests: () => Promise<Response>; sharing: () => Promise<Response> };
  secrets: Pick<Steward, "readLog">;
  backups: Pick<BackupSteward, "readBackups" | "readBackupAudit">;
  /** The provider's name, for the line a Project admin sends someone invited. */
  providerName: (now: number) => Promise<string | null>;
};

export type MemberRelay = {
  secrets: Handler;
  secretsLog: Handler;
  unlock: Handler;
  lock: Handler;
  readValue: Handler;
  setVariable: Handler;
  removeVariable: Handler;
  createFile: Handler;
  restoreFile: Handler;
  readContent: Handler;
  replaceContent: Handler;
  togglePortal: Handler;
  backups: Handler;
  backupAudit: Handler;
  restoreBackup: Handler;
  guests: Handler;
  createGuest: Handler;
  revokeGuest: (req: Request, id: string) => Promise<Response>;
  sharing: Handler;
  replaceSharing: (req: Request, host: string) => Promise<Response>;
  projectMembers: Handler;
  putProjectMember: Handler;
  removeProjectMember: Handler;
  /** Not a route: a member signing out, their unlock forgotten here and locked at the steward. */
  forgetUnlock: (sessionToken: string) => Promise<void>;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

/** What the page reads when a member's unlock is missing: where a forced sign-in begins. */
export const MEMBER_LOCKED = "Unlock first: sign in again with your provider.";

const locked = () => error(423, "locked", MEMBER_LOCKED);

/** Beyond that, it is not a site name. */
const MAX_SLUG = 128;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONTENT_BODY_BYTES = 512 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > max) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** The one slug a query names, or null. */
function oneSlug(req: Request): string | null {
  const wanted = new URL(req.url).searchParams.getAll("slug");
  return wanted.length === 1 && wanted[0] !== "" && wanted[0]!.length <= MAX_SLUG ? wanted[0]! : null;
}

function roleOn(roles: Roles, slug: string): Role | null {
  return Object.hasOwn(roles, slug) ? roles[slug]! : null;
}

const extractPortal: Extraction<{ slug: string; confirmation: string; active: boolean }> = (body) => {
  const names = fields(["slug", "confirmation"] as const)(body);
  if (names instanceof Response) return names;
  if (typeof body!.active !== "boolean") return error(400, "invalid", "Missing or non-boolean field: active.");
  return { ...names, active: body!.active };
};

export function createMemberRelay(dependencies: MemberRelayDependencies, clock: () => number = Date.now): MemberRelay {
  const { steward, tokens, resolve } = dependencies;

  type Open = { session: { hash: string }; token: string; identity: Extract<Identity, { kind: "member" }> };

  /** The member behind the request, the origin checked first for a change; or the refusal. */
  async function member(req: Request, writing: boolean): Promise<Open | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
    const resolved: Resolved = await resolve(req, clock());
    if (resolved === "unreachable") return error(502, "failure", "Can't reach the steward to say who this member is.");
    if (resolved === null) return json({ error: "no-session" }, 401);
    if (resolved.identity.kind !== "member") return error(403, "out-of-scope", "This route is a member's.");
    return { session: resolved.session, token: resolved.token, identity: resolved.identity };
  }

  /** A session the steward closed, a member removed above all: closed here too. */
  function closed(open: Open): Response {
    resolve.forget(open.session.hash);
    tokens.forget(open.session.hash);
    dependencies.closeSession(open.session.hash);
    return json({ error: "no-session" }, 401);
  }

  /** The steward's answer to the page, a closed session closing this one. */
  function answer(open: Open, received: Received, kept: { token: string } | null = null): Response {
    if (received.kind === "received" && received.status === 401) {
      if (received.body?.error === "signed-out") return closed(open);
      if (received.body?.error === "locked") {
        if (kept !== null && tokens.read(open.session.hash)?.token === kept.token) tokens.forget(open.session.hash);
        return locked();
      }
    }
    return relay(received);
  }

  /** A route that acts under the member's unlock: without it, 423, the steward not disturbed. */
  function withToken<D extends object>(extract: Extraction<D>, method: "POST" | "PUT" | "DELETE", path: string, options: { max?: number; long?: boolean } = {}): Handler {
    return async (req) => {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const read = extract(await readBody(req, options.max));
      if (read instanceof Response) return read;
      const kept = tokens.read(open.session.hash);
      if (kept === null) return locked();
      const received = await reach(() => steward.act(method, path, { ...read, session: open.token, token: kept.token }, options.long), kept.token, [open.token]);
      return answer(open, received, kept);
    };
  }

  /** A route of the member's session alone, no unlock: sharing, guests, a role taken away. */
  async function withSession(open: Open, method: "POST" | "PUT" | "DELETE", path: string, body: object): Promise<Response> {
    const received = await reach(() => steward.act(method, path, { ...body, session: open.token }), null, [open.token]);
    return answer(open, received);
  }

  /**
   * The hosts of the member's projects where their role shows this power, each
   * with its slug: the sites behind the portal in the snapshot, as for the
   * super admin's Guests and Sharing.
   */
  async function hosts(roles: Roles, power: Power): Promise<Map<string, string>> {
    const reading = await read(dependencies.stateFile, clock());
    const found = new Map<string, string>();
    if (!reading.present) return found;
    const invitable = new Set(invitableHosts(reading.snapshot));
    for (const site of reading.snapshot.sites) {
      if (invitable.has(site.address) && may(roleOn(roles, site.slug), power)) found.set(site.address, site.slug);
    }
    return found;
  }

  /** The portal's list read, or the answer that says why not. */
  async function portalList(call: () => Promise<Response>): Promise<Record<string, unknown> | Response> {
    try {
      const response = await call();
      const body: unknown = await response.json();
      if (response.status !== 200 || !isObject(body)) return error(502, "failure", "The portal sent an unreadable answer.");
      return body;
    } catch {
      return error(502, "failure", "Can't reach the portal.");
    }
  }

  /** May the member see this project's part? The page offers it only then; the steward refuses the rest anyway. */
  function mayOn(open: Open, slug: string, power: Power): Response | null {
    return may(roleOn(open.identity.roles, slug), power) ? null : error(403, "out-of-scope", `This part of ${slug} isn't yours: ask its project admin.`);
  }

  return {
    async secrets(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const received = await reach(() => steward.act("POST", "/members/secrets/projects", { session: open.token }), null, [open.token]);
      if (received.kind !== "received" || received.status !== 200) return answer(open, received);
      const projects = received.body?.projects;
      if (!Array.isArray(projects)) return error(502, "failure", "The steward sent an unreadable answer.");
      return json({ projects, until: tokens.read(open.session.hash)?.expiresAt ?? null });
    },

    async secretsLog(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "secrets.list");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.secrets.readLog(slug), null));
    },

    async unlock(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      return error(400, "reauthenticate", "A member unlocks by signing in again with their provider.");
    },

    async lock(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const kept = tokens.forget(open.session.hash);
      if (kept !== null) {
        try {
          await (await steward.lock(open.token, kept.token)).text();
        } catch {
          // A mute steward: the token is forgotten here, and lapses there.
        }
      }
      return new Response(null, { status: 204, headers: NO_STORE });
    },

    readValue: withToken(fields(["slug", "file", "variable"] as const), "POST", "/members/secrets/value", { long: true }),
    setVariable: withToken(fields(["slug", "file", "variable", "value"] as const), "PUT", "/members/secrets/variable", { long: true }),
    removeVariable: withToken(fields(["slug", "file", "variable"] as const), "DELETE", "/members/secrets/variable", { long: true }),
    createFile: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/file", { long: true }),
    restoreFile: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/restore", { long: true }),
    readContent: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/content", { long: true }),
    replaceContent: withToken(fields(["slug", "file", "content"] as const), "PUT", "/members/secrets/content", { long: true, max: MAX_CONTENT_BODY_BYTES }),
    togglePortal: withToken(extractPortal, "POST", "/members/portal", { long: true }),
    restoreBackup: withToken(fields(["slug", "snapshot", "confirmation"] as const), "POST", "/members/backups/restore", { long: true }),

    async backups(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "backups");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.backups.readBackups(slug), null));
    },

    async backupAudit(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "backups");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.backups.readBackupAudit(slug), null));
    },

    async guests(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const list = await portalList(dependencies.portal.guests);
      if (list instanceof Response) return list;
      const mine = await hosts(open.identity.roles, "guests");
      const guests = Array.isArray(list.guests) ? list.guests.filter((guest) => isObject(guest) && typeof guest.host === "string" && mine.has(guest.host)) : [];
      return json({ guests });
    },

    async createGuest(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null) return json({ error: "unreadable-body" }, 400);
      const slug = typeof body.host === "string" ? (await hosts(open.identity.roles, "guests")).get(body.host) : undefined;
      if (slug === undefined) return json({ error: "no-portal" }, 400);
      return withSession(open, "POST", "/members/guests", { slug, label: body.label, durationS: body.durationS });
    },

    async revokeGuest(req, id) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      return withSession(open, "DELETE", "/members/guests", { id });
    },

    async sharing(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const list = await portalList(dependencies.portal.sharing);
      if (list instanceof Response) return list;
      const mine = await hosts(open.identity.roles, "sharing");
      const sites = Array.isArray(list.sites) ? list.sites.filter((site) => isObject(site) && typeof site.host === "string" && mine.has(site.host)) : [];
      return json({ sso: list.sso, sites });
    },

    async replaceSharing(req, host) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null) return json({ error: "unreadable-body" }, 400);
      const slug = (await hosts(open.identity.roles, "sharing")).get(host);
      if (slug === undefined) return json({ error: "no-portal" }, 400);
      return withSession(open, "PUT", "/members/sharing", { slug, mode: body.mode, people: body.people, domains: body.domains });
    },

    async projectMembers(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "members");
      if (refusal !== null) return refusal;
      const received = await reach(() => steward.list(), null);
      if (received.kind !== "received" || received.status !== 200) return relay(received);
      const all = Array.isArray(received.body?.members) ? (received.body.members as Record<string, unknown>[]) : [];
      const members = all
        .filter((one) => typeof one.email === "string" && isObject(one.roles) && Object.hasOwn(one.roles, slug))
        .map((one) => ({ email: one.email as string, role: (one.roles as Roles)[slug]!, invitedBy: String(one.invitedBy ?? ""), updatedAt: Number(one.updatedAt ?? 0) }));
      const signIn = isObject(received.body?.signIn) ? received.body.signIn : { configured: false, allowedDomains: [] };
      const page: ProjectMembersResponse = {
        slug,
        members,
        signIn: signIn as ProjectMembersResponse["signIn"],
        dashboardUrl: dependencies.publicUrl,
        providerName: await dependencies.providerName(clock()),
        until: tokens.read(open.session.hash)?.expiresAt ?? null,
      };
      return json(page);
    },

    putProjectMember: withToken(fields(["slug", "email", "role"] as const), "PUT", "/members/project/member"),

    async removeProjectMember(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null || typeof body.slug !== "string" || typeof body.email !== "string") return error(400, "invalid", "Missing or non-text field: slug, email.");
      return withSession(open, "DELETE", "/members/project/member", { slug: body.slug, email: body.email });
    },

    async forgetUnlock(sessionToken) {
      const kept = tokens.forget(await tokenHash(sessionToken));
      if (kept === null) return;
      try {
        await (await steward.lock(sessionToken, kept.token)).text();
      } catch {
        // A mute steward: the token lapses there within ten minutes.
      }
    },
  };
}
