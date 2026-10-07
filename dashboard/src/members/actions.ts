/**
 * A member's work on their projects, judged by the steward: their secrets,
 * the portal door, sharing, guest access, and the restore of a backup. Each
 * route asks, in the order of the risk:
 *
 *   the body's shape, the member session, the member's own unlock where the
 *   power needs one, the role on that project (powers.ts), the machine's own
 *   projects and files refused, then the operation, under the steward's lock,
 *   where the session, the unlock and the role are asked again.
 *
 * **The operations are the super admin's, with the member as actor.** Writing
 * a variable, reading one, turning a door, starting a restore: the very code
 * of src/secrets/steward.ts and src/backup/routes.ts, handed over here with
 * `who`, the email this steward verified, which its journal and the backups'
 * audit record. A Developer is the same code with nothing read back: the
 * listing hides every value, size and previous version from them, and a read
 * is refused before any file is opened.
 *
 * **Sharing and guests go to the portal from here**, as root, through the
 * relay (portal.ts), with the member's email as actor: the dashboard never
 * names who acts. What a Project admin may share is a team token's rule: the
 * project's own site, people at any address, a domain only among those the
 * portal admits at sign-in, never public, which is the door, turned off.
 *
 * The routes, on the dashboard's socket:
 *
 *   POST   /members/secrets/projects  { session }                                      -> MemberProjectsResponse
 *   POST   /members/secrets/value     { session, token, slug, file, variable }         -> ValueResponse     Project admin
 *   PUT    /members/secrets/variable  { session, token, slug, file, variable, value }  -> FileResponse      Developer
 *   DELETE /members/secrets/variable  { session, token, slug, file, variable }         -> FileResponse      Developer
 *   POST   /members/secrets/file      { session, token, slug, file }                   -> FileResponse      Developer
 *   POST   /members/secrets/restore   { session, token, slug, file }                   -> FileResponse      Project admin
 *   POST   /members/secrets/content   { session, token, slug, file }                   -> ContentResponse   Project admin
 *   PUT    /members/secrets/content   { session, token, slug, file, content }          -> FileResponse      Developer
 *   POST   /members/portal            { session, token, slug, active, confirmation }   -> PortalResponse    Project admin
 *   POST   /members/backups/restore   { session, token, slug, snapshot, confirmation } -> 202 RestoreResponse  Project admin
 *   PUT    /members/sharing           { session, slug, mode, people, domains }         -> the portal's answer  Project admin
 *   POST   /members/guests            { session, slug, label, durationS }              -> the portal's answer  Project admin
 *   DELETE /members/guests            { session, id }                                  -> 204                  Project admin
 */
import { domainRefusals, policyOf, readPortalSharing, readTokenPolicy } from "../control/sharing";
import type { ProjectView, PortalView } from "../secrets/protocol";
import { checkSite, type Site } from "../secrets/scope";
import { machineRefusal, may, needsUnlock, powerRefusal, roleDetail, type Power } from "./powers";
import type { PortalAdmin } from "./portal";
import type { Role, Roles } from "./protocol";
import type { MemberPrincipal, MemberRoutes, RestartRefusal } from "./steward";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/**
 * Who the steward acts for: the email it verified, as the journal writes it.
 * `readsBack`: a member whose role reads values back, a Project admin; a
 * Developer's answers show every file write-only.
 */
export type Who = { actor: string; member: string | null; readsBack?: boolean };

/** The super admin's operations, taken with the member as `who`. They run under the steward's lock. */
export type MemberOps = {
  /** The projects whose files this member may list, in the shape the page knows, what they may not read hidden. */
  projects: (roles: Roles) => Promise<ProjectView[]>;
  readValue: (req: Request, body: Body, who: Who) => Promise<Response>;
  setVariable: (req: Request, body: Body, who: Who) => Promise<Response>;
  removeVariable: (req: Request, body: Body, who: Who) => Promise<Response>;
  createFile: (req: Request, body: Body, who: Who) => Promise<Response>;
  restoreFile: (req: Request, body: Body, who: Who) => Promise<Response>;
  readContent: (req: Request, body: Body, who: Who) => Promise<Response>;
  replaceContent: (req: Request, body: Body, who: Who) => Promise<Response>;
  portal: (req: Request, body: Body, who: Who) => Promise<Response>;
};

export type MemberActionsDependencies = {
  members: Pick<MemberRoutes, "authorize" | "unlockedUntil" | "journalRefusal">;
  /** The steward's body reader: the expected fields and those alone, bounded in size and time. */
  readBody: (req: Request, fields: string[], max?: number) => Promise<Body | Response>;
  /** The steward's exclusion lock; `still` is asked once the turn has come, and refuses with its answer. */
  underLock: (req: Request, still: () => Promise<Response | null>, task: () => Promise<Response>) => Promise<Response>;
  ops: MemberOps;
  /** The backup routes' restore, the requester given: absent, a steward built without backups. */
  startRestore: ((req: Request, body: Body) => Promise<Response>) | null;
  /** The portal's admin API through the relay; null, sharing and guests say the relay is missing. */
  portal: PortalAdmin | null;
  sites: () => Promise<Map<string, Site>>;
  portalOf: (site: Site) => Promise<PortalView>;
  /** The site's address under the zone, where the portal keeps its policy and its guests. */
  hostOf: (slug: string) => string;
  zone: string;
  /** The biggest body, a whole file's content. */
  maxContentBytes: number;
};

const STATUSES: Record<string, number> = {
  invalid: 400,
  "out-of-scope": 403,
  "not-found": 404,
  "no-portal": 409,
  "not-available": 503,
  failure: 502,
};

function fail(code: string, message: string, details?: string[]): Response {
  return Response.json(details === undefined ? { error: code, message } : { error: code, message, details }, { status: STATUSES[code] ?? 500 });
}

const SLUG_SHAPE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

const RELAY_MISSING =
  "the steward cannot reach the portal: its relay, sitesolide-portal-relay.socket, is not installed or not running; the super admin runs sitesolide upgrade";

/** The portal's answer, read whole, or why there is none. Never thrown. */
async function asked(call: () => Promise<Response>): Promise<{ status: number; body: unknown } | Response> {
  try {
    const response = await call();
    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return fail("failure", "the portal sent an answer that does not read");
      }
    }
    return { status: response.status, body };
  } catch {
    return fail("not-available", RELAY_MISSING);
  }
}

/** The portal's own refusal, its code kept and a message added, as the dashboard shows it. */
function portalRefusal(status: number, body: unknown): Response {
  const code = typeof body === "object" && body !== null && typeof (body as Body).error === "string" ? ((body as Body).error as string) : "failure";
  return Response.json({ error: code, message: `the portal refused: ${code}` }, { status: status >= 400 && status < 600 ? status : 502 });
}

export function createMemberActions(dependencies: MemberActionsDependencies): Routes {
  const { members, readBody, underLock, ops } = dependencies;

  function roleOn(principal: MemberPrincipal, slug: string): Role | null {
    return Object.hasOwn(principal.roles, slug) ? principal.roles[slug]! : null;
  }

  /**
   * The member may use this power on this project, or the refusal: the
   * machine's projects first, then the role, journaled with the role alone.
   */
  async function judge(principal: MemberPrincipal, slug: unknown, power: Power, operation: RestartRefusal["operation"]): Promise<Response | null> {
    if (typeof slug !== "string" || !SLUG_SHAPE.test(slug)) return fail("invalid", "slug: a project's slug");
    const machine = machineRefusal(slug, null, dependencies.zone);
    if (machine !== null) return fail("out-of-scope", machine);
    const role = roleOn(principal, slug);
    if (may(role, power)) return null;
    await members.journalRefusal({ operation, result: "rejects", actor: principal.email, member: principal.email, slug, detail: roleDetail(role) });
    return fail("out-of-scope", powerRefusal(principal.email, role, slug, power));
  }

  /** Keeps the fields an operation reads: never the session nor the member's token. */
  function only(body: Body, fields: readonly string[]): Body {
    const kept: Body = {};
    for (const field of fields) if (Object.hasOwn(body, field)) kept[field] = body[field];
    return kept;
  }

  type Spec = {
    operation: RestartRefusal["operation"];
    power: Power;
    /** Fields that must be strings. */
    texts: readonly string[];
    /** Other fields, checked by `check`. */
    others?: readonly string[];
    check?: (body: Body) => Response | null;
    max?: number;
    run: (req: Request, body: Body, who: Who) => Promise<Response>;
  };

  /** One operation on a project's secrets, door or data, under the lock, judged twice. */
  function action(spec: Spec): Handler {
    const unlock = needsUnlock(spec.power);
    const fields = [...spec.texts, ...(spec.others ?? [])];
    return async (req) => {
      const body = await readBody(req, ["session", ...(unlock ? ["token"] : []), ...fields], spec.max);
      if (body instanceof Response) return body;
      for (const field of spec.texts) if (typeof body[field] !== "string") return fail("invalid", `${field} must be a string`);
      const shape = spec.check?.(body) ?? null;
      if (shape !== null) return shape;
      const principal = await members.authorize(body.session, unlock ? body.token : null);
      if (principal instanceof Response) return principal;
      const refusal = await judge(principal, body.slug, spec.power, spec.operation);
      if (refusal !== null) return refusal;
      const slug = body.slug as string;
      const who: Who = { actor: principal.email, member: principal.email, readsBack: may(roleOn(principal, slug), "secrets.read") };
      // Asked again once the turn has come: removed, locked or demoted while
      // the request waited behind a restart, nothing is done.
      const still = async (): Promise<Response | null> => {
        const again = await members.authorize(body.session, unlock ? body.token : null);
        if (again instanceof Response) return again;
        if (again.email !== principal.email) return fail("out-of-scope", "this session is someone else's now");
        return may(roleOn(again, slug), spec.power) ? null : fail("out-of-scope", powerRefusal(again.email, roleOn(again, slug), slug, spec.power));
      };
      return underLock(req, still, () => spec.run(req, only(body, fields), who));
    };
  }

  const FILE = ["slug", "file"] as const;
  const VARIABLE = ["slug", "file", "variable"] as const;

  /** The project's site, behind the portal both in its manifest and in its block, and its host; or the refusal. */
  async function portalSite(slug: string): Promise<{ site: Site; host: string } | Response> {
    const found = checkSite(await dependencies.sites(), slug);
    if ("refusal" in found) return fail(found.refusal.error, found.refusal.message);
    const view = await dependencies.portalOf(found.site);
    if (!view.requested || !view.installed) {
      return fail("no-portal", `${slug} is not behind the portal: everyone gets in already, and putting it behind the portal is its Access section's`);
    }
    return { site: found.site, host: dependencies.hostOf(found.site.folder) };
  }

  async function sharing(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug", "mode", "people", "domains"]);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    const refusal = await judge(principal, body.slug, "sharing", "sharing");
    if (refusal !== null) return refusal;
    const slug = body.slug as string;
    const reading = readTokenPolicy(only(body, ["mode", "people", "domains"]));
    if ("refusal" in reading) {
      const message =
        reading.refusal.code === "out-of-scope"
          ? "public is not a sharing mode: making a site public turns its portal off, from its Access section"
          : reading.refusal.message;
      return fail(reading.refusal.code, message, reading.refusal.details);
    }
    const site = await portalSite(slug);
    if (site instanceof Response) return site;
    const portal = dependencies.portal;
    if (portal === null) return fail("not-available", RELAY_MISSING);
    const list = await asked(() => portal.sharing());
    if (list instanceof Response) return list;
    const known = list.status === 200 ? readPortalSharing(list.body) : null;
    if (known === null) return fail("failure", "the portal's sharing list does not read: is the portal up to date?");
    // A Project admin did not choose the company's domains: the owner did, in
    // OIDC_ALLOWED_DOMAINS. A domain they open must be one of those.
    const refusals = domainRefusals(policyOf(known, site.host).policy, reading.policy, known.sso.allowedDomains);
    if (refusals.length > 0) {
      const allowed = known.sso.allowedDomains;
      const message =
        allowed.length === 0
          ? "a project admin may open a site to no domain: the portal lets anyone its provider vouches for sign in, share with people by email instead"
          : `a project admin may open a site only to the domains the portal admits at sign-in: ${allowed.join(", ")}`;
      await members.journalRefusal({ operation: "sharing", result: "rejects", actor: principal.email, member: principal.email, slug, detail: "domain" });
      return fail("out-of-scope", message, refusals);
    }
    const { mode, people, domains } = reading.policy;
    const answer = await asked(() => portal.replaceSharing(site.host, { mode, people, domains, actor: principal.email }));
    if (answer instanceof Response) return answer;
    return answer.status === 200 ? Response.json(answer.body) : portalRefusal(answer.status, answer.body);
  }

  async function createGuest(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug", "label", "durationS"]);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    const refusal = await judge(principal, body.slug, "guests", "guest.create");
    if (refusal !== null) return refusal;
    const site = await portalSite(body.slug as string);
    if (site instanceof Response) return site;
    const portal = dependencies.portal;
    if (portal === null) return fail("not-available", RELAY_MISSING);
    // The label and the duration are the portal's to judge, as for the super admin.
    const answer = await asked(() => portal.createGuest({ host: site.host, label: body.label, durationS: body.durationS, actor: principal.email }));
    if (answer instanceof Response) return answer;
    return answer.status === 201 ? Response.json(answer.body, { status: 201 }) : portalRefusal(answer.status, answer.body);
  }

  async function revokeGuest(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "id"]);
    if (body instanceof Response) return body;
    if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) return fail("invalid", "id: a guest access's identifier");
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    const portal = dependencies.portal;
    if (portal === null) return fail("not-available", RELAY_MISSING);
    const list = await asked(() => portal.guests());
    if (list instanceof Response) return list;
    const guests = typeof list.body === "object" && list.body !== null ? (list.body as Body).guests : null;
    const guest = Array.isArray(guests) ? (guests as Body[]).find((one) => one.id === body.id) : undefined;
    // The project whose site the access opens: an access elsewhere reads as unknown.
    const slug = guest === undefined ? null : [...(await dependencies.sites()).keys()].find((folder) => dependencies.hostOf(folder) === guest.host) ?? null;
    if (slug === null) return fail("not-found", "no such guest access on your projects");
    const refusal = await judge(principal, slug, "guests", "guest.revoke");
    if (refusal !== null) return refusal;
    const answer = await asked(() => portal.revokeGuest(body.id as string, principal.email));
    if (answer instanceof Response) return answer;
    return answer.status === 204 ? new Response(null, { status: 204 }) : portalRefusal(answer.status, answer.body);
  }

  async function projects(req: Request): Promise<Response> {
    const body = await readBody(req, ["session"]);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    return Response.json({ projects: await ops.projects(principal.roles), until: await members.unlockedUntil(body.session) });
  }

  const startRestore = dependencies.startRestore;

  return {
    "/members/secrets/projects": { POST: projects },
    "/members/secrets/value": { POST: action({ operation: "read", power: "secrets.read", texts: VARIABLE, run: ops.readValue }) },
    "/members/secrets/variable": {
      PUT: action({ operation: "set", power: "secrets.write", texts: [...VARIABLE, "value"], run: ops.setVariable }),
      DELETE: action({ operation: "remove", power: "secrets.write", texts: VARIABLE, run: ops.removeVariable }),
    },
    "/members/secrets/file": { POST: action({ operation: "create", power: "secrets.write", texts: FILE, run: ops.createFile }) },
    "/members/secrets/restore": { POST: action({ operation: "restore", power: "secrets.restore", texts: FILE, run: ops.restoreFile }) },
    "/members/secrets/content": {
      POST: action({ operation: "read", power: "secrets.read", texts: FILE, run: ops.readContent }),
      PUT: action({ operation: "replace", power: "secrets.write", texts: [...FILE, "content"], max: dependencies.maxContentBytes, run: ops.replaceContent }),
    },
    "/members/portal": {
      POST: action({
        operation: "portal",
        power: "door",
        texts: ["slug", "confirmation"],
        others: ["active"],
        check: (body) => (typeof body.active === "boolean" ? null : fail("invalid", "active must be a boolean")),
        run: ops.portal,
      }),
    },
    "/members/backups/restore": {
      POST: action({
        operation: "backup.restore",
        power: "backups",
        texts: ["slug", "snapshot", "confirmation"],
        // The requester is this steward's to say: the email it verified.
        run: (req, body, who) => (startRestore === null ? Promise.resolve(fail("not-found", "backups are not set up on this server")) : startRestore(req, { ...body, actor: who.actor })),
      }),
    },
    "/members/sharing": { PUT: sharing },
    "/members/guests": { POST: createGuest, DELETE: revokeGuest },
  };
}
