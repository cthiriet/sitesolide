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
  type KeyResponse,
  type MemberIdentity,
  type MembersResponse,
  type PutMemberResponse,
  type SignInResponse,
  type WhoamiResponse,
} from "./protocol";
import {
  encodeRegistry,
  findMember,
  judgeEmail,
  mayRestart,
  putMember,
  readRegistry,
  readRoles,
  removeMember,
  roleOf,
  rolesText,
  views,
  type Registry,
} from "./registry";
import { dropMember, dropSession, encodeBook, findSession, openMemberSession, readBook, spendNonce, type SessionBook } from "./sessions";
import type { MembersSystem } from "./system";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/** What the journal records of a member event: the actor this steward verified, never one a request named. */
export type MemberEvent = {
  operation: "member.invite" | "member.role" | "member.remove" | "member.signin" | "member.signin_failed" | "member.signout";
  result: "ok" | "rejects";
  actor: string;
  /** The member the event is about. */
  member: string | null;
  detail: string | null;
};

/** A member's restart refused before it reached the service: the journal says who tried what. */
export type RestartRefusal = { operation: "restart"; result: "rejects"; actor: string; member: string; slug: string; detail: string };

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

export function createMemberRoutes(dependencies: MemberRoutesDependencies): MemberRoutes {
  const { system, readBody, journal } = dependencies;
  const failuresPerMinute = dependencies.failuresPerMinute ?? 20;

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

  /** `asRoot`: the owner's socket, which only root opens, needs no unlock token. */
  function put(asRoot: boolean): Handler {
    return async (req) => {
      const body = await readBody(req, asRoot ? ["email", "roles"] : ["token", "email", "roles"]);
      if (body instanceof Response) return body;
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
        const result = putMember(current, email, roles, OWNER_ACTOR, system.now());
        if ("refusal" in result) return fail("invalid", result.refusal);
        if (result.change !== "none") {
          await system.writeRegistry(encodeRegistry(result.registry));
          await journal({
            operation: result.change === "invite" ? "member.invite" : "member.role",
            result: "ok",
            actor: OWNER_ACTOR,
            member: email,
            detail: rolesText(roles),
          });
          console.log(`members: ${email} ${result.change === "invite" ? "invited" : "changed"}, ${rolesText(roles)}`);
        }
        const response: PutMemberResponse = { member: result.member, change: result.change };
        return Response.json(response, { status: result.change === "invite" ? 201 : 200 });
      });
    };
  }

  async function remove(req: Request): Promise<Response> {
    const body = await readBody(req, ["email"]);
    if (body instanceof Response) return body;
    return serially(async () => {
      const current = await registry();
      if (current instanceof Response) return current;
      const result = removeMember(current, body.email);
      if ("refusal" in result) return fail(result.refusal.endsWith("is not a member") ? "not-found" : "invalid", result.refusal);
      await system.writeRegistry(encodeRegistry(result.registry));
      // Their sessions fall with them: the next request of any of them is refused.
      await system.writeBook(encodeBook(dropMember(await book(), result.member.email)));
      await journal({ operation: "member.remove", result: "ok", actor: OWNER_ACTOR, member: result.member.email, detail: rolesText(result.member.roles) });
      console.log(`members: ${result.member.email} removed`);
      return Response.json({ member: result.member });
    });
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
    return member === null ? null : { kind: "member", email, name, roles: { ...member.roles } };
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
      await journal({ operation: "member.signin", result: "ok", actor: claims.email, member: claims.email, detail: rolesText(identity.roles) });
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
      if (/^[a-z0-9][a-z0-9.-]{0,62}$/.test(slug)) {
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

  return {
    dashboard: {
      "/members": { GET: list },
      "/members/key": { GET: key },
      "/members/member": { PUT: put(false), DELETE: remove },
      "/members/signin": { POST: signIn },
      "/members/whoami": { POST: whoami },
      "/members/signout": { POST: signOut },
      "/members/restart": { POST: restart },
    },
    owner: {
      "/members": { GET: list },
      "/members/member": { PUT: put(true), DELETE: remove },
    },
    ensureKeys,
  };
}
