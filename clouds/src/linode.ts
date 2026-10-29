/**
 * Akamai Cloud, formerly Linode, through its API v4:
 * https://techdocs.akamai.com/linode-api/reference/api
 *
 * A machine is two resources, each tagged `managed-by:<owner>` and
 * `<owner>-machine:<name>`, `<owner>` being the name of the program that
 * opened the provider (ProviderContext.owner). Akamai has no key-value
 * labels: a resource's `label` is its name, and its tags are plain strings,
 * hence owner.tags.
 *
 *   - a Cloud Firewall labelled `<owner>-<name>`, inbound TCP 22, 80 and
 *     443 and ICMP from everywhere, IPv4 and IPv6, everything else inbound
 *     dropped;
 *   - the Linode labelled `<name>`, the firewall attached from its creation,
 *     the request's key in root's authorized_keys, and no user_data: the
 *     program's own setup hardens it over SSH, which a run can be repeated
 *     against, where cloud-init only ever ran once.
 *
 * There is no SSH key resource: the create request carries the key, which
 * Akamai writes into root's `~/.ssh/authorized_keys` on the new disk, so that
 * nothing is left in the account for `destroy` to think about.
 *
 * No root password is sent. The API asks for at least one way into the disk,
 * a root password, authorized_keys or authorized_users, and the key is
 * enough: a Linode without a root password has no password login open in the
 * moments before the program's own setup turns them off.
 *
 * A Linode's network comes in two generations. Linode interfaces, generally
 * available since April 2026 and the default of new accounts, carry
 * the firewall on the public interface; legacy configuration profiles carry
 * it on the Linode, through `firewall_id`. `create` asks for Linode
 * interfaces in a region that lists them, the legacy profile elsewhere, and
 * says which, so that the account's default does not decide; either way the
 * firewall is attached by the order itself: the Linode never boots
 * unprotected.
 *
 * The public IPv4 is assigned at creation and stays with the Linode until it
 * is deleted, power cycles included: no reserved address is needed for the
 * DNS records to keep pointing at it. The IPv6 is the SLAAC address Akamai
 * derives from the interface, as stable.
 *
 * Everything that can refuse is read before the first write, so that a
 * refusal leaves nothing behind: the Linode, by label (one the owner did not
 * create is never touched), the region and the type against what Akamai sells
 * there, the firewall's label. When the order is refused all the same, the
 * firewall this run created for it is deleted again, unless a Linode of that
 * name turned up after all.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and fails with a ProviderError whose code is one of
 * FAILURE_CODES. The API's error format is `{"errors": [{"reason",
 * "field"}]}`. Lists are paginated, `data`, `page` and `pages`, followed to
 * the last page at 500 items a page, the most the API returns. Filters go in
 * the `X-Filter` header, and are checked again on what comes back.
 */
import {
  apiAddress,
  checkRequest,
  DEBIAN,
  formatPrice,
  labelsOfTags,
  patiently,
  ProviderError,
  retryAfter,
  statusFailure,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type DestroyOutcome,
  type Discovery,
  type Machine,
  type Owner,
  type Provider,
  type ProviderContext,
  type ProviderEntry,
  type Report,
  type Resource,
  type Supports,
  type Workstation,
} from "./provider";
import type { Failure } from "./provider";

export const DEFAULT_API = "https://api.linode.com/v4";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_LINODE_API";

/** Where the token is read from: the variable Akamai's Terraform provider reads. */
export const TOKEN_VARIABLE = "LINODE_TOKEN";

/** The variable linode-cli reads its token from, before its configuration file. */
export const CLI_TOKEN_VARIABLE = "LINODE_CLI_TOKEN";

/** The name Akamai goes by in messages: the company sells it, the API still says Linode. */
const TITLE = "Akamai";

/**
 * What `create` orders when nothing else is said. g6-standard-1, "Linode
 * 2GB", is the cheapest shared x86 type with 2 GB of memory (the Nanode has
 * one); every Akamai type is x86. fr-par, Paris, is a current core region of
 * the European Union that lists every capability `create` uses: Linodes,
 * Cloud Firewall, Backups and Linode interfaces. linode/debian13 is Akamai's
 * own Debian 13 image.
 */
export const LINODE_DEFAULTS = { type: "g6-standard-1", location: "fr-par", image: DEBIAN };

/** The image `debian-13` stands for at Akamai, as GET /images lists it. */
export const DEBIAN_IMAGE = "linode/debian13";

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  runningMs: 10 * 60_000,
  pollMs: 3_000,
};

/** Every rule allows these sources, IPv4 and IPv6. */
const EVERYWHERE = { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] };

export const FIREWALL_RULES = {
  inbound_policy: "DROP",
  outbound_policy: "ACCEPT",
  inbound: [
    { action: "ACCEPT", protocol: "TCP", ports: "22", addresses: EVERYWHERE, label: "ssh" },
    { action: "ACCEPT", protocol: "TCP", ports: "80", addresses: EVERYWHERE, label: "http" },
    { action: "ACCEPT", protocol: "TCP", ports: "443", addresses: EVERYWHERE, label: "https" },
    // Ping serves diagnosis and external monitoring. ICMP takes no ports.
    { action: "ACCEPT", protocol: "ICMP", addresses: EVERYWHERE, label: "ping" },
  ],
  outbound: [],
};

/**
 * Nothing beyond the fields every provider takes: a key is required, the
 * firewall is FIREWALL_RULES alone, and no user-data, disk, nested
 * virtualization or login is asked for.
 */
export const SUPPORTS: Supports = {};

/** A firewall's label is 32 characters at most: `<owner>-` leaves the rest to the name, 21 characters for `sitesolide-`. */
const FIREWALL_LABEL_MAX = 32;

/** The firewall's label, `<owner>-<name>`. */
export function firewallLabel(name: string, owner: Owner): string {
  return `${owner.name}-${name}`;
}

/** The longest name whose firewall's label still fits. */
function longestName(owner: Owner): number {
  return FIREWALL_LABEL_MAX - firewallLabel("", owner).length;
}

/** The shared CPU classes the wizard offers: the current generation, g6, holds them all. */
const WIZARD_CLASSES = new Set(["nanode", "standard"]);
/** The defaults' memory, in MB: the wizard offers nothing smaller. */
const WIZARD_MEMORY = 2048;

// --- the API's objects, as far as this file reads them ---------------------------------

type Price = { hourly: number | null; monthly: number | null };

export type LinodeType = {
  id: string;
  label: string;
  class: string;
  vcpus: number;
  /** In MB, as are `disk` and the specs of an instance. */
  memory: number;
  disk: number;
  price: Price;
  /** The regions where the type costs something else than `price`. */
  region_prices?: ({ id: string } & Price)[];
};

export type LinodeRegion = {
  id: string;
  label: string;
  country: string;
  status: string;
  capabilities: string[];
  site_type?: string;
};

export type LinodeInstance = {
  id: number;
  label: string;
  region: string;
  type: string | null;
  image: string | null;
  status: string;
  ipv4: string[];
  /** The SLAAC address, `2001:db8::1/128`; null without IPv6. */
  ipv6: string | null;
  tags: string[];
  backups?: { enabled: boolean };
  interface_generation?: string | null;
};

/** A Block Storage volume, billed on its own, attached or not. */
type LinodeVolume = { id: number; label: string; size: number; linode_id: number | null };

type FirewallEntity = { id: number; type: string; label?: string | null; parent_entity?: { id: number; type: string } | null };

export type LinodeFirewall = { id: number; label: string; status: string; tags: string[]; entities?: FirewallEntity[] };

type Availability = { region: string; plan: string; available: boolean };

type Page<T> = { data: T[]; page: number; pages: number; results?: number };

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and the fields it named kept for the callers that tell them apart. */
export class LinodeError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly fields: string[] = [],
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/**
 * An error answer of the API as a failure the CLI reports, with the code its
 * hint is found by. `what` says what was being done, in the infinitive:
 * `create the Linode web`.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string, now: number): LinodeError {
  const errors = (body as { errors?: unknown } | null)?.errors;
  const list = Array.isArray(errors) ? (errors as { reason?: unknown; field?: unknown }[]) : [];
  const reasons = list.map((entry) => (typeof entry.reason === "string" ? entry.reason : "")).filter((reason) => reason !== "");
  const fields = list.map((entry) => (typeof entry.field === "string" ? entry.field : "")).filter((field) => field !== "");
  const said = reasons.join("; ") || `answered ${status}`;
  const details = list
    .filter((entry) => typeof entry.field === "string" && typeof entry.reason === "string")
    .map((entry) => `${String(entry.field)}: ${String(entry.reason)}`);
  const make = (failure: Failure) => new LinodeError(failure, status, fields, said);

  // A token without the scope an endpoint needs is told 401 by the API in
  // practice, 403 by its documentation: both mean the same, and neither
  // means the token is wrong.
  const scope = /not authori[sz]ed to use this endpoint/i.test(said);
  if (status === 401 && !scope) {
    return make({
      error: "provider-unauthenticated",
      message: `${TITLE} refused the token (${status}): it is unknown, revoked, expired, or was copied wrong`,
      details: ["create a personal access token in Cloud Manager: your username, API Tokens, with Read/Write on Linodes and Firewalls"],
    });
  }
  if (status === 401 || status === 403) {
    return make({
      error: "provider-forbidden",
      message: `the token may not ${what} (${status}): ${said}`,
      details: ["the token needs Read/Write on Linodes and on Firewalls: Read Only lists but neither creates nor deletes"],
    });
  }
  if (status === 400 && /account limit|limit reached|reached (your|the|its) [a-z ]*limit/i.test(said)) {
    return make({ error: "provider-limit", message: `${TITLE} refused to ${what} (${status}): ${said}`, details: ["the account has reached one of its limits: its owner removes what it no longer needs, or asks Akamai's support to raise it"] });
  }
  if (status === 400 && fields.includes("label") && /unique|already|taken|in use/i.test(said)) {
    return make({ error: "provider-name-taken", message: `${TITLE} refused to ${what} (${status}): ${said}`, details });
  }
  if (status === 429) {
    const reset = Number(headers.get("X-RateLimit-Reset"));
    const untilReset = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - now / 1000)) : null;
    // Retry-After says when the window resets; X-RateLimit-Reset, when it
    // is missing, says it as a time.
    const wait = headers.get("Retry-After") === null && untilReset !== null ? Math.min(60, untilReset) : retryAfter(headers);
    const limit = headers.get("X-RateLimit-Limit");
    return make({
      error: "provider-rate-limited",
      message: `${TITLE}'s rate limit is reached, nothing more can be asked of it for now (${status})`,
      details: [`the limit${limit === null ? "" : ` of ${limit} requests`} resets in ${wait} s`],
      wait,
    });
  }
  return make(statusFailure(TITLE, status, said, headers, what, details));
}

/** The API's address from the environment, or why it is refused. */
export function apiBase(environment: Record<string, string | undefined>): string {
  return apiAddress(environment, API_VARIABLE, DEFAULT_API);
}

// --- what the answers mean -------------------------------------------------------------------

/**
 * Why Akamai would refuse that name, or null. A Linode's label starts with a
 * letter and never holds two dashes in a row; the firewall's, the name behind
 * `<owner>-`, is 32 characters at most. The CLI's own rule already keeps
 * names to lowercase letters, digits and dashes.
 */
export function nameProblem(name: string, owner: Owner): string | null {
  const longest = longestName(owner);
  if (name.length < 3) return "it is shorter than 3 characters, the least a Linode's label holds";
  if (name.length > longest) return `it is longer than ${longest} characters: the firewall's label, ${firewallLabel("<name>", owner)}, holds ${FIREWALL_LABEL_MAX} at most`;
  if (!/^[a-zA-Z]/.test(name)) return "it does not start with a letter, which a Linode's label must";
  if (/--|__|\.\./.test(name)) return "it holds two dashes in a row, which a Linode's label never does";
  if (!/^[a-zA-Z]((?!--|__|\.\.)[a-zA-Z0-9-_.])+$/.test(name)) return "it holds a character a Linode's label never does";
  return null;
}

/** The image a request names: `debian-13` is Akamai's Debian 13, anything else is Akamai's own id. */
export function imageFor(image: string): string {
  return image === DEBIAN ? DEBIAN_IMAGE : image;
}

/** The type's price at a region, which `region_prices` overrides for some. */
export function priceAt(type: LinodeType, region: string): Price {
  const override = type.region_prices?.find((entry) => entry.id === region);
  return override === undefined ? type.price : { hourly: override.hourly, monthly: override.monthly };
}

/** What a type costs a month at a region, for sorting: an hourly price counts for 730 hours. */
function monthlyCost(type: LinodeType, region: string): number {
  const price = priceAt(type, region);
  if (typeof price.monthly === "number") return price.monthly;
  if (typeof price.hourly === "number") return price.hourly * 730;
  return Number.POSITIVE_INFINITY;
}

function priceText(type: LinodeType, region: string): string | null {
  const price = priceAt(type, region);
  if (typeof price.monthly === "number") return formatPrice(price.monthly, "USD");
  if (typeof price.hourly === "number") return `${price.hourly} USD an hour before VAT`;
  return null;
}

function gigabytes(megabytes: number): string {
  return `${Math.round((megabytes / 1024) * 10) / 10} GB`;
}

function sizeText(type: LinodeType): string {
  return `${type.vcpus} vCPU, ${gigabytes(type.memory)} RAM, ${gigabytes(type.disk)} disk`;
}

/** A private address Akamai may list beside the public one. */
function isPrivate(address: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/.test(address);
}

export function toMachine(instance: LinodeInstance, types: LinodeType[] | null, owner: Owner): Machine {
  const type = types?.find((candidate) => candidate.id === instance.type);
  const monthly = type === undefined ? null : priceAt(type, instance.region).monthly;
  return {
    provider: "linode",
    id: String(instance.id),
    name: instance.label,
    type: instance.type ?? "unknown",
    location: instance.region,
    status: instance.status,
    ipv4: (instance.ipv4 ?? []).find((address) => !isPrivate(address)) ?? null,
    ipv6: instance.ipv6 === null || instance.ipv6 === undefined ? null : (instance.ipv6.split("/")[0] ?? null),
    // The SLAAC address lives in a /64 the region's Linodes share: no
    // network is routed to this one alone.
    ipv6Network: null,
    // Akamai's prices are before tax and it says no other: the gross is the
    // net, for want of a figure.
    monthlyPrice: typeof monthly === "number" ? { net: monthly.toFixed(2), gross: monthly.toFixed(2), currency: "USD" } : null,
    backups: instance.backups?.enabled === true,
    managed: owner.managesTags(instance.tags),
    labels: labelsOfTags(instance.tags),
    // Akamai's images take the key for root, and only for root.
    login: "root",
  };
}

/**
 * The Linode interfaces when the region lists them, the legacy configuration
 * profile otherwise. Both attach the firewall in the order itself.
 */
export function interfaceGeneration(region: LinodeRegion): "linode" | "legacy_config" {
  return region.capabilities.includes("Linode Interfaces") ? "linode" : "legacy_config";
}

/** What a region must offer for `create`. */
function missingCapabilities(region: LinodeRegion, backups: boolean): string[] {
  return ["Linodes", "Cloud Firewall", ...(backups ? ["Backups"] : [])].filter((capability) => !region.capabilities.includes(capability));
}

function regionLabel(region: LinodeRegion): string {
  return [region.label ?? region.id, (region.country ?? "").toUpperCase()].filter((part) => part !== "").join(", ");
}

/** A region the wizard offers: up, a core site, selling Linodes behind a Cloud Firewall. */
function orderable(region: LinodeRegion): boolean {
  return region.status === "ok" && region.site_type !== "distributed" && missingCapabilities(region, false).length === 0;
}

/** The plans a region says it cannot sell right now. */
function unavailablePlans(availability: Availability[] | null, region: string): Set<string> {
  return new Set((availability ?? []).filter((entry) => entry.region === region && entry.available === false).map((entry) => entry.plan));
}

/**
 * The cheapest shared types sold at a region, one line each, cheapest first,
 * none with less memory than the defaults.
 */
export function cheapestTypes(types: LinodeType[], region: string, unavailable: Set<string>, except?: string, count = 6): string[] {
  return types
    .filter((type) => WIZARD_CLASSES.has(type.class) && type.memory >= WIZARD_MEMORY && !unavailable.has(type.id) && type.id !== except)
    .sort((a, b) => monthlyCost(a, region) - monthlyCost(b, region) || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((type) => {
      const price = priceText(type, region);
      return `${type.id.padEnd(15)} ${sizeText(type)}${price === null ? "" : `, ${price}`}`;
    });
}

/**
 * Whether a refused order says the type cannot be had there, rather than that
 * the request was wrong: a refusal naming the type or the region, which were
 * checked against the lists just before, or one naming no field that says
 * so in words.
 */
export function refusesTheOffer(error: LinodeError): boolean {
  if (error.status !== 400) return false;
  if (error.fields.length > 0) return error.fields.some((field) => field === "type" || field === "region");
  return /not available|unavailable|capacity|sold out/i.test(error.said);
}

// --- the provider ---------------------------------------------------------------------------

export function linode(context: ProviderContext): Provider {
  const base = apiBase(context.environment);
  const host = new URL(base).host;
  const { clock, fetcher, owner } = context;
  const token = context.credentials[TOKEN_VARIABLE] ?? "";

  /** One call: the token in its header, a filter in another, JSON both ways, every failure said in the CLI's words. */
  async function call<T>(method: string, path: string, what: string, options: { body?: unknown; filter?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.filter !== undefined) headers["X-Filter"] = JSON.stringify(options.filter);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "error",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by the program that prints it.
      throw new LinodeError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0);
    }
    const text = await response.text().catch(() => null);
    let parsed: unknown = null;
    let readable = text !== null;
    if (text !== null && text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        readable = false;
      }
    }
    // A proxy in front of the API may answer a 502 or a 429 in HTML: still
    // Akamai saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new LinodeError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Akamai's API, while trying to ${what}` }, response.status);
    }
    if (!response.ok) throw failureFrom(response.status, parsed, response.headers, what, clock.now());
    return (parsed ?? {}) as T;
  }

  /** Every page of a list, following `page` up to `pages`. */
  async function listAll<T>(path: string, what: string, filter?: unknown): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1, pages = 1; page <= pages && page <= 1000; page++) {
      const answer = await call<Page<T>>("GET", `${path}?${new URLSearchParams({ page: String(page), page_size: "500" })}`, what, { filter });
      if (!Array.isArray(answer.data)) {
        throw new LinodeError({ error: "provider-unreadable", message: `${host} answered without a list, while trying to ${what}` }, 200);
      }
      items.push(...answer.data);
      pages = typeof answer.pages === "number" ? answer.pages : page;
    }
    return items;
  }

  /** The types, for prices; null when they cannot be read, which stops nothing. */
  let typesRead: Promise<LinodeType[] | null> | null = null;
  function knownTypes(): Promise<LinodeType[] | null> {
    typesRead ??= listAll<LinodeType>("/linode/types", "read the Linode types").catch(() => null);
    return typesRead;
  }

  /**
   * What a region cannot sell right now; null when it does not say, and the
   * order decides. The answer has been documented as a bare list: a page is
   * read all the same.
   */
  async function availability(region: string): Promise<Availability[] | null> {
    try {
      const answer = await call<Availability[] | Page<Availability>>("GET", `/regions/${encodeURIComponent(region)}/availability`, `read what ${region} can sell`);
      return Array.isArray(answer) ? answer : Array.isArray(answer.data) ? answer.data : null;
    } catch (error) {
      if (error instanceof ProviderError && error.failure.error === "provider-unauthenticated") throw error;
      return null;
    }
  }

  async function findInstance(name: string): Promise<LinodeInstance | null> {
    const instances = await listAll<LinodeInstance>("/linode/instances", "read the Linodes", { label: name });
    // Labels are unique in an account, and compared here as Akamai may
    // compare them, without case.
    return instances.find((instance) => instance.label.toLowerCase() === name.toLowerCase()) ?? null;
  }

  async function findFirewallByLabel(label: string): Promise<LinodeFirewall | null> {
    const firewalls = await listAll<LinodeFirewall>("/networking/firewalls", "read the firewalls", { label });
    return firewalls.find((firewall) => firewall.label.toLowerCase() === label.toLowerCase()) ?? null;
  }

  /** Until Akamai says the Linode runs: `provisioning`, then `booting`, then `running`. */
  async function waitRunning(id: number, name: string, report: Report, justCreated: boolean): Promise<LinodeInstance> {
    const deadline = clock.now() + WAITS.runningMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const read = await patiently(clock, () => call<LinodeInstance>("GET", `/linode/instances/${id}`, `read the Linode ${name}`), deadline, report, warned);
      if (read !== null) {
        if (read.status !== last) report(`   status: ${read.status}`);
        last = read.status;
        if (read.status === "running") return read;
        if ((read.status === "offline" || read.status === "stopped") && !justCreated) {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is powered off`, details: [`${owner.name} never powers a machine on or off by itself`] });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  type Offer = { region: LinodeRegion; types: LinodeType[]; unavailable: Set<string> };

  /** Refuses what cannot be ordered; returns what a refused order's suggestions need. */
  async function checkOffer(request: CreateRequest, report: Report): Promise<Offer> {
    report(`-> ${request.type} at ${request.location}, what ${TITLE} sells there`);
    const regions = await listAll<LinodeRegion>("/regions", "read the regions");
    const region = regions.find((candidate) => candidate.id === request.location);
    const suitable = regions.filter((candidate) => orderable(candidate) && missingCapabilities(candidate, request.backups).length === 0);
    const listing = suitable.map((candidate) => `${candidate.id.padEnd(12)} ${regionLabel(candidate)}`);
    if (region === undefined) {
      throw new ProviderError({ error: "invalid-location", message: `${request.location} is not an ${TITLE} region`, details: ["the regions:", ...listing] });
    }
    const missing = missingCapabilities(region, request.backups);
    if (missing.length > 0) {
      throw new ProviderError({
        error: "invalid-location",
        message: `${request.location} does not offer ${missing.join(", ")}`,
        details: [`the regions that do${request.backups ? ", backups included" : ""}:`, ...listing],
      });
    }
    if (region.status !== "ok") {
      throw new ProviderError({ error: "provider-unavailable", message: `${TITLE} says ${request.location} is ${region.status}`, details: ["run the same command again later, or pick another --location"] });
    }
    const types = (await knownTypes()) ?? (await listAll<LinodeType>("/linode/types", "read the Linode types"));
    const unavailable = unavailablePlans(await availability(request.location), request.location);
    const chosen = types.find((type) => type.id === request.type);
    if (chosen === undefined) {
      throw new ProviderError({
        error: "invalid-server-type",
        message: `${request.type} is not an ${TITLE} type`,
        details: [`the cheapest types at ${request.location}:`, ...cheapestTypes(types, request.location, unavailable)],
      });
    }
    if (unavailable.has(chosen.id)) {
      throw new ProviderError({
        error: "type-unavailable",
        message: `${TITLE} says ${request.type} cannot be ordered at ${request.location} right now`,
        details: [`the cheapest types it can sell there:`, ...cheapestTypes(types, request.location, unavailable, chosen.id), "or try another --location", "nothing had been created yet"],
      });
    }
    const price = priceText(chosen, request.location);
    report(`   ${sizeText(chosen)}${price === null ? "" : `, ${price}`}`);
    return { region, types, unavailable };
  }

  /** Whether a firewall carries the owner's tags for that machine, which is what makes it the owner's. */
  function ownsFirewall(firewall: LinodeFirewall, name: string): boolean {
    return owner.managesTags(firewall.tags) && owner.machineOfTags(firewall.tags) === name;
  }

  /** The firewall of that label, when its owner created it; read before anything is created, so that a refusal leaves nothing. */
  async function findFirewall(name: string): Promise<LinodeFirewall | null> {
    const label = firewallLabel(name, owner);
    const same = await findFirewallByLabel(label);
    if (same !== null && !ownsFirewall(same, name)) {
      throw new ProviderError({
        error: "firewall-taken",
        message: `a firewall labelled ${same.label} exists in the account, and ${owner.name} did not create it for ${name}`,
        details: [`it lacks the tags ${owner.tagMark} and ${owner.machineLabel}:${name}: it is never adopted nor changed`],
      });
    }
    return same;
  }

  async function ensureFirewall(name: string, found: LinodeFirewall | null, report: Report): Promise<LinodeFirewall & { reused: boolean }> {
    const label = firewallLabel(name, owner);
    report(`-> firewall ${label}`);
    if (found !== null) {
      report(`   already created by ${owner.name}, reused`);
      return { ...found, reused: true };
    }
    const created = await call<LinodeFirewall>("POST", "/networking/firewalls", `create the firewall ${label}`, {
      body: { label, tags: owner.tags(name), rules: FIREWALL_RULES },
    });
    report("   created: inbound tcp 22, 80, 443 and icmp from everywhere, everything else dropped");
    return { ...created, reused: false };
  }

  /**
   * Deletes the firewall this run created before an order Akamai refused: it
   * was made for a Linode that does not exist, and nothing else here would
   * ever list or remove it, since `list` and `destroy` start from a
   * Linode. Deleting a firewall strips its rules from whatever it protects,
   * so it is kept when anything uses it, or when a Linode of that name
   * appeared all the same (an order that failed on the way back may have
   * gone through): the next run finds it and reuses it. Returns what
   * happened, one line each, for the refusal's details.
   */
  async function undo(name: string, made: LinodeFirewall | null, report: Report): Promise<string[]> {
    if (made === null) return ["nothing had been created yet"];
    report("-> undo what this run created");
    let said: string;
    try {
      const current = await call<LinodeFirewall>("GET", `/networking/firewalls/${made.id}`, `read the firewall ${made.label}`);
      const instance = await findInstance(name);
      if ((current.entities ?? []).length > 0 || instance !== null) {
        said = `left the firewall ${made.label}: it protects a Linode now, and the next run finds it and reuses it`;
      } else {
        await call("DELETE", `/networking/firewalls/${made.id}`, `delete the firewall ${made.label}`);
        said = `deleted the firewall ${made.label} this run had created`;
      }
    } catch {
      said = `left the firewall ${made.label}: the next run finds it and reuses it`;
    }
    report(`   ${said}`);
    return [said];
  }

  async function ensureBackups(instance: LinodeInstance, report: Report): Promise<void> {
    report("-> backups");
    if (instance.backups?.enabled === true) {
      report("   already enabled");
      return;
    }
    await call("POST", `/linode/instances/${instance.id}/backups/enable`, `enable the backups of ${instance.label}`);
    report("   enabled: Akamai's Backup service, billed on top of the Linode");
  }

  /** What the order asks of the network: the firewall on the public interface, or on the Linode. */
  function network(region: LinodeRegion, firewall: number): Record<string, unknown> {
    if (interfaceGeneration(region) === "linode") {
      return {
        interface_generation: "linode",
        // Network Helper is what configures the SLAAC address, the EUI-64 one
        // the AAAA record points at; its default is the account's setting.
        network_helper: true,
        interfaces: [
          {
            firewall_id: firewall,
            default_route: { ipv4: true, ipv6: true },
            public: { ipv4: { addresses: [{ address: "auto", primary: true }] } },
          },
        ],
      };
    }
    // A region without Linode interfaces only has the legacy profile, said
    // all the same, so that the account's default for new Linodes does not
    // decide: the Linode gets its public interface by default.
    return { interface_generation: "legacy_config", firewall_id: firewall };
  }

  return {
    name: "linode",

    async find(name) {
      const instance = await findInstance(name);
      return instance === null ? null : toMachine(instance, await knownTypes(), owner);
    },

    async create(request, report): Promise<CreateOutcome> {
      checkRequest(TITLE, request, SUPPORTS);
      // SUPPORTS is not keyless: checkRequest refused a request without one.
      const publicKey = request.key!;
      const problem = nameProblem(request.name, owner);
      if (problem !== null) {
        throw new ProviderError({
          error: "provider-invalid",
          message: `${TITLE} cannot take the name ${request.name}: ${problem}`,
          details: [`a name for ${TITLE} is 3 to ${longestName(owner)} characters, starts with a letter, and never holds two dashes in a row`, "nothing was created"],
        });
      }
      const resources: Resource[] = [];
      report(`-> a Linode labelled ${request.name} in the account`);
      const existing = await findInstance(request.name);
      let instance: LinodeInstance;
      let created: boolean;
      if (existing !== null) {
        const found = toMachine(existing, null, owner);
        if (!found.managed || owner.machineOfTags(existing.tags) !== request.name) {
          throw new ProviderError({
            error: "machine-exists",
            message: `a Linode labelled ${existing.label} exists in the account, and ${owner.name} did not create it`,
            details: [
              `${found.type} at ${found.location}, ${found.status}, ${[found.ipv4, found.ipv6].filter(Boolean).join(", ") || "no public address"}`,
              `it lacks the tags ${owner.tagMark} and ${owner.machineLabel}:${request.name}: nothing was created, nothing was changed`,
            ],
          });
        }
        report(`   already created by ${owner.name}: ${found.type} at ${found.location}, ${found.status}`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        instance = existing;
        created = false;
        resources.push({ kind: "linode", name: existing.label, id: String(existing.id), reused: true });
      } else {
        report("   none of that name yet");
        const offer = await checkOffer(request, report);
        const existingFirewall = await findFirewall(request.name);

        // What this run creates before the Linode, undone if the order fails.
        let made: LinodeFirewall | null = null;
        let ordering = false;
        try {
          const firewall = await ensureFirewall(request.name, existingFirewall, report);
          resources.push({ kind: "firewall", name: firewall.label, id: String(firewall.id), reused: firewall.reused });
          if (!firewall.reused) made = firewall;

          const image = imageFor(request.image);
          report(`-> Linode ${request.name}: ${request.type} at ${request.location}, ${image}`);
          report("   root: your key only, no password");
          const key = [publicKey.algorithm, publicKey.blob, publicKey.comment].filter((part) => part !== "").join(" ");
          ordering = true;
          instance = await call<LinodeInstance>("POST", "/linode/instances", `create the Linode ${request.name}`, {
            body: {
              label: request.name,
              region: request.location,
              type: request.type,
              image,
              authorized_keys: [key],
              tags: owner.tags(request.name),
              booted: true,
              backups_enabled: request.backups,
              ...network(offer.region, firewall.id),
            },
          });
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          const undone = await undo(request.name, made, report);
          if (ordering && error instanceof LinodeError && refusesTheOffer(error)) {
            throw new ProviderError({
              error: "type-unavailable",
              message: `${TITLE} would not create ${request.type} at ${request.location} (${error.status}): ${error.said}`,
              details: [
                `the cheapest types at ${request.location}:`,
                ...cheapestTypes(offer.types, request.location, offer.unavailable, request.type),
                "or try another --location",
                ...undone,
              ],
            });
          }
          const interfaces = ordering && error instanceof LinodeError && error.fields.some((field) => field.startsWith("interface"));
          throw new ProviderError({
            ...error.failure,
            details: [
              ...(error.failure.details ?? []),
              ...(interfaces ? [`the account's setting for new Linodes' interfaces (Cloud Manager, Account, Settings) may forbid the ${interfaceGeneration(offer.region)} generation this region was asked for`] : []),
              ...undone,
            ],
          });
        }
        created = true;
        resources.push({ kind: "linode", name: instance.label, id: String(instance.id), reused: false });
        report(`   ordered, id ${instance.id}`);
      }
      if (request.backups && !created) await ensureBackups(instance, report);
      report(`-> ${request.name} running`);
      const running = await waitRunning(instance.id, request.name, report, created);
      return { machine: toMachine(running, await knownTypes(), owner), created, resources };
    },

    async list() {
      // Every Linode, filtered here: the tags are checked on what comes
      // back, whatever a filter on them would have matched.
      const instances = await listAll<LinodeInstance>("/linode/instances", "read the Linodes");
      const managed = instances.filter((instance) => owner.managesTags(instance.tags));
      const types = managed.length === 0 ? null : await knownTypes();
      return managed.map((instance) => toMachine(instance, types, owner));
    },

    async destroy(machine, _options, report): Promise<DestroyOutcome> {
      const removed: string[] = [];
      const kept: string[] = [];
      const id = Number(machine.id);
      const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");

      report(`-> Linode ${machine.name}`);
      // Read again, so that only a Linode carrying its owner's tags, under
      // that label, is ever deleted, whatever the caller was handed.
      const current = await call<LinodeInstance>("GET", `/linode/instances/${id}`, `read the Linode ${machine.name}`);
      if (!owner.managesTags(current.tags) || current.label !== machine.name) {
        throw new ProviderError({
          error: "machine-not-managed",
          message: `the Linode ${current.label} does not carry the tag ${owner.tagMark}: ${owner.name} did not create it`,
          details: ["nothing was deleted"],
        });
      }
      // Block Storage volumes are only detached by the deletion, and stay
      // billed: they are said, never deleted, since they may hold data.
      const volumes = await listAll<LinodeVolume>(`/linode/instances/${id}/volumes`, `read the volumes of ${machine.name}`);
      // Its disks and its backups go with it, and its address goes back to Akamai.
      await call("DELETE", `/linode/instances/${id}`, `delete the Linode ${machine.name}`);
      removed.push(`Linode ${machine.name}${addresses === "" ? "" : ` (${addresses})`}${current.backups?.enabled === true ? ", with its backups" : ""}`);
      report("   deleted");
      for (const volume of volumes) {
        kept.push(`volume ${volume.label} (${volume.size} GB): detached from ${machine.name}, and billed until it is deleted from Cloud Manager`);
        report(`!! volume ${volume.label} (${volume.size} GB) is only detached: it stays billed until it is deleted from Cloud Manager`);
      }

      const label = firewallLabel(machine.name, owner);
      report(`-> firewall ${label}`);
      const firewall = await findFirewallByLabel(label);
      if (firewall === null || !ownsFirewall(firewall, machine.name)) {
        report(`   none created by ${owner.name} for it`);
        if (firewall !== null) kept.push(`firewall ${firewall.label}: ${owner.name} did not create it for ${machine.name}`);
      } else {
        // Deleting a firewall strips its rules from all it protects: it goes
        // only when it protects nothing but the Linode just deleted.
        const elsewhere = (firewall.entities ?? []).filter((entity) => {
          if (entity.type === "linode") return entity.id !== id;
          if (entity.type === "linode_interface") return entity.parent_entity?.id !== id;
          return true;
        });
        if (elsewhere.length > 0) {
          const named = elsewhere.map((entity) => `${entity.type} ${entity.label ?? entity.id}`).join(", ");
          kept.push(`firewall ${firewall.label}: still protects ${named}`);
          report(`   kept: still protects ${named}`);
        } else {
          await call("DELETE", `/networking/firewalls/${firewall.id}`, `delete the firewall ${firewall.label}`);
          removed.push(`firewall ${firewall.label}`);
          report("   deleted");
        }
      }

      report("-> SSH key");
      report("   none in the account: the key went onto the Linode's disk, and went with it");
      return { removed, kept };
    },

    async locations(): Promise<Choice[]> {
      const regions = await listAll<LinodeRegion>("/regions", "read the regions");
      const first = (id: string) => (id === LINODE_DEFAULTS.location ? 0 : 1);
      return regions
        .filter(orderable)
        .sort((a, b) => first(a.id) - first(b.id) || (a.country ?? "").localeCompare(b.country ?? "") || a.id.localeCompare(b.id))
        .map((region) => ({ value: region.id, label: regionLabel(region), hint: region.id }));
    },

    async types(location): Promise<Choice[]> {
      const types = await listAll<LinodeType>("/linode/types", "read the Linode types");
      const unavailable = unavailablePlans(await availability(location), location);
      return types
        .filter((type) => WIZARD_CLASSES.has(type.class) && type.memory >= WIZARD_MEMORY && !unavailable.has(type.id))
        .sort((a, b) => Number(b.id === LINODE_DEFAULTS.type) - Number(a.id === LINODE_DEFAULTS.type) || monthlyCost(a, location) - monthlyCost(b, location) || a.id.localeCompare(b.id))
        .slice(0, 12)
        .map((type) => {
          const price = priceText(type, location);
          return { value: type.id, label: `${type.id}  ${sizeText(type)}`, ...(price === null ? {} : { hint: price }) };
        });
    },
  };
}

// --- the credentials ----------------------------------------------------------------------

/** A personal access token: 64 hexadecimal characters today, any run of letters and digits accepted. */
const TOKEN_SHAPE = /^[A-Za-z0-9]{32,256}$/;

/**
 * The token of linode-cli's configuration, an INI file: the user `[DEFAULT]`
 * names in `default-user`, else the only user it holds, as the CLI picks it.
 * Null when it holds none.
 */
export function cliConfigToken(text: string): string | null {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      const name = header[1]!.trim();
      current = sections.get(name) ?? new Map();
      sections.set(name, current);
      continue;
    }
    const separator = line.search(/[=:]/);
    if (current === null || separator <= 0) continue;
    current.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const users = [...sections.entries()].filter(([name, keys]) => name !== "DEFAULT" && keys.has("token"));
  const chosen = sections.get("DEFAULT")?.get("default-user");
  const user = chosen !== undefined ? users.find(([name]) => name === chosen) : users.length === 1 ? users[0] : undefined;
  const value = user?.[1].get("token");
  return value === undefined || value === "" ? null : value;
}

/**
 * The token linode-cli would use: LINODE_CLI_TOKEN, else its configuration
 * file, where LINODE_CLI_CONFIG says, else ~/.linode-cli, the older place,
 * else linode-cli under XDG_CONFIG_HOME or ~/.config. A value that does not
 * have a token's shape is not taken.
 */
export async function discover(workstation: Workstation): Promise<Discovery | null> {
  const fromVariable = workstation.environment[CLI_TOKEN_VARIABLE]?.trim();
  if (fromVariable !== undefined && fromVariable !== "") {
    return TOKEN_SHAPE.test(fromVariable) ? { source: `${CLI_TOKEN_VARIABLE}, linode-cli's variable`, credentials: { [TOKEN_VARIABLE]: fromVariable } } : null;
  }
  const custom = workstation.environment.LINODE_CLI_CONFIG?.trim();
  const xdg = workstation.environment.XDG_CONFIG_HOME?.trim();
  const paths = custom ? [custom] : ["~/.linode-cli", `${xdg ? xdg : "~/.config"}/linode-cli`];
  for (const path of paths) {
    const text = workstation.readFile(path);
    if (text === null) continue;
    const value = cliConfigToken(text);
    if (value === null || !TOKEN_SHAPE.test(value)) return null;
    return { source: `linode-cli's configuration, ${path}`, credentials: { [TOKEN_VARIABLE]: value } };
  }
  return null;
}

/** The token is read from LINODE_TOKEN, as Akamai's Terraform provider reads it, or found where linode-cli keeps its own. */
export const LINODE: ProviderEntry = {
  name: "linode",
  title: "Akamai (Linode)",
  credentials: [{ variable: TOKEN_VARIABLE, label: "personal access token", secret: true, shape: TOKEN_SHAPE }],
  discover,
  credentialHelp: [
    "create it in Akamai Cloud Manager: your username at the top right, API Tokens, Create a Personal Access Token",
    "give it Read/Write on Linodes and on Firewalls, No Access on everything else, and an expiry",
    "linode-cli's own token, from LINODE_CLI_TOKEN or its configuration, is used when LINODE_TOKEN is not set",
  ],
  docs: "docs/providers/linode.md",
  defaults: () => LINODE_DEFAULTS,
  nameProblem,
  backups: true,
  apiVariable: API_VARIABLE,
  open: linode,
};
