/**
 * The connectors: a credential the machine lends a project without handing it
 * over, and the read-only routes the dashboard calls.
 *
 * The app calls `http://127.0.0.1:3129/connectors/<name>/<path>` in plain HTTP
 * on the loopback, where nothing travels off the machine. The proxy checks, in
 * order: who is calling (the kernel's answer), that the connector exists and
 * reads, that the caller's deployed manifest asks for it, that the dashboard
 * granted it to that project, then resolves the connector's host and judges
 * every address like any egress. It forwards over HTTPS to the address it
 * judged, with the configured header set and every credential header the app
 * sent removed, and streams the answer back.
 *
 * **Both the manifest and the grant**, because neither alone is enough: the
 * manifest is written by whoever wrote the app, an agent perhaps, and a grant
 * without it would lend a credential to code that never asked, which a
 * redeployment of another app under that slug could then use.
 *
 * **Raw sockets on both sides, as on the CONNECT port**, and not Bun.serve and
 * fetch, which held what they were given without bound, measured on Bun
 * 1.3.11: Bun.serve counted no connections, and one project held thousands
 * until the process ran out of descriptors; fetch read an answer as fast as
 * the upstream sent it and Bun.serve kept what the app did not read, 1.6 GiB
 * for one answer of 300 MiB read slowly; fetch read a request body as fast as
 * the app sent it, whatever the upstream took. Here every connection is
 * admitted like a tunnel (admission.ts), and every byte waits in a queue the
 * budgets count, the side that sends it no longer read while it waits.
 *
 * One call per connection: the answer says `Connection: close`, and so does
 * the request sent upstream. A call holds its place among its project's calls
 * from its judgement to the last byte of its answer.
 */
import type { Socket, TCPSocketListener } from "bun";
import { checkServerIdentity } from "node:tls";
import { isValidConnectorName } from "../../bin/cli/egress";
import { connectorNamed, isGranted, readBaseUrl } from "../../bin/cli/connectors";
import { createAdmission, type Admission, type Member } from "./admission";
import type { Audit } from "./audit";
import { headEnd, HOP_BY_HOP, latin1Bytes, latin1Text, parseHead, type RequestHead } from "./decide";
import {
  answerFraming,
  bodyReader,
  downstreamHead,
  expectsContinue,
  isValidValue,
  LAST_CHUNK,
  onePiece,
  parseAnswerHead,
  requestFraming,
  upstreamHead,
  type BodyReader,
  type Framing,
} from "./http1";
import type { Policy } from "./policy";
import type { Caller, Peer } from "./proc-net";
import { DEFAULT_LIMITS, type Limits } from "./proxy";
import { machineAddresses, resolveChecked, type Lookup, type OwnAddresses } from "./resolve";
import { concat, copy, createLingering, createPipe, pause, side, type Side } from "./sockets";

/** The biggest request body forwarded: an API call, not a file upload service. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Connector calls a project may have under way at once, from their judgement
 * to the end of their answer. One project looping on a slow API, or holding
 * streams of events open, must not take every other project's share.
 */
export const MAX_IN_FLIGHT_PER_PROJECT = 32;

/**
 * The connectors' limits: the proxy's, whose byte budgets and connection
 * counts both ports share (see admission.ts), and their own.
 */
export type ConnectorLimits = Limits & {
  /** Time left to the upstream to answer with its head, from the first connection attempt. */
  headersTimeoutMs: number;
  /** Calls under way per project. */
  maxInFlight: number;
  /**
   * Calls under way, all projects together. Each holds a TLS connection,
   * whose buffers no byte budget counts: see DEFAULT_LIMITS in proxy.ts.
   */
  maxCalls: number;
  /** The biggest request body, announced or counted as it streams. */
  maxBodyBytes: number;
};

export const DEFAULT_CONNECTOR_LIMITS: ConnectorLimits = {
  ...DEFAULT_LIMITS,
  headersTimeoutMs: 30_000,
  maxInFlight: MAX_IN_FLIGHT_PER_PROJECT,
  maxCalls: 256,
  maxBodyBytes: MAX_BODY_BYTES,
};

export type ConnectorsOptions = {
  hostname: string;
  port: number;
  identify: (peer: Peer) => Caller | Promise<Caller>;
  policy: Policy;
  lookup: Lookup;
  /** The machine's own addresses, refused like the loopback; read from its interfaces unless a test says otherwise. */
  ownAddresses?: OwnAddresses;
  audit: Pick<Audit, "used" | "denied" | "recent">;
  /** The dashboard's account, the only caller of the read-only routes. */
  dashboardAccount: string;
  /** Where to connect for a judged address; the tests reroute it to a local server. */
  route?: (address: string, port: number) => { hostname: string; port: number };
  /**
   * The authorities to trust instead of the system's: the tests' own. Never
   * in production: Bun 1.3.11 builds a TLS context for every connection given
   * one, some 900 KiB each against 28 KiB with the system's, measured.
   */
  ca?: string;
  /**
   * The CONNECT port's admission, which this port's connections count against
   * too: the proxy's, in production. A test without one gets its own, made
   * from `limits`.
   */
  admission?: Admission;
  limits?: Partial<ConnectorLimits>;
  /** What the dashboard's status route says about the proxy's own side. */
  status?: () => Record<string, unknown>;
  log?: (line: string) => void;
};

export type Connectors = {
  port: number;
  stop: () => void;
  /** Connections to this port, the silent ones and those still judged included. */
  open: () => number;
  /** Calls under way, from their judgement to the end of their answer. */
  calls: () => number;
  /** Bytes waiting in the proxy for a side that has not taken them yet, both ports together. */
  buffered: () => number;
  /** Refused connections still read before they close, apart from `open`: see createLingering(). */
  lingering: () => number;
};

/**
 * Credential headers the app may have sent, removed before forwarding, on top
 * of the connector's own header: the request must carry the connector's
 * credential and no other, never a second identity the upstream might prefer.
 */
export const CREDENTIAL_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "private-token",
];

/** What reveals the machine or the platform to a third party, removed too. */
function isInternal(name: string): boolean {
  return name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-") || name.startsWith("x-sitesolide-");
}

/**
 * The headers sent upstream: the app's, cleaned, and the connector's
 * credential. The framing goes apart, as the proxy sends the body; Expect
 * too, the proxy answering it itself.
 */
export function upstreamHeaders(incoming: Headers, connectorHeader: string, value: string, host: string): Headers {
  const outgoing = new Headers();
  const drop = new Set([...HOP_BY_HOP, ...CREDENTIAL_HEADERS, "host", "content-length", "transfer-encoding", "expect", connectorHeader.toLowerCase()]);
  // A header named in Connection is hop-by-hop too.
  for (const named of (incoming.get("connection") ?? "").split(",")) drop.add(named.trim().toLowerCase());
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (drop.has(lower) || isInternal(lower)) return;
    outgoing.append(name, value);
  });
  outgoing.set("host", host);
  outgoing.set(connectorHeader, value);
  return outgoing;
}

/**
 * The path under the connector's prefix, or null. The request's URL has
 * already had its dot segments resolved by the parser, `/connectors/a/../b`
 * reading as `/connectors/b`; an encoded slash or backslash, which an upstream
 * might decode into a segment of its own, is refused.
 */
export function connectorPath(pathname: string): { name: string; rest: string } | null {
  const match = /^\/connectors\/([^/]+)(\/.*)?$/.exec(pathname);
  if (match === null) return null;
  const [, name = "", rest = ""] = match;
  if (!isValidConnectorName(name)) return null;
  if (/%2f|%5c/i.test(rest) || rest.includes("\\")) return null;
  return { name, rest };
}

const REASONS: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  413: "Content Too Large",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
};

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
const CONTINUE = encoder.encode("HTTP/1.1 100 Continue\r\n\r\n");

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

/** Does the certificate the upstream presented name the connector's host? Bun's TLS checks the chain, never the name. */
function namesHost(socket: Socket<Call>, host: string): boolean {
  try {
    return checkServerIdentity(host, socket.getPeerCertificate()) === undefined;
  } catch {
    return false;
  }
}

type Call = Member & {
  phase: "head" | "deciding" | "open" | "closed";
  head: Uint8Array;
  caller: Promise<Caller>;
  client: Side;
  upstream: Side;
  lastActivity: number;
  /** The head's delay, then the answer head's. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The number of the current connection attempt, see connect(). */
  attempt: number;
  /** The current attempt's socket, once its TCP connection is up and until its handshake ends: what giving up on it closes. */
  attempting: Socket<unknown> | null;
  /** What the app sent behind its head while the call was judged, raw, counted. */
  early: Uint8Array[];
  earlyBytes: number;
  /** The project, once its call holds a place among its calls under way. */
  slug: string | null;
  connector: string;
  method: string;
  /** The request's body as it streams, and whether it has all come. */
  request: BodyReader | null;
  requestEnded: boolean;
  /** Sent on in chunks of the proxy's own, rather than with a length. */
  chunked: boolean;
  bodyBytes: number;
  /** The answer's head as it arrives, then its body once it has. */
  answerHead: Uint8Array;
  answer: BodyReader | null;
  /** The answer has all come: what waits for the app is its end. */
  answered: boolean;
};

/**
 * Read through a function: TypeScript keeps a phase narrowed across an
 * `await`, during which the app may well have gone.
 */
function isClosed(call: Call): boolean {
  return call.phase === "closed";
}

export function startConnectors(options: ConnectorsOptions): Connectors {
  const limits: ConnectorLimits = { ...DEFAULT_CONNECTOR_LIMITS, ...options.limits };
  const log = options.log ?? ((line: string) => console.log(line));
  const route = options.route ?? ((address: string, port: number) => ({ hostname: address, port }));
  const ownAddresses = options.ownAddresses ?? machineAddresses();
  const admission = options.admission ?? createAdmission(limits);
  const lingering = createLingering(limits);
  /** This port's connections; the admission counts both ports'. */
  const calls = new Set<Call>();
  /** Calls under way per project, and all together. */
  const inFlight = new Map<string, number>();
  let underWay = 0;

  // A call's two sides, piped as a tunnel's are.
  const { stopReading, startReading, resumeIfAllowed, send, flush } = createPipe<Call>(admission, limits.bufferBytes, close);

  /** Drops what waits for the upstream: it is gone, or has answered whole. */
  function forgetUpstream(call: Call): void {
    const dropped = call.upstream.queued;
    call.upstream.queue = [];
    call.upstream.queued = 0;
    admission.account(call, -dropped);
  }

  /**
   * The call's end, both sides at once, its place among the calls under way
   * given back and the upstream let go of: an answer whose app is gone is not
   * read on for nobody. With an `answer`, a refusal or the proxy's own: the app
   * is answered and lingers. Without one, an app still sending its request
   * lingers too, its unread bytes otherwise turning the close into a reset.
   */
  function close(call: Call, answer: string | null = null): void {
    if (isClosed(call)) return;
    call.phase = "closed";
    if (call.timer !== null) clearTimeout(call.timer);
    calls.delete(call);
    admission.leave(call);
    if (call.slug !== null) {
      const left = (inFlight.get(call.slug) ?? 1) - 1;
      if (left <= 0) inFlight.delete(call.slug);
      else inFlight.set(call.slug, left);
      underWay--;
    }
    const released = call.client.queued + call.upstream.queued + call.earlyBytes;
    for (const each of [call.client, call.upstream]) {
      each.queue = [];
      each.queued = 0;
    }
    call.early = [];
    call.earlyBytes = 0;
    admission.account(call, -released);
    // An attempt still in its handshake is given up on with the call.
    call.attempting?.terminate();
    call.attempting = null;
    const upstream = call.upstream.socket;
    call.upstream.socket = null;
    upstream?.end();
    const socket = call.client.socket;
    if (socket === null) return;
    if (answer !== null || !call.requestEnded) lingering.start(socket, answer ?? "");
    else socket.end();
  }

  function refuse(call: Call, status: number, error: string, message: string): void {
    close(call, jsonAnswer(status, { error, message }, true));
  }

  /**
   * An answer of the proxy's own, of any size: written as the app takes it,
   * the call closed once it is, and swept like any other should it never be.
   */
  function respond(call: Call, answer: string): void {
    call.phase = "open";
    call.lastActivity = Date.now();
    send(call, call.client, call.upstream, encoder.encode(answer));
    call.client.ending = true;
    if (call.client.queue.length === 0) close(call);
  }

  function busy(call: Call): string {
    const who = call.share?.blocked ? call.share.slug : "the proxy";
    return `connectors: ${who} already holds too many bytes its callers have not read, try again in a moment`;
  }

  /** Bytes the app sent behind its head while the call is judged, kept for the upstream within their cap and the budgets. */
  function holdEarly(call: Call, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    call.early.push(bytes);
    call.earlyBytes += bytes.length;
    admission.account(call, bytes.length);
    if (call.earlyBytes > limits.pendingBytes) return refuse(call, 400, "invalid", "connectors: too much sent before the call was judged");
    if (!admission.mayRead(call)) return refuse(call, 503, "refused", busy(call));
  }

  /** A request that went wrong on its way up: refused while no answer has started, cut once one has. */
  function failRequest(call: Call, status: number, message: string): void {
    if (call.answer !== null) return close(call);
    if (status === 413) {
      options.audit.denied({ target: call.slug, destination: `connector:${call.connector}`, reason: "body too large", account: null });
    }
    refuse(call, status, "invalid", message);
  }

  /** The request's body as it streams, on to the upstream, in chunks of the proxy's own when it came in chunks. */
  function fromClient(call: Call, bytes: Uint8Array): void {
    // What follows a request's body goes nowhere: a second request behind the
    // first never reaches the upstream.
    if (call.requestEnded) return;
    const read = call.request!.read(bytes);
    if ("error" in read) return failRequest(call, 400, `connectors: the request body does not read, ${read.error}`);
    let length = 0;
    for (const data of read.data) length += data.length;
    call.bodyBytes += length;
    if (call.bodyBytes > limits.maxBodyBytes) return failRequest(call, 413, `connectors: the request body is over ${limits.maxBodyBytes} bytes`);
    // Never an empty piece: in chunks, it would read as the last one.
    if (length > 0) {
      call.lastActivity = Date.now();
      // One piece per read, one chunk when the body came in chunks: see onePiece().
      send(call, call.upstream, call.client, onePiece(read.data, call.chunked));
    }
    if (!read.done) return;
    call.requestEnded = true;
    if (call.chunked) send(call, call.upstream, call.client, LAST_CHUNK);
  }

  /** The upstream failed before its answer started: the app is told why. */
  function failAnswer(call: Call, why: string, status = 502): void {
    options.audit.used(call.slug!, call.connector, null);
    refuse(call, status, "upstream", `connectors: ${call.connector}: ${why}`);
  }

  /** Its answer whole, the upstream has nothing more to say: it is let go, and the call ends once the app has the rest. */
  function answered(call: Call): void {
    call.answered = true;
    forgetUpstream(call);
    const upstream = call.upstream.socket;
    call.upstream.socket = null;
    upstream?.end();
    call.client.ending = true;
    if (call.client.queue.length === 0) close(call);
  }

  /** The answer as it streams: its head rewritten for the app, its body passed on as the upstream framed it. */
  function fromUpstream(call: Call, chunk: Uint8Array): void {
    if (call.client.socket === null || call.answered) return;
    call.lastActivity = Date.now();
    let bytes = chunk;
    if (call.answer === null) {
      call.answerHead = concat(call.answerHead, chunk);
      for (;;) {
        const end = headEnd(call.answerHead);
        if (end === -1 && call.answerHead.length <= limits.headBytes) return;
        if (end === -1 || end > limits.headBytes) return failAnswer(call, `its answer's head is over ${limits.headBytes} bytes`);
        const head = parseAnswerHead(latin1Text(call.answerHead.subarray(0, end)));
        if (head === null) return failAnswer(call, "its answer does not read");
        const rest = call.answerHead.subarray(end);
        if (head.status === 101) return failAnswer(call, "it switched protocols, which a connector does not");
        // An interim answer, 100 or 103: dropped, the final one follows.
        if (head.status < 200) {
          call.answerHead = rest;
          continue;
        }
        const framing = answerFraming(call.method, head.status, head.headers);
        if ("error" in framing) return failAnswer(call, framing.error);
        if (call.timer !== null) clearTimeout(call.timer);
        call.timer = null;
        call.answer = bodyReader(framing);
        call.answerHead = EMPTY;
        options.audit.used(call.slug!, call.connector, head.status);
        send(call, call.client, call.upstream, latin1Bytes(downstreamHead(head, call.connector)));
        bytes = rest;
        break;
      }
    }
    const read = call.answer.read(bytes);
    // Cut short: the app's client sees its answer end before its framing does.
    if ("error" in read) return close(call);
    if (read.used > 0) send(call, call.client, call.upstream, bytes.subarray(0, read.used));
    if (read.done) answered(call);
  }

  /**
   * The upstream is gone. Before an answer, the app is told; an answer that
   * runs to the close has ended; any other is cut short, what came of it
   * delivered first.
   */
  function upstreamClosed(call: Call): void {
    call.upstream.socket = null;
    if (isClosed(call)) return;
    forgetUpstream(call);
    if (call.answer === null) return failAnswer(call, "the connection closed before an answer");
    if (call.answer.closes) return answered(call);
    call.client.ending = true;
    if (call.client.queue.length === 0) close(call);
  }

  /** Is this socket the call's upstream, and not an attempt given up on? */
  const isUpstream = (socket: Socket<Call>) => socket.data.upstream.socket === (socket as unknown as Socket<unknown>);

  /**
   * Tries each judged address in turn, each within the delay. The address
   * judged, never the name again, and the request written only once the
   * certificate is known to be valid for the connector's host: Bun 1.3.11
   * checks the chain against the trusted authorities and reports it in
   * `handshake`, and checks the name not at all, measured. A valid
   * certificate for another name, whoever answers for the host in DNS, gets
   * a handshake and not one byte. Each attempt carries a number, and a socket
   * is adopted only if its attempt is still the current one, as in proxy.ts.
   *
   * An attempt given up on, past its delay or with its call, is closed then
   * and there, not left to the host: one that takes the TCP connection and
   * never finishes the handshake kept it open, a descriptor no count saw, and
   * a project hanging up on call after call stacked them, measured. One still
   * waiting for its TCP connection has no socket to close yet: it is closed
   * the moment it has one, its attempt no longer the current one.
   */
  async function connect(call: Call, addresses: string[], host: string, port: number): Promise<boolean> {
    for (const address of addresses) {
      const target = route(address, port);
      const attempt = ++call.attempt;
      const adopted = await new Promise<boolean>((settle) => {
        const timer = setTimeout(() => {
          call.attempting?.terminate();
          call.attempting = null;
          settle(false);
        }, limits.connectTimeoutMs);
        const done = (ok: boolean) => {
          clearTimeout(timer);
          settle(ok);
        };
        Bun.connect<Call>({
          hostname: target.hostname,
          port: target.port,
          data: call,
          tls: { serverName: host, ...(options.ca === undefined ? {} : { ca: options.ca }) },
          socket: {
            open(socket) {
              const owner = socket.data;
              if (owner.attempt !== attempt || isClosed(owner)) return socket.terminate();
              owner.attempting = socket as unknown as Socket<unknown>;
            },
            handshake(socket, success, authorizationError) {
              const owner = socket.data;
              if (owner.attempting === (socket as unknown as Socket<unknown>)) owner.attempting = null;
              if (owner.attempt !== attempt || isClosed(owner) || !success || authorizationError || !namesHost(socket, host)) {
                socket.terminate();
                return done(false);
              }
              owner.upstream.socket = socket as unknown as Socket<unknown>;
              done(true);
            },
            data(socket, chunk) {
              if (isUpstream(socket) && socket.data.phase === "open") fromUpstream(socket.data, chunk);
            },
            drain(socket) {
              if (isUpstream(socket) && socket.data.phase === "open") flush(socket.data, socket.data.upstream, socket.data.client);
            },
            close(socket) {
              if (socket.data.attempting === (socket as unknown as Socket<unknown>)) socket.data.attempting = null;
              if (isUpstream(socket)) upstreamClosed(socket.data);
              else done(false);
            },
            connectError: () => done(false),
            error() {
              // close follows.
            },
          },
        }).catch(() => done(false));
      });
      if (isClosed(call)) return false;
      if (adopted) return true;
    }
    // The last attempt is given up on too, should it answer late.
    call.attempt++;
    return false;
  }

  /** The routes the dashboard reads, to it alone. */
  function dashboard(call: Call, who: Caller, url: URL): void {
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
    const lending = options.policy.lending();
    const status = {
      connectors: Object.keys(lending.connectors.connectors).length,
      grants: lending.grants.grants.length,
      errors: lending.errors,
      openCalls: calls.size,
      callsUnderWay: underWay,
      ...options.status?.(),
    };
    respond(call, jsonAnswer(200, status, false));
  }

  async function forward(call: Call, head: RequestHead, who: Caller, name: string, rest: string, search: string, framing: Framing): Promise<void> {
    const denied = (status: number, reason: string, message: string, slug: string | null) => {
      options.audit.denied({ target: slug, destination: `connector:${name}`, reason, account: who.kind === "account" ? who.account : null });
      refuse(call, status, "refused", message);
    };
    if (who.kind !== "project") {
      return denied(403, who.kind === "account" ? "not a project" : "unidentified", "connectors: only a project's service may call a connector", null);
    }
    const { slug } = who;
    const lending = options.policy.lending();
    const connector = connectorNamed(lending.connectors, name);
    if (connector === undefined) {
      const why = lending.errors.length > 0 ? `the connectors file on the server does not read (${lending.errors.join("; ")})` : `no connector named ${name} on this server`;
      return denied(404, "unknown connector", `connectors: ${why}`, slug);
    }
    const policy = options.policy.project(slug);
    if (policy === null || !policy.connectors.includes(name)) {
      return denied(403, "not requested", `connectors: ${slug}'s sitesolide.json on the server does not list ${name} under connectors`, slug);
    }
    if (!isGranted(lending.grants, slug, name)) {
      return denied(403, "not granted", `connectors: ${name} is not granted to ${slug}; an administrator grants it from the dashboard's Connectors page`, slug);
    }

    const base = readBaseUrl(connector.baseUrl);
    if ("error" in base) return denied(502, "unusable base address", `connectors: ${name} has an unusable base address`, slug);
    const resolution = await resolveChecked(base.host, options.lookup, limits.lookupTimeoutMs, ownAddresses);
    if (isClosed(call)) return;
    if (!resolution.ok) return denied(resolution.status, resolution.reason, `connectors: ${name}: ${resolution.message.replace(/^egress: /, "")}`, slug);

    if (framing.kind === "length" && framing.length > limits.maxBodyBytes) {
      return denied(413, "body too large", `connectors: the request body is over ${limits.maxBodyBytes} bytes`, slug);
    }
    if (!admission.mayRead(call)) return denied(503, "too many bytes", busy(call), slug);
    const open = inFlight.get(slug) ?? 0;
    if (open >= limits.maxInFlight) return denied(503, "too many calls", `connectors: ${slug} already has ${open} connector calls under way`, slug);
    if (underWay >= limits.maxCalls) {
      return denied(503, "too many calls", `connectors: the proxy already has ${underWay} connector calls under way, try again in a moment`, slug);
    }
    let headers: Headers;
    try {
      headers = upstreamHeaders(new Headers(head.headers), connector.header, connector.value, base.port === 443 ? base.host : `${base.host}:${base.port}`);
    } catch {
      return refuse(call, 400, "invalid", "connectors: a request header does not read");
    }
    inFlight.set(slug, open + 1);
    underWay++;
    call.slug = slug;
    call.connector = name;

    call.timer = setTimeout(() => {
      if (isClosed(call) || call.answer !== null) return;
      failAnswer(call, "no answer in time", 504);
    }, limits.headersTimeoutMs);
    if (!(await connect(call, resolution.addresses, base.host, base.port))) {
      if (!isClosed(call)) failAnswer(call, "the connection failed");
      return;
    }

    call.phase = "open";
    call.lastActivity = Date.now();
    const path = `${base.path}${rest}` || "/";
    const spelled = ["Host", connector.header];
    send(call, call.upstream, call.client, latin1Bytes(upstreamHead(head.method, `${path}${search}`, headers, framing, spelled)));
    // An app that waits to be told before it sends its body is told once the
    // upstream is there to take it.
    if (!call.requestEnded && expectsContinue(head)) send(call, call.client, call.upstream, CONTINUE);
    const early = call.early;
    admission.account(call, -call.earlyBytes);
    call.early = [];
    call.earlyBytes = 0;
    for (const bytes of early) {
      fromClient(call, bytes);
      if (isClosed(call)) return;
    }
    // A budget already crossed holds the new call back like the others.
    if (admission.mayRead(call)) resumeIfAllowed(call, call.client, call.upstream);
    else stopReading(call);
  }

  async function handle(call: Call): Promise<void> {
    const head = parseHead(latin1Text(call.head));
    call.head = EMPTY;
    if (head === null) return refuse(call, 400, "invalid", "connectors: not an HTTP request");
    if (head.version !== "HTTP/1.1") return refuse(call, 505, "invalid", "connectors: HTTP/1.1 only");
    if (!head.headers.every(([, value]) => isValidValue(value))) return refuse(call, 400, "invalid", "connectors: a header value with a control character");
    // Origin form only, printable ASCII, as an app's client sends it.
    if (!/^\/(?!\/)[!-~]*$/.test(head.target)) return refuse(call, 400, "invalid", "connectors: call /connectors/<name>/<path>");
    // TRACE answers with the request it received, the credential the proxy
    // adds included, which RFC 9110 says a client never sends one with; TRACK
    // is its old twin, and CONNECT asks for a tunnel, which a connector is not.
    if (["TRACE", "TRACK", "CONNECT"].includes(head.method)) return refuse(call, 405, "invalid", `connectors: ${head.method} is refused`);
    const announced = requestFraming(head.headers);
    if ("status" in announced) return refuse(call, announced.status, "invalid", `connectors: ${announced.message}`);
    // A GET or a HEAD goes up without a body, as fetch sent it before: an
    // upstream that expects none may leave one unread, and read it as a second
    // request, outside the connector's path. What the app sent is dropped.
    const framing: Framing = head.method === "GET" || head.method === "HEAD" ? { kind: "none" } : announced;
    call.method = head.method;
    call.request = bodyReader(framing);
    call.chunked = framing.kind === "chunked";
    call.requestEnded = framing.kind === "none" || (framing.kind === "length" && framing.length === 0);

    const url = new URL(head.target, "http://connectors.invalid");
    const who = await call.caller;
    if (isClosed(call)) return;
    if (url.pathname === "/audit" || url.pathname === "/status") {
      if (head.method !== "GET") return refuse(call, 405, "invalid", "GET only");
      return dashboard(call, who, url);
    }
    const target = connectorPath(url.pathname);
    if (target === null) return refuse(call, 404, "not-found", "connectors: call /connectors/<name>/<path>");
    return forward(call, head, who, target.name, target.rest, url.search, framing);
  }

  /**
   * Counts the connection in its project's share as soon as the kernel names
   * the project, before any head, as proxy.ts does and against the same
   * admission: beyond its share on both ports together, a project is refused
   * at once; another kind of caller is refused on its head.
   */
  function admit(call: Call, caller: Caller): void {
    if (isClosed(call) || caller.kind !== "project") return;
    const full = admission.join(call, caller.slug, call.client.queued + call.upstream.queued + call.earlyBytes);
    if (full !== null) {
      options.audit.denied({ target: caller.slug, destination: "connectors", reason: "too many connections" });
      refuse(call, 503, "refused", `connectors: ${caller.slug} already holds ${full} connections to the proxy, both ports together`);
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
          attempt: 0,
          attempting: null,
          early: [],
          earlyBytes: 0,
          slug: null,
          connector: "",
          method: "",
          request: null,
          requestEnded: false,
          chunked: false,
          bodyBytes: 0,
          answerHead: EMPTY,
          answer: null,
          answered: false,
        };
        socket.data = call;
        if (!admission.enter(call)) {
          call.phase = "closed";
          const answer = jsonAnswer(503, { error: "refused", message: "connectors: the proxy holds too many connections, try again in a moment" }, true);
          lingering.start(socket as unknown as Socket<unknown>, answer);
          return;
        }
        calls.add(call);
        // Registered before handle() awaits the same promise: the share is
        // settled by the time the head is judged.
        void call.caller.then((caller) => admit(call, caller));
        call.timer = setTimeout(() => {
          if (call.phase === "head") refuse(call, 408, "invalid", "connectors: the request head did not arrive in time");
        }, limits.headTimeoutMs);
      },

      data(socket, chunk) {
        const call = socket.data;
        switch (call.phase) {
          case "head": {
            call.head = concat(call.head, chunk);
            const end = headEnd(call.head);
            if (end === -1) {
              if (call.head.length > limits.headBytes) refuse(call, 431, "invalid", "connectors: request head too large");
              return;
            }
            if (end > limits.headBytes) return refuse(call, 431, "invalid", "connectors: request head too large");
            if (call.timer !== null) clearTimeout(call.timer);
            call.timer = null;
            call.phase = "deciding";
            // Nothing more is read until the call is judged and its upstream
            // there: what follows the head waits in the kernel.
            pause(call.client);
            const early = call.head.slice(end);
            call.head = call.head.subarray(0, end);
            holdEarly(call, early);
            if (isClosed(call)) return;
            handle(call).catch((error: unknown) => {
              log(`connectors: unexpected error (${error instanceof Error ? error.name : "unknown"})`);
              refuse(call, 500, "failure", "connectors: unexpected error");
            });
            return;
          }
          case "deciding":
            // Paused, but a read already under way may still deliver.
            holdEarly(call, copy(chunk));
            return;
          case "open":
            fromClient(call, chunk);
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
        // Nobody is left to answer: the upstream is let go of at once.
        close(call);
      },

      error() {
        // close follows.
      },
    },
  });

  // One sweep for every call, rather than a timer per socket: an answer that
  // streams has one silent side. Activity is a byte delivered.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const call of calls) {
      if (call.phase === "open" && now - call.lastActivity > limits.idleMs) close(call);
    }
  }, Math.min(30_000, limits.idleMs));

  return {
    port: listener.port,
    open: () => calls.size,
    calls: () => underWay,
    buffered: () => admission.held(),
    lingering: () => lingering.size(),
    stop() {
      clearInterval(sweep);
      for (const call of calls) close(call);
      lingering.stop();
      listener.stop(true);
    },
  };
}
