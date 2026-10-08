/**
 * The steward's access routes: the one registry of who may do what on each
 * project (registry.ts), the rules of who may change it (rules.ts), and the
 * portal's projection, written after every change.
 *
 * **One queue, the registry's.** Every change reads the registry, judges,
 * writes the portal's projection, then the registry, one at a time: two
 * changes read side by side would each write a registry without the other's.
 * Before either is written, both are encoded and read back by the very
 * functions that will read them (`readsBack`): a change that would leave a
 * registry the steward could not read again, or a projection the portal
 * could not, is refused, and nothing is written. The projection goes first:
 * a change the portal cannot be told of is no change, and the registry stays
 * as it was; a registry write that fails after it leaves a projection a step
 * ahead, which the next read notices and writes again from the registry.
 *
 * **The projection repairs itself.** Every read compares the registry with
 * the one the projection was last written from, and the projection's file
 * with the one written: a registry edited or repaired by hand, a projection
 * deleted or edited, and it is written again, in the queue.
 *
 * **The migration, once, never in a request's way.** At the first start on
 * this code there is no registry yet: it is made from `members.json` and the
 * portal's database (migrate.ts), written with its projection, journaled, and
 * never made again; the old stores are left as they were, read-only. It runs
 * in the background (`start`), the steward's sockets open meanwhile, and the
 * access routes answer `migrating` until it is done. One that cannot be read
 * is tried again, later and later, and nothing is guessed at: guessing at who
 * may do what is the one thing not to do. When the portal's database is the
 * one that does not read, the owner may carry the rest over without it
 * (`migrateWithoutPortal`), which the registry's migration record says.
 *
 * **Who asks.** The owner, over SSH on the owner's socket, or in the
 * dashboard on its own, with the live unlock for what raises someone above
 * Can open, gives password access or a whole domain while the company's
 * domains are not listed; an Admin of the project, through their session,
 * their unlock for the same; a token, through the control routes, Can open
 * alone, never password access. Removing and lowering someone never wait for
 * an unlock. Someone who no longer has a role above Can open anywhere, nor
 * the create right, no longer signs in to the dashboard: their sessions close
 * and their tokens are revoked (`leave`), once the change is written and the
 * registry's queue left (see the queues in src/people/steward.ts).
 *
 * **What reads, what changes.** Anyone with Viewer or above on a project
 * reads its people with access, and the admin emails (`OIDC_ADMIN_EMAILS`),
 * who open it too; only its Admins and the owner change them, and they alone
 * read who a removal would take out of the dashboard (`leaving`). A token
 * reads neither the admin emails nor who would leave.
 *
 * **Bounded.** Every accepted change is kept 180 days in the access log
 * (src/secrets/log.ts), whose rows are never pushed out before that. A change
 * that lets more people in, or more done (`widen`), is counted per actor and
 * per hour, the owner over SSH generously, and refused when the log is full
 * of rows younger than its retention, the owner over SSH excepted: the way
 * out when a flood filled it. A change that narrows, removing, lowering,
 * taking the create right back, is never refused for either: the rows it
 * writes are bounded by the widening ones that came before it.
 */
import { atLeast, isRole, rank, type Role } from "../../borrowed/access";
import { isValidSlug } from "../../borrowed/manifest";
import { cleanEmail } from "../../borrowed/sharing";
import { generatePassword } from "../password";
import type { MemberPrincipal } from "../people/steward";
import { reportText, migrate, readMembersFile } from "./migrate";
import {
  MAX_DASHBOARD_PEOPLE,
  OWNER,
  type AccessResponse,
  type EntryResponse,
  type GeneralView,
  type LeavingToken,
  type Left,
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
  forgetProject as dropProject,
  dashboardPeople,
  isDashboardPerson,
  kindOf,
  peopleViews,
  projectionOf,
  putEntry,
  readRegistry,
  readsBack,
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
  operation: "access.add" | "access.change" | "access.remove" | "access.migrate" | "people.create" | "project.create" | "project.remove";
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
  conflict: 409,
  "too-many-changes": 429,
  failure: 500,
  "not-ready": 503,
  migrating: 503,
  "log-full": 507,
};

function fail(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: STATUSES[code] ?? 500 });
}

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

/** The steward's refusal of password access without the unlock: the dashboard turns it into the page's 423. */
export const PASSWORD_LOCKED = "locked: giving password access needs the unlock, since it lets someone from outside the company in";

/** The answer while the registry does not read: no path, the steward's log says which file and why. */
const REGISTRY_UNREADABLE = "the access registry does not read on the machine: the owner must read the steward's log, journalctl -u sitesolide-steward";

/** The answer while the registry is being made from the stores before it. */
export const MIGRATING =
  "who may do what is being carried over from the stores before the access registry: try again in a minute; if it lasts, the owner reads journalctl -u sitesolide-steward";

/** The answer when the access log holds as many rows younger than 180 days as it keeps. */
export const LOG_FULL =
  "the access log is full of changes younger than 180 days, which are never pushed out: nobody more is let in until older ones age out, while removing and lowering still work; the owner may still change access from their workstation, with sitesolide share and sitesolide people, and reads journalctl -u sitesolide-steward";

/** Accepted changes per actor and per hour: a person, a token, the owner in the dashboard; and the owner over SSH. */
export const CHANGES_PER_HOUR = 120;
export const OWNER_SSH_CHANGES_PER_HOUR = 2_000;

/** The first wait before a migration that failed is tried again, and the longest. */
export const MIGRATION_RETRY_MS = 5_000;
export const MIGRATION_RETRY_MAX_MS = 10 * 60_000;

// --- the store ---------------------------------------------------------------------

export type AccessStoreDependencies = {
  system: AccessSystem;
  zone: string;
  /** The site's address, where the portal keeps its people: `<slug>.<zone>`. Null for none. */
  hostOf: (slug: string) => string | null;
  journal: (event: AccessEvent) => Promise<void>;
  /** Is the access log full of rows younger than its retention? Absent: never. */
  logFull?: () => Promise<boolean>;
  /** The wait between two migration attempts; the tests hand their own. */
  sleep?: (ms: number) => Promise<void>;
};

export type AccessStore = {
  /** The steward's clock, the one every date of the registry is read by. */
  now: () => number;
  /** The registry as it stands; `migrating` until it is made; or the refusal to send back. */
  read: () => Promise<Registry | Response>;
  /**
   * A change, in the registry's queue: `task` reads the registry and gives
   * the next one, or a refusal. Both read back before anything is written;
   * the projection is written, then the registry, when it changed.
   */
  change: <T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>) => Promise<T | Response>;
  /** One attempt now: the registry made if it is missing, the projection written again from it. True once both are there. */
  ensure: () => Promise<boolean>;
  /** The attempts in the background, later and later, until one succeeds; resolves then. */
  start: () => Promise<void>;
  /** The owner's way out when the portal's database does not read: the registry made without it. */
  migrateWithoutPortal: () => Promise<Response>;
  /** Is the access log full of rows younger than its retention? */
  full: () => Promise<boolean>;
};

export function createAccessStore(dependencies: AccessStoreDependencies): AccessStore {
  const { system, journal } = dependencies;
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));

  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  let projectionNoted: string | null = null;
  /** What the projection was last written from, and its file as written: a read that finds either moved writes it again. */
  let projected: { from: string; stamp: string | null } | null = null;
  /** When the projection was last tried while it could not be written: a portal deployed since gets it within the minute. */
  let triedAt = 0;

  /** The portal's projection laid; its folder or group missing is said once, and changes nothing else. */
  async function project(registry: Registry, from: string): Promise<void> {
    triedAt = system.now();
    const written = await system.writeProjection(encodeProjection(projectionOf(registry, dependencies.hostOf, system.now())));
    if (written !== "written" && projectionNoted !== written) {
      console.log(
        written === "no-folder"
          ? "access: /etc/sitesolide-portal is missing, the portal is not told who may open a site: run sitesolide upgrade"
          : "access: the portal is not deployed on this machine (no site-portal group): no projection to write",
      );
    }
    projectionNoted = written === "written" ? null : written;
    projected = written === "written" ? { from, stamp: system.projectionStamp() } : null;
  }

  /** Both files, the projection first, once both have read back. A refusal when either would not. */
  async function write(registry: Registry): Promise<Response | null> {
    const unreadable = readsBack(registry, projectionOf(registry, dependencies.hostOf, system.now()));
    if (unreadable !== null) {
      console.error(`access: a change refused before anything was written, it would not read back (${unreadable})`);
      return fail("invalid", "this change would leave who may do what in a state the machine could not read back: nothing was changed");
    }
    const text = encodeRegistry(registry);
    await project(registry, text);
    await system.writeRegistry(text);
    return null;
  }

  /** The registry's file and its text, null when there is none yet. */
  async function readFile(): Promise<{ registry: Registry; text: string } | null | Response> {
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
    return { registry: read, text };
  }

  /** Has the projection fallen behind the registry, or been touched since it was written? */
  function stale(text: string): boolean {
    if (projectionNoted !== null) return system.now() - triedAt > 60_000;
    return projected === null || projected.from !== text || projected.stamp !== system.projectionStamp();
  }

  /** A repair waiting in the queue: a burst of reads queues one, not one each. */
  let repairing = false;

  /** Written again from the registry, in the queue, once the queue reaches it; a failure is said and left for the next read. */
  function repair(): void {
    if (repairing) return;
    repairing = true;
    void serially(async () => {
      const found = await readFile();
      if (found === null || found instanceof Response || !stale(found.text)) return;
      await project(found.registry, found.text);
      console.log("access: the portal's projection written again from the registry");
    })
      .catch((e) => {
        triedAt = system.now();
        console.error(`access: projection not written (${errorName(e)})`);
      })
      .finally(() => {
        repairing = false;
      });
  }

  /** The registry made from the stores before it, written with its projection; a refusal when one does not read. */
  async function migrateNow(withoutPortal: boolean): Promise<Registry | Response> {
    let membersText: string | null;
    try {
      membersText = await system.readLegacyMembers();
    } catch (e) {
      console.error(`access: members.json unreadable (${errorName(e)}), nothing carried over yet`);
      return fail("failure", "the registry before this one, members.json, does not read: the owner must read the steward's log");
    }
    const members = readMembersFile(membersText);
    if ("unreadable" in members) {
      console.error(`access: ${members.unreadable}, nothing carried over yet`);
      return fail("failure", "the registry before this one, members.json, does not read: the owner must read the steward's log");
    }
    const portal = withoutPortal ? ({ kind: "absent" } as const) : await system.readPortalDatabase();
    if (portal.kind === "unreadable") {
      console.error(`access: the portal's database does not read (${portal.reason}), nothing carried over yet, tried again later`);
      return fail("failure", `who could open which site, from the portal's database, could not be carried over yet (${portal.reason}): the steward tries again; the owner may carry the rest over without it, sitesolide people --migrate-without-portal`);
    }
    const made =
      membersText === null && portal.kind === "absent" && !withoutPortal
        ? { registry: { ...EMPTY_REGISTRY, migration: { at: system.now(), from: [], setAside: [] } }, report: null }
        : migrate(members, portal.kind === "read" ? portal.rows : null, dependencies.zone, system.now(), { withoutPortal });
    const refused = await write(made.registry);
    if (refused !== null) return refused;
    if (made.report !== null) {
      const line = reportText(made.report);
      await journal({ operation: "access.migrate", result: "ok", actor: withoutPortal ? OWNER : "system", member: null, detail: withoutPortal ? `${line}, without the portal's database` : line });
      console.log(`access: registry made from ${made.registry.migration?.from.join(" and ") || "nothing"}${withoutPortal ? ", without the portal's database, at the owner's request" : ""}: ${line}`);
    } else {
      console.log("access: registry begun empty, nothing before it");
    }
    return made.registry;
  }

  /** The attempts running in the background, if any. */
  let running: Promise<void> | null = null;
  /** Cuts the attempts' wait short: a registry the owner made meanwhile is taken up at once. */
  let wake: (() => void) | null = null;

  function pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      wake = resolve;
      void sleep(ms).then(resolve);
    }).finally(() => {
      wake = null;
    });
  }

  async function read(): Promise<Registry | Response> {
    const found = await readFile();
    if (found instanceof Response) return found;
    if (found === null) {
      // Deleted by hand while running, or never made: made in the background,
      // from the stores before it.
      void start();
      return fail("migrating", MIGRATING);
    }
    if (stale(found.text)) repair();
    return found.registry;
  }

  function change<T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>): Promise<T | Response> {
    return serially(async () => {
      const current = await readFile();
      if (current === null) {
        void start();
        return fail("migrating", MIGRATING);
      }
      if (current instanceof Response) return current;
      const out = await task(current.registry);
      if (out instanceof Response) return out;
      if (out.registry !== current.registry) {
        const refused = await write(out.registry);
        if (refused !== null) return refused;
      }
      return out.value;
    });
  }

  async function ensure(): Promise<boolean> {
    return serially(async () => {
      const found = await readFile();
      if (found instanceof Response) return false;
      if (found !== null) {
        // Written again from the registry: a projection left a step ahead,
        // or edited by hand, is set right before the portal is asked anything.
        await project(found.registry, found.text);
        return true;
      }
      return !((await migrateNow(false)) instanceof Response);
    });
  }

  function start(): Promise<void> {
    if (running !== null) return running;
    running = (async () => {
      let wait = MIGRATION_RETRY_MS;
      for (;;) {
        let done = false;
        try {
          done = await ensure();
        } catch (e) {
          console.error(`access: registry not ready (${errorName(e)})`);
        }
        if (done) return;
        console.log(`access: the registry is tried again in ${Math.round(wait / 1000)} s`);
        await pause(wait);
        wait = Math.min(wait * 2, MIGRATION_RETRY_MAX_MS);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function migrateWithoutPortal(): Promise<Response> {
    return serially(async () => {
      const found = await readFile();
      if (found instanceof Response) return found;
      if (found !== null) return fail("conflict", "the access registry is already made: there is nothing left to carry over");
      const migrated = await migrateNow(true);
      if (migrated instanceof Response) return migrated;
      // The attempts in the background find it at once, and what waits on
      // them, the tokens made someone's, goes on now rather than minutes later.
      wake?.();
      return Response.json({ migration: migrated.migration, people: dashboardPeople(migrated).length, projects: Object.keys(migrated.projects).length });
    });
  }

  return {
    now: () => system.now(),
    read,
    change,
    ensure,
    start,
    migrateWithoutPortal,
    full: async () => (dependencies.logFull === undefined ? false : dependencies.logFull()),
  };
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
  /** What the portal says it reads its access from (src/people/portal.ts). */
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
   * Someone who may no longer sign in to the dashboard: their sessions
   * closed, their tokens revoked, under `actor`, unless the registry gives
   * them a role again by the time it runs. Called once the registry is
   * written and its queue left. The tokens revoked; null when they stayed.
   */
  leave: (email: string, actor: string) => Promise<LeavingToken[] | null>;
  /** A person's live tokens, what their leaving would revoke; absent, none are named. */
  tokensOf?: (email: string) => Promise<LeavingToken[]>;
  /** Draws a password access's password; the tests hand their own. */
  drawPassword?: () => string;
  drawId?: () => string;
  /** Accepted changes per actor and per hour, and the owner's over SSH; the tests hand smaller ones. */
  changesPerHour?: number;
  ownerChangesPerHour?: number;
};

/** Where a request comes from: the owner's socket, the dashboard's, a token through the control routes. */
type Channel = "ssh" | "dashboard" | "token";

export type AccessRoutes = {
  /** The owner's socket, which only root opens. */
  owner: Routes;
  /** The dashboard's socket: the owner's session, and a person's. */
  dashboard: Routes;
  /** What a token's routes ask (src/control/steward.ts), the token judged by them. */
  forToken: {
    /** The token's person, Viewer or above on the project, or the owner's token. */
    list: (slug: string, granter: Granter) => Promise<Response>;
    grant: (slug: string, who: unknown, role: unknown, granter: Granter) => Promise<Response>;
    remove: (slug: string, who: unknown, granter: Granter) => Promise<Response>;
    /** A project a person's token is about to create, `actor` their email: `widen`, for a token. */
    widen: (actor: string) => Promise<Response | null>;
  };
  /**
   * A change of access made elsewhere that lets more people in: a site made
   * public, opened with a code, given a new code (src/secrets/steward.ts).
   * Bounded as the registry's own changes are, the access log's room and the
   * actor's hour, and counted; the owner over SSH generously, and past a full
   * access log. Null: go ahead.
   */
  widen: (channel: "dashboard" | "token" | "ssh", actor: string) => Promise<Response | null>;
  /**
   * A project removed from the machine (src/control/steward.ts, over the
   * owner's socket): its entries go with it, journaled, so that a project
   * created later under that name starts from nobody. The number dropped,
   * or the refusal.
   */
  forgetProject: (slug: string, actor: string) => Promise<number | Response>;
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

const HOUR_MS = 3_600_000;

export function createAccessRoutes(dependencies: AccessRoutesDependencies): AccessRoutes {
  const { store, readBody, journal, journalRefusal } = dependencies;
  const drawPassword = dependencies.drawPassword ?? (() => generatePassword(undefined, 4));
  const drawId = dependencies.drawId ?? drawAccessId;
  const machine: Machine = { zone: dependencies.zone, exists: dependencies.projectExists };
  const now = () => store.now();
  const perHour = dependencies.changesPerHour ?? CHANGES_PER_HOUR;
  const ownerPerHour = dependencies.ownerChangesPerHour ?? OWNER_SSH_CHANGES_PER_HOUR;

  // --- bounds: per actor, and the access log's room ---------------------------------

  /** The accepted changes of the hour, per actor and channel: in memory, a restart forgets them. */
  const counted = new Map<string, number[]>();

  function bucket(channel: Channel, actor: string): string {
    return `${channel === "ssh" ? "ssh" : "other"}:${actor}`;
  }

  /** Has this actor used up their changes of the hour? */
  function exhausted(channel: Channel, actor: string): boolean {
    const key = bucket(channel, actor);
    const recent = (counted.get(key) ?? []).filter((at) => now() - at < HOUR_MS && at <= now());
    if (recent.length === 0) counted.delete(key);
    else counted.set(key, recent);
    return recent.length >= (channel === "ssh" ? ownerPerHour : perHour);
  }

  function count(channel: Channel, actor: string): void {
    const key = bucket(channel, actor);
    counted.set(key, [...(counted.get(key) ?? []), now()]);
    // A map that keeps only actors seen this hour.
    if (counted.size > 10_000) for (const old of [...counted.keys()].slice(0, 1_000)) counted.delete(old);
  }

  function tooMany(channel: Channel): Response {
    return fail("too-many-changes", `${channel === "ssh" ? ownerPerHour : perHour} changes of access per hour at most: try again later`);
  }

  let fullSaidAt = 0;
  /** The refusal when the access log has no room left; said in the steward's log once an hour. */
  async function noRoom(): Promise<Response | null> {
    if (!(await store.full())) return null;
    if (now() - fullSaidAt >= HOUR_MS || now() < fullSaidAt) {
      fullSaidAt = now();
      console.error("access: ALERT the access log is full of changes younger than 180 days: nobody more is let in until older ones age out, but over the owner's socket");
    }
    return fail("log-full", LOG_FULL);
  }

  /**
   * A change that lets more people in, or more done: refused when the access
   * log has no room for it (the owner over SSH excepted, their way out) or
   * when its actor has used up their hour; counted otherwise. A narrowing
   * change never comes here.
   */
  async function widen(channel: Channel, actor: string): Promise<Response | null> {
    if (channel !== "ssh") {
      const room = await noRoom();
      if (room !== null) return room;
    }
    if (exhausted(channel, actor)) return tooMany(channel);
    count(channel, actor);
    return null;
  }

  /**
   * Someone the change took out of the dashboard leaves it, once the change is
   * written and the registry's queue left: a change refused, before or at its
   * writing, takes nobody out. The answer then says so, with the tokens
   * revoked, which the CLI prints.
   */
  async function afterwards(answer: Response, leaving: { email: string; actor: string } | null): Promise<Response> {
    if (leaving === null || answer.status >= 400) return answer;
    const tokens = await dependencies.leave(leaving.email, leaving.actor);
    if (tokens === null) return answer;
    const left: Left = { who: leaving.email, tokens };
    return Response.json({ ...((await answer.json()) as object), left }, { status: answer.status });
  }

  function hostAndUrl(slug: string): { host: string; url: string } {
    const host = dependencies.hostOf(slug) ?? slug;
    return { host, url: `https://${host}/` };
  }

  /**
   * By who, the people whom removing from this project, or lowering to Can
   * open, takes out of the dashboard, and their live tokens.
   */
  async function leavingOf(registry: Registry, slug: string): Promise<Record<string, LeavingToken[]>> {
    const leaving: Record<string, LeavingToken[]> = {};
    for (const entry of entriesOf(registry, slug)) {
      const email = emailOf(entry);
      if (email === null || entry.role === "visitor" || !isDashboardPerson(registry, email)) continue;
      const without = removeEntry(registry, slug, entry.who);
      if ("refusal" in without || isDashboardPerson(without.registry, email)) continue;
      leaving[entry.who] = (await dependencies.tokensOf?.(email)) ?? [];
    }
    return leaving;
  }

  /**
   * The project's general access and people, and the admin emails, who open
   * it too; who would leave the dashboard, for those who may change the list.
   */
  async function listResponse(slug: string, reader: "owner" | "manager" | "reader" | "token"): Promise<Response> {
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const refusal = projectRefusal(slug, machine, entriesOf(registry, slug).length > 0);
    if (refusal !== null) return fail(refusal.code ?? "invalid", refusal.refusal);
    const signIn = await dependencies.signIn();
    const body: AccessResponse = {
      slug,
      ...hostAndUrl(slug),
      general: await dependencies.general(slug),
      entries: entryViews(entriesOf(registry, slug), now()),
      signIn: reader === "token" ? { ...signIn, admins: [] } : signIn,
      portal: await dependencies.portalReading(),
      leaving: reader === "owner" || reader === "manager" ? await leavingOf(registry, slug) : {},
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
   * waited gives nothing. `unlocked` is asked only when the change needs
   * it (`Grant.unlock`).
   */
  async function grant(
    channel: Channel,
    slugValue: unknown,
    whoValue: unknown,
    roleValue: unknown,
    expiresValue: unknown,
    granterNow: (registry: Registry) => Promise<Granter | Response>,
    unlocked: () => Promise<boolean>,
  ): Promise<Response> {
    if (typeof slugValue !== "string" || !isValidSlug(slugValue)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
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
      if (judged.unlock && !(await unlocked())) {
        return fail(
          "locked",
          judged.password
            ? PASSWORD_LOCKED
            : judged.who.kind === "domain"
              ? "locked: giving a whole domain access needs the unlock while the company's domains are not listed on this machine"
              : "locked: giving someone a role above Can open needs the unlock",
        );
      }
      if (atLeast(role, "viewer") && !isDashboardPerson(registry, judged.who.who) && dashboardPeople(registry).length >= MAX_DASHBOARD_PEOPLE) {
        return fail("invalid", `${MAX_DASHBOARD_PEOPLE} people sign in to the dashboard at most: take someone who left off first`);
      }
      const at = now();
      const keeps = judged.existing !== null && judged.existing.role === role;
      // Lowering lets nobody further in: never refused for the log's room, nor counted.
      const lowers = judged.existing !== null && rank(role) < rank(judged.existing.role);
      if (!keeps && !lowers) {
        const refused = await widen(channel, actor);
        if (refused !== null) return refused;
      }
      let password: string | undefined;
      let record: { id: string; hash: string; expiresAt: number | null } | undefined;
      if (judged.password) {
        password = drawPassword();
        record = { id: drawId(), hash: passwordHash(password), expiresAt: duration === null ? null : at + (duration as number) * 1000 };
      }
      const before = dashboardBefore(registry, judged.existing);
      const put = putEntry(registry, slug, judged.who.who, role, actor, at, record);
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
      const body: EntryResponse = { slug, entry: entryView(put.entry, at), change: put.change, ...(password === undefined ? {} : { password }) };
      return { registry: put.registry, value: Response.json(body, { status: put.change === "add" ? 201 : 200 }) };
    });
    return afterwards(answer, leaving);
  }

  async function remove(channel: Channel, slugValue: unknown, whoValue: unknown, granterNow: (registry: Registry) => Promise<Granter | Response>): Promise<Response> {
    if (typeof slugValue !== "string" || !isValidSlug(slugValue)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
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
      const body: EntryResponse = { slug, entry: entryView(removed.entry, now()), change: "remove" };
      return { registry: removed.registry, value: Response.json(body) };
    });
    return afterwards(answer, leaving);
  }

  // --- the owner ---------------------------------------------------------------------

  const owner: Granter = { kind: "owner" };
  const asOwner = async () => owner;

  function ownerList(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length !== 1) return Promise.resolve(fail("invalid", "name one project: ?slug=<slug>"));
    return listResponse(wanted[0]!, "owner");
  }

  /** `asRoot`: the owner's socket, which only root opens, needs no unlock token, password access included. */
  function ownerGrant(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["slug", "who", "role", "expiresInS"] : ["token", "slug", "who", "role", "expiresInS"]);
      if (body instanceof Response) return body;
      return grant(asRoot ? "ssh" : "dashboard", body.slug, body.who, body.role, body.expiresInS, asOwner, async () => asRoot || (await dependencies.isUnlocked(body.token)));
    };
  }

  function ownerRemove(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, ["slug", "who"]);
      if (body instanceof Response) return body;
      return remove(asRoot ? "ssh" : "dashboard", body.slug, body.who, asOwner);
    };
  }

  async function people(): Promise<Response> {
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const signIn = await dependencies.signIn();
    const body: PeopleResponse = { ...peopleViews(registry, signIn.admins, now()), signIn };
    return Response.json(body);
  }

  function personView(registry: Registry, email: string, admins: readonly string[]) {
    return peopleViews(registry, admins, now()).people.find((one) => one.who === email) ?? { who: email, roles: {}, create: false, passwords: [], admin: admins.includes(email) };
  }

  function putPerson(asRoot: boolean): Handler {
    const channel: Channel = asRoot ? "ssh" : "dashboard";
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
        const set = setCreate(registry, email, create, OWNER, now());
        if ("refusal" in set) return fail(set.code ?? "invalid", set.refusal);
        if (set.change) {
          // Taking the right back narrows: never refused for the log's room, nor counted.
          if (create) {
            const refused = await widen(channel, OWNER);
            if (refused !== null) return refused;
          }
          await journal({ operation: "people.create", result: "ok", actor: OWNER, member: email, detail: create ? `${email}: may create projects` : `${email}: may no longer create projects` });
          console.log(`access: ${email} ${create ? "may" : "may no longer"} create projects`);
          if (!create && isDashboardPerson(registry, email) && !isDashboardPerson(set.registry, email)) leaving = true;
        }
        const response: PersonResponse = { person: personView(set.registry, email, signIn.admins), change: set.change ? "create" : "none" };
        return { registry: set.registry, value: Response.json(response) };
      });
      return afterwards(answer, leaving ? { email, actor: OWNER } : null);
    };
  }

  function removePersonRoute(): Handler {
    return async (req) => {
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
      return afterwards(answer, leaving ? { email, actor: OWNER } : null);
    };
  }

  /** The owner's way out, over the owner's socket alone: the registry made without the portal's database. */
  async function migrateWithoutPortal(req: Request): Promise<Response> {
    const body = await readBody(req, ["withoutPortal"]);
    if (body instanceof Response) return body;
    if (body.withoutPortal !== true) return fail("invalid", "withoutPortal: true, the portal's database left out of the migration");
    return store.migrateWithoutPortal();
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
    if (typeof body.slug !== "string" || !isValidSlug(body.slug)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const role = findEntry(registry, body.slug, principal.email)?.role ?? null;
    if (!atLeast(role, "viewer")) return fail("out-of-scope", `People with access to ${body.slug} are read from Viewer up: ${principal.email} holds no such role there`);
    return listResponse(body.slug, role === "admin" ? "manager" : "reader");
  }

  async function personGrant(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "token", "slug", "who", "role", "expiresInS"]);
    if (body instanceof Response) return body;
    return grant("dashboard", body.slug, body.who, body.role, body.expiresInS, asPerson(body.session, body.slug), async () => {
      if (body.token === undefined) return false;
      return !((await dependencies.authorize(body.session, body.token)) instanceof Response);
    });
  }

  async function personRemove(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug", "who"]);
    if (body instanceof Response) return body;
    return remove("dashboard", body.slug, body.who, asPerson(body.session, body.slug));
  }

  // --- a project removed ---------------------------------------------------------------

  async function forgetProject(slug: string, actor: string): Promise<number | Response> {
    if (!isValidSlug(slug)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    const leaving: string[] = [];
    const answer = await store.change<number>(async (registry) => {
      const result = dropProject(registry, slug);
      if (result.dropped.length === 0) return { registry, value: 0 };
      for (const entry of result.dropped) {
        const email = emailOf(entry);
        if (email !== null && isDashboardPerson(registry, email) && !isDashboardPerson(result.registry, email)) leaving.push(email);
      }
      await journal({
        operation: "project.remove",
        result: "ok",
        actor,
        member: null,
        slug,
        detail: `removed from the machine, its people with access dropped: ${result.dropped.map((entry) => `${entry.who} (${roleWord(entry.role)})`).join(", ")}`,
      });
      console.log(`access: ${slug} removed, ${result.dropped.length} entr${result.dropped.length === 1 ? "y" : "ies"} dropped`);
      return { registry: result.registry, value: result.dropped.length };
    });
    if (!(answer instanceof Response)) for (const email of leaving) await dependencies.leave(email, actor);
    return answer;
  }

  /** A token's granter, its person's role on the project read from the registry in hand. */
  function asToken(granter: Granter, slug: string): (registry: Registry) => Promise<Granter> {
    return async (registry) => (granter.kind === "token" && granter.email !== null ? { ...granter, role: findEntry(registry, slug, granter.email)?.role ?? null } : granter);
  }

  return {
    owner: {
      "/access": { GET: ownerList },
      "/access/entry": { PUT: ownerGrant(true), DELETE: ownerRemove(true) },
      "/access/migrate": { POST: migrateWithoutPortal },
      "/people": { GET: people },
      "/people/person": { PUT: putPerson(true), DELETE: removePersonRoute() },
    },
    dashboard: {
      "/access": { GET: ownerList },
      "/access/entry": { PUT: ownerGrant(false), DELETE: ownerRemove(false) },
      "/people": { GET: people },
      "/people/person": { PUT: putPerson(false), DELETE: removePersonRoute() },
      "/access/person/list": { POST: personList },
      "/access/person/entry": { PUT: personGrant, DELETE: personRemove },
    },
    forToken: {
      async list(slug, granter) {
        // A person's token reads them while that person is Viewer or above there.
        if (granter.kind === "token" && granter.email !== null) {
          const registry = await store.read();
          if (registry instanceof Response) return registry;
          const role = findEntry(registry, slug, granter.email)?.role ?? null;
          if (!atLeast(role, "viewer")) return fail("out-of-scope", `People with access to ${slug} are read from Viewer up: ${granter.email} holds no such role there`);
        }
        return listResponse(slug, "token");
      },
      grant: (slug, who, role, granter) => grant("token", slug, who, role, undefined, asToken(granter, slug), async () => false),
      remove: (slug, who, granter) => remove("token", slug, who, asToken(granter, slug)),
      widen: (actor) => widen("token", actor),
    },
    widen,
    forgetProject,
  };
}
