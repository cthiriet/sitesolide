/**
 * Akamai's Linode DNS Manager, through the Linode API v4:
 * https://techdocs.akamai.com/linode-api/reference/get-domains, whose OpenAPI
 * document is github.com/linode/linode-api-openapi. A zone is a "domain"
 * there, listed by GET /v4/domains with a numeric id; its records are under
 * /v4/domains/{domainId}/records, named relative to it, the empty name for the
 * domain itself and `*` for its wildcard, their address in `target` and their
 * TTL in `ttl_sec`.
 *
 * THE TOKEN IS A DNS TOKEN, and nothing more. Setup lays it on the machine,
 * where Caddy renews the wildcard with it, so it is never read from
 * LINODE_TOKEN or LINODE_CLI_TOKEN, which the machine provider and linode-cli
 * read and which may order Linodes. It is SITESOLIDE_DNS_LINODE_TOKEN, a
 * personal access token with Read/Write on Domains and No Access on anything
 * else: every record operation asks for the OAuth scope `domains:read_write`,
 * and nothing more. Made by the account's own user, it reaches every domain of
 * the account; made by a restricted user granted Read-Write on the zone's
 * domain alone (the grants' `domain` list, one entry a domain), it reaches
 * that domain alone.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and gives up after a minute. Whatever text comes back
 * from outside is scrubbed of the token before it reaches a message. Lists are
 * read page by page, five hundred items a page, the most the API returns,
 * until `page` reaches `pages`. Errors are `{"errors": [{"reason", "field"}]}`;
 * a token without the scope an operation needs is told 401 "not authorized to
 * use this endpoint" by the API, where the reference says 403.
 *
 * DNSControl's Linode provider notes that a record's TTL is not saved when it
 * is created; the reference says nothing of it. A record whose answer carries
 * another TTL than the one asked has it set again, at once.
 */
import { apiAddress } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.linode.com/v4";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_LINODE_DNS_API";

/** sitesolide's own variable: LINODE_TOKEN may hold a token that orders machines. */
export const TOKEN_VARIABLE = "SITESOLIDE_DNS_LINODE_TOKEN";

/** A personal access token: 64 hexadecimal characters today, any run of letters and digits accepted. */
export const TOKEN_SHAPE = /^[A-Za-z0-9]{32,256}$/;

/**
 * The lowest TTL the reference lists for a record: "Valid values are 300,
 * 3600, 7200, ..., any other value will be rounded to the nearest valid
 * value."
 */
export const TTL = 300;

const TITLE = "Akamai";

/** The most items a page holds (the least is 25), and the most pages a listing reads. */
const PAGE_SIZE = 500;
const MAX_PAGES = 200;

export const CREDENTIAL_HELP = [
  "cloud.linode.com, your username, API Tokens, Create a Personal Access Token: Read/Write on Domains, No Access on everything else",
  "pick the expiry knowing the machine renews its certificate with it every two months; made by a restricted user granted Read-Write on this domain alone, it reaches nothing else",
];

type LinodeDomain = { id?: unknown; domain?: unknown; type?: unknown };
type LinodeRecord = { id?: unknown; type?: unknown; name?: unknown; target?: unknown; ttl_sec?: unknown };

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
  if (!name.endsWith(`.${domain}`)) throw new DnsError(`${name} is not a name of the ${TITLE} domain ${domain}`, "refused");
  return name.slice(0, -(domain.length + 1));
}

function linode(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";
  const scrub = (text: string): string => (token === "" ? text : text.replaceAll(token, "[token]"));

  /** An error answer, in the words of the interface: the token refused, or the request. */
  function refusal(status: number, body: unknown, method: string, path: string): DnsError {
    const errors = (body as { errors?: unknown } | null)?.errors;
    const list = Array.isArray(errors) ? (errors as { reason?: unknown; field?: unknown }[]) : [];
    const said = scrub(
      list
        .map((entry) => (typeof entry.reason !== "string" ? "" : typeof entry.field === "string" ? `${entry.field}: ${entry.reason}` : entry.reason))
        .filter((reason) => reason !== "")
        .join("; ") || `HTTP ${status}`,
    );
    const scope = /not authori[sz]ed to use this endpoint/i.test(said);
    if (status === 401 && !scope) {
      return new DnsError(`${TITLE} refused the token (401): ${said}`, "token", ["it is unknown, revoked, expired, or was copied wrong", ...CREDENTIAL_HELP]);
    }
    if (status === 401 || status === 403) {
      return new DnsError(`the ${TITLE} token may not ${method} ${path} (${status}): ${said}`, "token", [
        "the token needs Read/Write on Domains, and its user Read-Write on the zone's domain",
      ]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (429): ${said}`, "refused", ["run setup again in a minute"]);
    }
    return new DnsError(`${TITLE} refused ${method} ${path} (${status}): ${said}`, "refused");
  }

  /** One call: the token in its header, JSON both ways. */
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

  /** Every page of a list, until `page` reaches `pages`. */
  async function listAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await call<{ data?: unknown; pages?: unknown }>("GET", path, { page: String(page), page_size: String(PAGE_SIZE) });
      if (!Array.isArray(answer.data)) throw new DnsError(`${host}'s answer to GET ${path} holds no list`, "unreachable");
      items.push(...(answer.data as T[]));
      const pages = typeof answer.pages === "number" ? answer.pages : 1;
      if (page >= pages || answer.data.length === 0) return items;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const recordsPath = (zone: ZoneRef) => `/domains/${encodeURIComponent(zone.id)}/records`;

  return {
    async verify() {
      if (token === "") throw new DnsError(`no ${TITLE} token: set ${TOKEN_VARIABLE}`, "token", CREDENTIAL_HELP);
      const answer = await call<{ data?: unknown }>("GET", "/domains", { page: "1", page_size: "25" });
      if (!Array.isArray(answer.data)) throw new DnsError(`${host}'s answer to GET /domains holds no list`, "unreachable");
    },

    async findZone(zone) {
      const wanted = zone.trim().toLowerCase().replace(/\.$/, "");
      const domains = await listAll<LinodeDomain>("/domains");
      for (const candidate of zoneCandidates(wanted)) {
        const found = domains.find((domain) => typeof domain.domain === "string" && domain.domain.toLowerCase().replace(/\.$/, "") === candidate);
        if (found === undefined) continue;
        if (found.type === "slave") {
          throw new DnsError(`${TITLE} serves ${candidate} as a secondary copy of another name server`, "refused", [
            "its records are edited at its primary, not through Linode's API: use --dns for that provider, or --dns manual",
          ]);
        }
        return { id: String(found.id), name: candidate };
      }
      throw new DnsError(`no ${TITLE} domain the token can read holds ${wanted}`, "zone", [
        `looked for: ${zoneCandidates(wanted).join(", ")}`,
        "check --zone, and that the domain is in Cloud Manager's Domains, readable by the token's user",
      ]);
    },

    async listRecords(zone, name) {
      const wanted = name.toLowerCase();
      const records = await listAll<LinodeRecord>(recordsPath(zone));
      return records
        .map((record): DnsRecord => ({
          id: String(record.id),
          type: String(record.type ?? "").toUpperCase(),
          name: absoluteName(String(record.name ?? ""), zone.name),
          content: String(record.target ?? ""),
          proxied: false,
          ttl: typeof record.ttl_sec === "number" ? record.ttl_sec : 0,
        }))
        .filter((record) => record.name === wanted);
    },

    async createRecord(zone, record) {
      const created = await call<LinodeRecord>("POST", recordsPath(zone), {}, { type: record.type, name: relativeName(record.name, zone.name), target: record.content, ttl_sec: TTL });
      if (created.ttl_sec !== TTL && (typeof created.id === "number" || typeof created.id === "string")) {
        await call("PUT", `${recordsPath(zone)}/${encodeURIComponent(String(created.id))}`, {}, { ttl_sec: TTL });
      }
    },

    async updateRecord(zone, record, content) {
      await call("PUT", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`, {}, { target: content, ttl_sec: TTL });
    },

    async deleteRecord(zone, record) {
      await call("DELETE", `${recordsPath(zone)}/${encodeURIComponent(record.id)}`);
    },
  };
}

export const LINODE_DNS: DnsEntry = {
  name: "linode-dns",
  title: "Akamai (Linode) DNS Manager",
  credentials: [{ variable: TOKEN_VARIABLE, label: "DNS token", secret: true, shape: TOKEN_SHAPE }],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/linode-dns.md",
  // ns1 to ns5.linode.com, the name servers of every domain the DNS Manager serves.
  nameServers: /^ns[1-5]\.linode\.com$/,
  caddy: {
    package: "github.com/caddy-dns/linode",
    module: "dns.providers.linode",
    directive: [
      // The module's Provision replaces placeholders in the token, `{env.*}` included.
      `dns linode {env.${TOKEN_VARIABLE}}`,
      // The challenge's TXT records otherwise take the domain's default TTL,
      // a day, which resolvers may keep through the next attempt: the
      // module's own README sets this, and Linode rounds what it does not
      // take to its nearest value.
      "dns_ttl 30s",
      // Linode's name servers have been said to load a change within a
      // minute, and every quarter of an hour: Caddy waits for them rather
      // than give up after its default two minutes.
      "propagation_timeout 20m",
    ],
    environment: (credentials) => ({ [TOKEN_VARIABLE]: credentials[TOKEN_VARIABLE] ?? "" }),
  },
  apiVariable: API_VARIABLE,
  open: linode,
};
