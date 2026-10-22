/**
 * A local stand-in for Scaleway's Domains and DNS API, its DNS zones and
 * their records, on a random port of the loopback: the tests of
 * bin/cli/dns/scaleway-dns.ts never reach api.scaleway.com.
 *
 * It answers in the shapes of the API's OpenAPI document,
 * https://www.scaleway.com/en/developers/api/domains-and-dns/v2beta1/schema.yml,
 * and of the answers Scaleway's Terraform provider recorded in its tests
 * (internal/services/domain/testdata): `{"dns_zones": [...], "total_count"}`,
 * a zone as `domain` and `subdomain`, filtered by `dns_zones`; `{"records":
 * [...], "total_count"}`, a record's name relative to its zone, empty for the
 * zone itself, each with a UUID; a PATCH of `changes`, `add`, `set` or
 * `delete` by id, answering `{"records": [...]}` with what it wrote. Its
 * errors are `{"message", "type", ...}`, as the scw SDK reads them:
 * `denied_authentication` for a key it does not know, `permissions_denied`
 * with the action refused in `details`, `not_found` with the resource. A fresh
 * zone holds the NS records the recorded zones hold, which `records()` leaves
 * out.
 *
 * What the reference does not document is the fake's own, and stricter than
 * the real API may be: a TTL under 60 seconds, a record added twice, and an id
 * no record has are refused, in wordings of the fake's. Lists come back
 * `pageSize` items a page whatever `page_size` asks, two by default, so that
 * a client that reads one page fails a test. `access` makes the key's
 * application read only, or without any Domains and DNS permission; `fail()`
 * makes the next matching requests answer an error instead.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** Shaped as Scaleway's are, UUIDs; neither is anyone's. */
export const FAKE_SECRET = "7d3f9a2c-41e8-4b6d-a5c0-2e9f8b1d4c76";
export const FAKE_ORGANIZATION = "c2a8e4f1-9b3d-4e70-8f15-6a0d2c9b7e43";

export const ZONE = "test-zone.invalid";

const NAME_SERVERS = ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"];
const PROJECT = "5e9b1c7a-3d24-4f86-b0a1-8c6e2d4f9a15";
const UPDATED = "2026-10-21T10:00:00Z";

const TYPES = new Set(["A", "AAAA", "CNAME", "TXT", "SRV", "TLSA", "MX", "NS", "PTR", "CAA", "ALIAS", "LOC", "SSHFP", "HINFO", "RP", "URI", "DS", "NAPTR", "DNAME", "SVCB", "HTTPS"]);

export type FakeRecord = { id: string; name: string; type: string; data: string; ttl: number; priority: number };
export type FakeZone = { domain: string; subdomain: string; records: FakeRecord[] };
type Failure = { method: string; path: RegExp; status: number; body: Record<string, unknown>; times: number };

function error(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

const fullName = (zone: FakeZone) => (zone.subdomain === "" ? zone.domain : `${zone.subdomain}.${zone.domain}`);

export type FakeScalewayDns = ReturnType<typeof createFakeScalewayDns>;

export function createFakeScalewayDns(options: { pageSize?: number } = {}) {
  let counter = 0;
  const zones: FakeZone[] = [];
  const requests: (FakeRequest & { url: string })[] = [];
  const failures: Failure[] = [];
  const settings: { pageSize: number; access: "full" | "read" | "none" } = { pageSize: options.pageSize ?? 2, access: "full" };

  const uuid = () => `0f1e2d3c-4b5a-4987-a6b5-${String(++counter).padStart(12, "0")}`;

  function fresh(): void {
    zones.length = 0;
    for (const domain of ["a-first.invalid", ZONE, "other-zone.invalid"]) {
      zones.push({ domain, subdomain: "", records: NAME_SERVERS.map((server) => ({ id: uuid(), name: "", type: "NS", data: `${server}.`, ttl: 1800, priority: 0 })) });
    }
  }
  fresh();

  const zoneView = (zone: FakeZone) => ({
    domain: zone.domain,
    subdomain: zone.subdomain,
    ns: NAME_SERVERS,
    ns_default: NAME_SERVERS,
    ns_master: [],
    status: "active",
    message: null,
    updated_at: UPDATED,
    project_id: PROJECT,
    linked_products: [],
  });

  const recordView = (record: FakeRecord) => ({ comment: null, data: record.data, id: record.id, name: record.name, priority: record.priority, ttl: record.ttl, type: record.type, updated_at: UPDATED });

  function page<T>(url: URL, key: string, items: T[]): Response {
    const wanted = Math.max(1, Number(url.searchParams.get("page_size") ?? "20") || 20);
    const size = Math.min(wanted, settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    return Response.json({ total_count: items.length, [key]: items.slice((current - 1) * size, current * size) });
  }

  const denied = (action: string, resource: string) => error(403, { details: [{ action, resource }], message: "insufficient permissions", type: "permissions_denied" });
  const notFound = (resource: string, id: string) => error(404, { message: "resource is not found", resource, resource_id: id, type: "not_found" });
  const invalid = (argument: string, reason: string, help: string) =>
    error(400, { details: [{ argument_name: argument, reason, help_message: help }], message: "invalid argument(s)", type: "invalid_arguments" });

  /** A record of a change, checked as the fake checks it. */
  function recordOf(raw: unknown): FakeRecord | Response {
    const record = raw as { name?: unknown; type?: unknown; data?: unknown; ttl?: unknown; priority?: unknown } | null;
    if (typeof record?.name !== "string") return invalid("name", "required", "");
    if (typeof record.type !== "string" || !TYPES.has(record.type)) return invalid("type", "constraint", "unknown record type");
    if (typeof record.data !== "string" || record.data === "") return invalid("data", "required", "");
    if (typeof record.ttl !== "number" || record.ttl < 60) return invalid("ttl", "constraint", "must be at least 60");
    return { id: uuid(), name: record.name, type: record.type, data: record.data, ttl: record.ttl, priority: typeof record.priority === "number" ? record.priority : 0 };
  }

  /** The changes of a PATCH, applied in order on a copy: all of them, or none. */
  function apply(zone: FakeZone, changes: unknown): FakeRecord[] | Response {
    if (!Array.isArray(changes) || changes.length === 0) return invalid("changes", "required", "");
    const next = zone.records.map((record) => ({ ...record }));
    const written: FakeRecord[] = [];
    for (const change of changes as Record<string, unknown>[]) {
      const kinds = ["add", "set", "delete", "clear"].filter((kind) => change?.[kind] !== undefined && change?.[kind] !== null);
      if (kinds.length !== 1) return invalid("changes", "constraint", "exactly one of add, set, delete, clear");
      const kind = kinds[0]!;
      const body = change[kind] as { id?: unknown; id_fields?: unknown; records?: unknown };
      if (kind === "add" || kind === "set") {
        const records = Array.isArray(body.records) ? body.records.map(recordOf) : [];
        const refused = records.find((record): record is Response => record instanceof Response);
        if (refused !== undefined) return refused;
        if (records.length === 0) return invalid("records", "required", "");
        if (kind === "set") {
          if (typeof body.id !== "string") return invalid("id", "required", "the fake sets records by id alone");
          const index = next.findIndex((record) => record.id === body.id);
          if (index === -1) return notFound("dns_record", body.id);
          next.splice(index, 1);
        }
        for (const record of records as FakeRecord[]) {
          if (next.some((kept) => kept.name === record.name && kept.type === record.type && kept.data === record.data)) {
            return error(409, { message: "resource already exists", resource: "dns_record", resource_id: `${record.name} ${record.type} ${record.data}`, type: "conflict" });
          }
          next.push(record);
          written.push(record);
        }
      } else if (kind === "delete") {
        if (typeof body.id !== "string") return invalid("id", "required", "the fake deletes records by id alone");
        const index = next.findIndex((record) => record.id === body.id);
        if (index === -1) return notFound("dns_record", body.id);
        next.splice(index, 1);
      } else {
        return invalid("changes", "constraint", "the fake does not clear a zone");
      }
    }
    zone.records = next;
    return written;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const text = method === "GET" || method === "DELETE" ? "" : await request.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, { message: "invalid JSON", type: "invalid_request_error" });
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const path = url.pathname;
    requests.push({ method, path, search: url.search, body, headers, url: request.url });

    if (headers["x-auth-token"] !== FAKE_SECRET) return error(401, { message: "authentication is denied", method: "api_key", reason: "invalid_argument", type: "denied_authentication" });
    const failure = failures.find((candidate) => candidate.method === method && candidate.path.test(path) && candidate.times > 0);
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.body);
    }
    if (settings.access === "none") return denied("read", "dns_zone");

    if (method === "GET" && path === "/domain/v2beta1/dns-zones") {
      const wanted = url.searchParams.getAll("dns_zones");
      const domain = url.searchParams.get("domain") ?? "";
      return page(url, "dns_zones", zones.filter((zone) => (wanted.length === 0 || wanted.includes(fullName(zone))) && (domain === "" || zone.domain === domain)).map(zoneView));
    }
    const match = /^\/domain\/v2beta1\/dns-zones\/([^/]+)\/records$/.exec(path);
    if (match !== null) {
      const name = decodeURIComponent(match[1]!);
      const zone = zones.find((candidate) => fullName(candidate) === name);
      if (method === "GET") {
        if (zone === undefined) return notFound("dns_zone", name);
        const filter = url.searchParams.get("name") ?? "";
        const type = url.searchParams.get("type") ?? "";
        const id = url.searchParams.get("id") ?? "";
        const records = zone.records.filter(
          (record) => (filter === "" || record.name === filter) && (type === "" || type === "unknown" || record.type === type) && (id === "" || record.id === id),
        );
        return page(url, "records", records.map(recordView));
      }
      if (method === "PATCH") {
        if (settings.access !== "full") return denied("write", "dns_zone");
        const order = body as { changes?: unknown; disallow_new_zone_creation?: unknown } | null;
        if (zone === undefined) {
          // Without disallow_new_zone_creation, the real API may create the zone.
          return order?.disallow_new_zone_creation === true ? notFound("dns_zone", name) : invalid("disallow_new_zone_creation", "constraint", "the fake creates no zone");
        }
        const written = apply(zone, order?.changes);
        if (written instanceof Response) return written;
        return Response.json({ records: written.map(recordView) });
      }
    }
    return notFound("route", `${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const base = server.url.origin;
  const theZone = () => zones.find((zone) => fullName(zone) === ZONE)!;
  const relative = (name: string) => (name === ZONE ? "" : name.slice(0, -(ZONE.length + 1)));

  return {
    zone: ZONE,
    environment: { SITESOLIDE_DNS_SCALEWAY_SECRET_KEY: FAKE_SECRET, SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID: FAKE_ORGANIZATION, SITESOLIDE_SCALEWAY_DNS_API: base },
    secrets: [FAKE_SECRET],
    requests,
    base,
    zones,
    settings,
    addRecord(record: { name: string; type: string; content: string }, ttl = 3600): void {
      theZone().records.push({ id: uuid(), name: relative(record.name), type: record.type, data: record.content, ttl, priority: 0 });
    },
    records(): { name: string; type: string; content: string }[] {
      return theZone()
        .records.filter((record) => !(record.name === "" && record.type === "NS"))
        .map((record) => ({ name: record.name === "" ? ZONE : `${record.name}.${ZONE}`, type: record.type, content: record.data }));
    },
    /** The records of the zone as the fake keeps them, ids and TTLs included. */
    stored(): FakeRecord[] {
      return theZone().records;
    },
    writes(): (FakeRequest & { url: string })[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, body: Record<string, unknown>, times = 1): void {
      failures.push({ method, path, status, body, times });
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.access = "full";
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export function createFake(): FakeDns {
  return createFakeScalewayDns();
}
