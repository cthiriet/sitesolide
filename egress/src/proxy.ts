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
 * read in their client's error, and counted for the audit, and the socket
 * lingers long enough for the client to read it (see linger()).
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
  /** Bytes held for all of one project's connections, before every one of them stops reading. */
  projectBufferBytes: number;
  /** Bytes held for every connection, before the whole proxy stops reading. */
  totalBufferBytes: number;
  /** Bytes a client may send before its tunnel opens, kept until it does. */
  pendingBytes: number;
  /** How long a refused connection is still read, and dropped, once answered: see linger(). */
  lingerMs: number;
  /** How much it may send in that time before the socket is cut. */
  lingerBytes: number;
};

/**
 * What the proxy may hold, worked out against the unit's MemoryMax=256M,
 * which Bun itself (some 50 MiB), the kernel's socket buffers (charged to
 * the unit as well) and the garbage collector's slack share.
 *
 * Bytes wait in the proxy only while one end reads slower than the other
 * sends. A direction stops reading the sending side once bufferBytes wait,
 * but a pause is not immediate: Bun hands over what one read returned, up to
 * 512 KiB, and keeps reading a socket as long as each read fills that much,
 * so the pause lands once the kernel's receive buffer is drained, 6 MiB at
 * most with Linux's default net.ipv4.tcp_rmem. A direction may thus hold
 * 64 KiB + 6.5 MiB, and 128 tunnels x 2 directions of that come to 1.6 GiB:
 * the per-direction mark alone bounds no project. It keeps one tunnel from
 * taking its project's share, and the share is counted on its own.
 *
 * Past projectBufferBytes, every tunnel of that project stops reading; past
 * totalBufferBytes, every tunnel of the proxy; each until half has drained.
 * A paused socket is not read even if its event was already due in that
 * turn of the loop (uSockets masks the ready events with the ones still
 * asked for), so only the socket being read when a line is crossed goes past
 * it, by 6.5 MiB at most:
 *
 *   one project    8 MiB + 6.5 MiB +  128 heads x 16 KiB  =  16.5 MiB
 *   all projects  32 MiB + 6.5 MiB + 1024 heads x 16 KiB  =  54.5 MiB
 *
 * A chunk written in part keeps at most twice what it counts (see flush), so
 * 93 MiB at the very worst for everyone, beside some 50 MiB for Bun: the rest
 * of the 256 MiB is margin for the kernel's buffers, which no constant here
 * bounds, and for the collector. Bytes sent before a tunnel opens count the
 * same, and are capped per connection by pendingBytes. A refused connection
 * that lingers holds nothing: what it still sends is dropped as it is read.
 */
export const DEFAULT_LIMITS: Limits = {
  maxConnections: 1024,
  maxPerProject: 128,
  headBytes: 16 * 1024,
  headTimeoutMs: 10_000,
  idleMs: 10 * 60_000,
  connectTimeoutMs: 10_000,
  lookupTimeoutMs: 5_000,
  bufferBytes: 64 * 1024,
  projectBufferBytes: 8 * 1024 * 1024,
  totalBufferBytes: 32 * 1024 * 1024,
  pendingBytes: 2 * 1024 * 1024,
  lingerMs: 1000,
  lingerBytes: 64 * 1024,
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
  /** Told to stop reading: what Bun's own flag cannot be trusted to say, see write(). */
  paused: boolean;
};

/** What one project holds of the proxy: its connections, the bytes waiting in them, and whether they read. */
type Share = { slug: string; connections: Set<Connection>; held: number; blocked: boolean };

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
  /** Refused and answered, its client still read for a moment: see linger(). */
  linger: { dropped: number; timer: ReturnType<typeof setTimeout> } | null;
};

export type Proxy = {
  port: number;
  stop: () => void;
  open: () => number;
  /** Bytes waiting in the proxy for a side that has not taken them yet. */
  buffered: () => number;
  /** Refused connections still read before they close, apart from `open`: see linger(). */
  lingering: () => number;
};

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
  /** Refused connections still read once answered, counted apart: see linger(). */
  const lingering = new Set<Connection>();
  const shares = new Map<string, Share>();
  /** Bytes waiting in every queue; past totalBufferBytes, `saturated` until half has drained. */
  let held = 0;
  let saturated = false;

  function pause(side: Side): void {
    side.paused = true;
    // resume() first: after a short write Bun may be reading a socket it
    // still counts as paused, and on which a lone pause() does nothing.
    side.socket?.resume();
    side.socket?.pause();
  }

  function resume(side: Side): void {
    side.paused = false;
    side.socket?.resume();
  }

  /**
   * Writes to a side and keeps it from reading if it was paused. Bun 1.3.11
   * turns a socket's reading back on whenever a write to it comes up short
   * (uSockets' us_socket_write asks for readable and writable both, whatever
   * pause() said) and still counts it as paused, so that the next pause()
   * does nothing. A tunnel whose two ends both send and neither reads, each
   * end being written to while it should not be read, was read without
   * limit: gigabytes held in seconds. resume() then pause() puts the polling
   * and the flag back in step.
   */
  function write(side: Side, chunk: Uint8Array): number {
    const socket = side.socket!;
    const written = Math.max(socket.write(chunk), 0);
    if (written < chunk.length && side.paused) {
      socket.resume();
      socket.pause();
    }
    return written;
  }

  /** May this connection's sides read, as far as the budgets go? */
  function mayRead(connection: Connection): boolean {
    return !saturated && !(connection.share?.blocked ?? false);
  }

  /** A tunnel's sides stop reading, but one whose peer is gone, which is read to see it close (see sideClosed). */
  function stopReading(connection: Connection): void {
    if (connection.phase !== "open") return;
    if (connection.upstream.socket !== null && !connection.client.paused) pause(connection.client);
    if (connection.client.socket !== null && !connection.upstream.paused) pause(connection.upstream);
  }

  /** A side reads again once nothing it sent waits for the other side, and no budget holds it back. */
  function resumeIfAllowed(connection: Connection, from: Side, to: Side): void {
    if (connection.phase !== "open" || from.socket === null || to.socket === null) return;
    if (to.queue.length > 0 || !mayRead(connection)) return;
    resume(from);
  }

  function startReading(connection: Connection): void {
    resumeIfAllowed(connection, connection.client, connection.upstream);
    resumeIfAllowed(connection, connection.upstream, connection.client);
  }

  /**
   * Counts bytes that start or stop waiting, and stops or restarts reading
   * where a budget is crossed: a whole project past projectBufferBytes, the
   * whole proxy past totalBufferBytes, until half has drained. See
   * DEFAULT_LIMITS for why the mark of each direction is not enough.
   */
  function account(connection: Connection, bytes: number): void {
    held += bytes;
    const share = connection.share;
    if (share !== null) share.held += bytes;
    if (bytes > 0) overBudget(share);
    else if (bytes < 0) underBudget(share);
  }

  function overBudget(share: Share | null): void {
    if (share !== null && !share.blocked && share.held > limits.projectBufferBytes) {
      share.blocked = true;
      for (const each of share.connections) stopReading(each);
    }
    if (!saturated && held > limits.totalBufferBytes) {
      saturated = true;
      for (const each of connections) stopReading(each);
    }
  }

  function underBudget(share: Share | null): void {
    if (share !== null && share.blocked && share.held <= limits.projectBufferBytes / 2) {
      share.blocked = false;
      for (const each of share.connections) startReading(each);
    }
    if (saturated && held <= limits.totalBufferBytes / 2) {
      saturated = false;
      for (const each of connections) startReading(each);
    }
  }

  /** Bytes for a side that cannot take them now. */
  function enqueue(connection: Connection, to: Side, chunk: Uint8Array): void {
    to.queue.push(chunk);
    to.queued += chunk.length;
    account(connection, chunk.length);
  }

  /** Writes what it can, keeps the rest, and pauses the other side while too much waits. */
  function send(connection: Connection, to: Side, from: Side, chunk: Uint8Array): void {
    if (to.socket === null) return;
    if (to.queue.length === 0) {
      const written = write(to, chunk);
      if (written === chunk.length) return;
      chunk = copy(chunk.subarray(written));
    } else {
      chunk = copy(chunk);
    }
    if (to.queued + chunk.length > limits.bufferBytes && !from.paused) pause(from);
    enqueue(connection, to, chunk);
  }

  function flush(connection: Connection, to: Side, from: Side): void {
    if (to.socket === null) return;
    let released = 0;
    while (to.queue.length > 0) {
      const chunk = to.queue[0]!;
      const written = write(to, chunk);
      // A byte delivered is activity: a slow reader catching up is no idle
      // tunnel.
      if (written > 0) connection.lastActivity = Date.now();
      released += written;
      if (written < chunk.length) {
        // The rest is a view of the chunk, which stays in memory whole. Once
        // the rest is under half of it, a copy lets the chunk go: what a
        // queue keeps is never more than twice what it counts.
        const rest = chunk.subarray(written);
        to.queue[0] = rest.length * 2 < rest.buffer.byteLength ? copy(rest) : rest;
        break;
      }
      to.queue.shift();
    }
    to.queued -= released;
    account(connection, -released);
    if (to.queue.length > 0) return;
    if (to.ending) return close(connection);
    resumeIfAllowed(connection, from, to);
  }

  /** Bytes the client sent before its tunnel opened, kept for the upstream, within their cap and the budgets. */
  function holdEarly(connection: Connection, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    enqueue(connection, connection.upstream, bytes);
    if (connection.upstream.queued > limits.pendingBytes) {
      return refuse(connection, 400, "egress: too much sent before the tunnel opened");
    }
    if (!mayRead(connection)) {
      const who = connection.share?.blocked ? connection.share.slug : "the proxy";
      return refuse(connection, 503, `egress: ${who} already holds too many bytes its peers have not read, try again in a moment`);
    }
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
    const dropped = gone.queued;
    gone.queue = [];
    gone.queued = 0;
    account(connection, -dropped);
    if (other.socket === null || other.queue.length === 0) return close(connection);
    other.ending = true;
    resume(other);
  }

  /**
   * The connection's end, both sides at once. With an `answer`, a refusal
   * before the tunnel opened: the client is answered and lingers rather than
   * being closed on the spot.
   */
  function close(connection: Connection, answer: string | null = null): void {
    if (isClosed(connection)) return;
    connection.phase = "closed";
    if (connection.headTimer !== null) clearTimeout(connection.headTimer);
    connections.delete(connection);
    const share = connection.share;
    if (share !== null) {
      share.connections.delete(connection);
      if (share.connections.size === 0) shares.delete(share.slug);
    }
    const released = connection.client.queued + connection.upstream.queued;
    for (const side of [connection.client, connection.upstream]) {
      side.queue = [];
      side.queued = 0;
    }
    account(connection, -released);
    connection.upstream.socket?.end();
    if (answer === null) connection.client.socket?.end();
    else linger(connection, answer);
  }

  function refuse(connection: Connection, status: number, message: string): void {
    close(connection, refusal(status, message));
  }

  /**
   * A refused client answered, then read and ignored for a moment before its
   * socket closes: a lingering close, as nginx and Apache do it.
   *
   * A refusal often comes while the client is still sending: a body behind
   * its head, a head too large. Closed with those bytes unread, or receiving
   * more once closed, a socket answers with a reset, and a reset makes the
   * client's kernel throw away what it received and had not read yet: the
   * answer itself. The client saw "connection reset" instead of the sentence
   * that says why, 2 attempts in 40 on a loaded machine. So the answer goes,
   * a FIN behind it, and what still arrives is read and dropped until the
   * client closes its side, which it does once it has read the answer: for
   * lingerMs and lingerBytes at most, past which the socket is cut, the
   * client having had its chance.
   *
   * shutdown(), not end(): in Bun 1.3.11 end() on a server socket closes the
   * descriptor at once, unread bytes and all, which is the reset this
   * avoids. shutdown() without an argument is shutdown(SHUT_WR), the socket
   * reads on; shutdown(true), whatever its documentation says, closes the
   * reading side. Both measured on this Bun, which the tests hold to.
   *
   * Lingering sockets hold no byte and leave the connections' count at
   * once; they are bounded apart, by maxConnections, past which a refusal
   * closes at once as it used to.
   */
  function linger(connection: Connection, answer: string): void {
    const socket = connection.client.socket;
    if (socket === null) return;
    socket.write(answer);
    if (lingering.size >= limits.maxConnections) {
      socket.end();
      return;
    }
    lingering.add(connection);
    connection.linger = { dropped: 0, timer: setTimeout(() => cut(connection), limits.lingerMs) };
    // Paused while its head was judged, perhaps: what it sends is read now,
    // to be dropped, and nothing is written to it any more, so the quirk
    // write() works around cannot turn that back. Resumed before the
    // shutdown, never after: Bun 1.3.11 closes a socket shut down while
    // paused, at once, which is the very reset this avoids.
    socket.resume();
    socket.shutdown();
  }

  /** What a lingering client still sends, dropped; past lingerBytes, the socket is cut. */
  function drop(connection: Connection, bytes: number): void {
    if (connection.linger === null) return;
    connection.linger.dropped += bytes;
    if (connection.linger.dropped > limits.lingerBytes) cut(connection);
  }

  /** The linger is over: the client closed its side, or ran out of time or of bytes. */
  function unlinger(connection: Connection): void {
    if (connection.linger === null) return;
    clearTimeout(connection.linger.timer);
    connection.linger = null;
    lingering.delete(connection);
  }

  function cut(connection: Connection): void {
    const socket = connection.client.socket;
    unlinger(connection);
    socket?.terminate();
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
    const share = shares.get(caller.slug) ?? { slug: caller.slug, connections: new Set<Connection>(), held: 0, blocked: false };
    if (share.connections.size >= limits.maxPerProject) {
      options.audit.denied({ target: caller.slug, destination: null, reason: "too many connections" });
      return refuse(connection, 503, `egress: ${caller.slug} already holds ${share.connections.size} connections through the proxy`);
    }
    shares.set(caller.slug, share);
    share.connections.add(connection);
    connection.share = share;
    // What it sent before the kernel answered counts for its project too.
    share.held += connection.client.queued + connection.upstream.queued;
    overBudget(share);
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
                send(owner, owner.client, owner.upstream, chunk);
              },
              drain(socket) {
                // Not before the tunnel opens: the bytes the client sent
                // early go behind the head handle() puts first.
                if (isUpstream(socket) && socket.data.phase === "open") flush(socket.data, socket.data.upstream, socket.data.client);
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

  async function handle(connection: Connection): Promise<void> {
    const text = decoder.decode(connection.head);
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
    // A budget already crossed holds the new tunnel back like the others.
    if (!mayRead(connection)) stopReading(connection);
    if (forward === null) {
      send(connection, connection.client, connection.upstream, encoder.encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    } else {
      // The rewritten head goes before what the client sent behind its own.
      const rewritten = encoder.encode(forwardedHead(head, forward));
      connection.upstream.queue.unshift(rewritten);
      connection.upstream.queued += rewritten.length;
      account(connection, rewritten.length);
    }
    // What came behind the head, in the same read or during the decision,
    // waits in the upstream's queue: written now, and the client is read
    // again once it is.
    flush(connection, connection.upstream, connection.client);
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
          client: { socket: socket as unknown as Socket<unknown>, queue: [], queued: 0, ending: false, paused: false },
          upstream: { socket: null, queue: [], queued: 0, ending: false, paused: false },
          lastActivity: Date.now(),
          headTimer: null,
          attempt: 0,
          linger: null,
        };
        socket.data = connection;
        if (connections.size >= limits.maxConnections) {
          connection.phase = "closed";
          linger(connection, refusal(503, "egress: the proxy holds too many connections, try again in a moment"));
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
            pause(connection.client);
            // What came behind the head in the same read waits for the
            // upstream, counted.
            const early = connection.head.slice(end);
            connection.head = connection.head.subarray(0, end);
            holdEarly(connection, early);
            if (isClosed(connection)) return;
            handle(connection).catch((error: unknown) => {
              log(`egress: unexpected error (${error instanceof Error ? error.name : "unknown"})`);
              refuse(connection, 502, "egress: unexpected error");
            });
            return;
          }
          case "deciding":
            // Paused, but a read already under way may still deliver: kept,
            // and sent behind the head once the upstream is open.
            holdEarly(connection, copy(chunk));
            return;
          case "open":
            // The upstream gone, this reaches nobody: see sideClosed().
            if (connection.upstream.socket === null) return;
            connection.lastActivity = Date.now();
            send(connection, connection.upstream, connection.client, chunk);
            return;
          case "closed":
            // Refused and answered: dropped, see linger().
            drop(connection, chunk.length);
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
        unlinger(connection);
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
    buffered: () => held,
    lingering: () => lingering.size,
    stop() {
      clearInterval(sweep);
      for (const connection of connections) close(connection);
      for (const connection of lingering) cut(connection);
      listener.stop(true);
    },
  };
}
