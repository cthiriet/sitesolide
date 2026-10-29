/**
 * Microsoft Azure, through Azure Resource Manager's REST API, with nothing of
 * Azure's installed on the workstation: https://learn.microsoft.com/rest/api/azure/
 *
 * A machine is a resource group of its own, `<owner>-<name>`, at the
 * machine's location, and what it holds. The group and every resource in it
 * carry the tags `managed-by=<owner>` and `<owner>-machine=<name>`, so that
 * two owners' machines of one name live side by side, in two groups:
 *
 *   - a network security group `<name>-nsg`: inbound TCP 22, 80 and 443 and
 *     ICMP from the Internet; Azure's own DenyAllInBound, under every rule
 *     of every group, drops the rest;
 *   - a virtual network `<name>-vnet` with one subnet;
 *   - a Standard public IPv4 `<name>-ip`, static: Azure keeps it while the
 *     machine is stopped or deallocated, so the DNS records stay right;
 *   - a network interface `<name>-nic` with the address and the security group;
 *   - the virtual machine `<name>`, Debian 13, the workstation's key for an
 *     account named after the owner, password logins off, and no custom
 *     data: the program's own setup reaches it over SSH, which a run can
 *     repeat. Its OS disk `<name>-osdisk` is created by Azure with it,
 *     untagged, and tagged right after.
 *
 * The group is the unit. `destroy` deletes it, which deletes everything in
 * it, and refuses when it holds anything the owner did not create; a group
 * of that name without the tags is never touched. There is no SSH key
 * resource: the key is written into the machine, and goes with it.
 *
 * No IPv6: Azure routes it only into a dual-stack virtual network, with a
 * second address configuration on the interface and a second public address
 * billed apart, and whether Debian's Azure image then configures the address
 * has not been checked on a real machine. The security rules take their
 * sources from the Internet tag, which a dual-stack network would extend.
 *
 * Everything that can refuse is read before the first write: the group and
 * what it holds (a resource the owner did not create is never adopted), the
 * location, the size against what Azure sells there to this subscription,
 * the vCPU quota of its family, and the image. The one write that can come
 * before a refusal is the registration of the Microsoft.Compute and
 * Microsoft.Network resource providers on a subscription that never used
 * them, which reading the sizes needs: the portal and the Azure CLI register
 * them the same way, it costs nothing and creates nothing. When the order
 * itself fails, what this run created is deleted again, the resource group
 * whole when this run created it.
 *
 * The credentials: the subscription, and either a service principal's
 * secret, exchanged at Microsoft Entra for an access token with the client
 * credentials grant, or an access token the signed-in Azure CLI hands out
 * (`discover`). The secret travels in the Authorization header of the token
 * request (client_secret_basic, RFC 6749 2.3.1), or, should Entra refuse it
 * there, in that request's form body, as MSAL sends it; the token in the
 * Authorization header of every call to Resource Manager; neither in an
 * address nor anywhere else. The token goes through `context.secret` first. The retail
 * prices come from Azure's public price list, which takes no credentials and
 * is never sent any.
 *
 * Every call follows no redirect and fails with a ProviderError whose code
 * is one of FAILURE_CODES. The API's error format is `{"error": {"code",
 * "message", "details"}}`; `failureFrom` reads it. Lists follow `nextLink` to
 * the end. Long operations are followed through the Azure-AsyncOperation or
 * Location address the answer gives, every few seconds as Retry-After asks,
 * bounded; such an address, like a `nextLink`, is only followed when it
 * points at the API the token is meant for.
 */
import {
  apiAddress,
  checkRequest,
  DEBIAN,
  formatPrice,
  MANAGED_LABEL,
  patiently,
  ProviderError,
  retryAfter,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type Credentials,
  type DestroyOutcome,
  type Discovery,
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

export const DEFAULT_API = "https://management.azure.com";
export const DEFAULT_LOGIN = "https://login.microsoftonline.com";
export const DEFAULT_PRICES = "https://prices.azure.com";

/** Resource Manager's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_AZURE_API";
/** Microsoft Entra's address, where a service principal's secret is exchanged for a token. */
export const LOGIN_VARIABLE = "SITESOLIDE_AZURE_LOGIN";
/** The retail price list's address. */
export const PRICES_VARIABLE = "SITESOLIDE_AZURE_PRICES";

/** What a service principal's token is asked for: Resource Manager, with what the role allows. */
export const SCOPE = "https://management.azure.com/.default";

/** The variables Azure's SDKs, Terraform's providers and the Azure CLI's documentation use, and one of sitesolide's. */
export const VARIABLES = {
  subscription: "AZURE_SUBSCRIPTION_ID",
  tenant: "AZURE_TENANT_ID",
  client: "AZURE_CLIENT_ID",
  secret: "AZURE_CLIENT_SECRET",
  /** No Azure tool reads a token from the environment: this one is sitesolide's, filled by `discover`. */
  token: "AZURE_ACCESS_TOKEN",
} as const;

/**
 * One api-version per resource provider, each a stable version Microsoft
 * documents: Resource Manager rejects a call without one, and a newer
 * version may change a default (the security type of a machine did).
 */
export const VERSIONS = {
  /** Resource groups, resource providers, tags, the resources of a group. */
  resources: "2021-04-01",
  /** The subscription's locations. */
  subscriptions: "2022-12-01",
  /** Virtual machines, images, usages. */
  compute: "2025-04-01",
  /** Resource SKUs: the sizes sold at a location, and their restrictions. */
  skus: "2021-07-01",
  /** Security groups, virtual networks, public addresses, interfaces. */
  network: "2025-05-01",
  /** The retail price list. */
  prices: "2023-01-01-preview",
} as const;

/** How long each wait lasts at most, and how often it asks when Azure does not say. */
export const WAITS = {
  /** A machine is usually created in one or two minutes. */
  operationMs: 20 * 60_000,
  runningMs: 10 * 60_000,
  /** A resource group with a machine in it takes several minutes to go. */
  deleteMs: 30 * 60_000,
  registerMs: 10 * 60_000,
  pollMs: 5_000,
  /** The longest Retry-After followed: Azure asks for 10 to 60 seconds. */
  longestPollMs: 60_000,
};

/**
 * Nothing beyond what every provider takes: the key is written for the
 * login's account, and the security group holds SECURITY_RULES, WEB_SERVER's
 * rules.
 */
export const SUPPORTS: Supports = {};

/**
 * The account Debian's image creates with the key, with passwordless sudo,
 * is named after the owner: Azure makes the request name one, and refuses
 * `root`. Nor does it take these, which an owner's name could be.
 * https://learn.microsoft.com/rest/api/compute/virtual-machines/create-or-update#osprofile
 */
export const RESERVED_LOGINS: ReadonlySet<string> = new Set([
  "administrator", "admin", "user", "user1", "test", "user2", "test1", "user3", "admin1", "1", "123", "a", "actuser", "adm", "admin2", "aspnet",
  "backup", "console", "david", "guest", "john", "owner", "root", "server", "sql", "support", "support_388945a0", "sys", "test2", "test3", "user4", "user5",
]);

/**
 * Debian's own images on Azure, published by Debian:
 * https://wiki.debian.org/Cloud/MicrosoftAzure. `13-gen2` boots in UEFI,
 * which every current size takes; `13` is the BIOS image older sizes need.
 */
export const DEBIAN_IMAGE = { publisher: "Debian", offer: "debian-13", gen1: "13", gen2: "13-gen2", arm64: "13-arm64", version: "latest" } as const;

/**
 * The cheapest current x86 size with 2 GB of memory at least: Basv2, AMD,
 * 2 vCPU and 4 GiB, about 32 USD a month at Frankfurt in October 2026.
 * Standard_B2ats_v2 is cheaper but has 1 GiB; Standard_B1ms has 2 GiB but is
 * a B-series v1, end of life since July 2026, which new subscriptions can no
 * longer deploy. Frankfurt, as Hetzner's default is Germany too.
 */
export const DEFAULTS = { type: "Standard_B2als_v2", location: "germanywestcentral", image: DEBIAN } as const;

/**
 * The sizes the wizard offers, when Azure sells them at the location: the
 * burstable v2 B-series and the v5 D-series, x86 and arm. The v6 sizes are
 * left out: they only attach disks over NVMe, which Microsoft does not list
 * Debian 13 as supporting yet. `--type` takes any size all the same.
 */
export const OFFERED_SIZES = [
  "Standard_B2als_v2",
  "Standard_B2pls_v2",
  "Standard_B2ls_v2",
  "Standard_B2as_v2",
  "Standard_B2s_v2",
  "Standard_B2ps_v2",
  "Standard_B4als_v2",
  "Standard_B4as_v2",
  "Standard_D2ls_v5",
  "Standard_D2as_v5",
  "Standard_D2s_v5",
  "Standard_D4as_v5",
] as const;

/** One subnet in one network: the machine is alone in it. */
export const NETWORK = { space: "10.0.0.0/16", subnet: "10.0.0.0/24" } as const;

/** The disk Azure creates for the system: SSD, the cheapest kind Azure sells as such. */
export const DISK_TYPE = "StandardSSD_LRS";

/** Azure's own convention for a month of hourly prices. */
export const HOURS_A_MONTH = 730;

function rule(name: string, priority: number, protocol: string, port: string) {
  return {
    name,
    properties: {
      description: name,
      priority,
      direction: "Inbound",
      access: "Allow",
      protocol,
      sourceAddressPrefix: "Internet",
      sourcePortRange: "*",
      destinationAddressPrefix: "*",
      destinationPortRange: port,
    },
  };
}

/** What the security group lets in; Azure's DenyAllInBound, at priority 65500, drops the rest. */
export const SECURITY_RULES = [
  rule("ssh", 100, "Tcp", "22"),
  rule("http", 110, "Tcp", "80"),
  rule("https", 120, "Tcp", "443"),
  // Ping serves diagnosis and external monitoring.
  rule("ping", 130, "Icmp", "*"),
];

/** The resource providers a machine needs registered on the subscription. */
export const NAMESPACES = ["Microsoft.Compute", "Microsoft.Network"] as const;

/** The names of what makes a machine: the group's carries the owner's, what it holds the machine's alone. */
export function namesFor(name: string, owner: Owner) {
  return { group: `${owner.name}-${name}`, nsg: `${name}-nsg`, vnet: `${name}-vnet`, subnet: `${name}-subnet`, ip: `${name}-ip`, nic: `${name}-nic`, vm: name, disk: `${name}-osdisk` };
}

// --- shapes --------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A tenant is named by its ID or by one of its domains. */
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
/** Printable ASCII without spaces, quotes or backslashes: what a client secret is made of. */
const CLIENT_SECRET = /^[!#-&(-[\]-_a-~]{8,256}$/;
/** A JWT, or the five parts of an encrypted one: a few thousand characters of base64url. */
const ACCESS_TOKEN = /^(?=.{100,16384}$)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*){2,4}$/;
/** What a machine's name is (the program checks it), and therefore what can go in a path. */
const MACHINE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCATION = /^[a-z0-9]{2,40}$/;
const SIZE = /^[A-Za-z0-9_]{2,80}$/;
const IMAGE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// --- the API's objects, as far as this file reads them ---------------------------------------

type Tags = Record<string, string>;

export type AzureGroup = { id?: string; name: string; location: string; tags?: Tags; properties?: { provisioningState?: string } };

export type AzureVm = {
  id: string;
  name: string;
  location?: string;
  tags?: Tags;
  properties?: {
    vmId?: string;
    provisioningState?: string;
    hardwareProfile?: { vmSize?: string };
    storageProfile?: { osDisk?: { name?: string; managedDisk?: { id?: string } } };
    instanceView?: { statuses?: { code?: string; displayStatus?: string; message?: string }[] };
  };
};

export type AzurePublicIp = { id: string; name: string; tags?: Tags; properties?: { ipAddress?: string; provisioningState?: string; publicIPAllocationMethod?: string } };

type AzureResource = { id: string; name: string; type?: string; tags?: Tags; managedBy?: string; properties?: { provisioningState?: string } };

export type AzureLocation = {
  name: string;
  displayName?: string;
  type?: string;
  metadata?: { regionType?: string; regionCategory?: string; geography?: string; geographyGroup?: string; physicalLocation?: string };
};

export type AzureSku = {
  resourceType: string;
  name: string;
  family?: string;
  locations?: string[];
  capabilities?: { name: string; value: string }[];
  restrictions?: { type?: string; values?: string[]; reasonCode?: string }[];
};

type AzureUsage = { currentValue: number; limit: number; name?: { value?: string; localizedValue?: string } };

export type RetailPrice = {
  currencyCode?: string;
  retailPrice?: number;
  armRegionName?: string;
  armSkuName?: string;
  productName?: string;
  meterName?: string;
  skuName?: string;
  type?: string;
  unitOfMeasure?: string;
  isPrimaryMeterRegion?: boolean;
};

export type ImageReference = { publisher: string; offer: string; sku: string; version: string };

// --- reading the API's answers ----------------------------------------------------------------

/** A failure of the API, its HTTP status and its own code kept for the callers that tell them apart. */
export class AzureError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly code: string,
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/** The codes of a size Azure cannot place right now, at the order or while it runs. */
const OFFER_CODES = new Set([
  "SkuNotAvailable",
  "AllocationFailed",
  "ZonalAllocationFailed",
  "OverconstrainedAllocationRequest",
  "OverconstrainedZonalAllocationRequest",
]);

/** The codes of an operation that will succeed once another one ends. */
const BUSY_CODES = new Set(["Conflict", "AnotherOperationInProgress", "ResourceGroupBeingDeleted", "RetryableError", "OperationPreempted"]);

const ROLE_HELP = "the credentials need the Contributor role on the subscription: in the portal, Subscriptions, the subscription, Access control (IAM); a role granted a moment ago takes a few minutes to apply";

function isLimit(code: string, said: string): boolean {
  return code === "QuotaExceeded" || code === "PublicIPCountLimitReached" || (code === "OperationNotAllowed" && /quota/i.test(said));
}

/** `error.details`, the nested errors Azure gives the reasons in, one line each. */
function nestedDetails(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.slice(0, 3).map((entry) => {
    const { code, message } = (entry ?? {}) as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => typeof part === "string" && part !== "").join(": ");
  }).filter((line) => line !== "");
}

/**
 * An error answer of Resource Manager as a failure the CLI reports, with the
 * code its hint is found by. `what` says what was being done, in the
 * infinitive, for the message: `create the virtual machine web`.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string): AzureError {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "";
  const said = typeof error?.message === "string" ? error.message : `answered ${status}`;
  const details = nestedDetails(error?.details);
  const answer = `${status}${code === "" ? "" : ` ${code}`}`;
  const make = (failure: Failure) => new AzureError(failure, status, code, said);

  if (status === 401) {
    const why: Record<string, string> = {
      ExpiredAuthenticationToken: "an access token lasts about an hour: sign in again with az login, or give a service principal's secret, which is exchanged for a token at each run",
      InvalidAuthenticationTokenTenant: "the token belongs to another tenant than the subscription's: sign in to that tenant (az login --tenant), or set AZURE_TENANT_ID to it",
    };
    return make({
      error: "provider-unauthenticated",
      message: `Azure refused the credentials (${answer}): ${said}`,
      details: [why[code] ?? "the token is unknown, expired, or was copied wrong"],
    });
  }
  if (code === "RequestDisallowedByPolicy") {
    return make({ error: "provider-invalid", message: `an Azure Policy of the subscription refuses to ${what} (${answer}): ${said}`, details: [...details, "the subscription's owner decides its policies, in the portal under Policy"] });
  }
  if (status === 403 || code === "AuthorizationFailed") {
    return make({ error: "provider-forbidden", message: `the credentials may not ${what} (${answer}): ${said}`, details: [ROLE_HELP] });
  }
  if (code === "MissingSubscriptionRegistration") {
    return make({
      error: "provider-invalid",
      message: `Azure refused to ${what} (${answer}): ${said}`,
      details: ["creating a machine registers Microsoft.Compute and Microsoft.Network itself; or run az provider register --namespace with the namespace Azure names"],
    });
  }
  if (isLimit(code, said)) {
    return make({
      error: "provider-limit",
      message: `Azure refused to ${what} (${answer}): ${said}`,
      details:
        code === "PublicIPCountLimitReached"
          ? ["the subscription holds as many public IP addresses as its quota allows at that location: delete one it no longer needs, or raise the quota in the portal, under Quotas, then Networking"]
          : ["raise the quota in the portal, under Quotas, then Compute; a new subscription often starts at zero for a family", "or pick a --type of another family"],
    });
  }
  if (OFFER_CODES.has(code)) return make({ error: "type-unavailable", message: `Azure could not ${what} (${answer}): ${said}`, details });
  if (status === 404) return make({ error: "provider-not-found", message: `Azure could not ${what} (${answer}): ${said}`, details });
  if (BUSY_CODES.has(code)) return make({ error: "provider-busy", message: `Azure could not ${what} right now (${answer}): ${said}`, details });
  if (status === 429) {
    return make({
      error: "provider-rate-limited",
      message: `Azure's rate limit is reached, nothing more can be asked of it for now (${answer})`,
      details: ["Resource Manager gives requests back to a subscription gradually"],
      wait: retryAfter(headers),
    });
  }
  if (status >= 500) return make({ error: "provider-failure", message: `Azure failed to ${what} (${answer}): ${said}`, details: [...details, "the failure is on Azure's side"] });
  return make({ error: "provider-invalid", message: `Azure refused to ${what} (${answer}): ${said}`, details });
}

/**
 * An operation Azure ran and ended in `Failed` or `Canceled`, said in the
 * words of the code it gives: a size it could not place, a quota, or the
 * reason it names.
 */
export function operationFailure(error: { code?: unknown; message?: unknown } | undefined, label: string, status: string): AzureError {
  const code = typeof error?.code === "string" ? error.code : "";
  const said = typeof error?.message === "string" ? error.message : `the operation ended ${status}`;
  if (isLimit(code, said)) return new AzureError({ error: "provider-limit", message: `Azure's ${label} failed (${code}): ${said}`, details: ["raise the quota in the portal, under Quotas, then Compute"] }, 200, code, said);
  if (OFFER_CODES.has(code)) return new AzureError({ error: "type-unavailable", message: `Azure's ${label} failed (${code}): ${said}` }, 200, code, said);
  return new AzureError({ error: "action-failed", message: `Azure's ${label} failed: ${said}`, details: [code === "" ? `status ${status}` : code] }, 200, code, said);
}

/**
 * An error answer of Microsoft Entra's token endpoint: `{"error",
 * "error_description", "error_codes"}`. The description's first line names
 * the AADSTS code and the reason; the client ID may be in it, never the secret.
 */
export function loginFailure(status: number, body: unknown, headers: Headers): ProviderError {
  const answer = body as { error?: unknown; error_description?: unknown; error_codes?: unknown } | null;
  const error = typeof answer?.error === "string" ? answer.error : "";
  const said = typeof answer?.error_description === "string" ? (answer.error_description.split(/\r?\n/)[0] ?? "") : `answered ${status}`;
  const codes = Array.isArray(answer?.error_codes) ? answer.error_codes.map(Number) : [];
  const tagged = `${status}${error === "" ? "" : ` ${error}`}`;
  if (status === 429) {
    return new ProviderError({ error: "provider-rate-limited", message: `Microsoft Entra's rate limit is reached (${tagged})`, wait: retryAfter(headers) });
  }
  if (status >= 500) return new ProviderError({ error: "provider-failure", message: `Microsoft Entra failed to sign the service principal in (${tagged}): ${said}`, details: ["the failure is on Microsoft's side"] });
  const why: Record<number, string> = {
    7000215: "the client secret is wrong: copy its Value, not its Secret ID, from the app registration's Certificates & secrets",
    7000222: "the client secret has expired: create another under the app registration's Certificates & secrets",
    700016: "no application of that client ID in that tenant: check AZURE_CLIENT_ID and AZURE_TENANT_ID",
    90002: "no tenant of that ID: check AZURE_TENANT_ID",
    900023: "AZURE_TENANT_ID is not a tenant ID nor one of its domains",
  };
  const reason = codes.map((code) => why[code]).find((line) => line !== undefined);
  if (["invalid_client", "unauthorized_client", "invalid_grant"].includes(error) || reason !== undefined || status === 401) {
    return new ProviderError({ error: "provider-unauthenticated", message: `Microsoft Entra refused the service principal (${tagged}): ${said}`, details: [reason ?? "the tenant, the client ID or the secret is wrong, or the secret has expired"] });
  }
  return new ProviderError({ error: "provider-invalid", message: `Microsoft Entra refused to sign the service principal in (${tagged}): ${said}` });
}

// --- what the answers mean --------------------------------------------------------------------

function ownedBy(tags: Tags | undefined | null, name: string, owner: Owner): boolean {
  return owner.manages(tags) && tags?.[owner.machineLabel] === name;
}

function capability(sku: AzureSku, name: string): string | undefined {
  return sku.capabilities?.find((entry) => entry.name === name)?.value;
}

/** Why Azure will not sell a size at a location to this subscription, or null when it will. */
export function restrictionAt(sku: AzureSku, location: string): string | null {
  const found = sku.restrictions?.find((entry) => entry.type === "Location" && (entry.values ?? []).some((value) => value.toLowerCase() === location));
  return found === undefined ? null : (found.reasonCode ?? "restricted");
}

/** `2 vCPU, 4 GB RAM, x86, 31.54 USD a month before VAT`. */
export function describeSize(sku: AzureSku, monthly: number | undefined): string {
  const architecture = capability(sku, "CpuArchitectureType") === "Arm64" ? "arm" : "x86";
  const cost = monthly === undefined ? "" : `, ${formatPrice(monthly, "USD")}`;
  return `${capability(sku, "vCPUs") ?? "?"} vCPU, ${capability(sku, "MemoryGB") ?? "?"} GB RAM, ${architecture}${cost}`;
}

/** The image a request names, for that size: `debian-13` as Debian publishes it, or an image URN. */
export function imageFor(image: string, sku: AzureSku): ImageReference | Failure {
  if (image === DEBIAN) {
    const arm = capability(sku, "CpuArchitectureType") === "Arm64";
    const generations = (capability(sku, "HyperVGenerations") ?? "V1").split(",").map((entry) => entry.trim());
    const variant = arm ? DEBIAN_IMAGE.arm64 : generations.includes("V2") ? DEBIAN_IMAGE.gen2 : DEBIAN_IMAGE.gen1;
    return { publisher: DEBIAN_IMAGE.publisher, offer: DEBIAN_IMAGE.offer, sku: variant, version: DEBIAN_IMAGE.version };
  }
  const parts = image.split(":");
  if (parts.length === 4 && parts.every((part) => IMAGE_PART.test(part))) {
    const [publisher, offer, variant, version] = parts as [string, string, string, string];
    return { publisher, offer, sku: variant, version };
  }
  return {
    error: "provider-invalid",
    message: `Azure takes ${DEBIAN} or an image URN, publisher:offer:sku:version, as --image`,
    details: [`${DEBIAN} is ${DEBIAN_IMAGE.publisher}:${DEBIAN_IMAGE.offer}:${DEBIAN_IMAGE.gen2}:latest on x86, ${DEBIAN_IMAGE.arm64} on arm`],
  };
}

export function urn(image: ImageReference): string {
  return `${image.publisher}:${image.offer}:${image.sku}:${image.version}`;
}

/** The size of an RSA key's modulus, in bits, from the blob of its `.pub`; null when it cannot be read. */
export function rsaBits(blob: string): number | null {
  const bytes = Buffer.from(blob, "base64");
  let offset = 0;
  const field = (): Buffer | null => {
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + length > bytes.length) return null;
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const kind = field();
  if (kind === null || kind.toString() !== "ssh-rsa" || field() === null) return null;
  const modulus = field();
  if (modulus === null) return null;
  let start = 0;
  while (start < modulus.length && modulus[start] === 0) start++;
  if (start === modulus.length) return null;
  return (modulus.length - start) * 8 - Math.clz32(modulus[start]!) + 24;
}

/**
 * Why Azure would not take a key, in one line, or null when it takes it:
 * Ed25519, or RSA of 2048 bits at least, and no other kind.
 * https://learn.microsoft.com/azure/virtual-machines/linux/mac-create-ssh-keys
 */
export function keyProblem(key: PublicKey): string | null {
  if (key.algorithm === "ssh-ed25519") return null;
  if (key.algorithm === "ssh-rsa") {
    const bits = rsaBits(key.blob);
    if (bits !== null && bits >= 2048) return null;
    return `an RSA key needs 2048 bits at least, and this one has ${bits ?? "an unreadable number of"} bits`;
  }
  return `only ssh-ed25519 and ssh-rsa keys are taken, not ${key.algorithm}`;
}

/** The same, as a refusal of `create`, which checks it again before any request. */
export function keyRefusal(key: PublicKey): Failure | null {
  const problem = keyProblem(key);
  if (problem === null) return null;
  return { error: "provider-invalid", message: `Azure would not take the key: ${problem}`, details: ["pass another key with --ssh-key, or make one: ssh-keygen -t ed25519"] };
}

/** The power state Azure gives a machine, `running`, `deallocated`...; its provisioning state when it gives none. */
export function powerState(vm: AzureVm): string {
  const statuses = vm.properties?.instanceView?.statuses ?? [];
  const power = statuses.find((status) => status.code?.startsWith("PowerState/"))?.code?.slice("PowerState/".length);
  if (power !== undefined) return power;
  return (vm.properties?.provisioningState ?? "unknown").toLowerCase();
}

export function toMachine(name: string, group: AzureGroup, vm: AzureVm | null, ip: AzurePublicIp | null, owner: Owner): Machine {
  const managed = ownedBy(group.tags, name, owner);
  const groupState = (group.properties?.provisioningState ?? "unknown").toLowerCase();
  return {
    provider: "azure",
    id: group.name,
    name,
    type: vm?.properties?.hardwareProfile?.vmSize ?? (managed ? "none" : "unknown"),
    location: group.location,
    // A group of ours without its machine is a run that stopped halfway: the next one finishes it.
    status: vm !== null ? powerState(vm) : !managed ? groupState : groupState === "deleting" ? "deleting" : "incomplete",
    ipv4: ip?.properties?.ipAddress ?? null,
    ipv6: null,
    ipv6Network: null,
    // The API gives no price; the public price list's is a list price, which
    // ignores what the account is charged and the disk and address beside it.
    monthlyPrice: null,
    backups: false,
    managed,
    labels: group.tags ?? {},
    login: owner.name,
  };
}

/** `Frankfurt, Germany`, from what the subscription's list of locations says of one. */
export function locationLabel(location: AzureLocation): string {
  const place = location.metadata?.physicalLocation;
  const country = location.metadata?.geography;
  if (place !== undefined && country !== undefined && place !== country) return `${place}, ${country}`;
  return location.displayName ?? location.name;
}

/** A line of the price list that is a Linux machine's pay-as-you-go hourly price, in USD. */
export function linuxOnDemand(item: RetailPrice): boolean {
  return (
    item.type === "Consumption" &&
    item.unitOfMeasure === "1 Hour" &&
    item.currencyCode === "USD" &&
    item.isPrimaryMeterRegion !== false &&
    typeof item.retailPrice === "number" &&
    (item.productName ?? "").startsWith("Virtual Machines") &&
    !(item.productName ?? "").endsWith("Windows") &&
    !/(Spot|Low Priority)$/.test(item.meterName ?? "") &&
    !/(Spot|Low Priority)$/.test(item.skuName ?? "")
  );
}

/** Says a resource of a group's listing for a person: `public IPv4 web-ip (203.0.113.10)`. */
function describeResource(resource: AzureResource, ipv4: string | null): string {
  const kinds: Record<string, string> = {
    "microsoft.compute/virtualmachines": "virtual machine",
    "microsoft.compute/disks": "disk",
    "microsoft.network/networkinterfaces": "network interface",
    "microsoft.network/publicipaddresses": "public IPv4",
    "microsoft.network/networksecuritygroups": "network security group",
    "microsoft.network/virtualnetworks": "virtual network",
  };
  const type = (resource.type ?? "").toLowerCase();
  const kind = kinds[type] ?? resource.type ?? "resource";
  const address = type === "microsoft.network/publicipaddresses" && ipv4 !== null ? ` (${ipv4})` : "";
  return `${kind} ${resource.name}${address}`;
}

/** A resource's ID without the subscription it lives in, which a person never needs to read. */
function shortId(id: string | undefined, fallback: string): string {
  return (id ?? fallback).replace(/^\/subscriptions\/[^/]+/i, "");
}

// --- the credentials ---------------------------------------------------------------------------

type SignIn = { subscription: string; token: string | null; principal: { tenant: string; client: string; secret: string } | null };

const CREDENTIAL_HELP = [
  "sign in with the Azure CLI (az login): sitesolide asks it for a token; AZURE_SUBSCRIPTION_ID picks the subscription when it is not the CLI's default",
  "or create a service principal with the Contributor role on the subscription: az ad sp create-for-rbac --name sitesolide --role Contributor --scopes /subscriptions/<subscription ID>, then set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET to its tenant, appId and password",
  "a subscription of its own for sitesolide keeps the credentials away from everything else you run at Azure",
];

/** The credentials a provider is opened with, or why they cannot sign in: never a value. */
function signIn(credentials: Credentials): SignIn {
  const value = (variable: string) => credentials[variable]?.trim() ?? "";
  const subscription = value(VARIABLES.subscription);
  if (!UUID.test(subscription)) {
    throw new ProviderError({
      error: "no-provider-token",
      message: subscription === "" ? `no Azure subscription: set ${VARIABLES.subscription}` : `${VARIABLES.subscription} is not a subscription ID`,
      details: CREDENTIAL_HELP,
    });
  }
  const token = value(VARIABLES.token);
  if (token !== "") {
    if (!ACCESS_TOKEN.test(token)) throw new ProviderError({ error: "no-provider-token", message: `what ${VARIABLES.token} holds is not an access token`, details: CREDENTIAL_HELP });
    return { subscription, token, principal: null };
  }
  const tenant = value(VARIABLES.tenant);
  const client = value(VARIABLES.client);
  const secret = value(VARIABLES.secret);
  const missing = [VARIABLES.tenant, VARIABLES.client, VARIABLES.secret].filter((variable) => value(variable) === "");
  if (missing.length > 0) {
    throw new ProviderError({
      error: "no-provider-token",
      message: `no Azure credentials to sign in with: set ${missing.join(", ")}, or sign in with the Azure CLI (az login)`,
      details: CREDENTIAL_HELP,
    });
  }
  if (!TENANT.test(tenant) || !UUID.test(client) || !CLIENT_SECRET.test(secret)) {
    throw new ProviderError({ error: "no-provider-token", message: `${VARIABLES.tenant}, ${VARIABLES.client} or ${VARIABLES.secret} does not have the shape of one`, details: CREDENTIAL_HELP });
  }
  return { subscription, token: null, principal: { tenant, client, secret } };
}

/**
 * A token from the Azure CLI, signed in, for the subscription the
 * environment names or the CLI's default one. Null when the CLI is missing,
 * signed out, or answers something else.
 */
export async function discoverAzureCli(workstation: Workstation): Promise<Discovery | null> {
  const wanted = workstation.environment[VARIABLES.subscription]?.trim() ?? "";
  const answer = await workstation.run([
    "az",
    "account",
    "get-access-token",
    "--resource",
    "https://management.azure.com/",
    "--output",
    "json",
    ...(UUID.test(wanted) ? ["--subscription", wanted] : []),
  ]);
  if (answer.code !== 0) return null;
  let parsed: { accessToken?: unknown; subscription?: unknown; tenant?: unknown; expires_on?: unknown };
  try {
    parsed = JSON.parse(answer.stdout) as typeof parsed;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const token = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
  const subscription = typeof parsed.subscription === "string" ? parsed.subscription : wanted;
  const tenant = typeof parsed.tenant === "string" ? parsed.tenant : "";
  if (!ACCESS_TOKEN.test(token) || !UUID.test(subscription) || !TENANT.test(tenant)) return null;
  return {
    source: "the Azure CLI, signed in",
    credentials: { [VARIABLES.subscription]: subscription, [VARIABLES.tenant]: tenant, [VARIABLES.token]: token },
  };
}

// --- the provider ---------------------------------------------------------------------------

type Answer = { status: number; headers: Headers; body: unknown };
/** What this run created, to undo when the order fails. */
type Made = { kind: string; name: string; path: string; version: string };

export function azure(context: ProviderContext): Provider {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const loginBase = apiAddress(context.environment, LOGIN_VARIABLE, DEFAULT_LOGIN);
  const pricesBase = apiAddress(context.environment, PRICES_VARIABLE, DEFAULT_PRICES);
  const host = new URL(base).host;
  const { clock, fetcher, owner } = context;
  /** The account the key is written for: see RESERVED_LOGINS. */
  const login = owner.name;
  const credentials = signIn(context.credentials);
  const subscriptionPath = `/subscriptions/${credentials.subscription}`;

  /** The address of a call: `$filter` and the like as they are, every value encoded, the api-version last. */
  function armUrl(path: string, version: string, query: Record<string, string> = {}): string {
    const parameters = [...Object.entries(query).map(([key, value]) => `${key}=${encodeURIComponent(value)}`), `api-version=${version}`];
    return `${base}${path}?${parameters.join("&")}`;
  }

  /** An address an answer gives to follow, kept only when it is the API's own: the token goes with it. */
  function followable(link: string, what: string, origin = base): string {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new AzureError({ error: "provider-unreadable", message: `${host} answered with an address that is not one, while trying to ${what}` }, 200, "");
    }
    const expected = new URL(origin);
    if (url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname.replace(/\/$/, ""))) {
      throw new AzureError({ error: "provider-unreadable", message: `${host} gave an address at ${url.host} to follow, while trying to ${what}: it is not followed` }, 200, "");
    }
    return url.toString();
  }

  // --- the token

  let exchanged: { value: string; until: number } | null = null;

  /**
   * A service principal's token, exchanged for its secret, kept until five
   * minutes before it expires. The client ID and the secret go first in the
   * Authorization header (client_secret_basic, RFC 6749 2.3.1, which Entra
   * documents); should Entra answer `invalid_client`, once more in the form
   * body (client_secret_post), as MSAL and the Azure CLI send them. Never in
   * the address.
   */
  async function exchange(principal: { tenant: string; client: string; secret: string }): Promise<{ value: string; until: number }> {
    const loginHost = new URL(loginBase).host;
    const scope = `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`;
    const attempt = async (style: "basic" | "post"): Promise<{ response: Response; body: unknown }> => {
      let response: Response;
      try {
        response = await fetcher(`${loginBase}/${encodeURIComponent(principal.tenant)}/oauth2/v2.0/token`, {
          method: "POST",
          redirect: "error",
          headers: {
            ...(style === "basic" ? { Authorization: `Basic ${btoa(`${encodeURIComponent(principal.client)}:${encodeURIComponent(principal.secret)}`)}` } : {}),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: style === "basic" ? scope : `${scope}&client_id=${encodeURIComponent(principal.client)}&client_secret=${encodeURIComponent(principal.secret)}`,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        throw new ProviderError({ error: "provider-unreachable", message: `${loginHost} unreachable while signing the service principal in: ${(error as Error).message}` });
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        if (response.ok || (response.status < 500 && response.status !== 429)) {
          throw new ProviderError({ error: "provider-unreadable", message: `${loginHost} answered ${response.status} with something that is not Microsoft Entra's token endpoint` });
        }
      }
      return { response, body };
    };
    let { response, body } = await attempt("basic");
    if (!response.ok && (body as { error?: unknown } | null)?.error === "invalid_client") ({ response, body } = await attempt("post"));
    if (!response.ok) throw loginFailure(response.status, body, response.headers);
    const answer = body as { access_token?: unknown; expires_in?: unknown } | null;
    const token = typeof answer?.access_token === "string" ? answer.access_token : "";
    if (token === "") throw new ProviderError({ error: "provider-unreadable", message: `${loginHost} answered without an access token` });
    context.secret(token);
    const lifetime = Number(answer?.expires_in);
    const seconds = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600;
    return { value: token, until: clock.now() + Math.max(60, seconds - 300) * 1000 };
  }

  async function bearer(): Promise<string> {
    if (credentials.token !== null) return credentials.token;
    if (exchanged === null || clock.now() >= exchanged.until) exchanged = await exchange(credentials.principal!);
    return exchanged.value;
  }

  // --- the calls

  /** One call: the token in its header, JSON both ways, every failure said in the CLI's words. */
  async function send(method: string, url: string, what: string, extra: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
    const token = await bearer();
    let response: Response;
    let text: string;
    try {
      response = await fetcher(url, {
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
      // The message of a failed fetch names the address at most, which holds
      // no credential; it is scrubbed all the same, on the way out.
      throw new AzureError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, "");
    }
    let body: unknown = null;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        // A proxy in front of the API may answer a 502 or a 429 in HTML:
        // still Azure saying "later". Anything else that is not JSON is not its API.
        if (response.status < 500 && response.status !== 429) {
          throw new AzureError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Azure's API, while trying to ${what}` }, response.status, "");
        }
      }
    }
    if (!response.ok) throw failureFrom(response.status, body, response.headers, what);
    return { status: response.status, headers: response.headers, body };
  }

  async function call<T>(method: string, path: string, version: string, what: string, extra: { body?: unknown; headers?: Record<string, string>; query?: Record<string, string> } = {}): Promise<T> {
    const answer = await send(method, armUrl(path, version, extra.query), what, extra);
    if (method === "GET" && (answer.body === null || typeof answer.body !== "object")) {
      throw new AzureError({ error: "provider-unreadable", message: `${host} answered ${answer.status} without a body, while trying to ${what}` }, answer.status, "");
    }
    return answer.body as T;
  }

  /** A resource, or null when Azure says it does not exist. */
  async function read<T>(path: string, version: string, what: string, query: Record<string, string> = {}): Promise<T | null> {
    try {
      return await call<T>("GET", path, version, what, { query });
    } catch (error) {
      if (error instanceof AzureError && error.status === 404) return null;
      throw error;
    }
  }

  /** Every page of a list, following `nextLink`. */
  async function listAll<T>(path: string, version: string, what: string, query: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = armUrl(path, version, query);
    for (let pages = 0; next !== null && pages < 500; pages++) {
      const answer = await send("GET", next, what);
      const page = answer.body as { value?: unknown; nextLink?: unknown } | null;
      if (!Array.isArray(page?.value)) {
        throw new AzureError({ error: "provider-unreadable", message: `${host} answered without the list, while trying to ${what}` }, answer.status, "");
      }
      items.push(...(page.value as T[]));
      next = typeof page.nextLink === "string" && page.nextLink !== "" ? followable(page.nextLink, what) : null;
    }
    return items;
  }

  /** The milliseconds Retry-After asks for, within reason, else the usual pause. */
  function pause(headers: Headers | null): number {
    if (headers === null) return WAITS.pollMs;
    return Math.min(WAITS.longestPollMs, Math.max(1_000, retryAfter(headers, WAITS.pollMs / 1000) * 1000));
  }

  function timeout(label: string, limitMs: number, state: string): AzureError {
    return new AzureError({ error: "machine-timeout", message: `Azure's ${label} still runs after ${limitMs / 60_000} minutes`, details: [`last status: ${state || "unread"}`] }, 0, "");
  }

  /**
   * Waits for what an answer started: through Azure-AsyncOperation when it
   * gives one, else through Location, else by reading the resource until its
   * provisioning state ends. `resource.gone` waits for a deletion instead.
   */
  async function settle(answer: Answer, label: string, report: Report, resource: { path: string; version: string; gone?: boolean } | null, limitMs = WAITS.operationMs): Promise<void> {
    const deadline = clock.now() + limitMs;
    const warned = { done: false };
    const asyncOperation = answer.headers.get("Azure-AsyncOperation");
    const location = answer.headers.get("Location");
    let headers: Headers | null = answer.headers;
    let shown = "";
    const show = (state: string) => {
      if (state !== shown) report(`   ${state === "Succeeded" ? "done" : state === "InProgress" ? "in progress" : state.toLowerCase()}`);
      shown = state;
    };

    if (asyncOperation !== null && asyncOperation !== "") {
      const url = followable(asyncOperation, `follow ${label}`);
      for (;;) {
        await clock.sleep(pause(headers));
        const read = await patiently(clock, () => send("GET", url, `follow ${label}`), deadline, report, warned);
        if (read !== null) {
          const status = (read.body as { status?: unknown; error?: { code?: unknown; message?: unknown } } | null) ?? {};
          const state = typeof status.status === "string" ? status.status : "";
          show(state || "unread");
          if (state === "Succeeded") return;
          if (state === "Failed" || state === "Canceled") throw operationFailure(status.error, label, state);
          headers = read.headers;
        }
        if (clock.now() >= deadline) throw timeout(label, limitMs, shown);
      }
    }

    if (answer.status === 202 && location !== null && location !== "") {
      const url = followable(location, `follow ${label}`);
      for (;;) {
        await clock.sleep(pause(headers));
        const read = await patiently(clock, () => send("GET", url, `follow ${label}`), deadline, report, warned);
        if (read !== null) {
          if (read.status !== 202) {
            show("Succeeded");
            return;
          }
          show("InProgress");
          headers = read.headers;
        }
        if (clock.now() >= deadline) throw timeout(label, limitMs, shown);
      }
    }

    // No address to follow: the answer, then the resource itself, say whether it is done.
    const first = (answer.body as { properties?: { provisioningState?: unknown } } | null)?.properties?.provisioningState;
    let state = typeof first === "string" ? first : resource?.gone === true && answer.status === 202 ? "Deleting" : "Succeeded";
    for (;;) {
      if (state === "Succeeded") return show(state);
      if (state === "Failed" || state === "Canceled") throw operationFailure(undefined, label, state);
      if (resource === null) return;
      show(state);
      if (clock.now() >= deadline) throw timeout(label, limitMs, state);
      await clock.sleep(pause(headers));
      headers = null;
      const target = resource;
      // Wrapped, so that a tolerated failure (null) is not taken for a resource that is gone.
      const outcome = await patiently(
        clock,
        async () => ({ found: await read<{ properties?: { provisioningState?: unknown } }>(target.path, target.version, `follow ${label}`) }),
        deadline,
        report,
        warned,
      );
      if (outcome === null) continue;
      if (outcome.found === null) {
        if (target.gone === true) return show("Succeeded");
        throw new AzureError({ error: "provider-not-found", message: `the resource disappeared during the ${label}` }, 404, "");
      }
      const next = outcome.found.properties?.provisioningState;
      state = typeof next === "string" ? next : "Succeeded";
    }
  }

  // --- paths

  const groupPath = (group: string) => `${subscriptionPath}/resourcegroups/${group}`;
  const inGroup = (group: string, provider: string, type: string, name: string) => `${subscriptionPath}/resourceGroups/${group}/providers/${provider}/${type}/${name}`;
  const paths = (name: string) => {
    const names = namesFor(name, owner);
    return {
      names,
      group: groupPath(names.group),
      nsg: inGroup(names.group, "Microsoft.Network", "networkSecurityGroups", names.nsg),
      vnet: inGroup(names.group, "Microsoft.Network", "virtualNetworks", names.vnet),
      ip: inGroup(names.group, "Microsoft.Network", "publicIPAddresses", names.ip),
      nic: inGroup(names.group, "Microsoft.Network", "networkInterfaces", names.nic),
      vm: inGroup(names.group, "Microsoft.Compute", "virtualMachines", names.vm),
    };
  };

  function checkName(name: string): void {
    if (!MACHINE_NAME.test(name)) throw new ProviderError({ error: "machine-name", message: `not a machine name: ${name}` });
  }

  // --- what Azure sells, and where

  let regionsRead: Promise<AzureLocation[]> | null = null;
  function regions(): Promise<AzureLocation[]> {
    regionsRead ??= listAll<AzureLocation>(`${subscriptionPath}/locations`, VERSIONS.subscriptions, "read the locations").then((all) =>
      all.filter((location) => (location.type ?? "Region") === "Region" && location.metadata?.regionType === "Physical"),
    );
    return regionsRead;
  }

  const sizesRead = new Map<string, Promise<AzureSku[]>>();
  function sizesAt(location: string): Promise<AzureSku[]> {
    let found = sizesRead.get(location);
    if (found === undefined) {
      found = listAll<AzureSku>(`${subscriptionPath}/providers/Microsoft.Compute/skus`, VERSIONS.skus, `read the sizes sold at ${location}`, { $filter: `location eq '${location}'` }).then((all) =>
        all.filter((sku) => sku.resourceType === "virtualMachines" && (sku.locations ?? []).some((entry) => entry.toLowerCase() === location)),
      );
      sizesRead.set(location, found);
    }
    return found;
  }

  /**
   * The monthly list prices of sizes at a location, from Azure's public price
   * list: Linux, pay as you go, hourly times 730, in USD, Microsoft's own
   * currency for Azure. No credential goes there. A list that cannot be read
   * leaves the prices out and stops nothing.
   */
  async function monthlyPrices(location: string, sizes: readonly string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const wanted = sizes.filter((size) => SIZE.test(size));
    if (wanted.length === 0 || !LOCATION.test(location)) return prices;
    const filter = `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and armRegionName eq '${location}' and (${wanted.map((size) => `armSkuName eq '${size}'`).join(" or ")})`;
    let next: string | null = `${pricesBase}/api/retail/prices?api-version=${VERSIONS.prices}&meterRegion=${encodeURIComponent("'primary'")}&$filter=${encodeURIComponent(filter)}`;
    try {
      for (let pages = 0; next !== null && pages < 10; pages++) {
        const response: Response = await fetcher(next, { redirect: "error", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
        if (!response.ok) break;
        const page = (await response.json()) as { Items?: unknown; NextPageLink?: unknown };
        if (!Array.isArray(page.Items)) break;
        for (const item of page.Items as RetailPrice[]) {
          if (!linuxOnDemand(item) || item.armRegionName !== location || item.armSkuName === undefined) continue;
          const monthly = item.retailPrice! * HOURS_A_MONTH;
          prices.set(item.armSkuName, Math.min(prices.get(item.armSkuName) ?? Number.POSITIVE_INFINITY, monthly));
        }
        next = typeof page.NextPageLink === "string" && page.NextPageLink !== "" ? followable(page.NextPageLink, "read the prices", pricesBase) : null;
      }
    } catch {
      // Prices only inform: an unreadable list leaves what was read.
    }
    return prices;
  }

  /** The sizes of OFFERED_SIZES that Azure sells at a location to this subscription, the cheapest first. */
  function offered(skus: AzureSku[], location: string, prices: Map<string, number>, except?: string): AzureSku[] {
    const price = (sku: AzureSku) => prices.get(sku.name) ?? Number.POSITIVE_INFINITY;
    return OFFERED_SIZES.map((name) => skus.find((sku) => sku.name === name))
      .filter((sku): sku is AzureSku => sku !== undefined && restrictionAt(sku, location) === null && sku.name !== except)
      .sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name));
  }

  function suggestions(skus: AzureSku[], location: string, prices: Map<string, number>, except?: string): string[] {
    const sizes = offered(skus, location, prices, except).slice(0, 6);
    if (sizes.length === 0) return [`Azure sells this subscription none of the sizes ${owner.name} offers at ${location}: try another --location`];
    return [`the sizes ${owner.name} offers that Azure sells at ${location}, the cheapest first:`, ...sizes.map((sku) => `${sku.name.padEnd(18)} ${describeSize(sku, prices.get(sku.name))}`)];
  }

  async function checkLocation(location: string): Promise<void> {
    const all = await regions();
    if (LOCATION.test(location) && all.some((entry) => entry.name === location)) return;
    const shown = all.filter((entry) => entry.metadata?.regionCategory === "Recommended").sort((a, b) => a.name.localeCompare(b.name));
    throw new ProviderError({
      error: "invalid-location",
      message: `${location} is not an Azure location this subscription can use`,
      details: ["the locations:", ...shown.map((entry) => `${entry.name.padEnd(20)} ${locationLabel(entry)}`)],
    });
  }

  /** Registers the resource providers a machine needs, as the portal does on a first machine; reads first. */
  async function ensureRegistered(report: Report): Promise<void> {
    report("-> resource providers");
    const read = (namespace: string) => call<{ registrationState?: string }>("GET", `${subscriptionPath}/providers/${namespace}`, VERSIONS.resources, `read the resource provider ${namespace}`);
    const pending: string[] = [];
    for (const namespace of NAMESPACES) {
      const state = (await read(namespace)).registrationState ?? "";
      if (state === "Registered") continue;
      pending.push(namespace);
      if (state !== "Registering") {
        await call("POST", `${subscriptionPath}/providers/${namespace}/register`, VERSIONS.resources, `register the resource provider ${namespace}`);
      }
      report(`   ${namespace}: registering for the subscription, as the portal and the Azure CLI do on a first machine`);
    }
    if (pending.length === 0) {
      report(`   ${NAMESPACES.join(" and ")}: registered`);
      return;
    }
    const deadline = clock.now() + WAITS.registerMs;
    const warned = { done: false };
    while (pending.length > 0) {
      if (clock.now() >= deadline) {
        throw new AzureError({ error: "machine-timeout", message: `Azure is still registering ${pending.join(" and ")} after ${WAITS.registerMs / 60_000} minutes`, details: ["the registration goes on at Azure"] }, 0, "");
      }
      await clock.sleep(2 * WAITS.pollMs);
      const namespace = pending[0]!;
      const state = await patiently(clock, () => read(namespace), deadline, report, warned);
      if (state?.registrationState === "Registered") {
        report(`   ${namespace}: registered`);
        pending.shift();
      }
    }
  }

  /** Refuses a size the location does not sell to this subscription, or whose family's quota is spent. */
  async function checkOffer(request: CreateRequest, location: string, report: Report): Promise<{ sku: AzureSku; image: ImageReference; skus: AzureSku[]; prices: Map<string, number> }> {
    report(`-> ${request.type} at ${location}, what Azure sells there`);
    const skus = await sizesAt(location);
    const sku = skus.find((candidate) => candidate.name.toLowerCase() === request.type.toLowerCase());
    const prices = await monthlyPrices(location, [...new Set<string>([...OFFERED_SIZES, ...(sku === undefined ? [] : [sku.name])])]);
    if (sku === undefined) {
      throw new ProviderError({ error: "invalid-server-type", message: `${request.type} is not a size Azure sells at ${location}`, details: suggestions(skus, location, prices) });
    }
    const restriction = restrictionAt(sku, location);
    if (restriction !== null) {
      throw new ProviderError({
        error: "type-unavailable",
        message: `Azure does not sell ${sku.name} at ${location} to this subscription (${restriction})`,
        details: [...suggestions(skus, location, prices, sku.name), "or try another --location", "nothing had been created yet"],
      });
    }
    report(`   ${describeSize(sku, prices.get(sku.name))}${prices.has(sku.name) ? ", list price; the disk and the address are billed beside it" : ""}`);

    const needed = Number(capability(sku, "vCPUs") ?? "0");
    const usages = await listAll<AzureUsage>(`${subscriptionPath}/providers/Microsoft.Compute/locations/${location}/usages`, VERSIONS.compute, `read the quotas at ${location}`);
    for (const key of [sku.family ?? "", "cores"]) {
      const usage = usages.find((entry) => key !== "" && entry.name?.value?.toLowerCase() === key.toLowerCase());
      if (usage === undefined || usage.limit - usage.currentValue >= needed) continue;
      throw new ProviderError({
        error: "provider-limit",
        message: `the subscription's quota of ${usage.name?.localizedValue ?? key} at ${location} is ${usage.limit}, ${usage.currentValue} in use: ${sku.name} needs ${needed} vCPUs`,
        details: ["raise the quota in the portal, under Quotas, then Compute; a new subscription often starts at zero for a family", "or pick a --type of another family", "nothing had been created yet"],
      });
    }

    const image = imageFor(request.image, sku);
    if ("error" in image) throw new ProviderError(image);
    report(`-> image ${request.image}: ${urn(image)}`);
    const versions = await read<unknown>(
      `${subscriptionPath}/providers/Microsoft.Compute/locations/${location}/publishers/${image.publisher}/artifacttypes/vmimage/offers/${image.offer}/skus/${image.sku}/versions`,
      VERSIONS.compute,
      `read the versions of the image ${urn(image)}`,
    );
    const names = Array.isArray(versions) ? versions.map((entry) => String((entry as { name?: unknown }).name ?? "")) : [];
    if (names.length === 0 || (image.version !== "latest" && !names.includes(image.version))) {
      throw new ProviderError({
        error: "provider-invalid",
        message: `Azure offers no image ${urn(image)} at ${location}`,
        details: [`${DEBIAN} is ${DEBIAN_IMAGE.publisher}:${DEBIAN_IMAGE.offer}:${DEBIAN_IMAGE.gen2} on x86, ${DEBIAN_IMAGE.arm64} on arm`, "nothing had been created yet"],
      });
    }
    report(`   offered, ${image.version === "latest" ? `latest of ${names.length} version${names.length === 1 ? "" : "s"}` : image.version}`);
    return { sku, image, skus, prices };
  }

  // --- reading a machine

  async function readVm(path: string, name: string): Promise<AzureVm | null> {
    return read<AzureVm>(path, VERSIONS.compute, `read the virtual machine ${name}`, { $expand: "instanceView" });
  }

  async function machineOf(name: string, group: AzureGroup): Promise<Machine> {
    if (!ownedBy(group.tags, name, owner) || (group.properties?.provisioningState ?? "") === "Deleting") return toMachine(name, group, null, null, owner);
    const where = paths(name);
    const vm = await readVm(where.vm, name);
    const ip = await read<AzurePublicIp>(where.ip, VERSIONS.network, `read the public IPv4 ${where.names.ip}`);
    return toMachine(name, group, vm, ip !== null && ownedBy(ip.tags, name, owner) ? ip : null, owner);
  }

  /**
   * What a group of ours already holds, read before anything is written: a
   * resource of one of the names the owner gives that it did not create is
   * never adopted nor changed, and stops everything.
   */
  async function readParts(name: string): Promise<{ nsg: AzureResource | null; vnet: AzureResource | null; ip: AzurePublicIp | null; nic: AzureResource | null; vm: AzureVm | null }> {
    const where = paths(name);
    const guard = <T extends { tags?: Tags }>(kind: string, resourceName: string, found: T | null, code: string): T | null => {
      if (found !== null && !ownedBy(found.tags, name, owner)) {
        throw new ProviderError({
          error: code,
          message: `a ${kind} named ${resourceName} exists in the resource group ${where.names.group}, and ${owner.name} did not create it`,
          details: [`it lacks the tag ${owner.mark}: it is never adopted nor changed`, "nothing was created, nothing was changed"],
        });
      }
      return found;
    };
    const nsg = guard("network security group", where.names.nsg, await read<AzureResource>(where.nsg, VERSIONS.network, `read the network security group ${where.names.nsg}`), "firewall-taken");
    const vnet = guard("virtual network", where.names.vnet, await read<AzureResource>(where.vnet, VERSIONS.network, `read the virtual network ${where.names.vnet}`), "machine-exists");
    const ip = guard("public IPv4", where.names.ip, await read<AzurePublicIp>(where.ip, VERSIONS.network, `read the public IPv4 ${where.names.ip}`), "machine-exists");
    const nic = guard("network interface", where.names.nic, await read<AzureResource>(where.nic, VERSIONS.network, `read the network interface ${where.names.nic}`), "machine-exists");
    const vm = guard("virtual machine", where.names.vm, await readVm(where.vm, name), "machine-exists");
    return { nsg, vnet, ip, nic, vm };
  }

  async function waitRunning(name: string, report: Report, justCreated: boolean): Promise<AzureVm> {
    const where = paths(name);
    const deadline = clock.now() + WAITS.runningMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      // Wrapped, so that a tolerated failure (null) is not taken for a machine that is gone.
      const outcome = await patiently(clock, async () => ({ vm: await readVm(where.vm, name) }), deadline, report, warned);
      if (outcome !== null && outcome.vm === null) throw new AzureError({ error: "provider-not-found", message: `the virtual machine ${name} disappeared` }, 404, "");
      const vm = outcome?.vm ?? null;
      if (vm !== null) {
        if (vm.properties?.provisioningState === "Failed") {
          const said = vm.properties.instanceView?.statuses?.find((status) => status.code?.startsWith("ProvisioningState/"))?.message;
          throw new AzureError(
            {
              error: "action-failed",
              message: `Azure failed to provision the virtual machine ${name}${said === undefined ? "" : `: ${said}`}`,
              details: [`\`${owner.name} machine destroy ${name} --provider azure\` removes it; then create it again`],
            },
            200,
            "ProvisioningFailed",
          );
        }
        const state = powerState(vm);
        if (state !== last) report(`   status: ${state}`);
        last = state;
        if (state === "running") return vm;
        if ((state === "deallocated" || state === "stopped") && !justCreated) {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is ${state}`, details: [`${owner.name} never starts or stops a machine by itself`] });
        }
      }
      if (clock.now() >= deadline) {
        throw new AzureError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] }, 0, "");
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** Tags the OS disk Azure created with the machine, untagged; reads its tags first, so that a second run writes nothing. */
  async function tagDisk(name: string, vm: AzureVm, report: Report): Promise<void> {
    const id = vm.properties?.storageProfile?.osDisk?.managedDisk?.id;
    const diskName = vm.properties?.storageProfile?.osDisk?.name ?? namesFor(name, owner).disk;
    report(`-> OS disk ${diskName}`);
    if (id === undefined || !/^\/subscriptions\/[A-Za-z0-9._()/-]+$/.test(id) || id.includes("..")) {
      report("!! Azure names no managed disk for the machine: it carries no tags");
      return;
    }
    const scope = `${id}/providers/Microsoft.Resources/tags/default`;
    const current = await read<{ properties?: { tags?: Tags } }>(scope, VERSIONS.resources, `read the tags of the disk ${diskName}`);
    if (ownedBy(current?.properties?.tags, name, owner)) {
      report("   tagged");
      return;
    }
    await call("PATCH", scope, VERSIONS.resources, `tag the disk ${diskName}`, { body: { operation: "Merge", properties: { tags: owner.labels(name) } } });
    report("   tagged, as Azure creates it without the machine's tags");
  }

  /**
   * Deletes what this run created before an order Azure refused: the
   * resource group, which takes everything in it, when this run created it;
   * else each resource, the last created first. What an earlier run made is
   * left as it was. A deletion that fails leaves the resource, tagged, where
   * the next run finds and reuses it. Returns what happened, one line each,
   * for the refusal's details.
   */
  async function undo(made: Made[], report: Report): Promise<string[]> {
    if (made.length === 0) return ["nothing had been created yet"];
    report("-> undo what this run created");
    const group = made.find((resource) => resource.kind === "resource group");
    const targets = group !== undefined ? [group] : [...made].reverse();
    const said: string[] = [];
    for (const target of targets) {
      const whole = target === group ? ", and everything in it" : "";
      try {
        const answer = await send("DELETE", armUrl(target.path, target.version), `delete the ${target.kind} ${target.name}`);
        await settle(answer, `deletion of the ${target.kind} ${target.name}`, report, { path: target.path, version: target.version, gone: true }, WAITS.deleteMs);
        said.push(`deleted the ${target.kind} ${target.name} this run had created${whole}`);
      } catch (error) {
        if (error instanceof AzureError && error.status === 404) said.push(`deleted the ${target.kind} ${target.name} this run had created${whole}`);
        else said.push(`left the ${target.kind} ${target.name}: the next run finds it and reuses it, or \`${owner.name} machine destroy\` removes it`);
      }
      report(`   ${said.at(-1)}`);
    }
    return said;
  }

  /** Whether a refused order says the size cannot be had there right now, rather than that the request was wrong. */
  function refusesTheOffer(error: ProviderError): boolean {
    return error instanceof AzureError && (OFFER_CODES.has(error.code) || error.failure.error === "type-unavailable");
  }

  return {
    name: "azure",

    async find(name) {
      checkName(name);
      const group = await read<AzureGroup>(groupPath(namesFor(name, owner).group), VERSIONS.resources, `read the resource group ${namesFor(name, owner).group}`);
      return group === null ? null : machineOf(name, group);
    },

    async create(request, report): Promise<CreateOutcome> {
      checkRequest("Azure", request, SUPPORTS);
      // Not null: checkRequest refuses a request without a key, SUPPORTS not being keyless.
      const key = request.key!;
      checkName(request.name);
      const keyRefused = keyRefusal(key);
      if (keyRefused !== null) throw new ProviderError(keyRefused);
      if (RESERVED_LOGINS.has(login)) {
        throw new ProviderError({ error: "provider-unsupported", message: `Azure refuses ${login} as the name of the machine's account, which is the owner's name`, details: ["nothing was created"] });
      }
      if (request.backups) {
        throw new ProviderError({ error: "provider-invalid", message: `${owner.name} does not turn on Azure's own backups`, details: ["run the same command without --backups"] });
      }
      const where = paths(request.name);
      const names = where.names;
      const resources: Resource[] = [];
      const tags = owner.labels(request.name);

      report(`-> resource group ${names.group}`);
      const group = await read<AzureGroup>(where.group, VERSIONS.resources, `read the resource group ${names.group}`);
      let location = request.location;
      if (group !== null) {
        if (!ownedBy(group.tags, request.name, owner)) {
          throw new ProviderError({
            error: "machine-exists",
            message: `a resource group named ${names.group} exists in the subscription, and ${owner.name} did not create it for ${request.name}`,
            details: [`at ${group.location}, ${(group.properties?.provisioningState ?? "unknown").toLowerCase()}`, `it lacks the tags ${owner.mark} and ${owner.machineLabel}=${request.name}: nothing was created, nothing was changed`],
          });
        }
        if (group.properties?.provisioningState === "Deleting") {
          throw new ProviderError({ error: "provider-busy", message: `Azure is deleting the resource group ${names.group}`, details: [`run the same command again once it has gone: \`${owner.name} machine list --provider azure\` stops listing it`] });
        }
        location = group.location;
        report(`   already created by ${owner.name}, at ${location}`);
        resources.push({ kind: "resource group", name: names.group, id: shortId(group.id, where.group), reused: true });
      } else {
        report("   none of that name yet");
      }
      const found = group === null ? { nsg: null, vnet: null, ip: null, nic: null, vm: null } : await readParts(request.name);
      if (group !== null && location !== request.location) {
        // Everything in a group lives at the group's location, a machine still to create included.
        report(
          found.vm !== null
            ? `!! it is at ${location}: --location only applies to a machine being created`
            : `!! the resource group is at ${location}, not ${request.location}: the machine it lacks is created at ${location}; --location only applies to a resource group being created`,
        );
      }

      let created = false;
      let vm: AzureVm;
      if (found.vm !== null) {
        const size = found.vm.properties?.hardwareProfile?.vmSize ?? "unknown";
        report(`-> virtual machine ${names.vm}`);
        report(`   already created by ${owner.name}: ${size} at ${location}, ${powerState(found.vm)}`);
        if (size.toLowerCase() !== request.type.toLowerCase()) report(`!! it is ${size}: --type only applies to a machine being created`);
        resources.push({ kind: "virtual machine", name: names.vm, id: shortId(found.vm.id, where.vm), reused: true });
        vm = await waitRunning(request.name, report, false);
      } else {
        report(`-> ${location}`);
        await checkLocation(location);
        report(`   ${locationLabel((await regions()).find((entry) => entry.name === location)!)}`);
        await ensureRegistered(report);
        const offer = await checkOffer(request, location, report);

        const made: Made[] = [];
        let ordering = false;
        try {
          /** Creates a resource when it is not there yet, and waits for Azure to finish it. */
          const ensure = async <T extends { id?: string; properties?: { provisioningState?: string } }>(kind: string, name: string, path: string, version: string, existing: T | null, body: unknown, headers?: Record<string, string>): Promise<{ id: string; reused: boolean }> => {
            report(`-> ${kind} ${name}`);
            if (existing !== null) {
              const state = existing.properties?.provisioningState ?? "Succeeded";
              report(`   already created by ${owner.name}, reused${state === "Succeeded" ? "" : `; Azure is still at it (${state.toLowerCase()})`}`);
              // An earlier run stopped while Azure made it: referenced before it is done, Azure would refuse.
              if (state !== "Succeeded") await settle({ status: 200, headers: new Headers(), body: existing }, `creation of the ${kind} ${name}`, report, { path, version });
              resources.push({ kind, name, id: shortId(existing.id, path), reused: true });
              return { id: existing.id ?? path, reused: true };
            }
            const answer = await send("PUT", armUrl(path, version), `create the ${kind} ${name}`, { body, headers });
            made.push({ kind, name, path, version });
            await settle(answer, `creation of the ${kind} ${name}`, report, { path, version });
            const id = (answer.body as { id?: unknown } | null)?.id;
            const full = typeof id === "string" ? id : path;
            resources.push({ kind, name, id: shortId(full, path), reused: false });
            return { id: full, reused: false };
          };

          if (group === null) {
            report(`-> resource group ${names.group} at ${location}`);
            const answer = await send("PUT", armUrl(where.group, VERSIONS.resources), `create the resource group ${names.group}`, { body: { location, tags } });
            const id = (answer.body as { id?: unknown } | null)?.id;
            // 201 says this run created it; 200, that another run did a moment before, whose group it is not this run's to undo.
            if (answer.status === 201) made.push({ kind: "resource group", name: names.group, path: where.group, version: VERSIONS.resources });
            resources.push({ kind: "resource group", name: names.group, id: shortId(typeof id === "string" ? id : undefined, where.group), reused: answer.status !== 201 });
            report(answer.status === 201 ? "   created" : "   created a moment ago by another run, reused");
          }
          const nsg = await ensure("network security group", names.nsg, where.nsg, VERSIONS.network, found.nsg, { location, tags, properties: { securityRules: SECURITY_RULES } });
          if (!nsg.reused) report("   inbound tcp 22, 80, 443 and icmp, from the Internet; the rest dropped");
          const vnet = await ensure("virtual network", names.vnet, where.vnet, VERSIONS.network, found.vnet, {
            location,
            tags,
            properties: { addressSpace: { addressPrefixes: [NETWORK.space] }, subnets: [{ name: names.subnet, properties: { addressPrefix: NETWORK.subnet } }] },
          });
          const ip = await ensure("public IPv4", names.ip, where.ip, VERSIONS.network, found.ip, {
            location,
            tags,
            sku: { name: "Standard", tier: "Regional" },
            properties: { publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4" },
          });
          const nic = await ensure("network interface", names.nic, where.nic, VERSIONS.network, found.nic, {
            location,
            tags,
            properties: {
              ipConfigurations: [{ name: "ipv4", properties: { subnet: { id: `${vnet.id}/subnets/${names.subnet}` }, privateIPAllocationMethod: "Dynamic", publicIPAddress: { id: ip.id } } }],
              networkSecurityGroup: { id: nsg.id },
            },
          });

          ordering = true;
          const keyData = [key.algorithm, key.blob, /^[\x20-\x7e]*$/.test(key.comment) ? key.comment : ""].filter((part) => part !== "").join(" ");
          await ensure(
            "virtual machine",
            names.vm,
            where.vm,
            VERSIONS.compute,
            null,
            {
              location,
              tags,
              properties: {
                hardwareProfile: { vmSize: offer.sku.name },
                storageProfile: {
                  imageReference: { publisher: offer.image.publisher, offer: offer.image.offer, sku: offer.image.sku, version: offer.image.version },
                  osDisk: { name: names.disk, createOption: "FromImage", deleteOption: "Delete", managedDisk: { storageAccountType: DISK_TYPE } },
                },
                osProfile: {
                  computerName: request.name,
                  adminUsername: login,
                  linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [{ path: `/home/${login}/.ssh/authorized_keys`, keyData }] } },
                },
                networkProfile: { networkInterfaces: [{ id: nic.id, properties: { primary: true } }] },
              },
            },
            // Create, never replace: a machine that appeared since it was read is not overwritten.
            { "If-None-Match": "*" },
          );
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (error.failure.error === "machine-timeout") {
            // Azure is still at it: what it is making is the next run's to pick up, not to delete.
            throw new ProviderError({
              ...error.failure,
              details: [...(error.failure.details ?? []), `nothing was undone: the next run picks it up where it stands, and \`${owner.name} machine destroy ${request.name} --provider azure\` removes it all`],
            });
          }
          if (ordering && error instanceof AzureError && error.status === 412) {
            // Another run, most likely, is creating the same machine: nothing of it is this run's to delete.
            throw new ProviderError({
              error: "machine-exists",
              message: `a virtual machine named ${names.vm} appeared in the resource group ${names.group} while this run created it`,
              details: ["it was not changed, and nothing was undone: run the same command again in a few minutes to pick it up"],
            });
          }
          const undone = await undo(made, report);
          if (ordering && refusesTheOffer(error)) {
            // The list of sizes says what the subscription may order, not
            // what Azure can place right now: the order decides, and its
            // refusal still says what to try instead.
            const said = error instanceof AzureError ? error.said : error.failure.message;
            throw new ProviderError({
              error: "type-unavailable",
              message: `Azure would not create ${offer.sku.name} at ${location}${error instanceof AzureError && error.code !== "" ? ` (${error.code})` : ""}: ${said}`,
              details: [...suggestions(offer.skus, location, offer.prices, offer.sku.name), "or try another --location", ...undone],
            });
          }
          throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone] });
        }
        created = true;
        report(`-> ${request.name} running`);
        vm = await waitRunning(request.name, report, true);
      }

      await tagDisk(request.name, vm, report);
      const finalGroup = await call<AzureGroup>("GET", where.group, VERSIONS.resources, `read the resource group ${names.group}`);
      const ip = await read<AzurePublicIp>(where.ip, VERSIONS.network, `read the public IPv4 ${names.ip}`);
      return { machine: toMachine(request.name, finalGroup, vm, ip, owner), created, resources };
    },

    async list() {
      const groups = await listAll<AzureGroup>(`${subscriptionPath}/resourcegroups`, VERSIONS.resources, "read the resource groups", {
        $filter: `tagName eq '${MANAGED_LABEL}' and tagValue eq '${owner.name}'`,
      });
      const machines: Machine[] = [];
      for (const group of groups) {
        const name = group.tags?.[owner.machineLabel];
        // Only the groups the owner names after the machine they hold.
        if (!owner.manages(group.tags) || name === undefined || !MACHINE_NAME.test(name) || group.name.toLowerCase() !== namesFor(name, owner).group) continue;
        machines.push(await machineOf(name, group));
      }
      return machines;
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      checkName(machine.name);
      const where = paths(machine.name);
      const names = where.names;
      report(`-> resource group ${names.group}`);
      const group = await read<AzureGroup>(where.group, VERSIONS.resources, `read the resource group ${names.group}`);
      if (group === null) {
        report("   already gone");
        return { removed: [], kept: [] };
      }
      if (!ownedBy(group.tags, machine.name, owner)) {
        throw new ProviderError({
          error: "machine-not-managed",
          message: `the resource group ${names.group} was not created by ${owner.name} for ${machine.name}`,
          details: [`it lacks the tags ${owner.mark} and ${owner.machineLabel}=${machine.name}: nothing was deleted`],
        });
      }
      const contents = await listAll<AzureResource>(`${subscriptionPath}/resourceGroups/${names.group}/resources`, VERSIONS.resources, `read what the resource group ${names.group} holds`);
      // The OS disk Azure created with the machine counts as the owner's,
      // tagged or not yet; that disk alone, named by the machine itself. A
      // data disk attached since, in the portal, is its owner's, and stops
      // the deletion like anything else untagged.
      const vm = await read<AzureVm>(where.vm, VERSIONS.compute, `read the virtual machine ${names.vm}`);
      const systemDiskId = vm !== null && ownedBy(vm.tags, machine.name, owner) ? vm.properties?.storageProfile?.osDisk?.managedDisk?.id?.toLowerCase() : undefined;
      const systemDisk = (resource: AzureResource) => (resource.type ?? "").toLowerCase() === "microsoft.compute/disks" && systemDiskId !== undefined && resource.id.toLowerCase() === systemDiskId;
      const foreign = contents.filter((resource) => !ownedBy(resource.tags, machine.name, owner) && !systemDisk(resource));
      if (foreign.length > 0) {
        throw new ProviderError({
          error: "machine-not-managed",
          message: `the resource group ${names.group} holds resources ${owner.name} did not create`,
          details: [
            ...foreign.map((resource) => describeResource(resource, null)),
            "nothing was deleted: deleting the group would delete them too",
            "move them to another resource group, or delete the group from the portal if they have to go",
          ],
        });
      }
      const lines = contents.map((resource) => describeResource(resource, machine.ipv4));
      for (const line of lines) report(`   ${line}`);
      const answer = await send("DELETE", armUrl(where.group, VERSIONS.resources), `delete the resource group ${names.group}`);
      await settle(answer, `deletion of the resource group ${names.group}`, report, { path: where.group, version: VERSIONS.resources, gone: true }, WAITS.deleteMs);
      const removed = [`resource group ${names.group}`, ...lines];

      report("-> SSH key");
      report("   Azure holds no key of its own: it was written into the machine, and went with it");
      if (options.deleteKey) report("   --delete-key: nothing to delete");
      return { removed, kept: [] };
    },

    async locations(): Promise<Choice[]> {
      const all = (await regions()).filter((entry) => entry.metadata?.regionCategory === "Recommended");
      const rank = (entry: AzureLocation) => (entry.name === DEFAULTS.location ? 0 : entry.metadata?.geographyGroup === "Europe" ? 1 : 2);
      return all
        .sort((a, b) => rank(a) - rank(b) || locationLabel(a).localeCompare(locationLabel(b)))
        .map((entry) => ({ value: entry.name, label: locationLabel(entry), hint: entry.displayName ?? entry.name }));
    },

    async types(location): Promise<Choice[]> {
      if (!LOCATION.test(location)) throw new ProviderError({ error: "invalid-location", message: `${location} is not an Azure location` });
      const skus = await sizesAt(location);
      const prices = await monthlyPrices(location, OFFERED_SIZES);
      const sizes = offered(skus, location, prices);
      const first = sizes.filter((sku) => sku.name === DEFAULTS.type);
      return [...first, ...sizes.filter((sku) => sku.name !== DEFAULTS.type)].map((sku) => ({ value: sku.name, label: sku.name, hint: describeSize(sku, prices.get(sku.name)) }));
    },
  };
}

/**
 * The subscription always; then either a service principal's tenant, client
 * ID and secret, the variables Azure's SDKs and Terraform read, or an access
 * token, which `discover` asks the signed-in Azure CLI for whenever neither
 * form is whole.
 *
 * The service principal is the form a prompt asks for: whoever is prompted
 * has no Azure CLI signed in, or `discover` would have found it, and a
 * service principal is made once and lasts, where a token is a few thousand
 * characters to paste that expire within the hour.
 */
export const AZURE: ProviderEntry = {
  name: "azure",
  title: "Azure",
  credentials: [
    { variable: VARIABLES.subscription, label: "subscription ID", secret: false, shape: UUID },
    { variable: VARIABLES.tenant, label: "tenant ID", secret: false, shape: TENANT, optional: true },
    { variable: VARIABLES.client, label: "client ID", secret: false, shape: UUID, optional: true },
    { variable: VARIABLES.secret, label: "client secret", secret: true, shape: CLIENT_SECRET, optional: true },
    { variable: VARIABLES.token, label: "access token", secret: true, shape: ACCESS_TOKEN, optional: true },
  ],
  alternatives: [[VARIABLES.tenant, VARIABLES.client, VARIABLES.secret], [VARIABLES.token]],
  discover: discoverAzureCli,
  keyProblem,
  credentialHelp: CREDENTIAL_HELP,
  docs: "docs/providers/azure.md",
  defaults: (environment) => {
    // AZURE_DEFAULTS_LOCATION, the variable through which the Azure CLI's own default location can be set; its configuration file is not read.
    const wanted = environment.AZURE_DEFAULTS_LOCATION?.trim().toLowerCase() ?? "";
    return { type: DEFAULTS.type, location: LOCATION.test(wanted) ? wanted : DEFAULTS.location, image: DEFAULTS.image };
  },
  backups: false,
  apiVariable: API_VARIABLE,
  open: azure,
};
