/**
 * A local stand-in for Gandi's LiveDNS API v5, on a random port of the
 * loopback: the tests of bin/cli/dns/gandi.ts never reach api.gandi.net.
 *
 * It holds a few LiveDNS domains in memory, `test-zone.invalid` among them,
 * each a list of record sets, and answers the calls the provider makes in the
 * shapes of https://api.gandi.net/docs/livedns/: domains as `{fqdn,
 * domain_href, domain_records_href}`, record sets as `{rrset_name,
 * rrset_type, rrset_ttl, rrset_values, rrset_href}` with `@` for the domain
 * itself, lists cut in pages by `page` and `per_page` with `Total-Count` and
 * `Filtered-Count` headers, a POST answering 201, 200 when the same set is
 * already there and 409 when another is, a PUT 201 and a DELETE 204 without
 * a body, and TTLs outside 300 to 2592000 refused.
 *
 * Its refusals of the token are those api.gandi.net answered on 21 October
 * 2026: a 401 `{"message"}` without a token, a 403 `{"object": "HTTPForbidden",
 * "cause": "Forbidden", "code": 403, "message": "Access was denied to this
 * resource."}` for a token it does not know. The 404, 409 and 400 bodies follow
 * the documented error fields, `code`, `message`, `object`, `cause` and, on a
 * 400, `errors`; their messages are the fake's guess.
 *
 * Lists come back `pageSize` items a page whatever `per_page` asks, two by
 * default, so that a client that reads only the first page fails a test.
 * `fail()` makes the next matching request answer something else instead.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** Forty hexadecimal digits, the shape of the token in Gandi's own example. */
export const FAKE_TOKEN = "0123456789abcdef0123456789abcdef01234567";
export const ZONE = "test-zone.invalid";

/** The domains the token reaches besides the zone: the zone's is not on the first page. */
export const OTHER_DOMAINS = ["alpha-zone.invalid", "beta-zone.invalid", "omega-zone.invalid"];

/** A record set as the fake keeps it: its name relative to the domain, lowercase. */
export type FakeSet = { name: string; type: string; ttl: number; values: string[] };
type FakeDomain = { fqdn: string; sets: FakeSet[] };
export type Received = FakeRequest & { url: string; authorization: string | null };
type Failure = { method: string; path: RegExp; status: number; body?: unknown; raw?: string; times: number };

/** What every LiveDNS domain holds from its creation: its three name servers. */
function nameServers(): FakeSet {
  return { name: "@", type: "NS", ttl: 10800, values: ["ns-151-a.gandi.net.", "ns-193-b.gandi.net.", "ns-165-c.gandi.net."] };
}

function failure(status: number, message: string, object: string, cause: string, errors?: { location: string; name: string; description: string }[]): Response {
  return Response.json({ code: status, message, object, cause, ...(errors === undefined ? {} : { errors }) }, { status });
}

const NOT_FOUND = () => failure(404, "The resource could not be found.", "HTTPNotFound", "Not Found");
const FORBIDDEN = () => failure(403, "Access was denied to this resource.", "HTTPForbidden", "Forbidden");

export type FakeGandi = ReturnType<typeof createFakeGandi>;

export function createFakeGandi(options: { pageSize?: number } = {}) {
  const domains: FakeDomain[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  /**
   * `pageSize`: the items of a page at most; `totalCount`: whether lists carry
   * the Total-Count header; `readOnly`: every write answers 403, as to a token
   * without the permission; `crossOrganization`: every records path answers
   * 404, as Gandi does for a domain of another organization than the token
   * user's default one, by libdns/gandi's account.
   */
  const settings = { pageSize: options.pageSize ?? 2, totalCount: true, readOnly: false, crossOrganization: false };

  function seed(): void {
    domains.length = 0;
    for (const fqdn of [OTHER_DOMAINS[0]!, OTHER_DOMAINS[1]!, ZONE, OTHER_DOMAINS[2]!]) domains.push({ fqdn, sets: [nameServers()] });
  }
  seed();

  const zoneOf = () => domains.find((domain) => domain.fqdn === ZONE)!;

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const base = `http://127.0.0.1:${server.port}/v5`;

  const domainJson = (domain: FakeDomain) => ({
    fqdn: domain.fqdn,
    domain_href: `${base}/livedns/domains/${domain.fqdn}`,
    domain_records_href: `${base}/livedns/domains/${domain.fqdn}/records`,
  });
  const setJson = (domain: FakeDomain, set: FakeSet) => ({
    rrset_name: set.name,
    rrset_type: set.type,
    rrset_ttl: set.ttl,
    rrset_values: [...set.values],
    rrset_href: `${base}/livedns/domains/${domain.fqdn}/records/${set.name}/${set.type}`,
  });

  /** A page of a list, `page` and `per_page` as the API reads them, the counts in headers. */
  function page<T>(url: URL, items: T[]): Response {
    const number = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const wanted = Math.max(1, Number(url.searchParams.get("per_page") ?? "100") || 100);
    const size = Math.min(wanted, settings.pageSize);
    const slice = items.slice((number - 1) * size, number * size);
    const headers: Record<string, string> = settings.totalCount ? { "Total-Count": String(items.length), "Filtered-Count": String(slice.length) } : {};
    return Response.json(slice, { headers });
  }

  /** The body of a write: `rrset_values` a list of strings, `rrset_ttl` in range. */
  function validated(body: unknown): { values: string[]; ttl: number } | Response {
    const fields = (body ?? {}) as { rrset_values?: unknown; rrset_ttl?: unknown };
    const values = fields.rrset_values;
    if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string" && value !== "")) {
      return failure(400, "Bad Request", "HTTPBadRequest", "Bad Request", [{ location: "body", name: "rrset_values", description: "Required and must be a non-empty list of strings" }]);
    }
    const ttl = fields.rrset_ttl === undefined ? 10800 : fields.rrset_ttl;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 300 || ttl > 2592000) {
      return failure(400, "Bad Request", "HTTPBadRequest", "Bad Request", [{ location: "body", name: "rrset_ttl", description: "Must be between 300 and 2592000" }]);
    }
    return { values: [...new Set(values as string[])], ttl };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v5/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return failure(400, "Bad Request", "HTTPBadRequest", "Invalid JSON");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    const authorization = request.headers.get("authorization");
    requests.push({ method, path, search: url.search, url: request.url, authorization, body, headers });

    if (authorization === null || /^(Bearer)?\s*$/.test(authorization)) {
      return Response.json({ message: "You must provide an access token or an API Key. See https://api.gandi.net/docs/authentication/" }, { status: 401 });
    }
    if (authorization !== `Bearer ${FAKE_TOKEN}`) return FORBIDDEN();

    const scripted = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (scripted !== undefined) {
      scripted.times--;
      if (scripted.raw !== undefined) return new Response(scripted.raw, { status: scripted.status, headers: { "Content-Type": "text/html" } });
      return Response.json(scripted.body ?? {}, { status: scripted.status });
    }
    return route(method, path, url, body);
  }

  function route(method: string, path: string, url: URL, body: unknown): Response {
    const parts = path.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part));
    if (parts[0] !== "livedns" || parts[1] !== "domains") return NOT_FOUND();
    if (parts.length === 2) return method === "GET" ? page(url, domains.map(domainJson)) : failure(405, "Method Not Allowed", "HTTPMethodNotAllowed", "Method Not Allowed");

    const domain = domains.find((candidate) => candidate.fqdn === parts[2]!.toLowerCase());
    if (domain === undefined) return NOT_FOUND();
    if (parts.length === 3) return method === "GET" ? Response.json({ ...domainJson(domain), automatic_snapshots: true, domain_keys_href: `${base}/livedns/domains/${domain.fqdn}/keys` }) : NOT_FOUND();
    if (parts[3] !== "records") return NOT_FOUND();
    if (settings.crossOrganization) return NOT_FOUND();

    const sorted = () => [...domain.sets].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
    if (parts.length === 4) {
      if (method !== "GET") return failure(405, "Method Not Allowed", "HTTPMethodNotAllowed", "Method Not Allowed");
      const type = url.searchParams.get("rrset_type");
      return page(url, sorted().filter((set) => type === null || set.type === type).map((set) => setJson(domain, set)));
    }
    const name = parts[4]!.toLowerCase();
    if (parts.length === 5) {
      if (method !== "GET") return failure(405, "Method Not Allowed", "HTTPMethodNotAllowed", "Method Not Allowed");
      return Response.json(sorted().filter((set) => set.name === name).map((set) => setJson(domain, set)));
    }
    if (parts.length !== 6) return NOT_FOUND();
    const type = parts[5]!.toUpperCase();
    const index = domain.sets.findIndex((set) => set.name === name && set.type === type);
    const set = index === -1 ? undefined : domain.sets[index]!;

    if (method === "GET") return set === undefined ? NOT_FOUND() : Response.json(setJson(domain, set));
    if (settings.readOnly) return FORBIDDEN();
    if (method === "POST" || method === "PUT") {
      const fields = validated(body);
      if (fields instanceof Response) return fields;
      if (method === "POST" && set !== undefined) {
        const same = set.values.length === fields.values.length && set.values.every((value) => fields.values.includes(value));
        if (same) return Response.json({ message: "DNS Record already exists with same value" }, { status: 200 });
        return failure(409, "A DNS Record already exists with that name and type", "HTTPConflict", "Conflict");
      }
      if (set === undefined) domain.sets.push({ name, type, ttl: fields.ttl, values: fields.values });
      else Object.assign(set, { ttl: fields.ttl, values: fields.values });
      return Response.json({ message: "DNS Record Created" }, { status: 201, headers: { Location: `${base}/livedns/domains/${domain.fqdn}/records/${name}/${type}` } });
    }
    if (method === "DELETE") {
      if (set === undefined) return NOT_FOUND();
      domain.sets.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return failure(405, "Method Not Allowed", "HTTPMethodNotAllowed", "Method Not Allowed");
  }

  /** A name of the zone, relative as the fake keeps it. */
  function relative(name: string): string {
    const lowered = name.toLowerCase();
    if (lowered === ZONE) return "@";
    if (!lowered.endsWith(`.${ZONE}`)) throw new Error(`${name} is not a name of ${ZONE}`);
    return lowered.slice(0, -(ZONE.length + 1));
  }

  return {
    url: base,
    zone: ZONE,
    environment: { SITESOLIDE_DNS_GANDI_TOKEN: FAKE_TOKEN, SITESOLIDE_GANDI_DNS_API: base } as Record<string, string>,
    secrets: [FAKE_TOKEN],
    requests,
    settings,
    domains,
    /** The requests that changed something. */
    writes(): Received[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** Puts a value in the zone, in the set of its name and type, as an earlier owner left it. */
    addRecord(record: { name: string; type: string; content: string; ttl?: number }): void {
      const name = relative(record.name);
      const set = zoneOf().sets.find((candidate) => candidate.name === name && candidate.type === record.type);
      if (set === undefined) zoneOf().sets.push({ name, type: record.type, ttl: record.ttl ?? 10800, values: [record.content] });
      else if (!set.values.includes(record.content)) set.values.push(record.content);
    },
    /** The zone's records, one per value, names absolute. */
    records(): { name: string; type: string; content: string }[] {
      return zoneOf().sets.flatMap((set) => set.values.map((content) => ({ name: set.name === "@" ? ZONE : `${set.name}.${ZONE}`, type: set.type, content })));
    },
    /** The zone's set of that absolute name and type, as the fake holds it. */
    set(name: string, type: string): FakeSet | undefined {
      return zoneOf().sets.find((candidate) => candidate.name === relative(name) && candidate.type === type);
    },
    /** The next `times` requests matching answer this instead: a JSON body, or `raw` text. */
    fail(method: string, path: RegExp, status: number, answer: { body?: unknown; raw?: string; times?: number }): void {
      failures.push({ method, path, status, body: answer.body, raw: answer.raw, times: answer.times ?? 1 });
    },
    reset(): void {
      seed();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.totalCount = true;
      settings.readOnly = false;
      settings.crossOrganization = false;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as bin/tests/dns-providers.test.ts runs every provider's. */
export function createFake(): FakeDns {
  return createFakeGandi();
}
