/**
 * Porkbun's DNS, the zones Porkbun holds for the domains registered with it,
 * through its API v3: https://porkbun.com/api/json/v3/documentation, whose
 * OpenAPI document is https://porkbun.com/api/json/v3/spec (3.63 in October
 * 2026) and whose plain text reference is https://porkbun.com/llms-full.txt.
 *
 * THE ADDRESS IS api.porkbun.com. The API's old address,
 * porkbun.com/api/json/v3, answered a 403 page in October 2026; the Caddy
 * module's libdns/porkbun speaks the new one.
 *
 * THE KEYS TRAVEL IN HEADERS. The API long took them in the JSON body of a
 * POST; it now takes `X-API-Key` and `X-Secret-API-Key` as well, the form its
 * documentation prefers, and every read as a GET. That is the only form used
 * here: the keys are never in a body, a URL, a message or an error, and every
 * body this file sends holds nothing but the record.
 *
 * THE KEY IS A DNS KEY. Setup lays it on the machine, where Caddy renews the
 * wildcard with it, so it is read from SITESOLIDE_DNS_PORKBUN_API_KEY and
 * SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY, never from the variables Porkbun's
 * own tools read: a key made for this, with the DNS permission alone (read
 * comes with every key) and this domain alone among its allowed domains. The
 * domain must also have API Access turned on, in Domain Management: without
 * it, no key reaches its records.
 *
 * What setup asks becomes:
 *
 *   verify         GET /ping, which says whether the keys are valid and
 *                  which permissions they carry: without `dns`, refused here
 *   findZone       GET /domain/listAll, every page, the zone or a parent
 *   listRecords    GET /dns/retrieve/{domain}, every record of the domain,
 *                  filtered on the name: Porkbun names them in full
 *   createRecord   POST /dns/create/{domain}, the name relative to the
 *                  domain, empty for the domain itself, TTL 600
 *   updateRecord   POST /dns/edit/{domain}/{id}, name, type, content and TTL
 *   deleteRecord   POST /dns/delete/{domain}/{id}
 *
 * Every call follows no redirect and gives up after a minute. Answers are
 * `{"status": "SUCCESS", ...}` or `{"status": "ERROR", "code", "message"}`,
 * mostly with HTTP 400, 403 for what a key's restrictions forbid, 429 for the
 * rate limit: what decides is `code`, never the message, which is only
 * quoted, scrubbed of both keys.
 */
import { apiAddress } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://api.porkbun.com/api/json/v3";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_PORKBUN_DNS_API";

/** sitesolide's own variables: whatever Porkbun's tools read may hold a key that buys domains. */
export const API_KEY_VARIABLE = "SITESOLIDE_DNS_PORKBUN_API_KEY";
export const SECRET_KEY_VARIABLE = "SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY";

/**
 * Porkbun's keys, `pk1_` and `sk1_` then 64 hexadecimal digits (`pk1_sb_` for
 * a sandbox key): the prefix tells the two apart, so that one pasted in the
 * other's place is refused before anything leaves.
 */
export const API_KEY_SHAPE = /^pk\d+_[A-Za-z0-9_]{16,256}$/;
export const SECRET_KEY_SHAPE = /^sk\d+_[A-Za-z0-9_]{16,256}$/;

/** The lowest TTL Porkbun takes, "determined by account settings (typically 600)", and what the Caddy module sends. */
export const TTL = 600;

const TITLE = "Porkbun";

/** The most pages a listing reads: a thousand domains each. */
const MAX_PAGES = 100;

export const CREDENTIAL_HELP = [
  "porkbun.com, Account, API Access: a key with the DNS permission alone, and this domain alone in its allowed domains",
  "then Account, Domain Management, the domain's Details, API Access: on, or the key reaches none of its records",
];

/**
 * The codes of keys refused: unknown, deleted, mistyped, or missing. /ping
 * answers `INVALID_API_KEYS`, the other endpoints `INVALID_API_KEYS_001` for
 * an unknown key and `_002` for a secret that does not match it.
 */
const KEY_CODES = new Set(["API_KEY_REQUIRED", "INVALID_API_KEYS", "INVALID_API_KEYS_001", "INVALID_API_KEYS_002", "MISSING_SECRETAPIKEY", "INVALID_TOKEN", "INVALID_USER"]);

type Answer = Record<string, unknown> & { status?: unknown; code?: unknown; message?: unknown };
type PorkbunRecord = { id?: unknown; name?: unknown; type?: unknown; content?: unknown; ttl?: unknown };

/** A name of the domain as the API takes it: empty for the domain itself, relative otherwise. */
export function relativeName(name: string, domain: string): string {
  const lowered = name.toLowerCase();
  if (lowered === domain) return "";
  if (!lowered.endsWith(`.${domain}`)) throw new DnsError(`${name} is not a name of the ${TITLE} domain ${domain}`, "refused");
  return lowered.slice(0, -(domain.length + 1));
}

function porkbun(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const apiKey = context.credentials[API_KEY_VARIABLE] ?? "";
  const secretKey = context.credentials[SECRET_KEY_VARIABLE] ?? "";
  const scrub = (text: string): string => [apiKey, secretKey].filter((key) => key !== "").reduce((scrubbed, key) => scrubbed.replaceAll(key, "[key]"), text);

  /** An error answer, by its code: the keys refused, a restriction of theirs, or the request. */
  function refusal(status: number, answer: Answer, headers: Headers, method: string, path: string): DnsError {
    const code = typeof answer.code === "string" ? scrub(answer.code) : "";
    const words = scrub(typeof answer.message === "string" && answer.message.trim() !== "" ? answer.message.trim() : `HTTP ${status}`);
    const said = `(${status}${code === "" ? "" : ` ${code}`}): ${words}`;
    if (KEY_CODES.has(code)) {
      return new DnsError(`${TITLE} refused the API keys ${said}`, "token", [
        "they are unknown or deleted, or were copied wrong: the secret key is shown once, when the key is made",
        ...CREDENTIAL_HELP,
      ]);
    }
    if (code === "IP_NOT_ALLOWED") {
      return new DnsError(`the ${TITLE} API key may not be used from this address ${said}`, "token", [
        "its IP allowlist must hold the address of the workstation that runs setup, and the machine's, whose Caddy renews the certificate",
      ]);
    }
    if (code === "INSUFFICIENT_SCOPE") {
      return new DnsError(`the ${TITLE} API key may not ${method} ${path} ${said}`, "token", ["the key needs the DNS permission: porkbun.com, Account, API Access, the key's gear"]);
    }
    if (code === "DOMAIN_NOT_ALLOWED") {
      return new DnsError(`the ${TITLE} API key may not reach that domain ${said}`, "token", ["the domain must be among the key's allowed domains: porkbun.com, Account, API Access, the key's gear"]);
    }
    if (code === "API_ACCESS_DISABLED") {
      return new DnsError(`${TITLE} refused ${method} ${path} ${said}`, "refused", ["turn API Access on for the domain: porkbun.com, Account, Domain Management, the domain's Details, API Access"]);
    }
    if (status === 429 || code === "RATE_LIMIT_EXCEEDED") {
      const wait = Number(headers.get("Retry-After"));
      return new DnsError(`${TITLE}'s rate limit is reached ${said}`, "refused", [`run setup again in ${Number.isFinite(wait) && wait > 0 ? `${Math.ceil(wait)} seconds` : "a minute"}`]);
    }
    if (status >= 500) return new DnsError(`${TITLE} failed to answer ${method} ${path} ${said}`, "refused", [`the failure is on ${TITLE}'s side`]);
    return new DnsError(`${TITLE} refused ${method} ${path} ${said}`, "refused");
  }

  const foreign = (status: number, method: string, path: string) =>
    new DnsError(`${host} answered HTTP ${status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");

  /** One call: the keys in their headers, a GET for a read, a POST with the record alone for a write. */
  async function call(method: "GET" | "POST", path: string, options: { query?: Record<string, string>; body?: Record<string, unknown> } = {}): Promise<Answer> {
    const search = new URLSearchParams(options.query ?? {}).toString();
    let response: Response;
    let text: string;
    try {
      response = await context.fetcher(`${base}${path}${search === "" ? "" : `?${search}`}`, {
        method,
        // The keys follow no address an answer names.
        redirect: "error",
        headers: {
          "X-API-Key": apiKey,
          "X-Secret-API-Key": secretKey,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        // A POST always carries JSON, `{}` at least: the API refuses an empty body.
        ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
      text = await response.text();
    } catch (error) {
      throw new DnsError(scrub(`cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw foreign(response.status, method, path);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Answer).status !== "string") throw foreign(response.status, method, path);
    const answer = parsed as Answer;
    if (answer.status === "SUCCESS" && response.ok) return answer;
    if (answer.status !== "ERROR" && answer.status !== "SUCCESS") throw foreign(response.status, method, path);
    throw refusal(response.status, answer, response.headers, method, path);
  }

  /** Every domain of the account, a thousand a page, `start` the offset, until a page comes back empty. */
  async function domains(): Promise<string[]> {
    const names: string[] = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await call("GET", "/domain/listAll", { query: { start: String(start) } });
      if (!Array.isArray(answer.domains)) throw new DnsError(`${TITLE}'s answer to GET /domain/listAll holds no domains`, "unreachable");
      const listed = answer.domains as { domain?: unknown }[];
      if (listed.length === 0) return names;
      for (const entry of listed) if (typeof entry.domain === "string") names.push(entry.domain.toLowerCase().replace(/\.$/, ""));
      start += listed.length;
    }
    throw new DnsError(`GET /domain/listAll went on for more than ${MAX_PAGES} pages`, "refused");
  }

  const domainOf = (zone: ZoneRef) => encodeURIComponent(zone.id);
  const idOf = (record: DnsRecord) => {
    if (!/^[0-9]+$/.test(record.id)) throw new DnsError(`${record.id} is not a record id of the ${TITLE} provider`, "refused");
    return record.id;
  };

  return {
    async verify() {
      const answer = await call("GET", "/ping");
      // Without valid keys, /ping only gives the caller's address back.
      if (answer.credentialsValid !== true) {
        throw new DnsError(`${TITLE} did not take the API keys: /ping answered without validating them`, "token", CREDENTIAL_HELP);
      }
      const scopes = Array.isArray(answer.scopes) ? (answer.scopes as unknown[]).filter((scope): scope is string => typeof scope === "string") : null;
      if (scopes !== null && !scopes.includes("dns") && !scopes.includes("full")) {
        throw new DnsError(`the ${TITLE} API key may not change DNS records: its permissions are ${scopes.join(", ") || "none"}`, "token", [
          "give it the DNS permission: porkbun.com, Account, API Access, the key's gear",
        ]);
      }
    },

    async findZone(zone) {
      const held = new Set(await domains());
      for (const name of zoneCandidates(zone)) {
        if (held.has(name)) return { id: name, name };
      }
      throw new DnsError(`no domain of the ${TITLE} account holds ${zone}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        "Porkbun serves the DNS of the domains registered in the account the keys belong to",
      ]);
    },

    async listRecords(zone, name) {
      const answer = await call("GET", `/dns/retrieve/${domainOf(zone)}`);
      if (!Array.isArray(answer.records)) throw new DnsError(`${TITLE}'s answer to GET /dns/retrieve/${zone.id} holds no records`, "unreachable");
      const wanted = name.toLowerCase();
      // Every record of the domain, named in full: those of this name alone are kept.
      return (answer.records as PorkbunRecord[])
        .filter((record) => typeof record.name === "string" && record.name.toLowerCase().replace(/\.$/, "") === wanted && typeof record.type === "string" && typeof record.content === "string")
        .filter((record) => typeof record.id === "string" || typeof record.id === "number")
        .map(
          (record): DnsRecord => ({
            id: String(record.id),
            type: record.type as string,
            name: wanted,
            content: record.content as string,
            proxied: false,
            ttl: Number(record.ttl) || 0,
          }),
        );
    },

    async createRecord(zone, record) {
      await call("POST", `/dns/create/${domainOf(zone)}`, { body: { name: relativeName(record.name, zone.name), type: record.type, content: record.content, ttl: TTL } });
    },

    async updateRecord(zone, record, content) {
      // Every field said, whatever the API keeps of those left out.
      await call("POST", `/dns/edit/${domainOf(zone)}/${idOf(record)}`, { body: { name: relativeName(record.name, zone.name), type: record.type, content, ttl: TTL } });
    },

    async deleteRecord(zone, record) {
      await call("POST", `/dns/delete/${domainOf(zone)}/${idOf(record)}`);
    },
  };
}

export const PORKBUN_DNS: DnsEntry = {
  name: "porkbun",
  title: "Porkbun",
  credentials: [
    { variable: API_KEY_VARIABLE, label: "API key", secret: true, shape: API_KEY_SHAPE },
    { variable: SECRET_KEY_VARIABLE, label: "secret API key", secret: true, shape: SECRET_KEY_SHAPE },
  ],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/porkbun.md",
  // `curitiba`, `fortaleza`, `maceio` and `salvador`, under ns.porkbun.com,
  // as 250kb.club's NS records name them; the same four directly under
  // porkbun.com, which resolve to the same servers, for domains delegated
  // before the `ns` label. Nothing else under porkbun.com, whose wildcard
  // answers any name.
  nameServers: /^(?:[a-z0-9-]+\.ns|curitiba|fortaleza|maceio|salvador)\.porkbun\.com$/,
  caddy: {
    package: "github.com/caddy-dns/porkbun",
    module: "dns.providers.porkbun",
    // The module's Caddyfile syntax, a block alone: both keys read through
    // Caddy's replacer at provisioning.
    directive: ["dns porkbun {", `api_key {env.${API_KEY_VARIABLE}}`, `api_secret_key {env.${SECRET_KEY_VARIABLE}}`, "}"],
    environment: (credentials) => ({
      [API_KEY_VARIABLE]: credentials[API_KEY_VARIABLE] ?? "",
      [SECRET_KEY_VARIABLE]: credentials[SECRET_KEY_VARIABLE] ?? "",
    }),
  },
  apiVariable: API_VARIABLE,
  open: porkbun,
};
