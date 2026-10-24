/**
 * DigitalOcean, through its API v2:
 * https://docs.digitalocean.com/reference/api/reference/, whose OpenAPI
 * source is https://github.com/digitalocean/openapi.
 *
 * A machine is four resources:
 *
 *   - the workstation's SSH key, reused when the account already holds it
 *     under any name, uploaded as `sitesolide-<name>` otherwise;
 *   - the tag `sitesolide-machine:<name>`, which the firewall targets;
 *   - a Cloud Firewall named `sitesolide-<name>`, inbound TCP 22, 80 and 443
 *     and ICMP from everywhere, outbound everything;
 *   - the Droplet, with IPv6, the key for root, no user_data, tagged
 *     `managed-by:sitesolide` and `sitesolide-machine:<name>`.
 *
 * DigitalOcean has no labels, and tags only exist on some resources, which
 * is why the four are recognised in three different ways:
 *
 *   - a Droplet is ours when it carries the tag `managed-by:sitesolide`;
 *   - a firewall cannot carry it: a firewall's tags are not a description, they
 *     are the Droplets it applies to, and `managed-by:sitesolide` would apply
 *     every machine's firewall to every other machine. Ours targets the tag
 *     `sitesolide-machine:<name>` and is named `sitesolide-<name>`; a firewall
 *     of that name targeting anything else is somebody else's. Targeting the
 *     tag rather than the Droplet's id also means the firewall is in place
 *     from the Droplet's first boot, since the Droplet is created with it;
 *   - an SSH key carries nothing at all. When this command uploads one for a
 *     machine, the Droplet is also tagged `sitesolide-key:<key id>`: that tag,
 *     read before the Droplet is deleted, is the only thing that lets
 *     `--delete-key` delete a key, so that a key the account held before is
 *     never deleted, whatever its name.
 *
 * Everything that can refuse is read before the first write, so that a
 * refusal leaves nothing behind: the Droplet by name (names are not unique at
 * DigitalOcean, and one sitesolide did not create is never touched), the
 * region, the size and the image against what DigitalOcean sells there, and
 * the firewall's name. When the order itself is refused (a 4xx, 429 apart),
 * the key, the tag and the firewall this run created for it are deleted
 * again. Any other outcome is unknown (no answer, a 5xx, a 429, an answer cut
 * short) and undoes nothing: the Droplet may exist, and deleting its firewall
 * would leave it open. The next run finds it, makes its firewall again if it
 * is gone, or finds the rest and orders again.
 *
 * Destroying never deletes what DigitalOcean detaches from a Droplet and goes
 * on billing, its volumes and its reserved IPs: they are read before, and
 * listed as kept.
 *
 * A Droplet keeps its public IPv4 address until it is destroyed, powered off
 * and on included (https://docs.digitalocean.com/products/droplets/how-to/rebuild/:
 * the address goes back to the pool only on destroy), so no Reserved IP is
 * needed for DNS records to stay right.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and fails with a ProviderError whose code
 * bin/cli/hints.ts knows. The API's error format is `{"id", "message",
 * "request_id"}`, and `{"error", "messages", "root_causes"}` on the tags'
 * 400; `failureFrom` reads both.
 *
 * Lists are paginated: `links.pages.next` is followed until it is absent, two
 * hundred items a page, the most the API returns. Only the page number is read
 * from that link, and the request is built on the API's own address: the token
 * never follows an address an answer named. The token may make 5000 requests
 * an hour and 250 a minute, and list the SSH keys ten times a minute: that last
 * limit is in the "Rate Limit" section of the reference's introduction
 * (specification/description.yml of the OpenAPI source), which the page of
 * the SSH keys does not repeat. Actions are polled every two seconds, bounded.
 */
import {
  apiAddress,
  DEBIAN,
  formatPrice,
  isManagedTags,
  keyMaterial,
  machineOfTags,
  MANAGED_LABEL,
  MANAGED_VALUE,
  MACHINE_LABEL,
  patiently,
  ProviderError,
  tagsFor,
  TRANSIENT,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type DestroyOutcome,
  type Machine,
  type Provider,
  type ProviderContext,
  type ProviderEntry,
  type Report,
  type Resource,
  type Workstation,
} from "./provider";
import type { Failure } from "../remote";

export const DEFAULT_API = "https://api.digitalocean.com/v2";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_DIGITALOCEAN_API";

/** The variable the Terraform provider reads, and the one this command reads first. */
export const TOKEN_VARIABLE = "DIGITALOCEAN_TOKEN";

/** The variable doctl reads (and Terraform too): `discover` takes the token from it when the first is unset. */
export const DOCTL_VARIABLE = "DIGITALOCEAN_ACCESS_TOKEN";

/**
 * A personal access token, `dop_v1_` and 64 hex digits, an OAuth token from
 * `doctl auth login`, `doo_v1_`, or a token from before 2021, 64 hex digits
 * alone: the lengths doctl itself accepts at its prompt.
 */
export const TOKEN_SHAPE = /^(?:[0-9a-f]{64}|do[a-z]_v1_[0-9a-f]{64})$/;

/**
 * The cheapest size of the current Basic plans with at least 2 GB of memory,
 * at Frankfurt, the region of the three countries sitesolide prefers
 * (Germany, France, the Netherlands) that comes first by name; Amsterdam is
 * the other. Debian 13 is the only system `sitesolide setup` is verified on.
 */
export const DEFAULTS = { type: "s-1vcpu-2gb", location: "fra1", image: DEBIAN };

/** `debian-13`, as DigitalOcean names its official Debian 13 (trixie) image. */
export const IMAGES: Record<string, string> = { [DEBIAN]: "debian-13-x64" };

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  actionMs: 10 * 60_000,
  activeMs: 5 * 60_000,
  /** The firewall applied to the new Droplet; a warning, not a failure, past it. */
  firewallMs: 2 * 60_000,
  /** A deleted Droplet still answering for a moment. */
  goneMs: 3 * 60_000,
  pollMs: 2_000,
};

/** The most items a page holds. */
const PER_PAGE = 200;

/** The tag that names the key uploaded for a machine, followed by the key's id. */
export const KEY_TAG = "sitesolide-key";

const EVERYWHERE = (): { addresses: string[] } => ({ addresses: ["0.0.0.0/0", "::/0"] });

/**
 * What enters: SSH, HTTP and HTTPS, and ping, which serves diagnosis and
 * external monitoring. An ICMP rule takes no ports: the API reads it as all of
 * them, and answers "0".
 */
export const INBOUND_RULES = [
  { protocol: "tcp", ports: "22", sources: EVERYWHERE() },
  { protocol: "tcp", ports: "80", sources: EVERYWHERE() },
  { protocol: "tcp", ports: "443", sources: EVERYWHERE() },
  { protocol: "icmp", sources: EVERYWHERE() },
];

/**
 * What leaves: everything. A Cloud Firewall denies whatever no rule allows,
 * outbound included, and without these the machine could reach neither its
 * package mirrors, nor DNS, nor Let's Encrypt. "all" is answered back as "0".
 */
export const OUTBOUND_RULES = [
  { protocol: "tcp", ports: "all", destinations: EVERYWHERE() },
  { protocol: "udp", ports: "all", destinations: EVERYWHERE() },
  { protocol: "icmp", destinations: EVERYWHERE() },
];

/** Where each region's slug is, for the wizard: the API gives the city alone. */
const COUNTRIES: Record<string, string> = {
  ams: "NL",
  atl: "US",
  blr: "IN",
  fra: "DE",
  lon: "GB",
  nyc: "US",
  ric: "US",
  sfo: "US",
  sgp: "SG",
  syd: "AU",
  tor: "CA",
};

// --- the API's objects, as far as this file reads them ---------------------------------

type Links = { pages?: { first?: string; prev?: string; next?: string; last?: string } };

export type DoAction = {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  resource_id?: number | null;
  resource_type?: string;
};

export type DoSize = {
  slug: string;
  /** Megabytes. */
  memory: number;
  vcpus: number;
  /** Gigabytes. */
  disk: number;
  /** US dollars. */
  price_monthly: number;
  price_hourly?: number;
  regions: string[];
  available: boolean;
  description: string;
  gpu_info?: unknown;
};

export type DoRegion = { slug: string; name: string; available: boolean; features: string[]; sizes: string[] };

type DoNetwork = { ip_address: string; netmask: string | number; gateway: string | null; type: "public" | "private" };

export type DoDroplet = {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  features: string[];
  next_backup_window: { start: string; end: string } | null;
  size?: Partial<DoSize>;
  size_slug: string;
  networks: { v4?: DoNetwork[]; v6?: DoNetwork[] };
  region?: { slug: string; name?: string };
  tags: string[] | null;
  /** Absent when the token may not read volumes (block_storage:read). */
  volume_ids?: string[];
};

/** An IPv4 of /v2/reserved_ips or an IPv6 of /v2/reserved_ipv6: the Droplet is null while unassigned. */
type DoReservedIp = { ip: string; droplet: { id: number } | null };

export type DoKey = { id: number; fingerprint: string; public_key: string; name: string };

type DoRuleTarget = { addresses?: string[]; tags?: string[] | null; droplet_ids?: number[] };
type DoRule = { protocol: string; ports?: string; sources?: DoRuleTarget; destinations?: DoRuleTarget };

export type DoFirewall = {
  id: string;
  name: string;
  status: "waiting" | "succeeded" | "failed";
  pending_changes?: { droplet_id: number; removing: boolean; status: string }[];
  droplet_ids: number[] | null;
  tags: string[] | null;
  inbound_rules: DoRule[] | null;
  outbound_rules: DoRule[] | null;
};

type DoTag = { name: string; resources?: { count?: number } };
type DoImage = { id: number; slug: string | null; name: string; distribution?: string; regions?: string[]; status?: string };

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and its own id kept for the callers that tell them apart. */
export class DigitalOceanError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly id: string,
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/** A limit of the account, which is not the rate limit. */
const ACCOUNT_LIMIT = /\blimit\b/i;
const RATE = /\brate\b/i;

/**
 * An error answer of the API as a failure the CLI reports, with the code its
 * hint is found by. `what` says what was being done, in the infinitive, for
 * the message: `create the droplet web`. `now` in milliseconds, for the rate
 * limit's reset, which the API gives as a UNIX timestamp.
 *
 * The API's ids follow the status (`unprocessable_entity` for every 422), so
 * the message is what tells a droplet limit or a busy Droplet from a bad
 * request. Those messages are not part of the reference: the patterns below
 * are what DigitalOcean has been seen to answer, and an answer that matches
 * none is still a refusal with its own words.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string, now: number): DigitalOceanError {
  const error = body as { id?: unknown; message?: unknown; request_id?: unknown; error?: unknown; messages?: unknown } | null;
  const id = typeof error?.id === "string" ? error.id : "";
  const said = typeof error?.message === "string" ? error.message : typeof error?.error === "string" ? error.error : `answered ${status}`;
  const answer = `${status}${id === "" ? "" : ` ${id}`}`;
  const request = typeof error?.request_id === "string" ? [`DigitalOcean's request id, for its support: ${error.request_id}`] : [];
  const listed = Array.isArray(error?.messages) ? error.messages.filter((line): line is string => typeof line === "string") : [];
  const make = (failure: Failure) => new DigitalOceanError({ ...failure, details: [...(failure.details ?? []), ...listed, ...request] }, status, id, said);

  if (status === 401) {
    return make({
      error: "provider-unauthenticated",
      message: `DigitalOcean refused the token (${answer}): it is unknown, revoked, expired, or was copied wrong`,
      details: [
        "create a personal access token in the control panel: API, Tokens, Generate New Token, with the scopes docs/providers/digitalocean.md lists",
        "a token from `doctl auth login` expires within hours: running any doctl command renews it",
      ],
    });
  }
  if ((status === 403 || status === 422) && ACCOUNT_LIMIT.test(said) && !RATE.test(said)) {
    return make({ error: "provider-limit", message: `DigitalOcean refused to ${what} (${answer}): ${said}`, details: ["the account has reached one of its limits: the control panel shows them, and a raise is asked for there"] });
  }
  if (status === 403) {
    return make({
      error: "provider-forbidden",
      message: `the token may not ${what} (${answer}): ${said}`,
      details: ["a Read Only token, or a custom one without this scope: the token needs the scopes docs/providers/digitalocean.md lists"],
    });
  }
  if (status === 404) return make({ error: "provider-not-found", message: `DigitalOcean could not ${what} (${answer}): ${said}` });
  if (status === 409 || status === 423) return make({ error: "provider-busy", message: `DigitalOcean could not ${what} right now (${answer}): ${said}` });
  if (status === 422 && /pending event|locked|in progress/i.test(said)) {
    return make({ error: "provider-busy", message: `DigitalOcean could not ${what} right now (${answer}): ${said}` });
  }
  if (status === 422 && /already (in use|exists|been taken)/i.test(said)) {
    return make({ error: "provider-name-taken", message: `DigitalOcean refused to ${what} (${answer}): ${said}` });
  }
  if (status === 429) {
    // A burst over 250 a minute comes with Retry-After; the hourly quota
    // only with the time its oldest request expires.
    const reset = Number(headers.get("ratelimit-reset"));
    const untilReset = Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - now / 1000)) : null;
    const retryAfter = Number(headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : Math.min(60, Math.max(1, untilReset ?? 60));
    return make({
      error: "provider-rate-limited",
      message: `DigitalOcean's rate limit is reached, nothing more can be asked of it for now (${answer})`,
      details: [
        `the token may make ${headers.get("ratelimit-limit") ?? "5000"} requests an hour and 250 a minute, and list the SSH keys ten times a minute`,
        ...(untilReset === null ? [] : [`the oldest request counted expires in ${untilReset} s`]),
      ],
      wait,
    });
  }
  if (status >= 500) return make({ error: "provider-failure", message: `DigitalOcean failed to ${what} (${answer}): ${said}`, details: ["the failure is on DigitalOcean's side"] });
  return make({ error: "provider-invalid", message: `DigitalOcean refused to ${what} (${answer}): ${said}` });
}

/**
 * Whether a refused order says the size cannot be had there right now, rather
 * than that the request was wrong: a 422 that names the size or the region,
 * both checked against the lists just before.
 */
export function refusesTheOffer(error: DigitalOceanError): boolean {
  return error.status === 422 && /\b(size|region)\b|unavailable|not available|capacity/i.test(error.said);
}

/**
 * Whether a failed order says for certain that no Droplet was created: an
 * answer of 4xx, 429 apart, which says "later" and is not a decision on the
 * order. No answer, a 5xx, or a 2xx that could not be read leave the
 * outcome unknown.
 */
export function definiteRefusal(error: ProviderError): boolean {
  return error instanceof DigitalOceanError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

// --- what the answers mean -------------------------------------------------------------------

/** `256` -> `0.25`, `2048` -> `2`: megabytes as gigabytes, for a person. */
function gigabytes(megabytes: number): string {
  return String(Math.round((megabytes / 1024) * 100) / 100);
}

/**
 * The /124 a Droplet's IPv6 address belongs to: DigitalOcean routes sixteen
 * addresses to each Droplet and configures the one it reports, even though
 * the API reports the link's /64 netmask. Null when the address cannot be read.
 */
export function ipv6Block(address: string | null): string | null {
  if (address === null || !address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
  if (groups.length !== 8 || groups.some((group) => Number.isNaN(group))) return null;
  groups[7] = groups[7]! & 0xfff0;
  // The longest run of zero groups, two at least, is written `::`.
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > best.length && length >= 2) best = { start, length };
  }
  const hex = groups.map((group) => group.toString(16));
  const written = best.start === -1 ? hex.join(":") : `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.length).join(":")}`;
  return `${written}/124`;
}

/** `managed-by:sitesolide` -> `{"managed-by": "sitesolide"}`; a tag without a colon maps to an empty value. */
export function labelsOfTags(tags: readonly string[] | null | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags ?? []) {
    const colon = tag.indexOf(":");
    if (colon > 0) labels[tag.slice(0, colon)] = tag.slice(colon + 1);
    else labels[tag] = "";
  }
  return labels;
}

function publicAddress(networks: DoNetwork[] | undefined): string | null {
  return networks?.find((network) => network.type === "public")?.ip_address ?? null;
}

export function toMachine(droplet: DoDroplet): Machine {
  const ipv6 = publicAddress(droplet.networks?.v6);
  const price = droplet.size?.price_monthly;
  return {
    provider: "digitalocean",
    id: String(droplet.id),
    name: droplet.name,
    type: droplet.size_slug ?? droplet.size?.slug ?? "unknown",
    location: droplet.region?.slug ?? "unknown",
    status: droplet.status,
    ipv4: publicAddress(droplet.networks?.v4),
    ipv6,
    ipv6Network: ipv6Block(ipv6),
    // DigitalOcean quotes one price, in dollars and before the taxes of the
    // account's country, which it does not say: `gross` repeats it.
    monthlyPrice: typeof price === "number" && Number.isFinite(price) ? { net: String(price), gross: String(price), currency: "USD" } : null,
    backups: (droplet.features ?? []).includes("backups"),
    managed: isManagedTags(droplet.tags),
    labels: labelsOfTags(droplet.tags),
    // The keys of the order are written to root's authorized_keys.
    login: "root",
  };
}

/** The tag the firewall targets and the Droplet carries: `sitesolide-machine:<name>`. */
export function machineTag(name: string): string {
  return tagsFor(name)[1]!;
}

/** The firewall's name: a firewall's name takes two characters at least, and a machine's may be one. */
export function firewallName(name: string): string {
  return `sitesolide-${name}`;
}

/** Whether a firewall of the right name is the one sitesolide created for that machine: it targets the machine's tag. */
export function ownsFirewall(firewall: DoFirewall, name: string): boolean {
  return firewall.name === firewallName(name) && (firewall.tags ?? []).includes(machineTag(name));
}

/** The ids of the keys a Droplet's tags say sitesolide uploaded for it. */
export function uploadedKeys(tags: readonly string[] | null | undefined): number[] {
  return (tags ?? [])
    .filter((tag) => tag.startsWith(`${KEY_TAG}:`))
    .map((tag) => Number(tag.slice(KEY_TAG.length + 1)))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/** Whether a size can be ordered at a region, and if not, why. */
export function sizeOffer(size: DoSize | undefined, slug: string, region: string): { orderable: boolean; reason: string } {
  if (size === undefined) return { orderable: false, reason: `${slug} is not a DigitalOcean size` };
  if (!size.available) return { orderable: false, reason: `${slug} is no longer sold` };
  if (!size.regions.includes(region)) return { orderable: false, reason: `${slug} is not sold at ${region}` };
  return { orderable: true, reason: "" };
}

/** What a size is, said for a person: `1 vCPU, 2 GB RAM, 50 GB disk, Basic, 12.00 USD a month before VAT`. */
export function describeSize(size: DoSize): string {
  const price = Number.isFinite(size.price_monthly) ? `, ${formatPrice(size.price_monthly, "USD")}` : "";
  return `${size.vcpus} vCPU, ${gigabytes(size.memory)} GB RAM, ${size.disk} GB disk, ${size.description}${price}`;
}

/** A size worth offering: sold, not a GPU, and with the 2 GB a machine of sitesolide needs at least. */
function offered(size: DoSize, region: string): boolean {
  const gpu = (size.gpu_info !== undefined && size.gpu_info !== null) || size.slug.startsWith("gpu-");
  return size.available && size.regions.includes(region) && !gpu && size.memory >= 2048;
}

function byPrice(a: DoSize, b: DoSize): number {
  return (a.price_monthly ?? Number.POSITIVE_INFINITY) - (b.price_monthly ?? Number.POSITIVE_INFINITY) || a.slug.localeCompare(b.slug);
}

/** The cheapest sizes worth offering at a region, one line each, cheapest first. */
export function cheapestSizes(sizes: DoSize[], region: string, options: { except?: string; count?: number } = {}): string[] {
  return sizes
    .filter((size) => offered(size, region) && size.slug !== options.except)
    .sort(byPrice)
    .slice(0, options.count ?? 6)
    .map((size) => `${size.slug.padEnd(18)} ${describeSize(size)}`);
}

/** The suggestions of a refusal: the cheapest sizes sold at the region, or that there are none. */
export function suggestedSizes(sizes: DoSize[], region: string, except?: string): string[] {
  const lines = cheapestSizes(sizes, region, { except });
  return lines.length > 0 ? [`the cheapest sizes DigitalOcean sells at ${region}:`, ...lines] : [`DigitalOcean sells no other size at ${region}`];
}

/** `Frankfurt 1, DE`. */
export function regionLabel(region: DoRegion): string {
  const country = COUNTRIES[region.slug.replace(/[0-9]+$/, "")];
  return country === undefined ? region.name : `${region.name}, ${country}`;
}

/** The image as the order takes it: a public image's slug, or an id. */
function imageReference(image: string): string | number {
  const mapped = IMAGES[image] ?? image;
  return /^[0-9]+$/.test(mapped) ? Number(mapped) : mapped;
}

/** Whether something references a tag: a firewall that targets it or lets its Droplets in or out. */
function firewallUsesTag(firewall: DoFirewall, tag: string): boolean {
  const rules = [...(firewall.inbound_rules ?? []).map((rule) => rule.sources), ...(firewall.outbound_rules ?? []).map((rule) => rule.destinations)];
  return (firewall.tags ?? []).includes(tag) || rules.some((target) => (target?.tags ?? []).includes(tag));
}

// --- the provider ---------------------------------------------------------------------------

export function digitalocean(context: ProviderContext): Provider {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const { clock, fetcher } = context;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";
  if (token === "") {
    throw new ProviderError({ error: "no-provider-token", message: `no DigitalOcean API token: set ${TOKEN_VARIABLE}, or pipe it to --token-stdin`, details: CREDENTIAL_HELP });
  }

  /** One call: the token in its header, JSON both ways, every failure said in the CLI's words. */
  async function call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by bin/cli/machine.ts.
      throw new DigitalOceanError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, "");
    }
    if (response.status === 204) return {} as T;
    let parsed: unknown = null;
    let readable = true;
    try {
      parsed = await response.json();
    } catch {
      readable = false;
    }
    // A proxy in front of the API may answer a 502 or a 429 in HTML: still
    // DigitalOcean saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new DigitalOceanError(
        { error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not DigitalOcean's API, while trying to ${what}` },
        response.status,
        "",
      );
    }
    if (!response.ok) throw failureFrom(response.status, parsed, response.headers, what, clock.now());
    return parsed as T;
  }

  /**
   * Every page of a list. The next page's number is read from
   * `links.pages.next` and asked of the API's own address: the link is an
   * absolute address, and following it as given would send the token wherever
   * an answer pointed.
   */
  async function listAll<T>(path: string, key: string, what: string, query: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (let pages = 0; pages < 500; pages++) {
      const parameters = new URLSearchParams({ ...query, page: String(page), per_page: String(PER_PAGE) });
      const answer = await call<Record<string, unknown>>("GET", `${path}?${parameters}`, what);
      const list = answer[key];
      if (!Array.isArray(list)) {
        throw new DigitalOceanError({ error: "provider-unreadable", message: `${host} answered without the list of ${key}, while trying to ${what}` }, 200, "");
      }
      items.push(...(list as T[]));
      const next = (answer.links as Links | undefined)?.pages?.next;
      if (typeof next !== "string") break;
      let number = Number.NaN;
      try {
        number = Number(new URL(next).searchParams.get("page"));
      } catch {
        // Unreadable: refused just below, rather than taken for the last page.
      }
      if (!Number.isSafeInteger(number) || number <= page) {
        throw new DigitalOceanError({ error: "provider-unreadable", message: `${host} answered a next page that is not one, while trying to ${what}` }, 200, "");
      }
      page = number;
    }
    return items;
  }

  /** The Droplets of that name, ours first: names are unique neither at DigitalOcean nor in case. */
  async function dropletsNamed(name: string): Promise<DoDroplet[]> {
    const droplets = await listAll<DoDroplet>("/droplets", "droplets", "read the droplets", { name });
    const same = droplets.filter((droplet) => droplet.name.toLowerCase() === name.toLowerCase());
    const rank = (droplet: DoDroplet) => (isManagedTags(droplet.tags) ? (machineOfTags(droplet.tags) === name ? 0 : 1) : 2);
    return same.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  }

  async function waitForAction(id: number, label: string, report: Report): Promise<void> {
    const deadline = clock.now() + WAITS.actionMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const read = await patiently(clock, () => call<{ action: DoAction }>("GET", `/actions/${id}`, `follow ${label}`), deadline, report, warned);
      if (read !== null) {
        const action = read.action;
        if (action.status === "completed") {
          report(`   ${action.type}: done`);
          return;
        }
        if (action.status === "errored") {
          throw new ProviderError({ error: "action-failed", message: `DigitalOcean's ${action.type} failed`, details: [`action ${action.id}: its events in the control panel say why`] });
        }
        if (action.status !== last) report(`   ${action.type}: ${action.status}`);
        last = action.status;
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `DigitalOcean's ${label} still runs after ${WAITS.actionMs / 60_000} minutes`, details: [`action ${id}, ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** The Droplet once DigitalOcean says it runs and it has its public IPv4 address. */
  async function waitActive(id: number, name: string, report: Report, justCreated: boolean): Promise<DoDroplet> {
    const deadline = clock.now() + WAITS.activeMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const read = await patiently(clock, () => call<{ droplet: DoDroplet }>("GET", `/droplets/${id}`, `read the droplet ${name}`), deadline, report, warned);
      if (read !== null) {
        const droplet = read.droplet;
        if (droplet.status !== last) report(`   status: ${droplet.status}`);
        last = droplet.status;
        if (droplet.status === "active" && publicAddress(droplet.networks?.v4) !== null) return droplet;
        if (droplet.status === "off" && !justCreated) {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is powered off`, details: ["sitesolide never powers a machine on or off by itself"] });
        }
        if (droplet.status === "archive") {
          throw new ProviderError({ error: "provider-not-found", message: `the droplet ${name} is being deleted (status archive)` });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.activeMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /**
   * Waits for the firewall to be applied to the new Droplet. DigitalOcean
   * applies it on its own once the Droplet carries the tag; what it reports
   * is read here so that a firewall that failed is said, rather than a
   * machine left open without anyone knowing. A warning, not a failure: the
   * machine exists, and `setup` adds its own firewall on it.
   */
  async function waitFirewall(firewall: DoFirewall, dropletId: number, report: Report): Promise<void> {
    const deadline = clock.now() + WAITS.firewallMs;
    const warned = { done: false };
    for (;;) {
      const read = await patiently(clock, () => call<{ firewall: DoFirewall }>("GET", `/firewalls/${firewall.id}`, `read the firewall ${firewall.name}`), deadline, report, warned);
      if (read !== null) {
        const current = read.firewall;
        const pending = (current.pending_changes ?? []).some((change) => change.droplet_id === dropletId);
        if (current.status === "failed") {
          report(`!! DigitalOcean says the firewall ${firewall.name} failed to apply: check it in the control panel, Networking, Firewalls`);
          return;
        }
        if (current.status === "succeeded" && !pending) {
          report(`   firewall ${firewall.name}: applied`);
          return;
        }
      }
      if (clock.now() >= deadline) {
        report(`!! the firewall ${firewall.name} is still being applied after ${WAITS.firewallMs / 60_000} minutes: check it in the control panel, Networking, Firewalls`);
        return;
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  type Offer = { sizes: DoSize[]; region: DoRegion };

  /** Refuses what cannot be ordered; returns what the order and a refused order's suggestions need. */
  async function checkOffer(request: CreateRequest, report: Report): Promise<Offer> {
    report(`-> ${request.type} at ${request.location}, what DigitalOcean sells there`);
    const regions = await listAll<DoRegion>("/regions", "regions", "read the regions");
    const region = regions.find((candidate) => candidate.slug === request.location);
    if (region === undefined || !region.available) {
      throw new ProviderError({
        error: "invalid-location",
        message: region === undefined ? `${request.location} is not a DigitalOcean region` : `DigitalOcean no longer creates droplets at ${request.location}`,
        details: ["the regions:", ...regions.filter((candidate) => candidate.available).map((candidate) => `${candidate.slug.padEnd(5)} ${regionLabel(candidate)}`)],
      });
    }
    const sizes = await listAll<DoSize>("/sizes", "sizes", "read the sizes");
    const size = sizes.find((candidate) => candidate.slug === request.type);
    const offer = sizeOffer(size, request.type, request.location);
    if (size === undefined || !offer.orderable) {
      throw new ProviderError({ error: "invalid-server-type", message: offer.reason, details: suggestedSizes(sizes, request.location) });
    }
    report(`   ${describeSize(size)}`);
    if (request.backups && !region.features.includes("backups")) {
      throw new ProviderError({ error: "provider-unavailable", message: `DigitalOcean takes no backups at ${request.location}`, details: ["run the same command without --backups, or with another --location"] });
    }

    const image = imageReference(request.image);
    let found: DoImage;
    try {
      found = (await call<{ image: DoImage }>("GET", `/images/${encodeURIComponent(String(image))}`, `read the image ${image}`)).image;
    } catch (error) {
      if (!(error instanceof DigitalOceanError) || error.status !== 404) throw error;
      throw new ProviderError({
        error: "provider-invalid",
        message: `${image} is not a DigitalOcean image`,
        details: [`--image takes ${DEBIAN}, which is ${IMAGES[DEBIAN]} at DigitalOcean, a public image's slug, or an image's id`],
      });
    }
    if (found.status !== undefined && found.status !== "available") {
      throw new ProviderError({ error: "provider-invalid", message: `the image ${image} is ${found.status}, not available` });
    }
    if ((found.regions ?? []).length > 0 && !(found.regions ?? []).includes(request.location)) {
      throw new ProviderError({ error: "provider-invalid", message: `the image ${image} is not available at ${request.location}`, details: [`it is at ${(found.regions ?? []).join(", ")}`] });
    }
    report(`   image ${image}: ${[found.distribution, found.name].filter(Boolean).join(" ")}`);
    return { sizes, region };
  }

  /** The firewall of that name, when sitesolide created it; read before anything is created, so that a refusal leaves nothing. */
  async function findFirewall(name: string): Promise<DoFirewall | null> {
    const firewalls = await listAll<DoFirewall>("/firewalls", "firewalls", "read the firewalls");
    const same = firewalls.find((firewall) => firewall.name === firewallName(name));
    if (same !== undefined && !ownsFirewall(same, name)) {
      throw new ProviderError({
        error: "firewall-taken",
        message: `a firewall named ${firewallName(name)} exists in the account, and sitesolide did not create it`,
        details: [`it does not target the tag ${machineTag(name)}: it is never adopted nor changed`],
      });
    }
    return same ?? null;
  }

  /**
   * The workstation's key, found by its fingerprint or uploaded. `forMachine`
   * says whether the Droplet should be tagged with it, which is what lets
   * `--delete-key` delete it later: the key was uploaded now, or a run of
   * this command for this machine uploaded it under the name it gives,
   * before being interrupted.
   */
  async function ensureKey(request: CreateRequest, report: Report): Promise<{ key: DoKey; reused: boolean; forMachine: boolean }> {
    report("-> SSH key");
    const keys = await listAll<DoKey>("/account/keys", "ssh_keys", "read the SSH keys");
    const ours = `${request.key.algorithm} ${request.key.blob}`;
    const plain = `sitesolide-${request.name}`;
    const suffixed = `${plain}-${request.key.fingerprint.replaceAll(":", "").slice(0, 8)}`;
    const same = keys.find((key) => key.fingerprint === request.key.fingerprint || keyMaterial(key.public_key) === ours);
    if (same !== undefined) {
      report(`   ${same.name}, already in the account (${request.key.fingerprint}), reused`);
      return { key: same, reused: true, forMachine: same.name === plain || same.name === suffixed };
    }
    // A name of its own, never one the account already uses for another key.
    const name = keys.some((key) => key.name === plain) ? suffixed : plain;
    const line = [request.key.algorithm, request.key.blob, request.key.comment].filter((part) => part !== "").join(" ");
    const created = await call<{ ssh_key: DoKey }>("POST", "/account/keys", `upload the SSH key ${name}`, { name, public_key: line });
    report(`   ${name}, uploaded (${request.key.fingerprint})`);
    return { key: created.ssh_key, reused: false, forMachine: true };
  }

  /** The tag the firewall targets: a firewall may only name a tag that exists. */
  async function ensureTag(tag: string, report: Report): Promise<boolean> {
    report(`-> tag ${tag}`);
    try {
      await call<{ tag: DoTag }>("GET", `/tags/${tag}`, `read the tag ${tag}`);
      report("   already there, reused");
      return false;
    } catch (error) {
      if (!(error instanceof DigitalOceanError) || error.status !== 404) throw error;
    }
    await call<{ tag: DoTag }>("POST", "/tags", `create the tag ${tag}`, { name: tag });
    report("   created");
    return true;
  }

  async function ensureFirewall(name: string, found: DoFirewall | null, report: Report): Promise<{ firewall: DoFirewall; reused: boolean }> {
    report(`-> firewall ${firewallName(name)}`);
    if (found !== null) {
      report("   already created by sitesolide, reused");
      return { firewall: found, reused: true };
    }
    const created = await call<{ firewall: DoFirewall }>("POST", "/firewalls", `create the firewall ${firewallName(name)}`, {
      name: firewallName(name),
      inbound_rules: INBOUND_RULES,
      outbound_rules: OUTBOUND_RULES,
      tags: [machineTag(name)],
    });
    report(`   created: inbound tcp 22, 80, 443 and icmp, from everywhere, for the droplets tagged ${machineTag(name)}`);
    return { firewall: created.firewall, reused: false };
  }

  /**
   * The firewall of a Droplet an earlier run created, made again when it is
   * gone: an earlier run that could not finish, or a person in the control
   * panel, would otherwise leave the machine with nothing of sitesolide's in
   * front of it. A firewall of that name that is not sitesolide's is left as
   * it is, and said.
   */
  async function ensureFirewallOf(droplet: DoDroplet, name: string, report: Report): Promise<void> {
    const tag = machineTag(name);
    if (!(droplet.tags ?? []).includes(tag)) report(`!! the droplet ${droplet.name} lacks the tag ${tag}: the firewall ${firewallName(name)} does not apply to it`);
    let found: DoFirewall | null;
    try {
      found = await findFirewall(name);
    } catch (error) {
      if (!(error instanceof ProviderError) || error.failure.error !== "firewall-taken") throw error;
      report(`!! ${error.failure.message}, and none of sitesolide's applies to ${droplet.name}: it is left as it is, the control panel shows it under Networking, Firewalls`);
      return;
    }
    if (found !== null) return;
    report(`!! the firewall ${firewallName(name)} is gone: it is created again`);
    await ensureTag(tag, report);
    const { firewall } = await ensureFirewall(name, null, report);
    await waitFirewall(firewall, droplet.id, report);
  }

  async function ensureBackups(droplet: DoDroplet, report: Report): Promise<void> {
    report("-> backups");
    if ((droplet.features ?? []).includes("backups")) {
      report("   already enabled");
      return;
    }
    const answer = await call<{ action: DoAction }>("POST", `/droplets/${droplet.id}/actions`, `enable the backups of ${droplet.name}`, {
      type: "enable_backups",
      backup_policy: { plan: "daily" },
    });
    await waitForAction(answer.action.id, "enable_backups", report);
    report("   enabled: one a day, each kept seven days, 30 % on the price of the droplet");
  }

  /**
   * Deletes what this run created before an order DigitalOcean refused: the
   * key, the tag and the firewall were made for a Droplet that does not
   * exist, and nothing in sitesolide would ever list or remove them, since
   * `list` and `destroy` start from a Droplet. What an earlier run made, or
   * the account already held, is left as it was. A deletion that fails
   * leaves the resource, where the next run finds and reuses it.
   */
  async function undo(made: { kind: string; name: string; path: string }[], report: Report): Promise<string[]> {
    if (made.length === 0) return ["nothing had been created yet"];
    report("-> undo what this run created");
    const said: string[] = [];
    // The firewall first: it was created last, and names the tag.
    for (const resource of [...made].reverse()) {
      try {
        await call("DELETE", resource.path, `delete the ${resource.kind} ${resource.name}`);
        said.push(`deleted the ${resource.kind} ${resource.name} this run had created`);
      } catch {
        said.push(`left the ${resource.kind} ${resource.name}: the next run finds it and reuses it`);
      }
      report(`   ${said.at(-1)}`);
    }
    return said;
  }

  /**
   * The Reserved IPs, IPv4 and IPv6, assigned to a Droplet. A token that may
   * not read them is said, once, and the destruction goes on: they are never
   * deleted anyway, only listed as kept.
   */
  async function reservedAddresses(id: number, name: string, report: Report): Promise<string[]> {
    const found: string[] = [];
    for (const [path, key] of [
      ["/reserved_ips", "reserved_ips"],
      ["/reserved_ipv6", "reserved_ipv6s"],
    ] as const) {
      try {
        const addresses = await listAll<DoReservedIp>(path, key, "read the reserved IPs");
        found.push(...addresses.filter((address) => address.droplet?.id === id).map((address) => address.ip));
      } catch (error) {
        if (!(error instanceof DigitalOceanError) || (error.status !== 403 && error.status !== 404)) throw error;
        report(`!! could not read the reserved IPs (${error.status}): one assigned to ${name} would stay, unassigned and billed (the token needs reserved_ip:read)`);
        break;
      }
    }
    return found;
  }

  /** Waits for a deleted Droplet to answer 404; false when it still answers at the deadline. */
  async function waitGone(id: number, name: string, report: Report): Promise<boolean> {
    const deadline = clock.now() + WAITS.goneMs;
    const warned = { done: false };
    for (;;) {
      try {
        await patiently(clock, () => call<{ droplet: DoDroplet }>("GET", `/droplets/${id}`, `read the droplet ${name}`), deadline, report, warned);
      } catch (error) {
        if (error instanceof DigitalOceanError && error.status === 404) return true;
        // The deletion was accepted: a wait that ends on "later" says so, and the rest goes on.
        if (error instanceof ProviderError && TRANSIENT.has(error.failure.error)) return false;
        throw error;
      }
      if (clock.now() >= deadline) return false;
      await clock.sleep(WAITS.pollMs);
    }
  }

  /**
   * Deletes a tag created for the machine once nothing carries it and no
   * firewall names it: deleting a tag takes it off everything it is on.
   */
  async function deleteTagIfUnused(tag: string, firewalls: DoFirewall[], removed: string[], kept: string[], report: Report): Promise<void> {
    let found: DoTag;
    try {
      found = (await call<{ tag: DoTag }>("GET", `/tags/${tag}`, `read the tag ${tag}`)).tag;
    } catch (error) {
      if (error instanceof DigitalOceanError && error.status === 404) {
        report(`   ${tag}: already gone`);
        return;
      }
      throw error;
    }
    const count = found.resources?.count ?? 0;
    const naming = firewalls.filter((firewall) => firewallUsesTag(firewall, tag)).map((firewall) => firewall.name);
    if (count > 0 || naming.length > 0) {
      const why = count > 0 ? `still on ${count} resource${count === 1 ? "" : "s"}` : `the firewall${naming.length === 1 ? "" : "s"} ${naming.join(", ")} still name${naming.length === 1 ? "s" : ""} it`;
      kept.push(`tag ${tag}: ${why}`);
      report(`   ${tag}: kept, ${why}`);
      return;
    }
    await call("DELETE", `/tags/${tag}`, `delete the tag ${tag}`);
    removed.push(`tag ${tag}`);
    report(`   ${tag}: deleted`);
  }

  return {
    name: "digitalocean",

    async find(name) {
      const [first] = await dropletsNamed(name);
      return first === undefined ? null : toMachine(first);
    },

    async create(request, report): Promise<CreateOutcome> {
      const resources: Resource[] = [];
      report(`-> a droplet named ${request.name} in the account`);
      const same = await dropletsNamed(request.name);
      const existing = same[0];
      let droplet: DoDroplet;
      let created: boolean;
      if (existing !== undefined) {
        const found = toMachine(existing);
        if (!found.managed) {
          throw new ProviderError({
            error: "machine-exists",
            message: `a droplet named ${existing.name} exists in the account, and sitesolide did not create it`,
            details: [
              `${found.type} at ${found.location}, ${found.status}, ${[found.ipv4, found.ipv6].filter(Boolean).join(", ") || "no public address"}`,
              `it lacks the tag ${MANAGED_LABEL}:${MANAGED_VALUE}: nothing was created, nothing was changed`,
            ],
          });
        }
        report(`   already created by sitesolide: ${found.type} at ${found.location}, ${found.status}`);
        if (same.length > 1) report(`!! ${same.length - 1} other droplet${same.length === 2 ? "" : "s"} of that name, left as they are`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        droplet = existing;
        created = false;
        resources.push({ kind: "droplet", name: existing.name, id: String(existing.id), reused: true });
        await ensureFirewallOf(existing, request.name, report);
        if (request.backups) await ensureBackups(existing, report);
      } else {
        report("   none of that name yet");
        const offer = await checkOffer(request, report);
        const existingFirewall = await findFirewall(request.name);

        // What this run creates before the Droplet, undone if the order is refused.
        const made: { kind: string; name: string; path: string }[] = [];
        let ordering = false;
        let answer: { droplet: DoDroplet; links?: { actions?: { id: number; rel: string }[] } };
        let firewall: DoFirewall;
        try {
          const { key, reused, forMachine } = await ensureKey(request, report);
          resources.push({ kind: "ssh key", name: key.name, id: String(key.id), reused });
          if (!reused) made.push({ kind: "SSH key", name: key.name, path: `/account/keys/${key.id}` });
          const tag = machineTag(request.name);
          const tagCreated = await ensureTag(tag, report);
          resources.push({ kind: "tag", name: tag, id: tag, reused: !tagCreated });
          if (tagCreated) made.push({ kind: "tag", name: tag, path: `/tags/${tag}` });
          const ensured = await ensureFirewall(request.name, existingFirewall, report);
          firewall = ensured.firewall;
          resources.push({ kind: "firewall", name: firewall.name, id: firewall.id, reused: ensured.reused });
          if (!ensured.reused) made.push({ kind: "firewall", name: firewall.name, path: `/firewalls/${firewall.id}` });

          const ipv6 = offer.region.features.includes("ipv6");
          report(`-> droplet ${request.name}: ${request.type} at ${request.location}, ${request.image}`);
          if (!ipv6) report(`!! DigitalOcean routes no IPv6 at ${request.location}: the droplet gets an IPv4 address only`);
          ordering = true;
          answer = await call("POST", "/droplets", `create the droplet ${request.name}`, {
            name: request.name,
            region: request.location,
            size: request.type,
            image: imageReference(request.image),
            ssh_keys: [key.id],
            backups: request.backups,
            ...(request.backups ? { backup_policy: { plan: "daily" } } : {}),
            ipv6,
            // Free, but a second agent from a repository of DigitalOcean's,
            // reporting to it: sitesolide's own monitor watches the machine.
            monitoring: false,
            tags: [...tagsFor(request.name), ...(forMachine ? [`${KEY_TAG}:${key.id}`] : [])],
          });
          if (typeof answer?.droplet?.id !== "number") {
            throw new DigitalOceanError({ error: "provider-unreadable", message: `${host} answered the order of the droplet ${request.name} without the droplet` }, 202, "");
          }
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (ordering && !definiteRefusal(error)) {
            // Once the order has left, only a refusal says the Droplet does
            // not exist. No answer, a failure on DigitalOcean's side, a 429 or
            // an answer cut short may all hide a Droplet DigitalOcean created:
            // its firewall, its tag and its key stay, so that it is never left
            // open, and the next run finds it.
            throw new ProviderError({
              ...error.failure,
              details: [
                ...(error.failure.details ?? []),
                "whether DigitalOcean created the droplet is unknown: nothing was undone, so that it is never left without its firewall; the same command run again finds it, or orders it",
              ],
            });
          }
          const undone = await undo(made, report);
          if (ordering && error instanceof DigitalOceanError && refusesTheOffer(error)) {
            // The lists may sell a size the order refuses: the order is what
            // decides, and its refusal still says what to try instead.
            throw new ProviderError({
              error: "type-unavailable",
              message: `DigitalOcean would not create ${request.type} at ${request.location} (${error.status}${error.id === "" ? "" : ` ${error.id}`}): ${error.said}`,
              details: [...suggestedSizes(offer.sizes, request.location, request.type), "or try another --location", ...undone],
            });
          }
          throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone] });
        }
        droplet = answer.droplet;
        created = true;
        resources.push({ kind: "droplet", name: droplet.name, id: String(droplet.id), reused: false });
        report(`   ordered, id ${droplet.id}`);
        for (const action of answer.links?.actions ?? []) await waitForAction(action.id, action.rel, report);
        const running = await waitActive(droplet.id, request.name, report, true);
        await waitFirewall(firewall, droplet.id, report);
        report(`-> ${request.name} running`);
        return { machine: toMachine(running), created, resources };
      }
      report(`-> ${request.name} running`);
      const running = await waitActive(droplet.id, request.name, report, created);
      return { machine: toMachine(running), created, resources };
    },

    async list() {
      const droplets = await listAll<DoDroplet>("/droplets", "droplets", "read the droplets", { tag_name: `${MANAGED_LABEL}:${MANAGED_VALUE}` });
      return droplets.filter((droplet) => isManagedTags(droplet.tags)).map(toMachine);
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      const removed: string[] = [];
      const kept: string[] = [];
      const id = Number(machine.id);
      const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");

      report(`-> droplet ${machine.name}`);
      // Read again rather than trusted: the tags say which key was uploaded
      // for it, and whether it is still sitesolide's to delete.
      const before = (await call<{ droplet: DoDroplet }>("GET", `/droplets/${id}`, `read the droplet ${machine.name}`)).droplet;
      if (!isManagedTags(before.tags)) {
        throw new ProviderError({ error: "machine-not-managed", message: `the droplet ${before.name} lacks the tag ${MANAGED_LABEL}:${MANAGED_VALUE}`, details: ["nothing was destroyed"] });
      }
      const keys = uploadedKeys(before.tags);
      // What DigitalOcean detaches from a deleted Droplet rather than deleting,
      // and goes on billing: read before, said after, and never deleted, since
      // a volume holds data and a reserved IP may be named by someone's DNS.
      const volumes = before.volume_ids;
      if (volumes === undefined) report(`!! DigitalOcean did not say which volumes ${machine.name} has (the token needs block_storage:read): any stays, detached and billed`);
      const reserved = await reservedAddresses(id, machine.name, report);
      await call("DELETE", `/droplets/${id}`, `delete the droplet ${machine.name}`);
      removed.push(`droplet ${machine.name}${addresses === "" ? "" : ` (${addresses})`}`);
      if (await waitGone(id, machine.name, report)) report("   deleted");
      else report(`!! DigitalOcean still shows the droplet ${machine.name} after ${WAITS.goneMs / 60_000} minutes: it goes on its own, the console shows when`);
      if ((before.features ?? []).includes("backups")) {
        kept.push(`backups of ${machine.name}: DigitalOcean keeps them until their retention ends, seven days for daily ones, four weeks for weekly ones; the control panel lists them under Backups & Snapshots`);
        report(`   its backups stay until their retention ends, seven days for daily ones`);
      }
      for (const volume of volumes ?? []) {
        kept.push(`volume ${volume}: detached from ${machine.name} and kept with its data, billed until it is deleted from the control panel, Volumes`);
        report(`!! volume ${volume}: detached, kept with its data, and still billed`);
      }
      for (const address of reserved) {
        kept.push(`reserved IP ${address}: unassigned from ${machine.name} and kept, billed while it is unassigned, until it is released from the control panel, Networking, Reserved IPs`);
        report(`!! reserved IP ${address}: unassigned, kept, and still billed`);
      }

      const name = firewallName(machine.name);
      report(`-> firewall ${name}`);
      const firewalls = await listAll<DoFirewall>("/firewalls", "firewalls", "read the firewalls");
      const firewall = firewalls.find((candidate) => ownsFirewall(candidate, machine.name));
      let firewallKept = false;
      if (firewall === undefined) {
        report("   none created by sitesolide under that name");
      } else {
        const tag = machineTag(machine.name);
        const tagged = await listAll<DoDroplet>("/droplets", "droplets", `read the droplets tagged ${tag}`, { tag_name: tag });
        const elsewhere = [
          ...(firewall.droplet_ids ?? []).filter((other) => other !== id).map((other) => `droplet ${other}`),
          ...tagged.filter((other) => other.id !== id).map((other) => `droplet ${other.name}`),
          ...(firewall.tags ?? []).filter((other) => other !== tag).map((other) => `the droplets tagged ${other}`),
        ];
        if (elsewhere.length > 0) {
          firewallKept = true;
          kept.push(`firewall ${name}: still applied to ${elsewhere.join(", ")}`);
          report(`   kept: still applied to ${elsewhere.join(", ")}`);
        } else {
          await call("DELETE", `/firewalls/${firewall.id}`, `delete the firewall ${name}`);
          removed.push(`firewall ${name}`);
          report("   deleted");
        }
      }

      report("-> SSH key");
      if (keys.length === 0) report(`   none was uploaded for ${machine.name}: the key it used was already in the account`);
      for (const keyId of keys) {
        let key: DoKey;
        try {
          key = (await call<{ ssh_key: DoKey }>("GET", `/account/keys/${keyId}`, `read the SSH key ${keyId}`)).ssh_key;
        } catch (error) {
          if (!(error instanceof DigitalOceanError) || error.status !== 404) throw error;
          report(`   key ${keyId}: already deleted`);
          continue;
        }
        if (!options.deleteKey) {
          kept.push(`SSH key ${key.name}: other machines may be created with it; --delete-key deletes it`);
          report(`   ${key.name}: kept, other machines may be created with it`);
          continue;
        }
        // The key was in the droplet's root account from its creation: deleting
        // it from the account changes nothing on the machines made with it.
        await call("DELETE", `/account/keys/${keyId}`, `delete the SSH key ${key.name}`);
        removed.push(`SSH key ${key.name}`);
        report(`   ${key.name}: deleted`);
      }

      report("-> tags");
      const remaining = firewalls.filter((candidate) => candidate !== firewall || firewallKept);
      for (const tag of [machineTag(machine.name), ...keys.map((keyId) => `${KEY_TAG}:${keyId}`)]) {
        await deleteTagIfUnused(tag, remaining, removed, kept, report);
      }
      return { removed, kept };
    },

    async locations(): Promise<Choice[]> {
      const regions = await listAll<DoRegion>("/regions", "regions", "read the regions");
      return regions
        .filter((region) => region.available)
        .sort((a, b) => Number(b.slug === DEFAULTS.location) - Number(a.slug === DEFAULTS.location) || a.slug.localeCompare(b.slug))
        .map((region) => ({ value: region.slug, label: regionLabel(region) }));
    },

    async types(location): Promise<Choice[]> {
      const sizes = await listAll<DoSize>("/sizes", "sizes", "read the sizes");
      return sizes
        .filter((size) => offered(size, location))
        .sort((a, b) => Number(b.slug === DEFAULTS.type) - Number(a.slug === DEFAULTS.type) || byPrice(a, b))
        .slice(0, 12)
        .map((size) => ({ value: size.slug, label: size.slug, hint: describeSize(size) }));
    },
  };
}

// --- the entry ------------------------------------------------------------------------------

const CREDENTIAL_HELP = [
  "create it in the DigitalOcean control panel: API, Tokens, Generate New Token, with Custom Scopes",
  "the scopes: droplet create, read, update, delete; firewall, ssh_key and tag create, read, delete; regions, sizes, image, actions, reserved_ip and block_storage read (docs/providers/digitalocean.md)",
  "a token reaches its whole team: a team of its own for sitesolide keeps it away from everything else you run at DigitalOcean",
];

/**
 * The token, when the environment holds none under DIGITALOCEAN_TOKEN:
 * DIGITALOCEAN_ACCESS_TOKEN, which doctl reads, else what `doctl auth token`
 * prints for its current context, signed in with `doctl auth init` or
 * `doctl auth login`. A value that is not a token's shape is no token.
 */
export async function discover(workstation: Workstation): Promise<{ source: string; credentials: Record<string, string> } | null> {
  const variable = workstation.environment[DOCTL_VARIABLE]?.trim() ?? "";
  if (TOKEN_SHAPE.test(variable)) return { source: `${DOCTL_VARIABLE}, which doctl reads`, credentials: { [TOKEN_VARIABLE]: variable } };
  const answer = await workstation.run(["doctl", "auth", "token"]);
  const printed = answer.stdout.trim();
  if (answer.code !== 0 || !TOKEN_SHAPE.test(printed)) return null;
  return { source: "the doctl CLI, signed in", credentials: { [TOKEN_VARIABLE]: printed } };
}

export const DIGITALOCEAN: ProviderEntry = {
  name: "digitalocean",
  title: "DigitalOcean",
  credentials: [{ variable: TOKEN_VARIABLE, label: "API token", secret: true, shape: TOKEN_SHAPE }],
  discover,
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/providers/digitalocean.md",
  defaults: () => ({ ...DEFAULTS }),
  backups: true,
  apiVariable: API_VARIABLE,
  open: digitalocean,
};
