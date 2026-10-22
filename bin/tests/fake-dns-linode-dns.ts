/**
 * A local stand-in for the DNS Manager of Akamai's Linode API v4, its domains
 * and their records, on a random port of the loopback: the tests of
 * bin/cli/dns/linode-dns.ts never reach api.linode.com.
 *
 * It answers in the shapes of the OpenAPI document,
 * github.com/linode/linode-api-openapi: `data`, `page`, `pages` and `results`
 * on every list, a domain with a numeric `id`, its `domain` and its `type`,
 * `master` or `slave`, a record's name relative to its domain, empty for the
 * domain itself, its address in `target` and its TTL in `ttl_sec`, rounded up
 * to a value the reference lists, the record itself for one created (200) or
 * updated (200), an empty object for one deleted, and
 * `{"errors": [{"reason", "field"}]}` errors.
 *
 * Its token carries the scope `domains:read_write` unless a test says
 * otherwise: `read_only` reads and is refused every write, `none` is refused
 * everything, both with the 401 "not authorized to use this endpoint" the
 * API answers a token without the scope. `ignoreTtlOnCreate` stores a record
 * created at the domain's default TTL, 0, whatever it asked, as DNSControl's
 * Linode provider says the API does. A record created beside a CNAME of the
 * same name is a 400, in a wording of the fake's.
 *
 * Lists come back `pageSize` items a page whatever `page_size` asks, two by
 * default, so that a client that reads one page fails a test; a `page_size`
 * outside 25 to 500, the reference's bounds, is a 400.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** The shape of a personal access token: 64 hexadecimal characters. */
export const FAKE_TOKEN = "d1e5a7c0b2f4e6d8a0c2e4f6b8d0a2c4e6f8b0d2a4c6e8f0b2d4a6c8e0f2b4d6";

export const ZONE = "test-zone.invalid";

/** The values `ttl_sec` takes for a record, as the reference lists them. */
const TTLS = [300, 3600, 7200, 14400, 28800, 57600, 86400, 172800, 345600, 604800, 1209600, 2419200];

export type FakeRecord = { id: number; type: string; name: string; target: string; ttl_sec: number };

export type FakeDomain = { id: number; domain: string; type: "master" | "slave"; records: FakeRecord[] };

export type Received = FakeRequest & { url: string };

type Failure = { method: string; path: RegExp; status: number; body: unknown; times: number };

const TYPES = new Set(["A", "AAAA", "NS", "MX", "CNAME", "TXT", "SRV", "PTR", "CAA"]);

/** The domains of a fresh account: the zone on the second page of two, between others. */
const DOMAINS = ["a-first.invalid", "b-second.invalid", ZONE, "z-last.invalid"];

function error(status: number, reason: string, field?: string): Response {
  return Response.json({ errors: [{ reason, ...(field === undefined ? {} : { field }) }] }, { status });
}

/** Rounded up to the next value the reference lists; 0 stays the domain's default. */
const rounded = (ttl: number): number => (ttl === 0 ? 0 : (TTLS.find((value) => value >= ttl) ?? TTLS[TTLS.length - 1]!));

export type FakeLinodeDns = ReturnType<typeof createFakeLinodeDns>;

export function createFakeLinodeDns(options: { pageSize?: number } = {}) {
  let nextId = 5_000;
  const domains: FakeDomain[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  const settings: { pageSize: number; scope: "read_write" | "read_only" | "none"; ignoreTtlOnCreate: boolean } = {
    pageSize: options.pageSize ?? 2,
    scope: "read_write",
    ignoreTtlOnCreate: false,
  };

  const fresh = (): void => {
    domains.length = 0;
    for (const domain of DOMAINS) domains.push({ id: nextId++, domain, type: "master", records: [] });
  };
  fresh();

  const holding = (name: string): FakeDomain | undefined =>
    domains.filter((domain) => name === domain.domain || name.endsWith(`.${domain.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0];

  const relative = (name: string, domain: FakeDomain): string => (name === domain.domain ? "" : name.slice(0, -(domain.domain.length + 1)));
  const absolute = (name: string, domain: FakeDomain): string => (name === "" ? domain.domain : `${name}.${domain.domain}`);

  const page = <T>(url: URL, items: T[]): Response => {
    const asked = url.searchParams.get("page_size");
    if (asked !== null && !(Number(asked) >= 25 && Number(asked) <= 500)) return error(400, "Must be between 25 and 500", "page_size");
    const size = settings.pageSize;
    const pages = Math.max(1, Math.ceil(items.length / size));
    const current = Math.min(pages, Math.max(1, Number(url.searchParams.get("page") ?? "1")));
    return Response.json({ data: items.slice((current - 1) * size, current * size), page: current, pages, results: items.length });
  };

  const domainView = (domain: FakeDomain) => ({
    id: domain.id,
    domain: domain.domain,
    type: domain.type,
    status: "active",
    soa_email: `hostmaster@${domain.domain}`,
    description: "",
    group: "",
    tags: [],
    ttl_sec: 0,
    refresh_sec: 0,
    retry_sec: 0,
    expire_sec: 0,
    axfr_ips: [],
    master_ips: domain.type === "slave" ? ["192.0.2.53"] : [],
  });

  const recordView = (record: FakeRecord) => ({
    id: record.id,
    type: record.type,
    name: record.name,
    target: record.target,
    priority: 0,
    weight: 0,
    port: 0,
    service: null,
    protocol: null,
    tag: null,
    ttl_sec: record.ttl_sec,
    created: "2026-10-21T10:00:00",
    updated: "2026-10-21T10:00:00",
  });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v4/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "Malformed JSON");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({ method, path, search: url.search, body, headers, url: request.url });
    return route(url, method, path, body, request.headers.get("authorization"));
  }

  function route(url: URL, method: string, path: string, body: unknown, authorization: string | null): Response {
    if (authorization !== `Bearer ${FAKE_TOKEN}`) return error(401, "Invalid Token");
    const write = method !== "GET";
    if (settings.scope === "none" || (write && settings.scope === "read_only")) return error(401, "Your OAuth token is not authorized to use this endpoint.");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return Response.json(failure.body, { status: failure.status });
    }
    const parts = path.split("/");
    if (method === "GET" && path === "/domains") return page(url, domains.map(domainView));
    if (parts[1] !== "domains" || parts.length < 3 || parts.length > 5 || (parts.length > 3 && parts[3] !== "records")) return error(404, "Not found");
    const domain = domains.find((candidate) => String(candidate.id) === parts[2]);
    if (domain === undefined) return error(404, "Not found");
    if (method === "GET" && parts.length === 3) return Response.json(domainView(domain));
    if (parts.length === 3) return error(404, "Not found");
    if (write && domain.type === "slave") return error(400, "Records of a slave domain cannot be edited");

    if (method === "GET" && parts.length === 4) return page(url, domain.records.map(recordView));
    if (method === "POST" && parts.length === 4) {
      const input = (body ?? {}) as { type?: unknown; name?: unknown; target?: unknown; ttl_sec?: unknown };
      const type = String(input.type ?? "");
      if (!TYPES.has(type)) return error(400, "Invalid record type", "type");
      if (typeof input.target !== "string" || input.target === "") return error(400, "target is required", "target");
      if (type === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(input.target)) return error(400, "Must be a valid IPv4 address", "target");
      if (type === "AAAA" && !input.target.includes(":")) return error(400, "Must be a valid IPv6 address", "target");
      if (input.ttl_sec !== undefined && (typeof input.ttl_sec !== "number" || input.ttl_sec < 0)) return error(400, "Must be a positive integer", "ttl_sec");
      const name = typeof input.name === "string" ? input.name : "";
      const beside = domain.records.filter((record) => record.name === name);
      if ((type === "CNAME" && beside.length > 0) || beside.some((record) => record.type === "CNAME")) return error(400, "A CNAME cannot share its name with another record", "name");
      const record: FakeRecord = { id: nextId++, type, name, target: input.target, ttl_sec: settings.ignoreTtlOnCreate ? 0 : rounded(typeof input.ttl_sec === "number" ? input.ttl_sec : 0) };
      domain.records.push(record);
      return Response.json(recordView(record));
    }

    const record = domain.records.find((candidate) => String(candidate.id) === parts[4]);
    if (record === undefined || parts.length !== 5) return error(404, "Not found");
    if (method === "GET") return Response.json(recordView(record));
    if (method === "PUT") {
      const input = (body ?? {}) as { name?: unknown; target?: unknown; ttl_sec?: unknown };
      if (input.ttl_sec !== undefined && (typeof input.ttl_sec !== "number" || input.ttl_sec < 0)) return error(400, "Must be a positive integer", "ttl_sec");
      if (typeof input.target === "string") record.target = input.target;
      if (typeof input.name === "string") record.name = input.name;
      if (typeof input.ttl_sec === "number") record.ttl_sec = rounded(input.ttl_sec);
      return Response.json(recordView(record));
    }
    if (method === "DELETE") {
      domain.records.splice(domain.records.indexOf(record), 1);
      return Response.json({});
    }
    return error(404, "Not found");
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}/v4`;

  return {
    url,
    environment: { SITESOLIDE_DNS_LINODE_TOKEN: FAKE_TOKEN, SITESOLIDE_LINODE_DNS_API: url } as Record<string, string>,
    secrets: [FAKE_TOKEN],
    zone: ZONE,
    domains,
    requests,
    settings,
    /** The requests that changed something. */
    writes(): Received[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** The next `times` requests matching answer this instead. */
    fail(method: string, path: RegExp, status: number, body: unknown, times = 1): void {
      failures.push({ method, path, status, body, times });
    },
    addDomain(name: string, type: "master" | "slave" = "master"): FakeDomain {
      const domain: FakeDomain = { id: nextId++, domain: name, type, records: [] };
      domains.push(domain);
      return domain;
    },
    addRecord(input: { name: string; type: string; content: string; ttl?: number }): void {
      const domain = holding(input.name);
      if (domain === undefined) throw new Error(`the fake holds no domain for ${input.name}`);
      domain.records.push({ id: nextId++, type: input.type, name: relative(input.name, domain), target: input.content, ttl_sec: input.ttl ?? 0 });
    },
    records(): { name: string; type: string; content: string }[] {
      const domain = domains.find((candidate) => candidate.domain === ZONE);
      return (domain?.records ?? []).map((record) => ({ name: absolute(record.name, domain!), type: record.type, content: record.target }));
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.scope = "read_write";
      settings.ignoreTtlOnCreate = false;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as every DNS provider's offers it, for bin/tests/dns-providers.test.ts. */
export function createFake(): FakeDns {
  return createFakeLinodeDns();
}
