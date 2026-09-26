/**
 * The routes, built around their dependencies rather than importing them: the
 * tests create as many of them as they have cases to cover, without opening a
 * port or a database. The server, for its part, creates only one.
 */
import { remainingWait, isPasswordValid, isAcceptableSubmission } from "./auth";
import { invitableHosts, type Portal } from "./guests";
import { read } from "./read";
import {
  clearCookie,
  readCookie,
  isAcceptableOrigin,
  setCookie,
  isSessionAlive,
  type Session,
} from "./sessions";

export type Store = {
  openSession: (now: number) => Promise<string>;
  readSession: (token: string) => Promise<Session | null>;
  touchSession: (hash: string, now: number) => void;
  closeSession: (hash: string) => void;
  purgeSessions: (before: number) => void;
  readAttempts: () => { failures: number; lastAt: number };
  setAttempts: (failures: number, lastAt: number) => void;
};

export type Options = {
  hash: string;
  publicUrl: string;
  online: boolean;
  sessionDurationMs: number;
  stateFile: string;
  portal: Portal;
  /**
   * Called on signing out with the hash of the closed session: the dashboard
   * forgets there the unlocking of the secrets and revokes it at the steward.
   * Never rejects, see src/secrets/routes.ts. Absent, there is nothing to
   * forget.
   */
  forgetUnlock?: (sessionHash: string) => Promise<void>;
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
  guests: (req: Request) => Promise<Response>;
  createGuest: (req: Request) => Promise<Response>;
  revokeGuest: (req: Request, id: string) => Promise<Response>;
};

/**
 * The portal's response, returned as it stands to the page. Unreachable, it is
 * said unreachable: an exception here would return a mute 500.
 */
async function relay(call: () => Promise<Response>): Promise<Response> {
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
 * The request's session, or null. An expired session is closed rather than left
 * lying about: the purge at sign-in only happens when somebody signs in.
 *
 * Built apart so that the secrets routes check the session by this same path
 * rather than by a copy, which would end up diverging.
 */
export function createSessionReader(
  store: Pick<Store, "readSession" | "touchSession" | "closeSession">,
  options: Pick<Options, "online" | "sessionDurationMs">,
): SessionReader {
  return async (req, now) => {
    const token = readCookie(req.headers.get("cookie"), options.online);
    if (token === null) return null;

    const found = await store.readSession(token);
    if (found === null) return null;

    if (!isSessionAlive(found, options.sessionDurationMs, now)) {
      store.closeSession(found.hash);
      return null;
    }

    if (now - found.seenAt > TOUCH_INTERVAL_MS) {
      store.touchSession(found.hash, now);
    }
    return found;
  };
}

export function createRoutes(store: Store, options: Options, clock: () => number = Date.now): Routes {
  const session = createSessionReader(store, options);

  /**
   * The password attempts go through one by one, from the reading of the
   * counter to its writing. Without that, a burst read in one go would go
   * through in its entirety before the first failure is counted, and each
   * attempt would launch its argon2id at the same time as the others: the
   * steward's bench measured that two simultaneous verifications are enough to
   * get a service killed under MemoryMax=128M, this one's limit
   * (the bench results). The body is read before the queue: a
   * slow client makes nobody wait there.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
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
      // page at all could aim at this endpoint and, through failed attempts
      // made in the visitor's name, shut the door on the real user for an
      // hour: the failure counter is global.
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "unreadable-body" }, { status: 400 });
      }

      const submitted = (body as { password?: unknown } | null)?.password;
      if (!isAcceptableSubmission(submitted)) {
        return Response.json({ error: "no-password" }, { status: 400 });
      }

      return oneAtATime(async () => {
        // The time is re-read once its turn has come: the wait of an attempt
        // in the queue must not shorten the rate limiting of the next one.
        const now = clock();
        const attempts = store.readAttempts();
        const wait = remainingWait(attempts.failures, attempts.lastAt, now);
        if (wait > 0) {
          return Response.json(
            { error: "too-many-attempts", wait: Math.ceil(wait / 1000) },
            { status: 429, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } },
          );
        }

        if (!(await isPasswordValid(submitted, options.hash))) {
          store.setAttempts(attempts.failures + 1, now);
          // A single message for every cause: wrong password, missing hash,
          // malformed hash. What the service knows of its own configuration is
          // not learned here.
          return Response.json({ error: "refused" }, { status: 401 });
        }

        store.setAttempts(0, 0);
        store.purgeSessions(now - options.sessionDurationMs);
        const token = await store.openSession(now);

        return Response.json(
          { open: true },
          { headers: { "Set-Cookie": setCookie(token, options.online, options.sessionDurationMs) } },
        );
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
        // Failing which the steward's token would survive the session that
        // obtained it, until its expiry.
        await options.forgetUnlock?.(open.hash);
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

      const reading = await read(options.stateFile, now);
      // Nothing in this dashboard is to be kept: it describes an instant.
      return Response.json(reading, { headers: { "Cache-Control": "no-store" } });
    },

    async guests(req) {
      if ((await session(req, clock())) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }
      return relay(() => options.portal.list());
    },

    /**
     * The origin before the session, as for signing in: it is what stands in
     * for an anti-CSRF token, see src/sessions.ts.
     *
     * The host is confronted with the snapshot, the portal not knowing which
     * sites it protects: it would sign an access for any name at all. The
     * label and the duration, for their part, are judged by the portal, which
     * applies them.
     */
    async createGuest(req) {
      const now = clock();
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }
      if ((await session(req, now)) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }

      let body: { host?: unknown; label?: unknown; durationS?: unknown } | null;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "unreadable-body" }, { status: 400 });
      }

      const host = body?.host;
      const reading = await read(options.stateFile, now);
      if (typeof host !== "string" || !reading.present || !invitableHosts(reading.snapshot).includes(host)) {
        return Response.json({ error: "no-portal" }, { status: 400 });
      }

      return relay(() => options.portal.create({ host, label: body?.label, durationS: body?.durationS }));
    },

    async revokeGuest(req, id) {
      const now = clock();
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }
      if ((await session(req, now)) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }
      return relay(() => options.portal.remove(id));
    },
  };
}
