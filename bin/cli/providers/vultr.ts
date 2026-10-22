/**
 * Vultr, through its API v2: https://www.vultr.com/api/
 *
 * A machine is three resources:
 *
 *   - the workstation's SSH key, reused when the account already holds the
 *     same key under any name, uploaded as `sitesolide-<name>` otherwise;
 *   - a firewall group, inbound TCP 22, 80 and 443 and ICMP from everywhere,
 *     over IPv4 and IPv6, everything else inbound dropped;
 *   - the instance, labelled with the machine's name, with both public
 *     addresses, the key for root, the firewall group, and no user_data:
 *     `sitesolide setup` hardens it over SSH, which a run can repeat.
 *
 * Vultr has tags on instances only. The instance carries
 * `managed-by:sitesolide` and `sitesolide-machine:<name>`, which `list` and
 * `destroy` go by. A firewall group has a description and nothing else: it is
 * marked by writing the same two tags into it, and `destroy` deletes a group
 * only when its description says it was made for that machine. An SSH key has
 * a name and nothing else: when this command uploaded the key, or finds the
 * one it uploaded for that name before, the instance carries a third tag,
 * `sitesolide-key:<id>`, and `destroy --delete-key` deletes that key only, and
 * only while its name is still the one sitesolide gave it. A key the account
 * already held under another name is never deleted.
 *
 * The instance's public IPv4 stays its own for as long as the instance
 * exists, halted included: Vultr says a stopped instance "continues to
 * reserve" its IP addresses (and bills them). No Reserved IP is needed for the
 * DNS records to keep pointing at it.
 *
 * Everything that can refuse is read before the first write: an instance of
 * that label (one without the tags is never touched), the region, the plan
 * against where Vultr sells it and what it has in stock there right now, and
 * the image. When the order itself is refused, a 4xx, the key and the firewall
 * group this run created for it are deleted again, and the refusal says so.
 * An order whose answer is a 5xx, a 429, lost or unreadable may have created
 * the instance all the same: nothing is undone then, since Vultr detaches the
 * instances of a group it deletes and the instance would run with every port
 * open. A run that finds the machine makes sure it is behind its group, and
 * makes and attaches one if it is not.
 *
 * `destroy` says what outlives the instance and stays billed, its block
 * storage and its reserved IPs, and never deletes them. Prices are the
 * region's: `location_cost` where Vultr charges more there, `monthly_cost`
 * elsewhere.
 *
 * Every call carries the API key in the Authorization header and nowhere else,
 * follows no redirect, and fails with a ProviderError whose code
 * bin/cli/hints.ts knows. The API's errors are `{"error": "...", "status": n}`.
 * Lists are paginated by cursor: `meta.links.next` is passed back as `cursor`
 * until it is empty, 500 items a page, the most the API returns. Vultr allows
 * about 30 requests a second from one address; waits poll every five seconds.
 */
import {
  apiAddress,
  DEBIAN,
  formatPrice,
  isManagedTags,
  machineOfTags,
  MANAGED_LABEL,
  MANAGED_VALUE,
  ProviderError,
  retryAfter,
  statusFailure,
  tagsFor,
  TRANSIENT,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type DestroyOutcome,
  type Discovery,
  type Machine,
  type Provider,
  type ProviderContext,
  type ProviderEntry,
  type Report,
  type Resource,
  type Workstation,
} from "./provider";
import type { Failure } from "../remote";

export const DEFAULT_API = "https://api.vultr.com/v2";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_VULTR_API";

/** What vultr-cli and the Terraform provider read the key from. */
export const KEY_VARIABLE = "VULTR_API_KEY";

/**
 * Regular Cloud Compute with one vCPU and 2 GB is the cheapest x86 plan Vultr
 * sells with 2 GB of memory, sold in every European region; Frankfurt keeps
 * the machine in Germany. Debian 13 is the only system setup is verified on.
 */
export const VULTR_DEFAULTS = { type: "vc2-1c-2gb", location: "fra", image: DEBIAN };

/** Vultr's prices are in US dollars, before tax, whatever the account. */
const CURRENCY = "USD";

/** The instance tag that names the SSH key uploaded for it. */
export const KEY_TAG = "sitesolide-key";

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  /** From the order to an instance active, running and past its install lock. */
  readyMs: 10 * 60_000,
  /** A locked instance refuses deletion: how long destroy waits for the lock to go. */
  unlockMs: 2 * 60_000,
  /** From the deletion to the instance gone from the API. */
  goneMs: 3 * 60_000,
  pollMs: 5_000,
  /** A firewall group still counting its instance a moment after it went. */
  firewallTries: 5,
};

/** The smallest memory worth offering, in MB: the defaults' floor. */
const MINIMUM_RAM_MB = 2048;

type RuleRequest = { ip_type: "v4" | "v6"; protocol: string; subnet: string; subnet_size: number; port?: string; notes: string };

/**
 * Inbound TCP 22, 80 and 443 and ICMP, from every IPv4 and IPv6 address: a
 * firewall group drops whatever inbound no rule accepts. Ping serves diagnosis
 * and external monitoring. The protocol is written lowercase, as the API
 * answers it and as Vultr's Terraform provider sends it.
 */
export const FIREWALL_RULES: RuleRequest[] = (["v4", "v6"] as const).flatMap((family) => {
  const subnet = family === "v4" ? "0.0.0.0" : "::";
  return [
    { ip_type: family, protocol: "tcp", subnet, subnet_size: 0, port: "22", notes: "sitesolide ssh" },
    { ip_type: family, protocol: "tcp", subnet, subnet_size: 0, port: "80", notes: "sitesolide http" },
    { ip_type: family, protocol: "tcp", subnet, subnet_size: 0, port: "443", notes: "sitesolide https" },
    { ip_type: family, protocol: "icmp", subnet, subnet_size: 0, notes: "sitesolide ping" },
  ];
});

// --- the API's objects, as far as this file reads them ---------------------------------

export type VultrInstance = {
  id: string;
  label: string;
  hostname?: string;
  plan: string;
  region: string;
  os?: string;
  os_id?: number;
  /** `pending`, `active`, `suspended`, `resizing`. */
  status: string;
  /** `running`, `stopped`. */
  power_status: string;
  /** `none`, `locked`, `installingbooting`, `ok`. */
  server_status: string;
  /** `0.0.0.0` until the address is assigned. */
  main_ip: string;
  v6_main_ip?: string;
  v6_network?: string;
  v6_network_size?: number;
  firewall_group_id?: string;
  /** `auto_backups`, `ipv6`, `ddos_protection`. */
  features?: string[];
  tags?: string[];
  /** `root`, or `limited` for an image that lets in `linuxuser` only. */
  user_scheme?: string;
};

export type VultrPlan = {
  id: string;
  vcpu_count: number;
  /** In MB. */
  ram: number;
  /** In GB. */
  disk: number;
  /** The price in most regions; `location_cost` has the others. */
  monthly_cost: number;
  /** Where the plan costs more, `sao` for one: by region, its own monthly price. */
  location_cost?: Record<string, { monthly_cost?: unknown } | undefined>;
  type: string;
  /** The regions it is sold in; what is in stock right now is /regions/{id}/availability's. */
  locations: string[];
  gpu_type?: string;
};

type VultrRegion = { id: string; city?: string; country?: string; continent?: string };
type VultrOs = { id: number; name: string; arch: string; family: string };
type VultrKey = { id: string; name: string; ssh_key: string };
type VultrFirewall = { id: string; description: string; instance_count: number; rule_count?: number };
type VultrRule = { id: number; ip_type?: string; type?: string; protocol: string; port?: string; subnet: string; subnet_size: number; source?: string };
type VultrBlock = { id: string; label?: string; size_gb?: number; region?: string; attached_to_instance?: string };
type VultrReservedIp = { id: string; label?: string; ip_type?: string; subnet?: string; subnet_size?: number; instance_id?: string };
type BackupSchedule = { enabled?: boolean; type?: string; hour?: number; next_scheduled_time_utc?: string };

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status kept for the callers that tell them apart. */
export class VultrError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/**
 * A Vultr API key may be restricted to some addresses, and then answers 401
 * to a call from any other: the workstation's address is as likely a cause
 * as the key itself.
 */
function accessListDetails(said: string): string[] {
  const named = /\bIP\b|address/i.test(said);
  return [
    named
      ? "the key's access control list does not allow this workstation's address: add it, or its network, to the list"
      : "a key is refused when it is unknown or revoked, and also when its access control list does not allow this workstation's address",
    "the list is the user's API Access in the organization (Manage Organization, Users), or Account, API for the account's own key",
  ];
}

/**
 * An error answer of the API as a failure the CLI reports. `what` says what
 * was being done, in the infinitive: `create the instance web`.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string): VultrError {
  const error = (body as { error?: unknown } | null)?.error;
  const said = typeof error === "string" && error.trim() !== "" ? error.trim() : `answered ${status}`;
  const make = (failure: Failure) => new VultrError(failure, status, said);

  if (status === 401) {
    return make({ error: "provider-unauthenticated", message: `Vultr refused the API key (401): ${said}`, details: accessListDetails(said) });
  }
  if (status === 403) {
    return make({
      error: "provider-forbidden",
      message: `the API key may not ${what} (403): ${said}`,
      details: [
        "a key acts with its user's permissions: the user needs the compute instance and SSH key actions and the network firewall actions",
        ...accessListDetails(said),
      ],
    });
  }
  if (status === 400 && /\blimit\b|maximum number|quota/i.test(said)) {
    return make({
      error: "provider-limit",
      message: `Vultr refused to ${what} (400): ${said}`,
      details: ["the account has reached one of its limits: Vultr raises them on request, from a support ticket"],
    });
  }
  if (status === 429) {
    // The limit is per second and per address: a short wait is enough.
    const wait = retryAfter(headers, 2);
    return make({
      error: "provider-rate-limited",
      message: `Vultr's rate limit is reached, nothing more can be asked of it for now (429)`,
      details: [`Vultr accepts about 30 requests a second from one address: wait ${wait} s`],
      wait,
    });
  }
  return make(statusFailure("Vultr", status, said, headers, what));
}

/**
 * Whether a refused order says the plan cannot be had there right now rather
 * than that the request was wrong: the plan, the region and the stock were all
 * read just before, so a 400 that speaks of availability is about the offer.
 */
export function refusesTheOffer(error: VultrError): boolean {
  return error.status === 400 && /not available|unavailable|out of stock|sold out|capacity/i.test(error.said);
}

/**
 * Whether the API said no to a request, which then changed nothing: a 4xx.
 * A 429 says "not now" rather than "no", and a 5xx, an answer that never
 * came back or one that cannot be read leave the outcome unknown: the
 * request may have been carried out all the same.
 */
export function isDefiniteRefusal(error: ProviderError): boolean {
  return error instanceof VultrError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

// --- what the answers mean -------------------------------------------------------------------

/** `managed-by:sitesolide` as the label `managed-by` = `sitesolide`, for the interface's `labels`. */
export function labelsOfTags(tags: readonly string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags ?? []) {
    const colon = tag.indexOf(":");
    if (colon === -1) labels[tag] = "";
    else labels[tag.slice(0, colon)] = tag.slice(colon + 1);
  }
  return labels;
}

/** The SSH key an instance's tags say was uploaded for it, or null. */
export function keyOfTags(tags: readonly string[] | undefined): string | null {
  const prefix = `${KEY_TAG}:`;
  return (tags ?? []).find((tag) => tag.startsWith(prefix))?.slice(prefix.length) || null;
}

/** What a firewall group made for a machine says: the instance's two tags. */
export function firewallDescription(name: string): string {
  return tagsFor(name).join(" ");
}

/** Whether a firewall group was made by sitesolide for that machine, which its description alone can say. */
export function ownsFirewall(group: VultrFirewall, name: string): boolean {
  const words = (group.description ?? "").trim().split(/\s+/);
  return isManagedTags(words) && machineOfTags(words) === name;
}

/**
 * The names sitesolide gives a key it uploads for a machine: `sitesolide-web`,
 * or, when another key has that one, `sitesolide-web-` followed by the first
 * eight hex digits of this key's own MD5 fingerprint. Any other suffix is
 * somebody else's naming, and the key theirs.
 */
export function isKeyNameFor(keyName: string, machine: string, fingerprint: string): boolean {
  const plain = `sitesolide-${machine}`;
  const prefix = fingerprint.replaceAll(":", "").toLowerCase().slice(0, 8);
  return keyName === plain || (/^[0-9a-f]{8}$/.test(prefix) && keyName === `${plain}-${prefix}`);
}

/** The MD5 fingerprint of a key as the account holds it, `a4:46:...`, as ssh-keygen -E md5 prints it; empty when unreadable. */
export function fingerprintOf(line: string): string {
  const blob = line.trim().split(/\s+/)[1] ?? "";
  if (!/^[A-Za-z0-9+/]+=*$/.test(blob)) return "";
  return new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g)?.join(":") ?? "";
}

/** The key itself, without its comment: two copies of a key compare equal through it. */
function keyMaterial(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** An address Vultr has not assigned yet reads `0.0.0.0`, or nothing. */
function address(value: string | undefined): string | null {
  return value === undefined || value === "" || value === "0.0.0.0" || value === "::" ? null : value;
}

/** The instance's state in one of Vultr's words: its subscription's, then its power's, then its install's. */
export function statusOf(instance: VultrInstance): string {
  if (instance.status !== "active") return instance.status;
  if (instance.power_status !== "running") return instance.power_status;
  if (instance.server_status === "none" || instance.server_status === "locked" || instance.server_status === "installingbooting") return instance.server_status;
  return "running";
}

/**
 * Active, running, and past the lock it carries while it is being created:
 * what Vultr's Terraform provider and its Ansible collection wait for. The
 * first boot may still be finishing; the command waits for port 22 after.
 */
export function isReady(instance: VultrInstance): boolean {
  return instance.status === "active" && instance.power_status === "running" && instance.server_status !== "none" && instance.server_status !== "locked";
}

function gigabytes(megabytes: number): string {
  return megabytes % 1024 === 0 ? String(megabytes / 1024) : (megabytes / 1024).toFixed(1);
}

/**
 * What a plan costs a month in a region: most regions share `monthly_cost`,
 * and those that cost more have their own in `location_cost`, which the API
 * answers and its OpenAPI document does not list yet.
 */
export function priceAt(plan: VultrPlan, location: string): number {
  const local = plan.location_cost?.[location]?.monthly_cost;
  return typeof local === "number" && Number.isFinite(local) ? local : plan.monthly_cost;
}

export function toMachine(instance: VultrInstance, plans: VultrPlan[] | null): Machine {
  const plan = plans?.find((candidate) => candidate.id === instance.plan);
  const network = address(instance.v6_network);
  const price = plan === undefined ? Number.NaN : priceAt(plan, instance.region);
  const cost = Number.isFinite(price) ? price.toFixed(2) : null;
  return {
    provider: "vultr",
    id: instance.id,
    name: instance.label,
    type: instance.plan,
    location: instance.region,
    status: statusOf(instance),
    ipv4: address(instance.main_ip),
    ipv6: address(instance.v6_main_ip),
    ipv6Network: network === null ? null : `${network}/${instance.v6_network_size ?? 64}`,
    // Vultr gives one price, before tax: there is no other to call gross.
    monthlyPrice: cost === null ? null : { net: cost, gross: cost, currency: CURRENCY },
    backups: (instance.features ?? []).includes("auto_backups"),
    managed: isManagedTags(instance.tags),
    labels: labelsOfTags(instance.tags),
    // An image deployed with the limited scheme locks root and lets in linuxuser, a sudoer.
    login: instance.user_scheme === "limited" ? "linuxuser" : "root",
  };
}

/** Whether a plan is worth offering: not a GPU, not IPv6 only (a DNS A record needs an IPv4), 2 GB at least. */
function offered(plan: VultrPlan): boolean {
  return plan.type !== "vcg" && (plan.gpu_type ?? "") === "" && !plan.id.endsWith("-v6") && plan.ram >= MINIMUM_RAM_MB;
}

function planLine(plan: VultrPlan): string {
  return `${plan.vcpu_count} vCPU, ${gigabytes(plan.ram)} GB RAM, ${plan.disk} GB disk`;
}

/** The plans in stock at a location worth offering, cheapest first, one line each. */
export function cheapestPlans(plans: VultrPlan[], location: string, inStock: Set<string>, options: { except?: string; count?: number } = {}): string[] {
  return plans
    .filter((plan) => offered(plan) && plan.locations.includes(location) && inStock.has(plan.id) && plan.id !== options.except)
    .sort((a, b) => priceAt(a, location) - priceAt(b, location) || a.id.localeCompare(b.id))
    .slice(0, options.count ?? 6)
    .map((plan) => `${plan.id.padEnd(16)} ${planLine(plan)}, ${formatPrice(priceAt(plan, location), CURRENCY)}`);
}

function suggestedPlans(plans: VultrPlan[], location: string, inStock: Set<string>, except?: string): string[] {
  const lines = cheapestPlans(plans, location, inStock, { except });
  return lines.length > 0 ? [`the cheapest plans Vultr has in stock at ${location}:`, ...lines] : [`Vultr has no other plan in stock at ${location}`];
}

/**
 * The image `--image` names, among Vultr's: `debian-13` is Debian 13 x64, and
 * `debian-<n>` the same for another release; a number is an os_id as /os
 * lists it. Null when nothing matches.
 */
export function imageFor(image: string, systems: VultrOs[]): VultrOs | null {
  const debian = /^debian-([0-9]+)$/.exec(image);
  if (debian !== null) {
    const name = new RegExp(`^Debian ${debian[1]} x64\\b`);
    return systems.find((os) => os.family === "debian" && os.arch === "x64" && name.test(os.name)) ?? null;
  }
  if (/^[0-9]+$/.test(image)) return systems.find((os) => os.id === Number(image)) ?? null;
  return null;
}

/**
 * Whether a rule the group holds is one of FIREWALL_RULES. ICMP has no port,
 * which an answer may write as nothing, an empty string or `0`: all three are
 * the same rule, or a second run would add it again.
 */
export function sameRule(existing: VultrRule, wanted: RuleRequest): boolean {
  const family = existing.ip_type ?? existing.type;
  const protocol = existing.protocol.toLowerCase();
  const port = (value: string | undefined) => (protocol === "icmp" && (value === undefined || value === "" || value === "0") ? "" : (value ?? ""));
  return (
    family === wanted.ip_type &&
    protocol === wanted.protocol &&
    port(existing.port) === port(wanted.port) &&
    existing.subnet_size === 0 &&
    (existing.source ?? "") === ""
  );
}

/** What Vultr's backup schedule says, for a person. */
function scheduleLine(schedule: BackupSchedule): string {
  const hour = typeof schedule.hour === "number" ? ` at ${String(schedule.hour).padStart(2, "0")}:00 UTC` : "";
  const next = schedule.next_scheduled_time_utc ? `, the next on ${schedule.next_scheduled_time_utc} UTC` : "";
  return `${schedule.type ?? "scheduled"}${hour}${next}`;
}

// --- the provider ---------------------------------------------------------------------------

export function vultr(context: ProviderContext): Provider {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const { clock, fetcher } = context;
  const key = context.credentials[KEY_VARIABLE] ?? "";

  /** One call: the key in its header, JSON both ways, every failure said in the CLI's words. */
  async function call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by bin/cli/machine.ts.
      throw new VultrError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0);
    }
    if (response.status === 204) return {} as T;
    const text = await response.text();
    let parsed: unknown = {};
    let readable = true;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        readable = false;
      }
    }
    // A proxy in front of the API may answer a 502 or a 429 in HTML: still
    // Vultr saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new VultrError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Vultr's API, while trying to ${what}` }, response.status);
    }
    if (!response.ok) throw failureFrom(response.status, readable ? parsed : null, response.headers, what);
    return parsed as T;
  }

  /** Every page of a list, passing `meta.links.next` back as the cursor until it is empty. */
  async function listAll<T>(path: string, key: string, what: string, query: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (let pages = 0; pages < 200; pages++) {
      const parameters = new URLSearchParams({ ...query, per_page: "500", ...(cursor === "" ? {} : { cursor }) });
      const answer = await call<Record<string, unknown>>("GET", `${path}?${parameters}`, what);
      const list = answer[key];
      if (!Array.isArray(list)) {
        throw new VultrError({ error: "provider-unreadable", message: `${host} answered without the list of ${key}, while trying to ${what}` }, 200);
      }
      items.push(...(list as T[]));
      const next: unknown = (answer.meta as { links?: { next?: unknown } } | undefined)?.links?.next;
      if (typeof next !== "string" || next === "" || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return items;
  }

  /**
   * An instance as the API gave it, without what must never travel further:
   * the root password Vultr sets at creation, scrubbed from then on though
   * nothing here prints it, and the link to its web console.
   */
  function clean(raw: VultrInstance & { default_password?: unknown; kvm?: unknown }): VultrInstance {
    const { default_password: password, kvm: _console, ...instance } = raw;
    if (typeof password === "string" && password !== "") context.secret(password);
    return instance;
  }

  let plansRead: Promise<VultrPlan[]> | null = null;
  /** Every plan Vultr sells, read once. */
  function plans(): Promise<VultrPlan[]> {
    plansRead ??= listAll<VultrPlan>("/plans", "plans", "read the plans", { type: "all" }).catch((error: unknown) => {
      plansRead = null;
      throw error;
    });
    return plansRead;
  }

  /** The plans for their prices; null when they cannot be read, which stops nothing. */
  function prices(): Promise<VultrPlan[] | null> {
    return plans().catch(() => null);
  }

  async function inStock(location: string): Promise<Set<string>> {
    const answer = await call<{ available_plans?: unknown }>("GET", `/regions/${encodeURIComponent(location)}/availability`, `read what Vultr has in stock at ${location}`);
    if (!Array.isArray(answer.available_plans)) {
      throw new VultrError({ error: "provider-unreadable", message: `${host} answered without the plans in stock at ${location}` }, 200);
    }
    return new Set(answer.available_plans.map(String));
  }

  /** The instances labelled with that name, the one sitesolide created for it first. */
  async function findInstance(name: string): Promise<VultrInstance | null> {
    const listed = await listAll<VultrInstance>("/instances", "instances", "read the instances", { label: name });
    const same = listed.filter((instance) => instance.label === name).map(clean);
    return same.find((instance) => isManagedTags(instance.tags) && machineOfTags(instance.tags) === name) ?? same.find((instance) => isManagedTags(instance.tags)) ?? same[0] ?? null;
  }

  async function readInstance(id: string, name: string): Promise<VultrInstance> {
    const answer = await call<{ instance: VultrInstance }>("GET", `/instances/${encodeURIComponent(id)}`, `read the instance ${name}`);
    return clean(answer.instance);
  }

  /**
   * A call made while waiting: a failure that says "later" is tolerated until
   * the deadline, once warned; any other ends the wait.
   */
  async function patiently<T>(attempt: () => Promise<T>, deadline: number, report: Report, warned: { done: boolean }): Promise<T | null> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ProviderError) || !TRANSIENT.has(error.failure.error) || clock.now() >= deadline) throw error;
      if (!warned.done) report(`!! ${error.failure.message}: still waiting`);
      warned.done = true;
      return null;
    }
  }

  async function waitReady(id: string, name: string, report: Report, justCreated: boolean): Promise<VultrInstance> {
    const deadline = clock.now() + WAITS.readyMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const instance = await patiently(() => readInstance(id, name), deadline, report, warned);
      if (instance !== null) {
        const status = statusOf(instance);
        if (status !== last) report(`   status: ${status}`);
        last = status;
        if (isReady(instance)) return instance;
        if (instance.status === "suspended") {
          throw new ProviderError({
            error: "action-failed",
            message: `Vultr suspended the instance ${name}`,
            details: ["Vultr suspends an instance over the account's billing or its terms: the console and the account's email say why"],
          });
        }
        if (!justCreated && instance.status === "active" && instance.power_status === "stopped") {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is stopped`, details: ["sitesolide never starts or stops a machine by itself"] });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.readyMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** Refuses what cannot be ordered, before anything is written; returns what the order and its refusal need. */
  async function checkOffer(request: CreateRequest, report: Report): Promise<{ plans: VultrPlan[]; stock: Set<string>; os: VultrOs }> {
    report(`-> ${request.type} at ${request.location}, what Vultr sells there`);
    const regions = await listAll<VultrRegion>("/regions", "regions", "read the regions");
    if (!regions.some((region) => region.id === request.location)) {
      throw new ProviderError({
        error: "invalid-location",
        message: `${request.location} is not a Vultr region`,
        details: ["the regions:", ...regions.map((region) => `${region.id.padEnd(5)} ${[region.city, region.country].filter(Boolean).join(", ")}`)],
      });
    }
    const all = await plans();
    const stock = await inStock(request.location);
    const chosen = all.find((plan) => plan.id === request.type);
    if (chosen === undefined || !chosen.locations.includes(request.location)) {
      throw new ProviderError({
        error: "invalid-server-type",
        message: chosen === undefined ? `${request.type} is not a Vultr plan` : `${request.type} is not sold at ${request.location}`,
        details: suggestedPlans(all, request.location, stock),
      });
    }
    if (!stock.has(chosen.id)) {
      throw new ProviderError({
        error: "type-unavailable",
        message: `Vultr has no ${request.type} in stock at ${request.location} right now`,
        details: [...suggestedPlans(all, request.location, stock, request.type), "or try another --location", "nothing had been created yet"],
      });
    }
    report(`   ${planLine(chosen)}, ${formatPrice(priceAt(chosen, request.location), CURRENCY)}`);

    const systems = await listAll<VultrOs>("/os", "os", "read the images");
    const os = imageFor(request.image, systems);
    if (os === null) {
      const debian = systems.filter((candidate) => candidate.family === "debian" && candidate.arch === "x64");
      throw new ProviderError({
        error: "provider-invalid",
        message: `no Vultr image matches ${request.image}`,
        details: [
          "--image takes debian-<release>, or an os_id Vultr lists; sitesolide setup is verified on Debian 13 only",
          ...debian.map((candidate) => `${String(candidate.id).padEnd(6)} ${candidate.name}`),
        ],
      });
    }
    report(`   ${request.image}: ${os.name}, os_id ${os.id}`);
    return { plans: all, stock, os };
  }

  /**
   * Deletes what this run created before an order Vultr refused: the key and
   * the firewall group were made for an instance that does not exist, and
   * nothing else in sitesolide would ever list or remove them, since `list`
   * and `destroy` start from an instance. What an earlier run made, or the
   * account already held, is left as it was. A deletion that fails leaves the
   * resource, where the next run finds and reuses it. Returns what happened,
   * one line each, for the refusal's details.
   */
  async function undo(made: { kind: string; name: string; path: string }[], report: Report): Promise<string[]> {
    if (made.length === 0) return ["nothing had been created yet"];
    report("-> undo what this run created");
    const said: string[] = [];
    // The firewall group first: it was created last. Its rules go with it.
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

  /** The workstation's key in the account; `forMachine` when its name says sitesolide uploaded it for this machine. */
  async function ensureKey(request: CreateRequest, report: Report): Promise<VultrKey & { reused: boolean; forMachine: boolean }> {
    report("-> SSH key");
    const keys = await listAll<VultrKey>("/ssh-keys", "ssh_keys", "read the SSH keys");
    const ours = `${request.key.algorithm} ${request.key.blob}`;
    const same = keys.find((candidate) => keyMaterial(candidate.ssh_key) === ours);
    if (same !== undefined) {
      report(`   ${same.name}, already in the account (${request.key.fingerprint}), reused`);
      return { ...same, reused: true, forMachine: isKeyNameFor(same.name, request.name, request.key.fingerprint) };
    }
    // A name of its own, never one the account already uses for another key.
    const taken = new Set(keys.map((candidate) => candidate.name));
    const plain = `sitesolide-${request.name}`;
    const name = taken.has(plain) ? `${plain}-${request.key.fingerprint.replaceAll(":", "").slice(0, 8)}` : plain;
    const line = [request.key.algorithm, request.key.blob, request.key.comment].filter((part) => part !== "").join(" ");
    const created = await call<{ ssh_key: VultrKey }>("POST", "/ssh-keys", `upload the SSH key ${name}`, { name, ssh_key: line });
    report(`   ${name}, uploaded (${request.key.fingerprint})`);
    return { ...created.ssh_key, reused: false, forMachine: true };
  }

  /** The firewall group an earlier run made for that machine, read before anything is created. */
  async function findFirewall(name: string): Promise<VultrFirewall | null> {
    const groups = await listAll<VultrFirewall>("/firewalls", "firewall_groups", "read the firewall groups");
    return groups.find((group) => ownsFirewall(group, name)) ?? null;
  }

  /**
   * Adds the rules of FIREWALL_RULES a group lacks, and returns how many. A
   * group and its rules are separate writes: a run interrupted between them
   * left a group with some rules, which the next one completes.
   */
  async function completeRules(group: VultrFirewall): Promise<number> {
    const path = `/firewalls/${encodeURIComponent(group.id)}/rules`;
    const rules = await listAll<VultrRule>(path, "firewall_rules", "read the firewall rules");
    const missing = FIREWALL_RULES.filter((wanted) => !rules.some((existing) => sameRule(existing, wanted)));
    for (const rule of missing) await call("POST", path, `add the rule ${rule.notes} (${rule.ip_type}) to the firewall group`, rule);
    return missing.length;
  }

  /** The machine's firewall group with all its rules: the one an earlier run made, or a new one, which `made` then lists. */
  async function ensureFirewall(name: string, found: VultrFirewall | null, report: Report, made: { kind: string; name: string; path: string }[]): Promise<VultrFirewall & { reused: boolean }> {
    if (found !== null) {
      report(`   ${found.id}, already created by sitesolide, reused`);
      const added = await completeRules(found);
      if (added > 0) report(`   ${added} missing rules added`);
      return { ...found, reused: true };
    }
    const created = await call<{ firewall_group: VultrFirewall }>("POST", "/firewalls", `create the firewall group for ${name}`, { description: firewallDescription(name) });
    const group = created.firewall_group;
    made.push({ kind: "firewall group", name: group.id, path: `/firewalls/${encodeURIComponent(group.id)}` });
    await completeRules(group);
    report(`   ${group.id}, created: inbound tcp 22, 80, 443 and icmp, from everywhere, IPv4 and IPv6`);
    return { ...group, reused: false };
  }

  /**
   * On a machine found already created, that it is still behind its firewall
   * group, rules complete. It may not be: Vultr detaches the instances of a
   * group it deletes, and an instance whose order got no clear answer was
   * left as it was. A missing group is made again, or the one an earlier run
   * left is reused, and attached. A group sitesolide did not make, attached by
   * hand, is the owner's choice and stays.
   */
  async function ensureGuarded(instance: VultrInstance, report: Report, resources: Resource[]): Promise<VultrInstance> {
    const name = instance.label;
    report(`-> firewall group for ${name}`);
    const attachedId = instance.firewall_group_id ?? "";
    if (attachedId !== "") {
      let attached: VultrFirewall | null = null;
      try {
        attached = (await call<{ firewall_group: VultrFirewall }>("GET", `/firewalls/${encodeURIComponent(attachedId)}`, `read the firewall group ${attachedId}`)).firewall_group;
      } catch (error) {
        if (!(error instanceof VultrError) || error.status !== 404) throw error;
      }
      if (attached !== null && !ownsFirewall(attached, name)) {
        report(`!! ${name} is behind the firewall group ${attached.id}, which sitesolide did not make: left as it is`);
        return instance;
      }
      if (attached !== null) {
        const added = await completeRules(attached);
        report(`   ${attached.id}, attached${added > 0 ? `, ${added} missing rules added` : ""}`);
        resources.push({ kind: "firewall group", name: firewallDescription(name), id: attached.id, reused: true });
        return instance;
      }
    }
    report(`!! ${name} has no firewall group: every port of it is open`);
    const group = await ensureFirewall(name, await findFirewall(name), report, []);
    await call("PATCH", `/instances/${encodeURIComponent(instance.id)}`, `attach the firewall group ${group.id} to ${name}`, { firewall_group_id: group.id });
    report(`   ${group.id}, attached to ${name}`);
    resources.push({ kind: "firewall group", name: firewallDescription(name), id: group.id, reused: group.reused });
    return { ...instance, firewall_group_id: group.id };
  }

  /**
   * The block storage and the reserved IPs attached to an instance, as `kept`
   * lines: deleting the instance detaches them, and Vultr bills them until
   * someone deletes them. A list the key may not read is said, and stops
   * nothing.
   */
  async function attachments(id: string, name: string, report: Report): Promise<string[]> {
    const lines: string[] = [];
    try {
      const blocks = await listAll<VultrBlock>("/blocks", "blocks", "read the block storage");
      for (const block of blocks.filter((candidate) => candidate.attached_to_instance === id)) {
        const size = typeof block.size_gb === "number" ? `${block.size_gb} GB` : "a volume";
        lines.push(`block storage ${block.label || block.id} (${size}${block.region ? ` at ${block.region}` : ""}): detached from ${name}, billed until it is deleted from the console`);
      }
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      report(`!! could not check for block storage attached to ${name} (${error.failure.message}): look in the console, a volume outlives the instance and stays billed`);
    }
    try {
      const addresses = await listAll<VultrReservedIp>("/reserved-ips", "reserved_ips", "read the reserved IPs");
      for (const reserved of addresses.filter((candidate) => candidate.instance_id === id)) {
        const subnet = reserved.subnet ? `${reserved.subnet}${reserved.ip_type === "v6" || (reserved.subnet_size ?? 32) !== 32 ? `/${reserved.subnet_size}` : ""}` : reserved.id;
        lines.push(`reserved IP ${subnet}${reserved.label ? ` (${reserved.label})` : ""}: detached from ${name}, billed until it is deleted from the console`);
      }
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      report(`!! could not check for reserved IPs attached to ${name} (${error.failure.message}): look in the console, a reserved IP outlives the instance and stays billed`);
    }
    for (const line of lines) report(`!! ${line}`);
    return lines;
  }

  async function ensureBackups(instance: VultrInstance, created: boolean, report: Report): Promise<VultrInstance> {
    report("-> backups");
    let current = instance;
    if (!created && !(instance.features ?? []).includes("auto_backups")) {
      const answer = await call<{ instance?: VultrInstance }>("PATCH", `/instances/${encodeURIComponent(instance.id)}`, `enable the backups of ${instance.label}`, { backups: "enabled" });
      if (answer.instance !== undefined) current = clean(answer.instance);
      report("   enabled: Vultr's automatic backups, 20 % on the price of the machine");
    } else if (!created) {
      report("   already enabled");
    }
    try {
      const answer = await call<{ backup_schedule?: BackupSchedule }>("GET", `/instances/${encodeURIComponent(instance.id)}/backup-schedule`, `read the backup schedule of ${instance.label}`);
      const schedule = answer.backup_schedule ?? {};
      if (schedule.enabled === true) report(`   ${created ? "enabled, " : ""}${scheduleLine(schedule)}`);
      else report("!! Vultr does not list a backup schedule yet: look at the instance's Backups tab in the console");
    } catch {
      report("!! the backup schedule could not be read: look at the instance's Backups tab in the console");
    }
    return current;
  }

  return {
    name: "vultr",

    async find(name) {
      const instance = await findInstance(name);
      return instance === null ? null : toMachine(instance, await prices());
    },

    async create(request, report): Promise<CreateOutcome> {
      const resources: Resource[] = [];
      report(`-> an instance labelled ${request.name} in the account`);
      const existing = await findInstance(request.name);
      let instance: VultrInstance;
      let created: boolean;
      if (existing !== null) {
        const found = toMachine(existing, null);
        if (!found.managed) {
          throw new ProviderError({
            error: "machine-exists",
            message: `an instance labelled ${request.name} exists in the account, and sitesolide did not create it`,
            details: [
              `${found.type} at ${found.location}, ${found.status}, ${[found.ipv4, found.ipv6].filter(Boolean).join(", ") || "no public address"}`,
              `it lacks the tag ${MANAGED_LABEL}:${MANAGED_VALUE}: nothing was created, nothing was changed`,
            ],
          });
        }
        report(`   already created by sitesolide: ${found.type} at ${found.location}, ${found.status}`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        instance = existing;
        created = false;
        resources.push({ kind: "instance", name: existing.label, id: existing.id, reused: true });
      } else {
        report("   none of that label yet");
        const offer = await checkOffer(request, report);
        const existingFirewall = await findFirewall(request.name);

        // What this run creates before the instance, undone if the order fails.
        const made: { kind: string; name: string; path: string }[] = [];
        let ordering = false;
        let answer: { instance: VultrInstance };
        try {
          const sshKey = await ensureKey(request, report);
          resources.push({ kind: "ssh key", name: sshKey.name, id: sshKey.id, reused: sshKey.reused });
          if (!sshKey.reused) made.push({ kind: "SSH key", name: sshKey.name, path: `/ssh-keys/${encodeURIComponent(sshKey.id)}` });
          report(`-> firewall group for ${request.name}`);
          const firewall = await ensureFirewall(request.name, existingFirewall, report, made);
          resources.push({ kind: "firewall group", name: firewallDescription(request.name), id: firewall.id, reused: firewall.reused });

          report(`-> instance ${request.name}: ${request.type} at ${request.location}, ${offer.os.name}`);
          ordering = true;
          answer = await call("POST", "/instances", `create the instance ${request.name}`, {
            region: request.location,
            plan: request.type,
            os_id: offer.os.id,
            label: request.name,
            hostname: request.name,
            tags: [...tagsFor(request.name), ...(sshKey.forMachine ? [`${KEY_TAG}:${sshKey.id}`] : [])],
            sshkey_id: [sshKey.id],
            firewall_group_id: firewall.id,
            enable_ipv6: true,
            backups: request.backups ? "enabled" : "disabled",
          });
          if (typeof answer?.instance?.id !== "string") {
            throw new VultrError({ error: "provider-unreadable", message: `${host} answered the order of ${request.name} without the instance` }, 202);
          }
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (ordering && !isDefiniteRefusal(error)) {
            // Vultr may have created the instance though no clear answer
            // came back. Deleting the group now would leave it running with
            // every port open, since Vultr detaches the instances of a group
            // it deletes: nothing is undone, and the next run finds what is.
            report("!! the order's outcome is unknown: nothing this run created is undone");
            throw new ProviderError({
              ...error.failure,
              details: [
                ...(error.failure.details ?? []),
                "the order's outcome is unknown: Vultr may have created the instance, so nothing this run created was undone",
                "run the same command again: it finds the instance if there is one, and reuses the SSH key and the firewall group otherwise",
              ],
            });
          }
          const undone = await undo(made, report);
          if (ordering && error instanceof VultrError && refusesTheOffer(error)) {
            // The stock was read a moment ago and may have run out since:
            // the order is what decides, and its refusal still says what to
            // try instead.
            throw new ProviderError({
              error: "type-unavailable",
              message: `Vultr would not create ${request.type} at ${request.location} (${error.status}): ${error.said}`,
              details: [...suggestedPlans(offer.plans, request.location, offer.stock, request.type), "or try another --location", ...undone],
            });
          }
          throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone] });
        }
        instance = clean(answer.instance);
        created = true;
        resources.push({ kind: "instance", name: request.name, id: instance.id, reused: false });
        report(`   ordered, id ${instance.id}`);
      }
      report(`-> ${request.name} running`);
      let running = await waitReady(instance.id, request.name, report, created);
      if (!created) running = await ensureGuarded(running, report, resources);
      if (request.backups) running = await ensureBackups(running, created, report);
      return { machine: toMachine(running, await prices()), created, resources };
    },

    async list() {
      const instances = (await listAll<VultrInstance>("/instances", "instances", "read the instances")).map(clean).filter((instance) => isManagedTags(instance.tags));
      const known = instances.length === 0 ? null : await prices();
      return instances.map((instance) => toMachine(instance, known));
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      const removed: string[] = [];
      const kept: string[] = [];
      const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");

      report(`-> instance ${machine.name}`);
      // Read again rather than trusted: the tags decide, and they also name
      // the firewall group and the key that go with it.
      let current = await readInstance(machine.id, machine.name);
      if (!isManagedTags(current.tags)) {
        throw new ProviderError({
          error: "machine-not-managed",
          message: `the instance ${machine.name} lacks the tag ${MANAGED_LABEL}:${MANAGED_VALUE}`,
          details: ["sitesolide did not create it: nothing was destroyed"],
        });
      }
      const firewallId = current.firewall_group_id ?? "";
      const keyId = keyOfTags(current.tags);
      // What is attached to it outlives it, detached and still billed: read
      // while it is attached, said, and never deleted.
      const leftovers = await attachments(current.id, machine.name, report);

      // Vultr refuses to delete an instance it is still creating, as its
      // Ansible collection knows: the lock is waited out, bounded.
      const unlock = clock.now() + WAITS.unlockMs;
      while ((current.server_status === "none" || current.server_status === "locked") && current.status === "pending" && clock.now() < unlock) {
        report(`   ${statusOf(current)}: waiting for Vultr to finish creating it`);
        await clock.sleep(WAITS.pollMs);
        current = await readInstance(machine.id, machine.name);
      }
      await call("DELETE", `/instances/${encodeURIComponent(machine.id)}`, `delete the instance ${machine.name}`);
      removed.push(`instance ${machine.name}${addresses === "" ? "" : ` (${addresses})`}`);
      report("   deleted, with its disk");
      kept.push(...leftovers);
      if ((current.features ?? []).includes("auto_backups")) {
        // Vultr keeps the two latest for seven days, then purges them.
        kept.push("the instance's two latest Vultr backups: Vultr purges them seven days after the deletion; convert one to a snapshot in the console to keep it");
        report("   its two latest backups stay at Vultr for seven days, then are purged");
      }
      const gone = clock.now() + WAITS.goneMs;
      for (;;) {
        try {
          await readInstance(machine.id, machine.name);
        } catch (error) {
          if (error instanceof VultrError && error.status === 404) break;
          if (!(error instanceof ProviderError) || !TRANSIENT.has(error.failure.error)) throw error;
        }
        if (clock.now() >= gone) {
          report("!! Vultr still lists the instance: its firewall group may be kept for now");
          break;
        }
        await clock.sleep(WAITS.pollMs);
      }

      report(`-> firewall group for ${machine.name}`);
      const groups = await listAll<VultrFirewall>("/firewalls", "firewall_groups", "read the firewall groups");
      const ours = groups.filter((group) => ownsFirewall(group, machine.name));
      const attached = groups.find((group) => group.id === firewallId);
      if (attached !== undefined && !ownsFirewall(attached, machine.name)) {
        kept.push(`firewall group ${attached.id} (${attached.description || "no description"}): sitesolide did not create it`);
        report(`   ${attached.id}: kept, its description does not say sitesolide made it for ${machine.name}`);
      }
      if (ours.length === 0) report("   none created by sitesolide for that machine");
      for (const group of ours) {
        let count = group.instance_count;
        // Vultr may still count the deleted instance for a moment.
        for (let attempt = 1; count > 0 && attempt < WAITS.firewallTries; attempt++) {
          await clock.sleep(WAITS.pollMs);
          const read = await call<{ firewall_group: VultrFirewall }>("GET", `/firewalls/${encodeURIComponent(group.id)}`, `read the firewall group ${group.id}`);
          count = read.firewall_group.instance_count;
        }
        if (count > 0) {
          kept.push(`firewall group ${group.id}: still applied to ${count} instance${count === 1 ? "" : "s"}`);
          report(`   ${group.id}: kept, still applied to ${count} instance${count === 1 ? "" : "s"}`);
          continue;
        }
        await call("DELETE", `/firewalls/${encodeURIComponent(group.id)}`, `delete the firewall group ${group.id}`);
        removed.push(`firewall group ${group.id}`);
        report(`   ${group.id}: deleted, with its rules`);
      }

      report("-> SSH key");
      if (keyId === null) {
        report(`   none was uploaded for ${machine.name}: the key it used was already in the account`);
        return { removed, kept };
      }
      let sshKey: VultrKey;
      try {
        sshKey = (await call<{ ssh_key: VultrKey }>("GET", `/ssh-keys/${encodeURIComponent(keyId)}`, `read the SSH key ${keyId}`)).ssh_key;
      } catch (error) {
        if (!(error instanceof VultrError) || error.status !== 404) throw error;
        report(`   ${keyId}: no longer in the account`);
        return { removed, kept };
      }
      if (!isKeyNameFor(sshKey.name, machine.name, fingerprintOf(sshKey.ssh_key))) {
        // The tag names it, but it does not carry a name sitesolide gives,
        // whose suffix would be its own fingerprint's: renamed since, or
        // never sitesolide's, it is somebody's, and stays.
        kept.push(`SSH key ${sshKey.name}: not named as sitesolide names the keys it uploads, so never deleted by it`);
        report(`   ${sshKey.name}: kept, not named as sitesolide names the keys it uploads`);
      } else if (options.deleteKey) {
        await call("DELETE", `/ssh-keys/${encodeURIComponent(sshKey.id)}`, `delete the SSH key ${sshKey.name}`);
        removed.push(`SSH key ${sshKey.name}`);
        report(`   ${sshKey.name}: deleted`);
      } else {
        kept.push(`SSH key ${sshKey.name}: other machines may be created with it; --delete-key deletes it`);
        report(`   ${sshKey.name}: kept, other machines may be created with it`);
      }
      return { removed, kept };
    },

    async locations(): Promise<Choice[]> {
      const regions = await listAll<VultrRegion>("/regions", "regions", "read the regions");
      const first = (id: string) => (id === VULTR_DEFAULTS.location ? 0 : 1);
      return [...regions]
        .sort((a, b) => first(a.id) - first(b.id) || a.id.localeCompare(b.id))
        .map((region) => ({ value: region.id, label: [region.city, region.country].filter(Boolean).join(", ") || region.id, hint: region.id }));
    },

    async types(location): Promise<Choice[]> {
      const all = await plans();
      const stock = await inStock(location);
      const isDefault = (plan: VultrPlan) => Number(plan.id === VULTR_DEFAULTS.type);
      return all
        .filter((plan) => offered(plan) && plan.locations.includes(location) && stock.has(plan.id))
        .sort((a, b) => isDefault(b) - isDefault(a) || priceAt(a, location) - priceAt(b, location) || a.id.localeCompare(b.id))
        .slice(0, 12)
        .map((plan) => ({ value: plan.id, label: `${plan.id}  ${planLine(plan)}`, hint: formatPrice(priceAt(plan, location), CURRENCY) }));
    },
  };
}

// --- the credentials -------------------------------------------------------------------------

/**
 * Keys seen so far are 36 uppercase letters and digits; the shape leaves room
 * should Vultr lengthen them, and still refuses a value pasted with quotes,
 * spaces or a prefix.
 */
const KEY_SHAPE = /^[A-Za-z0-9]{32,64}$/;

/** `api-key: VALUE` at the top level of vultr-cli's YAML, quoted or not. */
export function apiKeyOfConfig(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^api-key\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").replace(/\s+#.*$/, "").trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    return value === "" ? null : value;
  }
  return null;
}

/**
 * The key vultr-cli is configured with: it reads `vultr-cli.yaml` in the
 * system's configuration folder (Go's os.UserConfigDir: $XDG_CONFIG_HOME or
 * ~/.config on Linux, ~/Library/Application Support on macOS), else
 * `~/.vultr-cli.yaml`. A value that is not a key is passed over, never shown.
 */
export async function discover(workstation: Workstation): Promise<Discovery | null> {
  const xdg = workstation.environment.XDG_CONFIG_HOME?.trim() ?? "";
  const paths = [
    ...(xdg.startsWith("/") ? [`${xdg.replace(/\/+$/, "")}/vultr-cli.yaml`] : []),
    "~/.config/vultr-cli.yaml",
    "~/Library/Application Support/vultr-cli.yaml",
    "~/.vultr-cli.yaml",
  ];
  for (const path of paths) {
    const text = workstation.readFile(path);
    if (text === null) continue;
    const value = apiKeyOfConfig(text);
    if (value !== null && KEY_SHAPE.test(value)) return { source: `vultr-cli's configuration, ${path}`, credentials: { [KEY_VARIABLE]: value } };
  }
  return null;
}

/** The key is read from VULTR_API_KEY, as vultr-cli and the Terraform provider read it, or from vultr-cli's configuration. */
export const VULTR: ProviderEntry = {
  name: "vultr",
  title: "Vultr",
  credentials: [{ variable: KEY_VARIABLE, label: "API key", secret: true, shape: KEY_SHAPE }],
  discover,
  credentialHelp: [
    "an account's own key reaches everything in the account: prefer a service user of the organization (Manage Organization, Users), with a policy allowing only the compute instance and SSH key actions and the network firewall actions, then Create API Key under its API Access",
    "restrict the key to this workstation's address in its access control list where the address is stable",
  ],
  docs: "docs/providers/vultr.md",
  defaults: () => VULTR_DEFAULTS,
  backups: true,
  apiVariable: API_VARIABLE,
  open: vultr,
};
