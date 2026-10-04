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
 * Bun.serve rather than the raw listener of proxy.ts: this is an HTTP exchange,
 * with a body and an answer that may stream for minutes, and Bun parses and
 * streams both. `requestIP` gives the caller's port, which is all the kernel
 * needs to say who it is.
 */
import type { Server } from "bun";
import { isValidConnectorName } from "../../bin/cli/egress";
import { isGranted, readBaseUrl } from "../../bin/cli/connectors";
import { urlHost } from "./addresses";
import type { Audit } from "./audit";
import { HOP_BY_HOP } from "./decide";
import type { Policy } from "./policy";
import type { Caller, Peer } from "./proc-net";
import { resolveChecked, type Lookup } from "./resolve";

export type ConnectorsOptions = {
  hostname: string;
  port: number;
  identify: (peer: Peer) => Caller | Promise<Caller>;
  policy: Policy;
  lookup: Lookup;
  audit: Pick<Audit, "used" | "denied" | "recent">;
  /** The dashboard's account, the only caller of the read-only routes. */
  dashboardAccount: string;
  /** Where to connect for a judged address; the tests reroute it to a local server. */
  route?: (address: string, port: number) => { hostname: string; port: number };
  /** Certificates to trust on top of the system's: the tests' own authority. */
  ca?: string;
  /** Time left to the upstream to answer with its headers. */
  headersTimeoutMs?: number;
  lookupTimeoutMs?: number;
  /** What the dashboard's status route says about the proxy's own side. */
  status?: () => Record<string, unknown>;
};

/** The biggest request body forwarded: an API call, not a file upload service. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

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

function refuse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: { "X-Sitesolide-Egress": "refused", "Cache-Control": "no-store" } });
}

/** The headers sent upstream: the app's, cleaned, and the connector's credential. */
export function upstreamHeaders(incoming: Headers, connectorHeader: string, value: string, host: string): Headers {
  const outgoing = new Headers();
  const drop = new Set([...HOP_BY_HOP, ...CREDENTIAL_HEADERS, "host", "content-length", "transfer-encoding", connectorHeader.toLowerCase()]);
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
 * The headers sent back to the app. fetch has already decoded the body, so its
 * encoding and length no longer describe what is sent; Bun.serve frames it
 * again.
 */
export function downstreamHeaders(incoming: Headers, connector: string): Headers {
  const outgoing = new Headers();
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.includes(lower) || lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return;
    outgoing.append(name, value);
  });
  outgoing.set("X-Sitesolide-Connector", connector);
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

export function startConnectors(options: ConnectorsOptions): Server<undefined> {
  const route = options.route ?? ((address: string, port: number) => ({ hostname: address, port }));
  const headersTimeoutMs = options.headersTimeoutMs ?? 30_000;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? 5_000;

  async function caller(req: Request, server: Server<undefined>): Promise<Caller> {
    const ip = server.requestIP(req);
    if (ip === null) return { kind: "unknown", reason: "no peer address" };
    try {
      return await options.identify({ remoteAddress: ip.address, remotePort: ip.port, localAddress: options.hostname, localPort: server.port ?? options.port });
    } catch {
      return { kind: "unknown", reason: "identification failed" };
    }
  }

  async function forward(req: Request, who: Caller, name: string, rest: string): Promise<Response> {
    const denied = (status: number, reason: string, message: string, target: string | null) => {
      options.audit.denied({ target, destination: `connector:${name}`, reason, account: who.kind === "account" ? who.account : null });
      return refuse(status, "refused", message);
    };
    if (who.kind !== "project") {
      return denied(403, who.kind === "account" ? "not a project" : "unidentified", "connectors: only a project's service may call a connector", null);
    }
    const { slug } = who;
    const lending = options.policy.lending();
    const connector = lending.connectors.connectors[name];
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
    const resolution = await resolveChecked(base.host, options.lookup, lookupTimeoutMs);
    if (!resolution.ok) return denied(resolution.status, resolution.reason, `connectors: ${name}: ${resolution.message.replace(/^egress: /, "")}`, slug);

    const url = new URL(req.url);
    const path = `${base.path}${rest}` || "/";
    const host = base.port === 443 ? base.host : `${base.host}:${base.port}`;
    const headers = upstreamHeaders(req.headers, connector.header, connector.value, host);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

    let lastError = "no address answered";
    for (const address of resolution.addresses) {
      const target = route(address, base.port);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), headersTimeoutMs);
      try {
        // The address judged, never the name again; TLS still checks the
        // certificate against the name, which serverName carries.
        const response = await fetch(`https://${urlHost(target.hostname)}:${target.port}${path}${url.search}`, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          signal: abort.signal,
          tls: { serverName: base.host, ...(options.ca === undefined ? {} : { ca: options.ca }) },
        });
        clearTimeout(timer);
        options.audit.used(slug, name, response.status);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: downstreamHeaders(response.headers, name) });
      } catch (error) {
        clearTimeout(timer);
        lastError = error instanceof Error && error.name === "AbortError" ? "no answer in time" : "the connection failed";
      }
    }
    options.audit.used(slug, name, null);
    return refuse(502, "upstream", `connectors: ${name}: ${lastError}`);
  }

  /** The routes the dashboard reads, to it alone. */
  function dashboard(req: Request, who: Caller, url: URL): Response {
    // The dashboard is a project like any other, site-dashboard: its account
    // decides, whatever kind the kernel's answer gives it.
    if (who.kind === "unknown" || who.account !== options.dashboardAccount) {
      return refuse(403, "refused", "only the dashboard reads this");
    }
    if (url.pathname === "/audit") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const beforeText = url.searchParams.get("before");
      const before = beforeText === null ? null : Number(beforeText);
      if (!Number.isInteger(limit) || limit < 1 || (before !== null && !Number.isInteger(before))) {
        return refuse(400, "invalid", "limit and before must be integers");
      }
      return Response.json({ rows: options.audit.recent(limit, before) }, { headers: { "Cache-Control": "no-store" } });
    }
    const lending = options.policy.lending();
    return Response.json(
      {
        connectors: Object.keys(lending.connectors.connectors).length,
        grants: lending.grants.grants.length,
        errors: lending.errors,
        ...options.status?.(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    // A streamed answer, a model's tokens for instance, may pause between two
    // chunks; Bun caps this at 255 seconds.
    idleTimeout: 255,
    maxRequestBodySize: MAX_BODY_BYTES,
    development: false,
    async fetch(req, server) {
      const url = new URL(req.url);
      const who = await caller(req, server);
      if (url.pathname === "/audit" || url.pathname === "/status") {
        if (req.method !== "GET") return refuse(405, "invalid", "GET only");
        return dashboard(req, who, url);
      }
      const target = connectorPath(url.pathname);
      if (target === null) return refuse(404, "not-found", "connectors: call /connectors/<name>/<path>");
      return forward(req, who, target.name, target.rest);
    },
    error() {
      return refuse(500, "failure", "connectors: unexpected error");
    },
  });
}
