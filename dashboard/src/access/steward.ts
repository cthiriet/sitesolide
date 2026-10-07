/**
 * The steward's access routes: the one registry of who may do what on each
 * project (registry.ts), the rules of who may change it (rules.ts), and the
 * portal's projection, written after every change.
 *
 * **One queue, the registry's.** Every change reads the registry, judges,
 * writes the portal's projection, then the registry, one at a time: two
 * changes read side by side would each write a registry without the other's.
 * The projection goes first: a change the portal cannot be told of is no
 * change, and the registry stays as it was; a registry write that fails after
 * it leaves a projection a step ahead, which the next change or the next
 * start writes again from the registry.
 *
 * **The migration, once.** At the first start on this code there is no
 * registry yet: it is made from `members.json` and the portal's database
 * (migrate.ts), written with its projection, journaled, and never made again;
 * the old stores are left as they were, read-only. One that cannot be read
 * leaves no registry, every person refused, and is tried again at the next
 * request and the next start: guessing at who may do what is the one thing
 * not to do.
 *
 * **Who asks.** The owner, over SSH on the owner's socket, or in the
 * dashboard on its own, with the live unlock for what raises someone above
 * Can open; an admin of the project, through their session, their unlock for
 * the same; a token, through the control routes, Can open alone. Removing
 * or lowering someone never waits for an unlock. Someone who no longer has a
 * role above Can open anywhere, nor the create right, no longer signs in to
 * the dashboard: their sessions close and their tokens are revoked (`leave`),
 * outside this queue, as a person removed's always were.
 */
import { atLeast, isRole, type Role } from "../../borrowed/access";
import { cleanEmail } from "../../borrowed/sharing";
import { generatePassword } from "../password";
import type { MemberPrincipal } from "../members/steward";
import { reportText, migrate, readMembersFile } from "./migrate";
import {
  MAX_DASHBOARD_PEOPLE,
  OWNER,
  type AccessResponse,
  type EntryResponse,
  type GeneralView,
  type PeopleResponse,
  type PersonResponse,
  type SignInSettings,
} from "./protocol";
import {
  EMPTY_REGISTRY,
  encodeProjection,
  encodeRegistry,
  entryView,
  entryViews,
  emailOf,
  entriesOf,
  findEntry,
  dashboardPeople,
  isDashboardPerson,
  kindOf,
  peopleViews,
  projectionOf,
  putEntry,
  readRegistry,
  removeEntry,
  removePerson,
  rolesText,
  setCreate,
  type Entry,
  type Registry,
} from "./registry";
import { granterName, judgeGrant, judgeRemoval, projectRefusal, readDuration, roleWord, signsInWithAccount, type Granter, type Machine } from "./rules";
import type { AccessSystem } from "./system";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/** What the journal records of access: the actor this steward verified, never one a request named. */
export type AccessEvent = {
  operation: "access.add" | "access.change" | "access.remove" | "access.migrate" | "people.create";
  result: "ok" | "rejects";
  actor: string;
  /** The person the event is about, when it is an email. */
  member: string | null;
  slug?: string;
  detail: string | null;
};

const STATUSES: Record<string, number> = {
  invalid: 400,
  locked: 401,
  "signed-out": 401,
  "out-of-scope": 403,
  "not-found": 404,
  failure: 500,
  "not-ready": 503,
};

function fail(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: STATUSES[code] ?? 500 });
}

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

const REGISTRY_UNREADABLE = "the access registry does not read on the machine: the owner must check /var/lib/sitesolide-steward/access.json";

// --- the store ---------------------------------------------------------------------

export type AccessStoreDependencies = {
  system: AccessSystem;
  zone: string;
  /** The site's address, where the portal keeps its people: `<slug>.<zone>`. Null for none. */
  hostOf: (slug: string) => string | null;
  journal: (event: AccessEvent) => Promise<void>;
};

export type AccessStore = {
  /** The registry as it stands, made from the stores before it the first time; or the refusal to send back. */
  read: () => Promise<Registry | Response>;
  /**
   * A change, in the registry's queue: `task` reads the registry and gives
   * the next one, or a refusal. The projection is written, then the registry,
   * when it changed.
   */
  change: <T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>) => Promise<T | Response>;
  /** At startup: the registry made if it is missing, the projection written again from it. */
  ensure: () => Promise<void>;
};

export function createAccessStore(dependencies: AccessStoreDependencies): AccessStore {
  const { system, journal } = dependencies;

  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  let projectionNoted: string | null = null;
  /** The portal's projection laid; its folder or group missing is said once, and changes nothing else. */
  async function project(registry: Registry): Promise<void> {
    const written = await system.writeProjection(encodeProjection(projectionOf(registry, dependencies.hostOf, system.now())));
    if (written !== "written" && projectionNoted !== written) {
      console.log(
        written === "no-folder"
          ? "access: /etc/sitesolide-portal is missing, the portal is not told who may open a site: run sitesolide upgrade"
          : "access: the portal is not deployed on this machine (no site-portal group): no projection to write",
      );
    }
    projectionNoted = written === "written" ? null : written;
  }

  async function write(registry: Registry): Promise<void> {
    await project(registry);
    await system.writeRegistry(encodeRegistry(registry));
  }

  /** The registry's file, null when there is none yet. */
  async function readFile(): Promise<Registry | null | Response> {
    let text: string | null;
    try {
      text = await system.readRegistry();
    } catch (e) {
      console.error(`access: access.json unreadable (${errorName(e)})`);
      return fail("failure", REGISTRY_UNREADABLE);
    }
    if (text === null) return null;
    const read = readRegistry(text);
    if ("unreadable" in read) {
      console.error(`access: ${read.unreadable}`);
      return fail("failure", REGISTRY_UNREADABLE);
    }
    return read;
  }

  /** The registry made from the stores before it, written with its projection; a refusal when one does not read. */
  async function migrateNow(): Promise<Registry | Response> {
    const again = await readFile();
    if (again !== null) return again;
    let membersText: string | null;
    try {
      membersText = await system.readLegacyMembers();
    } catch (e) {
      console.error(`access: members.json unreadable (${errorName(e)}), nothing carried over yet`);
      return fail("failure", "the registry before this one, members.json, does not read: the owner must check /var/lib/sitesolide-steward/members.json");
    }
    const members = readMembersFile(membersText);
    if ("unreadable" in members) {
      console.error(`access: ${members.unreadable}, nothing carried over yet`);
      return fail("failure", `${members.unreadable}: the owner must check /var/lib/sitesolide-steward/members.json`);
    }
    const portal = await system.readPortalDatabase();
    if (portal.kind === "unreadable") {
      console.error(`access: the portal's database does not read (${portal.reason}), nothing carried over yet, tried again at the next request`);
      return fail("failure", `who could open which site, from the portal's database, could not be carried over yet (${portal.reason}): the steward tries again at the next request`);
    }
    const made = membersText === null && portal.kind === "absent"
      ? { registry: { ...EMPTY_REGISTRY, migration: { at: system.now(), from: [], setAside: [] } }, report: null }
      : migrate(members, portal.kind === "read" ? portal.rows : null, dependencies.zone, system.now());
    await write(made.registry);
    if (made.report !== null) {
      const line = reportText(made.report);
      await journal({ operation: "access.migrate", result: "ok", actor: "system", member: null, detail: line });
      console.log(`access: registry made from ${made.registry.migration?.from.join(" and ")}: ${line}`);
    } else {
      console.log("access: registry begun empty, nothing before it");
    }
    return made.registry;
  }

  /** Whether a registry is known to exist: once it does, reads skip the queue. */
  let made = false;
  /** When the projection was last tried while it could not be written: a portal deployed since gets it within the minute. */
  let triedAt = 0;

  async function read(): Promise<Registry | Response> {
    if (made) {
      const found = await readFile();
      if (found !== null && !(found instanceof Response) && projectionNoted !== null && system.now() - triedAt > 60_000) {
        triedAt = system.now();
        void serially(() => project(found)).catch((e) => console.error(`access: projection not written (${errorName(e)})`));
      }
      if (found !== null) return found;
      // Deleted by hand while running: made again, from the stores before it.
      made = false;
    }
    const found = await serially(async () => {
      const existing = await readFile();
      return existing !== null ? existing : migrateNow();
    });
    if (!(found instanceof Response)) made = true;
    return found;
  }

  function change<T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>): Promise<T | Response> {
    return serially(async () => {
      let current = await readFile();
      if (current === null) current = await migrateNow();
      if (current instanceof Response) return current;
      made = true;
      const out = await task(current);
      if (out instanceof Response) return out;
      if (out.registry !== current) await write(out.registry);
      return out.value;
    });
  }

  async function ensure(): Promise<void> {
    const found = await read();
    if (found instanceof Response) return;
    // Written again from the registry: a projection left a step ahead, or
    // edited by hand, is set right before the portal is asked anything.
    await serially(() => project(found));
  }

  return { read, change, ensure };
}

// --- the routes --------------------------------------------------------------------

export type AccessRoutesDependencies = {
  store: AccessStore;
  zone: string;
  /** The site's address, for the answers. */
  hostOf: (slug: string) => string | null;
  /** Does the machine carry `/srv/sites/<slug>`? */
  projectExists: (slug: string) => boolean;
  /** What portal.env says of signing in. */
  signIn: () => Promise<SignInSettings>;
  /** The project's general access as the machine carries it, null when it is not deployed. */
  general: (slug: string) => Promise<GeneralView | null>;
  /** What the portal says it reads its access from (src/members/portal.ts). */
  portalReading: () => Promise<AccessResponse["portal"]>;
  /** Is this the live unlock token of the owner's secrets routes? */
  isUnlocked: (token: unknown) => Promise<boolean>;
  /** The steward's body reader: bounded in size and in time, the expected fields and those alone. */
  readBody: (req: Request, fields: string[]) => Promise<Body | Response>;
  journal: (event: AccessEvent) => Promise<void>;
  /** A refusal, bounded per minute so that a flood cannot push the journal's history out. */
  journalRefusal: (event: AccessEvent) => Promise<void>;
  /** A person's session, and their unlock when `unlock` is not null; or the refusal. */
  authorize: (session: unknown, unlock: unknown | null) => Promise<MemberPrincipal | Response>;
  /**
   * Someone who no longer signs in to the dashboard: their sessions closed,
   * their tokens revoked, under `actor`. Called once the registry is written
   * and its queue left.
   */
  leave: (email: string, actor: string) => Promise<void>;
  /** Draws a password access's password; the tests hand their own. */
  drawPassword?: () => string;
  drawId?: () => string;
};

export type AccessRoutes = {
  /** The owner's socket, which only root opens. */
  owner: Routes;
  /** The dashboard's socket: the owner's session, and a person's. */
  dashboard: Routes;
  /** What a token's routes ask (src/control/steward.ts), the token judged by them. */
  forToken: {
    /** The token's person, an Admin of the project, or the owner's token. */
    list: (slug: string, granter: Granter) => Promise<Response>;
    grant: (slug: string, who: unknown, role: unknown, granter: Granter) => Promise<Response>;
    remove: (slug: string, who: unknown, granter: Granter) => Promise<Response>;
  };
};

/** The hash a password access is found by: SHA-256 of the password, as the portal computes it. */
export function passwordHash(password: string): string {
  return new Bun.CryptoHasher("sha256").update(password).digest("hex");
}

function drawAccessId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
}

/** An expiry as the journal says it. */
function untilText(expiresAt: number | null): string {
  return expiresAt === null ? "no expiry" : `until ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const SLUG_SHAPE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

export function createAccessRoutes(dependencies: AccessRoutesDependencies): AccessRoutes {
  const { store, readBody, journal, journalRefusal } = dependencies;
  const drawPassword = dependencies.drawPassword ?? (() => generatePassword(undefined, 4));
  const drawId = dependencies.drawId ?? drawAccessId;
  const machine: Machine = { zone: dependencies.zone, exists: dependencies.projectExists };

  function hostAndUrl(slug: string): { host: string; url: string } {
    const host = dependencies.hostOf(slug) ?? slug;
    return { host, url: `https://${host}/` };
  }

  async function listResponse(slug: string): Promise<Response> {
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const refusal = projectRefusal(slug, machine, entriesOf(registry, slug).length > 0);
    if (refusal !== null) return fail(refusal.code ?? "invalid", refusal.refusal);
    const body: AccessResponse = {
      slug,
      ...hostAndUrl(slug),
      general: await dependencies.general(slug),
      entries: entryViews(entriesOf(registry, slug), Date.now()),
      signIn: await dependencies.signIn(),
      portal: await dependencies.portalReading(),
    };
    return Response.json(body);
  }

  /** The person an entry names, when that is an email and they signed in to the dashboard before a change. */
  function dashboardBefore(registry: Registry, entry: Entry | null): string | null {
    const email = entry === null ? null : emailOf(entry);
    return email !== null && isDashboardPerson(registry, email) ? email : null;
  }

  /**
   * An entry given or changed. `granterNow` reads the granter again from the
   * registry once the turn has come: an admin lowered while the request
   * waited gives nothing. `unlocked` is asked only when the change raises
   * someone above Can open.
   */
  async function grant(
    slugValue: unknown,
    whoValue: unknown,
    roleValue: unknown,
    expiresValue: unknown,
    granterNow: (registry: Registry) => Promise<Granter | Response>,
    unlocked: () => Promise<boolean>,
  ): Promise<Response> {
    if (typeof slugValue !== "string" || !SLUG_SHAPE.test(slugValue)) return fail("invalid", "slug: a project's slug");
    const slug = slugValue;
    if (!isRole(roleValue)) return fail("invalid", "role: visitor (Can open), viewer, developer or admin");
    const role: Role = roleValue;
    const duration = readDuration(expiresValue);
    if (typeof duration === "object" && duration !== null) return fail("invalid", duration.refusal);
    const signIn = await dependencies.signIn();
    let leaving: { email: string; actor: string } | null = null;
    const answer = await store.change<Response>(async (registry) => {
      const granter = await granterNow(registry);
      if (granter instanceof Response) return granter;
      const actor = granterName(granter);
      const refuse = async (code: string, message: string): Promise<Response> => {
        await journalRefusal({ operation: "access.add", result: "rejects", actor, member: typeof whoValue === "string" ? cleanEmail(whoValue) : null, slug, detail: message.slice(0, 150) });
        return fail(code, message);
      };
      const project = projectRefusal(slug, machine, typeof whoValue === "string" && findEntry(registry, slug, whoValue.trim().toLowerCase()) !== null);
      if (project !== null) return refuse(project.code ?? "invalid", project.refusal);
      const judged = judgeGrant(registry, slug, whoValue, role, granter, signIn);
      if ("refusal" in judged) return refuse(judged.code ?? "invalid", judged.refusal);
      if (judged.raises && !(await unlocked())) return fail("locked", "locked: giving someone a role above Can open needs the unlock");
      if (atLeast(role, "viewer") && !isDashboardPerson(registry, judged.who.who) && dashboardPeople(registry).length >= MAX_DASHBOARD_PEOPLE) {
        return fail("invalid", `${MAX_DASHBOARD_PEOPLE} people sign in to the dashboard at most: take someone who left off first`);
      }
      let password: string | undefined;
      let record: { id: string; hash: string; expiresAt: number | null } | undefined;
      const now = Date.now();
      if (judged.password) {
        password = drawPassword();
        record = { id: drawId(), hash: passwordHash(password), expiresAt: duration === null ? null : now + (duration as number) * 1000 };
      }
      const before = dashboardBefore(registry, judged.existing);
      const put = putEntry(registry, slug, judged.who.who, role, actor, now, record);
      if ("refusal" in put) return refuse(put.code ?? "invalid", put.refusal);
      if (put.change !== "none") {
        const email = emailOf(put.entry);
        await journal({
          operation: put.change === "add" ? "access.add" : "access.change",
          result: "ok",
          actor,
          member: email,
          slug,
          detail:
            put.change === "add"
              ? `${put.entry.who}: ${roleWord(role)}${record === undefined ? "" : `, password access ${untilText(record.expiresAt)}`}`
              : `${put.entry.who}: ${roleWord(judged.existing!.role)} -> ${roleWord(role)}`,
        });
        console.log(`access: ${put.entry.who} ${put.change === "add" ? "given" : "changed to"} ${role} on ${slug} by ${actor}`);
      }
      if (before !== null && !isDashboardPerson(put.registry, before)) leaving = { email: before, actor };
      const body: EntryResponse = { slug, entry: entryView(put.entry, now), change: put.change, ...(password === undefined ? {} : { password }) };
      return { registry: put.registry, value: Response.json(body, { status: put.change === "add" ? 201 : 200 }) };
    });
    const left = leaving as { email: string; actor: string } | null;
    if (left !== null) await dependencies.leave(left.email, left.actor);
    return answer;
  }

  async function remove(slugValue: unknown, whoValue: unknown, granterNow: (registry: Registry) => Promise<Granter | Response>): Promise<Response> {
    if (typeof slugValue !== "string" || !SLUG_SHAPE.test(slugValue)) return fail("invalid", "slug: a project's slug");
    const slug = slugValue;
    let leaving: { email: string; actor: string } | null = null;
    const answer = await store.change<Response>(async (registry) => {
      const granter = await granterNow(registry);
      if (granter instanceof Response) return granter;
      const actor = granterName(granter);
      const judged = judgeRemoval(registry, slug, whoValue, granter);
      if ("refusal" in judged) {
        if (judged.code !== "not-found") {
          await journalRefusal({ operation: "access.remove", result: "rejects", actor, member: typeof whoValue === "string" ? cleanEmail(whoValue) : null, slug, detail: judged.refusal.slice(0, 150) });
        }
        return fail(judged.code ?? "invalid", judged.refusal);
      }
      const before = dashboardBefore(registry, judged.entry);
      const removed = removeEntry(registry, slug, judged.entry.who);
      if ("refusal" in removed) return fail(removed.code ?? "invalid", removed.refusal);
      await journal({ operation: "access.remove", result: "ok", actor, member: emailOf(removed.entry), slug, detail: `${removed.entry.who}: was ${roleWord(removed.entry.role)}${kindOf(removed.entry) === "password" ? ", password access" : ""}` });
      console.log(`access: ${removed.entry.who} removed from ${slug} by ${actor}`);
      if (before !== null && !isDashboardPerson(removed.registry, before)) leaving = { email: before, actor };
      const body: EntryResponse = { slug, entry: entryView(removed.entry, Date.now()), change: "remove" };
      return { registry: removed.registry, value: Response.json(body) };
    });
    const left = leaving as { email: string; actor: string } | null;
    if (left !== null) await dependencies.leave(left.email, left.actor);
    return answer;
  }

  // --- the owner ---------------------------------------------------------------------

  const owner: Granter = { kind: "owner" };
  const asOwner = async () => owner;

  function ownerList(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length !== 1) return Promise.resolve(fail("invalid", "name one project: ?slug=<slug>"));
    return listResponse(wanted[0]!);
  }

  /** `asRoot`: the owner's socket, which only root opens, needs no unlock token. */
  function ownerGrant(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["slug", "who", "role", "expiresInS"] : ["token", "slug", "who", "role", "expiresInS"]);
      if (body instanceof Response) return body;
      return grant(body.slug, body.who, body.role, body.expiresInS, asOwner, async () => asRoot || (await dependencies.isUnlocked(body.token)));
    };
  }

  async function ownerRemove(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug", "who"]);
    if (body instanceof Response) return body;
    return remove(body.slug, body.who, asOwner);
  }

  async function people(): Promise<Response> {
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const signIn = await dependencies.signIn();
    const body: PeopleResponse = { ...peopleViews(registry, signIn.admins, Date.now()), signIn };
    return Response.json(body);
  }

  function personView(registry: Registry, email: string, admins: readonly string[]) {
    return peopleViews(registry, admins, Date.now()).people.find((one) => one.who === email) ?? { who: email, roles: {}, create: false, passwords: [], admin: admins.includes(email) };
  }

  function putPerson(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["email", "create"] : ["token", "email", "create"]);
      if (body instanceof Response) return body;
      const email = cleanEmail(body.email);
      if (email === null) return fail("invalid", "email: an address, like alice@acme.com");
      if (typeof body.create !== "boolean") return fail("invalid", "create: true or false");
      const create = body.create;
      const signIn = await dependencies.signIn();
      if (create && !signsInWithAccount(email, signIn)) {
        return fail("invalid", `${email} cannot sign in to the dashboard: ${signIn.configured ? `the company's domains are ${signIn.allowedDomains.join(", ")}` : "signing in with a company account is not set up on this machine"}`);
      }
      if (create && !asRoot && !(await dependencies.isUnlocked(body.token))) return fail("locked", "locked: letting someone create projects needs the unlock");
      let leaving = false;
      const answer = await store.change<Response>(async (registry) => {
        const set = setCreate(registry, email, create, OWNER, Date.now());
        if ("refusal" in set) return fail(set.code ?? "invalid", set.refusal);
        if (set.change) {
          await journal({ operation: "people.create", result: "ok", actor: OWNER, member: email, detail: create ? `${email}: may create projects` : `${email}: may no longer create projects` });
          console.log(`access: ${email} ${create ? "may" : "may no longer"} create projects`);
          if (!create && isDashboardPerson(registry, email) && !isDashboardPerson(set.registry, email)) leaving = true;
        }
        const response: PersonResponse = { person: personView(set.registry, email, signIn.admins), change: set.change ? "create" : "none" };
        return { registry: set.registry, value: Response.json(response) };
      });
      if (leaving) await dependencies.leave(email, OWNER);
      return answer;
    };
  }

  async function removePersonRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["email"]);
    if (body instanceof Response) return body;
    const email = cleanEmail(body.email);
    if (email === null) return fail("invalid", "email: the address of the person to take off");
    const signIn = await dependencies.signIn();
    let leaving = false;
    const answer = await store.change<Response>(async (registry) => {
      const was = personView(registry, email, signIn.admins);
      const result = removePerson(registry, email);
      if (result.removed.length === 0 && !result.create) return fail("not-found", `${email} has no access to any project`);
      leaving = isDashboardPerson(registry, email);
      const roles = Object.fromEntries(result.removed.map(({ slug, entry }) => [slug, entry.role]));
      await journal({ operation: "access.remove", result: "ok", actor: OWNER, member: email, detail: `${email}: taken off everywhere, ${rolesText(roles)}${result.create ? "; may create projects" : ""}` });
      console.log(`access: ${email} taken off every project`);
      const response: PersonResponse = { person: was, change: "remove" };
      return { registry: result.registry, value: Response.json(response) };
    });
    if (leaving) await dependencies.leave(email, OWNER);
    return answer;
  }

  // --- a person, through their session -------------------------------------------------

  /** The granter for a slug: the person's own role there, read from the registry in hand. */
  function asPerson(session: unknown, slug: unknown): (registry: Registry) => Promise<Granter | Response> {
    return async (registry) => {
      const principal = await dependencies.authorize(session, null);
      if (principal instanceof Response) return principal;
      const role = typeof slug === "string" ? findEntry(registry, slug, principal.email)?.role ?? null : null;
      return { kind: "admin", email: principal.email, role };
    };
  }

  async function personList(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug"]);
    if (body instanceof Response) return body;
    const principal = await dependencies.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    if (typeof body.slug !== "string" || !SLUG_SHAPE.test(body.slug)) return fail("invalid", "slug: a project's slug");
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const role = findEntry(registry, body.slug, principal.email)?.role ?? null;
    if (!atLeast(role, "admin")) return fail("out-of-scope", `People with access to ${body.slug} are its Admin's to see`);
    return listResponse(body.slug);
  }

  async function personGrant(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "token", "slug", "who", "role", "expiresInS"]);
    if (body instanceof Response) return body;
    return grant(body.slug, body.who, body.role, body.expiresInS, asPerson(body.session, body.slug), async () => {
      if (body.token === undefined) return false;
      return !((await dependencies.authorize(body.session, body.token)) instanceof Response);
    });
  }

  async function personRemove(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug", "who"]);
    if (body instanceof Response) return body;
    return remove(body.slug, body.who, asPerson(body.session, body.slug));
  }

  return {
    owner: {
      "/access": { GET: ownerList },
      "/access/entry": { PUT: ownerGrant(true), DELETE: ownerRemove },
      "/people": { GET: people },
      "/people/person": { PUT: putPerson(true), DELETE: removePersonRoute },
    },
    dashboard: {
      "/access": { GET: ownerList },
      "/access/entry": { PUT: ownerGrant(false), DELETE: ownerRemove },
      "/people": { GET: people },
      "/people/person": { PUT: putPerson(false), DELETE: removePersonRoute },
      "/access/person/list": { POST: personList },
      "/access/person/entry": { PUT: personGrant, DELETE: personRemove },
    },
    forToken: {
      async list(slug, granter) {
        // People with access are their Admin's to see: a person's token reads
        // them only while that person is an Admin of the project.
        if (granter.kind === "token" && granter.email !== null) {
          const registry = await store.read();
          if (registry instanceof Response) return registry;
          const role = findEntry(registry, slug, granter.email)?.role ?? null;
          if (!atLeast(role, "admin")) return fail("out-of-scope", `People with access to ${slug} are its Admin's to see: ${granter.email} is not its Admin`);
        }
        return listResponse(slug);
      },
      grant: (slug, who, role, granter) => grant(slug, who, role, undefined, async (registry) => (granter.kind === "token" && granter.email !== null ? { ...granter, role: findEntry(registry, slug, granter.email)?.role ?? null } : granter), async () => false),
      remove: (slug, who, granter) => remove(slug, who, async (registry) => (granter.kind === "token" && granter.email !== null ? { ...granter, role: findEntry(registry, slug, granter.email)?.role ?? null } : granter)),
    },
  };
}
