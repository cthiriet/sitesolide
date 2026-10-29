/**
 * A local stand-in for Amazon Route 53's REST API, version 2013-04-01, on a
 * random port of the loopback: the tests of bin/cli/dns/route53.ts never
 * reach route53.amazonaws.com.
 *
 * It checks every request's Signature Version 4 against its own copy of the
 * secret, for the region `us-east-1` and the service `route53`, as AWS does,
 * so that a request signed wrong fails here as it would there. It keeps
 * hosted zones in memory, public and private, and answers the calls the
 * provider makes in the shapes of the API reference
 * (https://docs.aws.amazon.com/Route53/latest/APIReference/):
 *
 *   GET  /2013-04-01/hostedzonesbyname            ListHostedZonesByName
 *   GET  /2013-04-01/hostedzone/{Id}/rrset        ListResourceRecordSets
 *   POST /2013-04-01/hostedzone/{Id}/rrset/       ChangeResourceRecordSets
 *   GET  /2013-04-01/change/{Id}                  GetChange
 *
 * Zones and record sets are listed in Route 53's order, labels reversed, a
 * wildcard written `\052`, a page `zonePageSize` or `pageSize` items long
 * whatever `maxitems` asks, so that a client that reads only the first page
 * fails a test. A change batch is applied whole or not at all: a CREATE of a
 * set that exists, a DELETE whose values are not the current ones, elements
 * out of the order the API requires, all refused as Route 53 refuses them,
 * `<InvalidChangeBatch><Messages>` or `<ErrorResponse><Error>`. `fail()` makes
 * the next matching requests answer an error instead; `denied` and
 * `readable`/`writable` stand for the key's IAM policy, answering AccessDenied.
 */
import { parseAuthorization, signature, signingParts } from "../../clouds/src/aws-sigv4";
import { at, escapeXml, parseXml, textAt, XmlError, type XmlElement } from "../../clouds/src/aws-xml";
import { ACCESS_KEY_VARIABLE, ROUTE53_API_VARIABLE, SECRET_KEY_VARIABLE, SET_ORDER } from "../cli/dns/route53";
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "../../clouds/fakes/fake-provider";

export const FAKE_ACCESS_KEY = "AKIAFAKEROUTE53DNS01";
export const FAKE_SECRET_KEY = "fakeRoute53SecretKey0123456789abcdefgh/+";
export const FAKE_ZONE = "test-zone.invalid";
export const NAMESPACE = "https://route53.amazonaws.com/doc/2013-04-01/";
export const ACCOUNT_USER = "arn:aws:iam::111122223333:user/sitesolide-dns";

export type FakeAlias = { hostedZoneId: string; dnsName: string; evaluateTargetHealth: boolean };

/** A record set, its name absolute without the trailing dot, lowercase, `*` for the wildcard. */
export type FakeSet = {
  name: string;
  type: string;
  identifier: string | null;
  weight: number | null;
  ttl: number | null;
  values: string[];
  alias: FakeAlias | null;
  healthCheckId: string | null;
};

export type FakeZone = { id: string; name: string; private: boolean; sets: FakeSet[] };

export type Received = FakeRequest & { action: string; url: string; text: string };

type Failure = { action: string; status: number; code: string; message: string; times: number; batch: boolean };

export type FakeRoute53Settings = {
  accessKey: string;
  secretKey: string;
  /** Record sets per page of ListResourceRecordSets, whatever maxitems asks. */
  pageSize: number;
  /** Hosted zones per page of ListHostedZonesByName, whatever maxitems asks. */
  zonePageSize: number;
  /** Actions the key's policy does not allow at all. */
  denied: Set<string>;
  /** The zone IDs the key may list the records of, or null for every zone. */
  readable: Set<string> | null;
  /** The zone IDs the key may change, or null for every zone. */
  writable: Set<string> | null;
  /** The order the elements of a listed set come in: the model's, as Route 53 answers, or alphabetical, as its reference shows them. */
  responseOrder: "model" | "alphabetical";
};

const el = (name: string, value: string | number | boolean | null | undefined): string => (value === null || value === undefined ? "" : `<${name}>${escapeXml(String(value))}</${name}>`);

/** A name as Route 53 saves it: every character but a-z, 0-9, `-`, `_` and the dots as a three-digit octal escape, then the trailing dot. */
export function encodeName(name: string): string {
  return `${name.replace(/[^a-z0-9\-_.]/g, (character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`)}.`;
}

/** Any spelling, `\052.Test-Zone.invalid.` or `*.test-zone.invalid`, as the fake keeps it. */
export function canonicalName(name: string): string {
  return name
    .trim()
    .replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\.$/, "")
    .toLowerCase();
}

/** Route 53's sort key: the labels reversed, with the trailing dot, `invalid.test-zone.*.`. */
function reversed(name: string): string {
  return `${name.split(".").reverse().join(".")}.`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function setOrder(a: FakeSet, b: FakeSet): number {
  return compare(reversed(a.name), reversed(b.name)) || compare(a.type, b.type) || compare(a.identifier ?? "", b.identifier ?? "");
}

function zoneOrder(a: FakeZone, b: FakeZone): number {
  return compare(reversed(encodeName(a.name).slice(0, -1)), reversed(encodeName(b.name).slice(0, -1))) || compare(a.id, b.id);
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** A change batch's refusal, answered `<InvalidChangeBatch><Messages>`. */
    readonly batch = false,
  ) {
    super(message);
  }
}

function errorResponse(error: ApiError): Response {
  const body = error.batch
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<InvalidChangeBatch xmlns="${NAMESPACE}"><Messages><Message>${escapeXml(error.message)}</Message></Messages><RequestId>b25f48e8-84fd-11e6-80d9-example</RequestId></InvalidChangeBatch>`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<ErrorResponse xmlns="${NAMESPACE}"><Error><Type>Sender</Type><Code>${escapeXml(error.code)}</Code><Message>${escapeXml(error.message)}</Message></Error><RequestId>b25f48e8-84fd-11e6-80d9-example</RequestId></ErrorResponse>`;
  return new Response(body, { status: error.status, headers: { "Content-Type": "text/xml" } });
}

function answer(root: string, inner: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NAMESPACE}">${inner}</${root}>`, { headers: { "Content-Type": "text/xml" } });
}

function denied(action: string, resource: string): ApiError {
  return new ApiError(403, "AccessDenied", `User: ${ACCOUNT_USER} is not authorized to perform: route53:${action} on resource: ${resource} because no identity-based policy allows the route53:${action} action`);
}

function sameSet(a: FakeSet, b: FakeSet): boolean {
  const values = (set: FakeSet) => [...set.values].sort().join("\n");
  const alias = (set: FakeSet) => (set.alias === null ? "" : `${set.alias.hostedZoneId} ${canonicalName(set.alias.dnsName)} ${set.alias.evaluateTargetHealth}`);
  return a.ttl === b.ttl && a.weight === b.weight && a.healthCheckId === b.healthCheckId && values(a) === values(b) && alias(a) === alias(b);
}

function sameKey(a: FakeSet, b: FakeSet): boolean {
  return a.name === b.name && a.type === b.type && a.identifier === b.identifier;
}

export function createFakeRoute53(options: { zone?: string } = {}) {
  const zoneName = options.zone ?? FAKE_ZONE;
  let counter = 0;
  const next = () => String(++counter).padStart(8, "0");
  const zones: FakeZone[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  const settings: FakeRoute53Settings = {
    accessKey: FAKE_ACCESS_KEY,
    secretKey: FAKE_SECRET_KEY,
    pageSize: 2,
    zonePageSize: 2,
    denied: new Set(),
    readable: null,
    writable: null,
    responseOrder: "model",
  };

  function zoneSets(name: string): FakeSet[] {
    return [
      { name, type: "NS", identifier: null, weight: null, ttl: 172800, values: ["ns-1372.awsdns-43.org.", "ns-81.awsdns-10.com.", "ns-659.awsdns-18.net.", "ns-1984.awsdns-56.co.uk."], alias: null, healthCheckId: null },
      { name, type: "SOA", identifier: null, weight: null, ttl: 900, values: ["ns-1372.awsdns-43.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400"], alias: null, healthCheckId: null },
    ];
  }

  function addZone(input: { name: string; private?: boolean; id?: string }): FakeZone {
    const name = canonicalName(input.name);
    const zone: FakeZone = { id: input.id ?? `Z0FAKE${next()}ROUTE53`, name, private: input.private ?? false, sets: zoneSets(name) };
    zones.push(zone);
    return zone;
  }

  function seed(): void {
    zones.length = 0;
    counter = 0;
    addZone({ name: zoneName, id: "Z0FAKE00000001ROUTE53" });
  }
  seed();

  const main = (): FakeZone => zones.find((zone) => zone.name === canonicalName(zoneName) && !zone.private)!;

  // --- reading and writing record sets as XML -------------------------------------------------------

  function setElements(set: FakeSet): Record<string, string> {
    return {
      Name: el("Name", encodeName(set.name)),
      Type: el("Type", set.type),
      SetIdentifier: el("SetIdentifier", set.identifier),
      Weight: el("Weight", set.weight),
      TTL: el("TTL", set.ttl),
      ResourceRecords: set.alias !== null ? "" : `<ResourceRecords>${set.values.map((value) => `<ResourceRecord>${el("Value", value)}</ResourceRecord>`).join("")}</ResourceRecords>`,
      AliasTarget:
        set.alias === null ? "" : `<AliasTarget>${el("HostedZoneId", set.alias.hostedZoneId)}${el("DNSName", set.alias.dnsName)}${el("EvaluateTargetHealth", set.alias.evaluateTargetHealth)}</AliasTarget>`,
      HealthCheckId: el("HealthCheckId", set.healthCheckId),
    };
  }

  function setXml(set: FakeSet): string {
    const parts = setElements(set);
    const names = settings.responseOrder === "model" ? SET_ORDER.filter((name) => name in parts) : Object.keys(parts).sort();
    return `<ResourceRecordSet>${names.map((name) => parts[name]).join("")}</ResourceRecordSet>`;
  }

  /** A set of a request, its elements in the order the API requires, as Route 53 checks them. */
  function readSet(element: XmlElement): FakeSet {
    const known: readonly string[] = SET_ORDER;
    let last = -1;
    for (const child of element.children) {
      const index = known.indexOf(child.name);
      if (index === -1 || index < last) throw new ApiError(400, "InvalidInput", `Invalid XML ; cvc-complex-type.2.4.a: Invalid content was found starting with element '${child.name}'.`);
      last = index;
    }
    const name = textAt(element, "Name");
    const type = textAt(element, "Type");
    if (name === null || type === null) throw new ApiError(400, "InvalidInput", "Invalid request: Missing field 'Name' or 'Type' in ResourceRecordSet");
    const aliasElement = at(element, "AliasTarget");
    const alias =
      aliasElement === undefined
        ? null
        : { hostedZoneId: textAt(aliasElement, "HostedZoneId") ?? "", dnsName: textAt(aliasElement, "DNSName") ?? "", evaluateTargetHealth: textAt(aliasElement, "EvaluateTargetHealth") === "true" };
    const ttl = textAt(element, "TTL");
    const weight = textAt(element, "Weight");
    return {
      name: canonicalName(name),
      type,
      identifier: textAt(element, "SetIdentifier"),
      weight: weight === null ? null : Number(weight),
      ttl: ttl === null ? null : Number(ttl),
      values: (at(element, "ResourceRecords")?.children ?? []).filter((child) => child.name === "ResourceRecord").map((child) => at(child, "Value")?.text ?? ""),
      alias,
      healthCheckId: textAt(element, "HealthCheckId"),
    };
  }

  function described(set: FakeSet): string {
    return `[name='${encodeName(set.name)}', type='${set.type}'${set.identifier === null ? "" : `, set-identifier='${set.identifier}'`}]`;
  }

  function validate(zone: FakeZone, set: FakeSet): void {
    if (set.name !== zone.name && !set.name.endsWith(`.${zone.name}`)) {
      throw new ApiError(400, "InvalidChangeBatch", `RRSet with DNS name ${encodeName(set.name)} is not permitted in zone ${encodeName(zone.name)}`, true);
    }
    if (set.alias === null) {
      if (set.ttl === null) throw new ApiError(400, "InvalidInput", "Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found none in Change with [Action=CREATE, Name=x, Type=A, SetIdentifier=null]");
      if (set.values.length === 0 || set.values.some((value) => value === "")) throw new ApiError(400, "InvalidInput", "Invalid request: ResourceRecords must hold at least one ResourceRecord");
      if (set.type === "CNAME" && set.values.length > 1) throw new ApiError(400, "InvalidChangeBatch", `RRSet of type CNAME with DNS name ${encodeName(set.name)} is not permitted to have more than one value`, true);
      for (const value of set.values) {
        if (set.type === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) throw new ApiError(400, "InvalidChangeBatch", `ARRDATAIllegalIPv4Address (Value is not a valid IPv4 address) encountered with '${value}'`, true);
        if (set.type === "AAAA" && !value.includes(":")) throw new ApiError(400, "InvalidChangeBatch", `AAAARRDATAIllegalIPv6Address (Value is not a valid IPv6 address) encountered with '${value}'`, true);
      }
    } else if (set.ttl !== null || set.values.length > 0) {
      throw new ApiError(400, "InvalidInput", "Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found more than one");
    }
  }

  function cnameConflict(sets: FakeSet[], set: FakeSet, zone: FakeZone): void {
    const clash = sets.find((other) => other.name === set.name && other.type !== set.type && (other.type === "CNAME" || set.type === "CNAME"));
    if (clash !== undefined) {
      throw new ApiError(400, "InvalidChangeBatch", `RRSet of type ${set.type} with DNS name ${encodeName(set.name)} is not permitted because a conflicting RRSet of type ${clash.type} with the same DNS name already exists in zone ${encodeName(zone.name)}`, true);
    }
  }

  // --- the actions ---------------------------------------------------------------------------------

  function zoneById(id: string): FakeZone {
    const zone = zones.find((candidate) => candidate.id === id);
    if (zone === undefined) throw new ApiError(404, "NoSuchHostedZone", `No hosted zone found with ID: ${id}`);
    return zone;
  }

  function listHostedZonesByName(query: URLSearchParams): Response {
    const dnsname = query.get("dnsname");
    const startId = query.get("hostedzoneid");
    if (startId !== null && dnsname === null) throw new ApiError(400, "InvalidInput", "Invalid input: hostedzoneid requires dnsname");
    const maxItems = Number(query.get("maxitems") ?? "100");
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new ApiError(400, "InvalidInput", "1 validation error detected: Value at 'maxitems' failed to satisfy constraint");
    const sorted = [...zones].sort(zoneOrder);
    const startKey = dnsname === null ? null : reversed(encodeName(canonicalName(dnsname)).slice(0, -1));
    const start = startKey === null ? 0 : sorted.findIndex((zone) => {
      const key = reversed(encodeName(zone.name).slice(0, -1));
      return key > startKey || (key === startKey && (startId === null || zone.id >= startId));
    });
    const from = start === -1 ? sorted.length : start;
    const size = Math.min(maxItems, settings.zonePageSize);
    const page = sorted.slice(from, from + size);
    const following = sorted[from + size];
    const hosted = page.map(
      (zone) =>
        `<HostedZone>${el("Id", `/hostedzone/${zone.id}`)}${el("Name", encodeName(zone.name))}${el("CallerReference", `reference-${zone.id}`)}<Config>${el("Comment", "")}${el("PrivateZone", zone.private)}</Config>${el("ResourceRecordSetCount", zone.sets.length)}</HostedZone>`,
    );
    return answer(
      "ListHostedZonesByNameResponse",
      `${el("DNSName", dnsname)}${el("HostedZoneId", startId)}<HostedZones>${hosted.join("")}</HostedZones>${el("IsTruncated", following !== undefined)}${el("MaxItems", query.get("maxitems"))}${following === undefined ? "" : `${el("NextDNSName", encodeName(following.name))}${el("NextHostedZoneId", following.id)}`}`,
    );
  }

  function listResourceRecordSets(zone: FakeZone, query: URLSearchParams): Response {
    const name = query.get("name");
    const type = query.get("type");
    const identifier = query.get("identifier");
    if (type !== null && name === null) throw new ApiError(400, "InvalidInput", "The input is not valid: type requires name");
    if (identifier !== null && type === null) throw new ApiError(400, "InvalidInput", "The input is not valid: identifier requires type");
    const maxItems = Number(query.get("maxitems") ?? "300");
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 300) throw new ApiError(400, "InvalidInput", "1 validation error detected: Value at 'maxitems' failed to satisfy constraint");
    const sorted = [...zone.sets].sort(setOrder);
    const startKey = name === null ? null : reversed(canonicalName(name));
    const start =
      startKey === null
        ? 0
        : sorted.findIndex((set) => {
            const key = reversed(set.name);
            if (key !== startKey) return key > startKey;
            if (type === null || set.type > type) return true;
            return set.type === type && (identifier === null || (set.identifier ?? "") >= identifier);
          });
    const from = start === -1 ? sorted.length : start;
    const size = Math.min(maxItems, settings.pageSize);
    const page = sorted.slice(from, from + size);
    const following = sorted[from + size];
    const after = following === undefined ? "" : `${el("NextRecordName", encodeName(following.name))}${el("NextRecordType", following.type)}${el("NextRecordIdentifier", following.identifier)}`;
    return answer("ListResourceRecordSetsResponse", `<ResourceRecordSets>${page.map(setXml).join("")}</ResourceRecordSets>${el("IsTruncated", following !== undefined)}${el("MaxItems", maxItems)}${after}`);
  }

  function changeResourceRecordSets(zone: FakeZone, text: string): Response {
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
      throw new ApiError(400, "InvalidInput", `Invalid XML: ${error.message}`);
    }
    if (root.name !== "ChangeResourceRecordSetsRequest") throw new ApiError(400, "InvalidInput", `Invalid XML ; the root element is ${root.name}`);
    const changes = (at(root, "ChangeBatch", "Changes")?.children ?? []).filter((child) => child.name === "Change");
    if (changes.length === 0) throw new ApiError(400, "InvalidInput", "Invalid request: the change batch holds no change");
    const sets = zone.sets.map((set) => ({ ...set, values: [...set.values] }));
    for (const change of changes) {
      const action = textAt(change, "Action");
      const element = at(change, "ResourceRecordSet");
      if (element === undefined) throw new ApiError(400, "InvalidInput", "Invalid request: a Change without ResourceRecordSet");
      const set = readSet(element);
      validate(zone, set);
      const index = sets.findIndex((candidate) => sameKey(candidate, set));
      if (action === "CREATE") {
        if (index !== -1) throw new ApiError(400, "InvalidChangeBatch", `Tried to create resource record set ${described(set)} but it already exists`, true);
        cnameConflict(sets, set, zone);
        sets.push(set);
      } else if (action === "DELETE") {
        if (index === -1) throw new ApiError(400, "InvalidChangeBatch", `Tried to delete resource record set ${described(set)} but it was not found`, true);
        if (!sameSet(sets[index]!, set)) throw new ApiError(400, "InvalidChangeBatch", `Tried to delete resource record set ${described(set)} but the values provided do not match the current values`, true);
        sets.splice(index, 1);
      } else if (action === "UPSERT") {
        cnameConflict(sets, set, zone);
        if (index === -1) sets.push(set);
        else sets[index] = set;
      } else {
        throw new ApiError(400, "InvalidInput", `Invalid request: Action ${action ?? "(none)"} is not one of CREATE, DELETE, UPSERT`);
      }
    }
    zone.sets = sets;
    return answer("ChangeResourceRecordSetsResponse", `<ChangeInfo>${el("Id", `/change/C${next()}FAKE`)}${el("Status", "PENDING")}${el("SubmittedAt", "2026-10-21T10:00:00.000Z")}</ChangeInfo>`);
  }

  // --- the server ----------------------------------------------------------------------------------

  /** Checks the request's signature as AWS does, with the fake's copy of the secret. */
  function authenticate(request: Request, body: string): void {
    const auth = parseAuthorization(request.headers.get("authorization"));
    if (auth === null) throw new ApiError(403, "MissingAuthenticationToken", "Missing Authentication Token");
    if (auth.accessKeyId !== settings.accessKey) throw new ApiError(403, "InvalidClientTokenId", "The security token included in the request is invalid.");
    if (auth.service !== "route53" || auth.region !== "us-east-1") {
      throw new ApiError(403, "SignatureDoesNotMatch", `Credential should be scoped to a valid region and to the correct service: 'us-east-1', 'route53'.`);
    }
    const date = request.headers.get("x-amz-date") ?? "";
    if (date.length !== 16 || !auth.scope.startsWith(date.slice(0, 8))) throw new ApiError(403, "SignatureDoesNotMatch", "Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP");
    for (const required of ["host", "x-amz-date", ...(request.method === "POST" ? ["content-type"] : [])]) {
      if (!auth.signedHeaders.includes(required)) throw new ApiError(403, "SignatureDoesNotMatch", `'${required}' must be a signed header`);
    }
    const headers: Record<string, string> = {};
    for (const name of auth.signedHeaders) if (name !== "host") headers[name] = request.headers.get(name) ?? "";
    const parts = signingParts({ method: request.method, url: request.url, headers, body, region: auth.region, service: auth.service, credentials: { accessKeyId: auth.accessKeyId, secretAccessKey: settings.secretKey }, now: 0 }, date);
    if (parts.signedHeaders !== auth.signedHeaders.join(";") || signature(settings.secretKey, parts.scope, parts.stringToSign) !== auth.signature) {
      throw new ApiError(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.");
    }
  }

  function route(method: string, path: string): { action: string; zoneId: string | null } | null {
    if (method === "GET" && path === "/2013-04-01/hostedzonesbyname") return { action: "ListHostedZonesByName", zoneId: null };
    const list = /^\/2013-04-01\/hostedzone\/([^/]+)\/rrset$/.exec(path);
    if (method === "GET" && list !== null) return { action: "ListResourceRecordSets", zoneId: decodeURIComponent(list[1]!) };
    const change = /^\/2013-04-01\/hostedzone\/([^/]+)\/rrset\/$/.exec(path);
    if (method === "POST" && change !== null) return { action: "ChangeResourceRecordSets", zoneId: decodeURIComponent(change[1]!) };
    if (method === "GET" && /^\/2013-04-01\/change\/[^/]+$/.test(path)) return { action: "GetChange", zoneId: null };
    return null;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const headers = Object.fromEntries([...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]));
    const found = route(request.method, url.pathname);
    const received: Received = { method: request.method, path: url.pathname, search: url.search, url: request.url, body: text, text, headers, action: found?.action ?? "" };
    requests.push(received);
    try {
      if (found === null) throw new ApiError(404, "UnknownOperationException", `No operation at ${request.method} ${url.pathname}`);
      authenticate(request, text);
      const failure = failures.find((candidate) => candidate.times > 0 && candidate.action === found.action);
      if (failure !== undefined) {
        failure.times--;
        throw new ApiError(failure.status, failure.code, failure.message, failure.batch);
      }
      if (settings.denied.has(found.action)) throw denied(found.action, found.zoneId === null ? "*" : `arn:aws:route53:::hostedzone/${found.zoneId}`);
      switch (found.action) {
        case "ListHostedZonesByName":
          return listHostedZonesByName(url.searchParams);
        case "ListResourceRecordSets": {
          const zone = zoneById(found.zoneId!);
          if (settings.readable !== null && !settings.readable.has(zone.id)) throw denied(found.action, `arn:aws:route53:::hostedzone/${zone.id}`);
          return listResourceRecordSets(zone, url.searchParams);
        }
        case "ChangeResourceRecordSets": {
          const zone = zoneById(found.zoneId!);
          if (settings.writable !== null && !settings.writable.has(zone.id)) throw denied(found.action, `arn:aws:route53:::hostedzone/${zone.id}`);
          return changeResourceRecordSets(zone, text);
        }
        default:
          return answer("GetChangeResponse", `<ChangeInfo>${el("Id", url.pathname.slice("/2013-04-01".length))}${el("Status", "INSYNC")}${el("SubmittedAt", "2026-10-21T10:00:00.000Z")}</ChangeInfo>`);
      }
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      throw error;
    }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}`;

  return {
    url,
    zone: canonicalName(zoneName),
    zones,
    settings,
    environment: { [ACCESS_KEY_VARIABLE]: FAKE_ACCESS_KEY, [SECRET_KEY_VARIABLE]: FAKE_SECRET_KEY, [ROUTE53_API_VARIABLE]: url } as Record<string, string>,
    secrets: [FAKE_ACCESS_KEY, FAKE_SECRET_KEY],
    requests: requests as Received[],
    /** The zone of that name, public unless said otherwise. */
    addZone,
    main,
    /** Puts a record in the zone, in the simple set of its name and type, as an earlier owner left it. */
    addRecord(record: { name: string; type: string; content: string }, zone: FakeZone = main()): void {
      const name = canonicalName(record.name);
      const set = zone.sets.find((candidate) => candidate.name === name && candidate.type === record.type && candidate.identifier === null && candidate.alias === null);
      if (set !== undefined) set.values.push(record.content);
      else zone.sets.push({ name, type: record.type, identifier: null, weight: null, ttl: 300, values: [record.content], alias: null, healthCheckId: null });
    },
    /** A whole set: weighted, alias, several values. */
    addSet(set: Partial<FakeSet> & { name: string; type: string }, zone: FakeZone = main()): FakeSet {
      const made: FakeSet = { identifier: null, weight: null, ttl: set.alias ? null : 300, values: [], alias: null, healthCheckId: null, ...set, name: canonicalName(set.name) };
      zone.sets.push(made);
      return made;
    },
    /** The zone's records as they stand, one per value, an alias as `alias <target>`. */
    records(zone: FakeZone = main()): { name: string; type: string; content: string }[] {
      return [...zone.sets].sort(setOrder).flatMap((set) => (set.alias !== null ? [{ name: set.name, type: set.type, content: `alias ${canonicalName(set.alias.dnsName)}` }] : set.values.map((content) => ({ name: set.name, type: set.type, content }))));
    },
    /** The sets of a name and type, as Route 53 holds them. */
    sets(name: string, type: string, zone: FakeZone = main()): FakeSet[] {
      return zone.sets.filter((set) => set.name === canonicalName(name) && set.type === type);
    },
    /** The next `times` requests for that action answer this error instead; `batch` answers it as a change batch's refusal. */
    fail(action: string, status: number, code: string, message: string, extra: { times?: number; batch?: boolean } = {}): void {
      failures.push({ action, status, code, message, times: extra.times ?? 1, batch: extra.batch ?? false });
    },
    /** The change batches received, in order: what a test of "nothing written" reads. */
    writes(): Received[] {
      return requests.filter((request) => request.action === "ChangeResourceRecordSets");
    },
    reset(): void {
      seed();
      requests.length = 0;
      failures.length = 0;
      Object.assign(settings, { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY, pageSize: 2, zonePageSize: 2, denied: new Set(), readable: null, writable: null, responseOrder: "model" });
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export type FakeRoute53 = ReturnType<typeof createFakeRoute53>;

/** The fake as the shared test of every DNS provider takes it. */
export function createFake(): FakeDns {
  const fake = createFakeRoute53();
  return {
    zone: fake.zone,
    environment: fake.environment,
    secrets: fake.secrets,
    requests: fake.requests,
    addRecord: (record) => fake.addRecord(record),
    records: () => fake.records(),
    reset: () => fake.reset(),
    stop: () => fake.stop(),
  };
}
