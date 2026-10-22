/**
 * Azure DNS, through Azure Resource Manager's REST API, with nothing of
 * Azure's installed on the workstation: https://learn.microsoft.com/rest/api/dns/
 *
 * A zone is a resource, Microsoft.Network/dnszones, of a resource group of a
 * subscription. Its records come in record sets, one per name and type, each
 * holding a list of values under one TTL and one ETag:
 *
 *   <zone>     A     the machine's IPv4      record set `@`, TTL 300
 *   *.<zone>   A     the machine's IPv4      record set `*`, TTL 300
 *   <zone>     AAAA  the machine's IPv6      when it has one
 *   *.<zone>   AAAA  the machine's IPv6      when it has one
 *
 * A zone that is a subdomain of an Azure zone, `sites.example.com` in
 * `example.com`, has its records in that zone, as the sets `sites` and
 * `*.sites`.
 *
 * ONE VALUE AT A TIME. Setup's engine (bin/cli/dns/dns.ts) sees records, one
 * per value; each change it asks for is a rewrite of the record set: read it,
 * change that one value, write the set back under `If-Match` with the ETag
 * read, so that a set somebody changed in between is read again rather than
 * overwritten, three times at most. Every other value of the set, its TTL and
 * its metadata are kept; a set left without a value is deleted. An alias
 * record set, which takes its address from another Azure resource
 * (`targetResource`) and holds no value, is one record, `alias of <resource>`:
 * it points elsewhere, and only `--dns-replace` replaces it with a plain set.
 *
 * THE CREDENTIALS are a service principal's, with the DNS Zone Contributor
 * role on the zone alone, and the zone's subscription and resource group,
 * read from SITESOLIDE_DNS_AZURE_*, never from the AZURE_* variables Azure's
 * own tools read, which usually hold a broad identity (bin/cli/dns/dns.ts
 * says why). The secret is exchanged at Microsoft Entra for an access token
 * with the client credentials grant, as bin/cli/providers/azure.ts does: in
 * the Authorization header of the token request (client_secret_basic, RFC
 * 6749 2.3.1), or, should Entra refuse it there, in that request's form body
 * (client_secret_post), as MSAL sends it. The token goes through
 * `context.secret` first, then in the Authorization header of every call to
 * Resource Manager. Neither is ever in an address, a message or an error:
 * whatever comes back from outside is scrubbed of both.
 *
 * The same five values go to Caddy, whose module github.com/caddy-dns/azure
 * reads them from its environment, /etc/caddy/cloudflare.env, to write the
 * TXT records of the DNS-01 challenge. It speaks to Azure's public cloud
 * only: no sovereign cloud, and no name server of one is recognised.
 *
 * Every call follows no redirect, gives up after a minute, and fails with a
 * DnsError. Lists follow `nextLink` to the end, only while it points at the
 * API the token is meant for. A 429 is waited out as Retry-After asks, a
 * minute at most, three times at most, on `context.clock`.
 * SITESOLIDE_AZURE_DNS_API and SITESOLIDE_AZURE_DNS_LOGIN point the module at
 * a local fake.
 */
import { canonicalAddress } from "../cloudflare";
import { apiAddress, retryAfter, type CredentialField, type Credentials } from "../providers/provider";
import { DnsError, zoneCandidates, type DnsContext, type DnsEntry, type DnsRecord, type ZoneApi, type ZoneRef } from "./dns";

export const DEFAULT_API = "https://management.azure.com";
export const DEFAULT_LOGIN = "https://login.microsoftonline.com";

/** Resource Manager's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_AZURE_DNS_API";
/** Microsoft Entra's address, where the service principal's secret is exchanged for a token. */
export const LOGIN_VARIABLE = "SITESOLIDE_AZURE_DNS_LOGIN";

/** What the token is asked for: Resource Manager, with what the role on the zone allows. */
export const SCOPE = "https://management.azure.com/.default";

/** The stable api-version of Microsoft.Network/dnszones; the later ones are previews. */
export const API_VERSION = "2018-05-01";

/** The TTL of a record set setup creates: five minutes, so that a new machine's address spreads soon. */
export const TTL = 300;

/** How many times a call is made again: after a 429, or a record set somebody changed meanwhile. */
const ATTEMPTS = 3;
/** The longest Retry-After waited, in seconds. */
const LONGEST_WAIT = 60;
/** A zone holds 10,000 record sets by default, a hundred a page: a runaway pagination stops well beyond. */
const MAX_PAGES = 500;

export const VARIABLES = {
  tenant: "SITESOLIDE_DNS_AZURE_TENANT_ID",
  client: "SITESOLIDE_DNS_AZURE_CLIENT_ID",
  secret: "SITESOLIDE_DNS_AZURE_CLIENT_SECRET",
  subscription: "SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID",
  group: "SITESOLIDE_DNS_AZURE_RESOURCE_GROUP",
} as const;

// --- shapes ------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant is named by its ID or by one of its domains. */
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
/**
 * Printable ASCII without spaces, quotes, backslashes or backticks: what a
 * client secret is made of, and what a line of a systemd EnvironmentFile
 * holds as it is.
 */
const CLIENT_SECRET = /^[!#-&(-[\]-_a-~]{8,256}$/;
/**
 * A resource group's name as Azure takes it, up to 90 letters, digits,
 * `_ ( ) - .`, not ending with a period, in ASCII alone: Azure also takes
 * other scripts' letters, which Caddy's environment file could not hold.
 */
const RESOURCE_GROUP = /^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$/;

export const CREDENTIALS: readonly CredentialField[] = [
  { variable: VARIABLES.tenant, label: "Microsoft Entra tenant ID", secret: false, shape: TENANT },
  { variable: VARIABLES.client, label: "service principal's client ID", secret: false, shape: UUID },
  { variable: VARIABLES.secret, label: "client secret", secret: true, shape: CLIENT_SECRET },
  { variable: VARIABLES.subscription, label: "zone's subscription ID", secret: false, shape: UUID },
  { variable: VARIABLES.group, label: "zone's resource group", secret: false, shape: RESOURCE_GROUP },
];

const DOCS = "docs/dns/azure-dns.md";

const ROLE_HELP = `the service principal needs the DNS Zone Contributor role on the zone: in the portal, the DNS zone, Access control (IAM); a role granted a moment ago takes a few minutes to apply (${DOCS})`;

// --- the API's objects, as far as this file reads them ------------------------------------------

type RecordSetProperties = {
  TTL?: number;
  fqdn?: string;
  metadata?: Record<string, string> | null;
  ARecords?: { ipv4Address?: string }[];
  AAAARecords?: { ipv6Address?: string }[];
  CNAMERecord?: { cname?: string } | null;
  MXRecords?: { preference?: number; exchange?: string }[];
  NSRecords?: { nsdname?: string }[];
  PTRRecords?: { ptrdname?: string }[];
  SRVRecords?: { priority?: number; weight?: number; port?: number; target?: string }[];
  TXTRecords?: { value?: string[] }[];
  caaRecords?: { flags?: number; tag?: string; value?: string }[];
  SOARecord?: { host?: string; email?: string; serialNumber?: number } | null;
  targetResource?: { id?: string | null } | null;
};

export type RecordSet = { id?: string; name?: string; type?: string; etag?: string; properties?: RecordSetProperties };

type AzureZone = { id?: string; name?: string; properties?: { zoneType?: string } };

/** The types setup writes. */
type Writable = "A" | "AAAA" | "CNAME";

function writable(type: string): type is Writable {
  return type === "A" || type === "AAAA" || type === "CNAME";
}

// --- what the answers mean ----------------------------------------------------------------------

function withoutDot(name: string): string {
  return name.replace(/\.$/, "");
}

/** A record set's type, `A` from `Microsoft.Network/dnszones/A`. */
export function setType(set: RecordSet): string {
  return (set.type ?? "").split("/").pop()?.toUpperCase() ?? "";
}

/** The resource an alias record set takes its value from, said shortly: `Microsoft.Network/publicIPAddresses/web-ip`. */
export function aliasTarget(set: RecordSet): string | null {
  const id = set.properties?.targetResource?.id;
  if (typeof id !== "string" || id === "") return null;
  return id.split(/\/providers\//i).pop() ?? id;
}

/** The values of a record set as text, one per record, as a zone file says them. */
export function setValues(set: RecordSet): string[] {
  const properties = set.properties ?? {};
  const present = (value: string | undefined): value is string => typeof value === "string" && value !== "";
  switch (setType(set)) {
    case "A":
      return (properties.ARecords ?? []).map((record) => record.ipv4Address).filter(present);
    case "AAAA":
      return (properties.AAAARecords ?? []).map((record) => record.ipv6Address).filter(present);
    case "CNAME":
      return [properties.CNAMERecord?.cname].filter(present).map(withoutDot);
    case "MX":
      return (properties.MXRecords ?? []).filter((record) => present(record.exchange)).map((record) => `${record.preference ?? 0} ${withoutDot(record.exchange!)}`);
    case "NS":
      return (properties.NSRecords ?? []).map((record) => record.nsdname).filter(present).map(withoutDot);
    case "PTR":
      return (properties.PTRRecords ?? []).map((record) => record.ptrdname).filter(present).map(withoutDot);
    case "SRV":
      return (properties.SRVRecords ?? []).filter((record) => present(record.target)).map((record) => `${record.priority ?? 0} ${record.weight ?? 0} ${record.port ?? 0} ${withoutDot(record.target!)}`);
    case "TXT":
      return (properties.TXTRecords ?? []).map((record) => (record.value ?? []).join(""));
    case "CAA":
      return (properties.caaRecords ?? []).map((record) => `${record.flags ?? 0} ${record.tag ?? ""} "${record.value ?? ""}"`);
    case "SOA":
      return properties.SOARecord?.host === undefined ? [] : [`${withoutDot(properties.SOARecord.host)} ${withoutDot(properties.SOARecord.email ?? "")} ${properties.SOARecord.serialNumber ?? 0}`];
    default:
      return [];
  }
}

/** Whether two values of a type say the same: `2001:DB8::1` is `2001:db8::1`, `Example.com.` is `example.com`. */
function sameValue(type: string, a: string, b: string): boolean {
  if (type === "A" || type === "AAAA") return canonicalAddress(a) === canonicalAddress(b);
  return withoutDot(a).toLowerCase() === withoutDot(b).toLowerCase();
}

/** A name as a record set of a zone names it: `@` for the zone itself, `*.apps` for `*.apps.example.com`. */
export function relativeName(zone: string, name: string): string {
  const parent = withoutDot(zone).toLowerCase();
  const absolute = withoutDot(name).toLowerCase();
  if (absolute === parent) return "@";
  if (absolute.endsWith(`.${parent}`)) return absolute.slice(0, -(parent.length + 1));
  throw new DnsError(`${name} is not a name of the zone ${zone}`, "refused");
}

function absoluteName(zone: string, relative: string): string {
  return relative === "@" ? zone : `${relative}.${zone}`;
}

/**
 * One segment of an address, every reserved character encoded: a
 * subscription, a resource group, a zone, a tenant.
 */
export function segment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A record set's relative name in an address: `@` and `*` sent as they are,
 * since the REST specification marks the parameter `x-ms-skip-url-encoding`
 * and both Microsoft SDKs, Python's azure-mgmt-dns (skip_quote) and Go's
 * armdns, put it in the path raw. Anything else a relative name could hold,
 * letters, digits, dashes and dots, needs no encoding either; the rest is
 * encoded all the same.
 */
export function setSegment(relative: string): string {
  return relative
    .split("")
    .map((character) => (/[A-Za-z0-9@*._-]/.test(character) ? character : encodeURIComponent(character)))
    .join("");
}

/** What lets a record be found again in its set: the type, the set's relative name, the value (null: the alias). */
type RecordKey = { type: string; set: string; value: string | null };

function recordId(key: RecordKey): string {
  return JSON.stringify([key.type, key.set, key.value]);
}

function parseId(id: string): RecordKey {
  try {
    const [type, set, value] = JSON.parse(id) as unknown[];
    if (typeof type === "string" && typeof set === "string" && (typeof value === "string" || value === null)) return { type, set, value };
  } catch {
    // Said below.
  }
  throw new DnsError("a record Azure DNS did not list was asked to change", "refused");
}

/** A record set as setup's engine sees it: one record per value, or one for an alias. */
function toRecords(set: RecordSet, name: string): DnsRecord[] {
  const type = setType(set);
  const relative = (set.name ?? "").toLowerCase();
  const ttl = typeof set.properties?.TTL === "number" ? set.properties.TTL : TTL;
  const target = aliasTarget(set);
  if (target !== null) return [{ id: recordId({ type, set: relative, value: null }), type, name, content: `alias of ${target}`, proxied: false, ttl }];
  return setValues(set).map((content) => ({ id: recordId({ type, set: relative, value: content }), type, name, content, proxied: false, ttl }));
}

/** The list a record set of that type holds its values in, as Resource Manager takes it. */
function valuesBody(type: Writable, values: string[]): RecordSetProperties {
  if (type === "A") return { ARecords: values.map((ipv4Address) => ({ ipv4Address })) };
  if (type === "AAAA") return { AAAARecords: values.map((ipv6Address) => ({ ipv6Address })) };
  return { CNAMERecord: { cname: values[0] } };
}

/** The values with `value` replaced by `content`, or added when it is gone, each once. */
function replaced(type: string, values: string[], value: string, content: string): string[] {
  const next = values.some((candidate) => sameValue(type, candidate, value)) ? values.map((candidate) => (sameValue(type, candidate, value) ? content : candidate)) : [...values, content];
  return next.filter((candidate, index) => next.findIndex((other) => sameValue(type, other, candidate)) === index);
}

function sameList(type: string, a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => sameValue(type, value, b[index]!));
}

/**
 * An error answer of Microsoft Entra's token endpoint: `{"error",
 * "error_description", "error_codes"}`. The description's first line names
 * the AADSTS code and the reason; the client ID may be in it, never the secret.
 */
export function loginRefusal(status: number, body: unknown, scrub: (text: string) => string): DnsError {
  const answer = body as { error?: unknown; error_description?: unknown; error_codes?: unknown } | null;
  const error = typeof answer?.error === "string" ? answer.error : "";
  const said = typeof answer?.error_description === "string" ? (answer.error_description.split(/\r?\n/)[0] ?? "") : `answered ${status}`;
  const codes = Array.isArray(answer?.error_codes) ? answer.error_codes.map(Number) : [];
  const tagged = `${status}${error === "" ? "" : ` ${error}`}`;
  if (status === 429) return new DnsError(`Microsoft Entra's rate limit is reached (${tagged})`, "refused", ["try again in a few minutes"]);
  if (status >= 500) return new DnsError(scrub(`Microsoft Entra failed to sign the service principal in (${tagged}): ${said}`), "unreachable", ["the failure is on Microsoft's side"]);
  const why: Record<number, string> = {
    7000215: `the client secret is wrong: copy its Value, not its Secret ID, from the app registration's Certificates & secrets into ${VARIABLES.secret}`,
    7000222: "the client secret has expired: create another under the app registration's Certificates & secrets",
    700016: `no application of that client ID in that tenant: check ${VARIABLES.client} and ${VARIABLES.tenant}`,
    90002: `no tenant of that ID: check ${VARIABLES.tenant}`,
    900023: `${VARIABLES.tenant} is not a tenant ID nor one of its domains`,
  };
  const reason = codes.map((code) => why[code]).find((line) => line !== undefined);
  return new DnsError(scrub(`Microsoft Entra refused the service principal (${tagged}): ${said}`), "token", [
    reason ?? "the tenant, the client ID or the secret is wrong, or the secret has expired",
    `make the credentials as ${DOCS} says`,
  ]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- the API --------------------------------------------------------------------------------------

type Answer = { status: number; headers: Headers; body: unknown };

/** What a rewrite does with an alias record set it finds: refuse it, replace it with plain values, or delete it. */
type AliasPolicy = "refuse" | "replace" | "delete";

/** A record set's values changed: the new list, empty to delete the set, or "unchanged" to write nothing. */
type Change = (values: string[] | null) => string[] | "unchanged";

function azureDns(context: DnsContext): ZoneApi {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const loginBase = apiAddress(context.environment, LOGIN_VARIABLE, DEFAULT_LOGIN);
  const host = new URL(base).host;
  const loginHost = new URL(loginBase).host;
  const credential = (variable: string) => context.credentials[variable]?.trim() ?? "";
  const tenant = credential(VARIABLES.tenant);
  const client = credential(VARIABLES.client);
  const secret = credential(VARIABLES.secret);
  const subscription = credential(VARIABLES.subscription);
  const group = credential(VARIABLES.group);

  /** The secret and the token, in every spelling a text from outside might carry them. */
  const hidden: string[] = [];
  const hide = (value: string) => {
    if (value !== "") hidden.push(value, encodeURIComponent(value));
  };
  hide(secret);
  const scrub = (text: string) => hidden.reduce((result, value) => result.replaceAll(value, "[secret]"), text);

  const zonesPath = `/subscriptions/${segment(subscription)}/resourceGroups/${segment(group)}/providers/Microsoft.Network/dnsZones`;
  const zonePath = (zone: string) => `${zonesPath}/${segment(zone)}`;
  const setPath = (zone: string, type: string, relative: string) => `${zonePath(zone)}/${type}/${setSegment(relative)}`;
  const address = (path: string) => `${base}${path}?api-version=${API_VERSION}`;

  // --- the token

  let exchanged: { value: string; until: number } | null = null;

  /**
   * The service principal's token, exchanged for its secret, kept until five
   * minutes before it expires. The client ID and the secret go first in the
   * Authorization header; should Entra answer `invalid_client`, once more in
   * the form body. Never in the address.
   */
  async function exchange(): Promise<{ value: string; until: number }> {
    const form = `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`;
    const attempt = async (style: "basic" | "post"): Promise<{ response: Response; body: unknown }> => {
      let response: Response;
      try {
        response = await context.fetcher(`${loginBase}/${segment(tenant)}/oauth2/v2.0/token`, {
          method: "POST",
          redirect: "error",
          headers: {
            ...(style === "basic" ? { Authorization: `Basic ${btoa(`${encodeURIComponent(client)}:${encodeURIComponent(secret)}`)}` } : {}),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: style === "basic" ? form : `${form}&client_id=${encodeURIComponent(client)}&client_secret=${encodeURIComponent(secret)}`,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new DnsError(scrub(`${loginHost} unreachable while signing the service principal in: ${describeError(error)}`), "unreachable");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DnsError(`${loginHost} answered ${response.status} with something that is not Microsoft Entra's token endpoint`, "unreachable");
      }
      return { response, body };
    };
    let { response, body } = await attempt("basic");
    if (!response.ok && (body as { error?: unknown } | null)?.error === "invalid_client") ({ response, body } = await attempt("post"));
    if (!response.ok) throw loginRefusal(response.status, body, scrub);
    const answer = body as { access_token?: unknown; expires_in?: unknown } | null;
    const token = typeof answer?.access_token === "string" ? answer.access_token : "";
    if (token === "") throw new DnsError(`${loginHost} answered without an access token`, "unreachable");
    context.secret(token);
    hide(token);
    const lifetime = Number(answer?.expires_in);
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600;
    return { value: token, until: context.clock.now() + Math.max(60, seconds - 300) * 1000 };
  }

  async function bearer(): Promise<string> {
    if (exchanged === null || context.clock.now() >= exchanged.until) exchanged = await exchange();
    return exchanged.value;
  }

  // --- the calls

  /** One call, the token in its header, JSON both ways; a 429 waited out. The answer is the caller's to judge. */
  async function send(method: string, url: string, what: string, extra: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
    for (let attempt = 1; ; attempt++) {
      const token = await bearer();
      let response: Response;
      let text: string;
      try {
        response = await context.fetcher(url, {
          method,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(extra.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(extra.headers ?? {}),
          },
          ...(extra.body === undefined ? {} : { body: JSON.stringify(extra.body) }),
          signal: AbortSignal.timeout(60_000),
        });
        text = await response.text();
      } catch (error) {
        throw new DnsError(scrub(`${host} unreachable while trying to ${what}: ${describeError(error)}`), "unreachable");
      }
      let body: unknown = null;
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          // A proxy in front of the API may answer a 502 or a 429 in HTML:
          // still Azure saying "later". Anything else that is not JSON is not its API.
          if (response.status < 500 && response.status !== 429) {
            throw new DnsError(`${host} answered ${response.status} with something that is not Azure Resource Manager, while trying to ${what}`, "unreachable");
          }
        }
      }
      if (response.status === 429 && attempt < ATTEMPTS) {
        await context.clock.sleep(Math.min(LONGEST_WAIT, retryAfter(response.headers, 10)) * 1000);
        continue;
      }
      return { status: response.status, headers: response.headers, body };
    }
  }

  /** An error answer of Resource Manager, `{"error": {"code", "message"}}`, in the words every provider uses. */
  function failure(answer: Answer, what: string): DnsError {
    const error = (answer.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "";
    const said = typeof error?.message === "string" ? error.message : `answered ${answer.status}`;
    const tagged = `${answer.status}${code === "" ? "" : ` ${code}`}`;
    if (answer.status === 401) {
      return new DnsError(scrub(`Azure refused the service principal's token (${tagged}): ${said}`), "token", [
        code === "InvalidAuthenticationTokenTenant"
          ? `the subscription ${VARIABLES.subscription} names is not in the tenant ${VARIABLES.tenant} names`
          : "check the tenant, the client ID and the secret",
      ]);
    }
    if (answer.status === 403) return new DnsError(scrub(`the service principal may not ${what} (${tagged}): ${said}`), "refused", [ROLE_HELP]);
    if (answer.status === 429) return new DnsError(`Azure's rate limit is reached, nothing more can be asked of it for now (${tagged})`, "refused", ["try again in a few minutes"]);
    if (answer.status >= 500 && error === undefined) return new DnsError(`${host} failed to ${what} (${answer.status}), with an answer that is not Azure's`, "unreachable");
    if (answer.status >= 500) return new DnsError(scrub(`Azure failed to ${what} (${tagged}): ${said}`), "refused", ["the failure is on Azure's side: try again later"]);
    return new DnsError(scrub(`Azure refused to ${what} (${tagged}): ${said}`), "refused");
  }

  /** An address an answer gives to follow, kept only when it is the API's own: the token goes with it. */
  function followable(link: string, what: string): string {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new DnsError(`${host} answered with an address that is not one, while trying to ${what}`, "unreachable");
    }
    const expected = new URL(base);
    if (url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname.replace(/\/$/, ""))) {
      throw new DnsError(`${host} gave an address at ${url.host} to follow, while trying to ${what}: it is not followed`, "unreachable");
    }
    return url.toString();
  }

  /** Every record set of the zone, following `nextLink` to the end. */
  async function recordSets(zone: ZoneRef): Promise<RecordSet[]> {
    const what = `list the record sets of ${zone.name}`;
    const sets: RecordSet[] = [];
    let next: string | null = address(`${zonePath(zone.id)}/recordsets`);
    for (let pages = 0; next !== null; pages++) {
      if (pages >= MAX_PAGES) throw new DnsError(`the record sets of ${zone.name} went on for more than ${MAX_PAGES} pages`, "refused");
      const answer = await send("GET", next, what);
      if (answer.status !== 200) throw failure(answer, what);
      const page = answer.body as { value?: unknown; nextLink?: unknown } | null;
      if (!Array.isArray(page?.value)) throw new DnsError(`${host} answered without the list, while trying to ${what}`, "unreachable");
      sets.push(...(page.value as RecordSet[]));
      next = typeof page.nextLink === "string" && page.nextLink !== "" ? followable(page.nextLink, what) : null;
    }
    return sets;
  }

  /** The zone's record sets as listed by this run, until it writes something. */
  const listed = new Map<string, RecordSet[]>();

  /**
   * One record set rewritten: read with its ETag, changed, written back under
   * If-Match (or If-None-Match when there was none), deleted when left
   * without a value; read again when somebody wrote it in between.
   */
  async function rewrite(zone: ZoneRef, type: string, relative: string, change: Change, alias: AliasPolicy): Promise<void> {
    if (!writable(type)) throw new DnsError(`sitesolide writes A, AAAA and CNAME record sets, not ${type}`, "refused");
    const path = setPath(zone.id, type, relative);
    const label = `the ${type} record set of ${absoluteName(zone.name, relative)}`;
    let conflicts = 0;
    // Twice the attempts at most: replacing an alias takes a round to delete it.
    for (let round = 0; round < 2 * ATTEMPTS; round++) {
      const read = await send("GET", address(path), `read ${label}`);
      if (read.status !== 200 && read.status !== 404) throw failure(read, `read ${label}`);
      const set = read.status === 200 ? (read.body as RecordSet | null) : null;
      if (read.status === 200 && (set === null || typeof set !== "object")) throw new DnsError(`${host} answered without ${label}`, "unreachable");
      const etag = set?.etag ?? read.headers.get("ETag") ?? "";
      const match: Record<string, string> = etag === "" ? {} : { "If-Match": etag };
      const target = set === null ? null : aliasTarget(set);

      let answer: Answer;
      if (target !== null && alias === "refuse") {
        throw new DnsError(`${label} is an alias of ${target}`, "refused", ["it points elsewhere: only --dns-replace replaces it"]);
      } else if (target !== null) {
        listed.clear();
        answer = await send("DELETE", address(path), `delete ${label}`, { headers: match });
        if ((answer.status === 200 || answer.status === 204) && alias === "delete") return;
        // Replaced: the next round finds no set, and creates the plain one.
        if (answer.status === 200 || answer.status === 204) continue;
      } else if (alias === "delete") {
        return;
      } else {
        const values = set === null ? null : setValues(set);
        const next = change(values);
        if (next === "unchanged" || (values !== null && sameList(type, next, values))) return;
        listed.clear();
        if (next.length === 0) {
          if (set === null) return;
          answer = await send("DELETE", address(path), `delete ${label}`, { headers: match });
          if (answer.status === 200 || answer.status === 204) return;
        } else {
          const kept = set?.properties ?? {};
          const properties: RecordSetProperties = {
            TTL: set === null || typeof kept.TTL !== "number" ? TTL : kept.TTL,
            ...(kept.metadata === undefined || kept.metadata === null ? {} : { metadata: kept.metadata }),
            ...valuesBody(type, next),
          };
          answer = await send("PUT", address(path), `write ${label}`, { body: { properties }, headers: set === null ? { "If-None-Match": "*" } : match });
          if (answer.status === 200 || answer.status === 201) return;
        }
      }
      // 412: somebody wrote the set since it was read. Read it again, three times at most.
      if (answer.status !== 412) throw failure(answer, `write ${label}`);
      if (++conflicts >= ATTEMPTS) break;
    }
    throw new DnsError(`${label} changed every time it was read: something else is writing it`, "refused", ["run the command again once it is done"]);
  }

  return {
    async verify() {
      await bearer();
    },

    async findZone(zone) {
      // A run starts here: what an earlier run listed is read again.
      listed.clear();
      const said: string[] = [];
      for (const name of zoneCandidates(zone)) {
        const what = `read the zone ${name}`;
        const answer = await send("GET", address(zonePath(name)), what);
        if (answer.status === 200) {
          const found = answer.body as AzureZone | null;
          if (found === null || typeof found !== "object") throw new DnsError(`${host} answered without the zone ${name}`, "unreachable");
          // A private zone of the old API is no zone the Internet resolves.
          if (found.properties?.zoneType === "Private") {
            said.push(`${name}: a private zone`);
            continue;
          }
          const actual = withoutDot(typeof found.name === "string" && found.name !== "" ? found.name : name);
          return { id: actual, name: actual.toLowerCase() };
        }
        if (answer.status === 403 || answer.status === 404) {
          // Resource Manager checks the role before it looks: a zone the
          // principal may not read and a zone that is not there both end here.
          const error = (answer.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
          const code = typeof error?.code === "string" ? error.code : `${answer.status}`;
          if (!said.some((line) => line.startsWith(`${code}:`))) said.push(scrub(`${code}: ${typeof error?.message === "string" ? error.message : `answered ${answer.status}`}`));
          continue;
        }
        throw failure(answer, what);
      }
      throw new DnsError(`no Azure DNS zone the credentials can read holds ${zone}, in the resource group ${group}`, "zone", [
        `looked for: ${zoneCandidates(zone).join(", ")}`,
        ...said.slice(0, 2).map((line) => `Azure said ${line}`),
        `check --zone, ${VARIABLES.subscription} and ${VARIABLES.group}, which are the zone's own, and that the service principal has DNS Zone Contributor on the zone (${DOCS})`,
      ]);
    },

    async listRecords(zone, name) {
      const relative = relativeName(zone.name, name);
      let sets = listed.get(zone.id);
      if (sets === undefined) {
        sets = await recordSets(zone);
        listed.set(zone.id, sets);
      }
      const absolute = withoutDot(name).toLowerCase();
      return sets.filter((set) => (set.name ?? "").toLowerCase() === relative).flatMap((set) => toRecords(set, absolute));
    },

    async createRecord(zone, record) {
      await rewrite(
        zone,
        record.type,
        relativeName(zone.name, record.name),
        (values) => {
          if (values === null) return [record.content];
          return values.some((value) => sameValue(record.type, value, record.content)) ? "unchanged" : [...values, record.content];
        },
        "refuse",
      );
    },

    async updateRecord(zone, record, content) {
      const key = parseId(record.id);
      if (key.value === null) {
        await rewrite(zone, key.type, key.set, (values) => (values !== null && values.some((value) => sameValue(key.type, value, content)) ? "unchanged" : [content]), "replace");
        return;
      }
      const value = key.value;
      await rewrite(zone, key.type, key.set, (values) => (values === null ? [content] : replaced(key.type, values, value, content)), "refuse");
    },

    async deleteRecord(zone, record) {
      const key = parseId(record.id);
      if (key.value === null) {
        await rewrite(zone, key.type, key.set, () => "unchanged", "delete");
        return;
      }
      const value = key.value;
      await rewrite(zone, key.type, key.set, (values) => (values === null ? "unchanged" : values.filter((candidate) => !sameValue(key.type, candidate, value))), "refuse");
    },
  };
}

// --- the entry ------------------------------------------------------------------------------------

/** The five values Caddy's module reads, each from the variable of the same name. */
function caddyEnvironment(credentials: Credentials): Record<string, string> {
  return Object.fromEntries(CREDENTIALS.map((field) => [field.variable, credentials[field.variable]?.trim() ?? ""]));
}

export const AZURE_DNS: DnsEntry = {
  name: "azure-dns",
  title: "Azure DNS",
  credentials: CREDENTIALS,
  credentialHelp: [
    "a service principal of its own: in the Azure portal, Microsoft Entra ID, App registrations, New registration; then Certificates & secrets, New client secret, and copy its Value",
    "on the DNS zone alone, Access control (IAM), Add role assignment, DNS Zone Contributor, assigned to that application: no role on the resource group or the subscription",
    'or: az ad sp create-for-rbac --name sitesolide-dns --role "DNS Zone Contributor" --scopes <the zone\'s resource ID>, whose tenant, appId and password are the tenant, the client ID and the secret',
    "the subscription and the resource group are the zone's, on its Overview page",
  ],
  docs: DOCS,
  // ns1-39.azure-dns.com, ns2-39.azure-dns.net, ns3-39.azure-dns.org, ns4-39.azure-dns.info
  nameServers: /^ns[1-4]-\d{2,3}\.azure-dns\.(?:com|net|org|info)$/,
  caddy: {
    package: "github.com/caddy-dns/azure",
    module: "dns.providers.azure",
    // The block's own lines are indented one tab more than `dns azure {`.
    directive: [
      "dns azure {",
      `\ttenant_id {env.${VARIABLES.tenant}}`,
      `\tclient_id {env.${VARIABLES.client}}`,
      `\tclient_secret {env.${VARIABLES.secret}}`,
      `\tsubscription_id {env.${VARIABLES.subscription}}`,
      `\tresource_group_name {env.${VARIABLES.group}}`,
      "}",
    ],
    environment: caddyEnvironment,
  },
  apiVariable: API_VARIABLE,
  open: (context) => azureDns(context),
};
