import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EGRESS_PROXY_PORT, egressUnitLines, parseEgressEntry, type HostPattern } from "../../bin/cli/egress";
import { DATA_DIR } from "../src/config";
import type { Caller } from "../src/proc-net";
import { startProxy, type Proxy } from "../src/proxy";
import { certificate, OPENSSL, rawExchange, recordingAudit, stubLookup, stubRoute } from "./helpers";

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
    const response = await fetch(`https://${API}/v1/ping`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
      tls: { ca: tls.cert },
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
    const response = await fetch(`https://${API}/`, { proxy: `http://127.0.0.1:${proxy.port}`, tls: { ca: tls.cert } });
    expect(response.status).toBe(200);
    expect(route.asked).toEqual([`${PUBLIC_V4}:443`]);
  });

  test("a large answer and a large upload go through whole, whichever side is slower", async () => {
    allow(API);
    const download = await fetch(`https://${API}/big`, { proxy: `http://127.0.0.1:${proxy.port}`, tls: { ca: tls.cert } });
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(BIG);
    expect(bytes.every((byte) => byte === 7)).toBe(true);
    const upload = await fetch(`https://${API}/upload`, {
      method: "POST",
      body: new Uint8Array(BIG).fill(3),
      proxy: `http://127.0.0.1:${proxy.port}`,
      tls: { ca: tls.cert },
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
    const response = await fetch(`http://${PLAIN}/hello?x=1`, { proxy: `http://127.0.0.1:${proxy.port}` });
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
});
