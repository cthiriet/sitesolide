/**
 * The proxy's second port: the two read-only routes the dashboard calls,
 * `GET /status` and `GET /audit`, answered to its account alone, recognised
 * like any caller by the uid of its socket (proc-net.ts).
 *
 * A port of its own rather than origin-form requests on the CONNECT port:
 * there the proxy pipes bytes it never reads, and two ports keep a tunnel from
 * ever being read as anything else.
 *
 * **A raw listener, counted against the CONNECT port's admission**, and not
 * Bun.serve, which counted no connections: measured on Bun 1.3.11, one
 * project held thousands until the process ran out of descriptors, after
 * which every other project's CONNECT went unanswered. Every connection here
 * takes its place among the proxy's, and in its project's share from the
 * moment the kernel names the project, before any head (admission.ts).
 *
 * One request per connection, its answer saying `Connection: close`.
 */
import type { Socket, TCPSocketListener } from "bun";
import { createAdmission, type Admission } from "./admission";
import type { Audit } from "./audit";
import { headEnd, latin1Text, parseHead } from "./decide";
import type { Caller, Peer } from "./proc-net";
import { DEFAULT_LIMITS, type Limits } from "./proxy";
import { concat, createLingering, createPipe, pause, side, type Piped } from "./sockets";

export type StatusOptions = {
  hostname: string;
  port: number;
  identify: (peer: Peer) => Caller | Promise<Caller>;
  audit: Pick<Audit, "denied" | "recent">;
  /** The dashboard's account, the only caller answered. */
  dashboardAccount: string;
  /**
   * The CONNECT port's admission, which this port's connections count against
   * too: the proxy's, in production. A test without one gets its own, made
   * from `limits`.
   */
  admission?: Admission;
  limits?: Partial<Limits>;
  /** What /status says of the proxy. */
  status?: () => Record<string, unknown>;
  log?: (line: string) => void;
};

export type StatusPort = {
  port: number;
  stop: () => void;
  /** Connections to this port, the silent ones and those still judged included. */
  open: () => number;
  /** Refused connections still read before they close, apart from `open`: see createLingering(). */
  lingering: () => number;
};

const REASONS: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
  505: "HTTP Version Not Supported",
};

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** What this port answers, said to whoever calls it for something else. */
const ROUTES = "egress: this port answers the dashboard's GET /status and GET /audit; a project reaches a host through HTTPS_PROXY";

/** A whole answer of the proxy's own, in JSON, the connection closed after it. */
function jsonAnswer(status: number, body: unknown, refused: boolean): string {
  const text = JSON.stringify(body);
  return [
    `HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${encoder.encode(text).length}`,
    "Cache-Control: no-store",
    ...(refused ? ["X-Sitesolide-Egress: refused"] : []),
    "Connection: close",
    "",
    text,
  ].join("\r\n");
}

/** One connection: its client, and an upstream side that never has a socket, for the pipe that writes the answer. */
type Call = Piped & {
  head: Uint8Array;
  caller: Promise<Caller>;
  /** The head's delay. */
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Read through a function: TypeScript keeps a phase narrowed across an
 * `await`, during which the caller may well have gone.
 */
function isClosed(call: Call): boolean {
  return call.phase === "closed";
}

export function startStatusPort(options: StatusOptions): StatusPort {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const log = options.log ?? ((line: string) => console.log(line));
  const admission = options.admission ?? createAdmission(limits);
  const lingering = createLingering(limits);
  /** This port's connections; the admission counts both ports'. */
  const calls = new Set<Call>();

  // An answer larger than the socket takes at once waits in the pipe, counted
  // against the budgets like a tunnel's bytes.
  const { stopReading, startReading, send, flush } = createPipe<Call>(admission, limits.bufferBytes, close);

  /**
   * The connection's end. With an `answer`, a refusal: the caller is answered
   * and lingers, so that bytes it still sends do not turn the close into a
   * reset that throws the answer away.
   */
  function close(call: Call, answer: string | null = null): void {
    if (isClosed(call)) return;
    call.phase = "closed";
    if (call.timer !== null) clearTimeout(call.timer);
    calls.delete(call);
    admission.leave(call);
    const released = call.client.queued;
    call.client.queue = [];
    call.client.queued = 0;
    admission.account(call, -released);
    const socket = call.client.socket;
    if (socket === null) return;
    if (answer !== null) lingering.start(socket, answer);
    else socket.end();
  }

  function refuse(call: Call, status: number, error: string, message: string): void {
    close(call, jsonAnswer(status, { error, message }, true));
  }

  /**
   * An answer of any size: written as the caller takes it, the connection
   * closed once it is, and swept like any other should it never be.
   */
  function respond(call: Call, answer: string): void {
    call.phase = "open";
    call.lastActivity = Date.now();
    send(call, call.client, call.upstream, encoder.encode(answer));
    call.client.ending = true;
    if (call.client.queue.length === 0) close(call);
  }

  async function handle(call: Call): Promise<void> {
    const head = parseHead(latin1Text(call.head));
    call.head = EMPTY;
    if (head === null) return refuse(call, 400, "invalid", "egress: not an HTTP request");
    if (head.version !== "HTTP/1.1") return refuse(call, 505, "invalid", "egress: HTTP/1.1 only");
    // Origin form only, printable ASCII, as a client sends it.
    if (!/^\/(?!\/)[!-~]*$/.test(head.target)) return refuse(call, 400, "invalid", ROUTES);
    const url = new URL(head.target, "http://status.invalid");
    if (url.pathname !== "/audit" && url.pathname !== "/status") return refuse(call, 404, "not-found", ROUTES);
    if (head.method !== "GET") return refuse(call, 405, "invalid", "GET only");

    const who = await call.caller;
    if (isClosed(call)) return;
    // The dashboard is a project like any other, site-dashboard: its account
    // decides, whatever kind the kernel's answer gives it.
    if (who.kind === "unknown" || who.account !== options.dashboardAccount) {
      return refuse(call, 403, "refused", "only the dashboard reads this");
    }
    if (url.pathname === "/audit") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const beforeText = url.searchParams.get("before");
      const before = beforeText === null ? null : Number(beforeText);
      if (!Number.isInteger(limit) || limit < 1 || (before !== null && !Number.isInteger(before))) {
        return refuse(call, 400, "invalid", "limit and before must be integers");
      }
      return respond(call, jsonAnswer(200, { rows: options.audit.recent(limit, before) }, false));
    }
    respond(call, jsonAnswer(200, { ...options.status?.() }, false));
  }

  /**
   * Counts the connection in its project's share as soon as the kernel names
   * the project, before any head, as proxy.ts does and against the same
   * admission: beyond its share on both ports together, a project is refused
   * at once; another kind of caller is refused on its head.
   */
  function admit(call: Call, caller: Caller): void {
    if (isClosed(call) || caller.kind !== "project") return;
    const full = admission.join(call, caller.slug, call.client.queued);
    if (full !== null) {
      options.audit.denied({ target: caller.slug, destination: null, reason: "too many connections" });
      refuse(call, 503, "refused", `egress: ${caller.slug} already holds ${full} connections to the proxy, both ports together`);
    }
  }

  const listener: TCPSocketListener<Call> = Bun.listen<Call>({
    hostname: options.hostname,
    port: options.port,
    socket: {
      open(socket) {
        const peer: Peer = {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          localAddress: socket.localAddress,
          localPort: socket.localPort,
        };
        const call: Call = {
          phase: "head",
          head: EMPTY,
          // Asked at once, while the connection is surely established.
          caller: Promise.resolve()
            .then(() => options.identify(peer))
            .catch((): Caller => ({ kind: "unknown", reason: "identification failed" })),
          share: null,
          stopReading: () => stopReading(call),
          startReading: () => startReading(call),
          client: side(socket as unknown as Socket<unknown>),
          upstream: side(null),
          lastActivity: Date.now(),
          timer: null,
        };
        socket.data = call;
        if (!admission.enter(call)) {
          call.phase = "closed";
          const answer = jsonAnswer(503, { error: "refused", message: "egress: the proxy holds too many connections, try again in a moment" }, true);
          lingering.start(socket as unknown as Socket<unknown>, answer);
          return;
        }
        calls.add(call);
        // Registered before handle() awaits the same promise: the share is
        // settled by the time the head is judged.
        void call.caller.then((caller) => admit(call, caller));
        call.timer = setTimeout(() => {
          if (call.phase === "head") refuse(call, 408, "invalid", "egress: the request head did not arrive in time");
        }, limits.headTimeoutMs);
      },

      data(socket, chunk) {
        const call = socket.data;
        switch (call.phase) {
          case "head": {
            call.head = concat(call.head, chunk);
            const end = headEnd(call.head);
            if (end === -1) {
              if (call.head.length > limits.headBytes) refuse(call, 431, "invalid", "egress: request head too large");
              return;
            }
            if (end > limits.headBytes) return refuse(call, 431, "invalid", "egress: request head too large");
            if (call.timer !== null) clearTimeout(call.timer);
            call.timer = null;
            call.phase = "deciding";
            // Nothing more is read: a GET carries no body, and what follows
            // the head waits in the kernel until the connection closes.
            pause(call.client);
            call.head = call.head.subarray(0, end);
            handle(call).catch((error: unknown) => {
              log(`egress: unexpected error on the status port (${error instanceof Error ? error.name : "unknown"})`);
              refuse(call, 500, "failure", "egress: unexpected error");
            });
            return;
          }
          case "deciding":
          case "open":
            // Paused, but a read already under way may still deliver: a GET
            // has nothing behind its head, and what came is dropped.
            return;
          case "closed":
            // Refused and answered: dropped, see createLingering().
            lingering.drop(socket as unknown as Socket<unknown>, chunk.length);
            return;
        }
      },

      drain(socket) {
        flush(socket.data, socket.data.client, socket.data.upstream);
      },

      close(socket) {
        const call = socket.data;
        if (call === undefined) return;
        lingering.end(socket as unknown as Socket<unknown>);
        call.client.socket = null;
        close(call);
      },

      error() {
        // close follows.
      },
    },
  });

  // An answer its caller never reads is swept like an idle tunnel.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const call of calls) {
      if (call.phase === "open" && now - call.lastActivity > limits.idleMs) close(call);
    }
  }, Math.min(30_000, limits.idleMs));

  return {
    port: listener.port,
    open: () => calls.size,
    lingering: () => lingering.size(),
    stop() {
      clearInterval(sweep);
      for (const call of calls) close(call);
      lingering.stop();
      listener.stop(true);
    },
  };
}
