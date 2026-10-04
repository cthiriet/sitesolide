/**
 * The two files that say which credentials the machine lends, and to whom:
 * `/etc/sitesolide-egress/connectors.json` and `grants.json`.
 *
 * The steward writes them, from the dashboard's Connectors page, unlocked like
 * a secret; the egress proxy reads them and forwards with the credential added.
 * Both run this one module: the steward borrows it (dashboard/borrowed/), the
 * proxy embeds it. A rule written twice would one day accept on one side what
 * the other refuses, and the page would show a connector the proxy ignores.
 *
 * Here rather than in egress/ because a borrowed file is copied flat and may
 * only import its neighbours, and its neighbours are the manifest's rules. The
 * CLI itself never reads these files: the machine is their only holder.
 *
 * **A credential's value goes nowhere but into the file.** No message built
 * here quotes it, no view returns it, and the page never reads it back: like a
 * private key in the Secrets section, it is replaced, never shown.
 *
 * Pure: parses, checks, rewrites text.
 */
import { isValidConnectorName, normalizeHost } from "./egress";
import { isValidSlug } from "./manifest";

/** Where the two files live, readable by the proxy's account alone. */
export const EGRESS_CONFIG_DIR = "/etc/sitesolide-egress";
export const CONNECTORS_FILE = "connectors.json";
export const GRANTS_FILE = "grants.json";

/**
 * The proxy's system account. The files belong to root, group this account,
 * mode 0640: the proxy reads them and can neither rewrite them nor change
 * their mode, and no other account opens them.
 */
export const EGRESS_ACCOUNT = "sitesolide-egress";
export const CONFIG_FILE_MODE = 0o640;

/** Who wrote: the dashboard's password holder, until people have accounts of their own. */
export const OWNER_ACTOR = "owner";

/**
 * One credential. `value` is the whole header value, `Bearer xoxb-...`
 * included: APIs disagree on the prefix, and the administrator knows it.
 */
export type ConnectorRecord = {
  baseUrl: string;
  header: string;
  value: string;
  /** Any change, the base address or the header included. */
  updatedAt: string;
  /** The value's last change alone: the audit says a credential was rotated without ever comparing values. */
  secretUpdatedAt: string;
  updatedBy: string;
};

export type ConnectorsFile = {
  version: 1;
  updatedAt: string | null;
  updatedBy: string | null;
  connectors: Record<string, ConnectorRecord>;
};

export type GrantRecord = { slug: string; connector: string; at: string; by: string };

export type GrantsFile = {
  version: 1;
  updatedAt: string | null;
  updatedBy: string | null;
  grants: GrantRecord[];
};

/** A connector as the page sees it: everything but the value. */
export type ConnectorView = Omit<ConnectorRecord, "value"> & { name: string };

export const EMPTY_CONNECTORS: ConnectorsFile = { version: 1, updatedAt: null, updatedBy: null, connectors: {} };
export const EMPTY_GRANTS: GrantsFile = { version: 1, updatedAt: null, updatedBy: null, grants: [] };

/** Bounds that keep the files small enough to read on every request. */
export const MAX_CONNECTOR_COUNT = 64;
export const MAX_GRANT_COUNT = 4096;
export const MAX_BASE_URL = 512;
export const MAX_VALUE_BYTES = 8192;

/**
 * Headers a connector may not set: they frame the request itself, and the
 * proxy computes them. Any other name is the administrator's choice:
 * `Authorization`, `X-Api-Key`, `PRIVATE-TOKEN`.
 */
export const FRAMING_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "proxy-authorization",
  "proxy-connection",
];

/** The connector's address once read: HTTPS, a name, a port and a path prefix. */
export type BaseUrl = { url: string; host: string; port: number; path: string };

/**
 * Reads a connector's base address: `https://slack.com/api`. Refused: another
 * scheme, a credential in the address, a query or a fragment, an IP address,
 * and anything the URL parser would read differently from how it is written.
 * The path is a prefix the proxy keeps every forwarded request under.
 */
export function readBaseUrl(raw: unknown): BaseUrl | { error: string } {
  const refusal = { error: "base address: must be https://, a host name and an optional path, such as https://slack.com/api" };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BASE_URL) return refusal;
  if (/[\s?#\\]/.test(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return refusal;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refusal;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return refusal;
  const host = normalizeHost(url.hostname);
  if (host === null) return { error: "base address: a host name, never an IP address" };
  if (/%2f|%5c|%2e/i.test(url.pathname)) return refusal;
  const port = url.port === "" ? 443 : Number(url.port);
  const path = url.pathname.replace(/\/+$/, "");
  return { url: `https://${host}${port === 443 ? "" : `:${port}`}${path}`, host, port, path };
}

/** Why a header name will not do, or null. */
export function headerNameError(name: unknown): string | null {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)) {
    return "header: a header name, letters, digits and dashes, such as Authorization";
  }
  if (FRAMING_HEADERS.includes(name.toLowerCase())) return `header: ${name} frames the request, the proxy sets it`;
  return null;
}

/**
 * Why a value will not do, or null. Visible ASCII and inner spaces only: a
 * line break would add a header of its own, and a header value is no place
 * for anything else. The message never quotes the value.
 */
export function headerValueError(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "value: the whole header value, such as Bearer xoxb-...";
  if (value.length > MAX_VALUE_BYTES) return `value: ${MAX_VALUE_BYTES} characters at most`;
  if (!/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value)) {
    return "value: printable ASCII, no line break, no leading or trailing space";
  }
  return null;
}

/** Who wrote a line: `owner`, `system`, an email, a token. Short, on one line. */
function isActor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 254 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(object).every((key) => keys.includes(key));
}

function readHeaderFields(object: Record<string, unknown>): { updatedAt: string | null; updatedBy: string | null } | null {
  const { version, updatedAt = null, updatedBy = null } = object;
  if (version !== 1) return null;
  if (updatedAt !== null && !isTimestamp(updatedAt)) return null;
  if (updatedBy !== null && !isActor(updatedBy)) return null;
  return { updatedAt, updatedBy };
}

/**
 * connectors.json read and checked whole. A single entry that does not read
 * refuses the whole file: the proxy then lends nothing, and the page says the
 * file is not in a form managed here, rather than each silently dropping a
 * different entry. An empty or missing file is an empty list.
 */
export function parseConnectors(text: string): { file: ConnectorsFile } | { error: string } {
  if (text.trim() === "") return { file: EMPTY_CONNECTORS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${CONNECTORS_FILE} is not JSON` };
  }
  if (!isObject(parsed) || !onlyKeys(parsed, ["version", "updatedAt", "updatedBy", "connectors"])) {
    return { error: `${CONNECTORS_FILE} is not in a known shape` };
  }
  const header = readHeaderFields(parsed);
  if (header === null || !isObject(parsed.connectors)) return { error: `${CONNECTORS_FILE} is not in a known shape` };
  const entries = Object.entries(parsed.connectors);
  if (entries.length > MAX_CONNECTOR_COUNT) return { error: `${CONNECTORS_FILE} holds more than ${MAX_CONNECTOR_COUNT} connectors` };
  const connectors: Record<string, ConnectorRecord> = {};
  for (const [name, record] of entries) {
    if (!isValidConnectorName(name)) return { error: `${CONNECTORS_FILE}: "${String(name).slice(0, 40)}" is not a connector name` };
    if (!isObject(record) || !onlyKeys(record, ["baseUrl", "header", "value", "updatedAt", "secretUpdatedAt", "updatedBy"])) {
      return { error: `${CONNECTORS_FILE}: ${name} is not in a known shape` };
    }
    const base = readBaseUrl(record.baseUrl);
    if ("error" in base || base.url !== record.baseUrl) return { error: `${CONNECTORS_FILE}: ${name} has an unusable base address` };
    if (headerNameError(record.header) !== null) return { error: `${CONNECTORS_FILE}: ${name} has an unusable header name` };
    if (headerValueError(record.value) !== null) return { error: `${CONNECTORS_FILE}: ${name} has an unusable value` };
    if (!isTimestamp(record.updatedAt) || !isTimestamp(record.secretUpdatedAt) || !isActor(record.updatedBy)) {
      return { error: `${CONNECTORS_FILE}: ${name} has unreadable dates or author` };
    }
    connectors[name] = {
      baseUrl: base.url,
      header: record.header as string,
      value: record.value as string,
      updatedAt: record.updatedAt,
      secretUpdatedAt: record.secretUpdatedAt,
      updatedBy: record.updatedBy,
    };
  }
  return { file: { version: 1, ...header, connectors } };
}

/** grants.json read and checked whole, with the same all-or-nothing rule. */
export function parseGrants(text: string): { file: GrantsFile } | { error: string } {
  if (text.trim() === "") return { file: EMPTY_GRANTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${GRANTS_FILE} is not JSON` };
  }
  if (!isObject(parsed) || !onlyKeys(parsed, ["version", "updatedAt", "updatedBy", "grants"])) {
    return { error: `${GRANTS_FILE} is not in a known shape` };
  }
  const header = readHeaderFields(parsed);
  if (header === null || !Array.isArray(parsed.grants)) return { error: `${GRANTS_FILE} is not in a known shape` };
  if (parsed.grants.length > MAX_GRANT_COUNT) return { error: `${GRANTS_FILE} holds more than ${MAX_GRANT_COUNT} grants` };
  const grants: GrantRecord[] = [];
  const seen = new Set<string>();
  for (const grant of parsed.grants as unknown[]) {
    if (!isObject(grant) || !onlyKeys(grant, ["slug", "connector", "at", "by"])) return { error: `${GRANTS_FILE}: a grant is not in a known shape` };
    const { slug, connector, at, by } = grant;
    if (typeof slug !== "string" || !isValidSlug(slug) || !isValidConnectorName(connector) || !isTimestamp(at) || !isActor(by)) {
      return { error: `${GRANTS_FILE}: a grant is unreadable` };
    }
    const key = `${slug}/${connector}`;
    if (seen.has(key)) return { error: `${GRANTS_FILE}: ${key} is granted twice` };
    seen.add(key);
    grants.push({ slug, connector, at, by });
  }
  return { file: { version: 1, ...header, grants } };
}

/** The file's text, keys in a fixed order, so that two writes of one state are one text. */
export function serializeConnectors(file: ConnectorsFile): string {
  const connectors: Record<string, ConnectorRecord> = {};
  for (const name of Object.keys(file.connectors).sort()) {
    const record = file.connectors[name]!;
    connectors[name] = {
      baseUrl: record.baseUrl,
      header: record.header,
      value: record.value,
      updatedAt: record.updatedAt,
      secretUpdatedAt: record.secretUpdatedAt,
      updatedBy: record.updatedBy,
    };
  }
  return `${JSON.stringify({ version: 1, updatedAt: file.updatedAt, updatedBy: file.updatedBy, connectors }, null, 2)}\n`;
}

export function serializeGrants(file: GrantsFile): string {
  const grants = [...file.grants]
    .sort((a, b) => a.connector.localeCompare(b.connector) || a.slug.localeCompare(b.slug))
    .map(({ slug, connector, at, by }) => ({ slug, connector, at, by }));
  return `${JSON.stringify({ version: 1, updatedAt: file.updatedAt, updatedBy: file.updatedBy, grants }, null, 2)}\n`;
}

/** What the page may see of the connectors: everything but the values. */
export function connectorViews(file: ConnectorsFile): ConnectorView[] {
  return Object.keys(file.connectors)
    .sort()
    .map((name) => {
      const { value: _value, ...rest } = file.connectors[name]!;
      return { name, ...rest };
    });
}

export function isGranted(grants: GrantsFile, slug: string, connector: string): boolean {
  return grants.grants.some((grant) => grant.slug === slug && grant.connector === connector);
}

/** What the page sends to create or change a connector. `value` null keeps the one in place. */
export type ConnectorInput = { name: unknown; baseUrl: unknown; header: unknown; value: unknown };

/**
 * The connectors with this one created or changed. A creation needs a value;
 * a change without one keeps the value in place and its date, so that the
 * audit says a base address moved without claiming the credential was rotated.
 */
export function putConnector(
  file: ConnectorsFile,
  input: ConnectorInput,
  now: string,
  actor: string,
): { file: ConnectorsFile; created: boolean } | { error: string } {
  if (!isValidConnectorName(input.name)) {
    return { error: "name: a letter, then lowercase letters, digits and dashes, 32 characters at most, such as slack" };
  }
  const base = readBaseUrl(input.baseUrl);
  if ("error" in base) return base;
  const headerError = headerNameError(input.header);
  if (headerError !== null) return { error: headerError };
  const existing = file.connectors[input.name];
  if (input.value === null && existing === undefined) return { error: "value: required to create a connector" };
  if (input.value !== null) {
    const valueError = headerValueError(input.value);
    if (valueError !== null) return { error: valueError };
  }
  if (existing === undefined && Object.keys(file.connectors).length >= MAX_CONNECTOR_COUNT) {
    return { error: `${MAX_CONNECTOR_COUNT} connectors at most` };
  }
  const value = input.value === null ? existing!.value : (input.value as string);
  const record: ConnectorRecord = {
    baseUrl: base.url,
    header: input.header as string,
    value,
    updatedAt: now,
    secretUpdatedAt: existing === undefined || value !== existing.value ? now : existing.secretUpdatedAt,
    updatedBy: actor,
  };
  return {
    file: { version: 1, updatedAt: now, updatedBy: actor, connectors: { ...file.connectors, [input.name]: record } },
    created: existing === undefined,
  };
}

/** The connector removed, and every grant of it with it: a grant of nothing would come back with a new one of the same name. */
export function removeConnector(
  connectors: ConnectorsFile,
  grants: GrantsFile,
  name: string,
  now: string,
  actor: string,
): { connectors: ConnectorsFile; grants: GrantsFile } | { error: string } {
  if (connectors.connectors[name] === undefined) return { error: `no connector named ${name}` };
  const { [name]: _removed, ...rest } = connectors.connectors;
  const kept = grants.grants.filter((grant) => grant.connector !== name);
  return {
    connectors: { version: 1, updatedAt: now, updatedBy: actor, connectors: rest },
    grants: kept.length === grants.grants.length ? grants : { version: 1, updatedAt: now, updatedBy: actor, grants: kept },
  };
}

/** The grants with this one added or withdrawn. Granting an unknown connector is refused. */
export function setGrant(
  grants: GrantsFile,
  connectors: ConnectorsFile,
  slug: unknown,
  connector: unknown,
  granted: boolean,
  now: string,
  actor: string,
): { file: GrantsFile; changed: boolean } | { error: string } {
  if (typeof slug !== "string" || !isValidSlug(slug)) return { error: "slug: not a site name" };
  if (!isValidConnectorName(connector)) return { error: "connector: not a connector name" };
  const present = isGranted(grants, slug, connector);
  if (granted) {
    if (connectors.connectors[connector] === undefined) return { error: `no connector named ${connector}` };
    if (present) return { file: grants, changed: false };
    if (grants.grants.length >= MAX_GRANT_COUNT) return { error: `${MAX_GRANT_COUNT} grants at most` };
    return {
      file: { version: 1, updatedAt: now, updatedBy: actor, grants: [...grants.grants, { slug, connector, at: now, by: actor }] },
      changed: true,
    };
  }
  if (!present) return { file: grants, changed: false };
  return {
    file: {
      version: 1,
      updatedAt: now,
      updatedBy: actor,
      grants: grants.grants.filter((grant) => !(grant.slug === slug && grant.connector === connector)),
    },
    changed: true,
  };
}
