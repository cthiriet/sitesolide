/**
 * The /api/passkeys/* routes, built around their dependencies like those of
 * src/routes.ts.
 *
 * The dashboard verifies nothing here: every ceremony goes to the steward,
 * which holds the owner's registry and alone says whether an assertion or a
 * registration checks out (src/passkeys/steward.ts). This process checks the
 * Origin, the session and the shape of the body, adds the unlock token it
 * holds and the client the request came from, relays, and opens the owner's
 * session when the steward says a sign-in, or root's registration link,
 * checked out.
 *
 * - `challenge`: a sign-in's, with no session; an unlock's, for the owner's
 *   session; a registration's, for the unlocked owner or with root's link.
 * - `signin`: a passkey's assertion, which opens the owner's session.
 * - `register`: a new passkey, from the unlocked dashboard or with root's
 *   link, the latter opening the owner's session as a sign-in would.
 * - `list`, `remove`: the owner's passkeys, a removal under the unlock, the
 *   owner's other sessions closed with it.
 */
import { clientKey } from "../auth";
import type { SessionReader } from "../routes";
import { reach, relay } from "../secrets/routes";
import type { Tokens } from "../secrets/tokens";
import { isAcceptableOrigin } from "../sessions";
import type { PasskeyStewardClient } from "./client";
import type { PasskeyState } from "./state";

type Handler = (req: Request) => Promise<Response>;

export type PasskeyRoutes = {
  challenge: Handler;
  signIn: Handler;
  register: Handler;
  list: Handler;
  remove: Handler;
};

export type PasskeyRoutesDependencies = {
  publicUrl: string;
  steward: PasskeyStewardClient;
  /** The owner's sessions alone. */
  session: SessionReader;
  /** The owner's unlock tokens, by session hash, shared with the Secrets section. */
  tokens: Tokens;
  /** The owner's session opened, its cookie set: src/routes.ts, `ownerSessionOpener`. */
  openOwnerSession: (now: number) => Promise<Response>;
  /** Every owner's session but the one kept closed: a passkey removed signs out whoever else held it. */
  closeOtherOwnerSessions: (keptHash: string) => void;
  state: PasskeyState;
};

const NO_CACHE = { "Cache-Control": "no-store" };

/** An assertion or a registration is a few kilobytes: the steward bounds each field to 16 KiB. */
export const MAX_BODY_BYTES = 64 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_CACHE });
const refusedOrigin = () => json({ error: "origin-refused" }, 403);
const missingSession = () => json({ error: "no-session" }, 401);
const locked = () => json({ error: "locked", message: "Unlock first." }, 423);
const invalid = (message: string) => json({ error: "invalid", message }, 400);

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES || req.body === null) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Bun.concatArrayBuffers(chunks)));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isText = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

export function createPasskeyRoutes(dependencies: PasskeyRoutesDependencies, clock: () => number = Date.now): PasskeyRoutes {
  const { steward, session, tokens } = dependencies;

  /** The Origin, then the body: what stands in for an anti-CSRF token (src/sessions.ts). */
  async function posted(req: Request): Promise<Record<string, unknown> | Response> {
    if (!isAcceptableOrigin(req.headers.get("origin"), dependencies.publicUrl)) return refusedOrigin();
    const body = await readBody(req);
    return body === null ? invalid("Unreadable request body.") : body;
  }

  /** The unlock token of the owner's session, or the refusal. */
  async function unlocked(req: Request): Promise<{ hash: string; token: string } | Response> {
    const open = await session(req, clock());
    if (open === null) return missingSession();
    const kept = tokens.read(open.hash);
    return kept === null ? locked() : { hash: open.hash, token: kept.token };
  }

  const client = (req: Request) => clientKey(req.headers.get("x-forwarded-for"));

  return {
    async challenge(req) {
      const body = await posted(req);
      if (body instanceof Response) return body;
      const purpose = body.purpose;
      if (purpose === "signin") return relay(await reach(() => steward.challenge({ purpose, client: client(req) }), null));
      if (purpose === "unlock") {
        if ((await session(req, clock())) === null) return missingSession();
        return relay(await reach(() => steward.challenge({ purpose, client: client(req) }), null));
      }
      if (purpose !== "register") return invalid("purpose must be signin, unlock or register.");
      if (body.link !== undefined) {
        if (!isText(body.link, 128)) return invalid("Unreadable registration link.");
        const link = body.link;
        return relay(await reach(() => steward.challenge({ purpose, client: client(req), link }), null, [link]));
      }
      const owner = await unlocked(req);
      if (owner instanceof Response) return owner;
      return relay(await reach(() => steward.challenge({ purpose, client: client(req), token: owner.token }), owner.token));
    },

    async signIn(req) {
      const body = await posted(req);
      if (body instanceof Response) return body;
      if (!isText(body.challengeId)) return invalid("Missing field: challengeId.");
      const challengeId = body.challengeId;
      const received = await reach(() => steward.signIn({ challengeId, credential: body.credential, client: client(req) }), null);
      if (received.kind !== "received" || received.status !== 200) return relay(received);
      return dependencies.openOwnerSession(clock());
    },

    async register(req) {
      const body = await posted(req);
      if (body instanceof Response) return body;
      if (!isText(body.challengeId)) return invalid("Missing field: challengeId.");
      if (typeof body.name !== "string") return invalid("Missing field: name.");
      const fields = { challengeId: body.challengeId, credential: body.credential, name: body.name, client: client(req) };

      if (body.link !== undefined) {
        if (!isText(body.link, 128)) return invalid("Unreadable registration link.");
        const link = body.link;
        const received = await reach(() => steward.register({ ...fields, link }), null, [link]);
        if (received.kind !== "received" || received.status !== 200) return relay(received);
        dependencies.state.changed();
        // Root's link is the owner's way in with no passkey: it signs them in.
        const opened = await dependencies.openOwnerSession(clock());
        const headers = new Headers(opened.headers);
        return new Response(JSON.stringify(received.body), { status: 200, headers });
      }

      const owner = await unlocked(req);
      if (owner instanceof Response) return owner;
      const received = await reach(() => steward.register({ ...fields, token: owner.token }), owner.token);
      if (received.kind === "received" && received.status === 200) dependencies.state.changed();
      return relay(received);
    },

    async list(req) {
      if ((await session(req, clock())) === null) return missingSession();
      return relay(await reach(() => steward.list(), null));
    },

    async remove(req) {
      const body = await posted(req);
      if (body instanceof Response) return body;
      if (!isText(body.id, 1400)) return invalid("Missing field: id.");
      const id = body.id;
      const owner = await unlocked(req);
      if (owner instanceof Response) return owner;
      const received = await reach(() => steward.remove({ token: owner.token, id }), owner.token);
      if (received.kind === "received" && received.status === 200) {
        dependencies.state.changed();
        dependencies.closeOtherOwnerSessions(owner.hash);
      }
      return relay(received);
    },
  };
}
