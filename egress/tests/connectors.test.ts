import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, Socket, TCPSocketListener } from "bun";
import { EMPTY_CONNECTORS, EMPTY_GRANTS, putConnector, serializeConnectors, serializeGrants, setGrant } from "../../bin/cli/connectors";
import { parseEgressEntry } from "../../bin/cli/egress";
import type { Admission } from "../src/admission";
import { DATA_DIR } from "../src/config";
import {
  connectorPath,
  MAX_BODY_BYTES,
  MAX_IN_FLIGHT_PER_PROJECT,
  startConnectors,
  upstreamHeaders,
  type ConnectorLimits,
  type Connectors,
} from "../src/connectors";
import { createPolicy } from "../src/policy";
import type { Caller } from "../src/proc-net";
import { startProxy } from "../src/proxy";
import {
  authority,
  BLOCK,
  certificate,
  identifyByPort,
  OPENSSL,
  OVERSHOOT,
  pump,
  rawExchange,
  recordingAudit,
  recordingTlsServer,
  stubLookup,
  stubRoute,
  type Flood,
} from "./helpers";

/**
 * The connectors on a random port, a real TLS upstream behind them that
 * echoes what it received, and the files of a machine in a throwaway folder.
 * The credential is a value made for the test.
 */
const CHAT = "chat.test-zone.invalid";
const ADDRESS = "203.0.114.30";
const VALUE = "Bearer test-connector-value-0123456789";

describe.skipIf(OPENSSL === null)("the connectors", () => {
  let tls: { cert: string; key: string };
  let upstream: Server<undefined>;
  let server: Connectors;
  let root: string;
  let caller: Caller = { kind: "project", slug: "shop", account: "site-shop" };
  const recorded = recordingAudit();
  const base = () => `http://127.0.0.1:${server.port}`;
  /** What the test says the machine's interfaces carry. */
  const own = new Set<string>();
  /** Every path the upstream was asked for. */
  const asked: string[] = [];

  beforeAll(() => {
    tls = certificate([CHAT]);
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      async fetch(req) {
        const url = new URL(req.url);
        asked.push(url.pathname);
        if (url.pathname === "/api/slow") {
          await Bun.sleep(400);
          return new Response("slow");
        }
        if (url.pathname === "/api/size") return Response.json({ received: (await req.arrayBuffer()).byteLength });
        if (url.pathname === "/api/latin1") {
          // The character codes of what arrived, and a value past ASCII back.
          const codes = [...(req.headers.get("x-name") ?? "")].map((each) => each.charCodeAt(0));
          return Response.json({ codes }, { headers: { "x-name": "café ÿ" } });
        }
        if (url.pathname === "/api/gzip") {
          return new Response(Bun.gzipSync(new TextEncoder().encode("compressed ".repeat(500))), {
            headers: { "content-encoding": "gzip", "content-type": "text/plain" },
          });
        }
        return Response.json(
          { method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() },
          { status: url.pathname === "/api/missing" ? 404 : 200, headers: { "x-upstream": "yes" } },
        );
      },
    });

    root = mkdtempSync(join(DATA_DIR, "connectors-"));
    const sites = join(root, "sites");
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    const manifest = (slug: string, body: object) => {
      mkdirSync(join(sites, slug), { recursive: true });
      writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, port: 3040, start: "/x", ...body }));
    };
    manifest("shop", { connectors: ["chat", "inner"] });
    manifest("blog", { connectors: ["chat"] });
    manifest("notes", {});

    const now = "2026-10-04T12:00:00.000Z";
    let connectors = EMPTY_CONNECTORS;
    for (const [name, baseUrl] of [["chat", `https://${CHAT}/api`], ["inner", "https://inner.test-zone.invalid"]] as const) {
      const put = putConnector(connectors, { name, baseUrl, header: "Authorization", value: VALUE }, now, "owner");
      if ("error" in put) throw new Error(put.error);
      connectors = put.file;
    }
    let grants = EMPTY_GRANTS;
    for (const [slug, name] of [["shop", "chat"], ["shop", "inner"], ["notes", "chat"]] as const) {
      const granted = setGrant(grants, connectors, slug, name, true, now, "owner");
      if ("error" in granted) throw new Error(granted.error);
      grants = granted.file;
    }
    writeFileSync(join(config, "connectors.json"), serializeConnectors(connectors));
    writeFileSync(join(config, "grants.json"), serializeGrants(grants));

    server = startConnectors({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => caller,
      policy: createPolicy(sites, config),
      lookup: stubLookup({ [CHAT]: [ADDRESS], "inner.test-zone.invalid": ["192.168.10.4"] }),
      ownAddresses: () => own,
      audit: { ...recorded.audit, recent: () => [{ id: 1, at: now, actor: "system", action: "connector.use", target: "shop", detail: "{}" }] },
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${ADDRESS}:443`]: upstream.port! }),
      ca: tls.cert,
    });
  });

  afterAll(() => {
    server?.stop();
    upstream?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a granted connector: forwarded over HTTPS, its credential added, the app's own removed", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/messages?channel=general`, {
      method: "POST",
      headers: {
        authorization: "Bearer the-app-own",
        cookie: "session=app",
        "x-api-key": "app-key",
        "x-forwarded-for": "10.0.0.1",
        "x-sitesolide-user": "someone@test-zone.invalid",
        "content-type": "application/json",
        "x-request-id": "kept",
      },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sitesolide-connector")).toBe("chat");
    expect(response.headers.get("x-upstream")).toBe("yes");
    const echoed = (await response.json()) as { method: string; path: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe("POST");
    expect(echoed.path).toBe("/api/messages?channel=general");
    expect(echoed.body).toBe('{"text":"hello"}');
    expect(echoed.headers.authorization).toBe(VALUE);
    expect(echoed.headers.host).toBe(CHAT);
    expect(echoed.headers["x-request-id"]).toBe("kept");
    for (const name of ["cookie", "x-api-key", "x-forwarded-for", "x-sitesolide-user"]) expect(echoed.headers[name]).toBeUndefined();
    expect(recorded.used.at(-1)).toEqual({ slug: "shop", connector: "chat", status: 200 });
  });

  test("the proxy's own answers never carry the credential; an upstream that echoes it does, as the README warns", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/missing`);
    // The upstream's own 404, relayed as it is.
    expect(response.status).toBe(404);
    // This upstream copies the headers it received into its answer, the way a
    // debugging endpoint would: the app then reads the credential. The proxy
    // cannot tell an echo from data, which is why the threat model says so.
    expect(await response.text()).toContain("test-connector-value");
    for (const path of ["/connectors/nothing/x", "/connectors/inner/x", "/status"]) {
      expect(await (await fetch(`${base()}${path}`)).text()).not.toContain("test-connector-value");
    }
    caller = { kind: "project", slug: "blog", account: "site-blog" };
    expect(await (await fetch(`${base()}/connectors/chat/x`)).text()).not.toContain("test-connector-value");
  });

  test("an answer the upstream compressed reaches the app as it was sent, and the app's client decodes it", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/gzip`);
    expect(response.status).toBe(200);
    // Passed on compressed: decoded in the proxy, it would be held, for a
    // slow app, many times the bytes the upstream sent.
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.text()).toBe("compressed ".repeat(500));
  });

  test("a second request behind a body never reaches the upstream, and the chunks it gets are the proxy's", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const smuggled = "GET /connectors/chat/smuggled HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
    const answer = await rawExchange(
      server.port,
      `POST /connectors/chat/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n${smuggled}`,
    );
    expect(answer).toStartWith("HTTP/1.1 200");
    expect(answer).toContain("Connection: close");
    const echoed = JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4)) as { body: string; headers: Record<string, string> };
    expect(echoed.body).toBe("hello");
    expect(echoed.headers["transfer-encoding"]).toBe("chunked");
    expect(echoed.headers["x-trailer"]).toBeUndefined();
    // Behind a body announced by its length, or behind none, the same.
    for (const first of ["POST /connectors/chat/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello", "GET /connectors/chat/echo HTTP/1.1\r\nHost: x\r\n\r\n"]) {
      expect(await rawExchange(server.port, `${first}${smuggled}`)).toStartWith("HTTP/1.1 200");
    }
    await Bun.sleep(50);
    expect(asked).not.toContain("/api/smuggled");
  });

  test("a body that could be read two ways, or a head that does not read, is refused before any upstream", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const before = asked.length;
    for (const [request, status] of [
      ["POST /connectors/chat/echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "400"],
      ["POST /connectors/chat/echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip, chunked\r\n\r\n", "501"],
      ["GET /connectors/chat/echo HTTP/1.0\r\nHost: x\r\n\r\n", "505"],
      ["GET http://127.0.0.1/connectors/chat/echo HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
      ["GET /connectors/chat/echo HTTP/1.1\r\nX: a\u0001b\r\n\r\n", "400"],
    ] as const) {
      expect(await rawExchange(server.port, request)).toStartWith(`HTTP/1.1 ${status}`);
    }
    // A chunk that does not read once the call is open: refused, not passed on.
    const broken = await rawExchange(server.port, "POST /connectors/chat/size HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\nhello\r\n0\r\n\r\n");
    expect(broken).toStartWith("HTTP/1.1 400");
    expect(broken).toContain("the request body does not read");
    expect(asked.slice(before)).not.toContain("/api/echo");
  });

  test("a header's bytes past ASCII reach the upstream as the app sent them, and the app as the upstream sent them", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    // Bytes, one character each: TextDecoder("latin1") is windows-1252, which
    // reads 0x80 as the euro sign.
    const bytes = (text: string) => Uint8Array.from(text, (each) => each.charCodeAt(0));
    const chunks: Uint8Array[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data: (_socket, chunk) => void chunks.push(new Uint8Array(chunk)), close: () => resolve(), error: () => resolve() },
    });
    socket.write(bytes("GET /connectors/chat/latin1 HTTP/1.1\r\nHost: x\r\nX-Name: café \u0080ÿ\r\n\r\n"));
    await Promise.race([promise, Bun.sleep(3000)]);
    const answer = String.fromCharCode(...new Uint8Array(Bun.concatArrayBuffers(chunks)));
    expect(answer).toStartWith("HTTP/1.1 200");
    expect(answer).toContain("\r\nx-name: café ÿ\r\n");
    const { codes } = JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4)) as { codes: number[] };
    expect(codes).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0xff]);
  });

  test("TRACE is refused: its answer echoes the request, and the credential the proxy added with it", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const before = asked.length;
    for (const method of ["TRACE", "TRACK", "CONNECT"]) {
      const answer = await rawExchange(server.port, `${method} /connectors/chat/traced HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(answer).toStartWith("HTTP/1.1 405");
      expect(answer).not.toContain("test-connector-value");
    }
    await Bun.sleep(50);
    expect(asked.slice(before)).not.toContain("/api/traced");
  });

  test("a GET or a HEAD goes up without a body, as fetch sent it: none for an upstream to read as a second request", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const smuggled = "GET /api/other HTTP/1.1\r\nHost: x\r\n\r\n";
    const answer = await rawExchange(server.port, `GET /connectors/chat/echo HTTP/1.1\r\nHost: x\r\nContent-Length: ${smuggled.length}\r\n\r\n${smuggled}`);
    expect(answer).toStartWith("HTTP/1.1 200");
    const echoed = JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4)) as { body: string; headers: Record<string, string> };
    expect(echoed.body).toBe("");
    expect(echoed.headers["content-length"]).toBeUndefined();
    expect(echoed.headers["transfer-encoding"]).toBeUndefined();
  });

  test("a body announced past the limit is refused at once, and the app reads why", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/size`, { method: "PUT", body: new Uint8Array(MAX_BODY_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { message: string }).message).toBe(`connectors: the request body is over ${MAX_BODY_BYTES} bytes`);
    expect(recorded.denied.at(-1)).toMatchObject({ target: "shop", destination: "connector:chat", reason: "body too large" });
  });

  test("an app that waits to be told before sending its body is told once the upstream is there", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    let received = "";
    const told = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        data(_socket, chunk) {
          received += new TextDecoder().decode(chunk);
          if (received.includes("100 Continue\r\n\r\n")) told.resolve();
        },
        close: () => closed.resolve(),
        error: () => closed.resolve(),
      },
    });
    client.write("PUT /connectors/chat/size HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n");
    // The body goes only once the proxy says so, as curl's would.
    await Promise.race([told.promise, Bun.sleep(2000)]);
    expect(received).toBe("HTTP/1.1 100 Continue\r\n\r\n");
    client.write("hello");
    await Promise.race([closed.promise, Bun.sleep(2000)]);
    expect(received).toContain("HTTP/1.1 200");
    expect(received).toContain('{"received":5}');
  });

  test("a HEAD has its head and no body, whatever length it announces", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/echo`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    await Bun.sleep(50);
    expect(server.open()).toBe(0);
  });

  test("a large body streams through whole", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const size = 3 * 1024 * 1024;
    const response = await fetch(`${base()}/connectors/chat/size`, { method: "PUT", body: new Uint8Array(size).fill(5) });
    expect(await response.json()).toEqual({ received: size });
  });

  test("a body sent in chunks is held to the same limit as one that announces its length", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    // Bun.serve's maxRequestBodySize refuses a Content-Length above it, and
    // let a chunked body of any size through, to an upstream slower than the
    // loopback: the proxy held what it could not send yet, without bound.
    const total = MAX_BODY_BYTES + 1024 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        controller.enqueue(new Uint8Array(1024 * 1024).fill(5));
        sent += 1024 * 1024;
      },
    });
    const response = await fetch(`${base()}/connectors/chat/size`, { method: "PUT", body, duplex: "half" } as RequestInit);
    expect(response.status).toBe(413);
    expect(((await response.json()) as { message: string }).message).toBe(`connectors: the request body is over ${MAX_BODY_BYTES} bytes`);
  });

  test("one project cannot hold more than its share of calls waiting for an upstream", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const responses = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_PER_PROJECT + 4 }, () => fetch(`${base()}/connectors/chat/slow`)),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200).length).toBe(MAX_IN_FLIGHT_PER_PROJECT);
    expect(statuses.filter((status) => status === 503).length).toBe(4);
    // The share comes back once the answers are in.
    expect((await fetch(`${base()}/connectors/chat/slow`)).status).toBe(200);
  });

  test("asked for in the manifest but not granted: refused", async () => {
    caller = { kind: "project", slug: "blog", account: "site-blog" };
    const response = await fetch(`${base()}/connectors/chat/messages`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain("chat is not granted to blog");
    expect(recorded.denied.at(-1)).toMatchObject({ target: "blog", destination: "connector:chat", reason: "not granted" });
  });

  test("granted but not asked for in the manifest: refused too, a grant alone lends nothing", async () => {
    caller = { kind: "project", slug: "notes", account: "site-notes" };
    const response = await fetch(`${base()}/connectors/chat/messages`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain("does not list chat under connectors");
  });

  test("an unknown connector, a caller that is not a project", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    expect((await fetch(`${base()}/connectors/nothing/x`)).status).toBe(404);
    caller = { kind: "account", account: "root" };
    expect((await fetch(`${base()}/connectors/chat/x`)).status).toBe(403);
    caller = { kind: "unknown", reason: "x" };
    expect((await fetch(`${base()}/connectors/chat/x`)).status).toBe(403);
  });

  test("a connector whose host resolves inside the network is refused like any egress", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/inner/x`);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { message: string }).message).toContain("a private address");
  });

  test("a connector whose host resolves to the machine's own address is refused too", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    own.add(ADDRESS);
    try {
      const response = await fetch(`${base()}/connectors/chat/x`);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toBe(`connectors: chat: refused, ${CHAT} resolves to ${ADDRESS}, this machine's own address`);
    } finally {
      own.clear();
    }
  });

  test("the path stays under the connector's prefix", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    // The URL parser resolves the dots first: this is /connectors/x, no connector.
    expect((await fetch(`${base()}/connectors/chat/../../admin`)).status).toBe(404);
    expect((await fetch(`${base()}/connectors/chat/a%2F..%2F..%2Fadmin`)).status).toBe(404);
    expect((await fetch(`${base()}/somewhere`)).status).toBe(404);
  });

  test("the read-only routes answer the dashboard's account, and nobody else", async () => {
    caller = { kind: "project", slug: "dashboard", account: "site-dashboard" };
    const audit = await fetch(`${base()}/audit?limit=10`);
    expect(audit.status).toBe(200);
    expect(((await audit.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    const status = await fetch(`${base()}/status`);
    expect(await status.json()).toMatchObject({ connectors: 2, grants: 3, errors: [] });
    for (const other of [
      { kind: "project", slug: "shop", account: "site-shop" },
      { kind: "account", account: "root" },
      { kind: "unknown", reason: "x" },
    ] as Caller[]) {
      caller = other;
      expect((await fetch(`${base()}/audit`)).status).toBe(403);
    }
    caller = { kind: "project", slug: "dashboard", account: "site-dashboard" };
    expect((await fetch(`${base()}/audit`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base()}/audit?limit=x`)).status).toBe(400);
  });
});

/**
 * The proxy fetches a connector by the address it judged, the host's name
 * carried in `tls.serverName`. Everything rests on the client checking the
 * certificate against that name: if it checked the chain alone, whoever
 * answers for the connector's host in DNS could collect the credential with
 * any valid certificate, theirs, for a name of theirs.
 *
 * One authority signs both certificates, and the proxy trusts it through the
 * option the other tests use: the chain is valid either way, and only the name
 * can refuse. The servers keep every decrypted byte, to prove the credential
 * never reached the wrong one, not even as a request it would have rejected.
 */
describe.skipIf(OPENSSL === null)("the certificate of a connector's host", () => {
  const API = "api.test-zone.invalid";
  const GENUINE = "203.0.114.40";
  const IMPOSTOR = "203.0.114.41";
  const API_VALUE = "Bearer api-test-value-0123456789";
  const TWIN_VALUE = "Bearer twin-test-value-0123456789";
  let genuine: ReturnType<typeof recordingTlsServer>;
  let impostor: ReturnType<typeof recordingTlsServer>;
  let server: Connectors;
  let root: string;
  const answers: Record<string, string[]> = {};

  beforeAll(() => {
    const signed = authority([[API], ["other.test-zone.invalid"]]);
    genuine = recordingTlsServer(signed.leaves[0]!);
    impostor = recordingTlsServer(signed.leaves[1]!);

    root = mkdtempSync(join(DATA_DIR, "certificates-"));
    const sites = join(root, "sites");
    const config = join(root, "config");
    mkdirSync(join(sites, "shop"), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(sites, "shop", "sitesolide.json"), JSON.stringify({ slug: "shop", port: 3040, start: "/x", connectors: ["api", "twin"] }));
    const now = "2026-10-04T12:00:00.000Z";
    let connectors = EMPTY_CONNECTORS;
    let grants = EMPTY_GRANTS;
    for (const [name, host, value] of [["api", API, API_VALUE], ["twin", "twin.test-zone.invalid", TWIN_VALUE]] as const) {
      const put = putConnector(connectors, { name, baseUrl: `https://${host}`, header: "Authorization", value }, now, "owner");
      if ("error" in put) throw new Error(put.error);
      connectors = put.file;
      const granted = setGrant(grants, connectors, "shop", name, true, now, "owner");
      if ("error" in granted) throw new Error(granted.error);
      grants = granted.file;
    }
    writeFileSync(join(config, "connectors.json"), serializeConnectors(connectors));
    writeFileSync(join(config, "grants.json"), serializeGrants(grants));

    server = startConnectors({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
      policy: createPolicy(sites, config),
      lookup: async (host) => {
        const answer = answers[host];
        if (answer === undefined) throw new Error(`ENOTFOUND ${host}`);
        return answer;
      },
      audit: recordingAudit().audit,
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${GENUINE}:443`]: genuine.port, [`${IMPOSTOR}:443`]: impostor.port }),
      ca: signed.ca,
    });
  });

  afterAll(() => {
    server?.stop();
    genuine?.stop();
    impostor?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("a valid certificate for another name is refused, and the credential never reaches that server", async () => {
    // Whoever controls the name's DNS points it at a server of theirs, with a
    // certificate the authority really signed, for a name of theirs.
    answers[API] = [IMPOSTOR];
    const response = await fetch(`http://127.0.0.1:${server.port}/connectors/api/v1/x`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: "connectors: api: the connection failed" });
    // The proxy did reach it, and stopped at the certificate: a handshake,
    // then not one byte of the request.
    expect(impostor.handshakes()).toBeGreaterThan(0);
    expect(impostor.received).toEqual([]);
  });

  test("a certificate for the right name from an authority the proxy does not trust is refused too", async () => {
    // Bun 1.3.11 reports such a handshake as a success, the chain's fault in
    // its authorization error alone: that error is what refuses it, measured.
    const stranger = recordingTlsServer(certificate([API]));
    try {
      const strangerAddress = "203.0.114.42";
      const routed = stubRoute({ [`${strangerAddress}:443`]: stranger.port });
      answers[API] = [strangerAddress];
      const lone = startConnectors({
        hostname: "127.0.0.1",
        port: 0,
        identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
        policy: createPolicy(join(root, "sites"), join(root, "config")),
        lookup: async (host) => answers[host] ?? [],
        audit: recordingAudit().audit,
        dashboardAccount: "site-dashboard",
        route: routed,
        ca: authority([[API]]).ca,
      });
      try {
        const response = await fetch(`http://127.0.0.1:${lone.port}/connectors/api/v1/x`);
        expect(response.status).toBe(502);
        expect(stranger.handshakes()).toBeGreaterThan(0);
        expect(stranger.received).toEqual([]);
      } finally {
        lone.stop();
      }
    } finally {
      stranger.stop();
    }
  });

  test("the same authority's certificate for the right name is accepted: the refusal above was the name", async () => {
    answers[API] = [GENUINE];
    const response = await fetch(`http://127.0.0.1:${server.port}/connectors/api/v1/x`);
    expect(response.status).toBe(200);
    expect(genuine.received.join("")).toContain(`Authorization: ${API_VALUE}`);
  });

  test("a connection checked for one name is not reused for another name on the same address", async () => {
    // Two connectors behind one address, a CDN's for instance: the connection
    // the previous test left open was checked for the api's name, and must
    // not carry the twin's credential to a server that never proved the twin's.
    answers["twin.test-zone.invalid"] = [GENUINE];
    const before = genuine.received.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/connectors/twin/x`);
    expect(response.status).toBe(502);
    expect(genuine.received.slice(before).join("")).not.toContain("twin-test-value");
    expect(impostor.received.join("") + genuine.received.join("")).not.toContain(TWIN_VALUE);
  });
});

/**
 * An answer that never ends, a stream of events, and a caller that hangs up
 * in the middle of it. Bun's fetch reads its upstream as fast as it arrives
 * whether anyone reads the body or not: an upstream the proxy forgets to let
 * go of is read, and kept in memory, for nobody, until it ends, or for ever.
 * One project hanging up on such streams in a loop, or a client that times
 * out and retries, would take the memory every project's egress shares.
 */
describe.skipIf(OPENSSL === null)("a connector's answer once its caller is gone", () => {
  const FEED = "feed.test-zone.invalid";
  const FEED_ADDRESS = "203.0.114.50";
  const streams = { opened: 0, closed: 0 };
  let upstream: TCPSocketListener<{ timer: ReturnType<typeof setInterval> | null }>;
  let server: Connectors;
  let root: string;

  beforeAll(() => {
    const tls = certificate([FEED]);
    // A server that answers with an endless chunked stream, one event every
    // 10 ms, and counts the connections the proxy closes.
    upstream = Bun.listen<{ timer: ReturnType<typeof setInterval> | null }>({
      hostname: "127.0.0.1",
      port: 0,
      tls,
      socket: {
        data(socket) {
          // Set here rather than in open(), which a TLS socket may not have
          // seen yet when its first bytes are delivered.
          if (socket.data?.timer) return;
          streams.opened++;
          socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
          const event = "data: tick\n\n";
          const frame = `${event.length.toString(16)}\r\n${event}\r\n`;
          socket.data = { timer: setInterval(() => socket.write(frame), 10) };
        },
        close(socket) {
          if (socket.data?.timer) clearInterval(socket.data.timer);
          streams.closed++;
        },
      },
    });

    root = mkdtempSync(join(DATA_DIR, "streams-"));
    const sites = join(root, "sites");
    const config = join(root, "config");
    mkdirSync(join(sites, "shop"), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(sites, "shop", "sitesolide.json"), JSON.stringify({ slug: "shop", port: 3040, start: "/x", connectors: ["feed"] }));
    const now = "2026-10-04T12:00:00.000Z";
    const put = putConnector(EMPTY_CONNECTORS, { name: "feed", baseUrl: `https://${FEED}`, header: "Authorization", value: VALUE }, now, "owner");
    if ("error" in put) throw new Error(put.error);
    const granted = setGrant(EMPTY_GRANTS, put.file, "shop", "feed", true, now, "owner");
    if ("error" in granted) throw new Error(granted.error);
    writeFileSync(join(config, "connectors.json"), serializeConnectors(put.file));
    writeFileSync(join(config, "grants.json"), serializeGrants(granted.file));

    server = startConnectors({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
      policy: createPolicy(sites, config),
      lookup: stubLookup({ [FEED]: [FEED_ADDRESS] }),
      ownAddresses: () => new Set<string>(),
      audit: recordingAudit().audit,
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${FEED_ADDRESS}:443`]: upstream.port }),
      ca: tls.cert,
    });
  });

  afterAll(() => {
    server?.stop();
    upstream?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the caller hangs up: the proxy lets go of the upstream, rather than reading it for nobody", async () => {
    const { promise: streaming, resolve } = Promise.withResolvers<void>();
    let received = "";
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port!,
      socket: {
        data(_socket, chunk) {
          received += new TextDecoder().decode(chunk);
          if (received.includes("tick")) resolve();
        },
        close() {},
        error() {},
      },
    });
    client.write("GET /connectors/feed/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await Promise.race([streaming, Bun.sleep(3000)]);
    expect(received).toContain("tick");
    expect(streams).toEqual({ opened: 1, closed: 0 });

    client.terminate();
    const deadline = Date.now() + 2000;
    while (streams.closed === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(streams.closed).toBe(1);
  });
});

/**
 * A connector's host that takes the TCP connection and never answers the TLS
 * handshake: an outage, or a host overloaded. The proxy gives up on the
 * attempt, at its delay or when its caller hangs up, and the attempt must go
 * with it: left open, it holds a descriptor no count sees, and a project
 * hanging up on call after call stacks them until the proxy runs out.
 */
describe.skipIf(OPENSSL === null)("a connection attempt the proxy gives up on", () => {
  const STALL = "stall.test-zone.invalid";
  const STALL_ADDRESS = "203.0.114.70";
  /** The stalling host's sockets still open, the proxy's attempts as it sees them. */
  const held = new Set<Socket<undefined>>();
  /** Every attempt that reached the host. */
  let reached = 0;
  let stall: TCPSocketListener<undefined>;
  let root: string;
  let sites: string;
  let config: string;

  beforeAll(() => {
    // Plain TCP: it reads the ClientHello and answers nothing.
    stall = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          reached++;
          held.add(socket);
        },
        data() {},
        close: (socket) => void held.delete(socket),
      },
    });
    root = mkdtempSync(join(DATA_DIR, "attempts-"));
    sites = join(root, "sites");
    config = join(root, "config");
    mkdirSync(join(sites, "shop"), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(sites, "shop", "sitesolide.json"), JSON.stringify({ slug: "shop", port: 3040, start: "/x", connectors: ["stall"] }));
    const now = "2026-10-04T12:00:00.000Z";
    const put = putConnector(EMPTY_CONNECTORS, { name: "stall", baseUrl: `https://${STALL}`, header: "Authorization", value: VALUE }, now, "owner");
    if ("error" in put) throw new Error(put.error);
    const granted = setGrant(EMPTY_GRANTS, put.file, "shop", "stall", true, now, "owner");
    if ("error" in granted) throw new Error(granted.error);
    writeFileSync(join(config, "connectors.json"), serializeConnectors(put.file));
    writeFileSync(join(config, "grants.json"), serializeGrants(granted.file));
  });

  afterAll(() => {
    stall?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  function bench(limits: Partial<ConnectorLimits>) {
    return startConnectors({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => ({ kind: "project", slug: "shop", account: "site-shop" }),
      policy: createPolicy(sites, config),
      lookup: stubLookup({ [STALL]: [STALL_ADDRESS] }),
      ownAddresses: () => new Set<string>(),
      audit: recordingAudit().audit,
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${STALL_ADDRESS}:443`]: stall.port }),
      limits,
    });
  }

  async function waitFor(condition: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  }

  test("an attempt past its delay is closed, not left to the host", async () => {
    const connectors = bench({ connectTimeoutMs: 300, headersTimeoutMs: 5000 });
    try {
      const answer = await rawExchange(connectors.port, "GET /connectors/stall/x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", 3000);
      expect(answer).toStartWith("HTTP/1.1 502");
      expect(answer).toContain("the connection failed");
      await waitFor(() => held.size === 0);
      expect(held.size).toBe(0);
    } finally {
      connectors.stop();
    }
  });

  test("an attempt whose call ends first, its caller gone, is closed with the call", async () => {
    // The call ends before the attempt's own delay: at once where the kernel
    // reports the hang-up of a caller not being read, at the answer's delay
    // where it does not (a caller is not read while its call is judged).
    const connectors = bench({ connectTimeoutMs: 10_000, headersTimeoutMs: 500 });
    try {
      const start = reached;
      for (let i = 1; i <= 5; i++) {
        const client = await Bun.connect({ hostname: "127.0.0.1", port: connectors.port, socket: { data() {} } });
        client.write("GET /connectors/stall/x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        await waitFor(() => reached >= start + i);
        client.terminate();
      }
      await waitFor(() => connectors.open() === 0 && held.size === 0);
      expect(connectors.open()).toBe(0);
      expect(connectors.calls()).toBe(0);
      // Five calls given up on, five handshakes still waiting at the host.
      expect(held.size).toBe(0);
    } finally {
      connectors.stop();
    }
  });
});

/**
 * What one project may take of the connectors' port, and of the proxy behind
 * it: its connections, the bytes waiting for a slow end, its calls under way.
 * The upstream is a raw TLS server of the test's own whose path says how it
 * answers: a flood that ends at FLOOD_BYTES or when the test says so, a
 * trickle of chunks, nothing at all and reading nothing, or a short answer.
 * Three projects ask for the connector and are granted it, each caller named
 * by its client's port.
 */
describe.skipIf(OPENSSL === null)("what one project may take of the connectors", () => {
  const FEED = "feed.test-zone.invalid";
  const FEED_ADDRESS = "203.0.114.60";
  /**
   * The most a flood answers: twice what the four kernel buffers between the
   * upstream and a paused app may hold, so that an answer read for nobody
   * shows, and little enough not to take the machine running the tests.
   */
  const FLOOD_BYTES = 8 * OVERSHOOT;
  type Answer = Flood & { path: string; head: string; timer: ReturnType<typeof setInterval> | null };
  const answers: Answer[] = [];
  let tls: { cert: string; key: string };
  let upstream: TCPSocketListener<Answer>;
  let root: string;
  let sites: string;
  let config: string;

  /** Writes the flood on, and ends it once it has all been written. */
  function flow(answer: Answer): void {
    pump(answer);
    if (answer.socket !== null && answer.written >= (answer.limit ?? Infinity)) answer.socket.end();
  }

  beforeAll(() => {
    tls = certificate([FEED]);
    upstream = Bun.listen<Answer>({
      hostname: "127.0.0.1",
      port: 0,
      tls,
      socket: {
        data(socket, chunk) {
          // Set here rather than in open(), which a TLS socket may not have
          // seen yet when its first bytes are delivered.
          socket.data ??= { socket: socket as unknown as Socket<undefined>, written: 0, on: false, path: "", head: "", timer: null };
          const answer = socket.data;
          // What follows the request line is read and dropped.
          if (answer.path !== "") return;
          answer.head += new TextDecoder("latin1").decode(chunk);
          const line = /^[A-Z]+ (\S+) HTTP\/1\.1\r\n/.exec(answer.head);
          if (line === null) return;
          answer.path = line[1]!;
          answers.push(answer);
          switch (answer.path) {
            case "/flood":
              socket.pause();
              socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n");
              answer.on = true;
              answer.limit = FLOOD_BYTES;
              flow(answer);
              return;
            case "/trickle":
              socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
              answer.timer = setInterval(() => socket.write("5\r\ntick\n\r\n"), 20);
              return;
            case "/sink":
              socket.pause();
              return;
            case "/big-head":
              socket.write(`HTTP/1.1 200 OK\r\nX-Big: ${"x".repeat(20_000)}\r\n\r\n`);
              socket.end();
              return;
            case "/hang-up":
              socket.end();
              return;
            case "/hints":
              socket.write("HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
              socket.end();
              return;
            case "/cut":
              socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
              socket.end();
              return;
            default:
              socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok");
              socket.end();
          }
        },
        drain(socket) {
          if (socket.data !== undefined) flow(socket.data);
        },
        close(socket) {
          if (socket.data === undefined) return;
          socket.data.socket = null;
          if (socket.data.timer !== null) clearInterval(socket.data.timer);
        },
      },
    });

    root = mkdtempSync(join(DATA_DIR, "bounds-"));
    sites = join(root, "sites");
    config = join(root, "config");
    mkdirSync(config, { recursive: true });
    const now = "2026-10-04T12:00:00.000Z";
    const put = putConnector(EMPTY_CONNECTORS, { name: "feed", baseUrl: `https://${FEED}`, header: "Authorization", value: VALUE }, now, "owner");
    if ("error" in put) throw new Error(put.error);
    let grants = EMPTY_GRANTS;
    for (const slug of ["shop", "blog", "wiki"]) {
      mkdirSync(join(sites, slug), { recursive: true });
      writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, port: 3040, start: "/x", connectors: ["feed"] }));
      const granted = setGrant(grants, put.file, slug, "feed", true, now, "owner");
      if ("error" in granted) throw new Error(granted.error);
      grants = granted.file;
    }
    writeFileSync(join(config, "connectors.json"), serializeConnectors(put.file));
    writeFileSync(join(config, "grants.json"), serializeGrants(grants));
  });

  afterAll(() => {
    upstream?.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  /** What the upstream's floods have written so far. */
  const flooded = () => answers.reduce((sum, answer) => sum + (answer.path === "/flood" ? answer.written : 0), 0);

  /** Every answer under way ends now: a flood where it stands, a trickle with its last chunk. */
  function endAnswers(): void {
    for (const answer of answers.splice(0)) {
      if (answer.timer !== null) {
        clearInterval(answer.timer);
        answer.socket?.write("0\r\n\r\n");
      }
      answer.limit = answer.written;
      answer.on = false;
      answer.socket?.end();
    }
  }

  function bench(limits: Partial<ConnectorLimits> = {}, owners = new Map<number, Caller>(), admission?: Admission) {
    const recorded = recordingAudit();
    const connectors = startConnectors({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      policy: createPolicy(sites, config),
      lookup: stubLookup({ [FEED]: [FEED_ADDRESS] }),
      ownAddresses: () => new Set<string>(),
      audit: recorded.audit,
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${FEED_ADDRESS}:443`]: upstream.port }),
      ca: tls.cert,
      limits,
      ...(admission === undefined ? {} : { admission }),
    });
    return {
      connectors,
      recorded,
      open: (slug: string) => app(connectors.port, owners, slug),
      stop: () => {
        endAnswers();
        connectors.stop();
      },
    };
  }

  test("one project holds at most its share of connections, silent ones included, and another project still gets in", async () => {
    const { open, recorded, stop } = bench({ maxPerProject: 3 });
    try {
      // Three connections that never send a head: the whole share of shop.
      const silent = [await open("shop"), await open("shop"), await open("shop")];
      await Bun.sleep(100);
      // The fourth is refused on the spot. Bun.serve counted none of them:
      // one project held thousands, until the proxy ran out of descriptors
      // and another project's CONNECT went unanswered.
      const fourth = await open("shop");
      expect(await fourth.status(1000)).toBe(503);
      expect(fourth.body()).toContain("shop already holds 3 connections");
      expect(recorded.denied.at(-1)).toMatchObject({ target: "shop", reason: "too many connections" });
      // Another project is not touched by shop's share.
      const blog = await open("blog");
      blog.call("/connectors/feed/ok");
      expect(await blog.status()).toBe(200);
      // A silent connection gone, its place is free again.
      silent[0]!.socket.end();
      await Bun.sleep(100);
      const again = await open("shop");
      again.call("/connectors/feed/ok");
      expect(await again.status()).toBe(200);
    } finally {
      stop();
    }
  });

  test("both ports count against one admission: connector connections take from the project's tunnels, and from the proxy's", async () => {
    const owners = new Map<number, Caller>();
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      egressOf: () => [parseEgressEntry(FEED)!],
      lookup: stubLookup({ [FEED]: [FEED_ADDRESS] }),
      audit: recordingAudit().audit,
      route: stubRoute({ [`${FEED_ADDRESS}:443`]: upstream.port }),
      limits: { maxPerProject: 2, maxConnections: 4 },
      log: () => undefined,
    });
    const { open, stop } = bench({}, owners, proxy.admission);
    const tunnel = () => `CONNECT ${FEED}:443 HTTP/1.1\r\n\r\n`;
    try {
      // shop's share is taken on the connectors' port: its tunnel is refused.
      await open("shop");
      await open("shop");
      await Bun.sleep(100);
      const shop = await app(proxy.port, owners, "shop");
      shop.socket.write(tunnel());
      expect(await shop.status(1000)).toBe(503);
      expect(shop.body()).toContain("shop already holds 2 connections");
      // Two of blog's on the connectors' port fill the proxy for everyone.
      const blog = [await open("blog"), await open("blog")];
      await Bun.sleep(100);
      const wiki = await app(proxy.port, owners, "wiki");
      wiki.socket.write(tunnel());
      expect(await wiki.status(1000)).toBe(503);
      expect(wiki.body()).toContain("the proxy holds too many connections");
      blog[0]!.socket.end();
      await Bun.sleep(100);
      const again = await app(proxy.port, owners, "wiki");
      again.socket.write(tunnel());
      expect(await again.status(1000)).toBe(200);
      again.socket.end();
    } finally {
      stop();
      proxy.stop();
    }
  });

  test("an app that reads nothing makes the proxy stop reading the answer, and reading again lets all of it through", async () => {
    const { connectors, open, stop } = bench({ bufferBytes: 16 * 1024 });
    try {
      const shop = await open("shop");
      shop.socket.pause();
      shop.call("/connectors/feed/flood");
      const written = await settled(flooded);
      // Bun's fetch read the answer as fast as it came, and Bun.serve kept
      // what the app did not take: the whole flood was held for it.
      expect(written.after).toBeLessThan(4 * OVERSHOOT);
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      expect(connectors.buffered()).toBeLessThanOrEqual(16 * 1024 + OVERSHOOT);
      // The app reads: the rest comes, every byte of it, and nothing stays.
      shop.socket.resume();
      await Promise.race([shop.closed, Bun.sleep(10_000)]);
      expect(shop.received()).toBe(FLOOD_BYTES);
      expect(connectors.buffered()).toBe(0);
      expect(connectors.open()).toBe(0);
    } finally {
      stop();
    }
  }, 20_000);

  test("one project's calls hold at most its budget: its next call is refused 503, another project's goes through", async () => {
    const limits = { bufferBytes: 16 * 1024, projectBufferBytes: 1024 * 1024, totalBufferBytes: 256 * 1024 * 1024 };
    const { connectors, open, stop } = bench(limits);
    try {
      const shop: Awaited<ReturnType<typeof app>>[] = [];
      for (let i = 0; i < 6; i++) {
        const each = await open("shop");
        each.socket.pause();
        each.call("/connectors/feed/flood");
        shop.push(each);
      }
      const written = await settled(flooded);
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      const next = await open("shop");
      next.call("/connectors/feed/ok");
      expect(await next.status()).toBe(503);
      expect(next.body()).toContain("shop already holds too many bytes");
      // The budget, and what the one read under way delivered past it.
      expect(connectors.buffered()).toBeLessThanOrEqual(limits.projectBufferBytes + OVERSHOOT);
      // Another project is not held back by shop's budget.
      const blog = await open("blog");
      blog.call("/connectors/feed/ok");
      expect(await blog.status()).toBe(200);
      // shop's apps read, its answers end: its calls go through again.
      for (const each of shop) each.socket.resume();
      endAnswers();
      await Promise.race([Promise.all(shop.map((each) => each.closed)), Bun.sleep(10_000)]);
      expect(connectors.buffered()).toBe(0);
      const later = await open("shop");
      later.call("/connectors/feed/ok");
      expect(await later.status()).toBe(200);
    } finally {
      stop();
    }
  }, 20_000);

  test("every project together holds at most the proxy's budget, and a new call is refused 503", async () => {
    const limits = { bufferBytes: 16 * 1024, projectBufferBytes: 256 * 1024 * 1024, totalBufferBytes: 1024 * 1024 };
    const { connectors, open, stop } = bench(limits);
    try {
      for (const slug of ["shop", "blog"]) {
        for (let i = 0; i < 3; i++) {
          const each = await open(slug);
          each.socket.pause();
          each.call("/connectors/feed/flood");
        }
      }
      const written = await settled(flooded);
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      const wiki = await open("wiki");
      wiki.call("/connectors/feed/ok");
      expect(await wiki.status()).toBe(503);
      expect(wiki.body()).toContain("the proxy already holds too many bytes");
      expect(connectors.buffered()).toBeLessThanOrEqual(limits.totalBufferBytes + OVERSHOOT);
    } finally {
      stop();
    }
  }, 20_000);

  test("bodies sent to an upstream that reads nothing are held to the project's budget, not to 10 MiB a call", async () => {
    const limits = { bufferBytes: 16 * 1024, projectBufferBytes: 1024 * 1024, totalBufferBytes: 256 * 1024 * 1024 };
    const { connectors, open, stop } = bench(limits);
    try {
      const shop: Awaited<ReturnType<typeof app>>[] = [];
      for (let i = 0; i < 6; i++) {
        const each = await open("shop");
        each.upload("/connectors/feed/sink", MAX_BODY_BYTES);
        shop.push(each);
      }
      // Bun's fetch read each body as fast as the app sent it, whatever the
      // upstream took: 32 calls of 10 MiB were past the unit's 256 MiB.
      const written = await settled(() => shop.reduce((sum, each) => sum + each.flood.written, 0));
      expect(written.after - written.before).toBeLessThan(BLOCK.length);
      const next = await open("shop");
      next.call("/connectors/feed/ok");
      expect(await next.status()).toBe(503);
      expect(next.body()).toContain("shop already holds too many bytes");
      expect(connectors.buffered()).toBeLessThanOrEqual(limits.projectBufferBytes + OVERSHOOT);
    } finally {
      stop();
    }
  }, 20_000);

  test("a body in one-byte chunks holds about what the budgets count, not three arrays a byte", async () => {
    const { connectors, open, stop } = bench();
    // Whole one-byte chunks, written on from where the last write stopped: a
    // chunk cut in two would not read, and the call would end on a 400.
    const unit = "1\r\nx\r\n";
    const block = new TextEncoder().encode(unit.repeat(Math.floor(BLOCK.length / unit.length)));
    let written = 0;
    const shop = await open("shop");
    const pumping = setInterval(() => {
      while (written < 8 * 1024 * 1024) {
        const offset = written % block.length;
        const taken = shop.socket.write(block.subarray(offset));
        if (taken > 0) written += taken;
        if (taken < block.length - offset) return;
      }
    }, 5);
    try {
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      shop.socket.write("POST /connectors/feed/sink HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n");
      await settled(() => written);
      expect(written).toBeGreaterThan(OVERSHOOT);
      expect(shop.body()).toBe("");
      Bun.gc(true);
      const grown = process.memoryUsage().heapUsed - before;
      // Each byte went up as three arrays of its own, a size line, the byte
      // and a line end, each counted as its few bytes and costing some sixty:
      // 2 MiB counted held 80 MiB, measured, and four such calls took the
      // proxy past the unit's MemoryMax.
      expect(connectors.buffered()).toBeLessThanOrEqual(64 * 1024 + OVERSHOOT);
      expect(grown).toBeLessThan(4 * OVERSHOOT);
    } finally {
      clearInterval(pumping);
      stop();
    }
  }, 20_000);

  test("a call keeps its place among its project's calls until its answer is sent, not only until its headers", async () => {
    const { open, stop } = bench();
    try {
      const shop: Awaited<ReturnType<typeof app>>[] = [];
      for (let i = 0; i < MAX_IN_FLIGHT_PER_PROJECT; i++) {
        const each = await open("shop");
        each.call("/connectors/feed/trickle");
        shop.push(each);
      }
      for (const each of shop) expect(await each.status()).toBe(200);
      // Every answer has its headers and streams on. Bun.serve gave the place
      // back at the headers: a project held any number of answers open.
      const next = await open("shop");
      next.call("/connectors/feed/ok");
      expect(await next.status()).toBe(503);
      expect(next.body()).toContain(`shop already has ${MAX_IN_FLIGHT_PER_PROJECT} connector calls under way`);
      endAnswers();
      await Promise.race([Promise.all(shop.map((each) => each.closed)), Bun.sleep(5000)]);
      expect(shop[0]!.body()).toContain("tick");
      const later = await open("shop");
      later.call("/connectors/feed/ok");
      expect(await later.status()).toBe(200);
    } finally {
      stop();
    }
  }, 20_000);

  test("an upstream that answers wrong: the app is told which way, and nothing is held", async () => {
    const { connectors, open, recorded, stop } = bench({ headersTimeoutMs: 300 });
    try {
      for (const [path, status, message] of [
        ["/big-head", 502, "connectors: feed: its answer's head is over 16384 bytes"],
        ["/hang-up", 502, "connectors: feed: the connection closed before an answer"],
        ["/sink", 504, "connectors: feed: no answer in time"],
      ] as const) {
        const shop = await open("shop");
        shop.call(`/connectors/feed${path}`);
        expect(await shop.status()).toBe(status);
        await shop.closed;
        expect(JSON.parse(shop.body())).toEqual({ error: "upstream", message });
        expect(recorded.used.at(-1)).toEqual({ slug: "shop", connector: "feed", status: null });
      }
      // An interim answer is dropped, the final one passed on.
      const hints = await open("shop");
      hints.call("/connectors/feed/hints");
      expect(await hints.status()).toBe(200);
      await hints.closed;
      expect(hints.body()).toBe("ok");
      // An answer cut short reaches the app as it came, then the connection
      // closes before its length: the app's client sees it incomplete.
      const cut = await open("shop");
      cut.call("/connectors/feed/cut");
      expect(await cut.status()).toBe(200);
      await cut.closed;
      expect(cut.head()).toContain("Content-Length: 10");
      expect(cut.body()).toBe("abc");
      await Bun.sleep(50);
      expect(connectors.open()).toBe(0);
      expect(connectors.calls()).toBe(0);
      expect(connectors.buffered()).toBe(0);
    } finally {
      stop();
    }
  });

  test("the proxy holds a bounded number of calls under way, all projects together", async () => {
    const { open, stop } = bench({ maxCalls: 2 });
    try {
      for (const slug of ["shop", "blog"]) {
        const each = await open(slug);
        each.call("/connectors/feed/trickle");
        expect(await each.status()).toBe(200);
      }
      const wiki = await open("wiki");
      wiki.call("/connectors/feed/ok");
      expect(await wiki.status()).toBe(503);
      expect(wiki.body()).toContain("the proxy already has 2 connector calls under way");
    } finally {
      stop();
    }
  });
});

/** The sum stops moving: sampled twice, apart. */
async function settled(read: () => number): Promise<{ before: number; after: number }> {
  await Bun.sleep(400);
  const before = read();
  await Bun.sleep(300);
  return { before, after: read() };
}

/**
 * An app's connection to the connectors, or to the CONNECT port, its project
 * named by its port as the kernel would name it. It keeps the head of what it
 * reads and the first bytes of the rest, counts the rest, and can flood a
 * body of its own behind a head.
 */
async function app(port: number, owners: Map<number, Caller>, slug: string) {
  const latin1 = new TextDecoder("latin1");
  let head = "";
  let headed = false;
  let body = "";
  let received = 0;
  const answered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const flood: Flood = { socket: null, written: 0, on: false };
  const keep = (text: string) => {
    received += text.length;
    if (body.length < 4096) body += text.slice(0, 4096 - body.length);
  };
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        if (headed) return keep(latin1.decode(chunk));
        head += latin1.decode(chunk);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        const rest = head.slice(end + 4);
        head = head.slice(0, end + 4);
        headed = true;
        keep(rest);
        answered.resolve();
      },
      drain: () => pump(flood),
      close: () => (answered.resolve(), closed.resolve()),
      error: () => (answered.resolve(), closed.resolve()),
    },
  });
  owners.set(socket.localPort, { kind: "project", slug, account: `site-${slug}` });
  flood.socket = socket;
  return {
    socket,
    flood,
    call: (path: string) => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`),
    /** A body of `bytes` behind its head, written as fast as the proxy takes it. */
    upload(path: string, bytes: number) {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${bytes}\r\n\r\n`);
      flood.limit = bytes;
      flood.on = true;
      pump(flood);
    },
    /** The answer's status, 0 when none came in time. */
    async status(timeoutMs = 3000): Promise<number> {
      await Promise.race([answered.promise, Bun.sleep(timeoutMs)]);
      return Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
    },
    head: () => head,
    body: () => body,
    received: () => received,
    closed: closed.promise,
  };
}

describe("the pieces of a forwarded request", () => {
  test("the path under a connector", () => {
    expect(connectorPath("/connectors/chat")).toEqual({ name: "chat", rest: "" });
    expect(connectorPath("/connectors/chat/a/b")).toEqual({ name: "chat", rest: "/a/b" });
    for (const path of ["/connectors/", "/connectors/Chat/x", "/connectors/chat/a%2fb", "/connectors/chat/a%5Cb", "/other/chat", "/connectors/constructor/x"]) {
      expect(connectorPath(path)).toBeNull();
    }
  });

  test("a header named in Connection is dropped with the others", () => {
    const headers = upstreamHeaders(
      new Headers({ connection: "x-hop", "x-hop": "1", "x-end": "2", authorization: "app", "private-token": "app" }),
      "PRIVATE-TOKEN",
      "lent",
      "chat.test-zone.invalid",
    );
    expect(Object.fromEntries(headers)).toEqual({ "x-end": "2", host: "chat.test-zone.invalid", "private-token": "lent" });
  });
});
