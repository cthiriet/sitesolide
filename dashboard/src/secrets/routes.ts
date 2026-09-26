/**
 * The /api/secrets/* routes, built around their dependencies like those of
 * src/routes.ts: the tests judge them with a simulated steward, with neither
 * socket nor database.
 *
 * The dashboard judges no secret rule at all, neither name, nor scope, nor
 * value, nor new password, nor portal. It checks the origin, the session and
 * the shape of the body, adds the token it holds, and relays. The steward
 * decides, and its refusal goes straight back to the browser with its status: a
 * rule copied here would diverge from its own without protecting anything more,
 * since it is the one that writes.
 *
 * What the dashboard keeps to itself, on the other hand, is the token: it goes
 * out in no response. The dashboard's password and the new password of a
 * `/password` request come back out no more than that, and nothing here logs.
 */
import { isAcceptableSubmission } from "../auth";
import type { SessionReader } from "../routes";
import { isAcceptableOrigin, type Session } from "../sessions";
import type { Steward } from "./client";
import type { Tokens } from "./tokens";
import type {
  WithToken,
  ErrorCode,
  ContentRequest,
  FileRequest,
  PasswordRequest,
  PortalRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
  Failure,
  DashboardUnlockResponse,
  DashboardResponse,
  WithoutToken,
} from "./protocol";

export type SecretsDependencies = {
  session: SessionReader;
  publicUrl: string;
  steward: Steward;
  tokens: Tokens;
};

type Handler = (req: Request) => Promise<Response>;

export type SecretsRoutes = {
  dashboard: Handler;
  log: Handler;
  unlock: Handler;
  lock: Handler;
  readValue: Handler;
  setVariable: Handler;
  removeVariable: Handler;
  createFile: Handler;
  restoreFile: Handler;
  readContent: Handler;
  replaceContent: Handler;
  changePassword: Handler;
  togglePortal: Handler;
  restart: Handler;
  /**
   * Not a route: what signing out calls. Forgets the session's token and
   * revokes it as best it can. Never rejects, a mute steward not being allowed
   * to stop one from signing out.
   */
  forgetUnlock: (sessionHash: string) => Promise<void>;
};

const NO_CACHE = { "Cache-Control": "no-store" };

/**
 * The biggest legitimate request outside a content carries a value of 8 KiB,
 * which the JSON escaping can double. This cap is not the size rule, which the
 * steward applies: it only prevents an enormous body from tying up the process.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A replacement of content: 64 KiB of text, which one control character takes
 * to six bytes in JSON. The same cap as the steward's.
 */
export const MAX_CONTENT_BODY_BYTES = 512 * 1024;

/** Beyond that, it is not a site name, and it has no business in a URL. */
export const MAX_LOG_SLUG = 128;

/**
 * Below that, a string can be found by coincidence in an honest response: the
 * guard that refuses a response copying out a password applies only to strings
 * long enough not to be there by chance. It is only the second lock, the first
 * being that the steward never copies out a request.
 */
export const MIN_SEARCHED_SECRET = 12;

// The fields the page sends, and the only ones that go out to the steward: a
// `token` slipped into the body by the page does not replace the dashboard's.
const PROJECT_FIELDS = ["slug"] as const satisfies readonly (keyof WithoutToken<ProjectRequest>)[];
const FILE_FIELDS = ["slug", "file"] as const satisfies readonly (keyof WithoutToken<FileRequest>)[];
const VARIABLE_FIELDS = ["slug", "file", "variable"] as const satisfies readonly (keyof WithoutToken<VariableRequest>)[];
const SET_FIELDS = ["slug", "file", "variable", "value"] as const satisfies readonly (keyof WithoutToken<SetRequest>)[];
const CONTENT_FIELDS = ["slug", "file", "content"] as const satisfies readonly (keyof WithoutToken<ContentRequest>)[];

/**
 * `fatal`: a byte that is not UTF-8 refuses the request rather than entering a
 * value in the form of a replacement character.
 */
const DECODER = new TextDecoder("utf-8", { fatal: true });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status: status, headers: { ...NO_CACHE, ...headers } });
}

function error(status: number, code: ErrorCode, message: string): Response {
  return json({ error: code, message } satisfies Failure, status);
}

// The same shapes as the rest of the dashboard, which the page already knows.
const refusedOrigin = () => json({ error: "origin-refused" }, 403);
const missingSession = () => json({ error: "no-session" }, 401);

const locked = () => error(423, "locked", "Unlock secrets first.");
const unreachable = () => error(502, "failure", "Can't reach the steward.");
const unreadable = () => error(502, "failure", "The steward sent an unreadable answer.");
const unreadableBody = () => error(400, "invalid", "Unreadable request body.");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request's body, or null if it is missing, too big, not UTF-8, not JSON,
 * or not an object. Read piece by piece: `req.json()` would read everything
 * before one could count, and `Content-Length` is missing on a chunked send.
 */
async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (req.body === null) return null;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let parsed = await reader.read(); !parsed.done; parsed = await reader.read()) {
      bytes += parsed.value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(parsed.value);
    }
    const body: unknown = JSON.parse(DECODER.decode(Bun.concatArrayBuffers(chunks)));
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** What a route keeps from the body: the request without a token, or the response that refuses it. */
type Extraction<D> = (body: Record<string, unknown> | null) => D | Response;

/**
 * The expected fields, each of them a string, and those alone. An empty string
 * gets through: saying that it will not do is a rule, therefore the steward's
 * business.
 */
function fields<C extends string>(names: readonly C[]): Extraction<Record<C, string>> {
  return (body) => {
    if (body === null) return unreadableBody();
    const kept = {} as Record<C, string>;
    for (const name of names) {
      const value = body[name];
      if (typeof value !== "string") return error(400, "invalid", `Missing or non-text field: ${name}.`);
      kept[name] = value;
    }
    return kept;
  };
}

/**
 * `/password`: three names, the dashboard's password in the form that a sign-in
 * accepts, and `newPassword`, a string or null. That the new password is long
 * enough is a rule, judged by the steward.
 */
const extractPassword: Extraction<WithoutToken<PasswordRequest>> = (body) => {
  const names = fields(["slug", "file", "variable"] as const)(body);
  if (names instanceof Response) return names;
  const { dashboardPassword, newPassword } = body!;
  if (!isAcceptableSubmission(dashboardPassword)) return error(400, "invalid", "Dashboard password missing or too long.");
  if (newPassword !== null && typeof newPassword !== "string") return error(400, "invalid", "Missing or non-text field: newPassword.");
  return { ...names, dashboardPassword, newPassword };
};

/** `/portal`: the slug, `active` a boolean, and the confirmation, a string. */
const extractPortal: Extraction<WithoutToken<PortalRequest>> = (body) => {
  const names = fields(["slug", "confirmation"] as const)(body);
  if (names instanceof Response) return names;
  const { active } = body!;
  if (typeof active !== "boolean") return error(400, "invalid", "Missing or non-boolean field: active.");
  return { ...names, active };
};

type Received =
  | { kind: "unreachable" }
  | { kind: "unreadable" }
  | { kind: "received"; status: number; body: Record<string, unknown> | null; retryAfter: string | null };

/**
 * The call to the steward and the entire reading of its response. A rejection,
 * a missing socket, a delay exceeded, including during the reading of the body:
 * unreachable. A response the page would not know how to read, or that contains
 * the token sent or a password from the request: unreadable. Neither of the two
 * throws, an exception here would return a mute 500.
 */
async function reach(call: () => Promise<Response>, token: string | null, secrets: string[] = []): Promise<Received> {
  let response: Response;
  let text: string;
  try {
    response = await call();
    text = await response.text();
  } catch {
    return { kind: "unreachable" };
  }

  // The token does not come back out, even if the steward copied it by mistake
  // into a message. Thirty-two bytes drawn at random are not found there by
  // coincidence: the comparison never refuses an honest response.
  if (token !== null && text.includes(token)) return { kind: "unreadable" };
  // The passwords from the request do not either. Compared in their JSON form
  // as well: a quote or a slash would be escaped there.
  for (const secret of secrets) {
    if (secret.length < MIN_SEARCHED_SECRET) continue;
    if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) return { kind: "unreadable" };
  }

  const status = response.status;
  const retryAfter = response.headers.get("retry-after");
  if (status === 204) return { kind: "received", status, body: null, retryAfter };

  // A redirect is already refused by the client; a 1xx or a 3xx arriving here
  // would be part of no route of the protocol.
  const success = status >= 200 && status < 300;
  if (!success && !(status >= 400 && status < 600)) return { kind: "unreadable" };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (!isObject(body)) return { kind: "unreadable" };
  // The page displays `message` under the field concerned: a refusal without it
  // would say nothing to anyone.
  if (!success && (typeof body.error !== "string" || typeof body.message !== "string")) {
    return { kind: "unreadable" };
  }
  return { kind: "received", status, body, retryAfter };
}

/** The steward's response, returned with its status, with no cache. */
function relay(received: Received): Response {
  if (received.kind === "unreachable") return unreachable();
  if (received.kind === "unreadable") return unreadable();
  if (received.status === 204) return new Response(null, { status: 204, headers: NO_CACHE });

  const headers: Record<string, string> = {};
  if (received.status === 429) {
    const wait = received.body?.wait;
    const timeout =
      typeof wait === "number" && Number.isFinite(wait) && wait >= 0
        ? String(Math.ceil(wait))
        : received.retryAfter;
    if (timeout !== null) headers["Retry-After"] = timeout;
  }
  return json(received.body, received.status, headers);
}

type RouteOptions<D> = {
  /** The body's cap, `MAX_BODY_BYTES` except for a content. */
  max?: number;
  /** The strings of the request that must never come back out. */
  secrets?: (requested: D) => string[];
};

export function createSecretsRoutes(dependencies: SecretsDependencies, clock: () => number = Date.now): SecretsRoutes {
  const { session, publicUrl, steward, tokens } = dependencies;

  /**
   * The origin before the session, like `createGuest`: it is what stands in for
   * an anti-CSRF token, see src/sessions.ts. A GET changes nothing and has only
   * the session to get past.
   */
  async function check(req: Request, writing: boolean): Promise<Session | Response> {
    if (writing && !isAcceptableOrigin(req.headers.get("origin"), publicUrl)) return refusedOrigin();
    return (await session(req, clock())) ?? missingSession();
  }

  async function forgetUnlock(sessionHash: string): Promise<void> {
    const kept = tokens.forget(sessionHash);
    if (kept === null) return;
    try {
      // The response changes nothing: the dashboard has already forgotten, and
      // a token the steward would not have received expires by itself.
      await (await steward.lock({ token: kept.token })).text();
    } catch {
      // Mute steward: nothing more to do than having forgotten.
    }
  }

  /**
   * A route that acts under the session's token. Without a live token, 423
   * without disturbing the steward, which would refuse in any case.
   */
  function withToken<D extends object>(
    extract: Extraction<D>,
    call: (requested: D & WithToken) => Promise<Response>,
    options: RouteOptions<D> = {},
  ): Handler {
    return async (req) => {
      const open = await check(req, true);
      if (open instanceof Response) return open;

      const fieldsRead = extract(await readBody(req, options.max));
      if (fieldsRead instanceof Response) return fieldsRead;

      const kept = tokens.read(open.hash);
      if (kept === null) return locked();

      const received = await reach(() => call({ ...fieldsRead, token: kept.token }), kept.token, options.secrets?.(fieldsRead) ?? []);

      // The steward forgot this token before the dashboard: it restarted, or
      // another session has unlocked since. Forgotten only if it is still the
      // one that served: a second tab may have unlocked again during the call,
      // and its new token is good.
      if (received.kind === "received" && received.status === 401 && received.body?.error === "locked") {
        if (tokens.read(open.hash)?.token === kept.token) tokens.forget(open.hash);
        return locked();
      }
      return relay(received);
    };
  }

  return {
    /** The projects, and the end of this session's unlocking. */
    async dashboard(req) {
      const open = await check(req, false);
      if (open instanceof Response) return open;

      const received = await reach(() => steward.readProjects(), null);
      if (received.kind !== "received" || received.status < 200 || received.status >= 300) return relay(received);

      const projects = received.body?.projects;
      if (!Array.isArray(projects)) return unreadable();
      // Read after the call, which can last: the deadline announced is the one
      // at the moment of the response.
      const until = tokens.read(open.hash)?.expiresAt ?? null;
      return json({ projects, until } satisfies DashboardResponse);
    },

    /**
     * The log, of every site or of one alone. The site's name is judged only by
     * the steward; the relay refuses only what would not fit in a request, and
     * encodes it so that it does not change the path.
     */
    async log(req) {
      const open = await check(req, false);
      if (open instanceof Response) return open;

      const wanted = new URL(req.url).searchParams.getAll("slug");
      if (wanted.length > 1) return error(400, "invalid", "Name one site at most.");
      const slug = wanted[0] ?? null;
      if (slug !== null && (slug === "" || slug.length > MAX_LOG_SLUG)) return error(400, "invalid", "Unreadable site name.");
      return relay(await reach(() => steward.readLog(slug), null));
    },

    /**
     * The password is checked by the steward, not here: the dashboard only
     * checks that it has a submittable shape, as at sign-in, and the rate
     * limiting is the steward's.
     */
    async unlock(req) {
      const open = await check(req, true);
      if (open instanceof Response) return open;

      const body = await readBody(req);
      if (body === null) return unreadableBody();
      const password = body.password;
      if (!isAcceptableSubmission(password)) return error(400, "invalid", "Password missing or too long.");

      const received = await reach(() => steward.unlock({ password }), null, [password]);
      if (received.kind !== "received" || received.status < 200 || received.status >= 300) return relay(received);

      const token = received.body?.token;
      const expiresAt = received.body?.expiresAt;
      // An empty token would get past every comparison of `reach`.
      if (typeof token !== "string" || token === "" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
        return unreadable();
      }
      tokens.set(open.hash, { token, expiresAt });
      return json({ until: expiresAt } satisfies DashboardUnlockResponse);
    },

    /** 204 in every case: locking what is already locked is not a fault. */
    async lock(req) {
      const open = await check(req, true);
      if (open instanceof Response) return open;
      await forgetUnlock(open.hash);
      return new Response(null, { status: 204, headers: NO_CACHE });
    },

    readValue: withToken(fields(VARIABLE_FIELDS), (requested) => steward.readValue(requested)),
    setVariable: withToken(fields(SET_FIELDS), (requested) => steward.setVariable(requested)),
    removeVariable: withToken(fields(VARIABLE_FIELDS), (requested) => steward.removeVariable(requested)),
    createFile: withToken(fields(FILE_FIELDS), (requested) => steward.createFile(requested)),
    restoreFile: withToken(fields(FILE_FIELDS), (requested) => steward.restoreFile(requested)),
    readContent: withToken(fields(FILE_FIELDS), (requested) => steward.readContent(requested)),
    replaceContent: withToken(fields(CONTENT_FIELDS), (requested) => steward.replaceContent(requested), {
      max: MAX_CONTENT_BODY_BYTES,
    }),
    changePassword: withToken(extractPassword, (requested) => steward.changePassword(requested), {
      secrets: (requested) => [requested.dashboardPassword, ...(requested.newPassword === null ? [] : [requested.newPassword])],
    }),
    togglePortal: withToken(extractPortal, (requested) => steward.togglePortal(requested)),
    restart: withToken(fields(PROJECT_FIELDS), (requested) => steward.restart(requested)),

    forgetUnlock,
  };
}
