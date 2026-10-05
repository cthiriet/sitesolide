/**
 * The zone's DNS records, through Cloudflare's API: the bare zone and its
 * wildcard, each pointed at the machine.
 *
 *   <zone>     A     the machine's IPv4      DNS only, TTL auto
 *   *.<zone>   A     the machine's IPv4      DNS only, TTL auto
 *   <zone>     AAAA  the machine's IPv6      when it has one
 *   *.<zone>   AAAA  the machine's IPv6      when it has one
 *
 * NEVER SOMEONE ELSE'S RECORD. A record that already says what it should is
 * left as it is; a missing one is created; a record that points elsewhere, a
 * CNAME where an address should be, an AAAA when the machine has no IPv6 or a
 * record proxied through Cloudflare is refused, all of them named, and nothing
 * is written: the zone may serve something today. Only `--dns-replace`, the
 * owner's explicit decision, updates or deletes them. The whole plan is drawn
 * before the first write, so that a refusal never comes half way.
 *
 * Proxied records are refused rather than kept: Cloudflare's proxy answers in
 * the machine's place, hides its address from the wildcard's visitors and
 * terminates TLS itself, which the platform does not expect.
 *
 * THE TOKEN TRAVELS IN ONE PLACE ONLY, the Authorization header. Never in a
 * URL, never in an error: whatever text comes back from outside is scrubbed of
 * it before it is shown. `SITESOLIDE_CLOUDFLARE_API` points the module at
 * another base URL, a mock in the tests.
 *
 * A zone that is a subdomain of a Cloudflare zone, `sites.example.com` in
 * `example.com`, is found through its parents: the records are then
 * `sites.example.com` and `*.sites.example.com` in that parent zone.
 */

export const DEFAULT_CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_API_VARIABLE = "SITESOLIDE_CLOUDFLARE_API";

/** The API's base URL, the environment's when it names one. */
export function cloudflareBase(environment: Record<string, string | undefined> = process.env): string {
  const chosen = environment[CLOUDFLARE_API_VARIABLE];
  return (chosen === undefined || chosen === "" ? DEFAULT_CLOUDFLARE_API : chosen).replace(/\/+$/, "");
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type Api = { base: string; token: string; fetcher?: Fetcher };

/**
 * `token`: refused or invalid; `zone`: no zone the token can read holds the
 * name; `refused`: the API said no to a request; `unreachable`: no answer, or
 * not the API's; `conflict`: records that point elsewhere.
 */
export type CloudflareFailure = "token" | "zone" | "refused" | "unreachable" | "conflict";

export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly kind: CloudflareFailure,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "CloudflareError";
  }
}

export type DnsRecord = { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number };

type Envelope<T> = {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; per_page: number; total_pages: number; count: number; total_count: number };
};

/** The token, wherever a text from outside might carry it: replaced. */
export function scrub(text: string, token: string): string {
  return token === "" ? text : text.replaceAll(token, "[token]");
}

async function call<T>(api: Api, method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<Envelope<T>> {
  const url = new URL(`${api.base}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await (api.fetcher ?? fetch)(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${api.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new CloudflareError(scrub(`cannot reach ${api.base}: ${error instanceof Error ? error.message : String(error)}`, api.token), "unreachable");
  }
  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new CloudflareError(`${api.base} answered HTTP ${response.status} with something that is not Cloudflare's API`, "unreachable");
  }
  if (envelope === null || typeof envelope !== "object" || envelope.success !== true) {
    const said = (envelope?.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ") || `HTTP ${response.status}`;
    const kind = response.status === 401 || response.status === 403 ? "token" : "refused";
    throw new CloudflareError(scrub(`Cloudflare refused ${method} ${path}: ${said}`, api.token), kind);
  }
  return envelope;
}

/** Every page of a listing. A runaway pagination stops rather than looping. */
async function all<T>(api: Api, path: string, query: Record<string, string>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const envelope = await call<T[]>(api, "GET", path, { ...query, page: String(page), per_page: "50" });
    if (!Array.isArray(envelope.result)) throw new CloudflareError(`Cloudflare's answer to GET ${path} holds no list`, "unreachable");
    items.push(...envelope.result);
    const pages = envelope.result_info?.total_pages ?? 1;
    if (page >= pages || envelope.result.length === 0) return items;
  }
  throw new CloudflareError(`GET ${path} went on for more than 100 pages`, "refused");
}

/** Whether the token is valid and active, as Cloudflare says of a user token. */
export async function verifyToken(api: Api): Promise<void> {
  const envelope = await call<{ status?: string }>(api, "GET", "/user/tokens/verify");
  if (envelope.result?.status !== "active") {
    throw new CloudflareError(`the Cloudflare token is not active: ${envelope.result?.status ?? "no status"}`, "token");
  }
}

/** The names a zone may be held under: itself, then each parent down to two labels. */
export function zoneCandidates(zone: string): string[] {
  const labels = zone.split(".");
  const names: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) names.push(labels.slice(i).join("."));
  return names;
}

/** The Cloudflare zone that holds `zone`, itself or a parent. */
export async function findZone(api: Api, zone: string): Promise<{ id: string; name: string }> {
  for (const name of zoneCandidates(zone)) {
    const found = await all<{ id: string; name: string }>(api, "/zones", { name });
    const exact = found.find((candidate) => candidate.name === name);
    if (exact !== undefined) return { id: exact.id, name: exact.name };
  }
  throw new CloudflareError(`no Cloudflare zone the token can read holds ${zone}`, "zone", [
    `looked for: ${zoneCandidates(zone).join(", ")}`,
    "check --zone, and that the token has Zone / Zone / Read and Zone / DNS / Edit on that zone",
  ]);
}

/** The records of one name, every type, every page. */
export async function listRecords(api: Api, zoneId: string, name: string): Promise<DnsRecord[]> {
  const records = await all<DnsRecord>(api, `/zones/${encodeURIComponent(zoneId)}/dns_records`, { name });
  // Filtered here as well: the name filter is the API's, and what is decided
  // below must only ever concern these two names.
  return records.filter((record) => record.name.toLowerCase() === name.toLowerCase());
}

// --- the plan ----------------------------------------------------------------

export type Desired = { name: string; type: "A" | "AAAA"; content: string | null };

/** The records the zone needs: an IPv6 of null means no AAAA may exist. */
export function desiredRecords(zone: string, ipv4: string, ipv6: string | null): Desired[] {
  return [zone, `*.${zone}`].flatMap((name): Desired[] => [
    { name, type: "A", content: ipv4 },
    { name, type: "AAAA", content: ipv6 },
  ]);
}

export type RecordAction =
  | { kind: "keep"; record: DnsRecord }
  | { kind: "create"; name: string; type: "A" | "AAAA"; content: string }
  | { kind: "update"; record: DnsRecord; content: string }
  | { kind: "delete"; record: DnsRecord }
  | { kind: "conflict"; record: DnsRecord; reason: string };

/** An address as one spelling: IPv6 has many, `2001:DB8:0::1` is `2001:db8::1`. */
export function canonicalAddress(address: string): string {
  if (!address.includes(":")) return address.trim();
  try {
    return new URL(`http://[${address.trim()}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return address.trim().toLowerCase();
  }
}

function sameAddress(a: string, b: string): boolean {
  return canonicalAddress(a) === canonicalAddress(b);
}

/**
 * What to do with each record, decided before anything is written. Records of
 * other types at these names, MX or TXT at the bare zone, are none of setup's
 * business and are left out.
 */
export function planRecords(existing: readonly DnsRecord[], desired: readonly Desired[], replace: boolean): RecordAction[] {
  const actions: RecordAction[] = [];
  const at = (name: string) => existing.filter((record) => record.name.toLowerCase() === name.toLowerCase());

  for (const name of [...new Set(desired.map((entry) => entry.name))]) {
    for (const record of at(name).filter((candidate) => candidate.type === "CNAME")) {
      actions.push(
        replace
          ? { kind: "delete", record }
          : { kind: "conflict", record, reason: "a CNAME, beside which an address record cannot exist" },
      );
    }
  }

  for (const entry of desired) {
    const records = at(entry.name).filter((record) => record.type === entry.type);
    if (entry.content === null) {
      for (const record of records) {
        actions.push(
          replace
            ? { kind: "delete", record }
            : { kind: "conflict", record, reason: "the machine has no IPv6, and this sends IPv6 visitors elsewhere" },
        );
      }
      continue;
    }
    const content = entry.content;
    const matching = records.filter((record) => sameAddress(record.content, content));
    const others = records.filter((record) => !sameAddress(record.content, content));

    if (records.length === 0) {
      actions.push({ kind: "create", name: entry.name, type: entry.type, content });
      continue;
    }
    if (others.length > 0 && !replace) {
      for (const record of others) actions.push({ kind: "conflict", record, reason: `points at ${record.content}, not at the machine` });
      continue;
    }
    const kept = matching[0] ?? others[0]!;
    if (kept.proxied && !replace) {
      actions.push({ kind: "conflict", record: kept, reason: "proxied through Cloudflare, which answers in the machine's place" });
    } else if (kept.proxied || !sameAddress(kept.content, content)) {
      actions.push({ kind: "update", record: kept, content });
    } else {
      actions.push({ kind: "keep", record: kept });
    }
    for (const record of records) {
      if (record !== kept) actions.push({ kind: "delete", record });
    }
  }
  return actions;
}

/** One record as a line: `example.com A 203.0.113.10`. */
export function recordLine(record: { name: string; type: string; content: string }): string {
  return `${record.name} ${record.type} ${record.content}`;
}

/** What a plan changes, for the report: nothing when every record was there. */
export function describePlan(actions: readonly RecordAction[]): string[] {
  return actions.flatMap((action) => {
    switch (action.kind) {
      case "create":
        return [`created ${recordLine(action)}`];
      case "update":
        return [`updated ${recordLine(action.record)} -> ${action.content}, DNS only`];
      case "delete":
        return [`deleted ${recordLine(action.record)}`];
      default:
        return [];
    }
  });
}

async function apply(api: Api, zoneId: string, actions: readonly RecordAction[]): Promise<void> {
  const base = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  // Deletions first: a CNAME has to go before an address record can take its name.
  for (const action of actions) {
    if (action.kind === "delete") await call(api, "DELETE", `${base}/${encodeURIComponent(action.record.id)}`);
  }
  for (const action of actions) {
    if (action.kind === "update") {
      await call(api, "PATCH", `${base}/${encodeURIComponent(action.record.id)}`, {}, { content: action.content, proxied: false, ttl: 1 });
    }
  }
  for (const action of actions) {
    if (action.kind === "create") {
      await call(api, "POST", base, {}, { type: action.type, name: action.name, content: action.content, proxied: false, ttl: 1 });
    }
  }
}

/**
 * The four records, or two without IPv6, made to point at the machine. The
 * token is verified first; a token Cloudflare cannot verify as a user token,
 * an account-owned one, is still used if it reads the zone.
 */
export async function ensureRecords(
  api: Api,
  zone: string,
  addresses: { ipv4: string; ipv6: string | null },
  replace: boolean,
): Promise<{ zone: string; actions: RecordAction[] }> {
  let verification: CloudflareError | null = null;
  try {
    await verifyToken(api);
  } catch (error) {
    if (!(error instanceof CloudflareError) || error.kind !== "token") throw error;
    verification = error;
  }

  let found: { id: string; name: string };
  try {
    found = await findZone(api, zone);
  } catch (error) {
    if (verification !== null && error instanceof CloudflareError && (error.kind === "token" || error.kind === "zone")) {
      throw new CloudflareError("the Cloudflare token is not valid", "token", [
        verification.message,
        "create one at dash.cloudflare.com/profile/api-tokens with Zone / Zone / Read and Zone / DNS / Edit on the zone",
      ]);
    }
    throw error;
  }

  const existing = [...(await listRecords(api, found.id, zone)), ...(await listRecords(api, found.id, `*.${zone}`))];
  const actions = planRecords(existing, desiredRecords(zone, addresses.ipv4, addresses.ipv6), replace);
  const conflicts = actions.filter((action): action is Extract<RecordAction, { kind: "conflict" }> => action.kind === "conflict");
  if (conflicts.length > 0) {
    throw new CloudflareError("records that point elsewhere", "conflict", [
      ...conflicts.map((conflict) => `${recordLine(conflict.record)}: ${conflict.reason}`),
      "nothing was written: the zone may be serving something with them",
    ]);
  }
  await apply(api, found.id, actions);
  return { zone: found.name, actions };
}

/** The records to create by hand, `--skip-dns`'s list. */
export function manualRecords(zone: string, ipv4: string, ipv6: string | null): string[] {
  return desiredRecords(zone, ipv4, ipv6)
    .filter((entry) => entry.content !== null)
    .map((entry) => `${entry.name.padEnd(zone.length + 3)} ${entry.type.padEnd(5)} ${entry.content}   DNS only, TTL auto`);
}
