/**
 * A local stand-in for Vultr's DNS API, its domains and their records, on a
 * random port of the loopback: the tests of bin/cli/dns/vultr-dns.ts never reach
 * api.vultr.com.
 *
 * It answers in the shapes of Vultr's OpenAPI document (published with
 * github.com/vultr/vultr-python-client, openapi-client/swagger.json) and of
 * its Go client, govultr: `{"domains": [...]}` and `{"records": [...]}` with
 * `meta.total` and the cursors `meta.links.next` and `prev`, a record's name
 * relative to its domain, empty for the domain itself, `{"record": {...}}`
 * and 201 for a record created, 204 for one updated or deleted, and
 * `{"error": "...", "status": n}` errors.
 *
 * It enforces the actions of Vultr's IAM policies,
 * https://docs.vultr.com/platform/iam/policies/iam-policy-actions-map/network-actions:
 * `network.dns.List` to list the domains, `network.dns.Read` to read their
 * records (which action a listing of records needs is not documented: this is
 * the fake's guess), `network.dns.Create`, `Update` and `Delete` to write.
 * And it refuses, as DNSControl reports Vultr does, a change that leaves the
 * records of one name and type with different TTLs.
 *
 * The wording of every error is the fake's: the reference documents none.
 * `absoluteNames` answers names in full, `foo.example.com`, as the
 * reference's own example of a listing shows them. Lists come back
 * `pageSize` items a page whatever `per_page` asks, two by default, so that a
 * client that reads one page fails a test.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** 36 uppercase letters and digits, the shape of Vultr's keys. */
export const FAKE_KEY = "VULTRDNSFAKEKEY0123456789ABCDEFGHIJK";

export const ZONE = "test-zone.invalid";

export type Action = "network.dns.List" | "network.dns.Read" | "network.dns.Create" | "network.dns.Update" | "network.dns.Delete";

export const ALL_ACTIONS: Action[] = ["network.dns.List", "network.dns.Read", "network.dns.Create", "network.dns.Update", "network.dns.Delete"];

export type FakeRecord = {
  id: string;
  type: string;
  /** Relative to its domain, empty for the domain itself. */
  name: string;
  data: string;
  priority: number;
  ttl: number;
};

export type FakeDomain = { domain: string; date_created: string; dns_sec: string; records: FakeRecord[] };

export type Received = FakeRequest & { url: string };

type Failure = { method: string; path: RegExp; status: number; body: unknown; times: number };

const TYPES = new Set(["A", "AAAA", "CNAME", "NS", "MX", "SRV", "TXT", "CAA", "SSHFP"]);

/** The domains of a fresh account: the zone on the second page of two, between others. */
const DOMAINS = ["a-first.invalid", "b-second.invalid", ZONE, "z-last.invalid"];

function error(status: number, message: string): Response {
  return Response.json({ error: message, status }, { status });
}

/** An opaque cursor, as Vultr's are: the offset of the next page. */
const cursorOf = (offset: number): string => Buffer.from(`next__${offset}`).toString("base64");
const offsetOf = (cursor: string | null): number => (cursor === null ? 0 : Number(Buffer.from(cursor, "base64").toString().replace(/^next__/, "")) || 0);

export type FakeVultrDns = ReturnType<typeof createFakeVultrDns>;

export function createFakeVultrDns(options: { pageSize?: number } = {}) {
  let nextId = 1;
  const domains: FakeDomain[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  const settings: { pageSize: number; actions: Set<Action>; absoluteNames: boolean } = { pageSize: options.pageSize ?? 2, actions: new Set(ALL_ACTIONS), absoluteNames: false };

  const fresh = (): void => {
    domains.length = 0;
    for (const domain of DOMAINS) domains.push({ domain, date_created: "2026-10-01T10:00:00+00:00", dns_sec: "disabled", records: [] });
  };
  fresh();

  const newId = (): string => `cb676a46-66fd-4dfb-b839-${String(nextId++).padStart(12, "0")}`;

  const holding = (name: string): FakeDomain | undefined =>
    domains.filter((domain) => name === domain.domain || name.endsWith(`.${domain.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0];

  const relative = (name: string, domain: FakeDomain): string => (name === domain.domain ? "" : name.slice(0, -(domain.domain.length + 1)));
  const absolute = (name: string, domain: FakeDomain): string => (name === "" ? domain.domain : `${name}.${domain.domain}`);

  const page = <T>(url: URL, key: string, items: T[]): Response => {
    const wanted = Math.max(1, Math.min(500, Number(url.searchParams.get("per_page") ?? "100")));
    const size = Math.min(wanted, settings.pageSize);
    const offset = offsetOf(url.searchParams.get("cursor"));
    const next = offset + size < items.length ? cursorOf(offset + size) : "";
    const prev = offset > 0 ? cursorOf(Math.max(0, offset - size)) : "";
    return Response.json({ [key]: items.slice(offset, offset + size), meta: { total: items.length, links: { next, prev } } });
  };

  const recordView = (record: FakeRecord, domain: FakeDomain) => ({ ...record, name: settings.absoluteNames ? absolute(record.name, domain) : record.name });

  /** Why a set of records of one name and type would be refused: TTLs that differ. */
  const mixed = (domain: FakeDomain, name: string, type: string, ttl: number, except?: FakeRecord): boolean =>
    domain.records.some((record) => record !== except && record.name === name && record.type === type && record.ttl !== ttl);

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
        return error(400, "Invalid JSON");
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
    if (authorization !== `Bearer ${FAKE_KEY}`) return error(401, "Invalid API token.");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return Response.json(failure.body, { status: failure.status });
    }
    const may = (action: Action): Response | null => (settings.actions.has(action) ? null : error(403, `Unauthorized to perform action ${action}`));
    const parts = path.split("/").map((part) => decodeURIComponent(part));
    const domain = parts[2] === undefined ? undefined : domains.find((candidate) => candidate.domain === parts[2]);

    if (method === "GET" && path === "/domains") {
      return may("network.dns.List") ?? page(url, "domains", domains.map(({ records: _, ...view }) => view));
    }
    if (parts[1] !== "domains" || parts.length < 3 || parts.length > 5 || (parts.length > 3 && parts[3] !== "records")) return error(404, `no such route in the fake: ${method} ${path}`);
    if (domain === undefined) return error(404, "Invalid domain.");
    if (method === "GET" && parts.length === 3) {
      const { records: _, ...view } = domain;
      return may("network.dns.Read") ?? Response.json({ domain: view });
    }
    if (method === "GET" && parts.length === 4) return may("network.dns.Read") ?? page(url, "records", domain.records.map((record) => recordView(record, domain)));
    if (method === "POST" && parts.length === 4) {
      const refused = may("network.dns.Create");
      if (refused !== null) return refused;
      const input = (body ?? {}) as Partial<FakeRecord>;
      const type = String(input.type ?? "");
      if (typeof input.name !== "string" || typeof input.data !== "string" || input.data === "") return error(400, "name, type and data are required");
      if (!TYPES.has(type)) return error(400, `Invalid record type ${type}`);
      if (input.ttl !== undefined && (!Number.isInteger(input.ttl) || input.ttl < 1)) return error(400, "Invalid TTL");
      if (type === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(input.data)) return error(400, "Invalid IPv4 address");
      if (type === "AAAA" && !input.data.includes(":")) return error(400, "Invalid IPv6 address");
      const beside = domain.records.filter((record) => record.name === input.name);
      if ((type === "CNAME" && beside.length > 0) || beside.some((record) => record.type === "CNAME")) return error(400, "A CNAME record cannot share its name with other records");
      const ttl = input.ttl ?? 300;
      if (mixed(domain, input.name, type, ttl)) return error(400, "All records of the same name and type must have the same TTL");
      const record: FakeRecord = { id: newId(), type, name: input.name, data: input.data, priority: input.priority ?? 0, ttl };
      domain.records.push(record);
      return Response.json({ record: recordView(record, domain) }, { status: 201 });
    }

    const record = domain.records.find((candidate) => candidate.id === parts[4]);
    if (record === undefined || parts.length !== 5) return error(404, "Invalid record.");
    if (method === "GET") return may("network.dns.Read") ?? Response.json({ record: recordView(record, domain) });
    if (method === "PATCH") {
      const refused = may("network.dns.Update");
      if (refused !== null) return refused;
      const input = (body ?? {}) as Partial<FakeRecord>;
      if (input.ttl !== undefined && (!Number.isInteger(input.ttl) || input.ttl < 1)) return error(400, "Invalid TTL");
      const name = typeof input.name === "string" ? input.name : record.name;
      const ttl = input.ttl ?? record.ttl;
      if (mixed(domain, name, record.type, ttl, record)) return error(400, "All records of the same name and type must have the same TTL");
      if (typeof input.data === "string") record.data = input.data;
      record.name = name;
      record.ttl = ttl;
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const refused = may("network.dns.Delete");
      if (refused !== null) return refused;
      domain.records.splice(domain.records.indexOf(record), 1);
      return new Response(null, { status: 204 });
    }
    return error(404, `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}/v2`;

  return {
    url,
    environment: { SITESOLIDE_DNS_VULTR_API_KEY: FAKE_KEY, SITESOLIDE_VULTR_DNS_API: url } as Record<string, string>,
    secrets: [FAKE_KEY],
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
    addRecord(input: { name: string; type: string; content: string; ttl?: number }): void {
      const domain = holding(input.name);
      if (domain === undefined) throw new Error(`the fake holds no domain for ${input.name}`);
      domain.records.push({ id: newId(), type: input.type, name: relative(input.name, domain), data: input.content, priority: 0, ttl: input.ttl ?? 300 });
    },
    records(): { name: string; type: string; content: string }[] {
      const domain = domains.find((candidate) => candidate.domain === ZONE);
      return (domain?.records ?? []).map((record) => ({ name: absolute(record.name, domain!), type: record.type, content: record.data }));
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.actions = new Set(ALL_ACTIONS);
      settings.absoluteNames = false;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as every DNS provider's offers it, for bin/tests/dns-providers.test.ts. */
export function createFake(): FakeDns {
  return createFakeVultrDns();
}
