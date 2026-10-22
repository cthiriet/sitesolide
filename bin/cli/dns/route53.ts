/**
 * Amazon Route 53, through its REST API, version 2013-04-01: XML bodies to
 * `https://route53.amazonaws.com`, signed with Signature Version 4 for the
 * region `us-east-1` and the service `route53` (../providers/aws-sigv4.ts),
 * answered in XML (../providers/aws-xml.ts). No SDK and no `aws` binary.
 * https://docs.aws.amazon.com/Route53/latest/APIReference/
 *
 * Three calls, and only those, which the key's policy in docs/dns/route53.md
 * allows along with what Caddy's module asks:
 *
 *   ListHostedZonesByName      the public hosted zone that holds the zone,
 *                              itself or a parent; a private one is never used
 *   ListResourceRecordSets     the record sets of one name, every type
 *   ChangeResourceRecordSets   one change batch per record changed
 *
 * GetChange is not called: setup does not wait for a change to reach every
 * Route 53 server, the records propagate while the machine installs.
 *
 * ROUTE 53 GROUPS VALUES IN SETS: one name, one type, and a set identifier
 * under a routing policy other than simple, hold every value. The interface
 * of dns.ts speaks of records, one value each: a set of three values is three
 * DnsRecords, whose `id` names the set and the value. An alias set, which
 * holds no value but answers for an AWS resource, is one record whose content
 * says so, `alias d111111abcdef8.cloudfront.net`: it never matches the
 * machine's address, so setup refuses it unless told to replace it.
 *
 * A record is changed by changing its set, and the set is read again just
 * before, since a plan's earlier steps may have changed it: Route 53 lists
 * the most current version of the records, those still PENDING included.
 * Changing one value, or removing one of several, is a batch that DELETEs the
 * set as it was read and CREATEs it as it must be; removing the last is a
 * DELETE alone; a new record is a CREATE. A batch is transactional, and a
 * DELETE must name the set's exact current values: a set someone changed
 * since it was read makes Route 53 refuse the whole batch rather than
 * overwrite it, which UPSERT would do. Every other value of the set, its TTL,
 * its routing policy and its health check are kept as they were.
 *
 * Names are absolute without the trailing dot, lowercase, `*` for the
 * wildcard, which Route 53 answers as the octal escape `\052`: decodeName
 * turns its spelling into ours. The elements of a set are written in the
 * order the API requires.
 *
 * THE CREDENTIALS ARE THEIR OWN: SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID and
 * SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY, never AWS_ACCESS_KEY_ID, the key
 * that may order machines. They are laid on the machine for Caddy's renewals,
 * so they must be an IAM user's long-term key whose policy reaches this
 * zone's records and nothing else (docs/dns/route53.md). The access key ID
 * travels in the Authorization header, as SigV4 requires, the secret only as
 * an HMAC there; neither is ever in a URL, and both are scrubbed from whatever
 * text comes back from outside. `SITESOLIDE_ROUTE53_DNS_API` points the module
 * at another address, a local fake in the tests.
 */
import { signRequest, uriEncode, type AwsCredentials } from "../providers/aws-sigv4";
import { at, escapeXml, parseXml, textAt, XmlError, type XmlElement } from "../providers/aws-xml";
import { apiAddress, type Clock, type Fetch } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsFailure, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const ACCESS_KEY_VARIABLE = "SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID";
export const SECRET_KEY_VARIABLE = "SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY";

export const ROUTE53_API_VARIABLE = "SITESOLIDE_ROUTE53_DNS_API";
export const DEFAULT_ROUTE53_API = "https://route53.amazonaws.com";

export const API_VERSION = "2013-04-01";
export const XML_NAMESPACE = "https://route53.amazonaws.com/doc/2013-04-01/";

/** Route 53 is global; its requests are signed for this region. */
export const SIGNING_REGION = "us-east-1";
export const SIGNING_SERVICE = "route53";

/** What a set created or pointed at the machine lives: Route 53 has no "auto", and five minutes is what its console proposes. */
export const TTL = 300;

const DOCS = "docs/dns/route53.md";

/**
 * An IAM user's long-term access key: AKIA, then 16 characters for every key
 * AWS issues today. A temporary key, ASIA, expires within hours and needs a
 * session token: it could not renew a certificate in two months.
 */
const ACCESS_KEY_SHAPE = /^AKIA[A-Z0-9]{12,124}$/;
const SECRET_KEY_SHAPE = /^[A-Za-z0-9/+=]{16,128}$/;

/** A hosted zone's ID as the API writes it after `/hostedzone/`, and nothing a path could be made to say. */
const ZONE_ID_SHAPE = /^[A-Z0-9]{1,32}$/;

/** How long a call keeps retrying what Route 53 says to retry, and the first wait. */
export const RETRY = { deadlineMs: 60_000, firstMs: 1_000, longestMs: 8_000 };

/** A listing that never ends stops here rather than looping. */
const MAX_PAGES = 100;

/**
 * The elements of a ResourceRecordSet in the order the API requires them in
 * a request, which is the order of its model
 * (https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html:
 * "The XML elements in your request must appear in the order listed").
 */
export const SET_ORDER = [
  "Name",
  "Type",
  "SetIdentifier",
  "Weight",
  "Region",
  "GeoLocation",
  "Failover",
  "MultiValueAnswer",
  "TTL",
  "ResourceRecords",
  "AliasTarget",
  "HealthCheckId",
  "TrafficPolicyInstanceId",
  "CidrRoutingConfig",
  "GeoProximityLocation",
] as const;

/** The codes that say the credentials themselves are refused, whatever was asked. */
const CREDENTIAL_CODES = new Set([
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "MissingAuthenticationToken",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "ExpiredToken",
  "RequestExpired",
  "AuthFailure",
]);

/** The codes that mean "not now", the request rejected before anything was applied: retried, writes included. */
const RETRIED = new Set(["Throttling", "ThrottlingException", "PriorRequestNotComplete", "RequestLimitExceeded"]);

/** What a failure on AWS's side says: retried on a read only, since a write's outcome is then unknown. */
const LATER = new Set(["ServiceUnavailable", "InternalFailure", "InternalError", "ServiceFailure"]);

/**
 * A name as Route 53 writes it, `\052.Example.com.`, as the rest of
 * sitesolide does: `*.example.com`. Every octal escape is decoded, though
 * only the wildcard's is expected in a zone setup touches.
 */
export function decodeName(name: string): string {
  return name
    .trim()
    .replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\.$/, "")
    .toLowerCase();
}

/** A record set as read, its element kept to be written back exactly. */
type RecordSet = {
  element: XmlElement;
  name: string;
  type: string;
  identifier: string | null;
  values: string[];
  /** The alias's target, decoded, for an alias set; null otherwise. */
  alias: string | null;
  ttl: number;
};

/** What a record's id carries: its set, and its value there, null for an alias. */
type RecordKey = { name: string; type: string; set: string | null; value: string | null };

function recordId(key: RecordKey): string {
  return JSON.stringify([key.name, key.type, key.set, key.value]);
}

function parseRecordId(id: string): RecordKey | null {
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [name, type, set, value] = parsed as unknown[];
    if (typeof name !== "string" || typeof type !== "string") return null;
    if (set !== null && typeof set !== "string") return null;
    if (value !== null && typeof value !== "string") return null;
    return { name, type, set, value };
  } catch {
    return null;
  }
}

/** An element written back as it was read: a leaf's text exactly, a container's children in their order. */
function xmlOf(element: XmlElement): string {
  if (element.children.length === 0) return `<${element.name}>${escapeXml(element.text)}</${element.name}>`;
  return `<${element.name}>${element.children.map(xmlOf).join("")}</${element.name}>`;
}

function valuesXml(values: readonly string[]): string {
  return `<ResourceRecords>${values.map((value) => `<ResourceRecord><Value>${escapeXml(value)}</Value></ResourceRecord>`).join("")}</ResourceRecords>`;
}

type Replaced = Partial<Record<(typeof SET_ORDER)[number], string | null>>;

/**
 * A set's element in the order a request requires, with some of its
 * elements replaced (null removes one). An element the API added after this
 * file was written goes last, rather than being dropped: a DELETE must name
 * everything the set holds.
 */
function setXml(set: RecordSet, replaced: Replaced = {}): string {
  const known = new Set<string>(SET_ORDER);
  const parts: string[] = [];
  for (const name of SET_ORDER) {
    if (name in replaced) {
      const value = replaced[name];
      if (value !== null && value !== undefined) parts.push(value);
      continue;
    }
    const child = set.element.children.find((candidate) => candidate.name === name);
    if (child !== undefined) parts.push(xmlOf(child));
  }
  for (const child of set.element.children) if (!known.has(child.name)) parts.push(xmlOf(child));
  return `<ResourceRecordSet>${parts.join("")}</ResourceRecordSet>`;
}

/** A new simple set: one value, TTL 300. */
function newSetXml(name: string, type: string, values: readonly string[]): string {
  return `<ResourceRecordSet><Name>${escapeXml(`${name}.`)}</Name><Type>${escapeXml(type)}</Type><TTL>${TTL}</TTL>${valuesXml(values)}</ResourceRecordSet>`;
}

function batchXml(changes: readonly { action: "CREATE" | "DELETE"; set: string }[]): string {
  const body = changes.map((change) => `<Change><Action>${change.action}</Action>${change.set}</Change>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ChangeResourceRecordSetsRequest xmlns="${XML_NAMESPACE}"><ChangeBatch><Changes>${body}</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
}

/**
 * A message from outside cut to what a person reads, between two words,
 * never inside one, so that nothing token-like is printed in half where the
 * scrubber would not recognise it.
 */
function short(said: string): string {
  const flat = said.replace(/\s+/g, " ").trim();
  if (flat.length <= 400) return flat;
  const cut = flat.slice(0, 401).search(/\s\S*$/);
  return cut > 0 ? `${flat.slice(0, cut)} ...` : "(a message too long to show)";
}

type Call = { method: "GET" | "POST"; path: string; query?: [string, string][]; body?: string; what: string; denied: DnsFailure };

export function route53(context: DnsContext): ZoneApi {
  const credentials: AwsCredentials = {
    accessKeyId: context.credentials[ACCESS_KEY_VARIABLE] ?? "",
    secretAccessKey: context.credentials[SECRET_KEY_VARIABLE] ?? "",
  };
  const fetcher: Fetch = context.fetcher;
  const clock: Clock = context.clock;
  // Checked once, before any call: a wrong override fails here, not mid-run.
  const base = apiAddress(context.environment, ROUTE53_API_VARIABLE, DEFAULT_ROUTE53_API);
  const host = new URL(base).host;

  /** Both credentials, wherever a text from outside might carry them: replaced. */
  function scrub(text: string): string {
    let clean = text;
    if (credentials.secretAccessKey !== "") clean = clean.replaceAll(credentials.secretAccessKey, "[secret access key]");
    if (credentials.accessKeyId !== "") clean = clean.replaceAll(credentials.accessKeyId, "[access key ID]");
    return clean;
  }

  function refusal(status: number, code: string, said: string, request: Call, retried: boolean): DnsError {
    const answer = `${status}${code === "" ? "" : ` ${code}`}`;
    const text = scrub(short(said || `answered ${status}`));
    if (CREDENTIAL_CODES.has(code) || status === 401) {
      const details =
        code === "InvalidClientTokenId" || code === "UnrecognizedClientException"
          ? [`AWS knows no active key of that ID: check ${ACCESS_KEY_VARIABLE}, the key may have been deleted or made inactive`]
          : code === "SignatureDoesNotMatch" || code === "InvalidSignatureException" || code === "IncompleteSignature"
            ? [`the secret access key does not go with the access key ID: check ${SECRET_KEY_VARIABLE}`, "AWS also refuses a request signed by a workstation whose clock is more than five minutes off"]
            : code === "RequestExpired"
              ? ["AWS refuses a request dated more than five minutes away from its own clock: check this workstation's clock"]
              : [];
      return new DnsError(scrub(`AWS refused the Route 53 credentials (${answer}): ${text}`), "token", [...details, `make a key as ${DOCS} says`]);
    }
    if (status === 403) {
      return new DnsError(scrub(`the access key may not ${request.what} (${answer}): ${text}`), request.denied, [`its policy is the one of ${DOCS}, with this zone's hosted zone ID and names in it`]);
    }
    const later = retried ? [`Route 53 kept answering ${code || status} for ${RETRY.deadlineMs / 1000} seconds: run the same command again`] : [];
    const theirs = status >= 500 && !retried ? ["the failure is on AWS's side: run the same command again, it reads the zone afresh"] : [];
    return new DnsError(scrub(`Route 53 refused to ${request.what} (${answer}): ${text}`), "refused", [...later, ...theirs]);
  }

  /** One call: signed, XML back, retried while Route 53 says "later" and the deadline allows. */
  async function call(request: Call): Promise<XmlElement> {
    const search = (request.query ?? []).map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");
    const url = `${base}${request.path}${search === "" ? "" : `?${search}`}`;
    const body = request.body ?? "";
    const headers: Record<string, string> = request.method === "POST" ? { "Content-Type": "application/xml" } : {};
    const deadline = clock.now() + RETRY.deadlineMs;
    let wait = RETRY.firstMs;
    for (;;) {
      const signed = signRequest({ method: request.method, url, headers, body, region: SIGNING_REGION, service: SIGNING_SERVICE, credentials, now: clock.now() });
      let response: Response;
      try {
        response = await fetcher(url, {
          method: request.method,
          // The signature follows no address an answer names.
          redirect: "error",
          headers: { ...headers, ...signed },
          ...(request.method === "POST" ? { body } : {}),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new DnsError(scrub(`cannot reach ${host} to ${request.what}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
      }
      const text = await response.text().catch(() => "");
      let root: XmlElement | null = null;
      try {
        root = parseXml(text);
      } catch (error) {
        if (!(error instanceof XmlError)) throw error;
      }
      if (response.ok) {
        if (root === null) throw new DnsError(`${host} answered ${response.status} with something that is not Route 53's API, asked to ${request.what}`, "unreachable");
        return root;
      }

      // `<ErrorResponse><Error><Code>` for every error but a change batch's,
      // `<InvalidChangeBatch><Messages><Message>`.
      let code: string | null = null;
      let said = "";
      if (root?.name === "InvalidChangeBatch") {
        code = "InvalidChangeBatch";
        said = (at(root, "Messages")?.children ?? []).filter((child) => child.name === "Message").map((child) => child.text.trim()).join("; ") || (textAt(root, "Message") ?? "");
      } else if (root !== null) {
        const error = root.name === "ErrorResponse" ? at(root, "Error") : root.name === "Error" ? root : undefined;
        code = textAt(error, "Code");
        said = textAt(error, "Message") ?? "";
      }
      const status = response.status;
      const transient = (code !== null && RETRIED.has(code)) || status === 429 || (request.method === "GET" && (status >= 500 || (code !== null && LATER.has(code))));
      if (transient && clock.now() + wait <= deadline) {
        await clock.sleep(wait);
        wait = Math.min(wait * 2, RETRY.longestMs);
        continue;
      }
      if (code === null && status < 500 && status !== 429) {
        throw new DnsError(`${host} answered ${status} with something that is not Route 53's API, asked to ${request.what}`, "unreachable");
      }
      throw refusal(status, code ?? "", said, request, transient);
    }
  }

  function expect(root: XmlElement, name: string, request: Call): XmlElement {
    if (root.name !== name) throw new DnsError(`${host} answered with something that is not Route 53's answer, asked to ${request.what}`, "unreachable");
    return root;
  }

  function readSet(element: XmlElement, request: Call): RecordSet {
    const name = textAt(element, "Name");
    const type = textAt(element, "Type");
    if (name === null || type === null) throw new DnsError(`${host} listed a record set without a name or a type, asked to ${request.what}`, "unreachable");
    const target = textAt(element, "AliasTarget", "DNSName");
    const values = (at(element, "ResourceRecords")?.children ?? [])
      .filter((child) => child.name === "ResourceRecord")
      .map((child) => textAt(child, "Value"))
      .filter((value): value is string => value !== null);
    return {
      element,
      name: decodeName(name),
      type: type.toUpperCase(),
      identifier: textAt(element, "SetIdentifier"),
      values,
      alias: target === null ? null : decodeName(target),
      ttl: Number(textAt(element, "TTL") ?? "0") || 0,
    };
  }

  /**
   * The record sets of exactly that name, every page of them. Route 53 lists
   * a zone's sets in order, its labels reversed, from the name asked: the
   * sets of that name come first, and the listing goes on only while the
   * next page still starts at it. Sets of other names on a page are left out.
   */
  async function readSets(zone: ZoneRef, name: string): Promise<RecordSet[]> {
    const zoneId = checkedId(zone);
    const wanted = decodeName(name);
    const sets: RecordSet[] = [];
    const seen = new Set<string>();
    let query: [string, string][] = [["name", `${wanted}.`], ["maxitems", "100"]];
    for (let page = 0; page < MAX_PAGES; page++) {
      const request: Call = { method: "GET", path: `/${API_VERSION}/hostedzone/${zoneId}/rrset`, query, what: `read the records of ${wanted} in the hosted zone ${zone.name}`, denied: "zone" };
      const root = expect(await call(request), "ListResourceRecordSetsResponse", request);
      for (const element of at(root, "ResourceRecordSets")?.children ?? []) {
        if (element.name !== "ResourceRecordSet") continue;
        const set = readSet(element, request);
        if (set.name === wanted) sets.push(set);
      }
      const nextName = textAt(root, "NextRecordName");
      if (textAt(root, "IsTruncated") !== "true" || nextName === null || decodeName(nextName) !== wanted) return sets;
      const nextType = textAt(root, "NextRecordType");
      const nextIdentifier = textAt(root, "NextRecordIdentifier");
      const position = JSON.stringify([nextName, nextType, nextIdentifier]);
      if (seen.has(position)) throw new DnsError(`Route 53 answered the same page twice, asked to ${request.what}`, "unreachable");
      seen.add(position);
      query = [
        ["name", nextName],
        ...(nextType === null ? [] : [["type", nextType] as [string, string]]),
        ...(nextIdentifier === null ? [] : [["identifier", nextIdentifier] as [string, string]]),
        ["maxitems", "100"],
      ];
    }
    throw new DnsError(`the records of ${wanted} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  /** The hosted zones of exactly that name, private ones included, in the order Route 53 lists them. */
  async function zonesNamed(name: string): Promise<{ id: string; private: boolean }[]> {
    const found: { id: string; private: boolean }[] = [];
    const seen = new Set<string>();
    let query: [string, string][] = [["dnsname", `${name}.`], ["maxitems", "100"]];
    for (let page = 0; page < MAX_PAGES; page++) {
      const request: Call = { method: "GET", path: `/${API_VERSION}/hostedzonesbyname`, query, what: `list the hosted zones named ${name}`, denied: "token" };
      const root = expect(await call(request), "ListHostedZonesByNameResponse", request);
      for (const zone of at(root, "HostedZones")?.children ?? []) {
        if (zone.name !== "HostedZone" || decodeName(textAt(zone, "Name") ?? "") !== name) continue;
        const id = (textAt(zone, "Id") ?? "").replace(/^\/hostedzone\//, "");
        if (!ZONE_ID_SHAPE.test(id)) throw new DnsError(`Route 53 listed a hosted zone of ${name} with an ID that is not one, asked to ${request.what}`, "unreachable");
        found.push({ id, private: textAt(zone, "Config", "PrivateZone") === "true" });
      }
      const nextName = textAt(root, "NextDNSName");
      const nextId = textAt(root, "NextHostedZoneId");
      if (textAt(root, "IsTruncated") !== "true" || nextName === null || nextId === null || decodeName(nextName) !== name) return found;
      if (seen.has(nextId)) throw new DnsError(`Route 53 answered the same page twice, asked to ${request.what}`, "unreachable");
      seen.add(nextId);
      query = [["dnsname", nextName], ["hostedzoneid", nextId], ["maxitems", "100"]];
    }
    throw new DnsError(`the hosted zones named ${name} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  function checkedId(zone: ZoneRef): string {
    if (!ZONE_ID_SHAPE.test(zone.id)) throw new DnsError(`${zone.id === "" ? "an empty" : "a"} hosted zone ID that is not Route 53's`, "refused");
    return zone.id;
  }

  /** One change batch, retried while Route 53 is still busy with the previous one. */
  async function change(zone: ZoneRef, changes: { action: "CREATE" | "DELETE"; set: string }[], what: string): Promise<void> {
    const request: Call = { method: "POST", path: `/${API_VERSION}/hostedzone/${checkedId(zone)}/rrset/`, body: batchXml(changes), what, denied: "refused" };
    const root = expect(await call(request), "ChangeResourceRecordSetsResponse", request);
    if (textAt(root, "ChangeInfo", "Id") === null) throw new DnsError(`${host} answered the change without a change ID, asked to ${what}`, "unreachable");
  }

  /** The set a record of listRecords belongs to, read afresh, and the record's place in it. */
  async function current(zone: ZoneRef, record: DnsRecord): Promise<{ key: RecordKey; set: RecordSet | null }> {
    const key = parseRecordId(record.id);
    if (key === null) throw new DnsError(`${record.name} ${record.type}: a record Route 53's listing did not give`, "refused");
    const set = (await readSets(zone, key.name)).find((candidate) => candidate.type === key.type && candidate.identifier === key.set) ?? null;
    const holds = set !== null && (key.value === null ? set.alias !== null : set.alias === null && set.values.includes(key.value));
    return { key, set: holds ? set : null };
  }

  function line(record: DnsRecord): string {
    return `${record.name} ${record.type} ${record.content}`;
  }

  return {
    async verify() {
      const request: Call = { method: "GET", path: `/${API_VERSION}/hostedzonesbyname`, query: [["maxitems", "1"]], what: "list the account's hosted zones (route53:ListHostedZonesByName)", denied: "token" };
      expect(await call(request), "ListHostedZonesByNameResponse", request);
    },

    async findZone(zone) {
      const wanted = decodeName(zone);
      const candidates = zoneCandidates(wanted);
      const privates: string[] = [];
      for (const name of candidates) {
        const zones = await zonesNamed(name);
        const publics = zones.filter((candidate) => !candidate.private);
        if (zones.length > publics.length) privates.push(name);
        if (publics.length === 0) continue;
        if (publics.length > 1) {
          throw new DnsError(`more than one public Route 53 hosted zone is named ${name}`, "zone", [
            `hosted zones ${publics.map((candidate) => candidate.id).join(", ")}`,
            "only the one the domain's NS records name is served: delete the others, or the records may land in a zone nobody reads",
          ]);
        }
        if (zones[0]!.private) {
          // Caddy's module asks for one hosted zone of that name, the first
          // Route 53 lists, and would answer the challenge in this one.
          throw new DnsError(`a private Route 53 hosted zone named ${name} comes before the public one`, "zone", [
            `private hosted zone ${zones[0]!.id}, public hosted zone ${publics[0]!.id}`,
            "Caddy's Route 53 module takes the first hosted zone of a name and would write the certificate's challenge in the private one",
            "rename or delete the private zone, or serve the sites from another zone",
          ]);
        }
        const found = { id: publics[0]!.id, name };
        // The key's policy names the zones it may read: a key made for another one fails here, not mid-plan.
        const request: Call = {
          method: "GET",
          path: `/${API_VERSION}/hostedzone/${found.id}/rrset`,
          query: [["maxitems", "1"]],
          what: `read the hosted zone ${name} (${found.id})`,
          denied: "zone",
        };
        expect(await call(request), "ListResourceRecordSetsResponse", request);
        return found;
      }
      throw new DnsError(`no public Route 53 hosted zone of the key's account holds ${wanted}`, "zone", [
        `looked for: ${candidates.join(", ")}`,
        ...(privates.length > 0 ? [`private hosted zones, which the internet does not see, were left aside: ${privates.join(", ")}`] : []),
        "check --zone, and that the access key belongs to the AWS account that holds the zone",
      ]);
    },

    async listRecords(zone, name) {
      const sets = await readSets(zone, name);
      return sets.flatMap((set): DnsRecord[] => {
        if (set.alias !== null) {
          return [{ id: recordId({ name: set.name, type: set.type, set: set.identifier, value: null }), type: set.type, name: set.name, content: `alias ${set.alias}`, proxied: false, ttl: 0 }];
        }
        return set.values.map((value) => ({
          id: recordId({ name: set.name, type: set.type, set: set.identifier, value }),
          type: set.type,
          name: set.name,
          content: set.type === "CNAME" ? decodeName(value) : value,
          proxied: false,
          ttl: set.ttl,
        }));
      });
    },

    async createRecord(zone, record) {
      const name = decodeName(record.name);
      // A CREATE: Route 53 refuses it if a set of that name and type appeared since the plan was drawn.
      await change(zone, [{ action: "CREATE", set: newSetXml(name, record.type, [record.content]) }], `create ${name} ${record.type} ${record.content}`);
    },

    async updateRecord(zone, record, content) {
      const { key, set } = await current(zone, record);
      if (set === null) {
        throw new DnsError(`${line(record)} changed since the zone was read`, "refused", ["nothing was written for it: run the same command again, it reads the zone afresh"]);
      }
      const values = set.alias !== null ? [content] : [...new Set(set.values.map((value) => (value === key.value ? content : value)))];
      await change(
        zone,
        [
          { action: "DELETE", set: setXml(set) },
          { action: "CREATE", set: setXml(set, { TTL: `<TTL>${TTL}</TTL>`, ResourceRecords: valuesXml(values), AliasTarget: null }) },
        ],
        `point ${record.name} ${record.type} at ${content}`,
      );
    },

    async deleteRecord(zone, record) {
      const { key, set } = await current(zone, record);
      // Already gone: what the plan wanted.
      if (set === null) return;
      const rest = set.values.filter((value) => value !== key.value);
      const what = `delete ${line(record)}`;
      if (set.alias !== null || rest.length === 0) {
        await change(zone, [{ action: "DELETE", set: setXml(set) }], what);
        return;
      }
      await change(
        zone,
        [
          { action: "DELETE", set: setXml(set) },
          { action: "CREATE", set: setXml(set, { ResourceRecords: valuesXml(rest) }) },
        ],
        what,
      );
    },
  };
}

export const ROUTE53: DnsEntry = {
  name: "route53",
  title: "Amazon Route 53",
  credentials: [
    { variable: ACCESS_KEY_VARIABLE, label: "access key ID", secret: true, shape: ACCESS_KEY_SHAPE },
    { variable: SECRET_KEY_VARIABLE, label: "secret access key", secret: true, shape: SECRET_KEY_SHAPE },
  ],
  credentialHelp: [
    `console.aws.amazon.com/iam, Policies, Create policy, JSON: the policy of ${DOCS}, with your zone and its hosted zone ID`,
    "IAM, Users, Create user without console access, with that policy alone; then Security credentials, Create access key",
    "a key of its own, never the one that orders machines: it stays on the machine for Caddy's renewals",
  ],
  docs: DOCS,
  // ns-1372.awsdns-43.org, ns-81.awsdns-10.com, ns-659.awsdns-18.net, ns-1984.awsdns-56.co.uk.
  nameServers: /^ns-[0-9]{1,4}\.awsdns-[0-9]{2}\.(com|net|org|co\.uk)$/,
  caddy: {
    package: "github.com/caddy-dns/route53",
    module: "dns.providers.route53",
    // Both credentials explicitly: unset, the module's AWS SDK would look for
    // AWS_ACCESS_KEY_ID and the instance's role. The region is Route 53's,
    // rather than AWS_REGION's.
    directive: ["dns route53 {", `\taccess_key_id {env.${ACCESS_KEY_VARIABLE}}`, `\tsecret_access_key {env.${SECRET_KEY_VARIABLE}}`, `\tregion ${SIGNING_REGION}`, "}"],
    environment: (credentials) => ({
      [ACCESS_KEY_VARIABLE]: credentials[ACCESS_KEY_VARIABLE] ?? "",
      [SECRET_KEY_VARIABLE]: credentials[SECRET_KEY_VARIABLE] ?? "",
    }),
  },
  apiVariable: ROUTE53_API_VARIABLE,
  open: route53,
};
