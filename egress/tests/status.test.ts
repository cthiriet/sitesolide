import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import { parseEgressEntry } from "../../bin/cli/egress";
import type { AuditRow } from "../src/audit";
import type { Caller } from "../src/proc-net";
import { startProxy } from "../src/proxy";
import { startStatusPort, type StatusPort } from "../src/status";
import { identifyByPort, rawExchange, recordingAudit, stubLookup, stubRoute } from "./helpers";

/**
 * The proxy's second port, which answers the dashboard's two read-only routes
 * and nothing else, on a random port, the caller named by the test.
 */
const DASHBOARD: Caller = { kind: "project", slug: "dashboard", account: "site-dashboard" };
const ROW: AuditRow = { id: 1, at: "2026-10-04T12:00:00.000Z", actor: "system", action: "egress.denied", target: "shop", detail: "{}" };

describe("the read-only routes", () => {
  let server: StatusPort;
  let caller: Caller = DASHBOARD;
  let rows: AuditRow[] = [ROW];
  const asked: [number, number | null][] = [];
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(() => {
    server = startStatusPort({
      hostname: "127.0.0.1",
      port: 0,
      identify: () => caller,
      audit: {
        ...recordingAudit().audit,
        recent: (limit, before = null) => {
          asked.push([limit, before]);
          return rows;
        },
      },
      dashboardAccount: "site-dashboard",
      status: () => ({ started: ROW.at, openTunnels: 2 }),
      limits: { headTimeoutMs: 300 },
      log: () => undefined,
    });
  });

  afterAll(() => server?.stop());

  test("answer the dashboard's account, and nobody else", async () => {
    caller = DASHBOARD;
    const audit = await fetch(`${base()}/audit?limit=10&before=7`);
    expect(audit.status).toBe(200);
    expect(audit.headers.get("cache-control")).toBe("no-store");
    expect(((await audit.json()) as { rows: unknown[] }).rows).toEqual([ROW]);
    expect(asked.at(-1)).toEqual([10, 7]);
    expect(await (await fetch(`${base()}/status`)).json()).toEqual({ started: ROW.at, openTunnels: 2 });
    for (const other of [
      { kind: "project", slug: "shop", account: "site-shop" },
      { kind: "account", account: "root" },
      { kind: "unknown", reason: "x" },
    ] as Caller[]) {
      caller = other;
      for (const path of ["/audit", "/status"]) {
        const refused = await fetch(`${base()}${path}`);
        expect({ path, status: refused.status }).toEqual({ path, status: 403 });
        expect(await refused.json()).toEqual({ error: "refused", message: "only the dashboard reads this" });
      }
    }
  });

  test("GET alone, with integers, on these two paths alone", async () => {
    caller = DASHBOARD;
    expect((await fetch(`${base()}/audit`, { method: "POST" })).status).toBe(405);
    for (const query of ["limit=x", "limit=0", "before=1.5"]) {
      expect({ query, status: (await fetch(`${base()}/audit?${query}`)).status }).toEqual({ query, status: 400 });
    }
    for (const path of ["/", "/somewhere", "/audit/more"]) {
      const missing = await fetch(`${base()}${path}`);
      expect({ path, status: missing.status }).toEqual({ path, status: 404 });
      expect(((await missing.json()) as { message: string }).message).toContain("GET /status and GET /audit");
    }
  });

  test("an answer larger than one write reaches the dashboard whole", async () => {
    caller = DASHBOARD;
    rows = Array.from({ length: 500 }, (_, index) => ({ ...ROW, id: index + 1, detail: JSON.stringify({ reason: "x".repeat(4000) }) }));
    try {
      const answer = (await (await fetch(`${base()}/audit?limit=500`)).json()) as { rows: AuditRow[] };
      expect(answer.rows).toHaveLength(500);
      expect(answer.rows.at(-1)?.id).toBe(500);
    } finally {
      rows = [ROW];
    }
  });

  test("what is not a request it reads is refused with a sentence, and the connection closed", async () => {
    expect(await rawExchange(server.port, "hello\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await rawExchange(server.port, "GET /status HTTP/1.0\r\n\r\n")).toStartWith("HTTP/1.1 505");
    expect(await rawExchange(server.port, "GET http://example.com/status HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await rawExchange(server.port, `GET /status HTTP/1.1\r\nX-Big: ${"x".repeat(20_000)}\r\n\r\n`)).toStartWith("HTTP/1.1 431");
    // A head that never ends is given up on at its delay.
    expect(await rawExchange(server.port, "GET /status HTTP/1.1\r\n", 2000)).toStartWith("HTTP/1.1 408");
    expect(server.open()).toBe(0);
  });
});

/**
 * A connection to either port, its project named by its client's port as the
 * kernel would name it, which keeps the head of what it reads.
 */
async function app(port: number, owners: Map<number, Caller>, slug: string) {
  let head = "";
  const answered = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        head += new TextDecoder("latin1").decode(chunk);
        if (head.includes("\r\n\r\n")) answered.resolve();
      },
      close: () => answered.resolve(),
      error: () => answered.resolve(),
    },
  });
  owners.set(socket.localPort, { kind: "project", slug, account: `site-${slug}` });
  return {
    socket,
    /** The answer's status, 0 when none came in time. */
    async status(timeoutMs = 3000): Promise<number> {
      await Promise.race([answered.promise, Bun.sleep(timeoutMs)]);
      return Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
    },
    head: () => head,
  };
}

describe("what one project may take of the status port", () => {
  const HOST = "api.test-zone.invalid";
  const ADDRESS = "203.0.114.70";
  let upstream: TCPSocketListener<undefined>;

  beforeAll(() => {
    // Where an allowed tunnel lands: it only has to accept the connection.
    upstream = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  });

  afterAll(() => upstream?.stop(true));

  test("one project holds at most its share of connections, silent ones included, and the dashboard still gets in", async () => {
    const owners = new Map<number, Caller>();
    const recorded = recordingAudit();
    const server = startStatusPort({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      audit: recorded.audit,
      dashboardAccount: "site-dashboard",
      limits: { maxPerProject: 3 },
    });
    try {
      // Three connections that never send a head: the whole share of shop.
      const silent = [await app(server.port, owners, "shop"), await app(server.port, owners, "shop"), await app(server.port, owners, "shop")];
      await Bun.sleep(100);
      const fourth = await app(server.port, owners, "shop");
      expect(await fourth.status(1000)).toBe(503);
      expect(fourth.head()).toContain("shop already holds 3 connections");
      expect(recorded.denied.at(-1)).toMatchObject({ target: "shop", reason: "too many connections" });
      // Another project is not touched by shop's share.
      const dashboard = await app(server.port, owners, "dashboard");
      dashboard.socket.write("GET /status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
      expect(await dashboard.status()).toBe(200);
      for (const each of silent) each.socket.end();
    } finally {
      server.stop();
    }
  });

  test("both ports count against one admission: status connections take from the project's tunnels, and from the proxy's", async () => {
    const owners = new Map<number, Caller>();
    const proxy = startProxy({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      egressOf: () => [parseEgressEntry(HOST)!],
      lookup: stubLookup({ [HOST]: [ADDRESS] }),
      ownAddresses: () => new Set<string>(),
      audit: recordingAudit().audit,
      route: stubRoute({ [`${ADDRESS}:443`]: upstream.port }),
      limits: { maxPerProject: 2, maxConnections: 4 },
      log: () => undefined,
    });
    const server = startStatusPort({
      hostname: "127.0.0.1",
      port: 0,
      identify: identifyByPort(owners),
      audit: recordingAudit().audit,
      dashboardAccount: "site-dashboard",
      admission: proxy.admission,
    });
    const tunnel = `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`;
    try {
      // shop's share is taken on the status port: its tunnel is refused.
      await app(server.port, owners, "shop");
      await app(server.port, owners, "shop");
      await Bun.sleep(100);
      const shop = await app(proxy.port, owners, "shop");
      shop.socket.write(tunnel);
      expect(await shop.status(1000)).toBe(503);
      expect(shop.head()).toContain("shop already holds 2 connections");
      // Two of blog's on the status port fill the proxy for everyone.
      const blog = [await app(server.port, owners, "blog"), await app(server.port, owners, "blog")];
      await Bun.sleep(100);
      const wiki = await app(proxy.port, owners, "wiki");
      wiki.socket.write(tunnel);
      expect(await wiki.status(1000)).toBe(503);
      expect(wiki.head()).toContain("the proxy holds too many connections");
      blog[0]!.socket.end();
      await Bun.sleep(100);
      const again = await app(proxy.port, owners, "wiki");
      again.socket.write(tunnel);
      expect(await again.status(1000)).toBe(200);
      again.socket.end();
    } finally {
      server.stop();
      proxy.stop();
    }
  });
});
