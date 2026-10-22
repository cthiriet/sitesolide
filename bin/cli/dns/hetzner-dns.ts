/**
 * Hetzner's DNS, the zones of the Hetzner Console, through the Cloud API:
 * https://docs.hetzner.cloud/reference/cloud#zones, whose OpenAPI document
 * is https://docs.hetzner.cloud/cloud.spec.json.
 *
 * NOT THE OLD DNS API. dns.hetzner.com/api/v1, with its Auth-API-Token
 * header, served the zones of the old DNS Console; Hetzner made DNS generally
 * available in the Console and the Cloud API on 10 November 2025, stopped
 * creating zones in the old console that day, and switched it off in May
 * 2026, as announced: in October 2026 its address only redirects to the
 * Console. Its tokens do not work here. A zone is now a resource of a Hetzner
 * Cloud project, like a server, and the API speaks of record sets, RRSets,
 * identified by a name relative to the zone (`@` for the zone itself, `*` for
 * its wildcard) and a type, each holding one or more values.
 *
 * THE TOKEN IS A DNS TOKEN. Setup lays it on the machine, where Caddy renews
 * the wildcard with it, so it is never read from HCLOUD_TOKEN, which the
 * machine provider and the hcloud CLI read and which orders servers. It is
 * SITESOLIDE_DNS_HETZNER_TOKEN, a Read & Write token of a project that holds
 * the zone and nothing else: Hetzner scopes a token by project, never by
 * resource, so the project is what keeps the token away from everything else.
 *
 * What setup asks becomes:
 *
 *   findZone       GET /zones?name=<candidate>, the zone and each parent
 *   listRecords    GET /zones/{id}/rrsets?name=<relative>, every type, one
 *                  record per value of each set
 *   createRecord   POST /zones/{id}/rrsets, TTL 60, the lowest the API takes
 *   updateRecord   GET the set, then POST its set_records with that one value
 *                  replaced and the others kept
 *   deleteRecord   POST remove_records with that one value, which deletes the
 *                  set when it was the last
 *
 * Each write answers an action, which is waited for, a second between reads
 * of GET /zones/actions/{id}, until it succeeds or fails, two minutes at most:
 * the next write would otherwise find the zone locked.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and gives up after a minute. Whatever text comes back
 * from outside is scrubbed of the token before it reaches a message. Lists are
 * read to their end, fifty items a page, the most the API returns, following
 * `meta.pagination.next_page`. Errors are `{"error": {"code", "message",
 * "details"}}`.
 */
import { apiAddress } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.hetzner.cloud/v1";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_HETZNER_DNS_API";

/** sitesolide's own variable: HCLOUD_TOKEN may hold a token that orders servers. */
export const TOKEN_VARIABLE = "SITESOLIDE_DNS_HETZNER_TOKEN";

/** A Cloud API token: 64 letters and digits, the length the hcloud CLI insists on. */
export const TOKEN_SHAPE = /^[A-Za-z0-9]{64}$/;

/** The lowest TTL the API takes: "Must be in between 60s and 2147483647s." */
export const TTL = 60;

/**
 * The Caddy module, at the version that speaks the Cloud API. Caddy's build
 * service registers the package under its old path, without `/v2`, and builds
 * v1.0.0 for it, which spoke the DNS API Hetzner has switched off; it takes a
 * version after `@` and builds that one instead, while `/v2` itself is
 * refused as an unregistered package.
 */
export const CADDY_PACKAGE = "github.com/caddy-dns/hetzner@v2.0.1";

/** How long a write's action is waited for at most, and how often it is read. */
export const WAITS = { actionMs: 2 * 60_000, pollMs: 1_000 };

const TITLE = "Hetzner";

/** The most items a page holds, and the most pages a listing reads. */
const PER_PAGE = 50;
const MAX_PAGES = 500;

export const CREDENTIAL_HELP = [
  "console.hetzner.com, the project that holds the zone, Security, API tokens, Generate API token, Read & Write",
  "a token reaches its whole project: give the zone a project of its own, moved there from the zone list, Transfer to Project",
];

type Pagination = { next_page?: unknown };
type HetznerZone = { id?: unknown; name?: unknown; mode?: unknown };
type HetznerRecord = { value?: unknown; comment?: unknown };
type HetznerSet = { id?: unknown; name?: unknown; type?: unknown; ttl?: unknown; records?: unknown };
type HetznerAction = { id?: unknown; status?: unknown; error?: { code?: unknown; message?: unknown } | null };

/** A name of the zone as the API takes it: `@` for the zone itself, relative otherwise. */
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "@";
  if (!name.endsWith(`.${zone}`)) throw new DnsError(`${name} is not a name of the Hetzner zone ${zone}`, "refused");
  return name.slice(0, -(zone.length + 1));
}

/** A set's name as the interface says it: absolute, lowercase, without a trailing dot. */
export function absoluteName(name: string, zone: string): string {
  const lowered = name.trim().toLowerCase().replace(/\.$/, "");
  return lowered === "@" || lowered === "" ? zone : `${lowered}.${zone}`;
}

/**
 * A record's id: its set's name and type, then its value, which is what
 * finds one value of a set again. The set's own id, `www/AAAA` in the
 * reference, is the first two parts.
 */
export function recordId(name: string, type: string, value: string): string {
  return `${name}/${type}/${value}`;
}

export function parseRecordId(id: string): { name: string; type: string; value: string } {
  const first = id.indexOf("/");
  const second = first === -1 ? -1 : id.indexOf("/", first + 1);
  if (second === -1) throw new DnsError(`${id} is not a record id of the Hetzner provider`, "refused");
  return { name: id.slice(0, first), type: id.slice(first + 1, second), value: id.slice(second + 1) };
}

/** A path segment, `@` and `*` kept as written, as hcloud-go sends them. */
function segment(value: string): string {
  return encodeURIComponent(value).replaceAll("%40", "@");
}

function hetzner(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";
  const { clock } = context;
  const scrub = (text: string): string => (token === "" ? text : text.replaceAll(token, "[token]"));

  /** An error answer, in the words of the interface: the token refused, or the request. */
  function refusal(status: number, body: unknown, method: string, path: string): DnsError {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? scrub(error.code) : "";
    const said = scrub(typeof error?.message === "string" && error.message.trim() !== "" ? error.message.trim() : `HTTP ${status}`);
    const answer = `${status}${code === "" ? "" : ` ${code}`}`;
    if (status === 401) {
      return new DnsError(`${TITLE} refused the token (${answer}): ${said}`, "token", [
        "it is unknown, revoked, or was copied wrong; a token of the old DNS Console, dns.hetzner.com, does not work with the Cloud API",
        ...CREDENTIAL_HELP,
      ]);
    }
    if (status === 403 && (code === "" || code === "forbidden")) {
      return new DnsError(`the ${TITLE} token may not ${method} ${path} (${answer}): ${said}`, "token", [
        "a Read token lists zones but cannot change them: the token needs Read & Write",
      ]);
    }
    if (status === 429) {
      return new DnsError(`${TITLE}'s rate limit is reached (${answer}): ${said}`, "refused", ["a project may make 3600 requests an hour, given back one a second: run setup again in a minute"]);
    }
    if (status >= 500) return new DnsError(`${TITLE} failed to answer ${method} ${path} (${answer}): ${said}`, "refused", [`the failure is on ${TITLE}'s side`]);
    return new DnsError(`${TITLE} refused ${method} ${path} (${answer}): ${said}`, "refused");
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
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
      }
    }
    if (!response.ok) {
      if (parsed === null || typeof parsed !== "object" || !("error" in parsed)) {
        throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
      }
      throw refusal(response.status, parsed, method, path);
    }
    if (parsed === null || typeof parsed !== "object") throw new DnsError(`${TITLE}'s answer to ${method} ${path} is not an object`, "unreachable");
    return parsed as T;
  }

  /** Every page of a listing, `key` naming the list in each answer. */
  async function all<T>(path: string, key: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (let read = 0; read < MAX_PAGES; read++) {
      const answer = await call<Record<string, unknown> & { meta?: { pagination?: Pagination } }>("GET", path, { ...query, page: String(page), per_page: String(PER_PAGE) });
      const list = answer[key];
      if (!Array.isArray(list)) throw new DnsError(`${TITLE}'s answer to GET ${path} holds no ${key}`, "unreachable");
      items.push(...(list as T[]));
      const next = answer.meta?.pagination?.next_page;
      if (next === null || next === undefined || list.length === 0) return items;
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= page) throw new DnsError(`${TITLE}'s answer to GET ${path} names no next page it can follow`, "unreachable");
      page = next;
    }
    throw new DnsError(`GET ${path} went on for more than ${MAX_PAGES} pages`, "refused");
  }

  /** Waits for a write's action to finish; an action that failed is the API saying no. */
  async function settled(action: HetznerAction | undefined, what: string): Promise<void> {
    if (action === undefined || action === null) return;
    const id = typeof action.id === "number" ? action.id : null;
    let current = action;
    const deadline = clock.now() + WAITS.actionMs;
    while (current.status === "running") {
      if (id === null) return;
      if (clock.now() >= deadline) {
        throw new DnsError(`${TITLE} had not finished to ${what} after ${WAITS.actionMs / 1000} s`, "refused", [`its action ${id} may still finish: run setup again, which reads the zone first`]);
      }
      await clock.sleep(WAITS.pollMs);
      current = (await call<{ action?: HetznerAction }>("GET", `/zones/actions/${id}`)).action ?? { status: "error" };
    }
    if (current.status === "error") {
      const code = typeof current.error?.code === "string" ? ` ${scrub(current.error.code)}` : "";
      const said = typeof current.error?.message === "string" ? scrub(current.error.message) : "no reason given";
      throw new DnsError(`${TITLE} could not ${what} (action${code}): ${said}`, "refused");
    }
  }

  const setPath = (zone: ZoneRef, name: string, type: string) => `/zones/${segment(zone.id)}/rrsets/${segment(name)}/${segment(type)}`;

  return {
    async verify() {
      // Any read: 401 for a token Hetzner does not know, whatever the project.
      await call("GET", "/zones", { per_page: "1" });
    },

    async findZone(zone) {
      for (const name of zoneCandidates(zone)) {
        const found = (await all<HetznerZone>("/zones", "zones", { name })).find((candidate) => candidate.name === name);
        if (found === undefined) continue;
        if (typeof found.id !== "number" && typeof found.id !== "string") throw new DnsError(`${TITLE}'s zone ${name} has no id`, "unreachable");
        if (found.mode === "secondary") {
          throw new DnsError(`${TITLE} serves ${name} as a secondary zone`, "refused", [
            "its records come from the primary name servers it copies them from, and the API cannot write them",
            "create the records there, or run setup with --dns manual",
          ]);
        }
        return { id: String(found.id), name };
      }
      throw new DnsError(`no ${TITLE} zone the token can read holds ${zone}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        "a token reaches the zones of its own project alone: make it in the project that holds the zone",
      ]);
    },

    async listRecords(zone, name) {
      const relative = relativeName(name, zone.name);
      const sets = await all<HetznerSet>(`/zones/${segment(zone.id)}/rrsets`, "rrsets", { name: relative });
      // Filtered here as well: what is decided must only ever concern this name.
      return sets
        .filter((set) => typeof set.name === "string" && set.name.toLowerCase() === relative && typeof set.type === "string")
        .flatMap((set) =>
          (Array.isArray(set.records) ? (set.records as HetznerRecord[]) : [])
            .filter((record) => typeof record.value === "string")
            .map(
              (record): DnsRecord => ({
                id: recordId(set.name as string, set.type as string, record.value as string),
                type: set.type as string,
                name: absoluteName(set.name as string, zone.name),
                content: record.value as string,
                proxied: false,
                ttl: typeof set.ttl === "number" ? set.ttl : 0,
              }),
            ),
        );
    },

    async createRecord(zone, record) {
      const answer = await call<{ action?: HetznerAction }>("POST", `/zones/${segment(zone.id)}/rrsets`, {}, {
        name: relativeName(record.name, zone.name),
        type: record.type,
        ttl: TTL,
        records: [{ value: record.content }],
      });
      await settled(answer.action, `create ${record.name} ${record.type}`);
    },

    async updateRecord(zone, record, content) {
      const { name, type, value } = parseRecordId(record.id);
      const path = setPath(zone, name, type);
      const set = (await call<{ rrset?: HetznerSet }>("GET", path)).rrset;
      const records = Array.isArray(set?.records) ? (set.records as HetznerRecord[]) : [];
      if (!records.some((entry) => entry.value === value)) {
        throw new DnsError(`${record.name} ${type} ${value} is no longer in its Hetzner record set`, "refused", ["the zone changed while setup was reading it: run setup again"]);
      }
      // That one value replaced, every other value of the set kept with its comment.
      const replaced: { value: string; comment?: string }[] = [];
      for (const entry of records) {
        const next = entry.value === value ? content : String(entry.value);
        if (replaced.some((kept) => kept.value === next)) continue;
        replaced.push({ value: next, ...(typeof entry.comment === "string" && entry.comment !== "" && entry.value !== value ? { comment: entry.comment } : {}) });
      }
      const answer = await call<{ action?: HetznerAction }>("POST", `${path}/actions/set_records`, {}, { records: replaced });
      await settled(answer.action, `update ${record.name} ${type}`);
    },

    async deleteRecord(zone, record) {
      const { name, type, value } = parseRecordId(record.id);
      const answer = await call<{ action?: HetznerAction }>("POST", `${setPath(zone, name, type)}/actions/remove_records`, {}, { records: [{ value }] });
      await settled(answer.action, `delete ${record.name} ${type} ${value}`);
    },
  };
}

export const HETZNER_DNS: DnsEntry = {
  name: "hetzner-dns",
  title: "Hetzner DNS",
  credentials: [{ variable: TOKEN_VARIABLE, label: "API token", secret: true, shape: TOKEN_SHAPE }],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/hetzner-dns.md",
  // The primary name servers, then the secondary ones, which Hetzner's
  // documentation says still serve older primary zones. The konsoleH ones,
  // ns1.your-server.de and its two companions, serve web hosting, which the
  // API does not reach.
  nameServers: /^(?:hydrogen\.ns\.hetzner\.com|oxygen\.ns\.hetzner\.com|helium\.ns\.hetzner\.de|ns1\.first-ns\.de|robotns2\.second-ns\.de|robotns3\.second-ns\.com)$/,
  caddy: {
    package: CADDY_PACKAGE,
    module: "dns.providers.hetzner",
    // The module's Caddyfile syntax, `hetzner [<api_token>]`, its token read
    // through Caddy's replacer at provisioning; Hetzner's name servers take
    // a while to publish a change, which the module's README answers with a delay.
    directive: [`dns hetzner {env.${TOKEN_VARIABLE}}`, "propagation_delay 30s"],
    environment: (credentials) => ({ [TOKEN_VARIABLE]: credentials[TOKEN_VARIABLE] ?? "" }),
  },
  apiVariable: API_VARIABLE,
  open: hetzner,
};
