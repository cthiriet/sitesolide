/**
 * What the steward's routes share, the secrets' (steward.ts), the control
 * API's (src/control/steward.ts), the people's and access's: a request's
 * body read bounded in size and in time, its route found behind a bound on
 * the requests in flight, an error named for the log, and a queue that runs
 * one change at a time. A refusal is the same JSON on every socket,
 * `{ error, message }`.
 */

export type Body = Record<string, unknown>;
export type Handler = (req: Request) => Promise<Response>;
export type Routes = Record<string, Record<string, Handler>>;

/** What an unexpected exception answers: its message could quote a path, and is never sent back. */
export const GENERIC_MESSAGE = "unexpected error, see the steward's log on the server";

const refusal = (status: number, error: string, message: string): Response => Response.json({ error, message }, { status });

/** The name of an error for the log, never its message: a system error's quotes a path, another's could quote worse. */
export function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

/**
 * The body, piece by piece, bounded in size and in time: a body that never
 * arrives must not hold a place in flight indefinitely.
 */
async function readStream(req: Request, max: number, timeoutMs: number): Promise<Uint8Array | "too-large" | "too-slow"> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiration = new Promise<"too-slow">((resolve) => {
    timer = setTimeout(() => resolve("too-slow"), timeoutMs);
  });

  try {
    for (;;) {
      const parsed = await Promise.race([reader.read(), expiration]);
      if (parsed === "too-slow") {
        reader.cancel().catch(() => undefined);
        return "too-slow";
      }
      if (parsed.done) break;
      total += parsed.value.byteLength;
      if (total > max) {
        reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(parsed.value);
    }
  } finally {
    clearTimeout(timer);
  }
  return new Uint8Array(Bun.concatArrayBuffers(chunks));
}

/**
 * The body, a JSON object with the expected fields and those alone, or the
 * refusal, 400 `invalid`. An unknown field is a typing mistake of the
 * relay's, refused rather than passed over in silence; its name is not
 * repeated, nothing saying what it contains.
 */
export async function readJsonBody(req: Request, fields: readonly string[], max: number, timeoutMs: number): Promise<Body | Response> {
  if (Number(req.headers.get("content-length") ?? "0") > max) return refusal(400, "invalid", "request body too large");

  const bytes = await readStream(req, max, timeoutMs);
  if (bytes === "too-large") return refusal(400, "invalid", "request body too large");
  if (bytes === "too-slow") return refusal(400, "invalid", "request body too slow");

  let object: unknown;
  try {
    object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refusal(400, "invalid", "the request body must be a JSON object");
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    return refusal(400, "invalid", "the request body must be a JSON object");
  }
  if (Object.keys(object).some((key) => !fields.includes(key))) return refusal(400, "invalid", "unexpected field in the request body");
  return object as Body;
}

/**
 * One socket's routes, a handler by path and method, behind a bound on the
 * requests in flight that every table served by the same `createServe`
 * shares, and one catch: an unexpected exception answers a generic 500, its
 * name alone in the log. `rename` maps a path to the one it is served
 * under.
 */
export function createServe(options: { maxInFlight: number; log: string; rename?: (path: string) => string }): (table: Routes) => Handler {
  let inFlight = 0;
  return (table) => async (req) => {
    // 503 and not 500: nothing is broken, the request can be made again in a moment.
    if (inFlight >= options.maxInFlight) return refusal(503, "failure", "the server is busy, try again in a moment");
    inFlight++;
    try {
      const pathname = new URL(req.url).pathname;
      const path = options.rename === undefined ? pathname : options.rename(pathname);
      const route = Object.hasOwn(table, path) ? table[path] : undefined;
      if (route === undefined) return refusal(404, "not-found", "no such route");
      const handler = Object.hasOwn(route, req.method) ? route[req.method] : undefined;
      if (handler === undefined) {
        return Response.json({ error: "invalid", message: "method not allowed" }, { status: 405, headers: { Allow: Object.keys(route).join(", ") } });
      }
      return await handler(req);
    } catch (e) {
      console.error(`${options.log}: unexpected error (${errorName(e)})`);
      return refusal(500, "failure", GENERIC_MESSAGE);
    } finally {
      inFlight--;
    }
  };
}

/** One task at a time, each waiting for the end of the one before it, successful or not. */
export function createQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
}
