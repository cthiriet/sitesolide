/**
 * The dashboard's access routes: a project's general access and guests, the
 * owner's. Built around their dependencies like the others: the tests drive
 * them with a simulated steward.
 *
 *   GET    /api/access?slug=<slug>      the general access and the guests
 *   PUT    /api/access/entry            a guest given password access, with the unlock
 *   DELETE /api/access/entry            a guest taken off
 *   PUT    /api/access/general          public or the code, with the unlock and the slug retyped; a new code, with the unlock; restricted, with neither
 *
 * **The dashboard decides nothing.** It checks the origin of a change, the
 * session and the shape of the request, adds the session's unlock token
 * when it holds one, and relays to the steward, which judges every change
 * and writes the registry. What the dashboard adds is what it already
 * holds: the preview code of a project whose general access is `code`, from
 * its snapshot.
 */
import { reach, type Reached } from "../control/client";
import { read } from "../read";
import type { SessionReader } from "../routes";
import { isAcceptableOrigin } from "../sessions";
import type { Tokens } from "../secrets/tokens";
import type { AccessSteward } from "./client";
import type { AccessPageResponse, AccessResponse } from "./protocol";

type Handler = (req: Request) => Promise<Response>;

export type AccessRoutesDependencies = {
  publicUrl: string;
  stateFile: string;
  steward: AccessSteward;
  session: SessionReader;
  /** The owner's unlock tokens, the Secrets section's. */
  tokens: Tokens;
};

export type AccessRoutes = {
  list: Handler;
  put: Handler;
  remove: Handler;
  general: Handler;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const error = (status: number, code: string, message: string) => json({ error: code, message }, status);

/** What the page says when the steward does not carry the access registry yet. */
export const ACCESS_NOT_AVAILABLE = "The steward on this machine does not keep guests yet: run sitesolide upgrade.";

/** What the page reads when a change needs the unlock. */
export const ACCESS_LOCKED = "Unlock first: giving password access, making a site public, or a code needs it.";

/** Any bigger, it is no change of access. */
const MAX_BODY_BYTES = 16 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The request's JSON object, or null when it is missing, past the bound or not an object. */
async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
    const body: unknown = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function relayed(reached: Reached): Response {
  if (reached.kind === "unreachable") return error(502, "failure", "Can't reach the access service on the server.");
  if (reached.kind === "unavailable") return error(503, "not-available", ACCESS_NOT_AVAILABLE);
  if (reached.kind === "unreadable") return error(502, "failure", "The server sent an unreadable answer.");
  return json(reached.body, reached.status);
}

export function createAccessRoutes(dependencies: AccessRoutesDependencies, clock: () => number = Date.now): AccessRoutes {
  const { steward } = dependencies;

  /** The owner's session hash, the origin checked first for a change; or the refusal. */
  async function owner(req: Request, writing: boolean): Promise<string | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return json({ error: "origin-refused" }, 403);
    const open = await dependencies.session(req, clock());
    return open === null ? json({ error: "no-session" }, 401) : open.hash;
  }

  /** The steward's answer, a forgotten unlock turned into the page's 423. */
  function answer(hash: string, reached: Reached, sentUnlock: string | null): Response {
    if (reached.kind === "received" && reached.status === 401 && reached.body.error === "locked") {
      if (sentUnlock !== null && dependencies.tokens.read(hash)?.token === sentUnlock) dependencies.tokens.forget(hash);
      return error(423, "locked", ACCESS_LOCKED);
    }
    return relayed(reached);
  }

  function oneSlug(req: Request): string | null {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    return wanted.length === 1 && wanted[0] !== "" && wanted[0]!.length <= 128 ? wanted[0]! : null;
  }

  /** The preview code of a project, from the snapshot, when its general access is `code`. */
  async function codeOf(slug: string): Promise<{ code: string; url: string } | null> {
    const reading = await read(dependencies.stateFile, clock());
    if (!reading.present) return null;
    const site = reading.snapshot.sites.find((one) => one.slug === slug);
    return site?.lock.code !== null && site?.lock.code !== undefined && site.lock.url !== null ? { code: site.lock.code, url: site.lock.url } : null;
  }

  return {
    async list(req) {
      const hash = await owner(req, false);
      if (hash instanceof Response) return hash;
      const slug = oneSlug(req);
      if (slug === null) return error(400, "invalid", "Name one project.");
      const reached = await reach(() => steward.list(slug));
      if (reached.kind !== "received" || reached.status !== 200) return answer(hash, reached, null);
      const access = reached.body as unknown as AccessResponse;
      const page: AccessPageResponse = {
        ...access,
        code: access.general?.access === "code" ? await codeOf(slug) : null,
        until: dependencies.tokens.read(hash)?.expiresAt ?? null,
      };
      return json(page);
    },

    async put(req) {
      const hash = await owner(req, true);
      if (hash instanceof Response) return hash;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      const kept = dependencies.tokens.read(hash)?.token ?? null;
      const fields = { slug: body.slug, who: body.who, ...(body.expiresInS === undefined ? {} : { expiresInS: body.expiresInS }) };
      const reached = await reach(() => steward.put({ ...(kept === null ? {} : { token: kept }), ...fields }), kept === null ? [] : [kept]);
      return answer(hash, reached, kept);
    },

    async remove(req) {
      const hash = await owner(req, true);
      if (hash instanceof Response) return hash;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      return answer(hash, await reach(() => steward.remove({ slug: body.slug, who: body.who })), null);
    },

    /**
     * General access, one of the three, or a new code: the gatekeeper
     * changes it, the steward judging. Making a site public and opening it
     * with a code take the unlock and the slug retyped, since either lets in
     * someone who was not; a new code takes the unlock; restricting takes
     * neither, less exposure being refused to nobody. The steward's answer
     * carries the code when the site opens with one: it goes back to the
     * page as it stands, and is written nowhere here.
     */
    async general(req) {
      const hash = await owner(req, true);
      if (hash instanceof Response) return hash;
      const body = await readBody(req);
      if (body === null) return error(400, "invalid", "Unreadable request body.");
      if (body.access !== "public" && body.access !== "restricted" && body.access !== "code") return error(400, "invalid", "access: public, restricted or code.");
      if (typeof body.slug !== "string" || body.slug === "" || body.slug.length > 128) return error(400, "invalid", "Name one project.");
      if (body.renew !== undefined && typeof body.renew !== "boolean") return error(400, "invalid", "renew: true or false.");
      const access: "public" | "restricted" | "code" = body.access;
      const renew = body.renew === true;
      if (renew && access !== "code") return error(400, "invalid", "A new code is for a site that opens with a code.");
      const kept = dependencies.tokens.read(hash)?.token ?? null;
      if (access !== "restricted" && kept === null) return error(423, "locked", ACCESS_LOCKED);
      const fields = { slug: body.slug, access, ...(renew ? { renew } : {}), confirmation: typeof body.confirmation === "string" ? body.confirmation : "" };
      const reached = await reach(() => steward.general({ ...(kept === null ? {} : { token: kept }), ...fields }), kept === null ? [] : [kept]);
      return answer(hash, reached, kept);
    },
  };
}
