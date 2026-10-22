/**
 * A local stand-in for Azure DNS, on a random port of the loopback: Microsoft
 * Entra's token endpoint and Resource Manager's Microsoft.Network/dnszones,
 * both at one address. The tests of bin/cli/dns/azure-dns.ts never reach the
 * real ones.
 *
 * It holds one subscription, one resource group and one public zone,
 * `test-zone.invalid` unless told otherwise, with the SOA and NS record sets
 * Azure creates with every zone, and answers in the shapes of Microsoft's
 * documentation (https://learn.microsoft.com/rest/api/dns/, api-version
 * 2018-05-01):
 *
 *   - the token endpoint takes the client credentials grant, the client's ID
 *     and secret in a Basic Authorization header or in the form body, and
 *     answers `{token_type, expires_in, access_token}`, or `{error,
 *     error_description, error_codes}`;
 *   - Resource Manager wants a bearer token it issued and the api-version,
 *     and answers `{"error": {"code", "message"}}` on failure. The service
 *     principal's role is on the zone alone, as the docs ask: any other zone,
 *     there or not, is 403 AuthorizationFailed, since Resource Manager checks
 *     the role before it looks. `settings.scope = "group"` gives it the
 *     resource group instead, where a missing zone is 404 ResourceNotFound;
 *   - a record set carries an ETag, which the If-Match of a PUT or a DELETE
 *     must match, and which an If-None-Match of `*` must find absent: 412
 *     PreconditionFailed otherwise. A CNAME set and another set of the same
 *     name are refused together, 409;
 *   - lists come back `pageSize` record sets a page, two by default, with a
 *     `nextLink`, so that a client that reads only the first page fails a
 *     test.
 *
 * `fail()` makes the next matching requests answer an error instead;
 * `settings.concurrentWrites` changes a record set's ETag right after it is
 * read, as somebody else writing it in between would.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

export const SUBSCRIPTION = "5d1c9e72-4a3b-4f60-9d8e-2b7a1c6f0e93";
export const TENANT = "a7e3b1c4-2d5f-4e8a-9b6c-0f1d2e3a4b5c";
export const CLIENT = "e2b4c6d8-1a3f-4b5d-8c7e-9f0a1b2c3d4e";
export const CLIENT_SECRET = "Az8Q~fake.dns-secret_0123456789abcdefWXYZ";
/** The service principal's object ID, which Resource Manager names in a refusal. */
export const OBJECT_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
export const GROUP = "dns-zones";
export const VERSION = "2018-05-01";

export const ENVIRONMENT_VARIABLES = {
  tenant: "SITESOLIDE_DNS_AZURE_TENANT_ID",
  client: "SITESOLIDE_DNS_AZURE_CLIENT_ID",
  secret: "SITESOLIDE_DNS_AZURE_CLIENT_SECRET",
  subscription: "SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID",
  group: "SITESOLIDE_DNS_AZURE_RESOURCE_GROUP",
} as const;

function jwt(subject: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ typ: "JWT", alg: "RS256", kid: "fake-key" })}.${part({ aud: "https://management.azure.com/", tid: TENANT, oid: OBJECT_ID, sub: subject, iss: "https://sts.test-zone.invalid/" })}.${Buffer.alloc(64, subject.length).toString("base64url")}`;
}

/** A record set as the fake keeps it: the type's own property (`ARecords`...) as Resource Manager shows it. */
export type FakeSet = {
  name: string;
  type: string;
  ttl: number;
  etag: string;
  metadata: Record<string, string> | null;
  values: Record<string, unknown>;
  /** The resource an alias record set takes its value from. */
  target: string | null;
};

export type Received = FakeRequest & { url: string };

type Injected = { method: string; path: RegExp; status: number; code: string; message: string; headers?: Record<string, string>; times: number };

const LISTS: Record<string, string> = { A: "ARecords", AAAA: "AAAARecords", MX: "MXRecords", NS: "NSRecords", PTR: "PTRRecords", SRV: "SRVRecords", TXT: "TXTRecords", CAA: "caaRecords" };

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function validIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

function error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export type FakeAzureDns = ReturnType<typeof createFakeAzureDns>;

export function createFakeAzureDns(options: { zone?: string; pageSize?: number } = {}) {
  const zone = options.zone ?? "test-zone.invalid";
  let serial = 1;
  const sets = new Map<string, FakeSet>();
  const requests: Received[] = [];
  const injected: Injected[] = [];
  /** The tokens the token endpoint handed out, which Resource Manager takes. */
  const issued: string[] = [];
  const revoked = new Set<string>();
  /** How many tokens were ever handed out: each one differs from every other, across resets. */
  let minted = 0;

  const defaults = () => ({
    pageSize: options.pageSize ?? 2,
    /** Where the service principal's role is: the zone alone, or the whole resource group. */
    scope: "zone" as "zone" | "group",
    /** Whether the token endpoint takes the client's secret in a Basic header; it always takes it in the form. */
    basicAccepted: true,
    /** The token endpoint's answer for the token's lifetime. */
    tokenLifetime: 3599,
    /** How many record set reads to follow with somebody else's write, which changes the set's ETag. */
    concurrentWrites: 0,
    /** A `nextLink` at another host than the API's, which no client should follow with its token. */
    foreignNextLink: false,
  });
  const settings = defaults();

  let origin = "";

  const key = (type: string, name: string) => `${type.toUpperCase()}|${name.toLowerCase()}`;
  const etag = () => `${(serial++).toString(16).padStart(8, "0")}-1a2b-4c3d-8e4f-5a6b7c8d9e0f`;
  const fqdn = (name: string) => `${name === "@" ? zone : `${name}.${zone}`}.`;
  const zoneId = `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/Microsoft.Network/dnszones/${zone}`;

  function put(set: Omit<FakeSet, "etag">): FakeSet {
    const stored = { ...set, etag: etag() };
    sets.set(key(set.type, set.name), stored);
    return stored;
  }

  /** The record sets Azure creates with a zone, which nobody else writes. */
  function seed(): void {
    sets.clear();
    put({ name: "@", type: "SOA", ttl: 3600, metadata: null, target: null, values: { SOARecord: { host: "ns1-01.azure-dns.com.", email: "azuredns-hostmaster.microsoft.com", serialNumber: 1, refreshTime: 3600, retryTime: 300, expireTime: 2419200, minimumTTL: 300 } } });
    put({
      name: "@",
      type: "NS",
      ttl: 172800,
      metadata: null,
      target: null,
      values: { NSRecords: ["ns1-01.azure-dns.com.", "ns2-01.azure-dns.net.", "ns3-01.azure-dns.org.", "ns4-01.azure-dns.info."].map((nsdname) => ({ nsdname })) },
    });
  }
  seed();

  function view(set: FakeSet) {
    return {
      id: `${zoneId}/${set.type}/${set.name}`,
      etag: set.etag,
      name: set.name,
      type: `Microsoft.Network/dnszones/${set.type}`,
      properties: {
        ...(set.metadata === null ? {} : { metadata: set.metadata }),
        TTL: set.ttl,
        fqdn: fqdn(set.name),
        ...set.values,
        ...(set.target === null ? {} : { targetResource: { id: set.target } }),
        provisioningState: "Succeeded",
      },
    };
  }

  /** A name of the zone as a record set names it. */
  function relative(name: string): string {
    const absolute = name.toLowerCase().replace(/\.$/, "");
    if (absolute === zone) return "@";
    if (absolute.endsWith(`.${zone}`)) return absolute.slice(0, -(zone.length + 1));
    throw new Error(`${name} is not in ${zone}`);
  }

  /** One value, as a person writes it, in the record set's own shape. */
  function addValue(set: Omit<FakeSet, "etag"> | FakeSet, content: string): void {
    if (set.type === "CNAME") {
      set.values = { CNAMERecord: { cname: content } };
      return;
    }
    const list = LISTS[set.type];
    if (list === undefined) throw new Error(`the fake holds no ${set.type} records`);
    const items = ((set.values[list] as unknown[] | undefined) ?? []).slice();
    if (set.type === "A") items.push({ ipv4Address: content });
    else if (set.type === "AAAA") items.push({ ipv6Address: content });
    else if (set.type === "MX") {
      const [preference = "0", exchange = ""] = content.split(" ");
      items.push({ preference: Number(preference), exchange });
    } else if (set.type === "NS") items.push({ nsdname: content });
    else if (set.type === "PTR") items.push({ ptrdname: content });
    else if (set.type === "TXT") items.push({ value: [content] });
    else if (set.type === "CAA") {
      const match = /^(\d+) (\S+) "(.*)"$/.exec(content);
      items.push({ flags: Number(match?.[1] ?? 0), tag: match?.[2] ?? "issue", value: match?.[3] ?? content });
    } else {
      const [priority = "0", weight = "0", port = "0", target = ""] = content.split(" ");
      items.push({ priority: Number(priority), weight: Number(weight), port: Number(port), target });
    }
    set.values = { [list]: items };
  }

  /** A record set's values as text, one per record. */
  function contents(set: FakeSet): string[] {
    if (set.target !== null) return [];
    if (set.type === "CNAME") return [(set.values.CNAMERecord as { cname: string }).cname];
    const items = (set.values[LISTS[set.type] ?? ""] as Record<string, unknown>[] | undefined) ?? [];
    return items.map((item) => {
      switch (set.type) {
        case "A":
          return String(item.ipv4Address);
        case "AAAA":
          return String(item.ipv6Address);
        case "MX":
          return `${item.preference} ${item.exchange}`;
        case "NS":
          return String(item.nsdname);
        case "PTR":
          return String(item.ptrdname);
        case "TXT":
          return (item.value as string[]).join("");
        case "CAA":
          return `${item.flags} ${item.tag} "${item.value}"`;
        default:
          return `${item.priority} ${item.weight} ${item.port} ${item.target}`;
      }
    });
  }

  function authorizationFailed(action: string, scope: string): Response {
    return error(
      403,
      "AuthorizationFailed",
      `The client '${CLIENT}' with object id '${OBJECT_ID}' does not have authorization to perform action '${action}' over scope '${scope}' or the scope is invalid. If access was recently granted, please refresh your credentials.`,
    );
  }

  function login(request: Request, tenant: string, body: string): Response {
    const failure = (status: number, code: string, number: number, said: string) =>
      Response.json(
        {
          error: code,
          error_description: `AADSTS${number}: ${said}\r\nTrace ID: 0000aaaa-11bb-cccc-dd22-eeeeee333333\r\nCorrelation ID: aaaa0000-bb11-2222-33cc-444444dddddd\r\nTimestamp: 2026-10-21 10:00:00Z`,
          error_codes: [number],
          timestamp: "2026-10-21 10:00:00Z",
          trace_id: "0000aaaa-11bb-cccc-dd22-eeeeee333333",
          correlation_id: "aaaa0000-bb11-2222-33cc-444444dddddd",
        },
        { status },
      );
    if (tenant !== TENANT) return failure(400, "invalid_request", 90002, `Tenant '${tenant}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    const form = new URLSearchParams(body);
    if (form.get("grant_type") !== "client_credentials") return failure(400, "unsupported_grant_type", 70003, "The app requested an unsupported grant type.");
    if (form.get("scope") !== "https://management.azure.com/.default") return failure(400, "invalid_scope", 70011, "The provided value for the input parameter 'scope' is not valid.");
    const authorization = request.headers.get("authorization") ?? "";
    let client = form.get("client_id") ?? "";
    let secret = form.get("client_secret") ?? "";
    if (authorization.startsWith("Basic ")) {
      if (!settings.basicAccepted) return failure(401, "invalid_client", 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
      const decoded = Buffer.from(authorization.slice(6), "base64").toString();
      [client = "", secret = ""] = decoded.split(":").map((part) => decodeURIComponent(part));
    } else if (secret === "") {
      return failure(401, "invalid_client", 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
    }
    if (client !== CLIENT) return failure(400, "unauthorized_client", 700016, `Application with identifier '${client}' was not found in the directory '${tenant}'.`);
    if (secret !== CLIENT_SECRET) return failure(401, "invalid_client", 7000215, "Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '" + CLIENT + "'.");
    const access = jwt(`service-principal-${++minted}-0123456789`);
    issued.push(access);
    return Response.json({ token_type: "Bearer", expires_in: settings.tokenLifetime, ext_expires_in: settings.tokenLifetime, access_token: access });
  }

  function bearer(request: Request): Response | null {
    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (presented === "") return error(401, "AuthenticationFailed", "Authentication failed. The 'Authorization' header is missing.");
    if (revoked.has(presented)) return error(401, "ExpiredAuthenticationToken", "The access token expiry UTC time '10/21/2026 9:00:00 AM' is earlier than current UTC time '10/21/2026 10:00:00 AM'.");
    if (!issued.includes(presented)) return error(401, "InvalidAuthenticationToken", "The access token is invalid.");
    return null;
  }

  /** The record sets of the zone, a page at a time, with a `nextLink` while more remain. */
  function list(url: URL): Response {
    const token = url.searchParams.get("$skipToken");
    const offset = token === null ? 0 : Number(Buffer.from(token, "base64").toString().replace(/^offset:/, ""));
    const top = Number(url.searchParams.get("$top") ?? "100");
    const size = Math.max(1, Math.min(settings.pageSize, Number.isFinite(top) && top > 0 ? top : 100));
    const all = [...sets.values()];
    const slice = all.slice(offset, offset + size);
    const next = new URL(settings.foreignNextLink ? `https://elsewhere.test-zone.invalid${url.pathname}${url.search}` : url.toString());
    next.searchParams.set("$skipToken", Buffer.from(`offset:${offset + size}`).toString("base64"));
    return Response.json({ value: slice.map(view), ...(offset + size < all.length ? { nextLink: next.toString() } : {}) });
  }

  /** A PUT's body checked as the DNS resource provider checks it; null when it is right. */
  function invalid(type: string, body: unknown): Response | null {
    const properties = (body as { properties?: Record<string, unknown> } | null)?.properties;
    if (properties === null || typeof properties !== "object") return error(400, "BadRequest", "The request body is missing the 'properties' object.");
    const ttl = properties.TTL;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > 2147483647) return error(400, "BadRequest", "The value of the TTL property must be an integer between 1 and 2147483647.");
    const own = type === "CNAME" ? "CNAMERecord" : LISTS[type];
    for (const name of [...Object.values(LISTS), "CNAMERecord", "SOARecord"]) {
      if (name !== own && properties[name] !== undefined) return error(400, "BadRequest", `The property '${name}' is not valid for a record set of type '${type}'.`);
    }
    if (type === "A") {
      const items = properties.ARecords;
      if (!Array.isArray(items) || items.some((item) => !IPV4.test(String((item as { ipv4Address?: unknown }).ipv4Address)))) return error(400, "BadRequest", "The value of ARecords is not a list of valid IPv4 addresses.");
    }
    if (type === "AAAA") {
      const items = properties.AAAARecords;
      if (!Array.isArray(items) || items.some((item) => !validIpv6(String((item as { ipv6Address?: unknown }).ipv6Address)))) return error(400, "BadRequest", "The value of AAAARecords is not a list of valid IPv6 addresses.");
    }
    if (type === "CNAME" && typeof (properties.CNAMERecord as { cname?: unknown } | undefined)?.cname !== "string") return error(400, "BadRequest", "The CNAME record set must hold one CNAME record.");
    return null;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const text = method === "GET" || method === "DELETE" ? "" : await request.text();
    let body: unknown = null;
    if (text !== "" && !(request.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")) {
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, "InvalidRequestContent", "The request content was invalid and could not be deserialized.");
      }
    } else if (text !== "") {
      body = text;
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({ method, path, search: url.search, url: request.url, body, headers });

    // --- the token endpoint, which takes no bearer
    const tokenRoute = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path);
    if (tokenRoute !== null && method === "POST") return login(request, decodeURIComponent(tokenRoute[1]!), text);

    const refused = bearer(request);
    if (refused !== null) return refused;
    const failure = injected.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(decodeURIComponent(path)));
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.code, failure.message, failure.headers);
    }

    const route = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/dnsZones\/([^/]+)(?:\/([A-Za-z]+)(?:\/([^/]+))?)?$/i.exec(path);
    if (route === null) return error(404, "NoRegisteredProviderFound", `no such route in the fake: ${method} ${path}`);
    if (url.searchParams.get("api-version") !== VERSION) {
      return error(400, "NoRegisteredProviderFound", `No registered resource provider found for location 'global' and API version '${url.searchParams.get("api-version")}' for type 'dnszones'. The supported api-versions are '2015-05-04-preview, 2016-04-01, 2017-09-01, 2017-09-15-preview, 2017-10-01, 2018-03-01-preview, 2018-05-01, 2023-07-01-preview'.`);
    }
    const subscription = decodeURIComponent(route[1]!);
    const group = decodeURIComponent(route[2]!);
    const zoneName = decodeURIComponent(route[3]!);
    const kind = route[4];
    const name = route[5] === undefined ? undefined : decodeURIComponent(route[5]);
    const type = kind?.toUpperCase();
    const action = `Microsoft.Network/dnszones${kind === undefined ? "" : type === "RECORDSETS" ? "/recordsets" : `/${type}`}/${method === "GET" ? "read" : method === "DELETE" ? "delete" : "write"}`;
    const scope = decodeURIComponent(path);

    if (subscription.toLowerCase() !== SUBSCRIPTION) return error(404, "SubscriptionNotFound", `The subscription '${subscription}' could not be found.`);
    if (group.toLowerCase() !== GROUP.toLowerCase()) {
      return settings.scope === "zone" ? authorizationFailed(action, scope) : error(404, "ResourceGroupNotFound", `Resource group '${group}' could not be found.`);
    }
    if (zoneName.toLowerCase() !== zone) {
      return settings.scope === "zone"
        ? authorizationFailed(action, scope)
        : error(404, "ResourceNotFound", `The Resource 'Microsoft.Network/dnszones/${zoneName}' under resource group '${group}' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix`);
    }

    if (kind === undefined) {
      if (method !== "GET") return error(405, "MethodNotAllowed", `The fake does not ${method} zones.`);
      return Response.json({
        id: zoneId,
        etag: "00000000-0000-0000-0000-000000000001",
        location: "global",
        name: zone,
        type: "Microsoft.Network/dnszones",
        tags: {},
        properties: { maxNumberOfRecordSets: 10000, maxNumberOfRecordsPerRecordSet: 20, numberOfRecordSets: sets.size, nameServers: ["ns1-01.azure-dns.com.", "ns2-01.azure-dns.net.", "ns3-01.azure-dns.org.", "ns4-01.azure-dns.info."], zoneType: "Public" },
      });
    }
    if (type === "RECORDSETS" && name === undefined) {
      if (method !== "GET") return error(405, "MethodNotAllowed", `The fake does not ${method} record set lists.`);
      return list(url);
    }
    if (type === undefined || name === undefined || (type !== "CNAME" && type !== "SOA" && LISTS[type] === undefined)) {
      return error(400, "BadRequest", `The record type '${kind}' is not supported.`);
    }

    const recordName = name === "@" ? "@" : name.toLowerCase();
    const found = sets.get(key(type, recordName));
    const conditions = { match: request.headers.get("if-match"), noneMatch: request.headers.get("if-none-match") };
    const precondition = () => error(412, "PreconditionFailed", `The Resource 'Microsoft.Network/dnszones/${zone}/${type}/${name}' was modified since it was read: its etag does not match the one of the If-Match header.`);

    if (method === "GET") {
      if (found === undefined) return error(404, "NotFound", `The resource record '${name}' does not exist in resource group '${GROUP}' of subscription '${SUBSCRIPTION}'.`);
      const answer = Response.json(view(found), { headers: { ETag: found.etag } });
      if (settings.concurrentWrites > 0) {
        settings.concurrentWrites--;
        found.etag = etag();
      }
      return answer;
    }

    if (method === "DELETE") {
      if (type === "SOA" || (type === "NS" && recordName === "@")) return error(400, "BadRequest", "The SOA and the zone's own NS record sets cannot be deleted.");
      if (conditions.match !== null && conditions.match !== "*" && conditions.match !== found?.etag) return precondition();
      if (found === undefined) return new Response(null, { status: 204 });
      sets.delete(key(type, recordName));
      return new Response(null, { status: 200 });
    }

    if (method === "PUT") {
      if (type === "SOA") return error(400, "BadRequest", "The fake does not write the SOA record set.");
      if (conditions.noneMatch === "*" && found !== undefined) return precondition();
      if (conditions.match !== null && conditions.match !== "*" && conditions.match !== found?.etag) return precondition();
      const refusal = invalid(type, body);
      if (refusal !== null) return refusal;
      const others = [...sets.values()].filter((set) => set.name === recordName && set.type !== type);
      if ((type === "CNAME" && others.length > 0) || (type !== "CNAME" && others.some((set) => set.type === "CNAME"))) {
        return error(409, "Conflict", `The record set '${name}' cannot be created: a CNAME record set cannot share its name with another record set.`);
      }
      const properties = (body as { properties: Record<string, unknown> }).properties;
      const own = type === "CNAME" ? "CNAMERecord" : LISTS[type]!;
      const target = (properties.targetResource as { id?: unknown } | undefined)?.id;
      const stored = put({
        name: recordName,
        type,
        ttl: properties.TTL as number,
        metadata: (properties.metadata as Record<string, string> | undefined) ?? null,
        values: properties[own] === undefined ? {} : { [own]: properties[own] },
        target: typeof target === "string" && target !== "" ? target : null,
      });
      return Response.json(view(stored), { status: found === undefined ? 201 : 200, headers: { ETag: stored.etag } });
    }

    return error(405, "MethodNotAllowed", `The fake does not ${method} record sets.`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  origin = `http://127.0.0.1:${server.port}`;

  const environment: Record<string, string> = {
    [ENVIRONMENT_VARIABLES.tenant]: TENANT,
    [ENVIRONMENT_VARIABLES.client]: CLIENT,
    [ENVIRONMENT_VARIABLES.secret]: CLIENT_SECRET,
    [ENVIRONMENT_VARIABLES.subscription]: SUBSCRIPTION,
    [ENVIRONMENT_VARIABLES.group]: GROUP,
    SITESOLIDE_AZURE_DNS_API: origin,
    SITESOLIDE_AZURE_DNS_LOGIN: origin,
  };

  const fake = {
    url: origin,
    zone,
    environment,
    secrets: [CLIENT_SECRET],
    requests,
    issued,
    settings,
    sets,
    reset(): void {
      seed();
      requests.length = 0;
      injected.length = 0;
      issued.length = 0;
      revoked.clear();
      Object.assign(settings, defaults());
    },
    stop(): void {
      server.stop(true);
    },
    /** A record of the zone, as an earlier owner left it: a value added to its record set. */
    addRecord(record: { name: string; type: string; content: string }): void {
      const name = relative(record.name);
      const type = record.type.toUpperCase();
      const found = sets.get(key(type, name));
      if (found !== undefined) {
        addValue(found, record.content);
        found.etag = etag();
        return;
      }
      const set: Omit<FakeSet, "etag"> = { name, type, ttl: 3600, metadata: null, values: {}, target: null };
      addValue(set, record.content);
      put(set);
    },
    /** An alias record set, which takes its address from another Azure resource. */
    addAlias(record: { name: string; type: "A" | "AAAA" | "CNAME"; target: string }): void {
      put({ name: relative(record.name), type: record.type, ttl: 3600, metadata: null, values: record.type === "CNAME" ? {} : { [LISTS[record.type]!]: [] }, target: record.target });
    },
    /** The zone's records as they stand, one per value; the SOA and NS Azure made with the zone left out. */
    records(): { name: string; type: string; content: string }[] {
      return [...sets.values()]
        .filter((set) => !(set.name === "@" && (set.type === "SOA" || set.type === "NS")))
        .flatMap((set) => contents(set).map((content) => ({ name: set.name === "@" ? zone : `${set.name}.${zone}`, type: set.type, content })));
    },
    /** The record set of that type and absolute name, as the fake keeps it. */
    set(type: string, name: string): FakeSet | undefined {
      return sets.get(key(type, relative(name)));
    },
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, code: string, message: string, extra: { headers?: Record<string, string>; times?: number } = {}): void {
      injected.push({ method, path, status, code, message, headers: extra.headers, times: extra.times ?? 1 });
    },
    /** Resource Manager stops taking a token it issued, as it does once the token expires. */
    expire(token: string): void {
      revoked.add(token);
    },
  };
  return fake;
}

/** The fake every DNS provider's test can run against (bin/tests/fake-dns.ts). */
export function createFake(): FakeAzureDns {
  return createFakeAzureDns();
}

// The fake satisfies what bin/tests/fake-dns.ts asks of every DNS provider's.
const _shape: () => FakeDns = createFake;
void _shape;
