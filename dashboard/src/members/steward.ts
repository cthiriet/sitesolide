/**
 * The steward's routes for the people who sign in to the dashboard: the key
 * pair, their sessions, their own unlock, and their restart, mounted beside
 * the secrets routes on the dashboard's socket. Who they are and what they
 * may do is the access registry's (src/access/), read here at every request.
 *
 * **The steward decides every write.** A session opens only on an assertion
 * the portal signed (portal/src/assertion.ts), checked here with the public
 * key this steward keeps, for the dashboard, unexpired, its nonce never seen,
 * for an email the registry gives a role above Can open, or the right to
 * create projects. Every later request carries that session, and is judged
 * against the registry as it reads at that moment: the role, the project,
 * the person still there. The actor of the journal is the email this steward
 * verified, never one a request names. A compromised dashboard can therefore
 * act only for the people whose sessions pass through it, within their
 * roles; it can neither give anyone a role nor widen one.
 *
 * **A person unlocks for themselves.** Not with a password, which they do
 * not have: with an assertion the portal signed after a forced sign-in at the
 * provider (`reauth`, `auth_time` within five minutes), for the very email
 * their session is. The token is theirs, for that session, ten minutes, and
 * neither replaces the owner's nor is replaced by it (unlocks.ts).
 * `authorize` is what every other route asks: the session, the person still
 * in the registry, and their unlock when the power needs one.
 *
 * **Leaving.** Someone the registry no longer gives a role above Can open,
 * nor the create right, no longer signs in: `leave` closes their sessions
 * and unlocks at once, and revokes their tokens, outside this file's queue.
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
  REAUTH_MAX_AGE_S,
  type KeyResponse,
  type MemberIdentity,
  type MemberUnlockResponse,
  type Roles,
  type SignInResponse,
  type WhoamiResponse,
} from "./protocol";
import { may, mayRestart, powerRefusal } from "./powers";
import type { AccessStore } from "../access/steward";
import { recordCreation as creationRecorded, rightsOf, rolesText, type Registry } from "../access/registry";
import type { MemberRights } from "./tokens";
import { attemptWait, countAttempt, EMPTY_UNLOCKS, failed, grant, isUnlocked, revokeMember, revokeSession, unlockedUntil, type UnlockBook } from "./unlocks";
import { dropMember, dropSession, encodeBook, findSession, openMemberSession, readBook, spendNonce, type SessionBook } from "./sessions";
import type { MembersSystem } from "./system";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/** What the journal records of a person's event: the actor this steward verified, never one a request named. */
export type MemberEvent = {
  operation:
    | "dashboard.signin"
    | "dashboard.signin_failed"
    | "dashboard.signout"
    | "unlock"
    | "lock"
    | "token.create"
    | "token.revoke"
    | "project.create"
    | "project.remove"
    | "access.add";
  result: "ok" | "rejects";
  actor: string;
  /** The person the event is about. */
  member: string | null;
  detail: string | null;
  /** The project an event is on. */
  slug?: string;
};

/** Who a person's request comes from, as this steward verified it: their session, their roles and create right now. */
export type MemberPrincipal = { email: string; roles: Roles; create: boolean; session: string };

/**
 * A person's request refused by role before it reached anything: the journal
 * says who tried what, on which project, and their role, never a value.
 */
export type RestartRefusal = {
  operation: "restart" | "read" | "set" | "remove" | "create" | "restore" | "replace" | "portal" | "backup.restore";
  result: "rejects";
  actor: string;
  member: string;
  slug: string;
  detail: string;
};

export type MemberRoutesDependencies = {
  system: MembersSystem;
  /** The access registry: who signs in, and their roles. */
  access: Pick<AccessStore, "read" | "change">;
  /** The served zone: it names the landing's directory, which no person takes. */
  zone: string;
  /** The steward's body reader: bounded in size and in time, the expected fields and those alone. */
  readBody: (req: Request, fields: string[]) => Promise<Body | Response>;
  journal: (event: MemberEvent | RestartRefusal) => Promise<void>;
  /**
   * The restart of a project's service for a person, under the secrets routes'
   * lock and observation. `allowed` is asked again once its turn has come: a
   * person removed while the restart waited behind another does not restart.
   */
  restart: (req: Request, slug: string, actor: string, allowed: () => Promise<boolean>) => Promise<Response>;
  /**
   * Someone who no longer signs in: every token of theirs revoked, journaled
   * under `actor` (src/control/steward.ts, `revokeMember`). Called outside
   * this file's queue: the control routes' queue may be waiting on the
   * registry's for a creation. Absent, nothing to revoke, and their tokens
   * are refused all the same.
   */
  revokeTokens?: (email: string, actor: string) => Promise<number>;
  random?: RandomSource;
  /** Failed sign-ins journaled per minute at most, so that a flood cannot push the journal's history out. */
  failuresPerMinute?: number;
};

export type MemberRoutes = {
  /** The routes of the dashboard's socket. */
  dashboard: Routes;
  /** The key pair, laid if missing or mismatched: at startup, and before every use. */
  ensureKeys: () => Promise<KeyState>;
  /**
   * Who a request comes from: the session, the person still signing in, and,
   * when `unlock` is not null, that it is the live unlock of that session.
   * Or the refusal to send back.
   */
  authorize: (session: unknown, unlock: unknown | null) => Promise<MemberPrincipal | Response>;
  /** When this session's unlock ends, null when locked. */
  unlockedUntil: (session: unknown) => Promise<number | null>;
  /** A refusal for the journal, bounded per minute so that a flood cannot push its history out. */
  journalRefusal: (event: MemberEvent | RestartRefusal) => Promise<void>;
  journal: (event: MemberEvent) => Promise<void>;
  /** A person's rights as the registry reads now; null: they do not sign in; a Response: the registry does not read. */
  rights: (email: string) => Promise<MemberRights | null | Response>;
  /**
   * A project a person's token creates: they become its Admin, and the
   * journal says so under their email. Null once recorded, or the refusal.
   */
  recordCreation: (slug: string, email: string, tokenId: string) => Promise<Response | null>;
  /** Someone who no longer signs in: their sessions and unlocks closed, their tokens revoked under `actor`. */
  leave: (email: string, actor: string) => Promise<void>;
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

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

/** A slug's shape, before it enters the journal or a refusal. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** The roles and the create right, for the journal: `blog: developer; may create projects`. */
function rightsText(roles: Roles, create: boolean): string {
  return create ? `${rolesText(roles)}; may create projects` : rolesText(roles);
}

export function createMemberRoutes(dependencies: MemberRoutesDependencies): MemberRoutes {
  const { system, readBody, journal } = dependencies;
  const failuresPerMinute = dependencies.failuresPerMinute ?? 20;
  /** The unlocks of the people's sessions, in memory: a restart locks everyone, as it locks the owner. */
  let unlocks: UnlockBook = EMPTY_UNLOCKS;

  /**
   * Every change to the sessions or the keys, one at a time: two sign-ins
   * read side by side would each write a book without the other's session.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  const registry = () => dependencies.access.read();

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
    console.log(`dashboard sign-in: key pair ${pair.publicKey.kid} laid for the portal`);
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
    return journalRefusal({ operation: "dashboard.signin_failed", result: "rejects", actor, member: actor === "anonymous" ? null : actor, detail: reason });
  }

  /**
   * Their tokens after them, outside this file's queue: see `revokeTokens`.
   * A failure there is said and left: their tokens are refused anyway, the
   * registry no longer giving them a role.
   */
  async function revokeTokensOf(email: string, actor: string): Promise<void> {
    if (dependencies.revokeTokens === undefined) return;
    try {
      await dependencies.revokeTokens(email, actor);
    } catch (e) {
      console.error(`dashboard sign-in: the tokens of ${email} not revoked (${errorName(e)}), refused all the same`);
    }
  }

  async function leave(email: string, actor: string): Promise<void> {
    await serially(async () => {
      await system.writeBook(encodeBook(dropMember(await book(), email)));
      unlocks = revokeMember(unlocks, email);
    });
    console.log(`dashboard sign-in: ${email} no longer signs in, sessions closed`);
    await revokeTokensOf(email, actor);
  }

  // --- the sessions --------------------------------------------------------------------

  async function key(): Promise<Response> {
    const state = await ensureKeys();
    if (state.kind === "unavailable") return fail("not-ready", state.reason);
    const body: KeyResponse = { publicKey: state.publicKey };
    return Response.json(body);
  }

  function identityOf(current: Registry, email: string, name: string | null): MemberIdentity | null {
    const rights = rightsOf(current, email);
    return rights === null ? null : { kind: "member", email, name, roles: rights.roles, create: rights.create };
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
    const current = await registry();
    if (current instanceof Response) return current;
    return serially(async () => {
      const now = system.now();
      const spent = spendNonce(await book(), claims.nonce, claims.exp * 1000, now);
      if (spent === "replayed" || spent === "too-many") {
        await journalFailure(claims.email, spent === "replayed" ? "replayed-assertion" : "too-many-sign-ins");
        return fail("invalid-assertion", "this sign-in was already used: sign in again");
      }
      const again = await registry();
      if (again instanceof Response) return again;
      const identity = identityOf(again, claims.email, claims.name);
      if (identity === null) {
        // The nonce stays spent: the same assertion is not tried again.
        await system.writeBook(encodeBook(spent));
        await journalFailure(claims.email, "no-role");
        return fail("not-a-member", `${claims.email} has no role on this dashboard: ask its owner, or the Admin of a project, for access`);
      }
      const opened = await openMemberSession(spent, claims.email, now, dependencies.random);
      await system.writeBook(encodeBook(opened.book));
      await journal({ operation: "dashboard.signin", result: "ok", actor: claims.email, member: claims.email, detail: rightsText(identity.roles, identity.create) });
      const response: SignInResponse = { session: opened.token, expiresAt: opened.record.expiresAt, identity };
      return Response.json(response);
    });
  }

  /** The person a session belongs to, as the registry reads now, or the refusal that signs them out. */
  async function member(token: unknown): Promise<{ identity: MemberIdentity; hash: string; expiresAt: number } | Response> {
    const session = await findSession(await book(), token, system.now());
    if (session === null) return fail("signed-out", "this session is closed: sign in again");
    const current = await registry();
    if (current instanceof Response) return current;
    const identity = identityOf(current, session.email, null);
    if (identity === null) return fail("signed-out", `${session.email} no longer has a role on this dashboard`);
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
      await journal({ operation: "dashboard.signout", result: "ok", actor: session.email, member: session.email, detail: null });
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
      const message = powerRefusal(email, role, slug, "restart");
      // A slug of the right shape only enters the journal.
      if (SLUG_SHAPE.test(slug)) {
        await journalRefusal({ operation: "restart", result: "rejects", actor: email, member: email, slug, detail: role === null ? "no role" : `role ${role}` });
      }
      return fail("out-of-scope", message);
    }
    // Asked again under the lock: the person, their role, their session.
    const allowed = async () => {
      const again = await member(body.session);
      if (again instanceof Response) return false;
      return mayRestart(Object.hasOwn(again.identity.roles, slug) ? again.identity.roles[slug]! : null);
    };
    return dependencies.restart(req, slug, email, allowed);
  }

  // --- a person's own unlock -----------------------------------------------------------

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
   * A person's unlock, from an assertion the portal signed after a forced
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
    // Someone who may create projects unlocks to mint a token that does,
    // whatever their roles; a Viewer everywhere has nothing to unlock.
    if (!found.identity.create && !Object.values(found.identity.roles).some((role) => may(role, "secrets.write"))) {
      return fail("out-of-scope", `${email} is a Viewer on every project: there is nothing to unlock`);
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

  // --- a person's own tokens -----------------------------------------------------------

  async function rights(email: string): Promise<MemberRights | null | Response> {
    const current = await registry();
    if (current instanceof Response) return current;
    return rightsOf(current, email);
  }

  /**
   * A project created by a person's token: its creator becomes its Admin, in
   * the registry's queue, journaled as `project.create` under their email,
   * the token in the detail.
   */
  async function recordCreation(slug: string, email: string, tokenId: string): Promise<Response | null> {
    const answer = await dependencies.access.change<null>(async (current) => {
      const result = creationRecorded(current, email, slug, system.now());
      if ("refusal" in result) return fail("out-of-scope", result.refusal);
      await journal({ operation: "project.create", result: "ok", actor: email, member: email, detail: `admin, created with token ${tokenId}`, slug });
      console.log(`access: ${email} created ${slug} with token ${tokenId}, its Admin`);
      return { registry: result.registry, value: null };
    });
    return answer;
  }

  return {
    dashboard: {
      "/members/key": { GET: key },
      "/members/signin": { POST: signIn },
      "/members/whoami": { POST: whoami },
      "/members/signout": { POST: signOut },
      "/members/restart": { POST: restart },
      "/members/unlock": { POST: unlockRoute },
      "/members/lock": { POST: lockRoute },
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
    leave,
  };
}
