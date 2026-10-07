/**
 * The steward's member routes: the registry, the key pair, and the member
 * sessions, mounted beside the secrets routes on the dashboard's socket, and
 * the registry alone on the owner's socket, which only root opens.
 *
 * **The steward decides every write.** A member session opens only on an
 * assertion the portal signed (portal/src/assertion.ts), checked here with the
 * public key this steward keeps, for the dashboard, unexpired, its nonce never
 * seen, for an email the registry names. A member's write carries their
 * session, which this steward drew, and is judged against the registry as it
 * reads at that moment: the role, the project, the member still there. The
 * actor of the journal is the email this steward verified, never one a request
 * names. A compromised dashboard can therefore act only for the members whose
 * sessions pass through it, within their roles; it can neither make a member
 * nor widen one.
 *
 * **Inviting asks for the unlock** on the dashboard's socket, the same ten
 * minutes as creating a token: a member can restart services. Removing does
 * not, as revoking a token does not: closing someone out must never wait for
 * the password, and the worst a compromised dashboard does with it is remove
 * everyone. On the owner's socket, root asks, over the owner's SSH: no unlock.
 *
 * **A member unlocks for themselves.** Not with a password, which they do
 * not have: with an assertion the portal signed after a forced sign-in at the
 * provider (`reauth`, `auth_time` within five minutes), for the very email
 * their session is. The token is theirs, for that session, ten minutes, and
 * neither replaces the super admin's nor is replaced by it (unlocks.ts).
 * `authorize` is what every other member route asks: the session, the member
 * still in the registry, and their unlock when the power needs one.
 *
 * **A Project admin invites on their project**, and nowhere else: one role,
 * at most their own, on a project where they are Project admin, under their
 * unlock; taking a role away needs no unlock, as for the super admin.
 *
 * **The create right is the super admin's to grant**, per member, beside
 * their roles. A member's own tokens (src/control/steward.ts) ask this file
 * for the member's rights at every use, and for the project one of them
 * creates, which makes the member its Project admin. A member removed takes
 * their tokens with them: `revokeTokens`, once the registry is written.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, credential, registry, machine, writing.
 */
import {
  DASHBOARD_AUDIENCE,
  encodeKey,
  generateKeyPair,
  readPrivateKey,
  readPublicKey,
  samePair,
  verifyAssertion,
  type PublicKey,
} from "../../borrowed/assertion";
import type { RandomSource } from "../sessions";
import {
  MAX_AUTH_AGE_S,
  OWNER_ACTOR,
  REAUTH_MAX_AGE_S,
  type KeyResponse,
  type MemberIdentity,
  type MemberUnlockResponse,
  type MemberView,
  type MembersResponse,
  type ProjectMemberResponse,
  type PutMemberResponse,
  type Roles,
  type SignInResponse,
  type WhoamiResponse,
} from "./protocol";
import { machineRefusal, may, mayGrant, powerRefusal, roleDetail } from "./powers";
import {
  encodeRegistry,
  findMember,
  isRole,
  judgeEmail,
  mayRestart,
  putMember,
  putProjectRole,
  readRegistry,
  readRoles,
  removeMember,
  removeProjectRole,
  roleOf,
  recordCreation as creationRecorded,
  rightsText,
  views,
  type Registry,
} from "./registry";
import { rightsOf, type MemberRights } from "./tokens";
import { attemptWait, countAttempt, EMPTY_UNLOCKS, failed, grant, isUnlocked, revokeMember, revokeSession, unlockedUntil, type UnlockBook } from "./unlocks";
import { dropMember, dropSession, encodeBook, findSession, openMemberSession, readBook, spendNonce, type SessionBook } from "./sessions";
import type { MembersSystem } from "./system";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/** What the journal records of a member event: the actor this steward verified, never one a request named. */
export type MemberEvent = {
  operation:
    | "member.invite"
    | "member.role"
    | "member.remove"
    | "member.signin"
    | "member.signin_failed"
    | "member.signout"
    | "unlock"
    | "lock"
    | "token.create"
    | "token.revoke"
    | "project.create"
    | "project.remove"
    | "sharing";
  result: "ok" | "rejects";
  actor: string;
  /** The member the event is about. */
  member: string | null;
  detail: string | null;
  /** The project a Project admin's change is on. */
  slug?: string;
};

/** Who a member request comes from, as this steward verified it: their session, their roles and create right now. */
export type MemberPrincipal = { email: string; roles: Roles; create: boolean; session: string };

/**
 * A member's request refused by role before it reached anything: the journal
 * says who tried what, on which project, and their role, never a value.
 */
export type RestartRefusal = {
  operation: "restart" | "read" | "set" | "remove" | "create" | "restore" | "replace" | "portal" | "sharing" | "guest.create" | "guest.revoke" | "backup.restore";
  result: "rejects";
  actor: string;
  member: string;
  slug: string;
  detail: string;
};

export type MemberRoutesDependencies = {
  system: MembersSystem;
  /** The served zone: it names the landing's directory, which no member takes. */
  zone: string;
  /** Is this the live unlock token of the secrets routes? */
  isUnlocked: (token: unknown) => Promise<boolean>;
  /** The steward's body reader: bounded in size and in time, the expected fields and those alone. */
  readBody: (req: Request, fields: string[]) => Promise<Body | Response>;
  journal: (event: MemberEvent | RestartRefusal) => Promise<void>;
  /**
   * The restart of a project's service for a member, under the secrets routes'
   * lock and observation. `allowed` is asked again once its turn has come: a
   * member removed while the restart waited behind another does not restart.
   */
  restart: (req: Request, slug: string, actor: string, allowed: () => Promise<boolean>) => Promise<Response>;
  /**
   * A member removed: every token of theirs revoked, journaled under `actor`
   * (src/control/steward.ts, `revokeMember`). Called once the registry is
   * written and this file's queue left, never from inside it: the control
   * routes' queue may be waiting on this one for a creation. Absent, nothing
   * to revoke, and their tokens are refused all the same.
   */
  revokeTokens?: (email: string, actor: string) => Promise<number>;
  random?: RandomSource;
  /** Failed sign-ins journaled per minute at most, so that a flood cannot push the journal's history out. */
  failuresPerMinute?: number;
};

export type MemberRoutes = {
  /** The routes of the dashboard's socket. */
  dashboard: Routes;
  /** The routes of the owner's socket, which only root opens. */
  owner: Routes;
  /** The key pair, laid if missing or mismatched: at startup, and before every use. */
  ensureKeys: () => Promise<KeyState>;
  /**
   * Who a member request comes from: the session, the member still in the
   * registry, and, when `unlock` is not null, that it is the live unlock of
   * that session. Or the refusal to send back.
   */
  authorize: (session: unknown, unlock: unknown | null) => Promise<MemberPrincipal | Response>;
  /** When this member session's unlock ends, null when locked. */
  unlockedUntil: (session: unknown) => Promise<number | null>;
  /** A refusal for the journal, bounded per minute so that a flood cannot push its history out. */
  journalRefusal: (event: MemberEvent | RestartRefusal) => Promise<void>;
  journal: (event: MemberEvent) => Promise<void>;
  /** A member's rights as the registry reads now; null: no member; a Response: the registry does not read. */
  rights: (email: string) => Promise<MemberRights | null | Response>;
  /**
   * A project a member's token creates: they become its Project admin, and
   * the journal says so under their email. Null once recorded, or the refusal.
   */
  recordCreation: (slug: string, email: string, tokenId: string) => Promise<Response | null>;
};

export type KeyState = { kind: "ready"; publicKey: PublicKey } | { kind: "unavailable"; reason: string };

const STATUSES: Record<string, number> = {
  invalid: 400,
  locked: 401,
  "signed-out": 401,
  "invalid-assertion": 401,
  "not-a-member": 403,
  "out-of-scope": 403,
  "not-found": 404,
  "too-many-attempts": 429,
  failure: 500,
  "not-ready": 503,
};

function fail(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: STATUSES[code] ?? 500 });
}

const REGISTRY_UNREADABLE = "the members registry does not read on the machine: the owner must check /var/lib/sitesolide-steward/members.json";

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

/** A slug's shape, before it enters the journal or a refusal. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** What a Project admin learns of a member: their role on that project, nothing of the others. */
function projectView(member: MemberView, slug: string): MemberView {
  return { ...member, roles: Object.hasOwn(member.roles, slug) ? { [slug]: member.roles[slug]! } : {} };
}

export function createMemberRoutes(dependencies: MemberRoutesDependencies): MemberRoutes {
  const { system, readBody, journal } = dependencies;
  const failuresPerMinute = dependencies.failuresPerMinute ?? 20;
  /** The members' unlocks, in memory: a restart locks everyone, as it locks the super admin. */
  let unlocks: UnlockBook = EMPTY_UNLOCKS;

  /**
   * Every change to the registry, the sessions or the keys, one at a time: two
   * invitations read side by side would each write a registry without the
   * other's member, two sign-ins a book without the other's session.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function registry(): Promise<Registry | Response> {
    let text: string | null;
    try {
      text = await system.readRegistry();
    } catch (e) {
      console.error(`members: members.json unreadable (${errorName(e)})`);
      return fail("failure", REGISTRY_UNREADABLE);
    }
    const read = readRegistry(text);
    if ("unreadable" in read) {
      console.error(`members: ${read.unreadable}`);
      return fail("failure", REGISTRY_UNREADABLE);
    }
    return read;
  }

  async function book(): Promise<SessionBook> {
    return readBook(await system.readBook());
  }

  // --- the key pair --------------------------------------------------------------

  async function ensureKeysNow(): Promise<KeyState> {
    const publicKey = readPublicKey(await system.readPublicKey());
    const privateKey = readPrivateKey(await system.readPortalKey());
    if (publicKey !== null && privateKey !== null && samePair(privateKey, publicKey)) return { kind: "ready", publicKey };
    // A new pair: the private half first, so that a stop between the two
    // leaves a mismatch, which the next call settles by drawing again.
    const pair = await generateKeyPair();
    const written = await system.writePortalKey(encodeKey(pair.privateKey));
    if (written === "no-folder") return { kind: "unavailable", reason: "/etc/sitesolide-portal is missing: run sitesolide upgrade, which runs bin/deploy-steward.sh" };
    if (written === "no-group") return { kind: "unavailable", reason: "the portal is not deployed on this machine: its site-portal group does not exist" };
    await system.writePublicKey(encodeKey(pair.publicKey));
    console.log(`members: key pair ${pair.publicKey.kid} laid for the portal`);
    return { kind: "ready", publicKey: pair.publicKey };
  }

  const ensureKeys = () => serially(ensureKeysNow);

  // --- the journal's failures, bounded ----------------------------------------------

  let failureMinute = -1;
  let failureCount = 0;
  /** A refusal for the journal, unless this minute already holds its share of them. */
  async function journalRefusal(event: MemberEvent | RestartRefusal): Promise<void> {
    const minute = Math.floor(system.now() / 60_000);
    if (minute !== failureMinute) {
      failureMinute = minute;
      failureCount = 0;
    }
    failureCount++;
    if (failureCount > failuresPerMinute) return;
    await journal(event);
  }

  function journalFailure(actor: string, reason: string): Promise<void> {
    return journalRefusal({ operation: "member.signin_failed", result: "rejects", actor, member: actor === "anonymous" ? null : actor, detail: reason });
  }

  // --- what root and the super admin ask for ---------------------------------------

  async function list(): Promise<Response> {
    const read = await registry();
    if (read instanceof Response) return read;
    const settings = await system.readPortalSettings();
    const body: MembersResponse = { members: views(read), signIn: { configured: settings.configured, allowedDomains: settings.allowedDomains } };
    return Response.json(body);
  }

  /**
   * `asRoot`: the owner's socket, which only root opens, needs no unlock
   * token. `create`, the right to create projects: true or false to grant or
   * take it back, absent to leave it as it stands.
   */
  function put(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["email", "roles", "create"] : ["token", "email", "roles", "create"]);
      if (body instanceof Response) return body;
      if (body.create !== undefined && typeof body.create !== "boolean") return fail("invalid", "create: true or false, or absent to leave it as it stands");
      const create = body.create as boolean | undefined;
      if (!asRoot && !(await dependencies.isUnlocked(body.token))) return fail("locked", "locked, unlock again");
      return serially(async () => {
        if (!asRoot && !(await dependencies.isUnlocked(body.token))) return fail("locked", "locked, unlock again");
        const settings = await system.readPortalSettings();
        const email = judgeEmail(body.email, settings);
        if (typeof email !== "string") return fail("invalid", email.refusal);
        const current = await registry();
        if (current instanceof Response) return current;
        const kept = findMember(current, email)?.roles ?? {};
        const roles = readRoles(body.roles, { zone: dependencies.zone, exists: system.projectExists }, kept);
        if ("refusal" in roles) return fail("invalid", roles.refusal);
        const result = putMember(current, email, roles, OWNER_ACTOR, system.now(), create);
        if ("refusal" in result) return fail("invalid", result.refusal);
        if (result.change !== "none") {
          await system.writeRegistry(encodeRegistry(result.registry));
          const rights = rightsText(result.member.roles, result.member.create);
          await journal({
            operation: result.change === "invite" ? "member.invite" : "member.role",
            result: "ok",
            actor: OWNER_ACTOR,
            member: email,
            detail: rights,
          });
          console.log(`members: ${email} ${result.change === "invite" ? "invited" : "changed"}, ${rights}`);
        }
        const response: PutMemberResponse = { member: result.member, change: result.change };
        return Response.json(response, { status: result.change === "invite" ? 201 : 200 });
      });
    };
  }

  /**
   * Their tokens after them, outside this file's queue: see `revokeTokens`.
   * A failure there is said and left: their tokens are refused anyway, the
   * registry no longer naming them.
   */
  async function revokeTokensOf(email: string, actor: string): Promise<void> {
    if (dependencies.revokeTokens === undefined) return;
    try {
      await dependencies.revokeTokens(email, actor);
    } catch (e) {
      console.error(`members: the tokens of ${email} not revoked (${errorName(e)}), refused all the same`);
    }
  }

  async function remove(req: Request): Promise<Response> {
    const body = await readBody(req, ["email"]);
    if (body instanceof Response) return body;
    const removed = await serially(async () => {
      const current = await registry();
      if (current instanceof Response) return current;
      const result = removeMember(current, body.email);
      if ("refusal" in result) return fail(result.refusal.endsWith("is not a member") ? "not-found" : "invalid", result.refusal);
      await system.writeRegistry(encodeRegistry(result.registry));
      // Their sessions fall with them: the next request of any of them is refused.
      await system.writeBook(encodeBook(dropMember(await book(), result.member.email)));
      unlocks = revokeMember(unlocks, result.member.email);
      await journal({ operation: "member.remove", result: "ok", actor: OWNER_ACTOR, member: result.member.email, detail: rightsText(result.member.roles, result.member.create) });
      console.log(`members: ${result.member.email} removed`);
      return result.member;
    });
    if (removed instanceof Response) return removed;
    await revokeTokensOf(removed.email, OWNER_ACTOR);
    return Response.json({ member: removed });
  }

  // --- the member sessions -----------------------------------------------------------

  async function key(): Promise<Response> {
    const state = await ensureKeys();
    if (state.kind === "unavailable") return fail("not-ready", state.reason);
    const body: KeyResponse = { publicKey: state.publicKey };
    return Response.json(body);
  }

  function identityOf(current: Registry, email: string, name: string | null): MemberIdentity | null {
    const member = findMember(current, email);
    return member === null ? null : { kind: "member", email, name, roles: { ...member.roles }, create: member.create };
  }

  async function signIn(req: Request): Promise<Response> {
    const body = await readBody(req, ["assertion"]);
    if (body instanceof Response) return body;
    const state = await ensureKeys();
    if (state.kind === "unavailable") return fail("not-ready", state.reason);
    const nowS = Math.floor(system.now() / 1000);
    const reading = await verifyAssertion(body.assertion, state.publicKey, { audience: DASHBOARD_AUDIENCE, nowS });
    if ("refusal" in reading) {
      await journalFailure("anonymous", reading.refusal);
      return fail("invalid-assertion", `the sign-in could not be verified (${reading.refusal}): sign in again`);
    }
    const { claims } = reading;
    if (nowS - claims.auth_time > MAX_AUTH_AGE_S) {
      await journalFailure(claims.email, "stale-authentication");
      return fail("invalid-assertion", "this sign-in is too old: sign in again with your provider");
    }
    return serially(async () => {
      const now = system.now();
      const spent = spendNonce(await book(), claims.nonce, claims.exp * 1000, now);
      if (spent === "replayed" || spent === "too-many") {
        await journalFailure(claims.email, spent === "replayed" ? "replayed-assertion" : "too-many-sign-ins");
        return fail("invalid-assertion", "this sign-in was already used: sign in again");
      }
      const current = await registry();
      if (current instanceof Response) return current;
      const identity = identityOf(current, claims.email, claims.name);
      if (identity === null) {
        // The nonce stays spent: the same assertion is not tried again.
        await system.writeBook(encodeBook(spent));
        await journalFailure(claims.email, "not-a-member");
        return fail("not-a-member", `${claims.email} is not a member of this dashboard: ask its owner to invite you`);
      }
      const opened = await openMemberSession(spent, claims.email, now, dependencies.random);
      await system.writeBook(encodeBook(opened.book));
      await journal({ operation: "member.signin", result: "ok", actor: claims.email, member: claims.email, detail: rightsText(identity.roles, identity.create) });
      const response: SignInResponse = { session: opened.token, expiresAt: opened.record.expiresAt, identity };
      return Response.json(response);
    });
  }

  /** The member a session belongs to, as the registry reads now, or the refusal that signs them out. */
  async function member(token: unknown): Promise<{ identity: MemberIdentity; hash: string; expiresAt: number } | Response> {
    const session = await findSession(await book(), token, system.now());
    if (session === null) return fail("signed-out", "this session is closed: sign in again");
    const current = await registry();
    if (current instanceof Response) return current;
    const identity = identityOf(current, session.email, null);
    if (identity === null) return fail("signed-out", `${session.email} is no longer a member of this dashboard`);
    return { identity, hash: session.hash, expiresAt: session.expiresAt };
  }

  async function whoami(req: Request): Promise<Response> {
    const body = await readBody(req, ["session"]);
    if (body instanceof Response) return body;
    const found = await member(body.session);
    if (found instanceof Response) return found;
    const response: WhoamiResponse = { identity: found.identity, expiresAt: found.expiresAt };
    return Response.json(response);
  }

  async function signOut(req: Request): Promise<Response> {
    const body = await readBody(req, ["session"]);
    if (body instanceof Response) return body;
    return serially(async () => {
      const current = await book();
      const session = await findSession(current, body.session, system.now());
      // 204 even on a session already closed: what is asked is already true.
      if (session === null) return new Response(null, { status: 204 });
      await system.writeBook(encodeBook(dropSession(current, session.hash)));
      unlocks = revokeSession(unlocks, session.hash);
      await journal({ operation: "member.signout", result: "ok", actor: session.email, member: session.email, detail: null });
      return new Response(null, { status: 204 });
    });
  }

  async function restart(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug"]);
    if (body instanceof Response) return body;
    const found = await member(body.session);
    if (found instanceof Response) return found;
    const email = found.identity.email;
    if (typeof body.slug !== "string") return fail("invalid", "slug must be a string");
    const slug = body.slug;
    const role = Object.hasOwn(found.identity.roles, slug) ? found.identity.roles[slug]! : null;
    if (!mayRestart(role)) {
      const message =
        role === null
          ? `${email} holds no role on ${slug}`
          : `${email} is a ${role} on ${slug}: restarting its service takes a developer or a project admin`;
      // A slug of the right shape only enters the journal.
      if (SLUG_SHAPE.test(slug)) {
        await journalRefusal({ operation: "restart", result: "rejects", actor: email, member: email, slug, detail: role === null ? "no role" : `role ${role}` });
      }
      return fail("out-of-scope", message);
    }
    // Asked again under the lock: the member, their role, their session.
    const allowed = async () => {
      const again = await member(body.session);
      if (again instanceof Response) return false;
      const current = await registry();
      return !(current instanceof Response) && mayRestart(roleOf(current, email, slug));
    };
    return dependencies.restart(req, slug, email, allowed);
  }

  // --- a member's own unlock -----------------------------------------------------------

  async function authorize(session: unknown, unlock: unknown | null): Promise<MemberPrincipal | Response> {
    const found = await member(session);
    if (found instanceof Response) return found;
    const principal: MemberPrincipal = { email: found.identity.email, roles: found.identity.roles, create: found.identity.create, session: found.hash };
    if (unlock === null) return principal;
    if (!(await isUnlocked(unlocks, found.hash, principal.email, unlock, system.now()))) {
      return fail("locked", "locked: unlock again, signing in once more with your provider");
    }
    return principal;
  }

  /**
   * A member's unlock, from an assertion the portal signed after a forced
   * sign-in: for this session's email, saying `reauth`, the sign-in at the
   * provider five minutes old at most, its nonce never seen. In the order of
   * what costs: the session, the counters, the role, the signature, the
   * claims, the nonce.
   */
  async function unlockRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "assertion"]);
    if (body instanceof Response) return body;
    const found = await member(body.session);
    if (found instanceof Response) return found;
    const email = found.identity.email;
    const now = system.now();
    const wait = attemptWait(unlocks, email, now);
    if (wait > 0) {
      return Response.json({ error: "too-many-attempts", message: "too many attempts, wait before unlocking again", wait: Math.ceil(wait / 1000) }, { status: 429 });
    }
    unlocks = countAttempt(unlocks, now);
    // A member who may create projects unlocks to mint a token that does,
    // whatever their roles.
    if (!found.identity.create && !Object.values(found.identity.roles).some((role) => may(role, "secrets.write"))) {
      return fail("out-of-scope", `${email} is a viewer on every project: there is nothing to unlock`);
    }

    const refuse = async (reason: string, message: string): Promise<Response> => {
      unlocks = failed(unlocks, email, system.now());
      await journalRefusal({ operation: "unlock", result: "rejects", actor: email, member: email, detail: reason });
      return fail("invalid-assertion", message);
    };
    const state = await ensureKeys();
    if (state.kind === "unavailable") return fail("not-ready", state.reason);
    const nowS = Math.floor(now / 1000);
    const reading = await verifyAssertion(body.assertion, state.publicKey, { audience: DASHBOARD_AUDIENCE, nowS });
    if ("refusal" in reading) return refuse(reading.refusal, `the sign-in could not be verified (${reading.refusal}): unlock again`);
    const { claims } = reading;
    if (claims.email !== email) return refuse("another-account", `this sign-in is for another account: unlock again, signing in as ${email}`);
    if (!claims.reauth) return refuse("not-forced", "your provider was not asked to sign you in again: unlock again from the dashboard");
    if (nowS - claims.auth_time > REAUTH_MAX_AGE_S) return refuse("stale-authentication", "this sign-in at your provider is too old: unlock again");

    return serially(async () => {
      const spent = spendNonce(await book(), claims.nonce, claims.exp * 1000, system.now());
      if (spent === "replayed" || spent === "too-many") return refuse(spent === "replayed" ? "replayed-assertion" : "too-many-sign-ins", "this sign-in was already used: unlock again");
      // Asked again now: the session may have closed while the assertion was read.
      const again = await member(body.session);
      if (again instanceof Response) return again;
      await system.writeBook(encodeBook(spent));
      const granted = await grant(unlocks, found.hash, email, system.now(), dependencies.random);
      unlocks = granted.book;
      await journal({ operation: "unlock", result: "ok", actor: email, member: email, detail: null });
      const response: MemberUnlockResponse = { token: granted.token, expiresAt: granted.expiresAt };
      return Response.json(response);
    });
  }

  /** 204 whatever: locking what is already locked is no fault, and a wrong token locks nothing. */
  async function lockRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "token"]);
    if (body instanceof Response) return body;
    const found = await member(body.session);
    if (found instanceof Response) return new Response(null, { status: 204 });
    if (await isUnlocked(unlocks, found.hash, found.identity.email, body.token, system.now())) {
      unlocks = revokeSession(unlocks, found.hash);
      await journal({ operation: "lock", result: "ok", actor: found.identity.email, member: found.identity.email, detail: null });
    }
    return new Response(null, { status: 204 });
  }

  // --- a Project admin's members -------------------------------------------------------

  /** The principal, if they are Project admin of a project of the machine's; or the refusal, journaled. */
  async function projectAdmin(
    session: unknown,
    unlock: unknown | null,
    slugValue: unknown,
    operation: MemberEvent["operation"],
  ): Promise<{ principal: MemberPrincipal; slug: string } | Response> {
    const principal = await authorize(session, unlock);
    if (principal instanceof Response) return principal;
    if (typeof slugValue !== "string" || !SLUG_SHAPE.test(slugValue)) return fail("invalid", "slug: a project's slug");
    const slug = slugValue;
    const machine = machineRefusal(slug, null, dependencies.zone);
    if (machine !== null) return fail("out-of-scope", machine);
    const own = Object.hasOwn(principal.roles, slug) ? principal.roles[slug]! : null;
    if (!may(own, "members")) {
      await journalRefusal({ operation, result: "rejects", actor: principal.email, member: null, detail: roleDetail(own), slug });
      return fail("out-of-scope", powerRefusal(principal.email, own, slug, "members"));
    }
    return { principal, slug };
  }

  /**
   * A role on their project, given by its Project admin: someone invited, or
   * a member's role there set. At most their own, on that project alone, and
   * judged again once its turn has come: a Project admin demoted while the
   * request waited gives nothing.
   */
  async function putProjectMember(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "token", "slug", "email", "role"]);
    if (body instanceof Response) return body;
    if (!isRole(body.role)) return fail("invalid", "role: viewer, developer or admin");
    const role = body.role;
    const asked = await projectAdmin(body.session, body.token, body.slug, "member.invite");
    if (asked instanceof Response) return asked;
    const { slug } = asked;
    if (!mayGrant(asked.principal.roles[slug] ?? null, role)) {
      return fail("out-of-scope", `${asked.principal.email} may give ${slug} a role at most their own`);
    }
    return serially(async () => {
      const again = await projectAdmin(body.session, body.token, slug, "member.invite");
      if (again instanceof Response) return again;
      const actor = again.principal.email;
      if (!mayGrant(again.principal.roles[slug] ?? null, role)) return fail("out-of-scope", `${actor} may give ${slug} a role at most their own`);
      const settings = await system.readPortalSettings();
      const email = judgeEmail(body.email, settings);
      if (typeof email !== "string") return fail("invalid", email.refusal);
      if (!system.projectExists(slug)) return fail("invalid", `roles: ${slug} is not deployed on this machine`);
      const current = await registry();
      if (current instanceof Response) return current;
      const result = putProjectRole(current, email, slug, role, actor, system.now());
      if ("refusal" in result) return fail("invalid", result.refusal);
      if (result.change !== "none") {
        await system.writeRegistry(encodeRegistry(result.registry));
        await journal({
          operation: result.change === "invite" ? "member.invite" : "member.role",
          result: "ok",
          actor,
          member: email,
          detail: `${slug}: ${role}`,
          slug,
        });
        console.log(`members: ${email} ${result.change === "invite" ? "invited" : "changed"} on ${slug} by ${actor}, ${role}`);
      }
      const response: ProjectMemberResponse = { member: projectView(result.member, slug), change: result.change };
      return Response.json(response, { status: result.change === "invite" ? 201 : 200 });
    });
  }

  /**
   * A role on their project taken away by its Project admin, no unlock, as
   * for the super admin: closing someone out never waits. Their last role
   * gone, the member goes, their sessions with them.
   */
  async function removeProjectMember(req: Request): Promise<Response> {
    const body = await readBody(req, ["session", "slug", "email"]);
    if (body instanceof Response) return body;
    const asked = await projectAdmin(body.session, null, body.slug, "member.role");
    if (asked instanceof Response) return asked;
    let gone: { email: string; actor: string } | null = null;
    const answer = await serially(async () => {
      const again = await projectAdmin(body.session, null, asked.slug, "member.role");
      if (again instanceof Response) return again;
      const { slug } = again;
      const current = await registry();
      if (current instanceof Response) return current;
      const result = removeProjectRole(current, body.email, slug, system.now());
      if ("refusal" in result) return fail(result.refusal.includes("holds no role") ? "not-found" : "invalid", result.refusal);
      await system.writeRegistry(encodeRegistry(result.registry));
      if (result.removed) {
        await system.writeBook(encodeBook(dropMember(await book(), result.member.email)));
        unlocks = revokeMember(unlocks, result.member.email);
        gone = { email: result.member.email, actor: again.principal.email };
      }
      await journal({
        operation: result.removed ? "member.remove" : "member.role",
        result: "ok",
        actor: again.principal.email,
        member: result.member.email,
        detail: `${slug}: removed`,
        slug,
      });
      const response: ProjectMemberResponse = { member: projectView(result.member, slug), change: result.removed ? "remove" : "role" };
      return Response.json(response);
    });
    const removedMember = gone as { email: string; actor: string } | null;
    if (removedMember !== null) await revokeTokensOf(removedMember.email, removedMember.actor);
    return answer;
  }

  // --- a member's own tokens -----------------------------------------------------------

  async function rights(email: string): Promise<MemberRights | null | Response> {
    const current = await registry();
    if (current instanceof Response) return current;
    return rightsOf(current, email);
  }

  /**
   * A project created by a member's token: its creator becomes Project admin
   * of it, in the registry's queue, journaled as `project.create` under their
   * email, the token in the detail.
   */
  function recordCreation(slug: string, email: string, tokenId: string): Promise<Response | null> {
    return serially(async () => {
      const current = await registry();
      if (current instanceof Response) return current;
      const result = creationRecorded(current, email, slug, system.now());
      if ("refusal" in result) return fail("out-of-scope", result.refusal);
      if (result.change !== "none") await system.writeRegistry(encodeRegistry(result.registry));
      await journal({ operation: "project.create", result: "ok", actor: email, member: email, detail: `admin, created with token ${tokenId}`, slug });
      console.log(`members: ${email} created ${slug} with token ${tokenId}, project admin of it`);
      return null;
    });
  }

  return {
    dashboard: {
      "/members": { GET: list },
      "/members/key": { GET: key },
      "/members/member": { PUT: put(false), DELETE: remove },
      "/members/signin": { POST: signIn },
      "/members/whoami": { POST: whoami },
      "/members/signout": { POST: signOut },
      "/members/restart": { POST: restart },
      "/members/unlock": { POST: unlockRoute },
      "/members/lock": { POST: lockRoute },
      "/members/project/member": { PUT: putProjectMember, DELETE: removeProjectMember },
    },
    owner: {
      "/members": { GET: list },
      "/members/member": { PUT: put(true), DELETE: remove },
    },
    ensureKeys,
    authorize,
    unlockedUntil: async (session) => {
      const found = await member(session);
      return found instanceof Response ? null : unlockedUntil(unlocks, found.hash, system.now());
    },
    journalRefusal,
    journal: (event) => journal(event),
    rights,
    recordCreation,
  };
}
