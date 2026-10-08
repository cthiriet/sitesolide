/**
 * Who is behind a request: the owner, whoever typed the dashboard's password,
 * or a member, as the steward reads its registry now.
 *
 * The session row says which, by its identity column. For a member it is not
 * enough: the steward holds the member's session and their roles, and a member
 * removed or a role taken away must hold at once for what they see too, not
 * only for what they write. So a member's request asks the steward who the
 * session belongs to, and the answer is kept a few seconds, the page asking
 * twice a minute and more on each navigation.
 *
 * Built around its correspondents: the tests hand it a simulated steward.
 */
import type { SessionReader } from "../routes";
import { isMemberSession, readCookie, type Session } from "../sessions";
import type { MembersSteward } from "./client";
import type { MemberIdentity } from "./protocol";

export type Identity = { kind: "owner" } | (MemberIdentity & { expiresAt: number });

/**
 * `null`: no session, or a member's the steward no longer knows, which is then
 * closed here too. `unreachable`: the steward did not answer, nothing is
 * closed, and the route says so rather than signing anyone out.
 */
export type Resolved = { session: Session; token: string; identity: Identity } | null | "unreachable";

export type IdentityResolver = (req: Request, now: number) => Promise<Resolved>;

/** How long the steward's answer about a member is kept. */
export const WHOAMI_CACHE_MS = 5_000;
/** Answers kept at most. */
const MAX_CACHED = 1000;

export type IdentityDependencies = {
  session: SessionReader;
  online: boolean;
  steward: Pick<MembersSteward, "whoami">;
  /** Closes the dashboard's row of a session the steward no longer knows. */
  closeSession: (hash: string) => void;
  cacheMs?: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The steward's identity, read and judged again: a shape it would not send is no identity. */
export function readMemberIdentity(value: unknown): MemberIdentity | null {
  if (!isObject(value) || value.kind !== "member" || typeof value.email !== "string" || !isObject(value.roles)) return null;
  const roles: Record<string, "viewer" | "developer" | "admin"> = {};
  for (const [slug, role] of Object.entries(value.roles)) {
    if (role !== "viewer" && role !== "developer" && role !== "admin") return null;
    roles[slug] = role;
  }
  const name = typeof value.name === "string" ? value.name : null;
  // A steward from before the create right says nothing of it: none.
  return { kind: "member", email: value.email, name, roles, create: value.create === true };
}

export function createIdentityResolver(dependencies: IdentityDependencies): IdentityResolver & { forget: (hash: string) => void } {
  const cacheMs = dependencies.cacheMs ?? WHOAMI_CACHE_MS;
  const cache = new Map<string, { at: number; identity: Identity }>();

  const resolve = async (req: Request, now: number): Promise<Resolved> => {
    const session = await dependencies.session(req, now);
    if (session === null) return null;
    const token = readCookie(req.headers.get("cookie"), dependencies.online);
    if (token === null) return null;
    if (!isMemberSession(session)) return { session, token, identity: { kind: "owner" } };

    const kept = cache.get(session.hash);
    if (kept !== undefined && now - kept.at < cacheMs) return { session, token, identity: kept.identity };

    let response: Response;
    let body: unknown;
    try {
      response = await dependencies.steward.whoami(token);
      body = await response.json();
    } catch {
      return "unreachable";
    }
    if (response.status === 401) {
      cache.delete(session.hash);
      dependencies.closeSession(session.hash);
      return null;
    }
    if (response.status !== 200 || !isObject(body)) return "unreachable";
    const identity = readMemberIdentity(body.identity);
    const expiresAt = body.expiresAt;
    // The steward speaks for the session the dashboard recorded: an answer
    // about someone else is no answer.
    if (identity === null || identity.email !== session.identity || typeof expiresAt !== "number") return "unreachable";
    const resolved: Identity = { ...identity, expiresAt };
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(session.hash, { at: now, identity: resolved });
    return { session, token, identity: resolved };
  };

  return Object.assign(resolve, { forget: (hash: string) => void cache.delete(hash) });
}
