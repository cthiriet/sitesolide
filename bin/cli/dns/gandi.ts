/**
 * Gandi LiveDNS, through Gandi's public API v5:
 * https://api.gandi.net/docs/livedns/, its authentication at
 * https://api.gandi.net/docs/authentication/.
 *
 * LiveDNS speaks of record sets: a name relative to the domain (`@` for the
 * domain itself, `*` for its wildcard, `*.apps` for a wildcard under it) and a
 * type, holding one or more values and one TTL. A record here is one value of
 * a set, and its id is the set's name and type, then the value, which is what
 * finds that one value again.
 *
 * THE TOKEN IS A PERSONAL ACCESS TOKEN, sent as `Authorization: Bearer`. The
 * API keys sent as `Authorization: Apikey` are deprecated by Gandi, could not
 * be scoped, and the Caddy module no longer takes them. Setup lays the token
 * on the machine, where Caddy renews the wildcard with it, so it is
 * SITESOLIDE_DNS_GANDI_TOKEN and never a variable Gandi's own tools read: a
 * token restricted to the domain, with the permission "Manage domain name
 * technical configurations" alone. A Gandi token expires, after a year at
 * most: docs/dns/gandi.md says what that means for the renewals.
 *
 * What setup asks becomes:
 *
 *   verify         GET /livedns/domains, one item: 401 or 403 for a token
 *                  Gandi does not know or that has expired
 *   findZone       GET /livedns/domains, every page, the zone or a parent
 *   listRecords    GET /livedns/domains/{fqdn}/records, every page, filtered
 *                  on the name, one record per value of each set
 *   createRecord   POST .../records/{name}/{type}, TTL 300, the lowest the
 *                  API takes; a set that appeared since the read is a 409
 *   updateRecord   GET the set, then PUT it with that one value replaced and
 *                  the others kept
 *   deleteRecord   GET the set, then PUT it without that value, or DELETE it
 *                  when it was the last
 *
 * The addresses the API gives in its answers, `domain_records_href`, are never
 * followed: every path is built from the API's own address, the token never
 * sent anywhere an answer names.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and gives up after a minute. Whatever text comes back
 * from outside is scrubbed of the token before it reaches a message. Lists are
 * read to their end, `page` and `per_page` in the query, until the
 * `Total-Count` header is reached or a page comes back empty. Errors are
 * `{"code", "message", "object", "cause"}`, `errors` added on a 400, or
 * `{"message"}` alone on a 401.
 */
import { apiAddress } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.gandi.net/v5";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_GANDI_DNS_API";

/** sitesolide's own variable: whatever Gandi's tools read may hold a broader token. */
export const TOKEN_VARIABLE = "SITESOLIDE_DNS_GANDI_TOKEN";

/**
 * A personal access token: Gandi documents no format, and its own example is
 * forty hexadecimal digits. Letters, digits and the few signs a token is made
 * of, on one line: nothing systemd would read otherwise than written in
 * Caddy's environment file.
 */
export const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{20,256}$/;

/** The lowest TTL LiveDNS takes: `rrset_ttl`, minimum 300, maximum 2592000. */
export const TTL = 300;

const TITLE = "Gandi";

/** The most items a page is asked for, and the most pages a listing reads. */
const PER_PAGE = 100;
const MAX_PAGES = 100;

export const CREDENTIAL_HELP = [
  "admin.gandi.net, Organizations, the organization that owns the domain, Sharing, Create a token",
  "Restrict to selected products: this domain alone; permission Manage domain name technical configurations, nothing else",
  "it expires, after a year at most: make a new one before then and run setup again with it",
];

type GandiDomain = { fqdn?: unknown };
type GandiSet = { rrset_name?: unknown; rrset_type?: unknown; rrset_ttl?: unknown; rrset_values?: unknown };
type GandiFailure = { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };

/** A name of the domain as the API takes it: `@` for the domain itself, relative otherwise. */
export function relativeName(name: string, zone: string): string {
  const lowered = name.toLowerCase();
  if (lowered === zone) return "@";
  if (!lowered.endsWith(`.${zone}`)) throw new DnsError(`${name} is not a name of the ${TITLE} domain ${zone}`, "refused");
  return lowered.slice(0, -(zone.length + 1));
}

/** A set's name as the interface says it: absolute, lowercase, without a trailing dot. */
export function absoluteName(name: string, zone: string): string {
  const lowered = name.trim().toLowerCase().replace(/\.$/, "");
  return lowered === "@" || lowered === "" ? zone : `${lowered}.${zone}`;
}

/** A record's id: its set's relative name and type, then its value, which may hold anything. */
export function recordId(name: string, type: string, value: string): string {
  return `${name}/${type}/${value}`;
}

export function parseRecordId(id: string): { name: string; type: string; value: string } {
  const first = id.indexOf("/");
  const second = first === -1 ? -1 : id.indexOf("/", first + 1);
  if (second === -1) throw new DnsError(`${id} is not a record id of the ${TITLE} provider`, "refused");
  return { name: id.slice(0, first), type: id.slice(first + 1, second), value: id.slice(second + 1) };
}

/** A path segment, `@` kept as written, as Gandi's own examples and libdns/gandi send it. */
function segment(value: string): string {
  return encodeURIComponent(value).replaceAll("%40", "@");
}

/** What a set holds, its values as strings. */
function valuesOf(set: GandiSet | null): string[] {
  return Array.isArray(set?.rrset_values) ? (set.rrset_values as unknown[]).filter((value): value is string => typeof value === "string") : [];
}

function gandi(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";
  const scrub = (text: string): string => (token === "" ? text : text.replaceAll(token, "[token]"));

  /** The API's own words: its message, and the fields a 400 names. */
  function said(body: GandiFailure, status: number): string {
    const message = typeof body.message === "string" && body.message.trim() !== "" ? body.message.trim() : `HTTP ${status}`;
    const fields = Array.isArray(body.errors)
      ? (body.errors as { name?: unknown; description?: unknown }[])
          .map((entry) => [entry.name, entry.description].filter((part) => typeof part === "string" && part !== "").join(": "))
          .filter((line) => line !== "")
      : [];
    return scrub([message, ...fields].join("; "));
  }

  /** An error answer, in the words of the interface: the token refused, or the request. */
  function refusal(status: number, body: GandiFailure, method: string, path: string): DnsError {
    const words = said(body, status);
    if (status === 401) {
      return new DnsError(`${TITLE} refused the token (401): ${words}`, "token", ["it is not a personal access token Gandi knows", ...CREDENTIAL_HELP]);
    }
    if (status === 403) {
      // Gandi's 403 covers a token it does not know, one that has expired,
      // and one without the permission the request needs.
      return new DnsError(`the ${TITLE} token may not ${method} ${path} (403): ${words}`, "token", [
        "it is unknown or expired, or lacks Manage domain name technical configurations on the domain",
        ...CREDENTIAL_HELP,
      ]);
    }
    if (status === 404 && path.includes("/records")) {
      return new DnsError(`${TITLE} found nothing at ${method} ${path} (404): ${words}`, "refused", [
        "a domain of another organization than the default one of the token's user answers 404 on its records: see docs/dns/gandi.md",
      ]);
    }
    if (status === 409) {
      return new DnsError(`${TITLE} refused ${method} ${path} (409): ${words}`, "refused", ["the record set appeared since setup read the zone: run setup again, which reads it first"]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (429): ${words}`, "refused", ["Gandi takes 1000 requests a minute from one address: run setup again in a minute"]);
    }
    if (status >= 500) return new DnsError(`${TITLE} failed to answer ${method} ${path} (${status}): ${words}`, "refused", [`the failure is on ${TITLE}'s side`]);
    return new DnsError(`${TITLE} refused ${method} ${path} (${status}): ${words}`, "refused");
  }

  const foreign = (status: number, method: string, path: string) =>
    new DnsError(`${host} answered HTTP ${status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");

  /**
   * One call: the token in its header, JSON both ways. With `absent`, a 404
   * answers null, for a record set that may not exist.
   */
  async function call(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown; absent?: boolean } = {},
  ): Promise<{ parsed: unknown; headers: Headers }> {
    const search = new URLSearchParams(options.query ?? {}).toString();
    let response: Response;
    let text: string;
    try {
      response = await context.fetcher(`${base}${path}${search === "" ? "" : `?${search}`}`, {
        method,
        // The token follows no address an answer names.
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(60_000),
      });
      text = await response.text();
    } catch (error) {
      throw new DnsError(scrub(`cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
    }
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw foreign(response.status, method, path);
      }
    }
    if (!response.ok) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw foreign(response.status, method, path);
      if (response.status === 404 && options.absent === true) return { parsed: null, headers: response.headers };
      throw refusal(response.status, parsed as GandiFailure, method, path);
    }
    return { parsed, headers: response.headers };
  }

  /** Every page of a listing: up to Total-Count, or to the first empty page when the header is missing. */
  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { parsed, headers } = await call("GET", path, { query: { page: String(page), per_page: String(PER_PAGE) } });
      if (!Array.isArray(parsed)) throw new DnsError(`${TITLE}'s answer to GET ${path} is not a list`, "unreachable");
      items.push(...(parsed as T[]));
      const total = Number(headers.get("Total-Count") ?? Number.NaN);
      if (parsed.length === 0 || (Number.isFinite(total) && items.length >= total)) return items;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const recordsPath = (zone: ZoneRef) => `/livedns/domains/${segment(zone.id)}/records`;
  const setPath = (zone: ZoneRef, name: string, type: string) => `${recordsPath(zone)}/${segment(name)}/${segment(type)}`;

  /** One record set, or null when the domain holds none of that name and type. */
  async function readSet(zone: ZoneRef, name: string, type: string): Promise<GandiSet | null> {
    const { parsed } = await call("GET", setPath(zone, name, type), { absent: true });
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new DnsError(`${TITLE}'s answer to GET ${setPath(zone, name, type)} is not a record set`, "unreachable");
    return parsed as GandiSet;
  }

  return {
    async verify() {
      // Any read: 401 without a token Gandi knows, 403 for one it refuses.
      const { parsed } = await call("GET", "/livedns/domains", { query: { page: "1", per_page: "1" } });
      if (!Array.isArray(parsed)) throw new DnsError(`${TITLE}'s answer to GET /livedns/domains is not a list`, "unreachable");
    },

    async findZone(zone) {
      const held = new Set(
        (await all<GandiDomain>("/livedns/domains")).filter((domain) => typeof domain.fqdn === "string").map((domain) => (domain.fqdn as string).toLowerCase().replace(/\.$/, "")),
      );
      for (const name of zoneCandidates(zone)) {
        if (held.has(name)) return { id: name, name };
      }
      throw new DnsError(`no ${TITLE} LiveDNS domain the token can read holds ${zone}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        "the domain must be served by LiveDNS, and the token restricted to it, made in the organization that owns it",
      ]);
    },

    async listRecords(zone, name) {
      const relative = relativeName(name, zone.name);
      const sets = await all<GandiSet>(recordsPath(zone));
      // Filtered here: what is decided must only ever concern this name.
      return sets
        .filter((set) => typeof set.rrset_name === "string" && set.rrset_name.toLowerCase() === relative && typeof set.rrset_type === "string")
        .flatMap((set) =>
          valuesOf(set).map(
            (value): DnsRecord => ({
              id: recordId(relative, set.rrset_type as string, value),
              type: set.rrset_type as string,
              name: absoluteName(relative, zone.name),
              content: value,
              proxied: false,
              ttl: typeof set.rrset_ttl === "number" ? set.rrset_ttl : 0,
            }),
          ),
        );
    },

    async createRecord(zone, record) {
      // POST, never PUT: a set someone created since the read is a 409, not overwritten.
      await call("POST", setPath(zone, relativeName(record.name, zone.name), record.type), { body: { rrset_values: [record.content], rrset_ttl: TTL } });
    },

    async updateRecord(zone, record, content) {
      const { name, type, value } = parseRecordId(record.id);
      const values = valuesOf(await readSet(zone, name, type));
      if (!values.includes(value)) {
        throw new DnsError(`${record.name} ${type} ${value} is no longer in its ${TITLE} record set`, "refused", ["the zone changed while setup was reading it: run setup again"]);
      }
      // That one value replaced, every other value of the set kept.
      const replaced = [...new Set(values.map((entry) => (entry === value ? content : entry)))];
      await call("PUT", setPath(zone, name, type), { body: { rrset_values: replaced, rrset_ttl: TTL } });
    },

    async deleteRecord(zone, record) {
      const { name, type, value } = parseRecordId(record.id);
      const set = await readSet(zone, name, type);
      const values = valuesOf(set);
      if (!values.includes(value)) return;
      const remaining = values.filter((entry) => entry !== value);
      if (remaining.length === 0) {
        await call("DELETE", setPath(zone, name, type));
        return;
      }
      // The other values kept, with the set's own TTL: only that value goes.
      const ttl = typeof set?.rrset_ttl === "number" && set.rrset_ttl >= TTL ? set.rrset_ttl : TTL;
      await call("PUT", setPath(zone, name, type), { body: { rrset_values: remaining, rrset_ttl: ttl } });
    },
  };
}

export const GANDI_DNS: DnsEntry = {
  name: "gandi",
  title: "Gandi LiveDNS",
  credentials: [{ variable: TOKEN_VARIABLE, label: "personal access token", secret: true, shape: TOKEN_SHAPE }],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/gandi.md",
  // LiveDNS's name servers, three per domain, `ns-<number>-<a, b or c>.gandi.net`:
  // gandi.com is served by ns-151-a, ns-193-b and ns-165-c. The classic DNS's,
  // a.dns.gandi.net and its companions, serve zones the API does not reach.
  nameServers: /^ns-\d+-[abc]\.gandi\.net$/,
  caddy: {
    package: "github.com/caddy-dns/gandi",
    module: "dns.providers.gandi",
    // The module's Caddyfile syntax, `gandi [<bearer_token>]`: the token is
    // sent as a Bearer, and read through Caddy's replacer at provisioning.
    directive: [`dns gandi {env.${TOKEN_VARIABLE}}`],
    environment: (credentials) => ({ [TOKEN_VARIABLE]: credentials[TOKEN_VARIABLE] ?? "" }),
  },
  apiVariable: API_VARIABLE,
  open: gandi,
};
