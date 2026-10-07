/**
 * The dashboard's member routes, built around their dependencies like the
 * others: the tests drive them with a simulated steward and portal.
 *
 *   GET    /api/session            who is signed in, and whether the provider is offered
 *   GET    /api/sso/begin          a member's sign-in, through the portal: a top-level navigation;
 *                                  `reauth=1`, a member's unlock, the provider made to ask again
 *   GET    /api/sso/complete       where the portal sends the browser back, with a code
 *   GET    /api/members            the Members page, the super admin's
 *   PUT    /api/members/member     invite, or change roles: unlocked, as creating a token
 *   DELETE /api/members/member     remove: no unlock, as revoking a token
 *   POST   /api/members/restart    a member's restart, judged by the steward
 *
 * **The dashboard decides nothing a member could use.** It checks the origin,
 * the session and the shape of a request, and relays: the steward opens member
 * sessions from assertions it verifies itself, and judges every write against
 * its registry. What the dashboard does decide is what a member sees, from
 * data it already holds: see view.ts.
 *
 * **A member's session is the steward's.** Its token is drawn by the steward
 * when an assertion checks out, set here as the browser's `__Host-session`,
 * and kept in `dashboard.db` by its hash with the member's email, beside the
 * owner's. Every member request presents it, and the steward is asked who it
 * belongs to (identity.ts): removed, the member is out at once.
 */
import { DASHBOARD_AUDIENCE, readPublicKey, verifyAssertion, type PublicKey } from "../../borrowed/assertion";
import { reach, type Reached } from "../control/client";
import { reservedReason } from "../control/policy";
import { read } from "../read";
import type { SessionReader } from "../routes";
import { isAcceptableOrigin, setCookie } from "../sessions";
import type { Tokens } from "../secrets/tokens";
import type { DashboardPortal, MembersSteward } from "./client";
import type { Identity, IdentityResolver } from "./identity";
import { readMemberIdentity } from "./identity";
import type { SignInLimiter } from "./limiter";
import type { Restriction } from "../audit/merge";
import type { Roles } from "./protocol";

type Handler = (req: Request) => Promise<Response>;

export type MembersRoutesDependencies = {
  publicUrl: string;
  online: boolean;
  /** Is a password hash in place? The sign-in page says so when it is not. */
  passwordConfigured: boolean;
  zone: string;
  stateFile: string;
  steward: MembersSteward;
  portal: DashboardPortal;
  store: {
    recordSession: (token: string, identity: string, now: number) => Promise<void>;
    purgeSessions: (before: number, memberBefore: number) => void;
    closeSession: (hash: string) => void;
  };
  resolve: IdentityResolver & { forget: (hash: string) => void };
  /** The owner's sessions alone: the Members page is the super admin's. */
  ownerSession: SessionReader;
  /** The unlock tokens of the Secrets section: inviting asks for the same unlock. */
  tokens: Tokens;
  /** The members' own unlock tokens, by session hash: a forced sign-in that checks out lays one here. */
  unlocks: Tokens;
  limiter: SignInLimiter;
  ownerDurationMs: number;
  memberDurationMs: number;
};

export type MembersRoutes = {
  session: Handler;
  begin: Handler;
  complete: Handler;
  list: Handler;
  put: Handler;
  remove: Handler;
  restart: Handler;
  /** Not a route: what signing out a member asks the steward, never rejecting. */
  signOut: (token: string) => Promise<void>;
  /** Not a route: what a session may read of the audit. */
  restriction: (req: Request, now: number) => Promise<Restriction | null>;
  /** Not a route: the roles that bound what a session sees, null for the owner, `unreachable` when the steward is mute. */
  roles: (req: Request, now: number) => Promise<Roles | null | "no-session" | "unreachable">;
  /** Not a route: the provider's name as the portal gives it, null when none is offered. */
  providerName: (now: number) => Promise<string | null>;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

/** The binding cookie of a sign-in in flight: on the dashboard's host alone, for the ten minutes a flow lasts. */
const BINDING_SUFFIX = "sso";
const BINDING_DURATION_S = 10 * 60;
/**
 * What the binding cookie carries after the binding when the flow is a
 * member's unlock: whatever the portal answers, the assertion then goes to
 * the steward's unlock, which refuses one that is not a forced sign-in,
 * rather than opening a session the member already has.
 */
const REAUTH_MARK = ".reauth";

/**
 * Unlocks in flight, the member's session kept here from the moment they left
 * for the provider. The session cookie is `SameSite=Strict`, and the way back
 * from a provider on another site is a cross-site navigation, which never
 * carries it: the binding, which does travel (`Lax`), finds the session again.
 * A minute's handful at most; past the bound, the oldest goes.
 */
const MAX_PENDING_UNLOCKS = 1000;

type PendingUnlock = { token: string; hash: string; email: string; expiresAt: number };

function bindingKey(binding: string): string {
  return new Bun.CryptoHasher("sha256").update(binding).digest("hex");
}

/** How long what the portal says of its provider is kept: the sign-in page asks for it on every visit. */
const SSO_CACHE_MS = 30_000;
const KEY_CACHE_MS = 60_000;

function bindingCookieName(online: boolean): string {
  return online ? `__Host-${BINDING_SUFFIX}` : BINDING_SUFFIX;
}

function bindingCookie(value: string, online: boolean, maxAgeS: number): string {
  // Lax and not Strict: the browser comes back from the provider, another
  // site, and a Strict cookie would not travel with that navigation.
  return [`${bindingCookieName(online)}=${value}`, "Path=/", `Max-Age=${maxAgeS}`, "HttpOnly", "SameSite=Lax", ...(online ? ["Secure"] : [])].join("; ");
}

function readNamedCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator === -1 || chunk.slice(0, separator).trim() !== name) continue;
    const value = chunk.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * A path of the dashboard to come back to, or `/`: never another host, never
 * the API, whose answers are not pages.
 */
export function safeReturn(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\x00-\x1f\x7f]/.test(value) || value.startsWith("/api/")) return "/";
  return value;
}

/** Where a sign-in that did not open a session sends the browser: the sign-in page, with why. */
function refused(reason: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...NO_STORE, Location: `/?signin=${encodeURIComponent(reason)}` });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** Back to the page a member unlocked from, with why not when the unlock did not go through. */
function backTo(returnTo: string, reason: string | null, cookies: string[]): Response {
  const location = reason === null ? returnTo : `${returnTo}${returnTo.includes("?") ? "&" : "?"}unlock=${encodeURIComponent(reason)}`;
  const headers = new Headers({ ...NO_STORE, Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return null;
  try {
    const text = await req.text();
    if (text.length > 64 * 1024) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** What the page says when the steward does not carry the member routes yet. */
export const MEMBERS_NOT_AVAILABLE = "The steward on this machine does not know members yet: run sitesolide upgrade.";

/** A view of who is signed in, for the page: never a token. */
function identityView(identity: Identity): Record<string, unknown> {
  return identity.kind === "owner"
    ? { kind: "owner" }
    : { kind: "member", email: identity.email, name: identity.name, roles: identity.roles, expiresAt: identity.expiresAt };
}

function relayRefusal(reached: Reached): Response {
  if (reached.kind === "unreachable") return error(502, "failure", "Can't reach the steward.");
  if (reached.kind === "unavailable") return error(503, "not-available", MEMBERS_NOT_AVAILABLE);
  if (reached.kind === "unreadable") return error(502, "failure", "The steward sent an unreadable answer.");
  return json({ error: reached.body.error, message: reached.body.message }, reached.status);
}

export function createMembersRoutes(dependencies: MembersRoutesDependencies, clock: () => number = Date.now): MembersRoutes {
  const { publicUrl, online, steward, portal, store, resolve, tokens, limiter } = dependencies;
  const pendingUnlocks = new Map<string, PendingUnlock>();

  function keepPending(key: string, pending: PendingUnlock, now: number): void {
    for (const [held, entry] of pendingUnlocks) if (entry.expiresAt <= now) pendingUnlocks.delete(held);
    if (pendingUnlocks.size >= MAX_PENDING_UNLOCKS) pendingUnlocks.delete(pendingUnlocks.keys().next().value!);
    pendingUnlocks.set(key, pending);
  }

  function takePending(key: string, now: number): PendingUnlock | null {
    const pending = pendingUnlocks.get(key) ?? null;
    pendingUnlocks.delete(key);
    return pending !== null && pending.expiresAt > now ? pending : null;
  }

  let sso: { at: number; value: { offered: boolean; providerName: string | null } } | null = null;
  /** Whether the portal offers its provider, and under which name; nothing offered when it cannot say. */
  async function ssoOffer(now: number): Promise<{ offered: boolean; providerName: string | null }> {
    if (sso !== null && now - sso.at < SSO_CACHE_MS) return sso.value;
    let value = { offered: false, providerName: null as string | null };
    try {
      const response = await portal.sso();
      const body: unknown = await response.json();
      const view = isObject(body) && isObject(body.sso) ? body.sso : null;
      if (response.status === 200 && view !== null && view.configured === true) {
        value = { offered: true, providerName: typeof view.providerName === "string" ? view.providerName : null };
      }
    } catch {
      // A portal that does not answer offers nothing: the password stays.
    }
    sso = { at: now, value };
    return value;
  }

  let key: { at: number; value: PublicKey } | null = null;
  /** The steward's public key, to read an assertion before the steward is asked: the steward checks it again. */
  async function publicKey(now: number): Promise<PublicKey | null> {
    if (key !== null && now - key.at < KEY_CACHE_MS) return key.value;
    try {
      const response = await steward.key();
      const body: unknown = await response.json();
      const value = response.status === 200 && isObject(body) ? readPublicKey(JSON.stringify(body.publicKey)) : null;
      if (value === null) return null;
      key = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  async function ownerOnly(req: Request, writing: boolean): Promise<{ hash: string } | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), publicUrl)) return json({ error: "origin-refused" }, 403);
    return (await dependencies.ownerSession(req, clock())) ?? json({ error: "no-session" }, 401);
  }

  return {
    async session(req) {
      const now = clock();
      const resolved = await resolve(req, now);
      if (resolved === "unreachable") return error(502, "failure", "Can't reach the steward to say who this member is.");
      return json({
        open: resolved !== null,
        configured: dependencies.passwordConfigured,
        identity: resolved === null ? null : identityView(resolved.identity),
        sso: await ssoOffer(now),
      });
    },

    async begin(req) {
      const params = new URL(req.url).searchParams;
      const returnTo = safeReturn(params.get("return"));
      // A member's unlock: a forced sign-in at the provider, for a session that
      // is theirs already. Anyone else goes back to signing in.
      const reauth = params.get("reauth") === "1";
      const binding = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      if (reauth) {
        const now = clock();
        const resolved = await resolve(req, now);
        if (resolved === "unreachable" || resolved === null || resolved.identity.kind !== "member") return refused("expired");
        keepPending(bindingKey(binding), { token: resolved.token, hash: resolved.session.hash, email: resolved.identity.email, expiresAt: now + BINDING_DURATION_S * 1000 }, now);
      }
      let start: string | null = null;
      try {
        const response = await portal.flow({ binding, returnTo, chooseAccount: params.get("account") === "choose", ...(reauth ? { reauth: true } : {}) });
        const body: unknown = await response.json();
        if (response.status === 200 && isObject(body) && typeof body.start === "string") start = body.start;
      } catch {
        start = null;
      }
      // Only to the portal's own HTTPS address, or a loopback one on the workstation.
      let url: URL | null = null;
      try {
        url = start === null ? null : new URL(start);
      } catch {
        url = null;
      }
      if (url === null || !(url.protocol === "https:" || (!online && url.protocol === "http:"))) return refused("unavailable");
      const headers = new Headers({ ...NO_STORE, Location: url.toString(), "Referrer-Policy": "no-referrer" });
      headers.append("Set-Cookie", bindingCookie(reauth ? `${binding}${REAUTH_MARK}` : binding, online, BINDING_DURATION_S));
      return new Response(null, { status: 303, headers });
    },

    async complete(req) {
      const now = clock();
      const spent = [bindingCookie("", online, 0)];
      const carried = readNamedCookie(req.headers.get("cookie"), bindingCookieName(online));
      const reauth = carried !== null && carried.endsWith(REAUTH_MARK);
      const binding = carried === null ? null : reauth ? carried.slice(0, -REAUTH_MARK.length) : carried;
      const code = new URL(req.url).searchParams.get("code") ?? "";
      if (binding === null) return refused("expired", spent);
      if (limiter.global(now) > 0) return refused("busy", spent);

      let assertion: string | null = null;
      let returnTo = "/";
      try {
        const response = await portal.redeem({ code, binding });
        const body: unknown = await response.json();
        if (response.status === 200 && isObject(body) && typeof body.assertion === "string") {
          assertion = body.assertion;
          returnTo = safeReturn(body.returnTo);
        } else if (isObject(body) && body.error === "domain-not-allowed") {
          return refused("domain-not-allowed", spent);
        }
      } catch {
        return refused("unavailable", spent);
      }
      if (assertion === null) return refused("expired", spent);

      // Read here first, for the email the rate limiting counts against: the
      // steward checks it again, and decides.
      const keyNow = await publicKey(now);
      if (keyNow === null) return refused("unavailable", spent);
      const reading = await verifyAssertion(assertion, keyNow, { audience: DASHBOARD_AUDIENCE, nowS: Math.floor(now / 1000) });
      if ("refusal" in reading) {
        key = null;
        return refused("invalid", spent);
      }
      const email = reading.claims.email;

      // A forced sign-in comes back for a session that is open: it unlocks that
      // member's secrets, never opens a session. The steward checks it all
      // again, the email, the forced sign-in, its age, and decides.
      if (reauth) {
        // The session the member left from, kept at begin: the way back from
        // the provider carries no Strict cookie.
        const pending = takePending(bindingKey(binding), now);
        if (pending === null) return backTo(returnTo, "expired", spent);
        if (pending.email !== email) return backTo(returnTo, "another-account", spent);
        const unlocked = await reach(() => steward.unlock(pending.token, assertion!), [pending.token]);
        if (unlocked.kind !== "received") return backTo(returnTo, unlocked.kind === "unavailable" ? "outdated" : "unavailable", spent);
        const token = unlocked.body.token;
        const expiresAt = unlocked.body.expiresAt;
        if (unlocked.status === 200 && typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) && typeof expiresAt === "number") {
          dependencies.unlocks.set(pending.hash, { token, expiresAt });
          return backTo(returnTo, null, spent);
        }
        if (unlocked.status === 401 && unlocked.body.error === "signed-out") return refused("expired", spent);
        const reason = unlocked.status === 429 ? "busy" : unlocked.status === 403 ? "nothing-to-unlock" : unlocked.body.error === "invalid-assertion" ? "refused" : "failed";
        return backTo(returnTo, reason, spent);
      }
      // A sign-in, which opens a session: counted per email. An unlock opens
      // none, and the steward counts its own per member.
      if (limiter.identity(email, now) > 0) return refused("busy", spent);

      const reached = await reach(() => steward.signIn(assertion!));
      if (reached.kind !== "received") return refused(reached.kind === "unavailable" ? "unavailable" : "failed", spent);
      if (reached.status !== 200) {
        if (reached.body.error === "not-a-member") {
          limiter.refused(email, now);
          return refused("not-a-member", spent);
        }
        limiter.refused(email, now);
        return refused(reached.body.error === "invalid-assertion" ? "invalid" : "failed", spent);
      }
      const session = reached.body.session;
      const expiresAt = reached.body.expiresAt;
      const identity = readMemberIdentity(reached.body.identity);
      if (typeof session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session) || typeof expiresAt !== "number" || identity?.email !== email) {
        return refused("failed", spent);
      }
      limiter.succeeded(email);
      store.purgeSessions(now - dependencies.ownerDurationMs, now - dependencies.memberDurationMs);
      await store.recordSession(session, email, now);
      const lifetime = Math.max(0, Math.min(expiresAt - now, dependencies.memberDurationMs));
      const headers = new Headers({ ...NO_STORE, Location: returnTo });
      for (const cookie of [...spent, setCookie(session, online, lifetime)]) headers.append("Set-Cookie", cookie);
      return new Response(null, { status: 303, headers });
    },

    async list(req) {
      const open = await ownerOnly(req, false);
      if (open instanceof Response) return open;
      const now = clock();
      const reached = await reach(() => steward.list());
      const until = tokens.read(open.hash)?.expiresAt ?? null;
      const reading = await read(dependencies.stateFile, now);
      const projects = reading.present
        ? reading.snapshot.sites.map((site) => site.slug).filter((slug) => reservedReason(slug, dependencies.zone) === null).sort()
        : [];
      const offer = await ssoOffer(now);
      const base = { dashboardUrl: publicUrl, providerName: offer.providerName, projects, until };
      if (reached.kind === "unavailable") {
        return json({ available: false, reason: MEMBERS_NOT_AVAILABLE, members: [], signIn: { configured: offer.offered, allowedDomains: [] }, ...base });
      }
      if (reached.kind !== "received" || reached.status !== 200) return relayRefusal(reached);
      return json({ available: true, reason: null, members: reached.body.members, signIn: reached.body.signIn, ...base });
    },

    async put(req) {
      const open = await ownerOnly(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const kept = tokens.read(open.hash);
      if (kept === null) return error(423, "locked", "Unlock first: inviting a member needs the dashboard password.");
      const reached = await reach(() => steward.put({ token: kept.token, email: body.email as string, roles: body.roles as Roles }), [kept.token]);
      if (reached.kind === "received" && reached.status === 401 && reached.body.error === "locked") {
        if (tokens.read(open.hash)?.token === kept.token) tokens.forget(open.hash);
        return error(423, "locked", "Unlock first: inviting a member needs the dashboard password.");
      }
      if (reached.kind !== "received" || (reached.status !== 200 && reached.status !== 201)) return relayRefusal(reached);
      return json({ member: reached.body.member, change: reached.body.change }, reached.status);
    },

    async remove(req) {
      const open = await ownerOnly(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null || typeof body.email !== "string") return error(400, "invalid", "Missing or non-text field: email.");
      const reached = await reach(() => steward.remove(body.email as string));
      if (reached.kind !== "received" || reached.status !== 200) return relayRefusal(reached);
      return json({ member: reached.body.member });
    },

    async restart(req) {
      if (!isAcceptableOrigin(req.headers.get("origin"), publicUrl)) return json({ error: "origin-refused" }, 403);
      const now = clock();
      const resolved = await resolve(req, now);
      if (resolved === "unreachable") return error(502, "failure", "Can't reach the steward.");
      if (resolved === null) return json({ error: "no-session" }, 401);
      if (resolved.identity.kind !== "member") {
        return error(403, "out-of-scope", "The super admin restarts a service from its Secrets section, unlocked.");
      }
      const body = await readBody(req);
      if (body === null || typeof body.slug !== "string") return error(400, "invalid", "Missing or non-text field: slug.");
      // The dashboard judges no role: the steward does, and its refusal comes
      // back as it stands.
      const reached = await reach(() => steward.restart(resolved.token, body.slug as string), [resolved.token]);
      if (reached.kind === "received" && reached.status === 401) {
        // Closed by the steward, a member removed above all: closed here too.
        resolve.forget(resolved.session.hash);
        store.closeSession(resolved.session.hash);
      }
      if (reached.kind !== "received") return relayRefusal(reached);
      return json(reached.body, reached.status);
    },

    async signOut(token) {
      try {
        await (await steward.signOut(token)).text();
      } catch {
        // A mute steward: the dashboard has closed its own row, the steward's
        // session lapses within half a day.
      }
    },

    async restriction(req, now) {
      const resolved = await resolve(req, now);
      if (resolved === null || resolved === "unreachable") return { sites: [], actor: "" };
      return resolved.identity.kind === "owner" ? null : { sites: Object.keys(resolved.identity.roles), actor: resolved.identity.email };
    },

    async roles(req, now) {
      const resolved = await resolve(req, now);
      if (resolved === null) return "no-session";
      if (resolved === "unreachable") return "unreachable";
      return resolved.identity.kind === "owner" ? null : resolved.identity.roles;
    },

    providerName: async (now) => (await ssoOffer(now)).providerName,
  };
}
