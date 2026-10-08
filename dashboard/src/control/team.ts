/**
 * The Tokens page's routes, `/api/tokens`: the owner's side of the control API,
 * behind the dashboard's session like every other page. The owner makes a
 * token for themselves, or for a person of People (`holder`), which the
 * steward mints within that person's roles.
 *
 * Same stance as src/secrets/routes.ts: the dashboard checks the origin, the
 * session and the shape of the body, adds the unlock token it holds, and
 * relays. The steward decides what a token may be, and its refusal comes back
 * to the page as it stands.
 *
 * **Creating a token demands the dashboard unlocked**, the same ten-minute
 * unlock as the Secrets section, held in the same place: a token can run code
 * on the machine, it deserves the password retyped. The token's value comes
 * back once, in the answer to the creation, and is never stored here.
 *
 * Every creation and revocation goes into the audit, actor `owner`. A
 * person's own tokens answer at the same addresses through
 * src/people/relay.ts, and the steward journals them under their email.
 */
import type { SessionReader } from "../routes";
import { isAcceptableOrigin, type Session } from "../sessions";
import type { Tokens } from "../secrets/tokens";
import { reach, type ControlSteward } from "./client";
import type { Scope, TeamPageResponse, TokenView } from "./protocol";
import type { ControlStore } from "./store";

export type TeamDependencies = {
  session: SessionReader;
  publicUrl: string;
  steward: ControlSteward;
  /** The unlock tokens of the Secrets section, shared: one unlock opens both. */
  tokens: Tokens;
  store: ControlStore;
};

type Handler = (req: Request) => Promise<Response>;

export type TeamRoutes = { team: Handler; createToken: Handler; revokeToken: Handler };

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > 16 * 1024) return null;
  try {
    const text = await req.text();
    if (text.length > 16 * 1024) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** What the page says when the steward does not carry the control routes yet. */
export const NOT_AVAILABLE_REASON =
  "The steward on this machine does not have the control API yet: run sitesolide upgrade, then sitesolide setup again for this machine, without --minimal if the installer is missing.";

export function createTeamRoutes(dependencies: TeamDependencies, clock: () => number = Date.now): TeamRoutes {
  const { session, publicUrl, steward, tokens, store } = dependencies;

  async function check(req: Request, writing: boolean): Promise<Session | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), publicUrl)) return json({ error: "origin-refused" }, 403);
    return (await session(req, clock())) ?? json({ error: "no-session" }, 401);
  }

  function relayRefusal(reached: Awaited<ReturnType<typeof reach>>): Response {
    if (reached.kind === "unreachable") return error(502, "failure", "Can't reach the token service on the server.");
    if (reached.kind === "unavailable") return error(503, "not-available", NOT_AVAILABLE_REASON);
    if (reached.kind === "unreadable") return error(502, "failure", "The server sent an unreadable answer.");
    return json({ error: reached.body.error, message: reached.body.message }, reached.status);
  }

  return {
    /** The tokens, the end of this session's unlock, and what happened lately. */
    async team(req) {
      const open = await check(req, false);
      if (open instanceof Response) return open;
      const reached = await reach(() => steward.listTokens());
      const deployments = store.recent(20).map(({ manifest: _manifest, ...row }) => row);
      const audit = store.listAudit(50).filter((entry) => entry.action.startsWith("token.") || entry.action.startsWith("deploy."));
      const until = tokens.read(open.hash)?.expiresAt ?? null;
      if (reached.kind === "unavailable") {
        return json({ available: false, reason: NOT_AVAILABLE_REASON, member: null, tokens: [], until, deployments, audit } satisfies TeamPageResponse);
      }
      if (reached.kind !== "received" || reached.status !== 200) return relayRefusal(reached);
      if (!Array.isArray(reached.body.tokens)) return error(502, "failure", "The server sent an unreadable answer.");
      return json({ available: true, reason: null, member: null, tokens: reached.body.tokens as TokenView[], until, deployments, audit } satisfies TeamPageResponse);
    },

    async createToken(req) {
      const open = await check(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const kept = tokens.read(open.hash);
      if (kept === null) return error(423, "locked", "Unlock first: creating a token needs the dashboard password.");

      const { label, holder, expiresAt, scope } = body;
      const reached = await reach(
        () => steward.createToken({ token: kept.token, label: label as string, holder: holder as string, expiresAt: expiresAt as number | null, scope: scope as Scope }),
        [kept.token],
      );
      if (reached.kind === "received" && reached.status === 401 && reached.body.error === "locked") {
        if (tokens.read(open.hash)?.token === kept.token) tokens.forget(open.hash);
        return error(423, "locked", "Unlock first: creating a token needs the dashboard password.");
      }
      if (reached.kind !== "received" || reached.status !== 201) return relayRefusal(reached);
      const created = reached.body.token as TokenView;
      store.recordAudit({
        at: clock(),
        actor: "owner",
        action: "token.create",
        target: null,
        detail: { id: created.id, label: created.label, email: created.email, member: created.member, expiresAt: created.expiresAt, scope: created.scope },
      });
      return json({ token: created, secret: reached.body.secret }, 201);
    },

    async revokeToken(req) {
      const open = await check(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null || typeof body.id !== "string") return error(400, "invalid", "Missing or non-text field: id.");
      const reached = await reach(() => steward.revokeToken(body.id as string));
      if (reached.kind !== "received" || reached.status !== 200) return relayRefusal(reached);
      const revoked = reached.body.token as TokenView;
      store.recordAudit({
        at: clock(),
        actor: "owner",
        action: "token.revoke",
        target: null,
        detail: { id: revoked.id, label: revoked.label, email: revoked.email },
      });
      return json({ token: revoked });
    },
  };
}
