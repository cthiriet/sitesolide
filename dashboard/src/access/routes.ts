/**
 * The dashboard's access routes: a project's general access and people with
 * access, and the machine's People. Built around their dependencies like the
 * others: the tests drive them with a simulated steward.
 *
 *   GET    /api/access?slug=<slug>      the owner, or the project's Admin
 *   PUT    /api/access/entry            someone given access, or their role changed
 *   DELETE /api/access/entry            someone taken off
 *   PUT    /api/access/general          public or restricted; the preview code is `sitesolide lock`'s
 *   GET    /api/people                  the owner's
 *   PUT    /api/people/person           the right to create projects
 *   DELETE /api/people/person           someone taken off every project
 *
 * **The dashboard decides nothing.** It checks the origin of a change, the
 * session and the shape of the request, adds the session's unlock token
 * when it holds one, and relays to the steward, which judges every change
 * by the access rules (src/access/rules.ts) and writes the registry. What
 * the dashboard adds is what it already holds: the preview code of a
 * project whose general access is `code`, from its snapshot, and which roles
 * the one signed in may give, from the steward's own rule, for the page to
 * offer what the steward will accept.
 */
import { ROLES, rank, type Role } from "../../borrowed/access";
import { reach, type Reached } from "../control/client";
import { reservedReason } from "../control/policy";
import { read } from "../read";
import type { SessionReader } from "../routes";
import { isAcceptableOrigin } from "../sessions";
import type { Tokens } from "../secrets/tokens";
import type { MembersSteward } from "../people/client";
import type { IdentityResolver } from "../people/identity";
import type { AccessSteward } from "./client";
import type { AccessPageResponse, AccessResponse, AccessViewer, PeoplePageResponse } from "./protocol";

type Handler = (req: Request) => Promise<Response>;

export type AccessRoutesDependencies = {
  publicUrl: string;
  zone: string;
  stateFile: string;
  steward: AccessSteward;
  /** A person's requests, their session inside: `/access/person/*`. */
  members: Pick<MembersSteward, "act">;
  resolve: IdentityResolver & { forget: (hash: string) => void };
  /** The owner's sessions alone: the People page is the owner's. */
  ownerSession: SessionReader;
  /** The owner's unlock tokens, the Secrets section's. */
  tokens: Tokens;
  /** The people's own unlock tokens, by session hash. */
  unlocks: Tokens;
  /** The provider's name, for the line to send someone given a role. */
  providerName: (now: number) => Promise<string | null>;
  /**
   * The Secrets section's change of a site's portal, the owner's or a
   * person's, which general access takes: public is the portal off,
   * restricted the portal on.
   */
  togglePortal: (req: Request) => Promise<Response>;
};

export type AccessRoutes = {
  list: Handler;
  put: Handler;
  remove: Handler;
  general: Handler;
  people: Handler;
  putPerson: Handler;
  removePerson: Handler;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

/** What the page says when the steward does not carry the access registry yet. */
export const ACCESS_NOT_AVAILABLE = "The steward on this machine does not keep people with access yet: run sitesolide upgrade.";

/** What the page reads when a change needs the unlock. */
export const ACCESS_LOCKED = "Unlock first: giving someone a role above Can open, password access, or the right to create projects needs it.";

const MAX_BODY_BYTES = 16 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function relayed(reached: Reached): Response {
  if (reached.kind === "unreachable") return error(502, "failure", "Can't reach the steward.");
  if (reached.kind === "unavailable") return error(503, "not-available", ACCESS_NOT_AVAILABLE);
  if (reached.kind === "unreadable") return error(502, "failure", "The steward sent an unreadable answer.");
  return json(reached.body, reached.status);
}

/** The roles the one signed in may give: everything for the owner, at most their own for an Admin. */
export function grantable(viewer: AccessViewer): Role[] {
  if (viewer.kind === "owner") return [...ROLES];
  if (viewer.role !== "admin") return [];
  return ROLES.filter((role) => rank(role) <= rank(viewer.role!));
}

export function createAccessRoutes(dependencies: AccessRoutesDependencies, clock: () => number = Date.now): AccessRoutes {
  const { steward, resolve } = dependencies;

  type Asker =
    | { kind: "owner"; hash: string }
    | { kind: "person"; hash: string; token: string; email: string; roles: Record<string, Role> };

  /** Who asks, the origin checked first for a change; or the refusal. */
  async function asker(req: Request, writing: boolean): Promise<Asker | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
    const resolved = await resolve(req, clock());
    if (resolved === "unreachable") return error(502, "failure", "Can't reach the steward to say who is signed in.");
    if (resolved === null) return json({ error: "no-session" }, 401);
    if (resolved.identity.kind === "owner") return { kind: "owner", hash: resolved.session.hash };
    return { kind: "person", hash: resolved.session.hash, token: resolved.token, email: resolved.identity.email, roles: resolved.identity.roles };
  }

  /** A person's request the steward refused as signed out: their session closes here too. */
  function personAnswer(person: Extract<Asker, { kind: "person" }>, reached: Reached, sentUnlock: string | null): Response {
    if (reached.kind === "received" && reached.status === 401) {
      if (reached.body.error === "signed-out") {
        resolve.forget(person.hash);
        return json({ error: "no-session" }, 401);
      }
      if (reached.body.error === "locked") {
        if (sentUnlock !== null && dependencies.unlocks.read(person.hash)?.token === sentUnlock) dependencies.unlocks.forget(person.hash);
        return error(423, "locked", ACCESS_LOCKED);
      }
    }
    return relayed(reached);
  }

  /** The owner's answer, a forgotten unlock turned into the page's 423. */
  function ownerAnswer(owner: Extract<Asker, { kind: "owner" }>, reached: Reached, sentUnlock: string | null): Response {
    if (reached.kind === "received" && reached.status === 401 && reached.body.error === "locked") {
      if (sentUnlock !== null && dependencies.tokens.read(owner.hash)?.token === sentUnlock) dependencies.tokens.forget(owner.hash);
      return error(423, "locked", ACCESS_LOCKED);
    }
    return relayed(reached);
  }

  function oneSlug(req: Request): string | null {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    return wanted.length === 1 && wanted[0] !== "" && wanted[0]!.length <= 128 ? wanted[0]! : null;
  }

  /** The preview code of a project, from the snapshot, when its general access is `code`. */
  async function codeOf(slug: string): Promise<{ code: string; url: string } | null> {
    const reading = await read(dependencies.stateFile, clock());
    if (!reading.present) return null;
    const site = reading.snapshot.sites.find((one) => one.slug === slug);
    return site?.lock.code !== null && site?.lock.code !== undefined && site.lock.url !== null ? { code: site.lock.code, url: site.lock.url } : null;
  }

  return {
    async list(req) {
      const who = await asker(req, false);
      if (who instanceof Response) return who;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one project.");
      const reached =
        who.kind === "owner"
          ? await reach(() => steward.list(slug))
          : await reach(() => dependencies.members.act("POST", "/access/person/list", { session: who.token, slug }), [who.token]);
      if (reached.kind !== "received" || reached.status !== 200) return who.kind === "owner" ? ownerAnswer(who, reached, null) : personAnswer(who, reached, null);
      const access = reached.body as unknown as AccessResponse;
      const you: AccessViewer = who.kind === "owner" ? { kind: "owner" } : { kind: "person", email: who.email, role: Object.hasOwn(who.roles, slug) ? who.roles[slug]! : null };
      const until = (who.kind === "owner" ? dependencies.tokens : dependencies.unlocks).read(who.hash)?.expiresAt ?? null;
      const page: AccessPageResponse = {
        ...access,
        code: access.general?.access === "code" ? await codeOf(slug) : null,
        you,
        grantable: grantable(you),
        until,
        dashboardUrl: dependencies.publicUrl,
        providerName: await dependencies.providerName(clock()),
      };
      return json(page);
    },

    async put(req) {
      const who = await asker(req, true);
      if (who instanceof Response) return who;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const fields = { slug: body.slug, who: body.who, role: body.role ?? "visitor", ...(body.expiresInS === undefined ? {} : { expiresInS: body.expiresInS }) };
      if (who.kind === "owner") {
        const kept = dependencies.tokens.read(who.hash)?.token ?? null;
        const reached = await reach(() => steward.put({ ...(kept === null ? {} : { token: kept }), ...fields }), kept === null ? [] : [kept]);
        return ownerAnswer(who, reached, kept);
      }
      const kept = dependencies.unlocks.read(who.hash)?.token ?? null;
      const reached = await reach(
        () => dependencies.members.act("PUT", "/access/person/entry", { session: who.token, ...(kept === null ? {} : { token: kept }), ...fields }),
        kept === null ? [who.token] : [who.token, kept],
      );
      return personAnswer(who, reached, kept);
    },

    async remove(req) {
      const who = await asker(req, true);
      if (who instanceof Response) return who;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      if (who.kind === "owner") return ownerAnswer(who, await reach(() => steward.remove({ slug: body.slug, who: body.who })), null);
      const reached = await reach(() => dependencies.members.act("DELETE", "/access/person/entry", { session: who.token, slug: body.slug, who: body.who }), [who.token]);
      return personAnswer(who, reached, null);
    },

    /**
     * General access, public or restricted: the portal turned off or on, by
     * the very route the Secrets section takes, under the same unlock. A
     * preview code is set and removed with `sitesolide lock`, never here.
     */
    async general(req) {
      const who = await asker(req, true);
      if (who instanceof Response) return who;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      if (body.access === "code") return error(400, "invalid", "A preview code is set and removed with sitesolide lock, from the project's folder.");
      if (body.access !== "public" && body.access !== "restricted") return error(400, "invalid", "access: public or restricted.");
      const headers = new Headers(req.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      const translated = new Request(req.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: body.slug, active: body.access === "restricted", confirmation: typeof body.confirmation === "string" ? body.confirmation : "" }),
      });
      return dependencies.togglePortal(translated);
    },

    async people(req) {
      const open = await dependencies.ownerSession(req, clock());
      if (open === null) return json({ error: "no-session" }, 401);
      const reached = await reach(() => steward.people());
      const reading = await read(dependencies.stateFile, clock());
      const projects = reading.present ? reading.snapshot.sites.map((site) => site.slug).filter((slug) => reservedReason(slug, dependencies.zone) === null).sort() : [];
      const base = {
        projects,
        until: dependencies.tokens.read(open.hash)?.expiresAt ?? null,
        dashboardUrl: dependencies.publicUrl,
        providerName: await dependencies.providerName(clock()),
      };
      if (reached.kind === "unavailable") {
        const page: PeoplePageResponse = { available: false, reason: ACCESS_NOT_AVAILABLE, people: [], domains: [], signIn: { configured: false, allowedDomains: [], admins: [], providerName: null }, ...base };
        return json(page);
      }
      if (reached.kind !== "received" || reached.status !== 200) return relayed(reached);
      const page = { available: true, reason: null, ...(reached.body as Record<string, unknown>), ...base } as unknown as PeoplePageResponse;
      return json(page);
    },

    async putPerson(req) {
      if (!isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
      const open = await dependencies.ownerSession(req, clock());
      if (open === null) return json({ error: "no-session" }, 401);
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const kept = dependencies.tokens.read(open.hash)?.token ?? null;
      const reached = await reach(() => steward.putPerson({ ...(kept === null ? {} : { token: kept }), email: body.email, create: body.create }), kept === null ? [] : [kept]);
      return ownerAnswer({ kind: "owner", hash: open.hash }, reached, kept);
    },

    async removePerson(req) {
      if (!isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
      const open = await dependencies.ownerSession(req, clock());
      if (open === null) return json({ error: "no-session" }, 401);
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      return relayed(await reach(() => steward.removePerson(body.email)));
    },
  };
}
