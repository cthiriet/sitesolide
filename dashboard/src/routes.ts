/**
 * The routes, built around their dependencies rather than importing them: the
 * tests create as many of them as they have cases to cover, without opening a
 * port or a database. The server, for its part, creates only one.
 */
import { clientKey, createClientLimiter, isPasswordValid, isAcceptableSubmission, type ClientLimiter } from "./auth";
import { read, type Reading } from "./read";
import type { StoreMissing } from "../borrowed/store-protocol";
import { withMissingSecrets } from "./state";
import { memberReading } from "./people/view";
import type { Roles } from "./people/protocol";
import {
  clearCookie,
  readCookie,
  isAcceptableOrigin,
  isMemberSession,
  setCookie,
  isSessionAlive,
  type Session,
} from "./sessions";

export type Store = {
  openSession: (now: number) => Promise<string>;
  readSession: (token: string) => Promise<Session | null>;
  touchSession: (hash: string, now: number) => void;
  closeSession: (hash: string) => void;
  /** The owner's sessions opened before `before`, a member's before `memberBefore`. */
  purgeSessions: (before: number, memberBefore?: number) => void;
};

/**
 * What a password submitted to the sign-in comes to: opens, refused, refused
 * because the owner holds a passkey, or not verified at all.
 */
export type PasswordVerdict = "valid" | "refused" | "passkey-only" | "unavailable";

export type Options = {
  /**
   * The hash in the dashboard's environment: whether a password is
   * configured, and what `verifyPassword` falls back on in a test.
   */
  hash: string;
  /**
   * Who verifies a submitted password: the steward, against the hash as its
   * file holds it now (src/password-check.ts). Absent, `hash` above.
   */
  verifyPassword?: (submitted: string) => Promise<PasswordVerdict>;
  publicUrl: string;
  online: boolean;
  sessionDurationMs: number;
  /** A member's session: half a day, whatever the owner's is. Absent, the owner's. */
  memberSessionDurationMs?: number;
  stateFile: string;
  /**
   * The roles that bound what a session sees of the snapshot: null for the
   * owner, who sees the whole machine. Absent, everyone sees it whole, as
   * before members. See src/people/view.ts.
   */
  roles?: (req: Request, now: number) => Promise<Roles | null | "no-session" | "unreachable">;
  /**
   * The declared names each project's store lacks, read from the steward's
   * listing (src/secrets/missing.ts), or null when it does not answer: they
   * join the snapshot's discrepancies, which the collector cannot see, never
   * reading the store. Absent, the snapshot goes out as the collector left it.
   */
  missingSecrets?: () => Promise<ReadonlyMap<string, StoreMissing> | null>;
  /**
   * Called on signing out a member with their session's token: the steward
   * closes its side and journals it. Never rejects.
   */
  memberSignOut?: (token: string) => Promise<void>;
  /**
   * Called on signing out with the hash of the closed session: the dashboard
   * forgets there the unlocking of the secrets and revokes it at the steward.
   * Never rejects, see src/secrets/routes.ts. Absent, there is nothing to
   * forget.
   */
  forgetUnlock?: (sessionHash: string) => Promise<void>;
  /**
   * Does the password still sign the owner in? Not once a passkey exists
   * (src/passkeys/state.ts): root's registration link is the way back in.
   * Absent, it does.
   */
  passwordSignIn?: () => Promise<boolean>;
  /** The failures counted per client; one of its own otherwise. */
  limiter?: ClientLimiter;
  /**
   * How long an owner's session stays open with nobody using it. Absent, as
   * long as it lives.
   */
  ownerIdleMs?: number;
};

/** Beyond that, the last visit is rewritten. Below it, a page that refreshes
 * every thirty seconds would make one write per refresh for nothing. */
const TOUCH_INTERVAL_MS = 60_000;

const NO_CACHE = { "Cache-Control": "no-store" };

export type Routes = {
  session: (req: Request) => Promise<Response>;
  signIn: (req: Request) => Promise<Response>;
  signOut: (req: Request) => Promise<Response>;
  state: (req: Request) => Promise<Response>;
};

/**
 * The portal's response, returned as it stands to the page: its audit.
 * Unreachable, it is said unreachable: an exception here would return a mute
 * 500.
 */
export async function relay(call: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try {
    response = await call();
  } catch {
    return Response.json({ error: "portal-unreachable" }, { status: 502, headers: NO_CACHE });
  }
  const body = response.status === 204 ? null : await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}

export type SessionReader = (req: Request, now: number) => Promise<Session | null>;

/**
 * The most of a sign-in's body that is read: a password of PASSWORD_MAX
 * characters, each escaped as `\uXXXX`, fits five times over.
 */
export const SIGN_IN_MAX_BYTES = 8 * 1024;

/**
 * The sign-in's body, parsed, or why not. Read piece by piece and given up
 * past SIGN_IN_MAX_BYTES, never held whole: it is the one body read before
 * there is a session, by anyone who sets the Origin header, which a script
 * outside a browser does. Read whole by `req.json()`, which Bun lets reach
 * 128 MB, a hundred megabytes of it are past the service's MemoryMax of
 * 128M: each such attempt would have the service killed, and the owner's
 * dashboard gone for as long as someone kept sending them.
 */
async function readSignInBody(req: Request): Promise<{ body: unknown } | "too-large" | "unreadable"> {
  const announced = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(announced) || announced > SIGN_IN_MAX_BYTES) return "too-large";
  if (req.body === null) return "unreadable";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      bytes += part.value.byteLength;
      if (bytes > SIGN_IN_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(part.value);
    }
    return { body: JSON.parse(new TextDecoder().decode(Bun.concatArrayBuffers(chunks))) };
  } catch {
    return "unreadable";
  }
}

/**
 * The request's session, or null. An expired session is closed rather than left
 * lying about: the purge at sign-in only happens when somebody signs in.
 *
 * Built apart so that the secrets routes check the session by this same path
 * rather than by a copy, which would end up diverging.
 *
 * It reads the owner's sessions and the members' alike: `ownerSessions` keeps
 * the first alone, for every route that is the owner's.
 */
export function createSessionReader(
  store: Pick<Store, "readSession" | "touchSession" | "closeSession">,
  options: Pick<Options, "online" | "sessionDurationMs" | "memberSessionDurationMs" | "ownerIdleMs">,
): SessionReader {
  return async (req, now) => {
    const token = readCookie(req.headers.get("cookie"), options.online);
    if (token === null) return null;

    const found = await store.readSession(token);
    if (found === null) return null;

    if (!isSessionAlive(found, options.sessionDurationMs, now, options.memberSessionDurationMs, options.ownerIdleMs)) {
      store.closeSession(found.hash);
      return null;
    }

    if (now - found.seenAt > TOUCH_INTERVAL_MS) {
      store.touchSession(found.hash, now);
    }
    return found;
  };
}

/**
 * The same reader, for the owner's sessions alone: a member's reads as no
 * session. Every route that is the owner's takes this one, so that a
 * route forgetting to ask who is signed in still refuses a member.
 */
export function ownerSessions(reader: SessionReader): SessionReader {
  return async (req, now) => {
    const found = await reader(req, now);
    return found !== null && !isMemberSession(found) ? found : null;
  };
}

/**
 * The owner's session opened, the expired ones purged first, and the answer
 * that sets its cookie: what a password and a passkey sign-in both end on.
 */
export function ownerSessionOpener(
  store: Pick<Store, "openSession" | "purgeSessions">,
  options: Pick<Options, "online" | "sessionDurationMs" | "memberSessionDurationMs">,
): (now: number) => Promise<Response> {
  return async (now) => {
    store.purgeSessions(now - options.sessionDurationMs, now - (options.memberSessionDurationMs ?? options.sessionDurationMs));
    const token = await store.openSession(now);
    return Response.json({ open: true }, { headers: { "Set-Cookie": setCookie(token, options.online, options.sessionDurationMs), ...NO_CACHE } });
  };
}

export function createRoutes(store: Store, options: Options, clock: () => number = Date.now): Routes {
  const session = createSessionReader(store, options);
  const limiter = options.limiter ?? createClientLimiter();
  const openOwnerSession = ownerSessionOpener(store, options);
  const verify = options.verifyPassword ?? (async (submitted: string): Promise<PasswordVerdict> => ((await isPasswordValid(submitted, options.hash)) ? "valid" : "refused"));

  /**
   * The password attempts go through one by one, from the reading of the
   * counter to its writing. Without that, a burst read in one go would go
   * through in its entirety before the first failure is counted, and each
   * attempt would launch its argon2id at the same time as the others: the
   * steward's bench measured that two simultaneous verifications are enough to
   * get a service killed under MemoryMax=128M, this one's limit. The body
   * is read before the queue: a slow client makes nobody wait there.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  /** The reading with the names the stores lack among its discrepancies, when the steward says them. */
  async function withSecrets(reading: Reading): Promise<Reading> {
    if (!reading.present || options.missingSecrets === undefined) return reading;
    const missing = await options.missingSecrets();
    return missing === null ? reading : { ...reading, snapshot: withMissingSecrets(reading.snapshot, missing) };
  }

  return {
    /**
     * Enough to know whether to display the form or the dashboard, with no
     * prior session.
     *
     * `configured` says that a hash is in place. Giving it without a session
     * teaches a visitor that the service is badly configured, which gives him
     * nothing: without a hash, nobody gets in. In exchange, the page says why
     * it refuses instead of leaving one to search.
     */
    async session(req) {
      const now = clock();
      return Response.json({
        open: (await session(req, now)) !== null,
        configured: options.hash !== "",
      });
    },

    async signIn(req) {
      // The only check that exists before there is a session. Without it, any
      // page at all could aim at this endpoint and make failed attempts in the
      // visitor's name.
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }

      // Once the owner holds a passkey, the password signs nobody in: asked
      // before the body is read, it costs no verification either.
      if (options.passwordSignIn !== undefined && !(await options.passwordSignIn())) {
        return Response.json({ error: "passkey-only", message: "This dashboard signs in with a passkey." }, { status: 403 });
      }

      const read = await readSignInBody(req);
      if (read === "too-large") return Response.json({ error: "too-large" }, { status: 413 });
      if (read === "unreadable") return Response.json({ error: "unreadable-body" }, { status: 400 });

      const submitted = (read.body as { password?: unknown } | null)?.password;
      if (!isAcceptableSubmission(submitted)) {
        return Response.json({ error: "no-password" }, { status: 400 });
      }

      // Per client, the address Caddy saw: a stranger's wrong passwords make
      // that stranger wait, never the owner.
      const client = clientKey(req.headers.get("x-forwarded-for"));

      return oneAtATime(async () => {
        // The time is re-read once its turn has come: the wait of an attempt
        // in the queue must not shorten the rate limiting of the next one.
        const now = clock();
        const wait = limiter.wait(client, now);
        if (wait > 0) {
          return Response.json(
            { error: "too-many-attempts", wait: Math.ceil(wait / 1000) },
            { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
          );
        }

        const verdict = await verify(submitted);
        if (verdict === "passkey-only") {
          return Response.json({ error: "passkey-only", message: "This dashboard signs in with a passkey." }, { status: 403 });
        }
        if (verdict === "unavailable") {
          // Nothing was verified: not counted against the client.
          return Response.json({ error: "unavailable", message: "The sign-in cannot be verified right now, try again in a moment." }, { status: 503 });
        }
        if (verdict !== "valid") {
          limiter.failed(client, now);
          // A single message for every cause: wrong password, missing hash,
          // malformed hash. What the service knows of its own configuration is
          // not learned here.
          return Response.json({ error: "refused" }, { status: 401 });
        }

        limiter.succeeded(client);
        return openOwnerSession(now);
      });
    },

    async signOut(req) {
      const now = clock();
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }

      const open = await session(req, now);
      if (open !== null) {
        store.closeSession(open.hash);
        if (isMemberSession(open)) {
          // The steward holds the member's session too: it closes its side
          // and journals the sign-out under the member's email.
          const token = readCookie(req.headers.get("cookie"), options.online);
          if (token !== null) await options.memberSignOut?.(token);
        } else {
          // Failing which the steward's token would survive the session that
          // obtained it, until its expiry.
          await options.forgetUnlock?.(open.hash);
        }
      }

      // The cookie is erased even without a session: an already expired
      // session otherwise leaves a dead cookie in the browser.
      return Response.json(
        { open: false },
        { headers: { "Set-Cookie": clearCookie(options.online) } },
      );
    },

    async state(req) {
      const now = clock();
      if ((await session(req, now)) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }
      // A member sees their projects alone; the owner, the whole machine.
      const roles = options.roles === undefined ? null : await options.roles(req, now);
      if (roles === "no-session") return Response.json({ error: "no-session" }, { status: 401 });
      if (roles === "unreachable") {
        return Response.json({ error: "failure", message: "Can't reach the server to say what this person may see." }, { status: 502 });
      }

      const reading = await withSecrets(await read(options.stateFile, now));
      // Nothing in this dashboard is to be kept: it describes an instant.
      return Response.json(roles === null ? reading : memberReading(reading, roles), { headers: NO_CACHE });
    },
  };
}
