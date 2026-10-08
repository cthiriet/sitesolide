/**
 * The dashboard's routes, as a person who signs in reaches them: a site's
 * Secrets, its general access and its Backups, and their own tokens. The
 * same addresses as the owner's, which server.ts sends here when the session
 * is a person's: the page asks the same routes, whoever is signed in. Their
 * people with access are src/access/routes.ts's.
 *
 * **The dashboard decides nothing a person could use to do more.** It checks
 * the origin, the session and the shape of a request, adds the person's
 * session and unlock token, and relays to the steward, which judges every
 * write and every secret read by role (src/people/actions.ts) and names the
 * person in its journal. What the dashboard does decide is what a person
 * sees of what it already holds: the backups, reduced to the projects where
 * their role shows them (powers.ts, the steward's own table). A compromised
 * dashboard reads all of it anyway, as it always could; it never reads a
 * secret value a person's role does not reach, which only the steward hands
 * out.
 *
 * **A person's unlock token is the steward's**, drawn when a forced sign-in
 * checks out (routes.ts, `complete`), kept here in memory by the session's
 * hash, as the owner's is, and never sent to the browser.
 *
 * **A person's own tokens** answer at the Tokens page's addresses too: their
 * tokens alone, minted under their unlock within their roles, revoked
 * without it. The steward judges and journals each (src/control/steward.ts);
 * the dashboard adds what it keeps itself, the deployments of those tokens.
 */
import { tokenHash } from "../sessions";
import { isAcceptableOrigin } from "../sessions";
import { fields, reach, relay, type Extraction, type Received } from "../secrets/routes";
import type { Steward } from "../secrets/client";
import type { Tokens } from "../secrets/tokens";
import type { BackupSteward } from "../backup/client";
import type { ControlStore } from "../control/store";
import type { TeamPageResponse, TokenView } from "../control/protocol";
import type { MembersSteward } from "./client";
import type { Identity, IdentityResolver, Resolved } from "./identity";
import { may, type Power } from "./powers";
import type { Role, Roles } from "./protocol";

type Handler = (req: Request) => Promise<Response>;

export type MemberRelayDependencies = {
  publicUrl: string;
  resolve: IdentityResolver & { forget: (hash: string) => void };
  closeSession: (hash: string) => void;
  steward: Pick<MembersSteward, "act" | "lock">;
  /** The members' unlock tokens, by session hash: never the owner's store. */
  tokens: Tokens;
  secrets: Pick<Steward, "readLog">;
  backups: Pick<BackupSteward, "readBackups" | "readBackupAudit">;
  /** The deployments and the audit the dashboard keeps, for a member's Tokens page: those of their own tokens. */
  control: Pick<ControlStore, "recent" | "listAudit">;
};

export type MemberRelay = {
  secrets: Handler;
  secretsLog: Handler;
  unlock: Handler;
  lock: Handler;
  readValue: Handler;
  setVariable: Handler;
  removeVariable: Handler;
  createFile: Handler;
  restoreFile: Handler;
  readContent: Handler;
  replaceContent: Handler;
  togglePortal: Handler;
  backups: Handler;
  backupAudit: Handler;
  restoreBackup: Handler;
  team: Handler;
  createToken: Handler;
  revokeToken: Handler;
  /** Not a route: a member signing out, their unlock forgotten here and locked at the steward. */
  forgetUnlock: (sessionToken: string) => Promise<void>;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

/** What the page reads when a member's unlock is missing: where a forced sign-in begins. */
export const MEMBER_LOCKED = "Unlock first: sign in again with your provider.";

const locked = () => error(423, "locked", MEMBER_LOCKED);

/** What a member's Tokens page says when the steward predates members' tokens. */
export const TOKENS_OUTDATED = "This server's steward doesn't know personal tokens yet. Ask the owner to run sitesolide upgrade.";

/** Beyond that, it is not a site name. */
const MAX_SLUG = 128;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONTENT_BODY_BYTES = 512 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > max) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** The one slug a query names, or null. */
function oneSlug(req: Request): string | null {
  const wanted = new URL(req.url).searchParams.getAll("slug");
  return wanted.length === 1 && wanted[0] !== "" && wanted[0]!.length <= MAX_SLUG ? wanted[0]! : null;
}

function roleOn(roles: Roles, slug: string): Role | null {
  return Object.hasOwn(roles, slug) ? roles[slug]! : null;
}

const extractPortal: Extraction<{ slug: string; confirmation: string; active: boolean }> = (body) => {
  const names = fields(["slug", "confirmation"] as const)(body);
  if (names instanceof Response) return names;
  if (typeof body!.active !== "boolean") return error(400, "invalid", "Missing or non-boolean field: active.");
  return { ...names, active: body!.active };
};

export function createMemberRelay(dependencies: MemberRelayDependencies, clock: () => number = Date.now): MemberRelay {
  const { steward, tokens, resolve } = dependencies;

  type Open = { session: { hash: string }; token: string; identity: Extract<Identity, { kind: "member" }> };

  /** The member behind the request, the origin checked first for a change; or the refusal. */
  async function member(req: Request, writing: boolean): Promise<Open | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
    const resolved: Resolved = await resolve(req, clock());
    if (resolved === "unreachable") return error(502, "failure", "Can't reach the steward to say who this person is.");
    if (resolved === null) return json({ error: "no-session" }, 401);
    if (resolved.identity.kind !== "member") return error(403, "out-of-scope", "This route is a member's.");
    return { session: resolved.session, token: resolved.token, identity: resolved.identity };
  }

  /** A session the steward closed, a member removed above all: closed here too. */
  function closed(open: Open): Response {
    resolve.forget(open.session.hash);
    tokens.forget(open.session.hash);
    dependencies.closeSession(open.session.hash);
    return json({ error: "no-session" }, 401);
  }

  /** The steward's answer to the page, a closed session closing this one. */
  function answer(open: Open, received: Received, kept: { token: string } | null = null): Response {
    if (received.kind === "received" && received.status === 401) {
      if (received.body?.error === "signed-out") return closed(open);
      if (received.body?.error === "locked") {
        if (kept !== null && tokens.read(open.session.hash)?.token === kept.token) tokens.forget(open.session.hash);
        return locked();
      }
    }
    return relay(received);
  }

  /** A route that acts under the member's unlock: without it, 423, the steward not disturbed. */
  function withToken<D extends object>(extract: Extraction<D>, method: "POST" | "PUT" | "DELETE", path: string, options: { max?: number; long?: boolean } = {}): Handler {
    return async (req) => {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const read = extract(await readBody(req, options.max));
      if (read instanceof Response) return read;
      const kept = tokens.read(open.session.hash);
      if (kept === null) return locked();
      const received = await reach(() => steward.act(method, path, { ...read, session: open.token, token: kept.token }, options.long), kept.token, [open.token]);
      return answer(open, received, kept);
    };
  }

  /** A route of the member's session alone, no unlock: sharing, guests, a role taken away. */
  async function withSession(open: Open, method: "POST" | "PUT" | "DELETE", path: string, body: object): Promise<Response> {
    const received = await reach(() => steward.act(method, path, { ...body, session: open.token }), null, [open.token]);
    return answer(open, received);
  }

  /** May the member see this project's part? The page offers it only then; the steward refuses the rest anyway. */
  function mayOn(open: Open, slug: string, power: Power): Response | null {
    return may(roleOn(open.identity.roles, slug), power) ? null : error(403, "out-of-scope", `This part of ${slug} isn't yours: ask one of its Admins.`);
  }

  return {
    async secrets(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const received = await reach(() => steward.act("POST", "/members/secrets/projects", { session: open.token }), null, [open.token]);
      if (received.kind !== "received" || received.status !== 200) return answer(open, received);
      const projects = received.body?.projects;
      if (!Array.isArray(projects)) return error(502, "failure", "The steward sent an unreadable answer.");
      return json({ projects, until: tokens.read(open.session.hash)?.expiresAt ?? null });
    },

    async secretsLog(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "secrets.list");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.secrets.readLog(slug), null));
    },

    async unlock(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      return error(400, "reauthenticate", "A person unlocks by signing in again with their provider.");
    },

    async lock(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const kept = tokens.forget(open.session.hash);
      if (kept !== null) {
        try {
          await (await steward.lock(open.token, kept.token)).text();
        } catch {
          // A mute steward: the token is forgotten here, and lapses there.
        }
      }
      return new Response(null, { status: 204, headers: NO_STORE });
    },

    readValue: withToken(fields(["slug", "file", "variable"] as const), "POST", "/members/secrets/value", { long: true }),
    setVariable: withToken(fields(["slug", "file", "variable", "value"] as const), "PUT", "/members/secrets/variable", { long: true }),
    removeVariable: withToken(fields(["slug", "file", "variable"] as const), "DELETE", "/members/secrets/variable", { long: true }),
    createFile: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/file", { long: true }),
    restoreFile: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/restore", { long: true }),
    readContent: withToken(fields(["slug", "file"] as const), "POST", "/members/secrets/content", { long: true }),
    replaceContent: withToken(fields(["slug", "file", "content"] as const), "PUT", "/members/secrets/content", { long: true, max: MAX_CONTENT_BODY_BYTES }),
    togglePortal: withToken(extractPortal, "POST", "/members/portal", { long: true }),
    restoreBackup: withToken(fields(["slug", "snapshot", "confirmation"] as const), "POST", "/members/backups/restore", { long: true }),

    async backups(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "backups");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.backups.readBackups(slug), null));
    },

    async backupAudit(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one site.");
      const refusal = mayOn(open, slug, "backups");
      if (refusal !== null) return refusal;
      return relay(await reach(() => dependencies.backups.readBackupAudit(slug), null));
    },

    /**
     * The member's Tokens page: their tokens, what they may mint them for, and
     * the deployments those tokens made. A steward that predates members'
     * tokens is said, as for the owner.
     */
    async team(req) {
      const open = await member(req, false);
      if (open instanceof Response) return open;
      const received = await reach(() => steward.act("POST", "/team/member/list", { session: open.token }), null, [open.token]);
      const until = tokens.read(open.session.hash)?.expiresAt ?? null;
      const self = { email: open.identity.email, roles: open.identity.roles, create: open.identity.create };
      if (received.kind === "received" && received.status === 404 && received.body?.message === "no such route") {
        const page: TeamPageResponse = { available: false, reason: TOKENS_OUTDATED, member: self, tokens: [], until, deployments: [], audit: [] };
        return json(page);
      }
      if (received.kind !== "received" || received.status !== 200) return answer(open, received);
      const listed = received.body?.tokens;
      const rights = received.body?.rights;
      if (!Array.isArray(listed) || !isObject(rights)) return error(502, "failure", "The steward sent an unreadable answer.");
      const mine = listed as TokenView[];
      const ids = new Set(mine.map((token) => token.id));
      const deployments = dependencies.control
        .recent(200)
        .filter((row) => ids.has(row.tokenId))
        .slice(0, 20)
        .map(({ manifest: _manifest, ...row }) => row);
      const audit = dependencies.control
        .listAudit(500, "deploy.")
        .filter((entry) => entry.actor.startsWith("token:") && ids.has(entry.actor.slice("token:".length)))
        .slice(0, 50);
      const page: TeamPageResponse = {
        available: true,
        reason: null,
        member: { email: open.identity.email, roles: (rights.roles ?? open.identity.roles) as Roles, create: rights.create === true },
        tokens: mine,
        until,
        deployments,
        audit,
      };
      return json(page);
    },

    async createToken(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const kept = tokens.read(open.session.hash);
      if (kept === null) return locked();
      const { label, expiresAt, scope } = body;
      const received = await reach(
        () => steward.act("POST", "/team/member/tokens", { session: open.token, token: kept.token, label, expiresAt, scope }),
        kept.token,
        [open.token],
      );
      return answer(open, received, kept);
    },

    async revokeToken(req) {
      const open = await member(req, true);
      if (open instanceof Response) return open;
      const body = await readBody(req);
      if (body === null || typeof body.id !== "string") return error(400, "invalid", "Missing or non-text field: id.");
      return withSession(open, "POST", "/team/member/revoke", { id: body.id });
    },

    async forgetUnlock(sessionToken) {
      const kept = tokens.forget(await tokenHash(sessionToken));
      if (kept === null) return;
      try {
        await (await steward.lock(sessionToken, kept.token)).text();
      } catch {
        // A mute steward: the token lapses there within ten minutes.
      }
    },
  };
}
