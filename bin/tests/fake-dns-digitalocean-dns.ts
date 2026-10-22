/**
 * A local stand-in for DigitalOcean's DNS API, its domains and their records,
 * on a random port of the loopback: the tests of bin/cli/dns/digitalocean-dns.ts
 * never reach api.digitalocean.com.
 *
 * It answers in the shapes of DigitalOcean's OpenAPI source,
 * https://github.com/digitalocean/openapi, specification/resources/domains:
 * `{"domains": [...]}` and `{"domain_records": [...]}` with `links.pages` and
 * `meta.total`, a record's name relative to its domain, `@` for the domain
 * itself, `{"domain_record": {...}}` for a record created (201) or updated
 * (200), 204 for a deletion, and `{"id", "message", "request_id"}` errors,
 * whose messages for 401, 403 and 404 are the reference's own.
 *
 * It enforces the scopes the reference gives each operation: `domain:read`
 * to list, `domain:create` or `domain:update` to create a record,
 * `domain:update` to edit one, `domain:delete` or `domain:update` to delete
 * one. The token holds `domain:read` and `domain:update`, the least the
 * documentation recommends, unless a test says otherwise.
 *
 * What the reference does not document is the fake's own, and stricter than
 * the real API may be: a TTL under 30 seconds, the documented minimum, is a
 * 422, and so is a record created beside a CNAME of the same name, in wordings
 * of the fake's. Lists come back `pageSize` items a page whatever `per_page`
 * asks, two by default, and their links name another host than the fake's,
 * as the real ones name api.digitalocean.com: a client that read one page, or
 * followed a link as given, fails a test.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** A personal access token's shape: `dop_v1_` and 64 hexadecimal digits. */
export const FAKE_TOKEN = `dop_v1_${"5e1f0d2c3b4a6978".repeat(4)}`;

/** Where the links of a page point: an address that resolves nowhere. */
export const LINK_ORIGIN = "https://api.test-zone.invalid";

export const ZONE = "test-zone.invalid";

export type Scope = "domain:read" | "domain:create" | "domain:update" | "domain:delete";

export type FakeRecord = {
  id: number;
  type: string;
  /** Relative to its domain, `@` for the domain itself. */
  name: string;
  data: string;
  priority: number | null;
  port: number | null;
  ttl: number;
  weight: number | null;
  flags: number | null;
  tag: string | null;
};

export type FakeDomain = { name: string; ttl: number; records: FakeRecord[] };

export type Received = FakeRequest & { url: string };

type Failure = { method: string; path: RegExp; status: number; body: unknown; times: number };

const TYPES = new Set(["A", "AAAA", "CAA", "CNAME", "MX", "NS", "SOA", "SRV", "TXT"]);

/** The domains of a fresh account: the zone on the second page of two, between others. */
const DOMAINS = ["a-first.invalid", "b-second.invalid", ZONE, "z-last.invalid"];

function error(status: number, id: string, message: string): Response {
  return Response.json({ id, message, request_id: "4d9d8375-3c56-4925-a3e7-eb137fed17e9" }, { status });
}

const NOT_FOUND = () => error(404, "not_found", "The resource you were accessing could not be found.");

export type FakeDigitalOceanDns = ReturnType<typeof createFakeDigitalOceanDns>;

export function createFakeDigitalOceanDns(options: { pageSize?: number } = {}) {
  let nextId = 28_448_400;
  const domains: FakeDomain[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  const settings: { pageSize: number; scopes: Set<Scope> } = { pageSize: options.pageSize ?? 2, scopes: new Set(["domain:read", "domain:update"]) };

  const fresh = (): void => {
    domains.length = 0;
    for (const name of DOMAINS) domains.push({ name, ttl: 1800, records: [] });
  };
  fresh();

  /** The domain that holds an absolute name: itself, or the nearest parent the account holds. */
  const holding = (name: string): FakeDomain | undefined =>
    domains.filter((domain) => name === domain.name || name.endsWith(`.${domain.name}`)).sort((a, b) => b.name.length - a.name.length)[0];

  const relative = (name: string, domain: FakeDomain): string => (name === domain.name ? "@" : name.slice(0, -(domain.name.length + 1)));
  const absolute = (name: string, domain: FakeDomain): string => (name === "@" ? domain.name : `${name}.${domain.name}`);

  const page = <T>(url: URL, path: string, key: string, items: T[]): Response => {
    const wanted = Math.max(1, Math.min(200, Number(url.searchParams.get("per_page") ?? "20")));
    const size = Math.min(wanted, settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const last = Math.max(1, Math.ceil(items.length / size));
    const link = (number: number) => {
      const query = new URLSearchParams(url.searchParams);
      query.set("page", String(number));
      query.set("per_page", String(size));
      return `${LINK_ORIGIN}/v2${path}?${query}`;
    };
    const pages: Record<string, string> = {};
    if (current > 1) Object.assign(pages, { first: link(1), prev: link(current - 1) });
    if (current < last) Object.assign(pages, { last: link(last), next: link(current + 1) });
    return Response.json({ [key]: items.slice((current - 1) * size, current * size), links: Object.keys(pages).length === 0 ? {} : { pages }, meta: { total: items.length } });
  };

  const allowed = (...any: Scope[]): boolean => any.some((scope) => settings.scopes.has(scope));
  const forbidden = () => error(403, "forbidden", "You do not have permission to perform this action.");

  const domainView = (domain: FakeDomain) => ({ name: domain.name, ttl: domain.ttl, zone_file: `$ORIGIN ${domain.name}.\n$TTL ${domain.ttl}\n` });

  /** What a record's body may say, checked as far as the fake knows the API. */
  function invalid(input: Partial<FakeRecord>, type: string): string | null {
    if (!TYPES.has(type)) return `${String(type)} is not a valid record type`;
    if (input.ttl !== undefined && (typeof input.ttl !== "number" || input.ttl < 30)) return "TTL must be at least 30 seconds";
    if (input.data !== undefined && typeof input.data !== "string") return "data must be a string";
    if (type === "A" && input.data !== undefined && !/^\d{1,3}(\.\d{1,3}){3}$/.test(input.data)) return "data must be an IPv4 address";
    if (type === "AAAA" && input.data !== undefined && !input.data.includes(":")) return "data must be an IPv6 address";
    return null;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v2/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "bad_request", "error parsing request body");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({ method, path, search: url.search, body, headers, url: request.url });
    const answer = route(url, method, path, body, request.headers.get("authorization"));
    for (const [name, value] of Object.entries({ "ratelimit-limit": "5000", "ratelimit-remaining": "4999", "ratelimit-reset": "1792576800" })) answer.headers.set(name, value);
    return answer;
  }

  function route(url: URL, method: string, path: string, body: unknown, authorization: string | null): Response {
    if (authorization !== `Bearer ${FAKE_TOKEN}`) return error(401, "unauthorized", "Unable to authenticate you.");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return Response.json(failure.body, { status: failure.status });
    }
    const parts = path.split("/").map((part) => decodeURIComponent(part));
    const domain = parts[2] === undefined ? undefined : domains.find((candidate) => candidate.name === parts[2]);

    if (method === "GET" && path === "/domains") {
      if (!allowed("domain:read")) return forbidden();
      return page(url, path, "domains", domains.map(domainView));
    }
    if (method === "GET" && parts.length === 3 && parts[1] === "domains") {
      if (!allowed("domain:read")) return forbidden();
      return domain === undefined ? NOT_FOUND() : Response.json({ domain: domainView(domain) });
    }
    if (parts[1] !== "domains" || parts[3] !== "records" || parts.length > 5) return error(404, "not_found", `no such route in the fake: ${method} ${path}`);
    if (domain === undefined) return NOT_FOUND();

    if (method === "GET" && parts.length === 4) {
      if (!allowed("domain:read")) return forbidden();
      return page(url, path, "domain_records", domain.records);
    }
    if (method === "POST" && parts.length === 4) {
      if (!allowed("domain:create", "domain:update")) return forbidden();
      const input = (body ?? {}) as Partial<FakeRecord>;
      const type = String(input.type ?? "");
      if (typeof input.name !== "string" || input.name === "" || typeof input.data !== "string") return error(422, "unprocessable_entity", "name and data are required for this record type");
      const problem = invalid(input, type);
      if (problem !== null) return error(422, "unprocessable_entity", problem);
      const beside = domain.records.filter((record) => record.name === input.name);
      if ((type === "CNAME" && beside.length > 0) || beside.some((record) => record.type === "CNAME")) {
        return error(422, "unprocessable_entity", "CNAME records cannot share a name with other records");
      }
      const record: FakeRecord = { id: nextId++, type, name: input.name, data: input.data, priority: null, port: null, ttl: input.ttl ?? 1800, weight: null, flags: null, tag: null };
      domain.records.push(record);
      return Response.json({ domain_record: record }, { status: 201 });
    }

    const record = domain.records.find((candidate) => String(candidate.id) === parts[4]);
    if (record === undefined) return NOT_FOUND();
    if (method === "GET") return allowed("domain:read") ? Response.json({ domain_record: record }) : forbidden();
    if (method === "PATCH" || method === "PUT") {
      if (!allowed("domain:update")) return forbidden();
      const input = (body ?? {}) as Partial<FakeRecord>;
      // The record model requires the type, in a PATCH as in a PUT.
      if (typeof input.type !== "string") return error(422, "unprocessable_entity", "type is required");
      if (input.type !== record.type) return error(422, "unprocessable_entity", "the type of a record cannot be changed");
      const problem = invalid(input, record.type);
      if (problem !== null) return error(422, "unprocessable_entity", problem);
      if (typeof input.data === "string") record.data = input.data;
      if (typeof input.ttl === "number") record.ttl = input.ttl;
      if (typeof input.name === "string") record.name = input.name;
      return Response.json({ domain_record: record });
    }
    if (method === "DELETE") {
      if (!allowed("domain:delete", "domain:update")) return forbidden();
      domain.records.splice(domain.records.indexOf(record), 1);
      return new Response(null, { status: 204 });
    }
    return error(404, "not_found", `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}/v2`;

  return {
    url,
    environment: { SITESOLIDE_DNS_DIGITALOCEAN_TOKEN: FAKE_TOKEN, SITESOLIDE_DIGITALOCEAN_DNS_API: url } as Record<string, string>,
    secrets: [FAKE_TOKEN],
    zone: ZONE,
    domains,
    requests,
    settings,
    /** The requests that changed something. */
    writes(): Received[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** The next `times` requests matching answer this instead, `{"id", "message"}` unless `body` says otherwise. */
    fail(method: string, path: RegExp, status: number, body: unknown, times = 1): void {
      failures.push({ method, path, status, body, times });
    },
    addDomain(name: string): FakeDomain {
      const domain: FakeDomain = { name, ttl: 1800, records: [] };
      domains.push(domain);
      return domain;
    },
    addRecord(input: { name: string; type: string; content: string; ttl?: number }): void {
      const domain = holding(input.name);
      if (domain === undefined) throw new Error(`the fake holds no domain for ${input.name}`);
      domain.records.push({ id: nextId++, type: input.type, name: relative(input.name, domain), data: input.content, priority: null, port: null, ttl: input.ttl ?? 1800, weight: null, flags: null, tag: null });
    },
    records(): { name: string; type: string; content: string }[] {
      const domain = domains.find((candidate) => candidate.name === ZONE);
      return (domain?.records ?? []).map((record) => ({ name: absolute(record.name, domain!), type: record.type, content: record.data }));
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.scopes = new Set(["domain:read", "domain:update"]);
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as every DNS provider's offers it, for bin/tests/dns-providers.test.ts. */
export function createFake(): FakeDns {
  return createFakeDigitalOceanDns();
}
