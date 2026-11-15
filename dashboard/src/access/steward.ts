/**
 * The steward's access routes: the one registry of the guests of each
 * project (registry.ts), and the portal's projection, written after every
 * change.
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
 * **Begun empty, never in a request's way.** A machine with no registry
 * yet, a fresh one, begins it empty at the steward's start, written with its
 * projection. In the background (`start`), the steward's sockets open
 * meanwhile, and the access routes answer `not-ready` until it is done; an
 * attempt that fails is tried again, later and later.
 *
 * **Who asks: the owner alone.** Over SSH on the owner's socket, root, or in
 * the dashboard on its own, with the live unlock to give access, since a
 * password lets someone in. Removing someone never waits for an unlock. A
 * token never reaches these routes.
 *
 * **Bounded.** Every accepted change is kept 180 days in the access log
 * (src/secrets/log.ts), whose rows are never pushed out before that. A change
 * that lets more people in (`widen`) is counted per hour, the owner over SSH
 * generously, and refused when the log is full of rows younger than its
 * retention, the owner over SSH excepted: the way out when a flood filled
 * it. Removing someone is never refused for either: the rows it writes are
 * bounded by the ones that gave access before it.
 */
import { isValidSlug } from "../../borrowed/manifest";
import { cleanEmail } from "../../borrowed/email";
import { generatePassword } from "../password";
import { createQueue, errorName, type Body, type Handler, type Routes } from "../secrets/requests";
import { OWNER, type AccessResponse, type EntryResponse, type GeneralView } from "./protocol";
import {
  EMPTY_REGISTRY,
  encodeProjection,
  encodeRegistry,
  entryView,
  entryViews,
  entriesOf,
  findEntry,
  forgetProject as dropProject,
  renameProject as moveProject,
  projectionOf,
  putEntry,
  readRegistry,
  readsBack,
  readWho,
  removeEntry,
  type Registry,
} from "./registry";
import { projectRefusal, readDuration, type Machine } from "./rules";
import type { AccessSystem } from "./system";

/** What the journal records of access: the actor this steward verified, never one a request named. */
export type AccessEvent = {
  operation: "access.add" | "access.remove" | "project.remove" | "project.rename";
  result: "ok" | "rejects";
  actor: string;
  /** The guest the event is about, when it is an email. */
  member: string | null;
  slug?: string;
  detail: string | null;
};

const STATUSES: Record<string, number> = {
  invalid: 400,
  locked: 401,
  "out-of-scope": 403,
  "not-found": 404,
  "too-many-changes": 429,
  failure: 500,
  "not-ready": 503,
  "log-full": 507,
};

function fail(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: STATUSES[code] ?? 500 });
}

/** The steward's refusal of password access without the unlock: the dashboard turns it into the page's 423. */
export const PASSWORD_LOCKED = "locked: giving password access needs the unlock, since it lets someone in";

/** The answer while the registry does not read: no path, the steward's log says which file and why. */
const REGISTRY_UNREADABLE = "the access registry does not read on the machine: the owner must read the steward's log, journalctl -u sitesolide-steward";

/** The answer while a machine without a registry begins it. */
export const BEGINNING =
  "the access registry is being begun on the machine: try again in a minute; if it lasts, the owner reads journalctl -u sitesolide-steward";

/** The answer when the access log holds as many rows younger than 180 days as it keeps. */
export const LOG_FULL =
  "the access log is full of changes younger than 180 days, which are never pushed out: nobody more is let in until older ones age out, while removing still works; the owner may still change access from their workstation, with sitesolide share, and reads journalctl -u sitesolide-steward";

/** Accepted changes per hour that let someone in: the owner in the dashboard, and over SSH. */
export const CHANGES_PER_HOUR = 120;
export const OWNER_SSH_CHANGES_PER_HOUR = 2_000;

/** The first wait before an attempt to begin the registry that failed is tried again, and the longest. */
export const BEGIN_RETRY_MS = 5_000;
export const BEGIN_RETRY_MAX_MS = 10 * 60_000;

// --- the store ---------------------------------------------------------------------

export type AccessStoreDependencies = {
  system: AccessSystem;
  zone: string;
  /** The site's address, where the portal keeps its guests: `<slug>.<zone>`. Null for none. */
  hostOf: (slug: string) => string | null;
  /** Does the access log hold as many rows younger than its retention as it keeps? Absent: never. */
  logFull?: () => Promise<boolean>;
  /** The wait between two attempts to begin the registry; the tests hand their own. */
  sleep?: (ms: number) => Promise<void>;
};

export type AccessStore = {
  /** The steward's clock, the one every date of the registry is read by. */
  now: () => number;
  /** The registry as it stands; `not-ready` until it is begun; or the refusal to send back. */
  read: () => Promise<Registry | Response>;
  /**
   * A change, in the registry's queue: `task` reads the registry and gives
   * the next one, or a refusal. Both read back before anything is written;
   * the projection is written, then the registry, when it changed.
   */
  change: <T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>) => Promise<T | Response>;
  /** One attempt now: the registry begun empty if it is missing, the projection written again from it. True once both are there. */
  ensure: () => Promise<boolean>;
  /** The attempts in the background, later and later, until one succeeds; resolves then. */
  start: () => Promise<void>;
  /** Is the access log full of rows younger than its retention? */
  full: () => Promise<boolean>;
};

export function createAccessStore(dependencies: AccessStoreDependencies): AccessStore {
  const { system } = dependencies;
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
  const serially = createQueue();

  let projectionNoted: string | null = null;
  /** The registry's text whose entries of before were said: once per file, not once per read. */
  let leftOutSaid: string | null = null;
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
      return fail("invalid", "this change would leave who may open what in a state the machine could not read back: nothing was changed");
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
    if (read.leftOut > 0 && leftOutSaid !== text) {
      leftOutSaid = text;
      console.log(`access: access.json names ${read.leftOut} people, domains or creators from company sign-in, which nothing reads any more: they go at its next change (docs/upgrading.md)`);
    }
    return { registry: read.registry, text };
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

  /** A registry begun empty, written with its projection: what a machine without one starts from. */
  async function begin(): Promise<boolean> {
    const refused = await write(EMPTY_REGISTRY);
    if (refused !== null) return false;
    console.log("access: registry begun empty");
    return true;
  }

  /** The attempts running in the background, if any. */
  let running: Promise<void> | null = null;

  async function read(): Promise<Registry | Response> {
    const found = await readFile();
    if (found instanceof Response) return found;
    if (found === null) {
      // Never made, or deleted by hand while running: begun in the background.
      void start();
      return fail("not-ready", BEGINNING);
    }
    if (stale(found.text)) repair();
    return found.registry;
  }

  function change<T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>): Promise<T | Response> {
    return serially(async () => {
      const current = await readFile();
      if (current === null) {
        void start();
        return fail("not-ready", BEGINNING);
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
      return begin();
    });
  }

  function start(): Promise<void> {
    if (running !== null) return running;
    running = (async () => {
      let wait = BEGIN_RETRY_MS;
      for (;;) {
        let done = false;
        try {
          done = await ensure();
        } catch (e) {
          console.error(`access: registry not ready (${errorName(e)})`);
        }
        if (done) return;
        console.log(`access: the registry is tried again in ${Math.round(wait / 1000)} s`);
        await sleep(wait);
        wait = Math.min(wait * 2, BEGIN_RETRY_MAX_MS);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    now: () => system.now(),
    read,
    change,
    ensure,
    start,
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
  /** The project's general access as the machine carries it, null when it is not deployed. */
  general: (slug: string) => Promise<GeneralView | null>;
  /** What the portal says it reads its access from (portal.ts). */
  portalReading: () => Promise<AccessResponse["portal"]>;
  /** Is this the live unlock token of the owner's secrets routes? */
  isUnlocked: (token: unknown) => Promise<boolean>;
  /** The steward's body reader: bounded in size and in time, the expected fields and those alone. */
  readBody: (req: Request, fields: string[]) => Promise<Body | Response>;
  journal: (event: AccessEvent) => Promise<void>;
  /** Draws a password access's password; the tests hand their own. */
  drawPassword?: () => string;
  drawId?: () => string;
  /** Accepted changes per hour, in the dashboard and over SSH; the tests hand smaller ones. */
  changesPerHour?: number;
  ownerChangesPerHour?: number;
};

/** Where a request comes from: the owner's socket, or the dashboard's. */
export type Channel = "ssh" | "dashboard";

export type AccessRoutes = {
  /** The owner's socket, which only root opens. */
  owner: Routes;
  /** The dashboard's socket: the owner's session. */
  dashboard: Routes;
  /**
   * A change of access made elsewhere that lets more people in: a site made
   * public, opened with a code, given a new code (src/secrets/steward.ts).
   * Bounded as the registry's own changes are, the access log's room and the
   * hour, and counted; the owner over SSH generously, and past a full access
   * log. Null: go ahead.
   */
  widen: (channel: Channel) => Promise<Response | null>;
  /**
   * A project removed from the machine (src/control/steward.ts, over the
   * owner's socket): its guests go with it, journaled, so that a project
   * created later under that name starts from nobody. The number dropped,
   * or the refusal.
   */
  forgetProject: (slug: string, actor: string) => Promise<number | Response>;
  /** A project renamed on the machine: its guests moved to the new slug, journaled. The number moved, or the refusal. */
  renameProject: (from: string, to: string, actor: string) => Promise<number | Response>;
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
  const { store, readBody, journal } = dependencies;
  const drawPassword = dependencies.drawPassword ?? (() => generatePassword(undefined, 4));
  const drawId = dependencies.drawId ?? drawAccessId;
  const machine: Machine = { zone: dependencies.zone, exists: dependencies.projectExists };
  const now = () => store.now();
  const perHour = dependencies.changesPerHour ?? CHANGES_PER_HOUR;
  const ownerPerHour = dependencies.ownerChangesPerHour ?? OWNER_SSH_CHANGES_PER_HOUR;

  // --- bounds: per channel, and the access log's room --------------------------------

  /** The accepted changes of the hour, per channel: in memory, a restart forgets them. */
  const counted: Record<Channel, number[]> = { ssh: [], dashboard: [] };

  /** Has this channel used up its changes of the hour? */
  function exhausted(channel: Channel): boolean {
    counted[channel] = counted[channel].filter((at) => now() - at < HOUR_MS && at <= now());
    return counted[channel].length >= (channel === "ssh" ? ownerPerHour : perHour);
  }

  let fullSaidAt = 0;
  /** The refusal when the access log has no room left, said in the steward's log once an hour. */
  async function noRoom(): Promise<Response | null> {
    if (!(await store.full())) return null;
    if (now() - fullSaidAt >= HOUR_MS || now() < fullSaidAt) {
      fullSaidAt = now();
      console.error("access: ALERT the access log is full of changes younger than 180 days: nobody more is let in until older ones age out, but over the owner's socket");
    }
    return fail("log-full", LOG_FULL);
  }

  /**
   * A change that lets more people in: refused when the access log has no
   * room for it (the owner over SSH excepted, their way out) or when the
   * hour is used up; counted otherwise. A removal never comes here.
   */
  async function widen(channel: Channel): Promise<Response | null> {
    if (channel !== "ssh") {
      const room = await noRoom();
      if (room !== null) return room;
    }
    if (exhausted(channel)) return fail("too-many-changes", `${channel === "ssh" ? ownerPerHour : perHour} changes of access per hour at most: try again later`);
    counted[channel].push(now());
    return null;
  }

  function hostAndUrl(slug: string): { host: string; url: string } {
    const host = dependencies.hostOf(slug) ?? slug;
    return { host, url: `https://${host}/` };
  }

  /** The project's general access and guests. */
  async function list(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length !== 1) return fail("invalid", "name one project: ?slug=<slug>");
    const slug = wanted[0]!;
    const registry = await store.read();
    if (registry instanceof Response) return registry;
    const refusal = projectRefusal(slug, machine, entriesOf(registry, slug).length > 0);
    if (refusal !== null) return fail(refusal.code ?? "invalid", refusal.refusal);
    const body: AccessResponse = {
      slug,
      ...hostAndUrl(slug),
      general: await dependencies.general(slug),
      entries: entryViews(entriesOf(registry, slug), now()),
      portal: await dependencies.portalReading(),
    };
    return Response.json(body);
  }

  const refuse = async (slug: string, whoValue: unknown, code: string, message: string): Promise<Response> => {
    await journal({ operation: "access.add", result: "rejects", actor: OWNER, member: typeof whoValue === "string" ? cleanEmail(whoValue) : null, slug, detail: message.slice(0, 150) });
    return fail(code, message);
  };

  /**
   * A password access given, the password drawn and shown once. Asked again
   * for the same guest, it keeps the one they hold: nothing is drawn, nobody
   * let in who was not. `unlocked` is asked only for someone new.
   */
  async function grant(channel: Channel, slugValue: unknown, whoValue: unknown, roleValue: unknown, expiresValue: unknown, unlocked: () => Promise<boolean>): Promise<Response> {
    if (typeof slugValue !== "string" || !isValidSlug(slugValue)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    const slug = slugValue;
    // A command of before names the role it gives: Can open, the one a guest holds, is still read.
    if (roleValue !== undefined && roleValue !== "visitor") return fail("invalid", "role: a guest opens the site and nothing more, the one access given here");
    const duration = readDuration(expiresValue);
    if (typeof duration === "object" && duration !== null) return fail("invalid", duration.refusal);
    return store.change<Response>(async (registry) => {
      const who = readWho(whoValue);
      if (typeof who === "object") return refuse(slug, whoValue, who.code ?? "invalid", who.refusal);
      const existing = findEntry(registry, slug, who);
      const project = projectRefusal(slug, machine, existing !== null);
      if (project !== null) return refuse(slug, whoValue, project.code ?? "invalid", project.refusal);
      if (existing !== null) {
        const body: EntryResponse = { slug, entry: entryView(existing, now()), change: "none" };
        return { registry, value: Response.json(body) };
      }
      if (!(await unlocked())) return fail("locked", PASSWORD_LOCKED);
      const refused = await widen(channel);
      if (refused !== null) return refused;
      const at = now();
      const password = drawPassword();
      const put = putEntry(registry, slug, who, OWNER, at, () => ({ id: drawId(), hash: passwordHash(password), expiresAt: duration === null ? null : at + (duration as number) * 1000 }));
      if ("refusal" in put) return refuse(slug, whoValue, put.code ?? "invalid", put.refusal);
      await journal({ operation: "access.add", result: "ok", actor: OWNER, member: who, slug, detail: `${who}: password access ${untilText(put.entry.password.expiresAt)}` });
      console.log(`access: ${who} given password access to ${slug}`);
      const body: EntryResponse = { slug, entry: entryView(put.entry, at), change: "add", password };
      return { registry: put.registry, value: Response.json(body, { status: 201 }) };
    });
  }

  /** A guest taken away: never counted nor refused for the log's room. */
  async function remove(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug", "who"]);
    if (body instanceof Response) return body;
    if (typeof body.slug !== "string" || !isValidSlug(body.slug)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    const slug = body.slug;
    return store.change<Response>(async (registry) => {
      // A name carried over from before the registry is matched as it stands.
      const read = readWho(body.who);
      const key = typeof read === "string" ? read : typeof body.who === "string" ? body.who.trim() : "";
      const removed = key === "" ? null : removeEntry(registry, slug, key);
      if (removed === null || "refusal" in removed) return fail("not-found", `${key === "" ? "who" : key} has no access to ${slug}`);
      await journal({ operation: "access.remove", result: "ok", actor: OWNER, member: cleanEmail(removed.entry.who), slug, detail: `${removed.entry.who}: password access` });
      console.log(`access: ${removed.entry.who} removed from ${slug}`);
      const answer: EntryResponse = { slug, entry: entryView(removed.entry, now()), change: "remove" };
      return { registry: removed.registry, value: Response.json(answer) };
    });
  }

  /** `asRoot`: the owner's socket, which only root opens, needs no unlock token. */
  function ownerGrant(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["slug", "who", "role", "expiresInS"] : ["token", "slug", "who", "expiresInS"]);
      if (body instanceof Response) return body;
      return grant(asRoot ? "ssh" : "dashboard", body.slug, body.who, body.role, body.expiresInS, async () => asRoot || (await dependencies.isUnlocked(body.token)));
    };
  }

  // --- a project removed or renamed ----------------------------------------------------

  async function forgetProject(slug: string, actor: string): Promise<number | Response> {
    if (!isValidSlug(slug)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    return store.change<number>(async (registry) => {
      const result = dropProject(registry, slug);
      if (result.dropped.length === 0) return { registry, value: 0 };
      await journal({
        operation: "project.remove",
        result: "ok",
        actor,
        member: null,
        slug,
        detail: `removed from the machine, its guests dropped: ${result.dropped.map((entry) => entry.who).join(", ")}`,
      });
      console.log(`access: ${slug} removed, ${result.dropped.length} entr${result.dropped.length === 1 ? "y" : "ies"} dropped`);
      return { registry: result.registry, value: result.dropped.length };
    });
  }

  /**
   * A project renamed on the machine (src/installer/rename.ts): its guests
   * open it under the new name, journaled once, under the old name with the
   * new one in the detail. Returns how many entries moved.
   */
  async function renameProject(from: string, to: string, actor: string): Promise<number | Response> {
    if (!isValidSlug(from) || !isValidSlug(to)) return fail("invalid", "slug: a project's slug, lowercase letters, digits and dashes");
    return store.change<number>(async (registry) => {
      const result = moveProject(registry, from, to);
      await journal({ operation: "project.rename", result: "ok", actor, member: null, slug: from, detail: `renamed ${to}${result.moved === 0 ? "" : `, its ${result.moved} guest${result.moved === 1 ? "" : "s"} kept`}` });
      console.log(`access: ${from} renamed ${to}, ${result.moved} entr${result.moved === 1 ? "y" : "ies"} moved`);
      return { registry: result.registry, value: result.moved };
    });
  }

  return {
    owner: {
      "/access": { GET: list },
      "/access/entry": { PUT: ownerGrant(true), DELETE: remove },
    },
    dashboard: {
      "/access": { GET: list },
      "/access/entry": { PUT: ownerGrant(false), DELETE: remove },
    },
    widen,
    forgetProject,
    renameProject,
  };
}
