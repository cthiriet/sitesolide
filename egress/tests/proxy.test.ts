import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, Socket } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EGRESS_PROXY_PORT, egressUnitLines, parseEgressEntry, type HostPattern } from "../../bin/cli/egress";
import { DATA_DIR } from "../src/config";
import type { Caller } from "../src/proc-net";
import { startProxy, type Limits, type Proxy, type ProxyOptions } from "../src/proxy";
import { certificate, lateReader, OPENSSL, rawExchange, recordingAudit, stubLookup, stubRoute } from "./helpers";

/**
 * The proxy on a random port, in front of real local servers: a TLS one that
 * plays an allowed API, a plain HTTP one, and a resolver stub. Who is calling
 * is decided by the test, the kernel's answer being proved apart
 * (proc-net.test.ts on fixtures, proc-kernel.test.ts in a real kernel).
 */
const API = "api.test-zone.invalid";
const PLAIN = "plain.test-zone.invalid";
const PUBLIC_V4 = "203.0.114.10";
const PUBLIC_V6 = "2a01:4f8:ffff::10";
const PLAIN_ADDRESS = "203.0.114.20";
/** A host no manifest of these tests lists. */
const UNLISTED = "evil.test-zone.invalid";
/** Public to the classification, routed to a closed local port by the test. */
const UNROUTED = "203.0.114.99";
/** Bigger than the proxy's buffer, so that both directions have to wait for each other. */
const BIG = 8 * 1024 * 1024;

describe.skipIf(OPENSSL === null)("the egress proxy", () => {
  let tls: { cert: string; key: string };
  let api: Server<undefined>;
  let plain: Server<undefined>;
  let proxy: Proxy;
  let caller: Caller = { kind: "project", slug: "shop", account: "site-shop" };
  let egress: HostPattern[] | null = [];
  const recorded = recordingAudit();
  const seen: { host: string | null; path: string; connection: string | null }[] = [];
  let lookup: ReturnType<typeof stubLookup>;
  let route: ReturnType<typeof stubRoute>;
  /** What the test says the machine's interfaces carry. */
  const own = new Set<string>();

  beforeAll(() => {
    tls = certificate([API]);
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/big") return new Response(new Uint8Array(BIG).fill(7));
        if (path === "/upload") return Response.json({ received: (await req.arrayBuffer()).byteLength });
        return Response.json({ host: req.headers.get("host"), path });
      },
    });
    plain = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        seen.push({ host: req.headers.get("host"), path: new URL(req.url).pathname + new URL(req.url).search, connection: req.headers.get("connection") });
        return new Response("plain origin");
      },
    });
    lookup = stubLookup({
      [API]: [PUBLIC_V4, PUBLIC_V6],
      [PLAIN]: [PLAIN_ADDRESS],
      "internal.test-zone.invalid": [PUBLIC_V4, "10.0.0.5"],
      "metadata.test-zone.invalid": ["169.254.169.254"],
      "mapped.test-zone.invalid": ["::ffff:127.0.0.1"],
      "empty.test-zone.invalid": [],
      "twice.test-zone.invalid": [UNROUTED, PUBLIC_V4],
    });
    route = stubRoute({ [`${PUBLIC_V4}:443`]: api.port!, [`${PLAIN_ADDRESS}:80`]: plain.port! });
    proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => caller,
      egressOf: () => egress,
      lookup,
      ownAddresses: () => own,
      audit: recorded.audit,
      route,
      limits: { headTimeoutMs: 500, connectTimeoutMs: 1000, lookupTimeoutMs: 1000 },
      log: () => undefined,
    });
  });

  afterAll(() => {
    proxy?.stop();
    api?.stop(true);
    plain?.stop(true);
  });

  function allow(...entries: string[]): void {
    egress = entries.map((entry) => parseEgressEntry(entry)!);
    caller = { kind: "project", slug: "shop", account: "site-shop" };
  }

  test("an allowed host: CONNECT, then TLS end to end with the real host's certificate", async () => {
    allow(API);
    // `keepalive: false` on every fetch through this proxy: Bun 1.4.2 keeps a
    // tunnel open after the answer and sends the next request to the same
    // host through it, measured on the test machine on 4 October 2026. The
    // next test would then see no CONNECT at all, and the last one a
    // connection still open. Bun 1.3.11 opened a tunnel per request.
    const response = await fetch(`https://${API}/v1/ping`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
      tls: { ca: tls.cert },
      keepalive: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: API, path: "/v1/ping" });
  });

  test("a Bun app given the unit's environment goes through the proxy by itself", async () => {
    allow(API);
    // The variables exactly as the generated unit writes them, the port moved
    // to this test's proxy: what proves the names and the format are the ones
    // a client reads.
    const environment: Record<string, string> = {};
    for (const line of egressUnitLines({ slug: "shop", port: 3040, start: "/x", egress: [API] })) {
      const match = /^Environment=([A-Za-z_]+)=(.*)$/.exec(line);
      if (match !== null) environment[match[1]!] = match[2]!.replace(`:${EGRESS_PROXY_PORT}`, `:${proxy.port}`);
    }
    expect(Object.keys(environment).sort()).toEqual(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);
    const ca = join(DATA_DIR, "proxy-test-ca.pem");
    writeFileSync(ca, tls.cert);
    const script = [
      `const allowed = await fetch("https://${API}/v1/app");`,
      "console.log(allowed.status, JSON.stringify(await allowed.json()));",
      `const refused = await fetch("https://evil.test-zone.invalid/").then(async (r) => r.status + " " + (await r.text()).trim(), () => "failed");`,
      "console.log(refused);",
    ].join("\n");
    const app = Bun.spawn(["bun", "-e", script], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_EXTRA_CA_CERTS: ca, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output] = await Promise.all([new Response(app.stdout).text(), app.exited]);
    // Bun hands the proxy's refusal to the app as the answer: a 403 whose
    // body names the host and the manifest, readable in the app's own log.
    expect(output.trim().split("\n")).toEqual([
      `200 {"host":"${API}","path":"/v1/app"}`,
      "403 egress: refused, evil.test-zone.invalid:443 is not in the egress list of shop's sitesolide.json",
    ]);
  });

  test.skipIf(Bun.which("curl") === null)("curl given the unit's environment goes through the proxy by itself", async () => {
    allow(API);
    const environment: Record<string, string> = {};
    for (const line of egressUnitLines({ slug: "shop", port: 3040, start: "/x", egress: [API] })) {
      const match = /^Environment=([A-Za-z_]+)=(.*)$/.exec(line);
      if (match !== null) environment[match[1]!] = match[2]!.replace(`:${EGRESS_PROXY_PORT}`, `:${proxy.port}`);
    }
    const ca = join(DATA_DIR, "proxy-test-ca-curl.pem");
    writeFileSync(ca, tls.cert);
    const curl = Bun.spawn(["curl", "-s", "--max-time", "5", "--cacert", ca, `https://${API}/v1/curl`], {
      env: { PATH: process.env.PATH ?? "", ...environment },
      stdout: "pipe",
    });
    const [output] = await Promise.all([new Response(curl.stdout).text(), curl.exited]);
    expect(JSON.parse(output)).toEqual({ host: API, path: "/v1/curl" });
  });

  test("in a tunnel the certificate is the app's to check: the proxy pipes, the app's client refuses another name", async () => {
    // The proxy never sees inside the TLS of a CONNECT, so it neither checks
    // nor could check the certificate: the app's client does, end to end,
    // against the name it asked for. A listed host whose DNS points at a
    // server with a valid certificate for another name gets a tunnel, and the
    // app's handshake fails before the app has sent anything through it.
    allow("decoy.test-zone.invalid");
    const other = certificate(["other.test-zone.invalid"]);
    const decoy = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: other, fetch: () => new Response("decoy") });
    const local = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => caller,
      egressOf: () => egress,
      lookup: stubLookup({ "decoy.test-zone.invalid": [PUBLIC_V4] }),
      audit: recordingAudit().audit,
      route: stubRoute({ [`${PUBLIC_V4}:443`]: decoy.port! }),
      log: () => undefined,
    });
    try {
      const failure = await fetch("https://decoy.test-zone.invalid/", { proxy: `http://127.0.0.1:${local.port}`, tls: { ca: other.cert } }).then(
        () => "accepted",
        (error: { code?: string }) => error.code,
      );
      expect(failure).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    } finally {
      local.stop();
      decoy.stop(true);
    }
  });

  test("the proxy connects to an address it judged, never to the name again", async () => {
    allow(API);
    route.asked.length = 0;
    const response = await fetch(`https://${API}/`, { proxy: `http://127.0.0.1:${proxy.port}`, tls: { ca: tls.cert }, keepalive: false });
    expect(response.status).toBe(200);
    expect(route.asked).toEqual([`${PUBLIC_V4}:443`]);
  });

  test("a large answer and a large upload go through whole, whichever side is slower", async () => {
    allow(API);
    const download = await fetch(`https://${API}/big`, { proxy: `http://127.0.0.1:${proxy.port}`, tls: { ca: tls.cert }, keepalive: false });
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(BIG);
    expect(bytes.every((byte) => byte === 7)).toBe(true);
    const upload = await fetch(`https://${API}/upload`, {
      method: "POST",
      body: new Uint8Array(BIG).fill(3),
      proxy: `http://127.0.0.1:${proxy.port}`,
      tls: { ca: tls.cert },
      keepalive: false,
    });
    expect(await upload.json()).toEqual({ received: BIG });
  });

  test("an address that refuses the connection gives way to the next judged one", async () => {
    allow("twice.test-zone.invalid");
    route.asked.length = 0;
    // The first address routes nowhere (a closed local port), the second to the API.
    const answer = await rawExchange(proxy.port, "CONNECT twice.test-zone.invalid:443 HTTP/1.1\r\n\r\n", 1000);
    expect(answer).toStartWith("HTTP/1.1 200 Connection Established");
    expect(route.asked).toEqual([`${UNROUTED}:443`, `${PUBLIC_V4}:443`]);
  });

  test("a host the manifest does not list is refused, with a sentence naming it", async () => {
    allow(API);
    const answer = await rawExchange(proxy.port, "CONNECT evil.test-zone.invalid:443 HTTP/1.1\r\nHost: evil.test-zone.invalid:443\r\n\r\n");
    expect(answer.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);
    expect(answer).toContain("evil.test-zone.invalid:443 is not in the egress list of shop's sitesolide.json");
    expect(recorded.denied.at(-1)).toEqual({ target: "shop", destination: "evil.test-zone.invalid:443", reason: "not in the list", account: null });
    // Refused before resolving: a refused name is not even looked up.
    expect(lookup.asked).not.toContain("evil.test-zone.invalid");
  });

  test("a listed host on a port it does not name is refused", async () => {
    allow(API);
    const answer = await rawExchange(proxy.port, `CONNECT ${API}:22 HTTP/1.1\r\n\r\n`);
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true);
  });

  test("a listed host that resolves to a private address is refused, one bad address being enough", async () => {
    allow("internal.test-zone.invalid");
    const answer = await rawExchange(proxy.port, "CONNECT internal.test-zone.invalid:443 HTTP/1.1\r\n\r\n");
    expect(answer.startsWith("HTTP/1.1 403")).toBe(true);
    expect(answer).toContain("resolves to 10.0.0.5, a private address");
    expect(recorded.denied.at(-1)).toMatchObject({ target: "shop", reason: "resolves to a private address" });
  });

  test("the cloud metadata service, and the loopback dressed as IPv6, are refused", async () => {
    allow("metadata.test-zone.invalid", "mapped.test-zone.invalid");
    const metadata = await rawExchange(proxy.port, "CONNECT metadata.test-zone.invalid:443 HTTP/1.1\r\n\r\n");
    expect(metadata).toContain("a cloud metadata address");
    const mapped = await rawExchange(proxy.port, "CONNECT mapped.test-zone.invalid:443 HTTP/1.1\r\n\r\n");
    expect(mapped).toContain("a loopback (IPv4-mapped) address");
  });

  test("a listed host that resolves to the machine's own public address is refused like the loopback", async () => {
    // A service listening on every address answers on the public one too, and
    // from the machine itself no provider firewall stands in between.
    allow(API);
    own.add(PUBLIC_V4);
    try {
      const answer = await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
      expect(answer).toStartWith("HTTP/1.1 403");
      expect(answer).toContain(`${API} resolves to ${PUBLIC_V4}, this machine's own address`);
      expect(recorded.denied.at(-1)).toMatchObject({ target: "shop", reason: "resolves to this machine's own address" });
    } finally {
      own.clear();
    }
  });

  test("a name that does not resolve is a 502, not a hang", async () => {
    allow("nowhere.test-zone.invalid", "empty.test-zone.invalid");
    expect(await rawExchange(proxy.port, "CONNECT nowhere.test-zone.invalid:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 502");
    expect(await rawExchange(proxy.port, "CONNECT empty.test-zone.invalid:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 502");
  });

  test("an address instead of a name is refused before anything", async () => {
    allow(API);
    expect(await rawExchange(proxy.port, "CONNECT 203.0.114.10:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await rawExchange(proxy.port, "CONNECT [::1]:443 HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
  });

  test("a caller that is not a project's service is refused whatever the list", async () => {
    allow(API);
    caller = { kind: "account", account: "root" };
    const answer = await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain("the account root");
    expect(recorded.denied.at(-1)).toMatchObject({ target: null, reason: "not a project", account: "root" });
    caller = { kind: "unknown", reason: "no single socket matches the connection" };
    expect(await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n\r\n`)).toContain("a caller nobody could name");
  });

  test("a project without egress reaches nothing", async () => {
    egress = null;
    caller = { kind: "project", slug: "blog", account: "site-blog" };
    expect(await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n\r\n`)).toContain("blog declares no egress");
  });

  test("plain HTTP is forwarded to the judged address, origin form, connection closed", async () => {
    allow(PLAIN);
    seen.length = 0;
    const response = await fetch(`http://${PLAIN}/hello?x=1`, { proxy: `http://127.0.0.1:${proxy.port}`, keepalive: false });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("plain origin");
    expect(seen).toEqual([{ host: PLAIN, path: "/hello?x=1", connection: "close" }]);
  });

  test("a second request on a forwarded connection still reaches only the judged address", async () => {
    allow(PLAIN);
    seen.length = 0;
    route.asked.length = 0;
    lookup.asked.length = 0;
    const answer = await rawExchange(
      proxy.port,
      `GET http://${PLAIN}/first HTTP/1.1\r\nHost: ${PLAIN}\r\n\r\nGET http://evil.test-zone.invalid/second HTTP/1.1\r\nHost: evil.test-zone.invalid\r\n\r\n`,
      1000,
    );
    expect(answer).toContain("plain origin");
    // Past the first head, the connection is a pipe to the judged address:
    // whatever follows reaches that origin, which answers or refuses it, and
    // no other name is ever resolved or connected to.
    expect(route.asked).toEqual([`${PLAIN_ADDRESS}:80`]);
    expect(lookup.asked).toEqual([PLAIN]);
    expect(seen[0]).toEqual({ host: PLAIN, path: "/first", connection: "close" });
  });

  test("a request to the proxy itself says what it is", async () => {
    allow(API);
    const answer = await rawExchange(proxy.port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    expect(answer).toStartWith("HTTP/1.1 400");
    expect(answer).toContain("this is the egress proxy");
  });

  test("a head too large, or never finished, is cut off", async () => {
    allow(API);
    const huge = `CONNECT ${API}:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(20_000)}\r\n\r\n`;
    expect(await rawExchange(proxy.port, huge)).toStartWith("HTTP/1.1 431");
    expect(await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n`)).toContain("did not arrive in time");
  });

  test("what is not HTTP is refused", async () => {
    expect(await rawExchange(proxy.port, "\u0016\u0003\u0001 hello\r\n\r\n")).toStartWith("HTTP/1.1 400");
  });

  test("no connection is left open once the clients are gone", async () => {
    await Bun.sleep(50);
    expect(proxy.open()).toBe(0);
  });
});

/**
 * A raw client of the proxy that keeps what it reads, for the tests that hold
 * connections open on purpose. Its caller is decided by its own port, which
 * is what the proxy's `identify` receives as the peer's.
 */
async function rawClient(port: number) {
  const chunks: Uint8Array[] = [];
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data: (_socket, chunk) => void chunks.push(new Uint8Array(chunk)),
      close: () => closed.resolve(),
      error: () => closed.resolve(),
    },
  });
  return { socket, closed: closed.promise, text: () => new TextDecoder().decode(Bun.concatArrayBuffers(chunks)) };
}

/** An identification by the client's port, as the kernel's would be, the table filled by the test. */
function identifyByPort(owners: Map<number, Caller>) {
  return async (peer: { remotePort: number }): Promise<Caller> => {
    // The test learns its client's port once connected, which may come a
    // moment after the proxy asks.
    for (let i = 0; i < 200 && !owners.has(peer.remotePort); i++) await Bun.sleep(2);
    return owners.get(peer.remotePort) ?? { kind: "unknown", reason: "no owner in the test" };
  };
}

/** What a flooding end writes at a time: big enough to fill every buffer on the way quickly. */
const BLOCK = new Uint8Array(1024 * 1024).fill(9);

/**
 * One end of a tunnel that writes as fast as the other lets it and reads
 * nothing: what makes the proxy hold bytes for it in both directions.
 */
type Flood = { socket: Socket<undefined> | null; written: number; on: boolean };

/**
 * Writes until the socket takes no more. A short write turns a paused Bun
 * socket's reading back on (see `keepPaused` in src/proxy.ts): resume() then
 * pause() puts it back, or this end would read after all.
 */
function pump(flood: Flood): void {
  while (flood.on && flood.socket !== null) {
    const written = flood.socket.write(BLOCK);
    if (written > 0) flood.written += written;
    if (written < BLOCK.length) {
      flood.socket.resume();
      flood.socket.pause();
      return;
    }
  }
}

/** An origin that floods whoever connects, and reads nothing. `flood` is the latest tunnel's. */
function floodingOrigin() {
  const all: Flood[] = [];
  const listener = Bun.listen<Flood>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const flood: Flood = { socket: socket as unknown as Socket<undefined>, written: 0, on: true };
        socket.data = flood;
        all.push(flood);
        socket.pause();
        pump(flood);
      },
      drain: (socket) => pump(socket.data),
      data() {},
      close(socket) {
        socket.data.socket = null;
      },
    },
  });
  return {
    all,
    get flood(): Flood {
      return all.at(-1)!;
    },
    written: () => all.reduce((sum, flood) => sum + flood.written, 0),
    port: listener.port,
    stop: () => listener.stop(true),
  };
}

/** A client that opens a tunnel, then reads nothing until told to, and floods it unless told not to. */
async function floodingClient(port: number, floods = true, onOpen?: (socket: Socket<undefined>) => void) {
  const flood: Flood = { socket: null, written: 0, on: false };
  const answer = Promise.withResolvers<void>();
  let received = 0;
  let head = "";
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        if (head.includes("\r\n\r\n")) received += chunk.length;
        else {
          // latin1: one character per byte, so lengths count bytes.
          head += new TextDecoder("latin1").decode(chunk);
          const end = head.indexOf("\r\n\r\n");
          if (end !== -1) {
            // The proxy's answer and the first bytes of the tunnel can come in
            // one read, and on Linux they do: measured on the test machine on
            // 4 October 2026, the kernel had delivered every byte and this
            // count missed the 127,616 that followed the head.
            received += head.length - end - 4;
            answer.resolve();
          }
        }
      },
      drain: () => pump(flood),
      close: () => closed.resolve(),
      error: () => closed.resolve(),
    },
  });
  flood.socket = socket;
  onOpen?.(socket);
  socket.write(`CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
  await answer.promise;
  socket.pause();
  flood.on = floods;
  pump(flood);
  return {
    flood,
    socket,
    head: () => head,
    received: () => received,
    closed: closed.promise,
    /** Reads again, and floods no more. */
    read: () => {
      flood.on = false;
      socket.resume();
    },
  };
}

describe("what the proxy holds for a slow reader", () => {
  function bench(limits: Partial<Limits> = {}, identify: ProxyOptions["identify"] = () => ({ kind: "project", slug: "shop", account: "site-shop" })) {
    const origin = floodingOrigin();
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify,
      egressOf: () => [parseEgressEntry(API)!, parseEgressEntry(PLAIN)!],
      lookup: stubLookup({ [API]: [PUBLIC_V4], [PLAIN]: [PLAIN_ADDRESS] }),
      audit: recordingAudit().audit,
      route: () => ({ hostname: "127.0.0.1", port: origin.port }),
      limits,
      log: () => undefined,
    });
    return { origin, proxy, stop: () => (proxy.stop(), origin.stop()) };
  }

  /** The sum stops moving: sampled twice, apart. */
  async function settled(read: () => number): Promise<{ before: number; after: number }> {
    await Bun.sleep(400);
    const before = read();
    await Bun.sleep(300);
    return { before, after: read() };
  }

  test("both ends flooding and reading nothing: the proxy stops reading both, and holds little", async () => {
    // Each end makes the proxy write to it while it is paused. Bun turns a
    // paused socket's reading back on when such a write comes up short: left
    // to itself, the proxy read gigabytes here, holding all of it.
    const { origin, proxy, stop } = bench();
    try {
      const client = await floodingClient(proxy.port);
      const written = await settled(() => origin.written() + client.flood.written);
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      // Per direction, the mark and what was already read when the pause
      // landed: at most the kernel's receive buffer, a few MiB here.
      expect(proxy.buffered()).toBeLessThan(16 * 1024 * 1024);
      expect(proxy.buffered()).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("a client that reads nothing makes the proxy stop reading its origin, and reading again lets everything through", async () => {
    const { origin, proxy, stop } = bench({ bufferBytes: 16 * 1024 });
    try {
      const client = await floodingClient(proxy.port, false);
      const written = await settled(() => origin.written());
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      // The client reads: the origin is read again, and what it wrote
      // arrives, every byte of it once it stops.
      client.read();
      await Bun.sleep(200);
      expect(origin.written()).toBeGreaterThan(written.after);
      origin.flood.on = false;
      const total = origin.written();
      for (let i = 0; i < 100 && client.received() < total; i++) await Bun.sleep(20);
      expect(client.received()).toBe(total);
      expect(proxy.buffered()).toBe(0);
    } finally {
      stop();
    }
  });

  test("one project's tunnels together hold at most its budget, and another project's still flow", async () => {
    const owners = new Map<number, Caller>();
    const limits = { bufferBytes: 16 * 1024, projectBufferBytes: 1024 * 1024, totalBufferBytes: 64 * 1024 * 1024 };
    const { origin, proxy, stop } = bench(limits, identifyByPort(owners));
    const as = (slug: string) => (socket: Socket<undefined>) => void owners.set(socket.localPort, { kind: "project", slug, account: `site-${slug}` });
    try {
      // Twelve tunnels whose clients read nothing: each would hold its mark
      // and the read under way when it paused, together far beyond 1 MiB.
      const shop = [];
      for (let i = 0; i < 12; i++) shop.push(await floodingClient(proxy.port, false, as("shop")));
      const written = await settled(() => origin.written());
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      // The budget, and what the one read under way delivered past it.
      expect(proxy.buffered()).toBeLessThan(limits.projectBufferBytes + 4 * 1024 * 1024);

      // Another project is not held back by shop's budget.
      const blog = await floodingClient(proxy.port, false, as("blog"));
      blog.read();
      const before = blog.received();
      await Bun.sleep(200);
      expect(blog.received() - before).toBeGreaterThan(4 * 1024 * 1024);
      blog.socket.terminate();

      // shop's clients read: its budget drains and every tunnel moves again.
      const received = shop.map((client) => client.received());
      for (const client of shop) client.read();
      await Bun.sleep(300);
      shop.forEach((client, i) => expect(client.received()).toBeGreaterThan(received[i]!));
    } finally {
      stop();
    }
  });

  test("all projects together hold at most the proxy's budget", async () => {
    const owners = new Map<number, Caller>();
    const limits = { bufferBytes: 16 * 1024, projectBufferBytes: 64 * 1024 * 1024, totalBufferBytes: 1024 * 1024 };
    const { origin, proxy, stop } = bench(limits, identifyByPort(owners));
    const as = (slug: string) => (socket: Socket<undefined>) => void owners.set(socket.localPort, { kind: "project", slug, account: `site-${slug}` });
    try {
      for (const slug of ["shop", "blog", "notes"]) {
        for (let i = 0; i < 4; i++) await floodingClient(proxy.port, false, as(slug));
      }
      const written = await settled(() => origin.written());
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      expect(proxy.buffered()).toBeLessThan(limits.totalBufferBytes + 4 * 1024 * 1024);
    } finally {
      stop();
    }
  });

  test("what a client sends before its tunnel opens is counted, and capped", async () => {
    const { proxy, stop } = bench({ pendingBytes: 4 * 1024 });
    try {
      // A plain HTTP request whose body follows its head at once: held while
      // the proxy decides, and refused past the cap rather than held whole.
      // Head and 12 KiB of body in one write go as one segment, under the
      // loopback's MTU (16 KiB on macOS, 64 KiB on Linux), and are read
      // together. 256 KiB in one write came in several, and when the first
      // read brought less than the cap, the tunnel opened, the origin
      // flooded the client, and the test timed out: 3 runs in 300.
      const body = "x".repeat(12 * 1024);
      const answer = await rawExchange(proxy.port, `POST http://${PLAIN}/upload HTTP/1.1\r\nHost: ${PLAIN}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      expect(answer).toStartWith("HTTP/1.1 400");
      expect(answer).toContain("too much sent before the tunnel opened");
      expect(proxy.buffered()).toBe(0);
    } finally {
      stop();
    }
  });

  test("a refusal reaches a client still sending its request, and reading only once it has", async () => {
    // The caller is known a moment late, which keeps the head waiting for
    // its verdict while the client sends on.
    const late = async (): Promise<Caller> => {
      await Bun.sleep(150);
      return { kind: "project", slug: "shop", account: "site-shop" };
    };
    const { proxy, stop } = bench({}, late);
    try {
      const rest = new Uint8Array(32 * 1024).fill(120);
      const client = await lateReader(proxy.port);
      client.socket.write(`POST http://${UNLISTED}/upload HTTP/1.1\r\nHost: ${UNLISTED}\r\nContent-Length: ${1024 + rest.length}\r\n\r\n${"x".repeat(1024)}`);
      // The rest of the body arrives while the proxy, paused, judges the
      // head: it waits in the proxy's kernel, unread, when the 403 goes.
      // Closed on the spot, with those bytes unread, the socket sent a reset
      // rather than a FIN, and the reset made the client's kernel throw away
      // the answer it had not read yet: the client saw "connection reset",
      // never the sentence naming the host.
      await Bun.sleep(50);
      expect(client.socket.write(rest)).toBe(rest.length);
      await Bun.sleep(250);
      const answer = await client.read();
      expect(answer).toStartWith("HTTP/1.1 403");
      expect(answer).toContain(UNLISTED);
      await Bun.sleep(50);
      expect(proxy.lingering()).toBe(0);
      expect(proxy.buffered()).toBe(0);
    } finally {
      stop();
    }
  });

  test("a refused client is read for a moment only: past lingerBytes, or past lingerMs, its socket is cut", async () => {
    const head = `POST http://${PLAIN}/upload HTTP/1.1\r\nHost: ${PLAIN}\r\nContent-Length: 999999999\r\n\r\n${"x".repeat(12 * 1024)}`;
    const bytes = bench({ pendingBytes: 4 * 1024, lingerMs: 60_000, lingerBytes: 64 * 1024 });
    try {
      // A client that sends on and on after its answer, reading nothing.
      const flooding = await lateReader(bytes.proxy.port);
      flooding.socket.write(head);
      await Bun.sleep(100);
      expect(bytes.proxy.open()).toBe(0);
      expect(bytes.proxy.lingering()).toBe(1);
      for (let i = 0; i < 8; i++) flooding.socket.write(new Uint8Array(32 * 1024).fill(120));
      await Bun.sleep(100);
      expect(bytes.proxy.lingering()).toBe(0);
    } finally {
      bytes.stop();
    }
    const time = bench({ pendingBytes: 4 * 1024, lingerMs: 300, lingerBytes: 64 * 1024 });
    try {
      // A client that neither sends nor reads nor closes.
      const silent = await lateReader(time.proxy.port);
      silent.socket.write(head);
      await Bun.sleep(100);
      expect(time.proxy.lingering()).toBe(1);
      await Bun.sleep(500);
      expect(time.proxy.lingering()).toBe(0);
    } finally {
      time.stop();
    }
  });
});

describe("closing a tunnel whose both ends hold bytes", () => {
  function bench(idleMs = 60_000) {
    const origin = floodingOrigin();
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
      egressOf: () => [parseEgressEntry(API)!],
      lookup: stubLookup({ [API]: [PUBLIC_V4] }),
      audit: recordingAudit().audit,
      route: () => ({ hostname: "127.0.0.1", port: origin.port }),
      limits: { idleMs },
      log: () => undefined,
    });
    return { origin, proxy, stop: () => (proxy.stop(), origin.stop()) };
  }

  /**
   * Both ends flood and neither reads, until the proxy holds bytes for both;
   * then both stop sending, so that what follows is only the closes. (Bun
   * 1.3 on macOS sometimes never reports the close of a peer it is reading
   * flat out while a write to it waits: a close in the middle of a flood
   * would test that, not the proxy.)
   */
  async function stalled(proxy: Proxy, origin: ReturnType<typeof floodingOrigin>, clientFloods = true) {
    const client = await floodingClient(proxy.port, clientFloods);
    await Bun.sleep(300);
    client.flood.on = false;
    origin.flood.on = false;
    await Bun.sleep(100);
    expect(proxy.open()).toBe(1);
    return client;
  }

  test("the client gone first: the connection is released once the origin goes too, not ten minutes later", async () => {
    const { origin, proxy, stop } = bench();
    try {
      const client = await stalled(proxy, origin);
      // Gone as a killed process goes.
      client.socket.terminate();
      await Bun.sleep(100);
      // The origin then ends its side, as a server does.
      origin.flood.socket?.end();
      await Bun.sleep(300);
      expect(proxy.open()).toBe(0);
    } finally {
      stop();
    }
  });

  test("the origin gone first: what it sent is delivered to a client that reads, then the connection closes", async () => {
    const { origin, proxy, stop } = bench();
    try {
      const client = await stalled(proxy, origin);
      origin.flood.socket?.terminate();
      await Bun.sleep(100);
      expect(proxy.open()).toBe(1);
      // The client reads at last: what the proxy held for it reaches it,
      // then the proxy closes.
      client.read();
      await Promise.race([client.closed, Bun.sleep(3000)]);
      expect(proxy.open()).toBe(0);
      expect(client.received()).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  test("the origin gone first, the client gone too without reading: released at once", async () => {
    const { origin, proxy, stop } = bench();
    try {
      const client = await stalled(proxy, origin);
      origin.flood.socket?.terminate();
      await Bun.sleep(100);
      client.socket.end();
      await Bun.sleep(300);
      expect(proxy.open()).toBe(0);
    } finally {
      stop();
    }
  });

  test("the origin gone, a client that trickles bytes and never reads is swept like an idle tunnel", async () => {
    // Idle longer than stalled() takes to set up, so that the sweep can only
    // come once the trickle has started.
    const { origin, proxy, stop } = bench(800);
    try {
      // A client that sends nothing and reads nothing: the origin's bytes
      // wait for it, and the proxy keeps reading it.
      const client = await stalled(proxy, origin, false);
      origin.flood.socket?.terminate();
      // A byte every 50 ms: it reaches nobody, and must not count as life.
      const trickle = setInterval(() => client.socket.write("x"), 50);
      try {
        for (let i = 0; i < 150 && proxy.open() > 0; i++) await Bun.sleep(20);
        expect(proxy.open()).toBe(0);
      } finally {
        clearInterval(trickle);
      }
    } finally {
      stop();
    }
  });
});

describe("the per-project limit", () => {
  test("refuses a project's connection beyond its share, and frees the share on close", async () => {
    const recorded = recordingAudit();
    const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const lookup = stubLookup({ [API]: [PUBLIC_V4] });
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
      egressOf: () => [parseEgressEntry(API)!],
      lookup,
      audit: recorded.audit,
      route: () => ({ hostname: "127.0.0.1", port: held.port }),
      limits: { maxPerProject: 1 },
      log: () => undefined,
    });
    try {
      const first = await Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: { data() {} } });
      first.write(`CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
      await Bun.sleep(100);
      expect(await rawExchange(proxy.port, `CONNECT ${API}:443 HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 503");
      expect(recorded.denied.at(-1)).toMatchObject({ reason: "too many connections" });
      first.end();
      await Bun.sleep(100);
      const { promise, resolve } = Promise.withResolvers<string>();
      const again = await Bun.connect({
        hostname: "127.0.0.1",
        port: proxy.port,
        socket: { data: (_socket, chunk) => resolve(new TextDecoder().decode(chunk)) },
      });
      again.write(`CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
      expect(await promise).toStartWith("HTTP/1.1 200");
      again.end();
    } finally {
      proxy.stop();
      held.stop(true);
    }
  });

  test("counts a connection from the moment its project is known, before any head: silent ones cannot starve the others", async () => {
    const recorded = recordingAudit();
    const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const owners = new Map<number, Caller>();
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      egressOf: () => [parseEgressEntry(API)!],
      lookup: stubLookup({ [API]: [PUBLIC_V4] }),
      audit: recorded.audit,
      route: () => ({ hostname: "127.0.0.1", port: held.port }),
      limits: { maxPerProject: 2, headTimeoutMs: 3000 },
      log: () => undefined,
    });
    const open = async (slug: string) => {
      const client = await rawClient(proxy.port);
      owners.set(client.socket.localPort, { kind: "project", slug, account: `site-${slug}` });
      return client;
    };
    try {
      // Two connections that never send a head: the whole share of shop.
      const silent = [await open("shop"), await open("shop")];
      await Bun.sleep(100);
      // The third is refused on the spot, without waiting for a head that
      // would only have come to be refused.
      const third = await open("shop");
      await Promise.race([third.closed, Bun.sleep(1000)]);
      expect(third.text()).toStartWith("HTTP/1.1 503");
      expect(third.text()).toContain("shop already holds 2 connections");
      expect(recorded.denied.at(-1)).toEqual({ target: "shop", destination: null, reason: "too many connections" });
      // Another project is not touched by shop's share.
      const blog = await open("blog");
      blog.socket.write(`CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
      await Bun.sleep(200);
      expect(blog.text()).toStartWith("HTTP/1.1 200");
      // A silent connection gone, its place is free again.
      silent[0]!.socket.end();
      await Bun.sleep(100);
      const again = await open("shop");
      again.socket.write(`CONNECT ${API}:443 HTTP/1.1\r\n\r\n`);
      await Bun.sleep(200);
      expect(again.text()).toStartWith("HTTP/1.1 200");
      for (const client of [silent[1]!, blog, again]) client.socket.end();
    } finally {
      proxy.stop();
      held.stop(true);
    }
  });
});
