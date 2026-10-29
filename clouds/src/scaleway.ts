/**
 * Scaleway Instances, through the Instance API v1 and the three other APIs a
 * machine touches: IAM for the SSH key, the Marketplace for the image, Block
 * Storage for the boot volume. https://www.scaleway.com/en/developers/api/instance/
 * An Elastic Metal, a type named `EM-...`, is a physical server ordered
 * through its own API: scaleway-metal.ts says what sets it apart.
 *
 * A machine is six resources, each tagged `managed-by:<owner>` and
 * `<owner>-machine:<name>`, Scaleway's tags being plain strings, but the
 * key, which IAM cannot tag:
 *
 *   - the request's SSH key, in IAM, reused when the project already holds
 *     it under any name, uploaded as `<owner>-<name>` otherwise. Scaleway's
 *     images install every key of the project for root at each boot, which is
 *     how the key reaches the machine. A key this command uploads is named on
 *     the server's tag `<owner>-key:<id>`, the only thing that lets
 *     `--delete-key` delete it: a name alone could be another machine's. A
 *     request without a key registers none: its user-data carries the key;
 *   - a security group `<owner>-<name>`, stateful, inbound what the request
 *     opens and nothing else, outbound open;
 *   - a flexible IPv4 address and a flexible IPv6 prefix. A server's default
 *     address is dynamic and changes when the server is stopped; DNS records
 *     point at these, which stay the project's until they are deleted;
 *   - the server, which Scaleway creates stopped, then powers on. The
 *     user-data is set in between, so that the first boot reads it;
 *   - its boot volume, Block Storage or a local SSD, which deleting the server
 *     leaves behind: it is tagged right after the order, so that `destroy`
 *     knows it for the owner's.
 *
 * Everything that can refuse is read before the first write: servers of that
 * name in every zone (one the owner did not create is never touched), the
 * type against what the zone sells and has in stock, the disk against what
 * the type takes, the image against the Marketplace, the security group's
 * name. When the order itself is refused, what this run created for it is
 * deleted again, as hetzner.ts does. When its outcome is unknown, nothing is
 * undone: the server may exist, and Scaleway deletes a flexible IP even
 * attached to one.
 *
 * What a run leaves without a server, addresses reserved, a group, a volume
 * whose server went, stays tagged, and billed for the addresses and the
 * volume: `find` and `list` show it as an `incomplete` machine, in whichever
 * zone it is, `create` reuses what it can, and `destroy` removes the rest.
 *
 * Every call carries the secret key in the X-Auth-Token header and nowhere
 * else, follows no redirect, and fails with a ProviderError whose code is one
 * of FAILURE_CODES. The API's errors are `{"type", "message", ...}`, the
 * Instance API adding older shapes of its own; `failureFrom` reads both.
 *
 * Lists are paginated: `page` and `per_page` on the Instance API, which gives
 * the total in X-Total-Count, `page` and `page_size` on IAM, the Marketplace,
 * Block Storage and Elastic Metal, which give it as `total_count`. Each is
 * followed to the end. Servers and volumes are polled every five seconds, an
 * Elastic Metal every thirty, each wait bounded; the API allows about fifty
 * requests a second.
 */
import {
  apiAddress,
  checkRequest,
  DEBIAN,
  describeInbound,
  formatPrice,
  keyMaterial,
  labelsOfTags,
  MANAGED_LABEL,
  patiently,
  ProviderError,
  retryAfter,
  undoMade,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type DestroyOutcome,
  type Discovery,
  type Inbound,
  type Machine,
  type Owner,
  type Provider,
  type ProviderContext,
  type ProviderEntry,
  type PublicKey,
  type Report,
  type Resource,
  type Supports,
  type Workstation,
} from "./provider";
import type { Failure } from "./provider";
import {
  chooseOffer,
  chooseOs,
  describeOffer,
  hourlyPrice,
  installKeyName,
  isMetal,
  metalMachine,
  metalStatus,
  METAL_ZONES,
  throwawayKey,
  type MetalOffer,
  type MetalOs,
  type MetalServer,
} from "./scaleway-metal";

export const DEFAULT_API = "https://api.scaleway.com";

/** The API's address, for tests against a local fake: it stands for every Scaleway API this file calls. */
export const API_VARIABLE = "SITESOLIDE_SCALEWAY_API";

/** The variables Scaleway's own tools read, the CLI and the Terraform provider among them. */
export const SECRET_VARIABLE = "SCW_SECRET_KEY";
export const PROJECT_VARIABLE = "SCW_DEFAULT_PROJECT_ID";

/** A secret key and a project ID are both UUIDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where Instances are sold: the zones of the Instance API's own table. The
 * API lists no zones, so a zone it opens is added here; until then
 * `--location` refuses it before anything is asked.
 */
export const ZONES = [
  { zone: "fr-par-1", city: "Paris 1", country: "FR" },
  { zone: "fr-par-2", city: "Paris 2", country: "FR" },
  { zone: "fr-par-3", city: "Paris 3", country: "FR" },
  { zone: "nl-ams-1", city: "Amsterdam 1", country: "NL" },
  { zone: "nl-ams-2", city: "Amsterdam 2", country: "NL" },
  { zone: "nl-ams-3", city: "Amsterdam 3", country: "NL" },
  { zone: "pl-waw-1", city: "Warsaw 1", country: "PL" },
  { zone: "pl-waw-2", city: "Warsaw 2", country: "PL" },
  { zone: "pl-waw-3", city: "Warsaw 3", country: "PL" },
] as const;

/**
 * DEV1-S at fr-par-1: in October 2026, the cheapest x86 type with 2 GB of
 * memory Scaleway sells, 2 vCPU, not at its end of service, in stock in Paris.
 * PLAY2-PICO, the next one, costs more for one vCPU. Paris is the first zone
 * that sells it, and France one of the countries sitesolide's defaults keep to.
 */
export const DEFAULT_TYPE = "DEV1-S";
export const DEFAULT_ZONE = "fr-par-1";

/** What `find` and `list` say of a machine whose server is gone, or was never made, while resources made for it remain. */
export const INCOMPLETE = "incomplete";

/** Debian 13 on Scaleway's Marketplace: "Debian 13 (Trixie)". */
export const DEBIAN_LABEL = "debian_trixie";

/**
 * The boot volume when the request names no disk, in bytes: 40 GB of Block
 * Storage, the disk of the Hetzner machine sitesolide runs on, which leaves
 * room for the restic repository of its backups. The image alone would give
 * 10 GB. The volume can be enlarged from the console later, never shrunk.
 */
export const BOOT_VOLUME_BYTES = 40_000_000_000;

/**
 * The volume types a request's disk may name: Block Storage, billed on its
 * own, and a local SSD, included in the type's hourly price, which only the
 * types whose `volumes_constraint` allows it take.
 */
export const DISK_TYPES = ["sbs_volume", "l_ssd"] as const;

/**
 * The key of the user-data cloud-init reads. Under any other key the data is
 * delivered as an ordinary metadata entry that nothing reads, and the machine
 * boots, answers on SSH, and was never provisioned, which says nothing of it.
 */
export const USER_DATA_KEY = "cloud-init";

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  runningMs: 10 * 60_000,
  stoppedMs: 10 * 60_000,
  volumeMs: 5 * 60_000,
  pollMs: 5_000,
  /** A security group still counted in use a moment after its server went. */
  groupTries: 5,
  /** An Elastic Metal's delivery and install take 15 to 40 minutes. */
  installMs: 90 * 60_000,
  metalDeletedMs: 30 * 60_000,
  metalPollMs: 30_000,
};

const TITLE = "Scaleway";
const METAL_TITLE = "Scaleway Elastic Metal";

export const SUPPORTS: Supports = { keyless: true, inbound: true, userData: true, disk: true };

/**
 * An Elastic Metal's disks come with its offer, and its firewall is the
 * host's, written by the user-data. A physical server has /dev/kvm without
 * nesting anything.
 */
export const METAL_SUPPORTS: Supports = { keyless: true, inbound: true, userData: true, nestedVirtualization: true };

/** Items a page: the most every list of these APIs returns. */
const PAGE = 100;
const MAX_PAGES = 500;

/** Scaleway's monthly prices are its hourly ones times 730 hours. */
const HOURS_A_MONTH = 730;

/** What `sitesolide setup` needs at least, in bytes, as Scaleway gives a type's memory. */
const MIN_MEMORY = 2 * 1024 ** 3;

/** The wizard's list stops there. */
const WIZARD_TYPES = 12;

/**
 * The rules of the security group, inbound, network by network, each rule
 * of the request once per network it names; everything else inbound is
 * dropped by the group's default policy.
 */
export function securityGroupRules(inbound: readonly Inbound[]) {
  const networks = [...new Set(inbound.flatMap((rule) => rule.sources))];
  return networks
    .flatMap((ip_range) => inbound.filter((rule) => rule.sources.includes(ip_range)).map((rule) => ({ ip_range, rule })))
    .map(({ ip_range, rule }, index) => ({
      action: "accept",
      protocol: rule.protocol.toUpperCase(),
      direction: "inbound",
      ip_range,
      dest_port_from: rule.port ?? null,
      dest_port_to: null,
      position: index + 1,
      editable: true,
    }));
}

// --- the API's objects, as far as this file reads them ---------------------------------

export type ScalewayServerIp = { id: string; address: string; family: string; netmask: string; dynamic: boolean; state?: string };

export type ScalewayVolumeOfServer = { id: string; volume_type: string; name?: string | null; size?: number | null; zone?: string };

export type ScalewayServer = {
  id: string;
  name: string;
  project?: string;
  commercial_type: string;
  zone: string;
  state: string;
  state_detail?: string;
  tags: string[];
  public_ips?: ScalewayServerIp[] | null;
  /** Before `public_ips`, the API gave one address here. */
  public_ip?: ScalewayServerIp | null;
  volumes?: Record<string, ScalewayVolumeOfServer>;
  security_group?: { id: string; name: string } | null;
  allowed_actions?: string[];
  creation_date?: string | null;
  modification_date?: string | null;
};

export type ScalewayServerType = {
  ncpus: number;
  /** In bytes. */
  ram: number;
  arch: string;
  hourly_price: number;
  /** Deprecated by the API, still given: the hourly price times 730. */
  monthly_price?: number | null;
  end_of_service: boolean;
  gpu?: number | null;
  /** In bytes, the local SSD the type takes in all: a maximum of 0 is a type with Block Storage alone. */
  volumes_constraint?: { min_size: number; max_size: number } | null;
  per_volume_constraint?: { l_ssd?: { min_size: number; max_size: number } | null } | null;
  capabilities?: { block_storage?: boolean } | null;
};

export type Availability = "available" | "scarce" | "shortage";

export type ScalewayIp = {
  id: string;
  /** Null for an IPv6 prefix, whose machine takes an address of its own in it. */
  address: string | null;
  prefix: string | null;
  type: string;
  state: string;
  tags: string[];
  server: { id: string; name: string } | null;
};

export type ScalewaySecurityGroup = { id: string; name: string; tags: string[]; servers?: { id: string; name: string }[] };

type ScalewayKey = { id: string; name: string; public_key: string; project_id: string; disabled?: boolean };
type LocalImage = { id: string; arch: string; zone: string; compatible_commercial_types: string[]; label: string; type: string };
export type BlockVolume = { id: string; name: string; size: number; status: string; tags: string[] };
/** A volume of the Instance API, a local SSD here: `state` is `available` once nothing is being done to it. */
export type LocalVolume = { id: string; name: string; size: number; volume_type: string; state: string; tags: string[]; server: { id: string; name: string } | null };

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and its own error type kept for the callers that tell them apart. */
export class ScalewayError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly type: string,
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/** The particulars an error carries, one line each, in each of the shapes the APIs use. */
function errorDetails(body: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (Array.isArray(body.details)) {
    for (const entry of body.details as Record<string, unknown>[]) {
      if (typeof entry?.argument_name === "string") {
        const help = typeof entry.help_message === "string" && entry.help_message !== "" ? `, ${entry.help_message}` : "";
        lines.push(`${entry.argument_name}: ${String(entry.reason ?? "invalid")}${help}`);
      } else if (typeof entry?.quota === "number") {
        lines.push(`${String(entry.resource ?? "resource")}: ${String(entry.current ?? "?")} used of ${entry.quota}`);
      } else if (typeof entry?.action === "string") {
        lines.push(`${String(entry.resource ?? "resource")}: ${entry.action} not allowed`);
      }
    }
  }
  // The Instance API's older errors name the refused fields in a map.
  if (body.fields !== null && typeof body.fields === "object" && !Array.isArray(body.fields)) {
    for (const [field, messages] of Object.entries(body.fields as Record<string, unknown>)) {
      lines.push(`${field}: ${Array.isArray(messages) ? messages.map(String).join(", ") : String(messages)}`);
    }
  }
  if (typeof body.help_message === "string" && body.help_message !== "") lines.push(body.help_message);
  return lines;
}

/**
 * An error answer as a failure the CLI reports, with the code its hint is
 * found by. The error's type decides before the status: `out_of_stock` and
 * `quotas_exceeded` arrive with statuses that say less. `what` says what was
 * being done, in the infinitive: `create the server web`.
 */
export function failureFrom(status: number, parsed: unknown, headers: Headers, what: string): ScalewayError {
  const body = (parsed !== null && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const type = typeof body.type === "string" ? body.type : "";
  const said = typeof body.message === "string" && body.message !== "" ? body.message : `answered ${status}`;
  const details = errorDetails(body);
  const answer = `${status}${type === "" ? "" : ` ${type}`}`;
  const make = (failure: Failure) => new ScalewayError(failure, status, type, said);

  if (status === 401 || type === "denied_authentication") {
    return make({
      error: "provider-unauthenticated",
      message: `Scaleway refused the secret key (${answer}): it is unknown, revoked, expired, or was copied wrong`,
      details: ["an API key is made in the console under IAM, API keys; its secret key is shown once, when it is generated"],
    });
  }
  if (type === "quotas_exceeded" || /quota exceeded/i.test(said)) {
    return make({ error: "provider-limit", message: `Scaleway refused to ${what} (${answer}): ${said}`, details: [...details, "the project has reached one of its quotas, listed in the console under Organization, Quotas"] });
  }
  if (type === "locked") {
    return make({ error: "provider-invalid", message: `Scaleway refused to ${what} (${answer}): ${said}`, details: [...details, "Scaleway locked the resource: its console says why, often a billing or an abuse matter"] });
  }
  if (type === "permissions_denied" || status === 403) {
    return make({
      error: "provider-forbidden",
      message: `the API key may not ${what} (${answer}): ${said}`,
      details: [...details, "the key's policy needs InstancesFullAccess, BlockStorageFullAccess and SSHKeysFullAccess on the project"],
    });
  }
  if (type === "out_of_stock") return make({ error: "provider-unavailable", message: `Scaleway could not ${what} (${answer}): ${said}`, details });
  if (type === "not_found" || type === "unknown_resource" || status === 404) return make({ error: "provider-not-found", message: `Scaleway could not ${what} (${answer}): ${said}`, details });
  if (type === "transient_state" || type === "conflict" || status === 409 || status === 423) {
    return make({ error: "provider-busy", message: `Scaleway could not ${what} right now (${answer}): ${said}`, details });
  }
  if (status === 429) {
    const reset = Number(headers.get("X-RateLimit-Reset"));
    // Scaleway writes it `50, 50;w=1`: the number, then a policy.
    const limit = /^\s*(\d+)/.exec(headers.get("X-RateLimit-Limit") ?? "")?.[1] ?? "about 50";
    return make({
      error: "provider-rate-limited",
      message: `Scaleway's rate limit is reached, nothing more can be asked of it for now (${answer})`,
      details: [`the limit is ${limit} requests a second`],
      wait: retryAfter(headers, Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : 60),
    });
  }
  if (status >= 500) return make({ error: "provider-failure", message: `Scaleway failed to ${what} (${answer}): ${said}`, details: [...details, "the failure is on Scaleway's side"] });
  return make({ error: "provider-invalid", message: `Scaleway refused to ${what} (${answer}): ${said}`, details });
}

/**
 * Whether a refused order says the type cannot be had there right now rather
 * than that the request was wrong: no stock, or an invalid argument naming
 * the type, which was checked against the catalogue just before.
 */
export function refusesTheOffer(error: ScalewayError): boolean {
  if (error.type === "out_of_stock") return true;
  if (error.type !== "invalid_arguments" && error.type !== "invalid_request_error") return false;
  return (error.failure.details ?? []).some((line) => /^commercial_type\b/.test(line));
}

// --- what the answers mean -------------------------------------------------------------------

/** A zone machines are ordered in, or the refusal that lists them; checked before a zone goes into a path. */
export function zoneOf(location: string): string {
  const known = ZONES.find((entry) => entry.zone === location);
  if (known !== undefined) return known.zone;
  throw new ProviderError({
    error: "invalid-location",
    message: `${location} is not a Scaleway zone machines are ordered in here`,
    details: ["the zones:", ...ZONES.map((entry) => `${entry.zone.padEnd(9)} ${entry.city}, ${entry.country}`)],
  });
}

/** `2001:bc8:710:7074:dc00:ff:fed1:458b` with netmask 64 -> `2001:bc8:710:7074::/64`; null for anything else. */
export function networkOf(address: string, netmask: string): string | null {
  if (String(netmask) !== "64" || !address.includes(":")) return null;
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** What a type costs a month, in euros before VAT. */
export function monthlyPrice(type: ScalewayServerType): number {
  return typeof type.monthly_price === "number" && type.monthly_price > 0 ? type.monthly_price : type.hourly_price * HOURS_A_MONTH;
}

/** One product of Scaleway's public catalogue, as much of it as a price needs. */
export type CatalogProduct = {
  sku?: string;
  product?: string;
  status?: string;
  unit_of_measure?: { unit?: string };
  price?: { retail_price?: { units?: number | string; nanos?: number | string } };
};

/**
 * {type: EUR an hour}, from the catalogue's products: what is sold now, by
 * the hour, as an instance.
 */
export function catalogPrices(products: readonly CatalogProduct[]): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const product of products) {
    if (product.status !== "general_availability" || product.unit_of_measure?.unit !== "hour" || !product.sku?.startsWith("/instance/server/") || product.product === undefined) continue;
    const price = Number(product.price?.retail_price?.units ?? 0) + Number(product.price?.retail_price?.nanos ?? 0) / 1e9;
    if (Number.isFinite(price) && price > 0) prices[product.product] = price;
  }
  return prices;
}

/** `2 vCPU, 2 GB RAM, x86_64`: Scaleway gives memory in bytes, in GiB steps. */
export function describeType(type: ScalewayServerType): string {
  const memory = type.ram / 1024 ** 3;
  return `${type.ncpus} vCPU, ${Number.isInteger(memory) ? memory : memory.toFixed(1)} GB RAM, ${type.arch}`;
}

/** The addresses of a server, the flexible ones first; dynamic ones change on every start. */
function addressesOf(server: ScalewayServer): ScalewayServerIp[] {
  const all = server.public_ips ?? (server.public_ip === null || server.public_ip === undefined ? [] : [server.public_ip]);
  return [...all].sort((a, b) => Number(a.dynamic) - Number(b.dynamic));
}

export function toMachine(server: ScalewayServer, type: ScalewayServerType | undefined, owner: Owner): Machine {
  const ips = addressesOf(server);
  const v4 = ips.find((ip) => ip.family === "inet");
  const v6 = ips.find((ip) => ip.family === "inet6");
  const price = type === undefined ? null : monthlyPrice(type).toFixed(4);
  return {
    provider: "scaleway",
    id: server.id,
    name: server.name,
    type: server.commercial_type,
    location: server.zone,
    status: server.state,
    ipv4: v4?.address ?? null,
    // The address the machine takes in its /64 by SLAAC, which the API computes from its MAC.
    ipv6: v6?.address ?? null,
    ipv6Network: v6 === undefined ? null : networkOf(v6.address, v6.netmask),
    // Scaleway gives its prices before VAT only, which depends on the customer: gross repeats net.
    monthlyPrice: price === null ? null : { net: price, gross: price, currency: "EUR" },
    backups: false,
    managed: owner.managesTags(server.tags),
    labels: labelsOfTags(server.tags),
    // Scaleway's Linux images let root in with the project's keys.
    login: "root",
  };
}

/** What remains of a machine without its server, by zone: what `destroy` removes, and what makes it a machine still. */
export type Leftovers = {
  ips: (ScalewayIp & { zone: string })[];
  groups: (ScalewaySecurityGroup & { zone: string })[];
  volumes: (BlockVolume & { zone: string })[];
  local: (LocalVolume & { zone: string })[];
};

export function hasLeftovers(left: Leftovers): boolean {
  return left.ips.length + left.groups.length + left.volumes.length + left.local.length > 0;
}

/**
 * A machine without its server, as `find` and `list` show it: managed, so
 * that `destroy` takes it and removes what is left, which is billed for the
 * addresses and the volume; the wizard orders a new server, and `create`
 * reuses what it can.
 */
export function incompleteMachine(name: string, left: Leftovers, owner: Owner): Machine {
  const ipv4 = left.ips.find((ip) => ip.type === "routed_ipv4" && ip.address !== null);
  const ipv6 = left.ips.find((ip) => ip.type === "routed_ipv6");
  const zone = ipv4?.zone ?? left.ips[0]?.zone ?? left.volumes[0]?.zone ?? left.local[0]?.zone ?? left.groups[0]?.zone ?? DEFAULT_ZONE;
  return {
    provider: "scaleway",
    id: "",
    name,
    type: "none",
    location: zone,
    status: INCOMPLETE,
    ipv4: ipv4?.address ?? null,
    ipv6: null,
    ipv6Network: ipv6?.prefix ?? null,
    monthlyPrice: null,
    backups: false,
    managed: true,
    labels: labelsOfTags(owner.tags(name)),
    login: "root",
  };
}

/**
 * Whether a stopped server was never started: Scaleway creates servers
 * stopped, and a run interrupted between the order and the power-on leaves
 * one so. A start changes the modification date; a server untouched since
 * its creation, by anyone, has none later than its creation. One powered off
 * by its owner has, and is left as it is.
 */
export function neverStarted(server: ScalewayServer): boolean {
  if (server.state !== "stopped" || !(server.allowed_actions ?? ["poweron"]).includes("poweron")) return false;
  const created = Date.parse(server.creation_date ?? "");
  const modified = Date.parse(server.modification_date ?? "");
  return Number.isFinite(created) && Number.isFinite(modified) && modified <= created;
}

/** Whether a type belongs in a list a person picks from: sold, a general-purpose machine, enough memory. */
function offered(name: string, type: ScalewayServerType, availability: Availability | undefined): boolean {
  return !type.end_of_service && !((type.gpu ?? 0) > 0) && !name.endsWith("-WIN") && type.ram >= MIN_MEMORY && availability !== "shortage";
}

/** The cheapest types a zone sells and has in stock, one line each, cheapest first. */
export function cheapestTypes(types: Record<string, ScalewayServerType>, availability: Record<string, Availability>, except?: string, count = 6): string[] {
  return Object.entries(types)
    .filter(([name, type]) => name !== except && offered(name, type, availability[name]))
    .sort(([nameA, a], [nameB, b]) => monthlyPrice(a) - monthlyPrice(b) || nameA.localeCompare(nameB))
    .slice(0, count)
    .map(([name, type]) => `${name.padEnd(14)} ${describeType(type)}, ${formatPrice(monthlyPrice(type), "EUR")}${availability[name] === "scarce" ? ", scarce" : ""}`);
}

/** The types to suggest instead, for a refusal. */
function suggestedTypes(types: Record<string, ScalewayServerType>, availability: Record<string, Availability>, zone: string, except?: string): string[] {
  const lines = cheapestTypes(types, availability, except);
  return lines.length === 0 ? [`Scaleway has no other type in stock at ${zone}`] : [`the cheapest types Scaleway has in stock at ${zone}:`, ...lines];
}

/** The first eight hex digits of a key's MD5, colon-less: what `create` adds to the key's name when the plain one is taken. */
export function fingerprintPrefix(publicKey: string): string | null {
  const blob = publicKey.trim().split(/\s+/)[1];
  if (blob === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  return new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").slice(0, 8);
}

/** The name a key gets: the plain one, or, when the project already uses it, the plain one and the key's own fingerprint. */
function keyName(plain: string, line: string, taken: ReadonlySet<string>): string {
  return taken.has(plain) ? `${plain}-${fingerprintPrefix(line) ?? "key"}` : plain;
}

function bearsName(key: { name: string; public_key: string }, plain: string): boolean {
  if (key.name === plain) return true;
  const prefix = fingerprintPrefix(key.public_key);
  return prefix !== null && key.name === `${plain}-${prefix}`;
}

/**
 * Whether a key bears a name `create` gives the key it uploads for that
 * machine: `<owner>-<name>`, or `<owner>-<name>-<its own fingerprint's
 * first eight digits>`. Never enough alone: `sitesolide-web-20261021` is
 * also the plain name of machine `web-20261021`'s key, which is why
 * `destroy` deletes only the key the server's `<owner>-key` tag names.
 */
export function isKeyFor(key: { name: string; public_key: string }, machine: string, owner: Owner): boolean {
  return bearsName(key, `${owner.name}-${machine}`);
}

/** The same for the throwaway key an Elastic Metal is installed with, `<owner>-<name>-install`. */
export function isInstallKeyFor(key: { name: string; public_key: string }, machine: string, owner: Owner): boolean {
  return bearsName(key, installKeyName(owner, machine));
}

/**
 * The server's tag naming the IAM key `create` uploaded for it, `<owner>-key`:
 * IAM keys carry no tags, and their names are not proof enough of whose they are.
 */
export function keyTag(owner: Owner): string {
  return `${owner.name}-key`;
}

/** The SSH key a server's tags say `create` uploaded for it, or null. */
export function keyOfTags(tags: readonly string[] | undefined | null, owner: Owner): string | null {
  const prefix = `${keyTag(owner)}:`;
  return (tags ?? []).find((tag) => tag.startsWith(prefix))?.slice(prefix.length) || null;
}

export function groupName(machine: string, owner: Owner): string {
  return `${owner.name}-${machine}`;
}

function tagged(tags: readonly string[] | undefined | null, machine: string, owner: Owner): boolean {
  return owner.managesTags(tags) && owner.machineOfTags(tags) === machine;
}

/** The volume an order boots from. */
export type BootVolume = { volume_type: (typeof DISK_TYPES)[number]; size: number };

/**
 * The boot volume a request asks for, 40 GB of Block Storage when it names
 * no disk; a disk no volume type here gives is refused before anything leaves.
 */
export function bootVolumeOf(request: CreateRequest): BootVolume {
  if (request.disk === undefined) return { volume_type: "sbs_volume", size: BOOT_VOLUME_BYTES };
  const refuse = (what: string): never => {
    throw new ProviderError({ error: "provider-unsupported", message: `${TITLE} cannot be asked ${what} here`, details: ["a disk is sbs_volume, Block Storage, the default, or l_ssd, a local SSD", "nothing was created"] });
  };
  const type = request.disk.type ?? "sbs_volume";
  const known = DISK_TYPES.find((candidate) => candidate === type);
  if (known === undefined) return refuse(`a disk of type ${type}`);
  if (!Number.isInteger(request.disk.gb) || request.disk.gb < 1) return refuse(`a disk of ${request.disk.gb} GB`);
  // Scaleway counts storage in GB of 10^9 bytes, as its catalogue's constraints do.
  return { volume_type: known, size: request.disk.gb * 1e9 };
}

/**
 * Refuses a disk the type does not take, as the catalogue says it: a local
 * SSD within `volumes_constraint`, whose maximum is 0 on the types that take
 * Block Storage alone, or Block Storage where the type has the capability.
 */
function checkDisk(volume: BootVolume, name: string, type: ScalewayServerType, zone: string): void {
  const refuse = (message: string): never => {
    throw new ProviderError({ error: "invalid-server-type", message, details: ["pick another --type, or a disk this one takes", "nothing had been created yet"] });
  };
  if (volume.volume_type === "l_ssd") {
    const { min_size = 0, max_size = 0 } = type.volumes_constraint ?? {};
    if (max_size === 0) refuse(`${name} takes no local SSD at ${zone}: its storage is Block Storage alone, sbs_volume`);
    if (volume.size < min_size || volume.size > max_size) {
      refuse(`${name} takes a local SSD of ${gigabytes(min_size)} to ${gigabytes(max_size)}: ${gigabytes(volume.size)} was asked`);
    }
  } else if (type.capabilities?.block_storage === false) {
    refuse(`${name} takes no Block Storage: its disk is a local SSD, l_ssd`);
  }
}

function gigabytes(bytes: number | null | undefined): string {
  return typeof bytes === "number" ? `${Math.round(bytes / 1e9)} GB` : "unknown size";
}

// --- the provider ---------------------------------------------------------------------------

export function scaleway(context: ProviderContext): Provider {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const host = new URL(base).host;
  const { clock, fetcher, owner } = context;
  const secret = context.credentials[SECRET_VARIABLE] ?? "";
  const project = context.credentials[PROJECT_VARIABLE] ?? "";
  if (!UUID.test(secret) || !UUID.test(project)) {
    throw new ProviderError({
      error: "no-provider-token",
      message: `Scaleway needs ${SECRET_VARIABLE} and ${PROJECT_VARIABLE}, each a UUID`,
      details: SCALEWAY_HELP,
    });
  }

  const instance = (zone: string) => `/instance/v1/zones/${zone}`;
  const block = (zone: string) => `/block/v1alpha1/zones/${zone}`;
  const baremetal = (zone: string) => `/baremetal/v1/zones/${zone}`;

  /**
   * One call: the secret key in its header, JSON both ways, every failure
   * said in the program's words. `text` sends the body as it is, as
   * text/plain, the one form the Instance API takes a user-data in.
   */
  async function request<T>(method: string, path: string, what: string, body?: unknown, text = false): Promise<{ body: T; headers: Headers }> {
    let response: Response;
    const content: Record<string, string> = body === undefined ? {} : { "Content-Type": text ? "text/plain" : "application/json" };
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "error",
        headers: { "X-Auth-Token": secret, ...content },
        ...(body === undefined ? {} : { body: text ? String(body) : JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by the program that prints it.
      throw new ScalewayError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, "");
    }
    const answer = await response.text().catch(() => "");
    let parsed: unknown = {};
    let readable = true;
    if (answer.trim() !== "") {
      try {
        parsed = JSON.parse(answer);
      } catch {
        readable = false;
      }
    }
    // A proxy in front of the API may answer a 502 or a 429 in HTML: still
    // Scaleway saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new ScalewayError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Scaleway's API, while trying to ${what}` }, response.status, "");
    }
    if (!response.ok) throw failureFrom(response.status, readable ? parsed : null, response.headers, what);
    return { body: parsed as T, headers: response.headers };
  }

  async function call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    return (await request<T>(method, path, what, body)).body;
  }

  function unreadable(key: string, what: string): ScalewayError {
    return new ScalewayError({ error: "provider-unreadable", message: `${host} answered without the list of ${key}, while trying to ${what}` }, 200, "");
  }

  /**
   * Every page of a list. The Instance API takes `per_page` and says the
   * total in X-Total-Count; the other APIs take `page_size` and say it as
   * `total_count`. Without a total, a short page is the last.
   */
  async function listAll<T>(path: string, key: string, what: string, query: Record<string, string> = {}, size: "per_page" | "page_size" = "per_page"): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const parameters = new URLSearchParams({ ...query, page: String(page), [size]: String(PAGE) });
      const answer = await request<Record<string, unknown>>("GET", `${path}?${parameters}`, what);
      const list = answer.body[key];
      if (!Array.isArray(list)) throw unreadable(key, what);
      items.push(...(list as T[]));
      const header = answer.headers.get("X-Total-Count");
      const total = header !== null ? Number(header) : typeof answer.body.total_count === "number" ? answer.body.total_count : Number.NaN;
      if (list.length === 0 || (Number.isFinite(total) ? items.length >= total : list.length < PAGE)) break;
    }
    return items;
  }

  /** Every page of a catalogue the API gives as a map, by type name. */
  async function mapAll<T>(path: string, what: string): Promise<Record<string, T>> {
    const items: Record<string, T> = {};
    for (let page = 1; page <= MAX_PAGES; page++) {
      const answer = await request<{ servers?: unknown }>("GET", `${path}?${new URLSearchParams({ page: String(page), per_page: String(PAGE) })}`, what);
      const map = answer.body.servers;
      if (map === null || typeof map !== "object" || Array.isArray(map)) throw unreadable("servers", what);
      const entries = Object.entries(map as Record<string, T>);
      for (const [name, value] of entries) items[name] = value;
      const total = Number(answer.headers.get("X-Total-Count") ?? Number.NaN);
      if (entries.length === 0 || (Number.isFinite(total) ? Object.keys(items).length >= total : entries.length < PAGE)) break;
    }
    return items;
  }

  /**
   * By 29/10 products/servers answered hourly_price 0 for every type: the
   * prices are in the public Product Catalog now, which takes no key. A
   * catalogue that cannot be read leaves the type as the Instance API gave it.
   */
  async function pricedTypes(zone: string): Promise<Record<string, ScalewayServerType>> {
    const [types, prices] = await Promise.all([
      mapAll<ScalewayServerType>(`${instance(zone)}/products/servers`, `read the types sold at ${zone}`),
      listAll<CatalogProduct>("/product-catalog/v2alpha1/public-catalog/products", "products", `read the prices at ${zone}`, { product_types: "instance", zone }, "page_size")
        .then(catalogPrices)
        .catch((): Record<string, number> => ({})),
    ]);
    for (const [name, type] of Object.entries(types)) {
      const price = prices[name];
      if (!(type.hourly_price > 0) && price !== undefined) types[name] = { ...type, hourly_price: price, monthly_price: null };
    }
    return types;
  }

  const catalogues = new Map<string, Promise<Record<string, ScalewayServerType>>>();
  function typesIn(zone: string): Promise<Record<string, ScalewayServerType>> {
    let read = catalogues.get(zone);
    if (read === undefined) {
      read = pricedTypes(zone);
      // A failed read is not kept: the next one asks again.
      read.catch(() => catalogues.delete(zone));
      catalogues.set(zone, read);
    }
    return read;
  }

  async function availabilityIn(zone: string): Promise<Record<string, Availability>> {
    const map = await mapAll<{ availability?: Availability }>(`${instance(zone)}/products/servers/availability`, `read the stock at ${zone}`);
    return Object.fromEntries(Object.entries(map).map(([name, entry]) => [name, entry.availability ?? "available"]));
  }

  /** A zone's catalogue for prices and suggestions, where one that cannot be read stops nothing. */
  function typesOrNone(zone: string): Promise<Record<string, ScalewayServerType>> {
    return typesIn(zone).catch((): Record<string, ScalewayServerType> => ({}));
  }

  function availabilityOrNone(zone: string): Promise<Record<string, Availability>> {
    return availabilityIn(zone).catch((): Record<string, Availability> => ({}));
  }

  /** The type of a machine, for its price. */
  async function typeOf(server: ScalewayServer): Promise<ScalewayServerType | undefined> {
    if (!ZONES.some((entry) => entry.zone === server.zone)) return undefined;
    return (await typesOrNone(server.zone))[server.commercial_type];
  }

  /** The servers of that name in the project, in every zone: Scaleway does not keep names unique. */
  async function findServers(name: string): Promise<ScalewayServer[]> {
    const found: ScalewayServer[] = [];
    for (const { zone } of ZONES) {
      // `name` matches as a prefix would: "web" also finds "web2".
      const servers = await listAll<ScalewayServer>(`${instance(zone)}/servers`, "servers", `read the servers at ${zone}`, { project, name });
      found.push(...servers.filter((server) => server.name === name).map((server) => ({ ...server, zone: server.zone ?? zone })));
    }
    return found;
  }

  async function readServer(zone: string, id: string, name: string): Promise<ScalewayServer> {
    return (await call<{ server: ScalewayServer }>("GET", `${instance(zone)}/servers/${encodeURIComponent(id)}`, `read the server ${name}`)).server;
  }

  /**
   * Until the server runs. `poweredOn` says this run asked it to start: until
   * the server is seen starting, a stopped state is the request not taken in
   * yet; after, it is a start that failed. Without it, a stopped server is
   * one its owner stopped, which this provider never starts by itself.
   */
  async function waitRunning(zone: string, id: string, name: string, report: Report, poweredOn: boolean): Promise<ScalewayServer> {
    const deadline = clock.now() + WAITS.runningMs;
    const warned = { done: false };
    let last = "";
    let seenStarting = false;
    for (;;) {
      const server = await patiently(clock, () => readServer(zone, id, name), deadline, report, warned);
      if (server !== null) {
        const state = `${server.state}${server.state_detail ? ` (${server.state_detail})` : ""}`;
        if (state !== last) report(`   state: ${state}`);
        last = state;
        if (server.state === "running") return server;
        if (server.state === "starting") seenStarting = true;
        if (server.state === "locked") {
          throw new ProviderError({ error: "action-failed", message: `Scaleway locked ${name}: ${server.state_detail || "no reason given"}`, details: ["the console says why, often a billing or an abuse matter"] });
        }
        if (server.state === "stopped" || server.state === "stopped in place") {
          if (!poweredOn) {
            throw new ProviderError({ error: "machine-off", message: `${name} exists but is powered off`, details: [`${owner.name} never powers a machine on or off by itself`] });
          }
          if (seenStarting) {
            throw new ProviderError({ error: "action-failed", message: `Scaleway could not start ${name}: ${server.state_detail || "no reason given"}`, details: [`${name} is stopped at ${zone}; the same command tries again`] });
          }
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last state: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** Until the server is stopped, powering it off once Scaleway allows it. */
  async function stopServer(server: ScalewayServer, report: Report): Promise<ScalewayServer> {
    const deadline = clock.now() + WAITS.stoppedMs;
    const warned = { done: false };
    let current = server;
    let asked = false;
    let last = "";
    for (;;) {
      const state = `${current.state}${current.state_detail ? ` (${current.state_detail})` : ""}`;
      if (state !== last) report(`   state: ${state}`);
      last = state;
      if (current.state === "stopped") return current;
      if (!asked && (current.allowed_actions ?? []).includes("poweroff")) {
        await call("POST", `${instance(current.zone)}/servers/${encodeURIComponent(current.id)}/action`, `power off the server ${current.name}`, { action: "poweroff" });
        asked = true;
        report("   powering off");
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${current.name} is still not stopped after ${WAITS.stoppedMs / 60_000} minutes`, details: [`last state: ${last}`, "nothing was deleted yet"] });
      }
      await clock.sleep(WAITS.pollMs);
      const read = await patiently(clock, () => readServer(current.zone, current.id, current.name), deadline, report, warned);
      if (read !== null) current = { ...read, zone: read.zone ?? current.zone };
    }
  }

  /** The volume once Scaleway is done with it: created, or detached from a deleted server. */
  async function settledVolume(zone: string, id: string, settled: (volume: BlockVolume) => boolean, report: Report): Promise<BlockVolume | null> {
    const deadline = clock.now() + WAITS.volumeMs;
    const warned = { done: false };
    for (;;) {
      const volume = await patiently(clock, () => call<BlockVolume>("GET", `${block(zone)}/volumes/${encodeURIComponent(id)}`, `read the volume ${id}`), deadline, report, warned);
      if (volume !== null && settled(volume)) return volume;
      if (clock.now() >= deadline) return null;
      await clock.sleep(WAITS.pollMs);
    }
  }

  async function readLocalVolume(zone: string, id: string): Promise<LocalVolume> {
    return (await call<{ volume: LocalVolume }>("GET", `${instance(zone)}/volumes/${encodeURIComponent(id)}`, `read the volume ${id}`)).volume;
  }

  /** A local SSD once no server holds it and Scaleway is done saving it. */
  async function freeLocalVolume(zone: string, id: string, report: Report): Promise<LocalVolume | null> {
    const deadline = clock.now() + WAITS.volumeMs;
    const warned = { done: false };
    for (;;) {
      const volume = await patiently(clock, () => readLocalVolume(zone, id), deadline, report, warned);
      if (volume !== null && volume.server === null && volume.state === "available") return volume;
      if (clock.now() >= deadline) return null;
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** The volume the server boots from, when it is of a type this provider orders. */
  function bootVolume(server: ScalewayServer): ScalewayVolumeOfServer | null {
    const volume = server.volumes?.["0"];
    return volume !== undefined && DISK_TYPES.some((type) => type === volume.volume_type) ? volume : null;
  }

  /** The owner's two tags in place of whatever tags of an owner a resource carried. */
  function retagged(tags: readonly string[], name: string): string[] {
    return [...tags.filter((tag) => !tag.startsWith(`${MANAGED_LABEL}:`) && owner.machineOfTags([tag]) === null), ...owner.tags(name)];
  }

  /**
   * Tags the boot volume the order made, so that `destroy` knows it for the
   * owner's: the order cannot tag it, and the volume outlives the server.
   * Called only on a volume this command's order created: right after the
   * order, or on a server untouched since (neverStarted).
   */
  async function tagBootVolume(server: ScalewayServer, name: string, report: Report): Promise<void> {
    const volume = bootVolume(server);
    if (volume === null) return;
    report("-> boot volume");
    if (volume.volume_type === "l_ssd") {
      const local = await readLocalVolume(server.zone, volume.id);
      if (tagged(local.tags, name, owner)) {
        report(`   ${gigabytes(local.size)} of local SSD, already tagged`);
        return;
      }
      await call("PATCH", `${instance(server.zone)}/volumes/${encodeURIComponent(volume.id)}`, `tag the boot volume of ${name}`, { tags: retagged(local.tags, name) });
      report(`   ${gigabytes(local.size)} of local SSD, tagged ${owner.tagMark}`);
      return;
    }
    const ready = await settledVolume(server.zone, volume.id, (candidate) => candidate.status !== "creating", report);
    if (ready === null) {
      throw new ProviderError({ error: "machine-timeout", message: `the boot volume of ${name} is still being created after ${WAITS.volumeMs / 60_000} minutes`, details: ["the same command picks it up where it stands"] });
    }
    if (tagged(ready.tags, name, owner)) {
      report(`   ${gigabytes(ready.size)} of Block Storage, already tagged`);
      return;
    }
    await call("PATCH", `${block(server.zone)}/volumes/${encodeURIComponent(volume.id)}`, `tag the boot volume of ${name}`, { tags: retagged(ready.tags, name) });
    report(`   ${gigabytes(ready.size)} of Block Storage, tagged ${owner.tagMark}`);
  }

  /** Sets the user-data before the first boot, which is the only one cloud-init reads it at. */
  async function setUserData(server: ScalewayServer, userData: string, report: Report): Promise<void> {
    report("-> user-data");
    await request("PATCH", `${instance(server.zone)}/servers/${encodeURIComponent(server.id)}/user_data/${USER_DATA_KEY}`, `set the user-data of ${server.name}`, userData, true);
    report(`   ${new TextEncoder().encode(userData).length} bytes under ${USER_DATA_KEY}, read at the first boot`);
  }

  async function powerOn(server: ScalewayServer, types: Record<string, ScalewayServerType>, report: Report): Promise<void> {
    report(`-> power on ${server.name}`);
    try {
      await call("POST", `${instance(server.zone)}/servers/${encodeURIComponent(server.id)}/action`, `power on the server ${server.name}`, { action: "poweron" });
    } catch (error) {
      if (!(error instanceof ScalewayError) || error.type !== "out_of_stock") throw error;
      // Scaleway finds a host for a server when it starts, not when it is
      // ordered: the server stays, stopped, for a later run to start.
      throw new ProviderError({
        error: "type-unavailable",
        message: `Scaleway created ${server.name} but has no ${server.commercial_type} to start it on at ${server.zone} right now (${error.status} ${error.type}): ${error.said}`,
        details: [
          ...suggestedTypes(types, await availabilityOrNone(server.zone), server.zone, server.commercial_type),
          `${server.name} stays, stopped, with its addresses and its boot volume, which are billed: the same command starts it later, or ${owner.name} machine destroy ${server.name} removes it`,
        ],
      });
    }
    report("   asked");
  }

  type Offer = { types: Record<string, ScalewayServerType>; availability: Record<string, Availability>; chosen: ScalewayServerType };

  /** Refuses what cannot be ordered, the disk included; returns the catalogue, for the suggestions of a refused order. */
  async function checkOffer(request: CreateRequest, zone: string, volume: BootVolume, report: Report): Promise<Offer> {
    report(`-> ${request.type} at ${zone}, what Scaleway sells there`);
    const types = await typesIn(zone);
    const availability = await availabilityIn(zone);
    const chosen = types[request.type];
    if (chosen === undefined || chosen.end_of_service) {
      throw new ProviderError({
        error: "invalid-server-type",
        message: chosen === undefined ? `${request.type} is not a type Scaleway sells at ${zone}` : `${request.type} has reached its end of service at Scaleway`,
        details: suggestedTypes(types, availability, zone, request.type),
      });
    }
    if (availability[request.type] === "shortage") {
      throw new ProviderError({
        error: "type-unavailable",
        message: `Scaleway lists ${request.type} as out of stock at ${zone}`,
        details: [...suggestedTypes(types, availability, zone, request.type), "or try another --location", "nothing had been created yet"],
      });
    }
    checkDisk(volume, request.type, chosen, zone);
    // A local SSD is part of the type's price; Block Storage is billed beside it.
    const besides = volume.volume_type === "l_ssd" ? "the IPv4 address" : "the storage and the IPv4 address";
    report(`   ${describeType(chosen)}, ${formatPrice(monthlyPrice(chosen), "EUR")}, plus ${besides}`);
    if (availability[request.type] === "scarce") report(`!! Scaleway lists ${request.type} as scarce at ${zone}; trying anyway`);
    return { types, availability, chosen };
  }

  /** The image's ID: `debian-13` and other labels through the Marketplace, for the zone and the type's architecture; an ID as given. */
  async function resolveImage(request: CreateRequest, zone: string, type: ScalewayServerType, boot: BootVolume, report: Report): Promise<string> {
    const label = request.image === DEBIAN ? DEBIAN_LABEL : request.image;
    if (UUID.test(label)) {
      report(`   image ${label}, as given`);
      return label;
    }
    let images: LocalImage[];
    try {
      // The image is a snapshot of the boot volume's own kind: Scaleway refuses an
      // l_ssd root made from a Block Storage image, "requested volume type does
      // not match the snapshot type".
      const kind = boot.volume_type === "l_ssd" ? "instance_local" : "instance_sbs";
      images = await listAll<LocalImage>("/marketplace/v2/local-images", "local_images", `find the image ${label}`, { image_label: label, zone, type: kind, arch: type.arch }, "page_size");
    } catch (error) {
      if (!(error instanceof ScalewayError) || error.status !== 404) throw error;
      images = [];
    }
    const image = images.find((candidate) => candidate.compatible_commercial_types.includes(request.type));
    if (image === undefined) {
      throw new ProviderError({
        error: "provider-invalid",
        message: `Scaleway's Marketplace has no image ${label} for ${request.type} (${type.arch}) at ${zone}`,
        details: [request.image === DEBIAN ? "Debian 13 is the only system sitesolide setup is verified on: pick another --type or --location" : "--image takes a Marketplace label, such as debian_trixie, or an image ID"],
      });
    }
    report(`   image ${label} (${image.id}), ${image.arch}`);
    return image.id;
  }

  /** The security group of that name, when the owner created it; read before anything is created, so that a refusal leaves nothing. */
  async function findGroup(zone: string, machine: string): Promise<ScalewaySecurityGroup | null> {
    const name = groupName(machine, owner);
    const groups = (await listAll<ScalewaySecurityGroup>(`${instance(zone)}/security_groups`, "security_groups", "read the security groups", { project, name })).filter((group) => group.name === name);
    const foreign = groups.find((group) => !owner.managesTags(group.tags));
    if (foreign !== undefined) {
      throw new ProviderError({
        error: "firewall-taken",
        message: `a security group named ${name} exists at ${zone}, and ${owner.name} did not create it`,
        details: [`it lacks the tag ${owner.tagMark}: it is never adopted nor changed`],
      });
    }
    return groups.find((group) => tagged(group.tags, machine, owner)) ?? null;
  }

  /** The flexible addresses reserved for that machine, by an earlier run or for the server. */
  async function findIps(zone: string, machine: string): Promise<ScalewayIp[]> {
    const ips = await listAll<ScalewayIp>(`${instance(zone)}/ips`, "ips", "read the flexible IP addresses", { project, tags: owner.tags(machine).join(",") });
    return ips.filter((ip) => tagged(ip.tags, machine, owner));
  }

  async function listKeys(): Promise<ScalewayKey[]> {
    return listAll<ScalewayKey>("/iam/v1alpha1/ssh-keys", "ssh_keys", "read the SSH keys", { project_id: project }, "page_size");
  }

  /**
   * What the owner made and no server of its own holds, in every zone, by
   * machine: free flexible addresses, security groups no server uses,
   * detached volumes. `tag` narrows the reads, `managed-by:<owner>` for every
   * machine or `<owner>-machine:<name>` for one; a resource attached to a
   * server since is not counted, `destroy` could not remove it.
   */
  async function leftovers(tag: string): Promise<Map<string, Leftovers>> {
    const found = new Map<string, Leftovers>();
    const entry = (tags: readonly string[]): Leftovers | null => {
      const name = owner.managesTags(tags) ? owner.machineOfTags(tags) : null;
      if (name === null) return null;
      let left = found.get(name);
      if (left === undefined) {
        left = { ips: [], groups: [], volumes: [], local: [] };
        found.set(name, left);
      }
      return left;
    };
    for (const { zone } of ZONES) {
      for (const ip of await listAll<ScalewayIp>(`${instance(zone)}/ips`, "ips", `read the flexible IP addresses at ${zone}`, { project, tags: tag })) {
        if (ip.server === null) entry(ip.tags)?.ips.push({ ...ip, zone });
      }
      for (const group of await listAll<ScalewaySecurityGroup>(`${instance(zone)}/security_groups`, "security_groups", `read the security groups at ${zone}`, { project, tags: tag })) {
        if (group.name === groupName(owner.machineOfTags(group.tags) ?? "", owner) && (group.servers ?? []).length === 0) entry(group.tags)?.groups.push({ ...group, zone });
      }
      for (const volume of await listAll<BlockVolume>(`${block(zone)}/volumes`, "volumes", `read the volumes at ${zone}`, { project_id: project, tags: tag }, "page_size")) {
        if (volume.status !== "in_use") entry(volume.tags)?.volumes.push({ ...volume, zone });
      }
      for (const volume of await listAll<LocalVolume>(`${instance(zone)}/volumes`, "volumes", `read the local volumes at ${zone}`, { project, tags: tag })) {
        if (volume.server === null) entry(volume.tags)?.local.push({ ...volume, zone });
      }
    }
    return found;
  }

  async function leftoversOf(machine: string): Promise<Leftovers> {
    return (await leftovers(`${owner.machineLabel}:${machine}`)).get(machine) ?? { ips: [], groups: [], volumes: [], local: [] };
  }

  type Made = { kind: string; name: string; path: string };

  /**
   * Deletes what this run created before an order Scaleway refused: the key,
   * the security group and the addresses were made for a server that does
   * not exist. What an earlier run made, or the project already held, is left
   * as it was, and `earlier` says so. A deletion that fails leaves the
   * resource tagged, where the next run finds and reuses it. Returns what
   * happened, one line each, for the refusal's details.
   */
  async function undo(made: Made[], earlier: string[], report: Report): Promise<string[]> {
    if (made.length === 0) return ["this run had created nothing yet", ...earlier];
    return [...(await undoMade(made, (resource) => call("DELETE", resource.path, `delete the ${resource.kind} ${resource.name}`), report)), ...earlier];
  }

  /** What a refusal says of what an earlier run left in the zone, which this one reuses: it stays, billed for an address, until a create or a destroy. */
  function earlierLines(machine: string, group: ScalewaySecurityGroup | null, ips: ScalewayIp[]): string[] {
    const lines = ips
      .filter((ip) => ip.server === null)
      .map(
        (ip) =>
          `kept the ${ip.type === "routed_ipv6" ? `IPv6 prefix ${ip.prefix ?? ip.id}` : `IPv4 address ${ip.address ?? ip.id}`} an earlier run reserved: it is billed until the next create reuses it, or ${owner.name} machine destroy ${machine} releases it`,
      );
    if (group !== null) lines.push(`kept the security group ${group.name} an earlier run created: the next create reuses it, ${owner.name} machine destroy ${machine} deletes it`);
    return lines;
  }

  /** A refusal with what an earlier run left added to its details. */
  function withEarlier(error: unknown, earlier: string[]): unknown {
    if (!(error instanceof ProviderError) || earlier.length === 0) return error;
    return new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...earlier] });
  }

  /** The key a request names, as the project already holds it; a disabled one is refused, since the machine would not take it. */
  function heldKey(key: PublicKey, keys: ScalewayKey[], earlier: string[]): ScalewayKey | undefined {
    const ours = `${key.algorithm} ${key.blob}`;
    const same = keys.find((candidate) => keyMaterial(candidate.public_key) === ours);
    if (same?.disabled === true) {
      throw new ProviderError({
        error: "provider-invalid",
        message: `the SSH key ${same.name} is in the project but disabled: the machine would not accept it`,
        details: ["enable it in the console, under the project's SSH keys, or pass another key with --ssh-key", "nothing was created", ...earlier],
      });
    }
    return same;
  }

  type Registered = { id: string; name: string; reused: boolean };

  /** Uploads a key to IAM under a name of its own, never one the project already uses for another key. */
  async function uploadKey(plain: string, line: string, keys: ScalewayKey[], made: Made[]): Promise<Registered> {
    const name = keyName(plain, line, new Set(keys.map((key) => key.name)));
    const created = await call<ScalewayKey>("POST", "/iam/v1alpha1/ssh-keys", `upload the SSH key ${name}`, { name, public_key: line, project_id: project });
    made.push({ kind: "SSH key", name, path: `/iam/v1alpha1/ssh-keys/${encodeURIComponent(created.id)}` });
    return { id: created.id, name, reused: false };
  }

  async function ensureKey(name: string, key: PublicKey, keys: ScalewayKey[], same: ScalewayKey | undefined, report: Report, made: Made[]): Promise<Registered> {
    report("-> SSH key");
    if (same !== undefined) {
      report(`   ${same.name}, already in the project (${key.fingerprint}), reused`);
      return { id: same.id, name: same.name, reused: true };
    }
    const line = [key.algorithm, key.blob, key.comment].filter((part) => part !== "").join(" ");
    const uploaded = await uploadKey(`${owner.name}-${name}`, line, keys, made);
    report(`   ${uploaded.name}, uploaded (${key.fingerprint})`);
    return uploaded;
  }

  async function ensureGroup(zone: string, machine: string, inbound: readonly Inbound[], found: ScalewaySecurityGroup | null, report: Report, made: Made[]): Promise<Registered> {
    const name = groupName(machine, owner);
    report(`-> security group ${name}`);
    let id: string;
    if (found !== null) {
      id = found.id;
      report("   created by an earlier run, reused");
    } else {
      const created = await call<{ security_group: ScalewaySecurityGroup }>("POST", `${instance(zone)}/security_groups`, `create the security group ${name}`, {
        name,
        description: `${owner.name}: ${describeInbound(inbound)}; the rest dropped`,
        project,
        tags: owner.tags(machine),
        stateful: true,
        inbound_default_policy: "drop",
        outbound_default_policy: "accept",
      });
      id = created.security_group.id;
      made.push({ kind: "security group", name, path: `${instance(zone)}/security_groups/${encodeURIComponent(id)}` });
    }
    // Set whole, on a group only the owner's runs have touched: an earlier run may have stopped before.
    await call("PUT", `${instance(zone)}/security_groups/${encodeURIComponent(id)}/rules`, `set the rules of the security group ${name}`, { rules: securityGroupRules(inbound) });
    report(`   ${describeInbound(inbound)}; the rest dropped`);
    return { id, name, reused: found !== null };
  }

  async function ensureIp(zone: string, machine: string, type: "routed_ipv4" | "routed_ipv6", earlier: ScalewayIp[], report: Report, made: Made[]): Promise<ScalewayIp & { reused: boolean }> {
    const kind = type === "routed_ipv4" ? "IPv4 address" : "IPv6 prefix";
    const free = earlier.find((ip) => ip.type === type && ip.server === null);
    if (free !== undefined) {
      report(`   ${kind} ${free.address ?? free.prefix}, reserved by an earlier run, reused`);
      return { ...free, reused: true };
    }
    const created = (await call<{ ip: ScalewayIp }>("POST", `${instance(zone)}/ips`, `reserve an ${kind}`, { project, type, tags: owner.tags(machine) })).ip;
    const shown = created.address ?? created.prefix ?? created.id;
    made.push({ kind, name: shown, path: `${instance(zone)}/ips/${encodeURIComponent(created.id)}` });
    report(`   ${kind} ${shown}, reserved`);
    return { ...created, reused: false };
  }

  /** Removes a volume tagged for the machine once nothing holds it; says what became of it. */
  async function removeVolume(zone: string, volume: BlockVolume, machine: string, report: Report, removed: string[], kept: string[]): Promise<void> {
    const label = `block volume ${volume.name || volume.id} (${gigabytes(volume.size)})`;
    if (!tagged(volume.tags, machine, owner)) {
      kept.push(`${label}: it lacks the tag ${owner.tagMark}; it is billed until it is deleted from the console`);
      report(`   ${label}: kept, not tagged by ${owner.name}`);
      return;
    }
    const detached = await settledVolume(zone, volume.id, (candidate) => candidate.status === "available", report);
    if (detached === null) {
      kept.push(`${label}: still attached after ${WAITS.volumeMs / 60_000} minutes; delete it from the console, or it stays billed`);
      report(`!! ${label} is still attached: delete it from the console once it is free`);
      return;
    }
    await call("DELETE", `${block(zone)}/volumes/${encodeURIComponent(volume.id)}`, `delete the ${label}`);
    removed.push(label);
    report(`   ${label}: deleted`);
  }

  /** The same for a local SSD, which the Instance API keeps once its server is deleted. */
  async function removeLocalVolume(zone: string, volume: LocalVolume, machine: string, report: Report, removed: string[], kept: string[]): Promise<void> {
    const label = `local volume ${volume.name || volume.id} (${gigabytes(volume.size)})`;
    if (!tagged(volume.tags, machine, owner)) {
      kept.push(`${label}: it lacks the tag ${owner.tagMark}; it is billed until it is deleted from the console`);
      report(`   ${label}: kept, not tagged by ${owner.name}`);
      return;
    }
    const free = await freeLocalVolume(zone, volume.id, report);
    if (free === null) {
      kept.push(`${label}: still attached after ${WAITS.volumeMs / 60_000} minutes; delete it from the console, or it stays billed`);
      report(`!! ${label} is still attached: delete it from the console once it is free`);
      return;
    }
    await call("DELETE", `${instance(zone)}/volumes/${encodeURIComponent(volume.id)}`, `delete the ${label}`);
    removed.push(label);
    report(`   ${label}: deleted`);
  }

  // --- Elastic Metal ------------------------------------------------------------------------

  /**
   * A list of Elastic Metal servers, or none when the key may not read them.
   * A key granted Instances alone, which sitesolide's documentation asks for,
   * answers 403 there, and could not have ordered one either.
   */
  async function metalList(zone: string, query: Record<string, string>): Promise<MetalServer[]> {
    try {
      const servers = await listAll<MetalServer>(`${baremetal(zone)}/servers`, "servers", `read the Elastic Metal servers at ${zone}`, { project_id: project, ...query }, "page_size");
      return servers.map((server) => ({ ...server, zone: server.zone ?? zone }));
    } catch (error) {
      if (error instanceof ScalewayError && error.status === 403) return [];
      throw error;
    }
  }

  /** The Elastic Metal servers of that name, in every zone that sells them. */
  async function findMetal(name: string): Promise<MetalServer[]> {
    const found: MetalServer[] = [];
    for (const zone of METAL_ZONES) found.push(...(await metalList(zone, { name })).filter((server) => server.name === name));
    return found;
  }

  async function readMetal(zone: string, id: string, name: string): Promise<MetalServer> {
    const server = await call<MetalServer>("GET", `${baremetal(zone)}/servers/${encodeURIComponent(id)}`, `read the Elastic Metal ${name}`);
    return { ...server, zone: server.zone ?? zone };
  }

  const offerLists = new Map<string, Promise<MetalOffer[]>>();
  /** The hourly offers of a zone, read once. */
  function offersIn(zone: string): Promise<MetalOffer[]> {
    let read = offerLists.get(zone);
    if (read === undefined) {
      // The filter asks for the hourly ones only; chooseOffer checks again.
      read = listAll<MetalOffer>(`${baremetal(zone)}/offers`, "offers", `read the Elastic Metal offers at ${zone}`, { subscription_period: "hourly" }, "page_size");
      read.catch(() => offerLists.delete(zone));
      offerLists.set(zone, read);
    }
    return read;
  }

  /** The offer a server was ordered with, for its price; one that cannot be read stops nothing. */
  async function offerOf(server: MetalServer): Promise<MetalOffer | undefined> {
    if (!METAL_ZONES.some((zone) => zone === server.zone)) return undefined;
    return (await offersIn(server.zone).catch((): MetalOffer[] => [])).find((offer) => offer.id === server.offer_id);
  }

  /**
   * Until the system is on the server's disks: delivery, then the install,
   * 15 to 40 minutes in all, asked slowly. A server that fails either stays,
   * billed, for a destroy.
   */
  async function waitInstalled(zone: string, id: string, name: string, report: Report): Promise<MetalServer> {
    const deadline = clock.now() + WAITS.installMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const server = await patiently(clock, () => readMetal(zone, id, name), deadline, report, warned);
      if (server !== null) {
        const state = metalStatus(server);
        if (state !== last) report(`   ${state}`);
        last = state;
        if (server.status === "ready" && server.install?.status === "completed") return server;
        if (["error", "out_of_stock", "locked"].includes(server.status) || server.install?.status === "error") {
          throw new ProviderError({
            error: "action-failed",
            message: `Scaleway could not deliver and install ${name}: ${server.status}${server.install?.status === "error" ? ", its install failed" : ""}`,
            details: [`${name} stays at ${zone}, billed by the hour: ${owner.name} machine destroy ${name} removes it`, "the console says why"],
          });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({
          error: "machine-timeout",
          message: `${name} is still not installed after ${WAITS.installMs / 60_000} minutes`,
          details: [`last state: ${last || "unread"}`, `${name} stays at ${zone}, billed by the hour: the same command waits for it again, ${owner.name} machine destroy ${name} removes it`],
        });
      }
      await clock.sleep(WAITS.metalPollMs);
    }
  }

  /**
   * Orders an Elastic Metal: the offer, the system and the keys read first,
   * then the install key registered, then the order, which carries the
   * install and the user-data, then the wait for both.
   */
  async function orderMetal(request: CreateRequest, zone: string, report: Report): Promise<CreateOutcome> {
    report(`-> ${request.type} at ${zone}, an Elastic Metal, what Scaleway sells there`);
    const offers = await offersIn(zone);
    const offer = chooseOffer(offers, request.type, zone);
    report(`   ${describeOffer(offer)}, ${hourlyPrice(offer).toFixed(3)} EUR an hour, ${formatPrice(hourlyPrice(offer) * HOURS_A_MONTH, "EUR")}, the disks included`);
    if (offer.stock === "low") report(`!! Scaleway lists ${request.type} as low in stock at ${zone}; trying anyway`);
    const systems = await listAll<MetalOs>(`${baremetal(zone)}/os`, "os", `read the systems ${request.type} installs`, { offer_id: offer.id }, "page_size");
    const os = UUID.test(request.image) ? systems.find((candidate) => candidate.id === request.image) : chooseOs(systems, request.image, offer, zone);
    if (os === undefined) {
      throw new ProviderError({ error: "invalid-image", message: `${request.image} is no system ${request.type} installs at ${zone}`, details: ["nothing had been created yet"] });
    }
    report(`   ${os.name} ${os.version} (${os.id})`);
    const keys = await listKeys();
    const same = request.key === null ? undefined : heldKey(request.key, keys, []);
    report(`   no security group: the user-data writes the firewall on the host, ${describeInbound(request.inbound)}`);

    const made: Made[] = [];
    let ordering = false;
    let key: Registered;
    let server: MetalServer;
    try {
      if (request.key !== null) {
        key = await ensureKey(request.name, request.key, keys, same, report, made);
      } else {
        report("-> install key");
        // Its private half is gone once this line is made: it only lets the install start.
        const plain = installKeyName(owner, request.name);
        key = await uploadKey(plain, await throwawayKey(plain), keys, made);
        report(`   ${key.name}, registered for the install alone, no one holds it`);
      }
      report(`-> Elastic Metal ${request.name}: ${request.type} at ${zone}, ${os.name} ${os.version}`);
      ordering = true;
      server = await call<MetalServer>("POST", `${baremetal(zone)}/servers`, `order the Elastic Metal ${request.name}`, {
        offer_id: offer.id,
        project_id: project,
        name: request.name,
        description: `${owner.name} machine ${request.name}`,
        // The key this run registered is named here, the only proof `destroy` takes.
        tags: [...owner.tags(request.name), ...(key.reused ? [] : [`${keyTag(owner)}:${key.id}`])],
        install: { os_id: os.id, hostname: request.name, ssh_key_ids: [key.id] },
        option_ids: [],
        protected: false,
        // Bytes in the API's schema, so base64 in its JSON.
        ...(request.userData === undefined ? {} : { user_data: Buffer.from(request.userData).toString("base64") }),
      });
      server = { ...server, zone: server.zone ?? zone };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const refused = error instanceof ScalewayError && ((error.status >= 400 && error.status < 500 && error.status !== 429) || error.type === "out_of_stock" || error.type === "quotas_exceeded");
      if (ordering && !refused) {
        throw new ProviderError({
          ...error.failure,
          details: [
            ...(error.failure.details ?? []),
            `whether Scaleway ordered ${request.name} is unknown: nothing was undone`,
            ...made.map((resource) => `the ${resource.kind} ${resource.name} this run registered stays`),
            `the same command finds ${request.name} if it was ordered and waits for its install; ${owner.name} machine destroy ${request.name} removes it`,
          ],
        });
      }
      throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...(await undo(made, [], report))] });
    }
    report(`   ordered, id ${server.id}, ${metalStatus(server)}; delivery and install take 15 to 40 minutes`);
    const ready = await waitInstalled(zone, server.id, request.name, report);
    return {
      machine: metalMachine(ready, offer, owner),
      created: true,
      resources: [
        { kind: "ssh key", name: key.name, id: key.id, reused: key.reused },
        { kind: "server", name: server.name, id: server.id, reused: false },
      ],
    };
  }

  /** An Elastic Metal the owner ordered before, waited for when its install has not completed yet. */
  async function reuseMetal(server: MetalServer, request: CreateRequest, report: Report): Promise<CreateOutcome> {
    const offer = await offerOf(server);
    report(`   already created by ${owner.name}: ${server.offer_name} at ${server.zone}, ${metalStatus(server)}`);
    if (server.offer_name !== request.type || server.zone !== request.location) {
      report(`!! it is ${server.offer_name} at ${server.zone}: --type and --location only apply to a machine being created`);
    }
    const installed = server.status === "ready" && server.install?.status === "completed" ? server : await waitInstalled(server.zone, server.id, server.name, report);
    return { machine: metalMachine(installed, offer, owner), created: false, resources: [{ kind: "server", name: server.name, id: server.id, reused: true }] };
  }

  /** Deletes an Elastic Metal the owner ordered, waits for it to go, then the key it was installed with. */
  async function destroyMetal(machine: Machine, options: { deleteKey: boolean }, report: Report): Promise<DestroyOutcome> {
    const removed: string[] = [];
    const kept: string[] = [];
    const zone = zoneOf(machine.location);
    report(`-> Elastic Metal ${machine.name}`);
    // Read again here, never trusted from the caller: only a server carrying the tag is deleted.
    const server = await readMetal(zone, machine.id, machine.name);
    if (!owner.managesTags(server.tags)) {
      throw new ProviderError({ error: "machine-not-managed", message: `${machine.name} lacks the tag ${owner.tagMark}: ${owner.name} did not create it`, details: ["nothing was deleted"] });
    }
    if (server.status !== "deleting") await call("DELETE", `${baremetal(zone)}/servers/${encodeURIComponent(server.id)}`, `delete the Elastic Metal ${machine.name}`);
    report("   deleting");
    const deadline = clock.now() + WAITS.metalDeletedMs;
    const warned = { done: false };
    for (;;) {
      let gone = false;
      try {
        await patiently(clock, () => readMetal(zone, server.id, machine.name), deadline, report, warned);
      } catch (error) {
        if (!(error instanceof ScalewayError) || error.status !== 404) throw error;
        gone = true;
      }
      if (gone) break;
      if (clock.now() >= deadline) {
        throw new ProviderError({
          error: "machine-timeout",
          message: `${machine.name} is still being deleted after ${WAITS.metalDeletedMs / 60_000} minutes`,
          details: ["the key it was installed with is kept until it is gone: the same command finishes"],
        });
      }
      await clock.sleep(WAITS.metalPollMs);
    }
    const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");
    removed.push(`Elastic Metal ${machine.name}${addresses === "" ? "" : ` (${addresses})`}`);
    report("   deleted");

    report("-> SSH key");
    const keyId = keyOfTags(server.tags, owner);
    const key = keyId === null ? undefined : (await listKeys()).find((candidate) => candidate.id === keyId);
    if (keyId === null) {
      report(`   none was registered for ${machine.name}: the key it used was already in the project`);
    } else if (key === undefined) {
      report("   already gone");
    } else if (isInstallKeyFor(key, machine.name, owner) || (options.deleteKey && isKeyFor(key, machine.name, owner))) {
      // An install key's private half was never kept: no one can use it again.
      await call("DELETE", `/iam/v1alpha1/ssh-keys/${encodeURIComponent(key.id)}`, `delete the SSH key ${key.name}`);
      removed.push(`SSH key ${key.name}`);
      report(`   ${key.name}: deleted`);
    } else if (isKeyFor(key, machine.name, owner)) {
      kept.push(`SSH key ${key.name}: every Instance of the project receives it at boot, and other machines may be created with it; --delete-key deletes it`);
      report(`   ${key.name}: kept, other machines of the project may use it`);
    } else {
      kept.push(`SSH key ${key.name}: renamed since it was uploaded for ${machine.name}, so it is never deleted from here`);
      report(`   ${key.name}: kept, renamed since`);
    }
    return { removed, kept };
  }

  // --- the provider ---------------------------------------------------------------------------

  return {
    name: "scaleway",

    async find(name) {
      const servers = await findServers(name);
      const metals = await findMetal(name);
      // One the owner created first, so that `destroy` finds its own among namesakes.
      const ours = servers.find((candidate) => owner.managesTags(candidate.tags));
      if (ours !== undefined) return toMachine(ours, await typeOf(ours), owner);
      const ourMetal = metals.find((candidate) => owner.managesTags(candidate.tags));
      if (ourMetal !== undefined) return metalMachine(ourMetal, await offerOf(ourMetal), owner);
      // Without a server, what an earlier run made for it is still a machine
      // of the owner's: billed, one a destroy finishes, a create reuses.
      const left = await leftoversOf(name);
      if (hasLeftovers(left)) return incompleteMachine(name, left, owner);
      if (servers[0] !== undefined) return toMachine(servers[0], await typeOf(servers[0]), owner);
      return metals[0] === undefined ? null : metalMachine(metals[0], await offerOf(metals[0]), owner);
    },

    async create(request, report): Promise<CreateOutcome> {
      const metal = isMetal(request.type);
      checkRequest(metal ? METAL_TITLE : TITLE, request, metal ? METAL_SUPPORTS : SUPPORTS);
      if (metal && request.hostFirewall !== true) {
        throw new ProviderError({
          error: "provider-unsupported",
          message: `${METAL_TITLE} has no security group: it is ordered only when the user-data writes the firewall on the host (hostFirewall)`,
          details: ["without it, every port of the machine would be open while the request believed them closed", "nothing was created"],
        });
      }
      if (metal && request.userData === undefined) {
        throw new ProviderError({
          error: "provider-unsupported",
          message: `${METAL_TITLE} was asked a firewall on the host, and no user-data to write it`,
          details: ["nothing was created"],
        });
      }
      if (request.backups) {
        throw new ProviderError({
          error: "provider-invalid",
          message: `${owner.name} turns on no Scaleway backups: Scaleway offers images on demand, not backups of a whole machine on a schedule`,
          details: ["nothing was created"],
        });
      }
      const zone = zoneOf(request.location);
      if (metal && !METAL_ZONES.some((candidate) => candidate === zone)) {
        throw new ProviderError({ error: "invalid-location", message: `Scaleway sells no Elastic Metal at ${zone}`, details: [`the zones that sell it: ${METAL_ZONES.join(", ")}`, "nothing was created"] });
      }
      const volume = metal ? null : bootVolumeOf(request);
      const resources: Resource[] = [];
      report(`-> a server named ${request.name} in the project`);
      const existing = await findServers(request.name);
      const metals = await findMetal(request.name);
      const foreign = existing.find((server) => !owner.managesTags(server.tags)) ?? metals.find((server) => !owner.managesTags(server.tags));
      if (foreign !== undefined || existing.length + metals.length > 1) {
        const shown = foreign ?? existing[0] ?? metals[0]!;
        const found = "commercial_type" in shown ? toMachine(shown, undefined, owner) : metalMachine(shown, undefined, owner);
        throw new ProviderError({
          error: "machine-exists",
          message:
            foreign !== undefined
              ? `a server named ${request.name} exists in the project, and ${owner.name} did not create it`
              : `${existing.length + metals.length} servers are named ${request.name} in the project: ${owner.name} does not choose between them`,
          details: [
            `${found.type} at ${found.location}, ${found.status}, ${[found.ipv4, found.ipv6].filter(Boolean).join(", ") || "no public address"}`,
            foreign !== undefined ? `it lacks the tag ${owner.tagMark}: nothing was created, nothing was changed` : "nothing was created, nothing was changed",
          ],
        });
      }
      if (metals.length === 1) return reuseMetal(metals[0]!, request, report);
      if (metal && existing.length === 0) {
        report("   none of that name yet");
        return orderMetal(request, zone, report);
      }

      let server: ScalewayServer;
      let created: boolean;
      let poweredOn = false;
      let types: Record<string, ScalewayServerType>;
      if (existing.length === 1) {
        server = existing[0]!;
        const found = toMachine(server, undefined, owner);
        report(`   already created by ${owner.name}: ${found.type} at ${found.location}, ${found.status}`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        created = false;
        resources.push({ kind: "server", name: server.name, id: server.id, reused: true });
        types = await typesOrNone(server.zone);
        if (neverStarted(server)) {
          // The run that ordered it stopped before starting it: this one finishes it.
          report("   never started: the run that ordered it stopped before");
          await tagBootVolume(server, request.name, report);
          if (request.userData !== undefined) await setUserData(server, request.userData, report);
          await powerOn(server, types, report);
          poweredOn = true;
        } else if (request.userData !== undefined) {
          report(`!! ${request.name} has booted before: cloud-init reads a user-data at the first boot alone, so it is left as it is`);
        }
      } else {
        report("   none of that name yet");
        const boot = volume!;
        // What an earlier run left in the zone is read first: every refusal says it stays.
        const existingGroup = await findGroup(zone, request.name);
        const earlierIps = await findIps(zone, request.name);
        const earlier = earlierLines(request.name, existingGroup, earlierIps);
        let image: string;
        let keys: ScalewayKey[] = [];
        let offer: Offer;
        let sameKey: ScalewayKey | undefined;
        try {
          offer = await checkOffer(request, zone, boot, report);
          image = await resolveImage(request, zone, offer.chosen, boot, report);
          if (request.key !== null) {
            keys = await listKeys();
            sameKey = heldKey(request.key, keys, earlier);
          }
        } catch (error) {
          throw withEarlier(error, earlier);
        }
        types = offer.types;

        // What this run creates before the server, undone if the order is refused.
        const made: Made[] = [];
        let ordering = false;
        try {
          let key: Registered | null = null;
          if (request.key !== null) {
            key = await ensureKey(request.name, request.key, keys, sameKey, report, made);
            resources.push({ kind: "ssh key", name: key.name, id: key.id, reused: key.reused });
          } else {
            report("-> SSH key");
            report("   none registered: the user-data carries the machine's key");
          }
          const group = await ensureGroup(zone, request.name, request.inbound, existingGroup, report, made);
          resources.push({ kind: "security group", name: group.name, id: group.id, reused: group.reused });
          report("-> flexible addresses");
          const ipv4 = await ensureIp(zone, request.name, "routed_ipv4", earlierIps, report, made);
          resources.push({ kind: "ipv4", name: ipv4.address ?? ipv4.id, id: ipv4.id, reused: ipv4.reused });
          const ipv6 = await ensureIp(zone, request.name, "routed_ipv6", earlierIps, report, made);
          resources.push({ kind: "ipv6", name: ipv6.prefix ?? ipv6.id, id: ipv6.id, reused: ipv6.reused });

          report(`-> server ${request.name}: ${request.type} at ${zone}, ${request.image}`);
          ordering = true;
          const answer = await call<{ server: ScalewayServer }>("POST", `${instance(zone)}/servers`, `create the server ${request.name}`, {
            name: request.name,
            commercial_type: request.type,
            image,
            // The boot volume, from the image, at the size asked rather than the image's.
            volumes: { "0": boot },
            // The flexible addresses only: a dynamic one would change at every start.
            dynamic_ip_required: false,
            public_ips: [ipv4.id, ipv6.id],
            project,
            // The key this run uploaded is named here, the only proof `destroy --delete-key` takes.
            tags: [...owner.tags(request.name), ...(key === null || key.reused ? [] : [`${keyTag(owner)}:${key.id}`])],
            security_group: group.id,
          });
          server = { ...answer.server, zone: answer.server.zone ?? zone };
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          // A 4xx other than a 429 is Scaleway saying no. Anything else once
          // the order left, no answer, a 5xx, an answer that cannot be read,
          // leaves it unknown whether the server exists: undoing would take
          // its key and its addresses from it (Scaleway deletes an attached
          // flexible IP), so nothing is undone, and the next run finds either
          // the server or what this one made.
          // `out_of_stock` and `quotas_exceeded` say no whatever the status they come with.
          const refused =
            error instanceof ScalewayError && ((error.status >= 400 && error.status < 500 && error.status !== 429) || error.type === "out_of_stock" || error.type === "quotas_exceeded");
          if (ordering && !refused) {
            throw new ProviderError({
              ...error.failure,
              details: [
                ...(error.failure.details ?? []),
                `whether Scaleway created ${request.name} is unknown: nothing was undone`,
                ...made.map((resource) => `the ${resource.kind} ${resource.name} this run created stays`),
                ...earlier,
                `the same command finds ${request.name} if it was created and starts it, or reuses what is left; ${owner.name} machine destroy ${request.name} removes it all`,
              ],
            });
          }
          const undone = await undo(made, earlier, report);
          if (ordering && error instanceof ScalewayError && refusesTheOffer(error)) {
            // The stock may change between the read and the order: the order
            // decides, and its refusal still says what to try instead.
            throw new ProviderError({
              error: "type-unavailable",
              message: `Scaleway would not create ${request.type} at ${zone} (${error.status} ${error.type}): ${error.said}`,
              details: [...suggestedTypes(types, await availabilityOrNone(zone), zone, request.type), "or try another --location", ...undone],
            });
          }
          throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone] });
        }
        created = true;
        resources.push({ kind: "server", name: server.name, id: server.id, reused: false });
        report(`   ordered, id ${server.id}, ${server.state}`);
        await tagBootVolume(server, request.name, report);
        // Scaleway creates the server stopped: the user-data is in place before the first boot.
        if (request.userData !== undefined) await setUserData(server, request.userData, report);
        await powerOn(server, types, report);
        poweredOn = true;
      }
      report(`-> ${request.name} running`);
      const running = await waitRunning(server.zone, server.id, request.name, report, poweredOn);
      const boot = bootVolume(running);
      if (!created && !poweredOn && boot !== null) {
        // Only said, never fixed: on a server that has run, the volume may no
        // longer be the one the order made. A read that fails stops nothing.
        const read =
          boot.volume_type === "l_ssd"
            ? await readLocalVolume(running.zone, boot.id).catch(() => null)
            : await call<BlockVolume>("GET", `${block(running.zone)}/volumes/${encodeURIComponent(boot.id)}`, `read the boot volume of ${request.name}`).catch(() => null);
        if (read !== null && !tagged(read.tags, request.name, owner)) report(`!! the boot volume of ${request.name} carries no ${owner.name} tag: destroy will keep it`);
      }
      return { machine: toMachine(running, types[running.commercial_type], owner), created, resources };
    },

    async list() {
      const servers: ScalewayServer[] = [];
      for (const { zone } of ZONES) {
        const found = await listAll<ScalewayServer>(`${instance(zone)}/servers`, "servers", `read the servers at ${zone}`, { project, tags: owner.tagMark });
        servers.push(...found.filter((server) => owner.managesTags(server.tags)).map((server) => ({ ...server, zone: server.zone ?? zone })));
      }
      const machines: Machine[] = [];
      for (const server of servers) machines.push(toMachine(server, await typeOf(server), owner));
      const metals: MetalServer[] = [];
      for (const zone of METAL_ZONES) metals.push(...(await metalList(zone, { tags: owner.tagMark })).filter((server) => owner.managesTags(server.tags)));
      for (const server of metals) machines.push(metalMachine(server, await offerOf(server), owner));
      // What earlier runs left without a server: billed, and only a destroy removes it.
      const present = new Set([...servers, ...metals].map((server) => owner.machineOfTags(server.tags) ?? server.name));
      const left = await leftovers(owner.tagMark);
      for (const [name, remains] of [...left.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!present.has(name) && hasLeftovers(remains)) machines.push(incompleteMachine(name, remains, owner));
      }
      return machines;
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      if (isMetal(machine.type)) return destroyMetal(machine, options, report);
      const removed: string[] = [];
      const kept: string[] = [];
      const incomplete = machine.status === INCOMPLETE;
      const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");

      report(`-> server ${machine.name}`);
      // The server deleted here, its zone, and what it held; null when there was none.
      let server: ScalewayServer | null = null;
      const handled = new Set<string>();
      if (incomplete) {
        if ((await findServers(machine.name)).some((candidate) => owner.managesTags(candidate.tags))) {
          throw new ProviderError({
            error: "provider-busy",
            message: `a server named ${machine.name} appeared since the machine was read`,
            details: ["nothing was deleted: run the same command again, which destroys it whole"],
          });
        }
        report("   none: an earlier run never created it, or it was deleted; what was made for it goes below, in every zone");
      } else {
        const zone = zoneOf(machine.location);
        const read = { ...(await readServer(zone, machine.id, machine.name)), zone };
        // Read again here, never trusted from the caller: only a server carrying the tag is deleted.
        if (!owner.managesTags(read.tags)) {
          throw new ProviderError({ error: "machine-not-managed", message: `${machine.name} lacks the tag ${owner.tagMark}: ${owner.name} did not create it`, details: ["nothing was deleted"] });
        }
        // Scaleway deletes a stopped server only; deleting it leaves its
        // volumes, local ones included, and its flexible addresses, each
        // deleted below when it is the owner's.
        server = await stopServer(read, report);
        await call("DELETE", `${instance(zone)}/servers/${encodeURIComponent(server.id)}`, `delete the server ${machine.name}`);
        removed.push(`server ${machine.name}${addresses === "" ? "" : ` (${addresses})`}`);
        report("   deleted");
      }

      report("-> volumes");
      const beforeVolumes = removed.length + kept.length;
      if (server !== null) {
        for (const volume of Object.values(server.volumes ?? {})) {
          handled.add(volume.id);
          try {
            if (volume.volume_type === "sbs_volume") {
              const read = await call<BlockVolume>("GET", `${block(server.zone)}/volumes/${encodeURIComponent(volume.id)}`, `read the volume ${volume.id}`);
              await removeVolume(server.zone, read, machine.name, report, removed, kept);
            } else if (volume.volume_type === "l_ssd") {
              await removeLocalVolume(server.zone, await readLocalVolume(server.zone, volume.id), machine.name, report, removed, kept);
            } else {
              kept.push(`${volume.volume_type} volume ${volume.name || volume.id}: ${owner.name} never creates one; it is billed until it is deleted from the console`);
              report(`   ${volume.name || volume.id}: kept, not ${owner.name}'s`);
            }
          } catch (error) {
            if (error instanceof ScalewayError && error.status === 404) continue;
            throw error;
          }
        }
      }
      // An earlier server's boot volume, left by a destroy that stopped, in any zone.
      for (const { zone } of ZONES) {
        const volumes = await listAll<BlockVolume>(`${block(zone)}/volumes`, "volumes", `read the volumes at ${zone}`, { project_id: project, tags: `${owner.machineLabel}:${machine.name}` }, "page_size");
        for (const volume of volumes.filter((candidate) => tagged(candidate.tags, machine.name, owner) && !handled.has(candidate.id))) {
          if (volume.status === "in_use") {
            kept.push(`block volume ${volume.name || volume.id}: attached to a server since; it is billed until it is deleted from the console`);
            report(`   ${volume.name || volume.id}: kept, attached to a server`);
            continue;
          }
          await removeVolume(zone, volume, machine.name, report, removed, kept);
        }
        const local = await listAll<LocalVolume>(`${instance(zone)}/volumes`, "volumes", `read the local volumes at ${zone}`, { project, tags: `${owner.machineLabel}:${machine.name}` });
        for (const volume of local.filter((candidate) => tagged(candidate.tags, machine.name, owner) && !handled.has(candidate.id))) {
          if (volume.server !== null) {
            kept.push(`local volume ${volume.name || volume.id}: attached to the server ${volume.server.name} since; it is billed until it is deleted from the console`);
            report(`   ${volume.name || volume.id}: kept, attached to a server`);
            continue;
          }
          await removeLocalVolume(zone, volume, machine.name, report, removed, kept);
        }
      }
      if (removed.length + kept.length === beforeVolumes) report("   none");

      report("-> flexible addresses");
      const before = removed.length + kept.length;
      for (const { zone } of ZONES) {
        const ours = await findIps(zone, machine.name);
        for (const ip of ours) {
          const shown = ip.type === "routed_ipv6" ? `IPv6 prefix ${ip.prefix ?? ip.id}` : `IPv4 address ${ip.address ?? ip.id}`;
          if (ip.server !== null && ip.server.id !== server?.id) {
            kept.push(`${shown}: now attached to the server ${ip.server.name}`);
            report(`   ${shown}: kept, attached to ${ip.server.name}`);
            continue;
          }
          await call("DELETE", `${instance(zone)}/ips/${encodeURIComponent(ip.id)}`, `release the ${shown}`);
          removed.push(shown);
          report(`   ${shown}: released`);
        }
        if (server !== null && server.zone === zone) {
          for (const ip of addressesOf(server).filter((candidate) => !candidate.dynamic && !ours.some((own) => own.id === candidate.id))) {
            kept.push(`flexible IP ${ip.address}: ${owner.name} did not reserve it; it is billed until it is released from the console`);
            report(`   ${ip.address}: kept, not ${owner.name}'s`);
          }
        }
      }
      if (removed.length + kept.length === before) report("   none");

      const name = groupName(machine.name, owner);
      report(`-> security group ${name}`);
      let groupsSeen = 0;
      for (const { zone } of ZONES) {
        const groups = (await listAll<ScalewaySecurityGroup>(`${instance(zone)}/security_groups`, "security_groups", `read the security groups at ${zone}`, { project, name })).filter(
          (group) => group.name === name && tagged(group.tags, machine.name, owner),
        );
        groupsSeen += groups.length;
        for (const group of groups) {
          // Scaleway may still count the deleted server for a moment.
          for (let attempt = 1; ; attempt++) {
            let current: ScalewaySecurityGroup;
            try {
              current = (await call<{ security_group: ScalewaySecurityGroup }>("GET", `${instance(zone)}/security_groups/${encodeURIComponent(group.id)}`, `read the security group ${name}`)).security_group;
            } catch (error) {
              if (error instanceof ScalewayError && error.status === 404) break;
              throw error;
            }
            const elsewhere = (current.servers ?? []).filter((candidate) => candidate.id !== server?.id);
            if (elsewhere.length > 0) {
              const names = elsewhere.map((candidate) => candidate.name).join(", ");
              kept.push(`security group ${name} at ${zone}: still applied to ${names}`);
              report(`   kept: still applied to ${names}`);
              break;
            }
            try {
              await call("DELETE", `${instance(zone)}/security_groups/${encodeURIComponent(group.id)}`, `delete the security group ${name}`);
              removed.push(`security group ${name} at ${zone}`);
              report(`   ${zone}: deleted`);
              break;
            } catch (error) {
              if (!(error instanceof ProviderError) || ["provider-unauthenticated", "provider-forbidden"].includes(error.failure.error)) throw error;
              if (attempt >= WAITS.groupTries) {
                kept.push(`security group ${name} at ${zone}: Scaleway would not delete it (${error.failure.message})`);
                report("   kept: Scaleway would not delete it yet; delete it from the console once it is free");
                break;
              }
              await clock.sleep(WAITS.pollMs);
            }
          }
        }
      }
      if (groupsSeen === 0) report(`   none created by ${owner.name} under that name`);

      report("-> SSH key");
      const keyId = server === null ? null : keyOfTags(server.tags, owner);
      if (keyId === null) {
        report(
          server === null
            ? "   no server says which key was uploaded for it: none is deleted"
            : `   none was uploaded for ${machine.name}: it used a key the project already held, or none`,
        );
      } else {
        // The key the server's tag names, and only while it bears the name create gave it.
        const key = (await listKeys()).find((candidate) => candidate.id === keyId);
        if (key === undefined) {
          report("   already gone");
        } else if (!isKeyFor(key, machine.name, owner)) {
          kept.push(`SSH key ${key.name}: renamed since it was uploaded for ${machine.name}, so it is never deleted from here`);
          report(`   ${key.name}: kept, renamed since`);
        } else if (options.deleteKey) {
          await call("DELETE", `/iam/v1alpha1/ssh-keys/${encodeURIComponent(key.id)}`, `delete the SSH key ${key.name}`);
          removed.push(`SSH key ${key.name}`);
          report(`   ${key.name}: deleted, from the project and from every Instance of it at its next boot`);
        } else {
          kept.push(`SSH key ${key.name}: every Instance of the project receives it at boot, and other machines may be created with it; --delete-key deletes it`);
          report(`   ${key.name}: kept, other machines of the project may use it`);
        }
      }
      return { removed, kept };
    },

    async locations(): Promise<Choice[]> {
      const choices = ZONES.map((entry) => ({ value: entry.zone, label: `${entry.city}, ${entry.country}` }));
      return [...choices.filter((choice) => choice.value === DEFAULT_ZONE), ...choices.filter((choice) => choice.value !== DEFAULT_ZONE)];
    },

    async types(location): Promise<Choice[]> {
      const zone = zoneOf(location);
      const types = await typesIn(zone);
      const availability = await availabilityIn(zone);
      const sorted = Object.entries(types)
        .filter(([name, type]) => offered(name, type, availability[name]))
        .sort(([nameA, a], [nameB, b]) => monthlyPrice(a) - monthlyPrice(b) || nameA.localeCompare(nameB));
      const ordered = [...sorted.filter(([name]) => name === DEFAULT_TYPE), ...sorted.filter(([name]) => name !== DEFAULT_TYPE)];
      return ordered.slice(0, WIZARD_TYPES).map(([name, type]) => ({
        value: name,
        label: name,
        hint: `${describeType(type)}, ${formatPrice(monthlyPrice(type), "EUR")}${availability[name] === "scarce" ? ", scarce" : ""}`,
      }));
    },
  };
}

// --- the entry ------------------------------------------------------------------------------

const SCALEWAY_HELP = [
  "create it in the Scaleway console: IAM, Applications, an application of its own; then IAM, Policies, a policy for it granting InstancesFullAccess, BlockStorageFullAccess and SSHKeysFullAccess on that one project, and ElasticMetalFullAccess to order Elastic Metal; then IAM, API keys, Generate API key, for the application",
  "SCW_DEFAULT_PROJECT_ID is the project's ID, in the console under Project settings; a project of its own for these machines keeps the key away from everything else you run at Scaleway",
];

/** One value of the scw CLI's active profile, or null when it has none, or none of that shape. */
async function scwValue(workstation: Workstation, key: string): Promise<string | null> {
  const answer = await workstation.run(["scw", "config", "get", key]);
  const value = answer.stdout.trim();
  return answer.code === 0 && UUID.test(value) ? value : null;
}

/**
 * The secret key and the project the scw CLI was set up with (`scw init`),
 * through `scw config get`, which prints a value of the active profile as
 * is. The secret key alone is enough: a project in the environment wins
 * over the CLI's.
 */
export async function discover(workstation: Workstation): Promise<Discovery | null> {
  const key = await scwValue(workstation, "secret-key");
  if (key === null) return null;
  const project = await scwValue(workstation, "default-project-id");
  return { source: "the scw CLI's configuration", credentials: { [SECRET_VARIABLE]: key, ...(project === null ? {} : { [PROJECT_VARIABLE]: project }) } };
}

export const SCALEWAY: ProviderEntry = {
  name: "scaleway",
  title: "Scaleway",
  credentials: [
    { variable: SECRET_VARIABLE, label: "API secret key", secret: true, shape: UUID },
    { variable: PROJECT_VARIABLE, label: "project ID", secret: false, shape: UUID },
  ],
  discover,
  credentialHelp: SCALEWAY_HELP,
  docs: "docs/providers/scaleway.md",
  defaults: () => ({ type: DEFAULT_TYPE, location: DEFAULT_ZONE, image: DEBIAN }),
  // Scaleway's `backup` action makes an image on demand: no schedule a flag turns on.
  backups: false,
  apiVariable: API_VARIABLE,
  open: scaleway,
};
