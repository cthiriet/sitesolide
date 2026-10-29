/**
 * DigitalOcean's DNS, through its API v2:
 * https://docs.digitalocean.com/reference/api/reference/, whose OpenAPI
 * source is https://github.com/digitalocean/openapi
 * (specification/resources/domains). A zone is a "domain" there, listed by
 * GET /v2/domains; its records are under /v2/domains/{name}/records, named
 * relative to it, `@` for the domain itself and `*` for its wildcard.
 *
 * THE TOKEN IS A DNS TOKEN, and nothing more. Setup lays it on the machine,
 * where Caddy renews the wildcard with it, so it is never read from
 * DIGITALOCEAN_TOKEN or DIGITALOCEAN_ACCESS_TOKEN, which the machine provider
 * and doctl read and which may order Droplets. It is
 * SITESOLIDE_DNS_DIGITALOCEAN_TOKEN, a personal access token with two custom
 * scopes, `domain:read` and `domain:update`. The reference lets
 * `domain:update` create and delete records as well as edit them (the
 * security of domains_create_record.yml is `domain:create` or
 * `domain:update`, that of domains_delete_record.yml `domain:delete` or
 * `domain:update`), while creating and deleting a whole domain need
 * `domain:create` and `domain:delete`, which the token does without. It still
 * reaches every domain of the team it was made in: DigitalOcean scopes a
 * token by kind of resource, never by resource.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and gives up after a minute. Whatever text comes back
 * from outside is scrubbed of the token before it reaches a message. Lists are
 * read to their end, two hundred items a page, the most the API returns: only
 * the page number is taken from `links.pages.next`, and the request is built
 * on the API's own address, so the token never follows an address an answer
 * named. Errors are `{"id", "message", "request_id"}`.
 *
 * Records are read whole and filtered here rather than through the `name`
 * query parameter: the reference says it takes a fully qualified name, and
 * says nothing of how it matches `@` or `*`.
 */
import { apiAddress } from "../../../clouds/src/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.digitalocean.com/v2";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_DIGITALOCEAN_DNS_API";

/** sitesolide's own variable: DIGITALOCEAN_TOKEN may hold a token that orders machines. */
export const TOKEN_VARIABLE = "SITESOLIDE_DNS_DIGITALOCEAN_TOKEN";

/**
 * A personal access token, `dop_v1_` and 64 hexadecimal digits, and nothing
 * else: a token from before 2021, 64 digits alone, predates custom scopes and
 * reaches the whole team, and an OAuth token from `doctl auth login`,
 * `doo_v1_`, expires within hours, which would stop the renewals.
 */
export const TOKEN_SHAPE = /^dop_v1_[0-9a-f]{64}$/;

/** The lowest TTL DigitalOcean accepts: "All DNS records require a minimum TTL value of 30 seconds." */
export const TTL = 30;

const TITLE = "DigitalOcean";

/** The most items a page holds, and the most pages a listing reads. */
const PER_PAGE = 200;
const MAX_PAGES = 500;

export const CREDENTIAL_HELP = [
  "cloud.digitalocean.com, API, Tokens, Generate New Token: Custom Scopes, domain:read and domain:update alone",
  "pick the expiration knowing the machine renews its certificate with it every two months: past it, renewals fail",
];

type Links = { pages?: { next?: unknown } };
type DoDomain = { name?: unknown };
type DoRecord = { id?: unknown; type?: unknown; name?: unknown; data?: unknown; ttl?: unknown };

/**
 * A record's name as the interface says it, absolute, lowercase, without a
 * trailing dot, from the API's: `@` or empty for the domain, a name relative
 * to it otherwise. A name that already ends with the domain, or with a dot, is
 * taken as written.
 */
export function absoluteName(name: string, domain: string): string {
  const lowered = name.trim().toLowerCase().replace(/\.$/, "");
  if (lowered === "" || lowered === "@") return domain;
  if (lowered === domain || lowered.endsWith(`.${domain}`) || name.trim().endsWith(".")) return lowered;
  return `${lowered}.${domain}`;
}

/** A name of the zone as the API takes it: `@` for the domain, relative otherwise. */
export function relativeName(absolute: string, domain: string): string {
  const name = absolute.toLowerCase();
  if (name === domain) return "@";
  if (!name.endsWith(`.${domain}`)) throw new DnsError(`${name} is not a name of the DigitalOcean domain ${domain}`, "refused");
  return name.slice(0, -(domain.length + 1));
}

/** The page number a `links.pages.next` address names, or null. */
function pageOf(link: string): number | null {
  try {
    const number = Number(new URL(link).searchParams.get("page"));
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function digitalocean(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";
  const scrub = (text: string): string => (token === "" ? text : text.replaceAll(token, "[token]"));

  /** An error answer, in the words of the interface: the token refused, or the request. */
  function refusal(status: number, body: unknown, method: string, path: string): DnsError {
    const error = body as { id?: unknown; message?: unknown; request_id?: unknown } | null;
    const said = scrub(typeof error?.message === "string" && error.message.trim() !== "" ? error.message.trim() : `HTTP ${status}`);
    const answer = `${status}${typeof error?.id === "string" ? ` ${scrub(error.id)}` : ""}`;
    const request = typeof error?.request_id === "string" ? [`DigitalOcean's request id, for its support: ${scrub(error.request_id)}`] : [];
    if (status === 401) {
      return new DnsError(`${TITLE} refused the token (${answer}): ${said}`, "token", ["it is unknown, revoked, expired, or was copied wrong", ...CREDENTIAL_HELP]);
    }
    if (status === 403) {
      return new DnsError(`the ${TITLE} token may not ${method} ${path} (${answer}): ${said}`, "token", ["the token needs the custom scopes domain:read and domain:update", ...request]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (${answer}): ${said}`, "refused", ["a token may make 250 requests a minute and 5000 an hour: run setup again in a minute"]);
    }
    return new DnsError(`${TITLE} refused ${method} ${path} (${answer}): ${said}`, "refused", request);
  }

  /** One call: the token in its header, JSON both ways. A 204 answers an empty object. */
  async function call<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const search = new URLSearchParams(query).toString();
    let response: Response;
    let text: string;
    try {
      response = await context.fetcher(`${base}${path}${search === "" ? "" : `?${search}`}`, {
        method,
        // The token follows no address an answer names.
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

  /** Every page of a list, to its end. */
  async function listAll<T>(path: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (let read = 0; read < MAX_PAGES; read++) {
      const answer = await call<Record<string, unknown>>("GET", path, { page: String(page), per_page: String(PER_PAGE) });
      const list = answer[key];
      if (!Array.isArray(list)) throw new DnsError(`${host}'s answer to GET ${path} holds no list of ${key}`, "unreachable");
      items.push(...(list as T[]));
      const next = (answer.links as Links | undefined)?.pages?.next;
      if (typeof next !== "string" || list.length === 0) return items;
      const number = pageOf(next);
      if (number === null || number <= page) throw new DnsError(`${host} answered GET ${path} with a next page that is not one`, "unreachable");
      page = number;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const recordsPath = (zone: ZoneRef) => `/domains/${encodeURIComponent(zone.id)}/records`;

  return {
    async verify() {
      if (token === "") throw new DnsError(`no ${TITLE} token: set ${TOKEN_VARIABLE}`, "token", CREDENTIAL_HELP);
      const answer = await call<{ domains?: unknown }>("GET", "/domains", { page: "1", per_page: "1" });
      if (!Array.isArray(answer.domains)) throw new DnsError(`${host}'s answer to GET /domains holds no list of domains`, "unreachable");
    },

    async findZone(zone) {
      const wanted = zone.trim().toLowerCase().replace(/\.$/, "");
      const domains = await listAll<DoDomain>("/domains", "domains");
      const names = new Set(domains.map((domain) => (typeof domain.name === "string" ? domain.name.toLowerCase().replace(/\.$/, "") : "")));
      for (const candidate of zoneCandidates(wanted)) if (names.has(candidate)) return { id: candidate, name: candidate };
      throw new DnsError(`no ${TITLE} domain the token can read holds ${wanted}`, "zone", [
        `looked for: ${zoneCandidates(wanted).join(", ")}`,
        "check --zone, and that the domain is under Networking, Domains, in the team the token was made in",
      ]);
    },

    async listRecords(zone, name) {
      const wanted = name.toLowerCase();
      const records = await listAll<DoRecord>(recordsPath(zone), "domain_records");
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
      await call("POST", recordsPath(zone), {}, { type: record.type, name: relativeName(record.name, zone.name), data: record.content, ttl: TTL });
    },

    async updateRecord(zone, record, content) {
      // The reference's record model requires the type, PATCH included.
      await call("PATCH", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`, {}, { type: record.type, data: content, ttl: TTL });
    },

    async deleteRecord(zone, record) {
      await call("DELETE", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`);
    },
  };
}

export const DIGITALOCEAN_DNS: DnsEntry = {
  name: "digitalocean-dns",
  title: "DigitalOcean DNS",
  credentials: [{ variable: TOKEN_VARIABLE, label: "DNS token", secret: true, shape: TOKEN_SHAPE }],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/digitalocean-dns.md",
  // ns1, ns2 and ns3.digitalocean.com, the name servers of every domain DigitalOcean serves.
  nameServers: /^ns[1-3]\.digitalocean\.com$/,
  caddy: {
    package: "github.com/caddy-dns/digitalocean",
    module: "dns.providers.digitalocean",
    // The module's Provision replaces placeholders in the token, `{env.*}` included.
    directive: [`dns digitalocean {env.${TOKEN_VARIABLE}}`],
    environment: (credentials) => ({ [TOKEN_VARIABLE]: credentials[TOKEN_VARIABLE] ?? "" }),
  },
  apiVariable: API_VARIABLE,
  open: digitalocean,
};
