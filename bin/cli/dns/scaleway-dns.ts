/**
 * Scaleway Domains and DNS, through its API v2beta1:
 * https://www.scaleway.com/en/developers/api/domains-and-dns/, whose OpenAPI
 * document is https://www.scaleway.com/en/developers/api/domains-and-dns/v2beta1/schema.yml.
 *
 * A zone is a DNS zone there, `domain` and `subdomain` together (`example.com`
 * and ``, or `example.com` and `apps` for the zone `apps.example.com`),
 * named by its full name in every path. Its records are named relative to it,
 * the empty string for the zone itself and `*` for its wildcard, and each has
 * an id of its own, a UUID, by which one record is changed or deleted alone:
 * the API keeps no record sets, an A with two addresses is two records.
 *
 * THE KEY IS A DNS KEY. Setup lays it on the machine, where Caddy renews the
 * wildcard with it, so it is never read from SCW_SECRET_KEY, which the scw
 * CLI and the machine provider read and which orders Instances. It is
 * SITESOLIDE_DNS_SCALEWAY_SECRET_KEY, the secret key of an API key of an IAM
 * application whose only policy gives DomainsDNSFullAccess on the zone's
 * project: Scaleway scopes a permission set to a project or to the whole
 * organization, never to one zone (its resource-level conditions cover IAM,
 * Key Manager and Secret Manager alone). The organization's ID,
 * SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID, is no secret: the Caddy module
 * refuses to start without it.
 *
 * What setup asks becomes:
 *
 *   findZone       GET /domain/v2beta1/dns-zones?dns_zones=<candidate>, the
 *                  zone and each parent
 *   listRecords    GET /domain/v2beta1/dns-zones/{zone}/records?name=<relative>,
 *                  filtered here as well, since the empty name of the zone
 *                  itself filters nothing
 *   createRecord   PATCH .../records, an `add` change, TTL 60
 *   updateRecord   PATCH .../records, a `set` change naming the record's id,
 *                  its TTL kept
 *   deleteRecord   PATCH .../records, a `delete` change naming the record's id
 *
 * Every PATCH says `disallow_new_zone_creation`: a name that is not a zone of
 * the account is refused rather than created. The API applies a change at
 * once, and versions it.
 *
 * Every call carries the secret key in the X-Auth-Token header and nowhere
 * else, follows no redirect, and gives up after a minute. Whatever text comes
 * back from outside is scrubbed of it before it reaches a message. Lists are
 * read to their end, a hundred items a page, until `total_count` is reached.
 * Errors are `{"type", "message", ...}`, the `details` of a refused argument or
 * permission read too.
 */
import { apiAddress } from "../../../clouds/src/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.scaleway.com";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_SCALEWAY_DNS_API";

/** sitesolide's own variables: SCW_SECRET_KEY may hold a key that orders Instances. */
export const SECRET_VARIABLE = "SITESOLIDE_DNS_SCALEWAY_SECRET_KEY";
export const ORGANIZATION_VARIABLE = "SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID";

/** A secret key and an organization ID are both UUIDs. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The TTL of a record setup creates: sixty seconds, the lowest Scaleway's own
 * Terraform provider lets a record have; the API's reference names no bound.
 */
export const TTL = 60;

const TITLE = "Scaleway";
const PREFIX = "/domain/v2beta1";

/** The most items a page holds, and the most pages a listing reads. */
const PAGE_SIZE = 100;
const MAX_PAGES = 500;

export const CREDENTIAL_HELP = [
  "console.scaleway.com, IAM, Applications, Create application, then a policy with one rule: the zone's project, DomainsDNSFullAccess",
  "the application, API keys, Generate an API key; the organization ID is under Organization settings",
];

type ScalewayZone = { domain?: unknown; subdomain?: unknown; status?: unknown };
type ScalewayRecord = { id?: unknown; name?: unknown; type?: unknown; data?: unknown; ttl?: unknown };

/** A zone's full name, from its domain and its subdomain. */
export function zoneName(zone: ScalewayZone): string {
  const domain = typeof zone.domain === "string" ? zone.domain.toLowerCase().replace(/\.$/, "") : "";
  const subdomain = typeof zone.subdomain === "string" ? zone.subdomain.toLowerCase() : "";
  return subdomain === "" ? domain : `${subdomain}.${domain}`;
}

/** A name of the zone as the API takes it: empty for the zone itself, relative otherwise. */
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "";
  if (!name.endsWith(`.${zone}`)) throw new DnsError(`${name} is not a name of the Scaleway zone ${zone}`, "refused");
  return name.slice(0, -(zone.length + 1));
}

/** A record's name as the interface says it: absolute, lowercase, without a trailing dot. */
export function absoluteName(name: string, zone: string): string {
  const lowered = name.trim().toLowerCase().replace(/\.$/, "");
  return lowered === "" || lowered === "@" ? zone : `${lowered}.${zone}`;
}

function scaleway(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const secret = context.credentials[SECRET_VARIABLE] ?? "";
  const scrub = (text: string): string => (secret === "" ? text : text.replaceAll(secret, "[secret key]"));

  /** What an error answer details: the arguments refused, the permissions missing. */
  function details(body: Record<string, unknown>): string[] {
    const lines: string[] = [];
    for (const entry of Array.isArray(body.details) ? (body.details as Record<string, unknown>[]) : []) {
      if (typeof entry?.argument_name === "string") {
        const help = typeof entry.help_message === "string" && entry.help_message !== "" ? `, ${entry.help_message}` : "";
        lines.push(scrub(`${entry.argument_name}: ${String(entry.reason ?? "invalid")}${help}`));
      } else if (typeof entry?.action === "string") {
        lines.push(scrub(`${String(entry.resource ?? "resource")}: ${entry.action} not allowed`));
      }
    }
    if (typeof body.help_message === "string" && body.help_message !== "") lines.push(scrub(body.help_message));
    return lines;
  }

  /** An error answer, in the words of the interface: the key refused, or the request. */
  function refusal(status: number, body: Record<string, unknown>, method: string, path: string): DnsError {
    const type = typeof body.type === "string" ? scrub(body.type) : "";
    const said = scrub(typeof body.message === "string" && body.message.trim() !== "" ? body.message.trim() : `HTTP ${status}`);
    const answer = `${status}${type === "" ? "" : ` ${type}`}`;
    const listed = details(body);
    if (status === 401 || type === "denied_authentication") {
      return new DnsError(`${TITLE} refused the secret key (${answer}): ${said}`, "token", ["it is unknown, revoked, expired, or was copied wrong", ...CREDENTIAL_HELP]);
    }
    if (status === 403 || type === "permissions_denied") {
      return new DnsError(`the ${TITLE} API key may not ${method} ${path} (${answer}): ${said}`, "token", [
        ...listed,
        "its application's policy needs DomainsDNSFullAccess on the project that holds the zone",
      ]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (${answer}): ${said}`, "refused", ["run setup again in a minute"]);
    }
    if (status >= 500) return new DnsError(`${TITLE} failed to answer ${method} ${path} (${answer}): ${said}`, "refused", [...listed, `the failure is on ${TITLE}'s side`]);
    return new DnsError(`${TITLE} refused ${method} ${path} (${answer}): ${said}`, "refused", listed);
  }

  /** One call: the secret key in its header, JSON both ways. */
  async function call<T>(method: string, path: string, query: [string, string][] = [], body?: unknown): Promise<T> {
    const search = new URLSearchParams(query).toString();
    let response: Response;
    let text: string;
    try {
      response = await context.fetcher(`${base}${PREFIX}${path}${search === "" ? "" : `?${search}`}`, {
        method,
        // The key follows no address an answer names.
        redirect: "error",
        headers: { "X-Auth-Token": secret, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
      text = await response.text();
    } catch (error) {
      throw new DnsError(scrub(`cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
    }
    let parsed: unknown = null;
    try {
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
    }
    if (!response.ok) {
      const body = parsed as Record<string, unknown>;
      if (typeof body.message !== "string" && typeof body.type !== "string") {
        throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
      }
      throw refusal(response.status, body, method, path);
    }
    return parsed as T;
  }

  /** Every page of a listing, `key` naming the list in each answer. */
  async function all<T>(path: string, key: string, query: [string, string][]): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await call<Record<string, unknown>>("GET", path, [...query, ["page", String(page)], ["page_size", String(PAGE_SIZE)]]);
      const list = answer[key];
      if (!Array.isArray(list)) throw new DnsError(`${TITLE}'s answer to GET ${path} holds no ${key}`, "unreachable");
      items.push(...(list as T[]));
      const total = typeof answer.total_count === "number" ? answer.total_count : items.length;
      if (items.length >= total || list.length === 0) return items;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const records = (zone: ZoneRef) => `/dns-zones/${encodeURIComponent(zone.id)}/records`;

  /** One PATCH of the zone's records, never creating a zone that is not there. */
  async function change(zone: ZoneRef, what: Record<string, unknown>): Promise<void> {
    await call("PATCH", records(zone), [], { changes: [what], return_all_records: false, disallow_new_zone_creation: true });
  }

  return {
    async verify() {
      // Any read: 401 for a key Scaleway does not know, 403 for one whose
      // application may not read Domains and DNS.
      await call("GET", "/dns-zones", [["page_size", "1"]]);
    },

    async findZone(zone) {
      for (const name of zoneCandidates(zone)) {
        const found = await all<ScalewayZone>("/dns-zones", "dns_zones", [["dns_zones", name]]);
        if (found.some((candidate) => zoneName(candidate) === name)) return { id: name, name };
      }
      throw new DnsError(`no ${TITLE} DNS zone the API key can read holds ${zone}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        "check --zone, and that the key's application has DomainsDNSFullAccess on the project that holds the zone",
      ]);
    },

    async listRecords(zone, name) {
      const relative = relativeName(name, zone.name);
      const found = await all<ScalewayRecord>(records(zone), "records", [["name", relative]]);
      // Filtered here as well: the empty name of the zone itself filters
      // nothing, and what is decided must only ever concern this name.
      return found
        .filter((record) => typeof record.name === "string" && absoluteName(record.name, zone.name) === name)
        .filter((record) => typeof record.id === "string" && typeof record.type === "string" && typeof record.data === "string")
        .map(
          (record): DnsRecord => ({
            id: record.id as string,
            type: record.type as string,
            name,
            content: record.data as string,
            proxied: false,
            ttl: typeof record.ttl === "number" ? record.ttl : 0,
          }),
        );
    },

    async createRecord(zone, record) {
      await change(zone, { add: { records: [{ name: relativeName(record.name, zone.name), type: record.type, data: record.content, ttl: TTL }] } });
    },

    async updateRecord(zone, record, content) {
      const ttl = record.ttl > 0 ? record.ttl : TTL;
      await change(zone, { set: { id: record.id, records: [{ name: relativeName(record.name, zone.name), type: record.type, data: content, ttl }] } });
    },

    async deleteRecord(zone, record) {
      await change(zone, { delete: { id: record.id } });
    },
  };
}

export const SCALEWAY_DNS: DnsEntry = {
  name: "scaleway-dns",
  title: "Scaleway Domains and DNS",
  credentials: [
    { variable: SECRET_VARIABLE, label: "secret key", secret: true, shape: UUID },
    { variable: ORGANIZATION_VARIABLE, label: "organization ID", secret: false, shape: UUID },
  ],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/scaleway-dns.md",
  // The two name servers the API names for every zone it serves, ns_default.
  nameServers: /^ns[01]\.dom\.scw\.cloud$/,
  caddy: {
    package: "github.com/caddy-dns/scaleway",
    module: "dns.providers.scaleway",
    // The module's Caddyfile syntax, both fields required, both read through
    // Caddy's replacer at provisioning.
    directive: ["dns scaleway {", `\tsecret_key {env.${SECRET_VARIABLE}}`, `\torganization_id {env.${ORGANIZATION_VARIABLE}}`, "}"],
    environment: (credentials) => ({
      [SECRET_VARIABLE]: credentials[SECRET_VARIABLE] ?? "",
      [ORGANIZATION_VARIABLE]: credentials[ORGANIZATION_VARIABLE] ?? "",
    }),
  },
  apiVariable: API_VARIABLE,
  open: scaleway,
};
