/**
 * Vultr's DNS, through its API v2: https://www.vultr.com/api/#tag/dns, whose
 * OpenAPI document Vultr also publishes with its Python client
 * (github.com/vultr/vultr-python-client, openapi-client/swagger.json). A zone
 * is a "DNS domain" there, listed by GET /v2/domains; its records are under
 * /v2/domains/{dns-domain}/records, named relative to it, the empty name for
 * the domain itself and `*` for its wildcard. The reference's own example of
 * a listing shows a full name, `foo.example.com`, where its examples of a
 * record created or read show `www`, and Vultr's Terraform provider and
 * DNSControl read relative names: both are read here, a name that ends with
 * the domain being taken as written.
 *
 * THE KEY IS A DNS KEY, and nothing more. Setup lays it on the machine, where
 * Caddy renews the wildcard with it, so it is never read from VULTR_API_KEY,
 * which the machine provider and vultr-cli read. It is
 * SITESOLIDE_DNS_VULTR_API_KEY, which should be the key of a service user of
 * the organization whose only policy allows `network.dns.*`: the account's own
 * key reaches everything the account holds, instances and billing included.
 * Even so restricted, it reaches every DNS domain of the organization, and
 * `network.dns.Create` and `network.dns.Delete` cover whole domains as well as
 * records (https://docs.vultr.com/platform/iam/policies/iam-policy-actions-map/network-actions):
 * Vultr documents no narrower grant for DNS.
 *
 * A key's access control list applies to every call it makes: it must allow
 * the machine's addresses, since Caddy calls from there, as well as the
 * workstation's, from which setup calls.
 *
 * Every call carries the key in the Authorization header and nowhere else,
 * follows no redirect, and gives up after a minute. Whatever text comes back
 * from outside is scrubbed of the key before it reaches a message. Lists are
 * read by cursor, `meta.links.next` passed back as `cursor` until it is empty,
 * five hundred items a page, the most the API returns. Errors are
 * `{"error": "...", "status": n}`.
 *
 * Vultr refuses a change that would leave the records of one name and type
 * with different TTLs (as DNSControl's Vultr provider notes, 2026-07-26). The
 * plan never does: it creates a record only where none of that name and type
 * exists, and updates one only once the others beside it are deleted.
 */
import { apiAddress } from "../../../clouds/src/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.vultr.com/v2";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_VULTR_DNS_API";

/** sitesolide's own variable: VULTR_API_KEY may hold a key that orders machines. */
export const KEY_VARIABLE = "SITESOLIDE_DNS_VULTR_API_KEY";

/** A Vultr API key: 36 uppercase letters and digits today, any run of 32 to 64 letters and digits accepted. */
export const KEY_SHAPE = /^[A-Za-z0-9]{32,64}$/;

/**
 * Vultr documents no minimum TTL. 120 seconds is what lego, the ACME client,
 * has sent it for years for its own records; the console's default is 300.
 */
export const TTL = 120;

const TITLE = "Vultr";

const PER_PAGE = 500;
const MAX_PAGES = 200;

export const CREDENTIAL_HELP = [
  "my.vultr.com, the organization's name, Manage Organization: a Permission Policy allowing network.dns.* alone, given to a Service User",
  "then the user's API Access, Create API Key; its Access Control List must allow the machine's addresses and this workstation's",
];

type VultrDomain = { domain?: unknown };
type VultrRecord = { id?: unknown; type?: unknown; name?: unknown; data?: unknown; ttl?: unknown };

/**
 * A record's name as the interface says it, absolute, lowercase, without a
 * trailing dot: empty or `@` for the domain, a name relative to it otherwise,
 * or already ending with it.
 */
export function absoluteName(name: string, domain: string): string {
  const lowered = name.trim().toLowerCase().replace(/\.$/, "");
  if (lowered === "" || lowered === "@") return domain;
  if (lowered === domain || lowered.endsWith(`.${domain}`)) return lowered;
  return `${lowered}.${domain}`;
}

/** A name of the zone as the API takes it: empty for the domain, relative otherwise. */
export function relativeName(absolute: string, domain: string): string {
  const name = absolute.toLowerCase();
  if (name === domain) return "";
  if (!name.endsWith(`.${domain}`)) throw new DnsError(`${name} is not a name of the Vultr DNS domain ${domain}`, "refused");
  return name.slice(0, -(domain.length + 1));
}

function vultr(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const key = context.credentials[KEY_VARIABLE] ?? "";
  const scrub = (text: string): string => (key === "" ? text : text.replaceAll(key, "[token]"));

  /** An error answer, in the words of the interface: the key refused, or the request. */
  function refusal(status: number, body: unknown, method: string, path: string): DnsError {
    const error = (body as { error?: unknown } | null)?.error;
    const said = scrub(typeof error === "string" && error.trim() !== "" ? error.trim() : `HTTP ${status}`);
    if (status === 401) {
      return new DnsError(`${TITLE} refused the API key (401): ${said}`, "token", [
        "a key is refused when it is unknown or revoked, and also when its access control list does not allow the address it is used from",
        ...CREDENTIAL_HELP,
      ]);
    }
    if (status === 403) {
      return new DnsError(`the ${TITLE} API key may not ${method} ${path} (403): ${said}`, "token", ["the key's user needs a policy allowing network.dns.* (List, Read, Create, Update, Delete)"]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (429): ${said}`, "refused", ["Vultr accepts about 30 requests a second from one address: run setup again"]);
    }
    return new DnsError(`${TITLE} refused ${method} ${path} (${status}): ${said}`, "refused");
  }

  /** One call: the key in its header, JSON both ways. A 204 answers an empty object. */
  async function call<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const search = new URLSearchParams(query).toString();
    let response: Response;
    let text: string;
    try {
      response = await context.fetcher(`${base}${path}${search === "" ? "" : `?${search}`}`, {
        method,
        // The key follows no address an answer names.
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
      text = await response.text();
    } catch (error) {
      throw new DnsError(scrub(`cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
    }
    if (response.status === 204) return {} as T;
    let parsed: unknown;
    try {
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
    }
    if (!response.ok) throw refusal(response.status, parsed, method, path);
    return parsed as T;
  }

  /** Every page of a list, passing `meta.links.next` back as the cursor until it is empty. */
  async function listAll<T>(path: string, key: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (let read = 0; read < MAX_PAGES; read++) {
      const answer = await call<Record<string, unknown>>("GET", path, { per_page: String(PER_PAGE), ...(cursor === "" ? {} : { cursor }) });
      const list = answer[key];
      if (!Array.isArray(list)) throw new DnsError(`${host}'s answer to GET ${path} holds no list of ${key}`, "unreachable");
      items.push(...(list as T[]));
      const next: unknown = (answer.meta as { links?: { next?: unknown } } | undefined)?.links?.next;
      if (typeof next !== "string" || next === "") return items;
      if (seen.has(next)) throw new DnsError(`${host} answered GET ${path} with a cursor it had already given`, "unreachable");
      seen.add(next);
      cursor = next;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const recordsPath = (zone: ZoneRef) => `/domains/${encodeURIComponent(zone.id)}/records`;

  return {
    async verify() {
      if (key === "") throw new DnsError(`no ${TITLE} API key: set ${KEY_VARIABLE}`, "token", CREDENTIAL_HELP);
      const answer = await call<{ domains?: unknown }>("GET", "/domains", { per_page: "1" });
      if (!Array.isArray(answer.domains)) throw new DnsError(`${host}'s answer to GET /domains holds no list of domains`, "unreachable");
    },

    async findZone(zone) {
      const wanted = zone.trim().toLowerCase().replace(/\.$/, "");
      const domains = await listAll<VultrDomain>("/domains", "domains");
      const names = new Set(domains.map((domain) => (typeof domain.domain === "string" ? domain.domain.toLowerCase().replace(/\.$/, "") : "")));
      for (const candidate of zoneCandidates(wanted)) if (names.has(candidate)) return { id: candidate, name: candidate };
      throw new DnsError(`no ${TITLE} DNS domain the API key can read holds ${wanted}`, "zone", [
        `looked for: ${zoneCandidates(wanted).join(", ")}`,
        "check --zone, and that the domain is under Network, DNS, in the organization the key's user belongs to",
      ]);
    },

    async listRecords(zone, name) {
      const wanted = name.toLowerCase();
      const records = await listAll<VultrRecord>(recordsPath(zone), "records");
      return records
        .map((record): DnsRecord => ({
          id: String(record.id),
          type: String(record.type ?? "").toUpperCase(),
          name: absoluteName(String(record.name ?? ""), zone.name),
          content: String(record.data ?? ""),
          proxied: false,
          ttl: typeof record.ttl === "number" ? record.ttl : 0,
        }))
        .filter((record) => record.name === wanted);
    },

    async createRecord(zone, record) {
      await call("POST", recordsPath(zone), {}, { name: relativeName(record.name, zone.name), type: record.type, data: record.content, ttl: TTL });
    },

    async updateRecord(zone, record, content) {
      // Every attribute is optional, and keeps its value when left out.
      await call("PATCH", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`, {}, { data: content, ttl: TTL });
    },

    async deleteRecord(zone, record) {
      await call("DELETE", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`);
    },
  };
}

export const VULTR_DNS: DnsEntry = {
  name: "vultr-dns",
  title: "Vultr DNS",
  credentials: [{ variable: KEY_VARIABLE, label: "DNS API key", secret: true, shape: KEY_SHAPE }],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/vultr-dns.md",
  // ns1 and ns2.vultr.com, the name servers of every domain Vultr serves.
  nameServers: /^ns[12]\.vultr\.com$/,
  caddy: {
    package: "github.com/caddy-dns/vultr",
    module: "dns.providers.vultr",
    // The key as the directive's argument: the module's `api_token` subdirective
    // stores its own name rather than the value. Its Provision replaces
    // placeholders in the key, `{env.*}` included.
    directive: [`dns vultr {env.${KEY_VARIABLE}}`],
    environment: (credentials) => ({ [KEY_VARIABLE]: credentials[KEY_VARIABLE] ?? "" }),
  },
  apiVariable: API_VARIABLE,
  open: vultr,
};
