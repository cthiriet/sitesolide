/**
 * The forward proxy: what HTTPS_PROXY and HTTP_PROXY point at.
 *
 * A raw TCP listener, because a CONNECT tunnel is not an HTTP exchange the
 * server answers but a pipe it opens: once the client is told
 * `200 Connection Established`, every byte goes through untouched, the TLS
 * handshake with the real host included. The proxy never sees inside it.
 *
 * Per connection, in order:
 *
 *   1. who is calling: the kernel's answer, started as soon as the connection
 *      opens (proc-net.ts), and the project's share of connections counted
 *      from that moment;
 *   2. the head, bounded in size and in time;
 *   3. the destination it names, and whether the caller's manifest lists it
 *      (decide.ts);
 *   4. the resolution, every address judged (resolve.ts);
 *   5. the connection, to an address that was judged, then the pipe.
 *
 * Plain HTTP in absolute form, what HTTP_PROXY produces, goes through the same
 * steps, its head rewritten for the origin, then the same pipe: a second
 * request on that connection can only ever reach the address already judged.
 *
 * Every refusal is answered with a status and a sentence the developer can
 * read in their client's error, and counted for the audit.
 */
import type { Socket, TCPSocketListener } from "bun";
import type { HostPattern } from "../../bin/cli/egress";
import type { Audit } from "./audit";
import {
  connectDestination,
  decide,
  forwardDestination,
  forwardedHead,
  headEnd,
  parseHead,
  refusal,
  type Destination,
} from "./decide";
import type { Caller, Peer } from "./proc-net";
import { machineAddresses, resolveChecked, type Lookup, type OwnAddresses } from "./resolve";

export type Limits = {
  /** Open client connections, all projects together. */
  maxConnections: number;
  /** Open connections per project, counted from the moment the caller is known, head or no head. */
  maxPerProject: number;
  /** The biggest head accepted. */
  headBytes: number;
  /** Time left to the head to arrive whole. */
  headTimeoutMs: number;
  /** A tunnel that delivers no byte in either direction for this long is closed. */
  idleMs: number;
  connectTimeoutMs: number;
  lookupTimeoutMs: number;
  /** Bytes held for a side that cannot take them yet, before reading the other pauses. */
  bufferBytes: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxConnections: 1024,
  maxPerProject: 128,
  headBytes: 16 * 1024,
  headTimeoutMs: 10_000,
  idleMs: 10 * 60_000,
  connectTimeoutMs: 10_000,
  lookupTimeoutMs: 5_000,
  bufferBytes: 1024 * 1024,
};

export type ProxyOptions = {
  hostname: string;
  port: number;
  identify: (peer: Peer) => Caller | Promise<Caller>;
  /** The hosts a project's manifest lists, null without a manifest that reads. */
  egressOf: (slug: string) => HostPattern[] | null;
  lookup: Lookup;
  /** The machine's own addresses, refused like the loopback; read from its interfaces unless a test says otherwise. */
  ownAddresses?: OwnAddresses;
  audit: Pick<Audit, "denied">;
  /**
   * Where to connect for a judged address. Production connects to the address
   * itself; the tests reroute a public address to a local server, which is
   * how they prove the proxy connects to the address it judged.
   */
  route?: (address: string, port: number) => { hostname: string; port: number };
  limits?: Partial<Limits>;
  log?: (line: string) => void;
};

type Side = {
  socket: Socket<unknown> | null;
  /** Bytes waiting for this side to drain. */
  queue: Uint8Array[];
  queued: number;
  /** Its peer is gone: the connection closes once this queue is written. */
  ending: boolean;
};

/** What one project holds of the proxy. */
type Share = { slug: string; connections: Set<Connection> };

type Connection = {
  phase: "head" | "deciding" | "open" | "closed";
  head: Uint8Array;
  caller: Promise<Caller>;
  /** The caller's project, once the kernel named one and its share had room. */
  share: Share | null;
  client: Side;
  upstream: Side;
  lastActivity: number;
  headTimer: ReturnType<typeof setTimeout> | null;
  /** The number of the current connection attempt, see connect(). */
  attempt: number;
};

export type Proxy = { port: number; stop: () => void; open: () => number };

/**
 * Read through a function: TypeScript keeps a phase narrowed across an
 * `await`, during which the client may well have gone.
 */
function isClosed(connection: Connection): boolean {
  return connection.phase === "closed";
}

/**
 * A copy of what a read delivered, to keep it beyond the callback: its memory
 * may be reused by the next read. Not `slice`, which on the Buffer a socket
 * hands over is a view, not a copy.
 */
function copy(view: Uint8Array): Uint8Array {
  const kept = new Uint8Array(view.length);
  kept.set(view);
  return kept;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

const decoder = new TextDecoder("latin1");
const encoder = new TextEncoder();

export function startProxy(options: ProxyOptions): Proxy {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const log = options.log ?? ((line: string) => console.log(line));
  const route = options.route ?? ((address: string, port: number) => ({ hostname: address, port }));
  const ownAddresses = options.ownAddresses ?? machineAddresses();
  const connections = new Set<Connection>();
  const shares = new Map<string, Share>();

  /** Writes what it can, keeps the rest, and pauses the other side while too much waits. */
  function send(to: Side, from: Side, chunk: Uint8Array): void {
    if (to.socket === null) return;
    if (to.queue.length === 0) {
      const written = to.socket.write(chunk);
      if (written === chunk.length) return;
      chunk = copy(chunk.subarray(Math.max(written, 0)));
    } else {
      chunk = copy(chunk);
    }
    to.queue.push(chunk);
    to.queued += chunk.length;
    if (to.queued > limits.bufferBytes) from.socket?.pause();
  }

  function flush(connection: Connection, to: Side, from: Side): void {
    if (to.socket === null) return;
    while (to.queue.length > 0) {
      const chunk = to.queue[0]!;
      const written = Math.max(to.socket.write(chunk), 0);
      // A byte delivered is activity: a slow reader catching up is no idle
      // tunnel.
      if (written > 0) connection.lastActivity = Date.now();
      if (written < chunk.length) {
        to.queue[0] = chunk.subarray(written);
        to.queued -= written;
        return;
      }
      to.queue.shift();
      to.queued -= chunk.length;
    }
    if (to.ending) return close(connection);
    from.socket?.resume();
  }

  /**
   * One side is gone, whichever goes first. What waited for it can never be
   * delivered, and is dropped. What waits for the other side is delivered
   * first, an answer cut at the end being worse than a late close, and the
   * connection closes once it is written; with nothing waiting, it closes
   * now. Until then the other side is read again, so that its own close is
   * seen at once, and what it sends, which reaches nobody, is dropped without
   * counting as activity: a peer that trickles bytes it knows go nowhere is
   * swept like an idle tunnel. Left as they were, two queues holding bytes at
   * the close kept the connection, and its place in the project's share,
   * until the idle sweep, or for ever behind such a trickle.
   */
  function sideClosed(connection: Connection, gone: Side, other: Side): void {
    if (isClosed(connection)) return;
    gone.queue = [];
    gone.queued = 0;
    if (other.socket === null || other.queue.length === 0) return close(connection);
    other.ending = true;
    other.socket.resume();
  }

  function close(connection: Connection): void {
    if (isClosed(connection)) return;
    connection.phase = "closed";
    if (connection.headTimer !== null) clearTimeout(connection.headTimer);
    connections.delete(connection);
    const share = connection.share;
    if (share !== null) {
      share.connections.delete(connection);
      if (share.connections.size === 0) shares.delete(share.slug);
    }
    connection.upstream.socket?.end();
    connection.client.socket?.end();
  }

  function refuse(connection: Connection, status: number, message: string): void {
    connection.client.socket?.write(refusal(status, message));
    close(connection);
  }

  /**
   * Counts the connection in its project's share as soon as the kernel names
   * the project, before any head. Counted later, once the head was read, the
   * share let one project open the proxy's every slot with connections that
   * never send one, each held for the head's delay and opened again, and
   * starve every other project. Beyond its share, a project is refused at
   * once; another kind of caller is refused on its head, with the sentence
   * that names it.
   */
  function admit(connection: Connection, caller: Caller): void {
    if (isClosed(connection) || caller.kind !== "project") return;
    const share = shares.get(caller.slug) ?? { slug: caller.slug, connections: new Set<Connection>() };
    if (share.connections.size >= limits.maxPerProject) {
      options.audit.denied({ target: caller.slug, destination: null, reason: "too many connections" });
      return refuse(connection, 503, `egress: ${caller.slug} already holds ${share.connections.size} connections through the proxy`);
    }
    shares.set(caller.slug, share);
    share.connections.add(connection);
    connection.share = share;
  }

  /** Is this socket the connection's upstream, and not an attempt given up on? */
  const isUpstream = (socket: Socket<Connection>) => socket.data.upstream.socket === (socket as unknown as Socket<unknown>);

  /**
   * Tries each judged address in turn, within the delay. Each attempt carries
   * a number, and a socket adopts the connection in its `open` only if its
   * attempt is still the current one: an address that answers after its delay
   * ran out is closed, and its events never reach the client.
   */
  async function connect(connection: Connection, addresses: string[], port: number): Promise<Socket<Connection> | null> {
    for (const address of addresses) {
      const target = route(address, port);
      const attempt = ++connection.attempt;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), limits.connectTimeoutMs);
        });
        const socket = await Promise.race([
          Bun.connect<Connection>({
            hostname: target.hostname,
            port: target.port,
            data: connection,
            socket: {
              open(socket) {
                const owner = socket.data;
                if (owner.attempt !== attempt || isClosed(owner)) {
                  socket.end();
                  return;
                }
                owner.upstream.socket = socket as unknown as Socket<unknown>;
              },
              data(socket, chunk) {
                if (!isUpstream(socket)) return;
                const owner = socket.data;
                // The client gone, this reaches nobody: see sideClosed().
                if (owner.client.socket === null) return;
                owner.lastActivity = Date.now();
                send(owner.client, owner.upstream, chunk);
              },
              drain(socket) {
                if (isUpstream(socket)) flush(socket.data, socket.data.upstream, socket.data.client);
              },
              close(socket) {
                if (!isUpstream(socket)) return;
                const owner = socket.data;
                owner.upstream.socket = null;
                sideClosed(owner, owner.upstream, owner.client);
              },
              error() {
                // close follows.
              },
            },
          }),
          expired,
        ]);
        if (socket !== null && isUpstream(socket)) return socket;
      } catch {
        // The next address, if there is one.
      } finally {
        clearTimeout(timer);
      }
      if (isClosed(connection)) return null;
    }
    // The last attempt is given up on too, should it answer late.
    connection.attempt++;
    return null;
  }

  async function handle(connection: Connection, headLength: number): Promise<void> {
    const text = decoder.decode(connection.head.subarray(0, headLength));
    const early = connection.head.subarray(headLength).slice();
    connection.head = new Uint8Array(0);
    const head = parseHead(text);
    if (head === null) return refuse(connection, 400, "egress: not an HTTP request");

    let destination: Destination | null;
    let forward: (Destination & { path: string }) | null = null;
    if (head.method === "CONNECT") {
      destination = connectDestination(head.target);
      if (destination === null) {
        return refuse(connection, 400, `egress: CONNECT needs host:port with a host name, got ${head.target.slice(0, 100)}`);
      }
    } else {
      forward = forwardDestination(head.target);
      if (forward === null) {
        const message = head.target.startsWith("/")
          ? "egress: this is the egress proxy; set HTTPS_PROXY to it, and call connectors on the connectors port"
          : `egress: a plain HTTP request must name an http:// address, got ${head.target.slice(0, 100)}`;
        return refuse(connection, 400, message);
      }
      destination = forward;
    }

    const caller = await connection.caller;
    if (isClosed(connection)) return;
    const written = `${destination.host}:${destination.port}`;
    const verdict = decide(caller, caller.kind === "project" ? options.egressOf(caller.slug) : null, destination);
    if (!verdict.allowed) {
      options.audit.denied({
        target: verdict.target,
        destination: written,
        reason: verdict.reason,
        account: caller.kind === "account" ? caller.account : null,
      });
      return refuse(connection, verdict.status, verdict.message);
    }

    const resolution = await resolveChecked(destination.host, options.lookup, limits.lookupTimeoutMs, ownAddresses);
    if (isClosed(connection)) return;
    if (!resolution.ok) {
      options.audit.denied({ target: verdict.slug, destination: written, reason: resolution.reason });
      return refuse(connection, resolution.status, resolution.message);
    }

    const upstream = await connect(connection, resolution.addresses, destination.port);
    if (isClosed(connection)) {
      upstream?.end();
      return;
    }
    if (upstream === null) return refuse(connection, 502, `egress: ${written} did not accept the connection`);

    connection.upstream.socket = upstream as unknown as Socket<unknown>;
    connection.phase = "open";
    connection.lastActivity = Date.now();
    if (forward === null) send(connection.client, connection.upstream, encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    else send(connection.upstream, connection.client, encoder.encode(forwardedHead(head, forward)));
    // What came behind the head, in the same read or during the decision,
    // follows it in order.
    const later = connection.head;
    connection.head = new Uint8Array(0);
    if (early.length > 0) send(connection.upstream, connection.client, early);
    if (later.length > 0) send(connection.upstream, connection.client, later);
    connection.client.socket?.resume();
  }

  const listener: TCPSocketListener<Connection> = Bun.listen<Connection>({
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
        const connection: Connection = {
          phase: "head",
          head: new Uint8Array(0),
          // Asked at once, while the connection is surely established.
          caller: Promise.resolve()
            .then(() => options.identify(peer))
            .catch((): Caller => ({ kind: "unknown", reason: "identification failed" })),
          share: null,
          client: { socket: socket as unknown as Socket<unknown>, queue: [], queued: 0, ending: false },
          upstream: { socket: null, queue: [], queued: 0, ending: false },
          lastActivity: Date.now(),
          headTimer: null,
          attempt: 0,
        };
        socket.data = connection;
        if (connections.size >= limits.maxConnections) {
          socket.write(refusal(503, "egress: the proxy holds too many connections, try again in a moment"));
          socket.end();
          connection.phase = "closed";
          return;
        }
        connections.add(connection);
        // Registered before handle() awaits the same promise: the share is
        // settled by the time the head is judged.
        void connection.caller.then((caller) => admit(connection, caller));
        connection.headTimer = setTimeout(() => {
          if (connection.phase === "head") refuse(connection, 400, "egress: the request head did not arrive in time");
        }, limits.headTimeoutMs);
      },

      data(socket, chunk) {
        const connection = socket.data;
        switch (connection.phase) {
          case "head": {
            connection.head = concat(connection.head, chunk);
            const end = headEnd(connection.head);
            if (end === -1) {
              if (connection.head.length > limits.headBytes) refuse(connection, 431, "egress: request head too large");
              return;
            }
            if (end > limits.headBytes) return refuse(connection, 431, "egress: request head too large");
            if (connection.headTimer !== null) clearTimeout(connection.headTimer);
            connection.headTimer = null;
            connection.phase = "deciding";
            // Nothing more is read until the decision: what follows the head
            // waits in the kernel, not in this process.
            socket.pause();
            handle(connection, end).catch((error: unknown) => {
              log(`egress: unexpected error (${error instanceof Error ? error.name : "unknown"})`);
              refuse(connection, 502, "egress: unexpected error");
            });
            return;
          }
          case "deciding":
            // Paused, but a read already under way may still deliver: kept,
            // and sent behind the head once the upstream is open.
            connection.head = concat(connection.head, chunk);
            if (connection.head.length > limits.bufferBytes) refuse(connection, 400, "egress: too much sent before the tunnel opened");
            return;
          case "open":
            // The upstream gone, this reaches nobody: see sideClosed().
            if (connection.upstream.socket === null) return;
            connection.lastActivity = Date.now();
            send(connection.upstream, connection.client, chunk);
            return;
          case "closed":
            return;
        }
      },

      drain(socket) {
        const connection = socket.data;
        flush(connection, connection.client, connection.upstream);
      },

      close(socket) {
        const connection = socket.data;
        if (connection === undefined) return;
        connection.client.socket = null;
        sideClosed(connection, connection.client, connection.upstream);
      },

      error() {
        // close follows.
      },
    },
  });

  // One sweep for every tunnel, rather than a timer per socket: a tunnel
  // carrying a download has one silent side, and a per-socket idle timeout
  // would cut it. Activity is a byte delivered, never one dropped.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const connection of connections) {
      if (connection.phase === "open" && now - connection.lastActivity > limits.idleMs) close(connection);
    }
  }, Math.min(30_000, limits.idleMs));

  return {
    port: listener.port,
    open: () => connections.size,
    stop() {
      clearInterval(sweep);
      for (const connection of connections) close(connection);
      listener.stop(true);
    },
  };
}
