import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { EMPTY_CONNECTORS, EMPTY_GRANTS, putConnector, serializeConnectors, serializeGrants, setGrant } from "../../bin/cli/connectors";
import { DATA_DIR } from "../src/config";
import { connectorPath, startConnectors, upstreamHeaders } from "../src/connectors";
import { createPolicy } from "../src/policy";
import type { Caller } from "../src/proc-net";
import { certificate, OPENSSL, recordingAudit, stubLookup, stubRoute } from "./helpers";

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
  let server: Server<undefined>;
  let root: string;
  let caller: Caller = { kind: "project", slug: "shop", account: "site-shop" };
  const recorded = recordingAudit();
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(() => {
    tls = certificate([CHAT]);
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      async fetch(req) {
        const url = new URL(req.url);
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
      audit: { ...recorded.audit, recent: () => [{ id: 1, at: now, actor: "system", action: "connector.use", target: "shop", detail: "{}" }] },
      dashboardAccount: "site-dashboard",
      route: stubRoute({ [`${ADDRESS}:443`]: upstream.port! }),
      ca: tls.cert,
    });
  });

  afterAll(() => {
    server?.stop(true);
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

  test("an answer the upstream compressed reaches the app decoded and whole", async () => {
    caller = { kind: "project", slug: "shop", account: "site-shop" };
    const response = await fetch(`${base()}/connectors/chat/gzip`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("compressed ".repeat(500));
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

describe("the pieces of a forwarded request", () => {
  test("the path under a connector", () => {
    expect(connectorPath("/connectors/chat")).toEqual({ name: "chat", rest: "" });
    expect(connectorPath("/connectors/chat/a/b")).toEqual({ name: "chat", rest: "/a/b" });
    for (const path of ["/connectors/", "/connectors/Chat/x", "/connectors/chat/a%2fb", "/connectors/chat/a%5Cb", "/other/chat"]) {
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
