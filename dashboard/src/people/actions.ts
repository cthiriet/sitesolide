/**
 * A person's work on their projects, judged by the steward: their secrets,
 * the project's general access, and the restore of a backup. Each route
 * asks, in the order of the risk:
 *
 *   the body's shape, the person's session, their own unlock where the
 *   power needs one, the role on that project (powers.ts), the machine's own
 *   projects and files refused, then the operation, under the steward's lock,
 *   where the session, the unlock and the role are asked again.
 *
 * **The operations are the owner's, with the person as actor.** Writing a
 * variable, reading one, changing general access, starting a restore: the
 * very code of src/secrets/steward.ts and src/backup/routes.ts, handed over
 * here with `who`, the email this steward verified, which its journal and
 * the backups' audit record. A Developer is the same code with nothing read
 * back: the listing hides every value, size and previous version from them,
 * and a read is refused before any file is opened.
 *
 * Their people with access are the access routes' (src/access/steward.ts).
 *
 * The routes, on the dashboard's socket:
 *
 *   POST   /people/secrets/projects  { session }                                      -> MemberProjectsResponse
 *   POST   /people/secrets/value     { session, token, slug, file, variable }         -> ValueResponse     Admin
 *   PUT    /people/secrets/variable  { session, token, slug, file, variable, value }  -> FileResponse      Developer
 *   DELETE /people/secrets/variable  { session, token, slug, file, variable }         -> FileResponse      Developer
 *   POST   /people/secrets/file      { session, token, slug, file }                   -> FileResponse      Developer
 *   POST   /people/secrets/restore   { session, token, slug, file }                   -> FileResponse      Admin
 *   POST   /people/secrets/content   { session, token, slug, file }                   -> ContentResponse   Admin
 *   PUT    /people/secrets/content   { session, token, slug, file, content }          -> FileResponse      Developer
 *   POST   /people/portal            { session, token?, slug, active, confirmation }  -> PortalResponse    Admin, the unlock to make it public
 *   POST   /people/general           { session, token?, slug, access, renew?, confirmation } -> GeneralResponse  Admin, the unlock but to restrict
 *   POST   /people/backups/restore   { session, token, slug, snapshot, confirmation } -> 202 RestoreResponse  Admin
 */
import type { ProjectView } from "../secrets/protocol";
import { generalNeedsUnlock, machineRefusal, may, needsUnlock, powerRefusal, roleDetail, type Power } from "./powers";
import type { Role, Roles } from "./protocol";
import type { MemberPrincipal, MemberRoutes, RestartRefusal } from "./steward";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/**
 * Who the steward acts for: the email it verified, as the journal writes it.
 * `readsBack`: a member whose role reads values back, an Admin; a
 * Developer's answers show every file write-only.
 */
export type Who = { actor: string; member: string | null; readsBack?: boolean };

/** The owner's operations, taken with the member as `who`. They run under the steward's lock. */
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
  /** General access, any of the three, or a new code: `access`, `renew`, `confirmation`. */
  general: (req: Request, body: Body, who: Who) => Promise<Response>;
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

const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
    /** Whether this request asks for the unlock, read from its body; absent, the power says (`needsUnlock`). */
    unlockFor?: (body: Body) => boolean;
    run: (req: Request, body: Body, who: Who) => Promise<Response>;
  };

  /** One operation on a project's secrets, general access or data, under the lock, judged twice. */
  function action(spec: Spec): Handler {
    const always = needsUnlock(spec.power);
    const fields = [...spec.texts, ...(spec.others ?? [])];
    return async (req) => {
      const body = await readBody(req, ["session", ...(always || spec.unlockFor !== undefined ? ["token"] : []), ...fields], spec.max);
      if (body instanceof Response) return body;
      for (const field of spec.texts) if (typeof body[field] !== "string") return fail("invalid", `${field} must be a string`);
      const shape = spec.check?.(body) ?? null;
      if (shape !== null) return shape;
      const unlock = spec.unlockFor === undefined ? always : spec.unlockFor(body);
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

  async function projects(req: Request): Promise<Response> {
    const body = await readBody(req, ["session"]);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    return Response.json({ projects: await ops.projects(principal.roles), until: await members.unlockedUntil(body.session) });
  }

  const startRestore = dependencies.startRestore;

  return {
    "/people/secrets/projects": { POST: projects },
    "/people/secrets/value": { POST: action({ operation: "read", power: "secrets.read", texts: VARIABLE, run: ops.readValue }) },
    "/people/secrets/variable": {
      PUT: action({ operation: "set", power: "secrets.write", texts: [...VARIABLE, "value"], run: ops.setVariable }),
      DELETE: action({ operation: "remove", power: "secrets.write", texts: VARIABLE, run: ops.removeVariable }),
    },
    "/people/secrets/file": { POST: action({ operation: "create", power: "secrets.write", texts: FILE, run: ops.createFile }) },
    "/people/secrets/restore": { POST: action({ operation: "restore", power: "secrets.restore", texts: FILE, run: ops.restoreFile }) },
    "/people/secrets/content": {
      POST: action({ operation: "read", power: "secrets.read", texts: FILE, run: ops.readContent }),
      PUT: action({ operation: "replace", power: "secrets.write", texts: [...FILE, "content"], max: dependencies.maxContentBytes, run: ops.replaceContent }),
    },
    "/people/portal": {
      POST: action({
        operation: "portal",
        power: "general",
        texts: ["slug", "confirmation"],
        others: ["active"],
        check: (body) => (typeof body.active === "boolean" ? null : fail("invalid", "active must be a boolean")),
        // Restricting a site needs no unlock; making it public does.
        unlockFor: (body) => generalNeedsUnlock(body.active === true ? "restricted" : "public"),
        run: ops.portal,
      }),
    },
    "/people/general": {
      POST: action({
        operation: "portal",
        power: "general",
        texts: ["slug", "confirmation"],
        others: ["access", "renew"],
        check: (body) =>
          body.access !== "public" && body.access !== "restricted" && body.access !== "code"
            ? fail("invalid", "access: public, restricted or code")
            : body.renew !== undefined && typeof body.renew !== "boolean"
              ? fail("invalid", "renew must be a boolean")
              : null,
        // Restricting a site needs no unlock; making it public, opening it
        // with a code and a new code do.
        unlockFor: (body) => generalNeedsUnlock(body.access as "public" | "restricted" | "code"),
        run: ops.general,
      }),
    },
    "/people/backups/restore": {
      POST: action({
        operation: "backup.restore",
        power: "backups",
        texts: ["slug", "snapshot", "confirmation"],
        // The requester is this steward's to say: the email it verified.
        run: (req, body, who) => (startRestore === null ? Promise.resolve(fail("not-found", "backups are not set up on this server")) : startRestore(req, { ...body, actor: who.actor })),
      }),
    },
  };
}
