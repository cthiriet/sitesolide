/**
 * OVHcloud's DNS, through the OVHcloud API v1: https://eu.api.ovh.com/1.0,
 * described by https://eu.api.ovh.com/1.0/domain.json and
 * https://eu.api.ovh.com/1.0/auth.json, its signing explained at
 * https://docs.ovhcloud.com/en/guides/manage-and-operate/api/first-steps.
 *
 * Three regions, three APIs: `ovh-eu`, `ovh-ca` and `ovh-us`, the names
 * OVHcloud's own libraries give them, the one the account was opened in.
 * A zone is named by its name in every path; its records are numbered, named
 * relative to it (`subDomain`, empty for the zone itself, `*` for its
 * wildcard), and each is changed or deleted alone, by its id. A change is
 * written to the zone at once, and served once the zone is refreshed:
 * every write is followed by POST /domain/zone/{zone}/refresh.
 *
 * THE CREDENTIALS ARE DNS CREDENTIALS. Setup lays them on the machine, where
 * Caddy renews the wildcard with them, so they are never read from OVH's own
 * variables, OVH_APPLICATION_KEY and the like, nor from an ovh.conf, which
 * usually hold a consumer key that reaches the whole account. They are an
 * application key and its secret, and a consumer key whose access rules reach
 * the zone's records and nothing else:
 *
 *   GET    /domain/zone/<zone>/soa         how setup finds the zone
 *   GET    /domain/zone/<zone>/record      the records of a name
 *   GET    /domain/zone/<zone>/record/*    each of them
 *   POST   /domain/zone/<zone>/record      a record created
 *   PUT    /domain/zone/<zone>/record/*    a record changed
 *   DELETE /domain/zone/<zone>/record/*    a record deleted
 *   POST   /domain/zone/<zone>/refresh     the zone served again
 *
 * The same rules serve Caddy's module, whose library asks for exactly these.
 * `verify` asks GET /auth/currentCredential, whether the consumer key is
 * valid: a key whose rules do not grant that call answers NOT_GRANTED_CALL,
 * which OVHcloud only says once the keys and the signature are accepted, and
 * is let through.
 *
 * EVERY REQUEST IS SIGNED: X-Ovh-Signature is "$1$" and the SHA-1, in
 * hexadecimal, of the application secret, the consumer key, the method, the
 * whole address, the body and the timestamp, joined by `+`; the timestamp is
 * the API's own clock, read once from GET /auth/time, which needs no
 * credentials. The application key and the consumer key travel in the
 * X-Ovh-Application and X-Ovh-Consumer headers, the secret only through the
 * signature; none of them in an address or a message, and whatever text comes
 * back from outside is scrubbed of them. Every call follows no redirect and
 * gives up after a minute. The API pages none of these lists: the ids of a
 * name come back whole, and each record is read. Errors are `{"message",
 * "errorCode", "httpCode", "class", "details"}`, some of them absent.
 */
import { apiAddress } from "../../../clouds/src/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

/** The API of each region, as OVHcloud's libraries name them. */
export const ENDPOINTS: Readonly<Record<string, string>> = {
  "ovh-eu": "https://eu.api.ovh.com/1.0",
  "ovh-ca": "https://ca.api.ovh.com/1.0",
  "ovh-us": "https://api.us.ovhcloud.com/1.0",
};

/** Where each region's console makes a consumer key, the page that takes the rules in its address. */
export const TOKEN_PAGES: Readonly<Record<string, string>> = {
  "ovh-eu": "https://api.eu.ovhcloud.com/createToken/",
  "ovh-ca": "https://ca.api.ovh.com/createToken/",
  "ovh-us": "https://api.us.ovhcloud.com/createToken/",
};

/** The API's address, for tests against a local fake, whatever the region: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_OVH_DNS_API";

/** sitesolide's own variables: OVH_CONSUMER_KEY may hold a key that reaches the whole account. */
export const ENDPOINT_VARIABLE = "SITESOLIDE_DNS_OVH_ENDPOINT";
export const APPLICATION_KEY_VARIABLE = "SITESOLIDE_DNS_OVH_APPLICATION_KEY";
export const APPLICATION_SECRET_VARIABLE = "SITESOLIDE_DNS_OVH_APPLICATION_SECRET";
export const CONSUMER_KEY_VARIABLE = "SITESOLIDE_DNS_OVH_CONSUMER_KEY";

export const ENDPOINT_SHAPE = /^ovh-(?:eu|ca|us)$/;

/** Letters and digits: an application key is 16 of them, its secret and a consumer key 32. */
export const KEY_SHAPE = /^[A-Za-z0-9]{16,64}$/;

/** The TTL of a record setup creates: sixty seconds, the lowest OVHcloud's own console takes. */
export const TTL = 60;

const TITLE = "OVHcloud";

/** The rules a consumer key needs, for a zone. */
export function accessRules(zone: string): { method: string; path: string }[] {
  return [
    { method: "GET", path: `/domain/zone/${zone}/soa` },
    { method: "GET", path: `/domain/zone/${zone}/record` },
    { method: "GET", path: `/domain/zone/${zone}/record/*` },
    { method: "POST", path: `/domain/zone/${zone}/record` },
    { method: "PUT", path: `/domain/zone/${zone}/record/*` },
    { method: "DELETE", path: `/domain/zone/${zone}/record/*` },
    { method: "POST", path: `/domain/zone/${zone}/refresh` },
  ];
}

/** The region's key page, those rules written in its address, validity left to choose: Unlimited. */
export function tokenPage(endpoint: string, zone: string): string {
  const page = TOKEN_PAGES[endpoint] ?? TOKEN_PAGES["ovh-eu"]!;
  return `${page}?${accessRules(zone).map((rule) => `${rule.method}=${rule.path}`).join("&")}`;
}

export const CREDENTIAL_HELP = [
  "api.eu.ovhcloud.com/createToken (ca.api.ovh.com or api.us.ovhcloud.com for the other regions), validity Unlimited, with seven rights on the zone alone:",
  "GET /domain/zone/<zone>/soa, GET and POST /domain/zone/<zone>/record, GET, PUT and DELETE /domain/zone/<zone>/record/*, POST /domain/zone/<zone>/refresh",
];

type OvhRecord = { id?: unknown; fieldType?: unknown; subDomain?: unknown; target?: unknown; ttl?: unknown; zone?: unknown };
type OvhError = { message?: unknown; errorCode?: unknown; httpCode?: unknown; class?: unknown; details?: unknown };

/** A name of the zone as the API takes it: empty for the zone itself, relative otherwise. */
export function relativeName(name: string, zone: string): string {
  if (name === zone) return "";
  if (!name.endsWith(`.${zone}`)) throw new DnsError(`${name} is not a name of the ${TITLE} zone ${zone}`, "refused");
  return name.slice(0, -(zone.length + 1));
}

/** The signature of one request, as OVHcloud checks it. */
export function signature(secret: string, consumerKey: string, method: string, url: string, body: string, timestamp: number): string {
  return `$1$${new Bun.CryptoHasher("sha1").update([secret, consumerKey, method, url, body, String(timestamp)].join("+")).digest("hex")}`;
}

/** The credentials refused, by the codes OVHcloud's libraries tell apart. */
const KEY_CODES = new Set(["INVALID_KEY", "INVALID_CREDENTIAL", "NOT_CREDENTIAL", "INVALID_SIGNATURE", "NOT_GRANTED_CALL", "FORBIDDEN"]);

/** An error answer of the API, its status and its code kept for the callers that tell them apart. */
class OvhRefusal extends DnsError {
  constructor(
    message: string,
    kind: DnsError["kind"],
    details: string[],
    readonly status: number,
    readonly code: string,
  ) {
    super(message, kind, details);
  }
}

/** OVHcloud said the keys and the signature were good, and the rules do not grant the call. */
const notGranted = (error: unknown): boolean => error instanceof OvhRefusal && error.code === "NOT_GRANTED_CALL";

function ovh(context: DnsContext): ZoneApi {
  const endpoint = context.credentials[ENDPOINT_VARIABLE] ?? "";
  const regional = ENDPOINTS[endpoint];
  if (regional === undefined) {
    throw new DnsError(`${ENDPOINT_VARIABLE} is not a region of ${TITLE}'s API`, "refused", [`one of ${Object.keys(ENDPOINTS).join(", ")}, the region the account was opened in`]);
  }
  const base = apiAddress(context.environment, API_VARIABLE, regional);
  const host = new URL(base).host;
  const applicationKey = context.credentials[APPLICATION_KEY_VARIABLE] ?? "";
  const secret = context.credentials[APPLICATION_SECRET_VARIABLE] ?? "";
  const consumerKey = context.credentials[CONSUMER_KEY_VARIABLE] ?? "";
  const { clock } = context;
  const scrub = (text: string): string => {
    let scrubbed = text;
    for (const [value, label] of [
      [secret, "[application secret]"],
      [consumerKey, "[consumer key]"],
      [applicationKey, "[application key]"],
    ] as const) {
      if (value !== "") scrubbed = scrubbed.replaceAll(value, label);
    }
    return scrubbed;
  };
  /** The API's clock minus this machine's, in seconds, once read. */
  let delta: number | null = null;

  /** An error answer, in the words of the interface: the credentials refused, or the request. */
  function refusal(status: number, body: OvhError, method: string, path: string): OvhRefusal {
    const code = typeof body.errorCode === "string" ? scrub(body.errorCode) : "";
    const said = scrub(typeof body.message === "string" && body.message.trim() !== "" ? body.message.trim() : `HTTP ${status}`);
    const answer = `${status}${code === "" ? "" : ` ${code}`}`;
    const missing = body.details !== null && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
    const iam = ["unauthorizedActionsByAuthentication", "unauthorizedActionsByIAM"]
      .map((key) => missing[key])
      .filter((value): value is string => typeof value === "string" && value !== "")
      .map((value) => `missing IAM permissions: ${scrub(value)}`);
    if (code === "NOT_GRANTED_CALL") {
      const help = [...iam, "its access rules must grant the seven calls on the zone: make a new consumer key with them", ...CREDENTIAL_HELP];
      return new OvhRefusal(`the ${TITLE} consumer key may not ${method} ${path} (${answer}): ${said}`, "token", help, status, code);
    }
    if (status === 401 || (status === 403 && (code === "" || KEY_CODES.has(code))) || code === "INVALID_SIGNATURE") {
      const why =
        code === "INVALID_KEY"
          ? "the application key is unknown, or of another region"
          : code === "INVALID_SIGNATURE"
            ? "the application secret is not the application key's"
            : "the consumer key is unknown, expired, revoked, or was never validated";
      return new OvhRefusal(`${TITLE} refused the credentials (${answer}): ${said}`, "token", [why, ...iam, ...CREDENTIAL_HELP], status, code);
    }
    if (status === 429) return new OvhRefusal(`${TITLE}'s rate limit is reached (${answer}): ${said}`, "refused", ["run setup again in a minute"], status, code);
    if (status >= 500) return new OvhRefusal(`${TITLE} failed to answer ${method} ${path} (${answer}): ${said}`, "refused", [`the failure is on ${TITLE}'s side`], status, code);
    return new OvhRefusal(`${TITLE} refused ${method} ${path} (${answer}): ${said}`, "refused", iam, status, code);
  }

  /** One request, signed unless `signed` is false. A void answer is null. */
  async function call<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown, signed = true): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${base}${path}${search === "" ? "" : `?${search}`}`;
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json", "X-Ovh-Application": applicationKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (signed) {
      const timestamp = Math.floor(clock.now() / 1000) + (await offset());
      headers["X-Ovh-Consumer"] = consumerKey;
      headers["X-Ovh-Timestamp"] = String(timestamp);
      headers["X-Ovh-Signature"] = signature(secret, consumerKey, method, url, text, timestamp);
    }
    let response: Response;
    let answer: string;
    try {
      response = await context.fetcher(url, {
        method,
        // The credentials follow no address an answer names.
        redirect: "error",
        headers,
        ...(body === undefined ? {} : { body: text }),
        signal: AbortSignal.timeout(60_000),
      });
      answer = await response.text();
    } catch (error) {
      throw new DnsError(scrub(`cannot reach ${host}: ${error instanceof Error ? error.message : String(error)}`), "unreachable");
    }
    let parsed: unknown = null;
    try {
      parsed = answer.trim() === "" ? null : JSON.parse(answer);
    } catch {
      throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
    }
    if (!response.ok) {
      if (parsed === null || typeof parsed !== "object" || typeof (parsed as OvhError).message !== "string") {
        throw new DnsError(`${host} answered HTTP ${response.status} to ${method} ${path} with something that is not ${TITLE}'s API`, "unreachable");
      }
      throw refusal(response.status, parsed as OvhError, method, path);
    }
    return parsed as T;
  }

  /** The API's clock, read once: a signature more than a few seconds off is refused. */
  async function offset(): Promise<number> {
    if (delta !== null) return delta;
    const time = await call<unknown>("GET", "/auth/time", {}, undefined, false);
    if (typeof time !== "number" || !Number.isFinite(time)) throw new DnsError(`${TITLE}'s answer to GET /auth/time is not a time`, "unreachable");
    delta = time - Math.floor(clock.now() / 1000);
    return delta;
  }

  const zonePath = (zone: ZoneRef) => `/domain/zone/${encodeURIComponent(zone.id)}`;

  /** The zone served again with what was just written. */
  async function refresh(zone: ZoneRef): Promise<void> {
    await call("POST", `${zonePath(zone)}/refresh`);
  }

  return {
    async verify() {
      try {
        const credential = await call<{ status?: unknown } | null>("GET", "/auth/currentCredential");
        const status = typeof credential?.status === "string" ? credential.status : "unknown";
        if (status !== "validated") {
          throw new DnsError(`the ${TITLE} consumer key is ${status}, not validated`, "token", [
            status === "pendingValidation" ? "open the validation address OVHcloud gave with it, and sign in to validate it" : "make a new one",
            ...CREDENTIAL_HELP,
          ]);
        }
      } catch (error) {
        // The keys and the signature were accepted; the rules, limited to
        // the zone, do not grant this call, and need not.
        if (notGranted(error)) return;
        throw error;
      }
    },

    async findZone(zone) {
      for (const name of zoneCandidates(zone)) {
        try {
          await call("GET", `/domain/zone/${encodeURIComponent(name)}/soa`);
          return { id: name, name };
        } catch (error) {
          // Not a zone of the account (404), or not one the rules reach (403).
          if ((error instanceof OvhRefusal && error.status === 404) || notGranted(error)) continue;
          throw error;
        }
      }
      throw new DnsError(`no ${TITLE} zone the consumer key can read holds ${zone}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        "check --zone, the region, and that the consumer key's rules name the zone: GET /domain/zone/<zone>/soa among them",
      ]);
    },

    async listRecords(zone, name) {
      const relative = relativeName(name, zone.name);
      const ids = await call<unknown>("GET", `${zonePath(zone)}/record`, { subDomain: relative });
      if (!Array.isArray(ids)) throw new DnsError(`${TITLE}'s answer to GET ${zonePath(zone)}/record is not a list`, "unreachable");
      const records: DnsRecord[] = [];
      for (const id of ids) {
        if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new DnsError(`${TITLE}'s list of records holds ${String(id)}, not an id`, "unreachable");
        const record = await call<OvhRecord | null>("GET", `${zonePath(zone)}/record/${id}`);
        // Filtered here: the API's filter is a case-insensitive LIKE, and
        // what is decided must only ever concern this name.
        const subDomain = typeof record?.subDomain === "string" ? record.subDomain.toLowerCase() : "";
        if (subDomain !== relative || typeof record?.fieldType !== "string" || typeof record.target !== "string") continue;
        records.push({ id: String(id), type: record.fieldType, name, content: record.target, proxied: false, ttl: typeof record.ttl === "number" ? record.ttl : 0 });
      }
      return records;
    },

    async createRecord(zone, record) {
      await call("POST", `${zonePath(zone)}/record`, {}, { fieldType: record.type, subDomain: relativeName(record.name, zone.name), target: record.content, ttl: TTL });
      await refresh(zone);
    },

    async updateRecord(zone, record, content) {
      await call("PUT", `${zonePath(zone)}/record/${encodeURIComponent(record.id)}`, {}, { target: content });
      await refresh(zone);
    },

    async deleteRecord(zone, record) {
      await call("DELETE", `${zonePath(zone)}/record/${encodeURIComponent(record.id)}`);
      await refresh(zone);
    },
  };
}

export const OVH_DNS: DnsEntry = {
  name: "ovh",
  title: "OVHcloud",
  credentials: [
    { variable: ENDPOINT_VARIABLE, label: "API region (ovh-eu, ovh-ca or ovh-us)", secret: false, shape: ENDPOINT_SHAPE },
    { variable: APPLICATION_KEY_VARIABLE, label: "application key", secret: false, shape: KEY_SHAPE },
    { variable: APPLICATION_SECRET_VARIABLE, label: "application secret", secret: true, shape: KEY_SHAPE },
    { variable: CONSUMER_KEY_VARIABLE, label: "consumer key", secret: true, shape: KEY_SHAPE },
  ],
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/dns/ovh.md",
  // A zone's pair, dnsNN.ovh.net and nsNN.ovh.net, ovh.us in the US region,
  // and dns200.anycast.me and ns200.anycast.me with the DNS Anycast option.
  nameServers: /^(?:(?:dns|ns)\d*\.ovh\.(?:net|us)|(?:dns|ns)\d+\.anycast\.me)$/,
  caddy: {
    package: "github.com/caddy-dns/ovh",
    module: "dns.providers.ovh",
    // The module's Caddyfile syntax, every field read through Caddy's
    // replacer at provisioning; the endpoint is a region's name, which the
    // module's library, go-ovh, knows.
    directive: [
      "dns ovh {",
      `\tendpoint {env.${ENDPOINT_VARIABLE}}`,
      `\tapplication_key {env.${APPLICATION_KEY_VARIABLE}}`,
      `\tapplication_secret {env.${APPLICATION_SECRET_VARIABLE}}`,
      `\tconsumer_key {env.${CONSUMER_KEY_VARIABLE}}`,
      "}",
    ],
    environment: (credentials) => ({
      [ENDPOINT_VARIABLE]: credentials[ENDPOINT_VARIABLE] ?? "",
      [APPLICATION_KEY_VARIABLE]: credentials[APPLICATION_KEY_VARIABLE] ?? "",
      [APPLICATION_SECRET_VARIABLE]: credentials[APPLICATION_SECRET_VARIABLE] ?? "",
      [CONSUMER_KEY_VARIABLE]: credentials[CONSUMER_KEY_VARIABLE] ?? "",
    }),
  },
  apiVariable: API_VARIABLE,
  open: ovh,
};
