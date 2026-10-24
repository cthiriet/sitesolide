/**
 * Google Cloud Compute Engine, through its REST API v1:
 * https://cloud.google.com/compute/docs/reference/rest/v1
 *
 * A machine is four resources of the project, all named after it:
 *
 *   - two VPC firewall rules on the project's `default` network, applied to
 *     the instances that carry the network tag `sitesolide-<name>`:
 *     `sitesolide-<name>` allows TCP 22, 80 and 443 and ICMP from everywhere,
 *     and `sitesolide-<name>-deny`, one step below it in priority, drops
 *     everything else. The second is what makes "everything else is dropped"
 *     true on Google Cloud: the default network comes with rules of its own,
 *     `default-allow-rdp` and `default-allow-internal` among them, which
 *     apply to every instance of the network and which sitesolide never
 *     changes. They sit at priority 65534, far below these two;
 *   - a static regional IPv4 address, `sitesolide-<name>`: the ephemeral
 *     address an instance gets otherwise may change when it is stopped and
 *     started, and the DNS records point at it;
 *   - the instance, with the tag, the address, a 20 GB boot disk of Debian
 *     that goes when the instance goes, no service account (the machine
 *     holds no Google credentials), and the workstation's key in its
 *     metadata for the account `sitesolide`, which Google's guest agent
 *     creates and puts in its `google-sudoers` group. Google's documentation
 *     says such a key cannot be root's unless the image is changed to allow
 *     it, hence that account. The project's own keys are blocked on the
 *     instance, and OS Login is turned off for it, so that the key is the
 *     one way in.
 *
 * The default network's subnets are IPv4 only: the machine has no IPv6
 * address, and the rules no IPv6 range.
 *
 * Firewall rules carry no labels on Google Cloud. sitesolide's mark is
 * written in their description instead, `managed-by=sitesolide
 * sitesolide-machine=<name>`, and a rule only counts as sitesolide's when its
 * name, its description and its single target tag all say so (see ownRule).
 * The address carries the labels and the same description: the API reference
 * says an address's labels are set through setLabels, after the address
 * exists, and a run interrupted between the two still recognises the address
 * by its description.
 *
 * Everything that can refuse is read before the first write: an instance of
 * that name anywhere in the project (one sitesolide did not create is never
 * touched), the zone, the machine type in that zone, the image, the default
 * network and its subnet in the region, the two rules and the address by
 * name. The order itself can still be refused, by its operation above all:
 * an instance is accepted at once and fails later when the zone has no room
 * for it (ZONE_RESOURCE_POOL_EXHAUSTED). When Google says no, the rules and
 * the address this run created are deleted again, and the refusal says so.
 * When the answer is unknown, an order that timed out or a network that
 * failed after it left, nothing is undone: the next run finds what exists.
 * What an earlier run left without an instance, its address and its rules,
 * is a machine for `find` and `list` all the same, status `incomplete`, since
 * the address is billed: `destroy` removes it, `create` reuses it, and every
 * refusal of a create that found it names it and says how it goes.
 *
 * Every call carries the access token in the Authorization header and nowhere
 * else, follows no redirect, and fails with a ProviderError whose code
 * bin/cli/hints.ts knows. The API's errors are
 * `{"error": {"code", "message", "errors": [{"reason"}], "status"}}`;
 * `failureFrom` reads them. Lists follow `nextPageToken` to the end, five
 * hundred items a page, the most the API returns. Operations are polled every
 * two seconds through their zone, region or global `operations/<name>`,
 * bounded; `wait` is not used, it holds a request open two minutes, longer
 * than a call may last here.
 *
 * Credentials: a project and an access token, the token as the gcloud CLI
 * prints it, or a service account's email and private key, which the
 * provider exchanges for a token at Google's OAuth endpoint with a JWT it
 * signs itself (RS256, crypto.subtle). The exchanged token, and the signed
 * assertion that obtained it, go through `context.secret` before use.
 */
import {
  apiAddress,
  DEBIAN,
  isManaged,
  labelsFor,
  MACHINE_LABEL,
  MANAGED_LABEL,
  MANAGED_VALUE,
  patiently,
  ProviderError,
  retryAfter,
  undoMade,
  type Choice,
  type CreateOutcome,
  type CreateRequest,
  type Credentials,
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

export const DEFAULT_API = "https://compute.googleapis.com/compute/v1";
/** Where a signed assertion is exchanged for an access token; also the JWT's audience. */
export const DEFAULT_OAUTH = "https://oauth2.googleapis.com/token";

/** The API's address, and the token endpoint's, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_GCP_API";
export const OAUTH_VARIABLE = "SITESOLIDE_GCP_OAUTH";

/** The project, as Google's client libraries read it. */
export const PROJECT_VARIABLE = "GOOGLE_CLOUD_PROJECT";
/** An access token, as the Terraform provider reads it. */
export const TOKEN_VARIABLE = "GOOGLE_OAUTH_ACCESS_TOKEN";
/**
 * A service account's email and private key. No Google tool reads a key from
 * the environment, so these names are sitesolide's own: a GOOGLE_PRIVATE_KEY
 * some other program of the workstation uses would otherwise be picked up
 * against the wrong project. They are filled from the key file
 * GOOGLE_APPLICATION_CREDENTIALS names (see discover).
 */
export const EMAIL_VARIABLE = "SITESOLIDE_GCP_CLIENT_EMAIL";
export const KEY_VARIABLE = "SITESOLIDE_GCP_PRIVATE_KEY";

/** A project ID: 6 to 30 characters, a letter first; older ones carry a domain, `example.com:my-project`. */
export const PROJECT_SHAPE = /^(?:[a-z][a-z0-9.-]{0,61}[a-z0-9]:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** An OAuth bearer token (RFC 6750's b64token); Google's run up to 2048 characters. */
export const TOKEN_SHAPE = /^(?=[\s\S]{16,4096}$)[A-Za-z0-9._~+/-]+=*$/;
export const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190}\.gserviceaccount\.com$/;
/** PKCS #8, as a key file holds it; its newlines may arrive written `\n`, as in the JSON. */
export const KEY_SHAPE = /^\s*-----BEGIN PRIVATE KEY-----(?:\\n|[\sA-Za-z0-9+/=])+-----END PRIVATE KEY-----(?:\\n|\s)*$/;

/** Read and write on Compute Engine, nothing else of the project. */
export const SCOPE = "https://www.googleapis.com/auth/compute";

/** The account Google's guest agent creates from the `ssh-keys` metadata entry. */
export const LOGIN = "sitesolide";

/**
 * e2-small: 2 shared vCPUs and 2 GB, the cheapest x86 type of the current
 * generations with at least 2 GB (e2-micro has 1 GB). europe-west4 is
 * Eemshaven, in the Netherlands, the cheapest of the German, French and Dutch
 * regions for E2 when this was written; zone a of the three.
 */
export const DEFAULT_TYPE = "e2-small";
export const DEFAULT_ZONE = "europe-west4-a";
export const DISK_GB = 20;

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  operationMs: 10 * 60_000,
  runningMs: 5 * 60_000,
  pollMs: 2_000,
  /** An address still held a moment after its instance went. */
  addressTries: 5,
};

/** The rule that allows sits at the API's default priority; the one that denies right after it. */
export const ALLOW_PRIORITY = 1000;
export const DENY_PRIORITY = 1001;

/**
 * GCP's names start with a letter and hold at most 63 characters; the longest
 * one sitesolide makes is `sitesolide-<name>-deny`, hence 47 for the name.
 */
export const NAME_SHAPE = /^[a-z](?:[a-z0-9-]{0,45}[a-z0-9])?$/;
export const MAX_NAME = 47;

/** Why Google Cloud would refuse a name the CLI accepts, or null: asked before anything leaves. */
export function nameProblem(name: string): string | null {
  if (!/^[a-z]/.test(name)) return "a name there starts with a letter";
  if (name.length > MAX_NAME) return `${MAX_NAME} characters at most: sitesolide derives sitesolide-<name>-deny from it, and Google takes 63`;
  if (!NAME_SHAPE.test(name)) return "lowercase letters, digits and dashes, ending with a letter or a digit";
  return null;
}

/**
 * The status `find` and `list` give a machine whose instance is not there,
 * never created or already deleted, while its address or its rules remain:
 * a destroy removes those, a create reuses them.
 */
export const INCOMPLETE = "incomplete";
const ZONE_SHAPE = /^[a-z]+-[a-z]+[0-9]+-[a-z0-9]+$/;
/** A standard zone, `europe-west4-a`; the AI zones, `us-west4-ai2b`, are not offered. */
const STANDARD_ZONE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const TYPE_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The series the wizard offers, x86 only: E2, Google's cost-optimised one,
 * then the general-purpose series by generation. Without a price the API
 * gives, this order stands in for "the cheapest first".
 */
const OFFERED_SERIES = ["e2", "n4", "n4d", "c4", "c4d", "c3", "c3d", "n2", "n2d"];
/** The series whose boot disk can only be Hyperdisk, per the machine families page. */
const HYPERDISK_ONLY = new Set(["n4", "n4d", "n4a", "c4", "c4a", "c4d"]);
/** The Arm series, which boot the arm64 image. */
const ARM_SERIES = new Set(["c4a", "n4a", "t2a"]);

/** Where each region is, from https://cloud.google.com/compute/docs/regions-zones; a region missing here shows its name alone. */
export const REGIONS: Readonly<Record<string, readonly [city: string, country: string]>> = {
  "africa-south1": ["Johannesburg", "ZA"],
  "asia-east1": ["Changhua County", "TW"],
  "asia-east2": ["Hong Kong", "HK"],
  "asia-northeast1": ["Tokyo", "JP"],
  "asia-northeast2": ["Osaka", "JP"],
  "asia-northeast3": ["Seoul", "KR"],
  "asia-south1": ["Mumbai", "IN"],
  "asia-south2": ["Delhi", "IN"],
  "asia-southeast1": ["Jurong West", "SG"],
  "asia-southeast2": ["Jakarta", "ID"],
  "asia-southeast3": ["Bangkok", "TH"],
  "australia-southeast1": ["Sydney", "AU"],
  "australia-southeast2": ["Melbourne", "AU"],
  "europe-central2": ["Warsaw", "PL"],
  "europe-north1": ["Hamina", "FI"],
  "europe-north2": ["Stockholm", "SE"],
  "europe-southwest1": ["Madrid", "ES"],
  "europe-west1": ["St. Ghislain", "BE"],
  "europe-west2": ["London", "GB"],
  "europe-west3": ["Frankfurt", "DE"],
  "europe-west4": ["Eemshaven", "NL"],
  "europe-west6": ["Zurich", "CH"],
  "europe-west8": ["Milan", "IT"],
  "europe-west9": ["Paris", "FR"],
  "europe-west10": ["Berlin", "DE"],
  "europe-west12": ["Turin", "IT"],
  "me-central1": ["Doha", "QA"],
  "me-central2": ["Dammam", "SA"],
  "me-west1": ["Tel Aviv", "IL"],
  "northamerica-northeast1": ["Montreal", "CA"],
  "northamerica-northeast2": ["Toronto", "CA"],
  "northamerica-south1": ["Queretaro", "MX"],
  "southamerica-east1": ["Osasco", "BR"],
  "southamerica-west1": ["Santiago", "CL"],
  "us-central1": ["Council Bluffs, Iowa", "US"],
  "us-east1": ["Moncks Corner, South Carolina", "US"],
  "us-east4": ["Ashburn, Virginia", "US"],
  "us-east5": ["Columbus, Ohio", "US"],
  "us-south1": ["Dallas, Texas", "US"],
  "us-west1": ["The Dalles, Oregon", "US"],
  "us-west2": ["Los Angeles, California", "US"],
  "us-west3": ["Salt Lake City, Utah", "US"],
  "us-west4": ["Las Vegas, Nevada", "US"],
};

// --- the API's objects, as far as this file reads them ---------------------------------

export type GcpOperation = {
  name: string;
  operationType?: string;
  status: "PENDING" | "RUNNING" | "DONE";
  progress?: number;
  /** The URL of the zone or the region of a zonal or regional operation; absent for a global one. */
  zone?: string;
  region?: string;
  targetLink?: string;
  /** The id of the resource the operation acts on, a uint64 written as a string. */
  targetId?: string;
  error?: { errors?: { code?: string; message?: string; location?: string }[] };
  httpErrorStatusCode?: number;
  httpErrorMessage?: string;
};

export type GcpInstance = {
  id: string;
  name: string;
  status: string;
  /** URLs, of which the last segment is the name. */
  zone: string;
  machineType: string;
  labels?: Record<string, string>;
  tags?: { items?: string[] };
  networkInterfaces?: {
    network?: string;
    subnetwork?: string;
    accessConfigs?: { type?: string; name?: string; natIP?: string; networkTier?: string }[];
    ipv6AccessConfigs?: { externalIpv6?: string; externalIpv6PrefixLength?: number }[];
  }[];
  disks?: { boot?: boolean; autoDelete?: boolean; deviceName?: string; source?: string }[];
};

export type GcpAddress = {
  id: string;
  name: string;
  address?: string;
  status?: string;
  region?: string;
  description?: string;
  labels?: Record<string, string>;
  labelFingerprint?: string;
  users?: string[];
  networkTier?: string;
};

export type GcpFirewall = {
  id: string;
  name: string;
  description?: string;
  network?: string;
  priority?: number;
  direction?: string;
  sourceRanges?: string[];
  targetTags?: string[];
  targetServiceAccounts?: string[];
  allowed?: { IPProtocol: string; ports?: string[] }[];
  denied?: { IPProtocol: string; ports?: string[] }[];
};

export type GcpZone = { name: string; region?: string; status?: string; deprecated?: { state?: string } };

export type GcpMachineType = {
  name: string;
  guestCpus: number;
  memoryMb: number;
  isSharedCpu?: boolean;
  /** `X86_64` or `ARM64`; absent from older answers, where the series says. */
  architecture?: string;
  deprecated?: { state?: string };
};

type GcpNetwork = { name: string; selfLink: string; autoCreateSubnetworks?: boolean; subnetworks?: string[]; IPv4Range?: string };
type GcpImage = { name: string; family?: string; architecture?: string; status?: string; deprecated?: { state?: string } };

type ErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    errors?: { reason?: unknown; message?: unknown }[];
    details?: { "@type"?: unknown; reason?: unknown }[];
  };
};

// --- names and marks -------------------------------------------------------------------------

/** What sitesolide writes where labels cannot go: in a firewall rule's description, and an address's. */
export function markOf(name: string): string {
  return `${MANAGED_LABEL}=${MANAGED_VALUE} ${MACHINE_LABEL}=${name}`;
}

function marked(description: string | undefined, name: string): boolean {
  const mark = markOf(name);
  return description === mark || (description ?? "").startsWith(`${mark}:`);
}

/** The network tag the rules target, which the instance carries. */
export function tagOf(name: string): string {
  return `sitesolide-${name}`;
}

export function addressNameOf(name: string): string {
  return `sitesolide-${name}`;
}

export function ruleNamesOf(name: string): { allow: string; deny: string } {
  return { allow: `sitesolide-${name}`, deny: `sitesolide-${name}-deny` };
}

/** The last segment of one of the API's URLs: the name it points at. */
export function lastSegment(url: string | undefined): string {
  return (url ?? "").split("/").pop() ?? "";
}

/** `europe-west4-a` -> `europe-west4`; `us-west4-ai2b` -> `us-west4`. */
export function regionOf(zone: string): string {
  return zone.replace(/-[a-z0-9]+$/, "");
}

function seriesOf(type: string): string {
  return type.split("-")[0] ?? "";
}

/** The boot disk a series can take: Hyperdisk Balanced where Persistent Disk is not offered, Balanced Persistent Disk otherwise. */
export function bootDiskType(type: string): string {
  return HYPERDISK_ONLY.has(seriesOf(type)) ? "hyperdisk-balanced" : "pd-balanced";
}

function isArm(type: GcpMachineType): boolean {
  return type.architecture === "ARM64" || (type.architecture === undefined && ARM_SERIES.has(seriesOf(type.name)));
}

/** Debian 13 from Google's own image project, the family so that an order gets its latest build. */
export function debianImage(arm: boolean): string {
  return `projects/debian-cloud/global/images/family/${arm ? "debian-13-arm64" : "debian-13"}`;
}

/** A sourceImage given with --image: Google's path to an image or an image family. */
const IMAGE_PATH = /^projects\/[a-z0-9.:-]+\/global\/images\/(?:family\/)?[a-z0-9-]+$/;

/** The two rules of a machine: what they let in, then everything else dropped. */
export function firewallRules(name: string, network: string) {
  const { allow, deny } = ruleNamesOf(name);
  const common = { network, direction: "INGRESS", sourceRanges: ["0.0.0.0/0"], targetTags: [tagOf(name)] };
  return [
    {
      name: allow,
      description: `${markOf(name)}: inbound tcp 22, 80, 443 and icmp, from everywhere`,
      priority: ALLOW_PRIORITY,
      ...common,
      // Ping serves diagnosis and external monitoring.
      allowed: [{ IPProtocol: "tcp", ports: ["22", "80", "443"] }, { IPProtocol: "icmp" }],
    },
    {
      name: deny,
      description: `${markOf(name)}: every other inbound packet dropped, before the default network's own rules`,
      priority: DENY_PRIORITY,
      ...common,
      denied: [{ IPProtocol: "all" }],
    },
  ];
}

/**
 * Whether a rule is sitesolide's for that machine: its name, the mark in its
 * description, and a target that is the machine's tag and nothing else. One
 * that fails any of the three is left as it is, whatever its name says.
 */
export function ownRule(rule: GcpFirewall, name: string): boolean {
  const names = ruleNamesOf(name);
  const tags = rule.targetTags ?? [];
  return (
    (rule.name === names.allow || rule.name === names.deny) &&
    marked(rule.description, name) &&
    tags.length === 1 &&
    tags[0] === tagOf(name) &&
    (rule.targetServiceAccounts ?? []).length === 0
  );
}

/** Whether an address is sitesolide's for that machine: by its labels, or, for one whose labels a run did not get to set, by its name and description. */
export function ownAddress(address: GcpAddress, name: string): boolean {
  if (isManaged(address.labels)) return address.labels?.[MACHINE_LABEL] === name;
  const unlabelled = Object.keys(address.labels ?? {}).length === 0;
  return unlabelled && address.name === addressNameOf(name) && marked(address.description, name);
}

/** The machine a description's mark names, `managed-by=sitesolide sitesolide-machine=web: ...`, or null. */
export function machineOfMark(description: string | undefined): string | null {
  const match = new RegExp(`^${MANAGED_LABEL}=${MANAGED_VALUE} ${MACHINE_LABEL}=([a-z0-9-]+)(?::|$)`).exec(description ?? "");
  return match?.[1] ?? null;
}

/** The machine an address was reserved for, when sitesolide reserved it. */
export function machineOfAddress(address: GcpAddress): string | null {
  const name = isManaged(address.labels) ? (address.labels?.[MACHINE_LABEL] ?? null) : machineOfMark(address.description);
  return name !== null && ownAddress(address, name) ? name : null;
}

/** The machine a rule was created for, when sitesolide created it. */
export function machineOfRule(rule: GcpFirewall): string | null {
  const name = machineOfMark(rule.description);
  return name !== null && ownRule(rule, name) ? name : null;
}

/** What remains of a machine besides its instance: what a refusal names, and what `destroy` removes once the instance is gone. */
export type Leftovers = { addresses: GcpAddress[]; rules: GcpFirewall[] };

/** A machine without its instance, as `find` and `list` show it: managed, so that `destroy` takes it. */
export function incompleteMachine(name: string, left: Leftovers): Machine {
  const address = left.addresses[0];
  return {
    provider: "gcp",
    id: "",
    name,
    type: "none",
    location: address === undefined ? "global" : lastSegment(address.region) || "unknown",
    status: INCOMPLETE,
    ipv4: address?.address ?? null,
    ipv6: null,
    ipv6Network: null,
    monthlyPrice: null,
    backups: false,
    managed: true,
    labels: labelsFor(name),
    login: LOGIN,
  };
}

/** What a refusal says of the leftovers an earlier run made: they stay, the address is billed, and how they go. */
export function leftoverLines(name: string, left: Leftovers): string[] {
  if (left.addresses.length === 0 && left.rules.length === 0) return [];
  const rules = left.rules.map((rule) => rule.name);
  return [
    ...left.addresses.map((address) => `the address ${address.name} (${address.address ?? "no address"}, ${lastSegment(address.region)}) an earlier run reserved is still there, billed by the hour while it is`),
    ...(rules.length === 0 ? [] : [`the firewall ${rules.length === 1 ? "rule" : "rules"} ${rules.join(" and ")} an earlier run created ${rules.length === 1 ? "is" : "are"} still there`]),
    `the same create reuses them; to give the machine up, \`sitesolide machine destroy ${name} --provider gcp\` removes them`,
  ];
}

/** An attached disk's name: the last segment of its source, else its device name. */
function diskName(disk: { deviceName?: string; source?: string }): string {
  return lastSegment(disk.source) || disk.deviceName || "a disk";
}

/** The `ssh-keys` entry: `user:key`. A comment that Google would read as an expiry is left out. */
export function sshKeysEntry(key: CreateRequest["key"]): string {
  const comment = key.comment.startsWith("google-ssh") ? "" : key.comment;
  return `${LOGIN}:${[key.algorithm, key.blob, comment].filter((part) => part !== "").join(" ")}`;
}

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and its reasons kept for the callers that tell them apart. */
export class GcpError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly reasons: string[],
    /** What the API said, in its own words, without what the CLI added around it. */
    readonly said = "",
  ) {
    super(failure);
  }
}

/** An operation that ended in error: the codes of its errors, `ZONE_RESOURCE_POOL_EXHAUSTED`... */
export class OperationError extends ProviderError {
  constructor(
    failure: Failure,
    readonly codes: string[],
    readonly said: string,
  ) {
    super(failure);
  }
}

const ROLES = "the account needs Compute Instance Admin (v1), Compute Network Admin and Compute Security Admin on the project, or Compute Admin on a project of its own (docs/providers/gcp.md)";

/**
 * An error answer of the API as a failure the CLI reports, with the code its
 * hint is found by. `what` says what was being done, in the infinitive:
 * `create the instance web`. `project` names the project, for the advice.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string, project: string): GcpError {
  const error = (body as ErrorBody | null)?.error;
  const said = typeof error?.message === "string" ? error.message : `answered ${status}`;
  const reasons = [
    ...(error?.errors ?? []).map((item) => item.reason),
    ...(error?.details ?? []).map((item) => item.reason),
  ].filter((reason): reason is string => typeof reason === "string" && reason !== "");
  const has = (...candidates: string[]) => candidates.some((candidate) => reasons.includes(candidate));
  const label = reasons[0] ?? (typeof error?.status === "string" ? error.status : "");
  const answer = `${status}${label === "" ? "" : ` ${label}`}`;
  const make = (failure: Failure) => new GcpError(failure, status, reasons, said);

  if (status === 401) {
    return make({
      error: "provider-unauthenticated",
      message: `Google Cloud refused the credentials (${answer}): the access token expired, it lasts an hour, or it was revoked or copied wrong`,
      details: ["`gcloud auth print-access-token` prints a fresh one; a service account's key is exchanged for a new one at each run"],
    });
  }
  if (status === 403 && has("accessNotConfigured", "SERVICE_DISABLED")) {
    return make({
      error: "provider-api-disabled",
      message: `the Compute Engine API is not enabled in the project ${project} (${answer})`,
      details: [
        "enable it in the Google Cloud console: APIs & Services, Library, Compute Engine API, Enable; or with `gcloud services enable compute.googleapis.com`",
        "it takes a few minutes to apply, and the project needs a billing account",
      ],
    });
  }
  if ((status === 403 || status === 429) && has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED")) {
    return make({ error: "provider-rate-limited", message: `Google Cloud's rate limit is reached, nothing more can be asked of it for now (${answer})`, details: [], wait: retryAfter(headers) });
  }
  if (status === 403 && has("quotaExceeded", "QUOTA_EXCEEDED")) {
    return make({ error: "provider-limit", message: `Google Cloud refused to ${what} (${answer}): ${said}`, details: ["the project's quotas are in the console under IAM & Admin, Quotas & System Limits"] });
  }
  if (status === 403) return make({ error: "provider-forbidden", message: `the credentials may not ${what} (${answer}): ${said}`, details: [ROLES] });
  if (status === 404) return make({ error: "provider-not-found", message: `Google Cloud could not ${what} (${answer}): ${said}` });
  if (status === 409 && has("alreadyExists")) return make({ error: "provider-name-taken", message: `Google Cloud refused to ${what} (${answer}): ${said}` });
  if (status === 409 || status === 412 || has("resourceInUseByAnotherResource", "resourceNotReady")) {
    return make({ error: "provider-busy", message: `Google Cloud could not ${what} right now (${answer}): ${said}` });
  }
  if (status === 429) {
    return make({ error: "provider-rate-limited", message: `Google Cloud's rate limit is reached, nothing more can be asked of it for now (${answer})`, details: [], wait: retryAfter(headers) });
  }
  if (status >= 500) return make({ error: "provider-failure", message: `Google Cloud failed to ${what} (${answer}): ${said}`, details: ["the failure is on Google's side"] });
  return make({ error: "provider-invalid", message: `Google Cloud refused to ${what} (${answer}): ${said}` });
}

/** An operation that ended in error, as a failure. */
export function operationFailure(operation: GcpOperation, what: string): OperationError {
  const errors = operation.error?.errors ?? [];
  const codes = errors.map((item) => item.code ?? "").filter((code) => code !== "");
  const said = errors.map((item) => item.message ?? "").filter((message) => message !== "").join("; ") || operation.httpErrorMessage || "no reason given";
  const answer = codes.join(", ") || String(operation.httpErrorStatusCode ?? "error");
  if (codes.some((code) => code.startsWith("ZONE_RESOURCE_POOL_EXHAUSTED"))) {
    return new OperationError({ error: "type-unavailable", message: `Google Cloud has no room to ${what} right now (${answer}): ${said}` }, codes, said);
  }
  if (codes.includes("QUOTA_EXCEEDED")) {
    return new OperationError(
      { error: "provider-limit", message: `Google Cloud refused to ${what} (${answer}): ${said}`, details: ["the project's quotas are in the console under IAM & Admin, Quotas & System Limits"] },
      codes,
      said,
    );
  }
  return new OperationError({ error: "action-failed", message: `Google Cloud could not ${what} (${answer}): ${said}`, details: [`operation ${operation.name}`] }, codes, said);
}

// --- what the answers mean -------------------------------------------------------------------

export function toMachine(instance: GcpInstance): Machine {
  const nic = instance.networkInterfaces?.[0];
  const ipv6 = nic?.ipv6AccessConfigs?.[0];
  return {
    provider: "gcp",
    id: String(instance.id),
    name: instance.name,
    type: lastSegment(instance.machineType) || "unknown",
    location: lastSegment(instance.zone) || "unknown",
    status: (instance.status ?? "unknown").toLowerCase(),
    ipv4: nic?.accessConfigs?.[0]?.natIP ?? null,
    ipv6: ipv6?.externalIpv6 ?? null,
    ipv6Network: ipv6?.externalIpv6 === undefined || ipv6.externalIpv6PrefixLength === undefined ? null : `${ipv6.externalIpv6}/${ipv6.externalIpv6PrefixLength}`,
    // The API gives no price; the Cloud Billing catalogue needs credentials of its own.
    monthlyPrice: null,
    backups: false,
    managed: isManaged(instance.labels),
    labels: instance.labels ?? {},
    login: LOGIN,
  };
}

function gigabytes(memoryMb: number): string {
  return String(Number((memoryMb / 1024).toFixed(1)));
}

export function typeHint(type: GcpMachineType): string {
  return `${type.guestCpus} vCPU${type.isSharedCpu === true ? " (shared core)" : ""}, ${gigabytes(type.memoryMb)} GB memory`;
}

/**
 * The types worth offering: x86, at least 2 GB, not deprecated, of the
 * series OFFERED_SERIES names, the two shared-core E2 and the `standard`
 * shapes up to 8 vCPUs; E2 first, then by series, vCPUs and memory; the
 * default first when it is among them.
 */
export function offeredTypes(types: GcpMachineType[], count = 12): GcpMachineType[] {
  const rank = (type: GcpMachineType) => OFFERED_SERIES.indexOf(seriesOf(type.name));
  return types
    .filter((type) => {
      if (rank(type) === -1 || isArm(type) || type.memoryMb < 2048) return false;
      if ((type.deprecated?.state ?? "ACTIVE") !== "ACTIVE") return false;
      const standard = /^[a-z0-9]+-standard-(2|4|8)$/.test(type.name);
      return standard || type.name === "e2-small" || type.name === "e2-medium";
    })
    .sort((a, b) => Number(b.name === DEFAULT_TYPE) - Number(a.name === DEFAULT_TYPE) || rank(a) - rank(b) || a.guestCpus - b.guestCpus || a.memoryMb - b.memoryMb)
    .slice(0, count);
}

/** One zone a region, the default region first then by name: what the wizard and a refused --location list. */
export function zoneChoices(zones: GcpZone[], defaultZone = DEFAULT_ZONE): Choice[] {
  const byRegion = new Map<string, string[]>();
  for (const zone of zones) {
    if (!STANDARD_ZONE.test(zone.name) || zone.status !== "UP" || (zone.deprecated?.state ?? "ACTIVE") !== "ACTIVE") continue;
    const region = lastSegment(zone.region) || regionOf(zone.name);
    byRegion.set(region, [...(byRegion.get(region) ?? []), zone.name].sort());
  }
  const defaultRegion = regionOf(defaultZone);
  return [...byRegion.entries()]
    .sort(([a], [b]) => Number(b === defaultRegion) - Number(a === defaultRegion) || a.localeCompare(b))
    .map(([region, names]) => {
      const place = REGIONS[region];
      const value = region === defaultRegion && names.includes(defaultZone) ? defaultZone : names[0]!;
      return {
        value,
        label: place === undefined ? region : `${place[0]}, ${place[1]}`,
        hint: `${region}, zones ${names.map((name) => name.slice(region.length + 1)).join(", ")}`,
      };
    });
}

function choiceLines(choices: Choice[]): string[] {
  const width = Math.max(0, ...choices.map((choice) => choice.value.length));
  return choices.map((choice) => `${choice.value.padEnd(width)}  ${choice.label}${choice.hint === undefined ? "" : `, ${choice.hint}`}`);
}

// --- credentials -----------------------------------------------------------------------------

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

/** The DER inside a PKCS #8 PEM, its newlines real or written `\n`; null when it is not one. */
export function pkcs8(pem: string): Uint8Array<ArrayBuffer> | null {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replaceAll("\\n", "\n"));
  const body = match?.[1]?.replace(/\s+/g, "") ?? "";
  if (body === "" || !/^[A-Za-z0-9+/]+=*$/.test(body)) return null;
  return new Uint8Array(Buffer.from(body, "base64"));
}

/**
 * The JWT a service account presents to the token endpoint, signed RS256:
 * https://developers.google.com/identity/protocols/oauth2/service-account
 * It is valid an hour, the most Google accepts, and asks for the compute
 * scope alone.
 */
export async function signedAssertion(email: string, privateKey: string, now: number, audience: string): Promise<string> {
  const der = pkcs8(privateKey);
  let key: CryptoKey;
  try {
    if (der === null) throw new Error("not a PEM");
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new ProviderError({
      error: "provider-unauthenticated",
      message: "the service account's private key could not be read: it is not the PKCS #8 RSA key a Google key file holds",
      details: ["make a new JSON key for the service account in the console: IAM & Admin, Service Accounts, the account, Keys, Add key"],
    });
  }
  const issued = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: email, scope: SCOPE, aud: audience, iat: issued, exp: issued + 3600 }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/** The fields of a service account key file sitesolide uses; null for anything else, an authorized_user file included. */
export function readKeyFile(text: string | null): { email: string; privateKey: string; project: string | null } | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const file = parsed as { type?: unknown; client_email?: unknown; private_key?: unknown; project_id?: unknown } | null;
  if (file?.type !== "service_account") return null;
  if (typeof file.client_email !== "string" || !EMAIL_SHAPE.test(file.client_email)) return null;
  if (typeof file.private_key !== "string" || !KEY_SHAPE.test(file.private_key)) return null;
  const project = typeof file.project_id === "string" && PROJECT_SHAPE.test(file.project_id) ? file.project_id : null;
  return { email: file.client_email, privateKey: file.private_key, project };
}

/**
 * Credentials the workstation already holds, in the order Google's own
 * client libraries look for them: the service account key file
 * GOOGLE_APPLICATION_CREDENTIALS names, a deliberate choice, then the gcloud
 * CLI, signed in. The project comes from GOOGLE_CLOUD_PROJECT or
 * CLOUDSDK_CORE_PROJECT, else the key file, else gcloud's configuration.
 * Nothing here reaches the network: a key is exchanged by the provider.
 */
export async function discover(workstation: Workstation): Promise<Discovery | null> {
  const environment = workstation.environment;
  const named = [environment[PROJECT_VARIABLE], environment.CLOUDSDK_CORE_PROJECT].map((value) => value?.trim() ?? "").find((value) => PROJECT_SHAPE.test(value));

  const keyPath = environment.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const key = keyPath === undefined || keyPath === "" ? null : readKeyFile(workstation.readFile(keyPath));
  if (key !== null) {
    const project = named ?? key.project;
    return {
      source: "the service account key file GOOGLE_APPLICATION_CREDENTIALS names",
      credentials: { ...(project === null ? {} : { [PROJECT_VARIABLE]: project }), [EMAIL_VARIABLE]: key.email, [KEY_VARIABLE]: key.privateKey },
    };
  }

  const printed = await workstation.run(["gcloud", "auth", "print-access-token"]);
  const token = printed.stdout.trim();
  if (printed.code !== 0 || !TOKEN_SHAPE.test(token)) return null;
  let project = named ?? null;
  if (project === null) {
    const configured = await workstation.run(["gcloud", "config", "get-value", "project"]);
    const value = configured.stdout.trim();
    if (configured.code === 0 && PROJECT_SHAPE.test(value)) project = value;
  }
  return { source: "the gcloud CLI, signed in", credentials: { ...(project === null ? {} : { [PROJECT_VARIABLE]: project }), [TOKEN_VARIABLE]: token } };
}

// --- the provider ---------------------------------------------------------------------------

/** A write this run made before the instance, undone if the order is refused. */
type Made = { kind: string; name: string; path: string };

export function gcp(context: ProviderContext): Provider {
  const base = apiAddress(context.environment, API_VARIABLE, DEFAULT_API);
  const oauth = apiAddress(context.environment, OAUTH_VARIABLE, DEFAULT_OAUTH);
  const host = new URL(base).host;
  const { clock, fetcher } = context;
  const credentials: Credentials = context.credentials;
  const project = credentials[PROJECT_VARIABLE]?.trim() ?? "";
  const given = credentials[TOKEN_VARIABLE]?.trim() ?? "";
  const email = credentials[EMAIL_VARIABLE]?.trim() ?? "";
  const privateKey = credentials[KEY_VARIABLE] ?? "";

  if (!PROJECT_SHAPE.test(project)) {
    throw new ProviderError({ error: "no-provider-token", message: `no Google Cloud project: set ${PROJECT_VARIABLE} to the project's ID`, details: GCP.credentialHelp });
  }
  if (given === "" && (email === "" || privateKey.trim() === "")) {
    throw new ProviderError({
      error: "no-provider-token",
      message: `no Google Cloud credentials: sign in with gcloud, name a service account key file with GOOGLE_APPLICATION_CREDENTIALS, or set ${TOKEN_VARIABLE}`,
      details: GCP.credentialHelp,
    });
  }

  /** The project's own path, under which nearly every call lives. */
  const own = (rest: string) => `/projects/${project}${rest}`;

  // --- the access token

  let exchanged: { value: string; expires: number } | null = null;

  async function exchange(): Promise<{ value: string; expires: number }> {
    const assertion = await signedAssertion(email, privateKey, clock.now(), oauth);
    context.secret(assertion);
    const oauthHost = new URL(oauth).host;
    let response: Response;
    try {
      response = await fetcher(oauth, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new ProviderError({ error: "provider-unreachable", message: `${oauthHost} unreachable while exchanging the service account's key for a token: ${(error as Error).message}` });
    }
    let body = null as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      if (response.status < 500 && response.status !== 429) {
        throw new ProviderError({ error: "provider-unreadable", message: `${oauthHost} answered ${response.status} with something that is not Google's token endpoint` });
      }
    }
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : "";
      const said = typeof body?.error_description === "string" ? body.error_description : `answered ${response.status}`;
      const answer = `${response.status}${code === "" ? "" : ` ${code}`}`;
      if (response.status === 429) throw new ProviderError({ error: "provider-rate-limited", message: `Google's token endpoint asks to wait (${answer})`, wait: retryAfter(response.headers) });
      if (response.status >= 500) throw new ProviderError({ error: "provider-failure", message: `Google's token endpoint failed (${answer}): ${said}`, details: ["the failure is on Google's side"] });
      throw new ProviderError({
        error: "provider-unauthenticated",
        message: `Google refused the service account's key (${answer}): ${said}`,
        details: ["the key may have been deleted or disabled, the account too; or this workstation's clock is off by more than a few minutes"],
      });
    }
    const value = body?.access_token;
    if (typeof value !== "string" || !TOKEN_SHAPE.test(value)) {
      throw new ProviderError({ error: "provider-unreadable", message: `${oauthHost} answered without an access token` });
    }
    context.secret(value);
    const lifetime = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    // Renewed five minutes before Google stops taking it.
    return { value, expires: clock.now() + Math.max(60, lifetime - 300) * 1000 };
  }

  async function bearer(): Promise<string> {
    if (given !== "") return given;
    if (exchanged === null || clock.now() >= exchanged.expires) exchanged = await exchange();
    return exchanged.value;
  }

  // --- calls

  function withQuery(path: string, query: Record<string, string>): string {
    const pairs = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
  }

  /** One call: the token in its header, JSON both ways, every failure said in the CLI's words. */
  async function call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    const token = await bearer();
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
      throw new GcpError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, []);
    }
    if (response.status === 204) return {} as T;
    let parsed: unknown = null;
    let readable = true;
    try {
      parsed = await response.json();
    } catch {
      readable = false;
    }
    // A front end of Google's may answer a 502 or a 429 in HTML: still
    // Google saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new GcpError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Google Cloud's API, while trying to ${what}` }, response.status, []);
    }
    if (!response.ok) throw failureFrom(response.status, parsed, response.headers, what, project);
    return parsed as T;
  }

  /** A read that answers null for a 404: the resource is not there. */
  async function read<T>(path: string, what: string): Promise<T | null> {
    try {
      return await call<T>("GET", path, what);
    } catch (error) {
      if (error instanceof GcpError && error.status === 404) return null;
      throw error;
    }
  }

  /** Every page of a list, following `nextPageToken`. The API leaves `items` out of an empty page. */
  async function listAll<T>(path: string, what: string): Promise<T[]> {
    const items: T[] = [];
    let token: string | null = null;
    for (let pages = 0; pages < 500; pages++) {
      const answer: { items?: unknown; nextPageToken?: unknown } = await call("GET", withQuery(path, { maxResults: "500", ...(token === null ? {} : { pageToken: token }) }), what);
      if (answer.items !== undefined && !Array.isArray(answer.items)) {
        throw new GcpError({ error: "provider-unreadable", message: `${host} answered without a list, while trying to ${what}` }, 200, []);
      }
      items.push(...((answer.items ?? []) as T[]));
      token = typeof answer.nextPageToken === "string" && answer.nextPageToken !== "" ? answer.nextPageToken : null;
      if (token === null) break;
    }
    return items;
  }

  /**
   * Every page of an aggregated list: `items` maps each zone or region to its
   * own list, or to a warning when it has none on the page.
   */
  async function aggregated<T>(collection: "instances" | "addresses", what: string, filter?: string): Promise<T[]> {
    const items: T[] = [];
    let token: string | null = null;
    for (let pages = 0; pages < 500; pages++) {
      const query = { ...(filter === undefined ? {} : { filter }), maxResults: "500", ...(token === null ? {} : { pageToken: token }) };
      const answer: { items?: unknown; nextPageToken?: unknown } = await call("GET", withQuery(own(`/aggregated/${collection}`), query), what);
      if (answer.items !== undefined && (typeof answer.items !== "object" || answer.items === null || Array.isArray(answer.items))) {
        throw new GcpError({ error: "provider-unreadable", message: `${host} answered without the ${collection} of each scope, while trying to ${what}` }, 200, []);
      }
      for (const scoped of Object.values((answer.items ?? {}) as Record<string, Record<string, unknown>>)) {
        const list = scoped?.[collection];
        if (Array.isArray(list)) items.push(...(list as T[]));
      }
      token = typeof answer.nextPageToken === "string" && answer.nextPageToken !== "" ? answer.nextPageToken : null;
      if (token === null) break;
    }
    return items;
  }

  /** The instances of that name in every zone: names are unique a zone, not a project. */
  async function instancesNamed(name: string): Promise<GcpInstance[]> {
    // The filter is the API reference's own example, `name != example-instance`, with `=`.
    const found = await aggregated<GcpInstance>("instances", "read the instances", `name = ${name}`);
    return found.filter((instance) => instance.name === name);
  }

  /** Polls an operation until it is DONE, bounded; one that ends in error throws an OperationError. */
  async function waitFor(operation: GcpOperation, what: string, report: Report): Promise<void> {
    const scope = operation.zone !== undefined ? `/zones/${lastSegment(operation.zone)}` : operation.region !== undefined ? `/regions/${lastSegment(operation.region)}` : "/global";
    const path = own(`${scope}/operations/${operation.name}`);
    const deadline = clock.now() + WAITS.operationMs;
    const warned = { done: false };
    let current = operation;
    for (;;) {
      if (current.status === "DONE") {
        if ((current.error?.errors ?? []).length > 0) throw operationFailure(current, what);
        report(`   ${current.operationType ?? "operation"}: done`);
        return;
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({
          error: "machine-timeout",
          message: `Google Cloud is still working to ${what} after ${WAITS.operationMs / 60_000} minutes`,
          details: [`operation ${current.name}, ${current.status.toLowerCase()}${current.progress === undefined ? "" : `, ${current.progress} %`}`],
        });
      }
      await clock.sleep(WAITS.pollMs);
      const read = await patiently(clock, () => call<GcpOperation>("GET", path, `follow the operation to ${what}`), deadline, report, warned);
      if (read !== null) current = read;
    }
  }

  async function waitRunning(zone: string, name: string, report: Report, justCreated: boolean): Promise<GcpInstance> {
    const deadline = clock.now() + WAITS.runningMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const instance = await patiently(clock, () => call<GcpInstance>("GET", own(`/zones/${zone}/instances/${name}`), `read the instance ${name}`), deadline, report, warned);
      if (instance !== null) {
        const status = (instance.status ?? "").toLowerCase();
        if (status !== last) report(`   status: ${status}`);
        last = status;
        if (instance.status === "RUNNING") return instance;
        if (!justCreated && (instance.status === "TERMINATED" || instance.status === "STOPPED" || instance.status === "SUSPENDED")) {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is ${status}`, details: ["sitesolide never starts or stops a machine by itself"] });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  // --- what is read before anything is written

  async function readZones(): Promise<GcpZone[]> {
    return listAll<GcpZone>(own("/zones"), "read the zones");
  }

  async function checkZone(location: string, report: Report): Promise<{ zone: string; region: string; zones: GcpZone[] }> {
    report(`-> zone ${location}`);
    const zones = ZONE_SHAPE.test(location) ? await readZones() : [];
    const zone = zones.find((candidate) => candidate.name === location);
    if (zone === undefined || (zone.deprecated?.state ?? "ACTIVE") !== "ACTIVE") {
      const all = zones.length > 0 ? zones : await readZones();
      throw new ProviderError({
        error: "invalid-location",
        message: zone === undefined ? `${location} is not a zone the project can use` : `${location} is deprecated`,
        details: ["a zone of each region:", ...choiceLines(zoneChoices(all))],
      });
    }
    if (zone.status !== "UP") {
      throw new ProviderError({ error: "provider-unavailable", message: `the zone ${location} is ${zone.status ?? "not up"} right now`, details: ["pick another zone of the region with --location, or run the same command again later"] });
    }
    const region = lastSegment(zone.region) || regionOf(zone.name);
    const place = REGIONS[region];
    report(`   ${place === undefined ? region : `${place[0]}, ${place[1]}`}, up`);
    return { zone: zone.name, region, zones };
  }

  async function checkType(type: string, zone: string, report: Report): Promise<GcpMachineType> {
    report(`-> ${type} at ${zone}`);
    const found = TYPE_SHAPE.test(type) ? await read<GcpMachineType>(own(`/zones/${zone}/machineTypes/${type}`), `read the machine type ${type}`) : null;
    const state = found?.deprecated?.state ?? "ACTIVE";
    if (found === null || state === "OBSOLETE" || state === "DELETED") {
      const offered = offeredTypes(await listAll<GcpMachineType>(own(`/zones/${zone}/machineTypes`), "read the machine types"));
      throw new ProviderError({
        error: "invalid-server-type",
        message: found === null ? `${type} is not a machine type of the zone ${zone}` : `${type} is no longer sold (${state.toLowerCase()})`,
        details: [`the types worth trying at ${zone}:`, ...choiceLines(offered.map((item) => ({ value: item.name, label: typeHint(item) })))],
      });
    }
    report(`   ${typeHint(found)}${state === "DEPRECATED" ? ", deprecated" : ""}`);
    if (state === "DEPRECATED") report(`!! Google lists ${type} as deprecated; it is still sold`);
    return found;
  }

  /** The image `create` asks for, checked: Debian 13 for the type's architecture, or a path to an image of Google's. */
  async function checkImage(image: string, type: GcpMachineType, report: Report): Promise<string> {
    const source = image === DEBIAN ? debianImage(isArm(type)) : image;
    report(`-> image ${image === DEBIAN ? `${DEBIAN}, ${source}` : source}`);
    if (!IMAGE_PATH.test(source)) {
      throw new ProviderError({
        error: "provider-invalid",
        message: `${image} is not an image sitesolide can order on Google Cloud`,
        details: [`--image takes ${DEBIAN}, or a path to an image or an image family: projects/debian-cloud/global/images/family/debian-13`],
      });
    }
    const found = await read<GcpImage>(`/${source}`, `read the image ${source}`);
    if (found === null) throw new ProviderError({ error: "provider-invalid", message: `Google Cloud has no image ${source}`, details: ["the image or its family does not exist, or the account may not read it"] });
    report(`   ${found.name}${found.architecture === undefined ? "" : `, ${found.architecture.toLowerCase()}`}`);
    return source;
  }

  /** The default network, and the subnet of the region the instance is attached to. */
  async function checkNetwork(region: string, report: Report): Promise<{ network: string; subnetwork: string | null }> {
    report("-> the default network");
    const network = await read<GcpNetwork>(own("/global/networks/default"), "read the default network");
    const how = [
      "a project starts with a default network unless an organization policy prevents it (compute.skipDefaultNetworkCreation)",
      "create one in the console, VPC network, Create VPC network, named default, with automatic subnets; or `gcloud compute networks create default --subnet-mode=auto`",
    ];
    if (network === null) throw new ProviderError({ error: "no-default-network", message: `the project ${project} has no network named default, which the machine is attached to`, details: how });
    const subnetwork = (network.subnetworks ?? []).find((url) => url.includes(`/regions/${region}/subnetworks/`)) ?? null;
    if (subnetwork === null && network.autoCreateSubnetworks !== true && network.IPv4Range === undefined) {
      throw new ProviderError({ error: "no-default-network", message: `the default network of ${project} has no subnet in ${region}`, details: [`add one in ${region}, or pick a zone of a region it has a subnet in`, ...how.slice(1)] });
    }
    report(`   ${subnetwork === null ? "found" : `subnet ${lastSegment(subnetwork)} in ${region}`}`);
    return { network: network.selfLink, subnetwork };
  }

  /** The two rules, when sitesolide created them; one of their names that is not sitesolide's refuses the run. */
  async function findRules(name: string): Promise<(GcpFirewall | null)[]> {
    const rules: (GcpFirewall | null)[] = [];
    for (const ruleName of Object.values(ruleNamesOf(name))) {
      const rule = await read<GcpFirewall>(own(`/global/firewalls/${ruleName}`), `read the firewall rule ${ruleName}`);
      if (rule !== null && !ownRule(rule, name)) {
        throw new ProviderError({
          error: "firewall-taken",
          message: `a firewall rule named ${ruleName} exists in the project, and sitesolide did not create it`,
          details: [`its description does not start with ${markOf(name)}, or it targets more than the tag ${tagOf(name)}: it is never adopted nor changed`],
        });
      }
      rules.push(rule);
    }
    return rules;
  }

  async function findAddress(region: string, name: string): Promise<GcpAddress | null> {
    const addressName = addressNameOf(name);
    const address = await read<GcpAddress>(own(`/regions/${region}/addresses/${addressName}`), `read the address ${addressName}`);
    if (address === null) return null;
    if (!ownAddress(address, name)) {
      throw new ProviderError({
        error: "provider-name-taken",
        message: `an address named ${addressName} exists in ${region}, and sitesolide did not reserve it`,
        details: [`it lacks the label ${MANAGED_LABEL}=${MANAGED_VALUE}: it is never adopted nor changed`],
      });
    }
    if ((address.users ?? []).length > 0) {
      throw new ProviderError({
        error: "provider-name-taken",
        message: `the address ${addressName}, reserved by sitesolide, is in use by something else`,
        details: (address.users ?? []).map((user) => `used by ${user.replace(/^.*\/projects\//, "projects/")}`),
      });
    }
    return address;
  }

  // --- what is written

  async function ensureRule(rule: ReturnType<typeof firewallRules>[number], found: GcpFirewall | null, report: Report, made: Made[]): Promise<Resource> {
    report(`-> firewall rule ${rule.name}`);
    if (found !== null) {
      report("   already created by sitesolide, reused");
      return { kind: "firewall rule", name: found.name, id: String(found.id), reused: true };
    }
    const operation = await call<GcpOperation>("POST", own("/global/firewalls"), `create the firewall rule ${rule.name}`, rule);
    made.push({ kind: "firewall rule", name: rule.name, path: own(`/global/firewalls/${rule.name}`) });
    await waitFor(operation, `create the firewall rule ${rule.name}`, report);
    // The description after the mark says what the rule does.
    report(`   created: ${rule.description.split(": ").slice(1).join(": ")}`);
    return { kind: "firewall rule", name: rule.name, id: operation.targetId ?? rule.name, reused: false };
  }

  async function ensureAddress(region: string, name: string, found: GcpAddress | null, report: Report, made: Made[]): Promise<{ address: GcpAddress; resource: Resource }> {
    const addressName = addressNameOf(name);
    const path = own(`/regions/${region}/addresses/${addressName}`);
    report(`-> static address ${addressName} in ${region}`);
    let address = found;
    let reused = true;
    if (address === null) {
      const operation = await call<GcpOperation>("POST", own(`/regions/${region}/addresses`), `reserve the address ${addressName}`, {
        name: addressName,
        description: `${markOf(name)}: the machine's public IPv4, kept across a stop and a start`,
        addressType: "EXTERNAL",
        networkTier: "PREMIUM",
        labels: labelsFor(name),
      });
      made.push({ kind: "address", name: addressName, path });
      await waitFor(operation, `reserve the address ${addressName}`, report);
      address = await call<GcpAddress>("GET", path, `read the address ${addressName}`);
      reused = false;
    }
    if (!isManaged(address.labels)) {
      // The reference sets an address's labels through setLabels, with the
      // fingerprint of those it has: whether insert took them or not, they
      // are there after this.
      const operation = await call<GcpOperation>("POST", `${path}/setLabels`, `label the address ${addressName}`, { labels: labelsFor(name), labelFingerprint: address.labelFingerprint ?? "" });
      await waitFor(operation, `label the address ${addressName}`, report);
      address = await call<GcpAddress>("GET", path, `read the address ${addressName}`);
    }
    if (typeof address.address !== "string" || address.address === "") {
      throw new GcpError({ error: "provider-unreadable", message: `${host} answered without the address of ${addressName}` }, 200, []);
    }
    report(reused ? `   ${address.address}, already reserved by sitesolide, reused` : `   reserved: ${address.address}`);
    return { address, resource: { kind: "address", name: addressName, id: String(address.id), reused } };
  }

  /**
   * Deletes what this run created before an order Google refused: the rules
   * and the address were made for an instance that does not exist, and
   * nothing in sitesolide would ever list or remove them, since `list` and
   * `destroy` start from an instance. What an earlier run made, or the
   * project already held, is left as it was. A deletion that fails leaves the
   * resource marked, where the next run finds and reuses it. Returns what
   * happened, one line each, for the refusal's details.
   */
  async function undo(made: Made[], machine: string, report: Report): Promise<string[]> {
    if (made.length === 0) return ["this run had created nothing yet"];
    // The address first: it was created last.
    return undoMade(
      made,
      async (resource) => {
        const operation = await call<GcpOperation>("DELETE", resource.path, `delete the ${resource.kind} ${resource.name}`);
        await waitFor(operation, `delete the ${resource.kind} ${resource.name}`, () => {});
      },
      report,
      (resource) => `left the ${resource.kind} ${resource.name}: the next run reuses it, or \`sitesolide machine destroy ${machine} --provider gcp\` removes it`,
    );
  }

  /** What to try instead of a type the zone has no room for: the other zones of the region, and other types. */
  async function alternatives(type: string, zone: string, region: string, zones: GcpZone[]): Promise<string[]> {
    const others = zones.filter((candidate) => candidate.name !== zone && candidate.status === "UP" && (lastSegment(candidate.region) || regionOf(candidate.name)) === region && STANDARD_ZONE.test(candidate.name));
    let types: GcpMachineType[] = [];
    try {
      types = offeredTypes(await listAll<GcpMachineType>(own(`/zones/${zone}/machineTypes`), "read the machine types")).filter((candidate) => candidate.name !== type);
    } catch {
      // The suggestions are a courtesy: the refusal stands without them.
    }
    return [
      ...(others.length === 0 ? [] : [`the other zones of ${region}, as --location: ${others.map((candidate) => candidate.name).sort().join(", ")}`]),
      ...(types.length === 0 ? [] : [`other types of ${zone}, as --type:`, ...choiceLines(types.slice(0, 6).map((item) => ({ value: item.name, label: typeHint(item) })))]),
    ];
  }

  /**
   * The order itself, once no instance of that name exists: everything that
   * can refuse is read, then the rules, the address and the instance are
   * made, or reused when an earlier run made them.
   */
  async function order(request: CreateRequest, resources: Resource[], report: Report): Promise<CreateOutcome> {
    const { zone, region, zones } = await checkZone(request.location, report);
    const type = await checkType(request.type, zone, report);
    const image = await checkImage(request.image, type, report);
    const { network, subnetwork } = await checkNetwork(region, report);
    const foundRules = await findRules(request.name);
    const foundAddress = await findAddress(region, request.name);

    // What this run creates before the instance, undone if the order is refused.
    const made: Made[] = [];
    let ordering = false;
    let accepted = false;
    try {
      const rules = firewallRules(request.name, network);
      for (const [index, rule] of rules.entries()) resources.push(await ensureRule(rule, foundRules[index] ?? null, report, made));
      const { address, resource } = await ensureAddress(region, request.name, foundAddress, report, made);
      resources.push(resource);

      report(`-> instance ${request.name}: ${request.type} at ${zone}, ${request.image}`);
      // A token that needs renewing is renewed before the order leaves, so
      // that a refusal of the renewal is not mistaken for an order in flight.
      await bearer();
      ordering = true;
      const operation = await call<GcpOperation>("POST", own(`/zones/${zone}/instances`), `create the instance ${request.name}`, {
        name: request.name,
        description: `${markOf(request.name)}: created by sitesolide machine create`,
        machineType: `zones/${zone}/machineTypes/${request.type}`,
        labels: labelsFor(request.name),
        tags: { items: [tagOf(request.name)] },
        metadata: {
          items: [
            { key: "ssh-keys", value: sshKeysEntry(request.key) },
            // An organization may turn OS Login on for the whole project,
            // and the guest agent then ignores the key above. The
            // instance's own value wins over the project's.
            { key: "enable-oslogin", value: "FALSE" },
            // The guest agent makes a sudoer of every key in the project's
            // metadata too: this machine takes its own keys only.
            { key: "block-project-ssh-keys", value: "TRUE" },
          ],
        },
        disks: [
          {
            boot: true,
            autoDelete: true,
            type: "PERSISTENT",
            initializeParams: {
              sourceImage: image,
              diskSizeGb: String(DISK_GB),
              diskType: `zones/${zone}/diskTypes/${bootDiskType(request.type)}`,
              labels: labelsFor(request.name),
            },
          },
        ],
        networkInterfaces: [
          {
            network,
            ...(subnetwork === null ? {} : { subnetwork }),
            accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT", natIP: address.address, networkTier: address.networkTier ?? "PREMIUM" }],
          },
        ],
      });
      accepted = true;
      report(`   ordered, operation ${operation.name}`);
      await waitFor(operation, `create the instance ${request.name}`, report);
      resources.push({ kind: "instance", name: request.name, id: operation.targetId ?? request.name, reused: false });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      // Once the order has left, it is undone only when Google said no: a
      // request it refused, or an operation that ended in error. An order
      // whose outcome is unknown, a wait that timed out or a network that
      // failed on the way, may yet create the instance, which would then
      // have lost its rules.
      const refused = error instanceof OperationError || (!accepted && error instanceof GcpError && error.status >= 400 && error.status < 500);
      if (ordering && !refused) {
        throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), "the order may still go through: nothing was undone, and the next run picks up what exists", `to give the machine up instead, \`sitesolide machine destroy ${request.name} --provider gcp\` removes what exists`] });
      }
      const undone = await undo(made, request.name, report);
      if (error.failure.error === "type-unavailable") {
        throw new ProviderError({
          error: "type-unavailable",
          message: error.failure.message,
          details: [...(await alternatives(request.type, zone, region, zones)), ...undone],
        });
      }
      throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone] });
    }
    report(`-> ${request.name} running`);
    const running = await waitRunning(zone, request.name, report, true);
    return { machine: toMachine(running), created: true, resources };
  }

  /** What an earlier run made for a machine besides its instance: its address in any region, its two rules. */
  async function leftoversOf(name: string): Promise<Leftovers> {
    const addresses = (await aggregated<GcpAddress>("addresses", "read the addresses")).filter((address) => ownAddress(address, name));
    const rules: GcpFirewall[] = [];
    for (const ruleName of Object.values(ruleNamesOf(name))) {
      const rule = await read<GcpFirewall>(own(`/global/firewalls/${ruleName}`), `read the firewall rule ${ruleName}`);
      if (rule !== null && ownRule(rule, name)) rules.push(rule);
    }
    return { addresses, rules };
  }

  return {
    name: "gcp",

    async find(name) {
      const instances = await instancesNamed(name);
      const ours = instances.find((instance) => isManaged(instance.labels));
      if (ours !== undefined) return toMachine(ours);
      // Without an instance, what an earlier run made for it is still a
      // machine of sitesolide's: one a destroy finishes, a create reuses.
      const left = await leftoversOf(name);
      if (left.addresses.length > 0 || left.rules.length > 0) return incompleteMachine(name, left);
      return instances[0] === undefined ? null : toMachine(instances[0]);
    },

    async create(request, report): Promise<CreateOutcome> {
      const problem = nameProblem(request.name);
      if (problem !== null) throw new ProviderError({ error: "provider-invalid", message: `Google Cloud would not take the name ${request.name}: ${problem}`, details: ["pick another --name"] });
      if (request.backups) {
        throw new ProviderError({ error: "provider-invalid", message: "--backups is not implemented on Google Cloud", details: ["Google's snapshot schedules are not created by sitesolide; the machine's own backups are `sitesolide backups`"] });
      }
      const resources: Resource[] = [];
      report(`-> an instance named ${request.name} in the project ${project}`);
      const existing = await instancesNamed(request.name);
      const ours = existing.find((instance) => isManaged(instance.labels));
      if (ours !== undefined) {
        const found = toMachine(ours);
        report(`   already created by sitesolide: ${found.type} at ${found.location}, ${found.status}`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        resources.push({ kind: "instance", name: ours.name, id: String(ours.id), reused: true });
        report(`-> ${request.name} running`);
        const running = await waitRunning(found.location, request.name, report, false);
        return { machine: toMachine(running), created: false, resources };
      }
      if (existing.length > 0) {
        const found = toMachine(existing[0]!);
        throw new ProviderError({
          error: "machine-exists",
          message: `an instance named ${request.name} exists in the project, and sitesolide did not create it`,
          details: [
            `${found.type} at ${found.location}, ${found.status}, ${found.ipv4 ?? "no public address"}`,
            `it lacks the label ${MANAGED_LABEL}=${MANAGED_VALUE}: nothing was created, nothing was changed`,
          ],
        });
      }
      report("   none of that name yet");

      const earlier = await leftoversOf(request.name);
      if (earlier.addresses.length > 0 || earlier.rules.length > 0) {
        const left = [
          ...earlier.addresses.map((address) => `the address ${address.name} (${address.address ?? "no address"}, ${lastSegment(address.region)})`),
          ...earlier.rules.map((rule) => `the firewall rule ${rule.name}`),
        ];
        report(`   an earlier run left ${left.join(", ")}: reused where they fit`);
        const wanted = regionOf(request.location);
        for (const address of earlier.addresses.filter((candidate) => lastSegment(candidate.region) !== wanted)) {
          report(`!! the address ${address.name} in ${lastSegment(address.region)} is not in ${wanted}, where the machine goes: it stays billed until the machine is destroyed`);
        }
      }
      try {
        return await order(request, resources, report);
      } catch (error) {
        // Whatever stopped the run, what an earlier run left is still there,
        // and its address still billed: the refusal says so, and how it goes.
        const lines = leftoverLines(request.name, earlier);
        if (!(error instanceof ProviderError) || lines.length === 0) throw error;
        throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...lines] });
      }
    },

    async list() {
      const machines = (await aggregated<GcpInstance>("instances", "read the instances")).filter((instance) => isManaged(instance.labels)).map(toMachine);
      // The machines whose instance is gone, or never came, while their
      // address or their rules remain: billed, and destroyed like the others.
      const present = new Set(machines.map((machine) => machine.name));
      const left = new Map<string, Leftovers>();
      const entry = (name: string) => left.get(name) ?? left.set(name, { addresses: [], rules: [] }).get(name)!;
      for (const address of await aggregated<GcpAddress>("addresses", "read the addresses")) {
        const name = machineOfAddress(address);
        if (name !== null && !present.has(name)) entry(name).addresses.push(address);
      }
      for (const rule of await listAll<GcpFirewall>(own("/global/firewalls"), "read the firewall rules")) {
        const name = machineOfRule(rule);
        if (name !== null && !present.has(name)) entry(name).rules.push(rule);
      }
      return [...machines, ...[...left.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, leftovers]) => incompleteMachine(name, leftovers))];
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      const removed: string[] = [];
      const kept: string[] = [];
      const incomplete = machine.status === INCOMPLETE;
      if (!NAME_SHAPE.test(machine.name) || (!incomplete && !ZONE_SHAPE.test(machine.location))) {
        throw new ProviderError({ error: "provider-invalid", message: `${machine.name} at ${machine.location} is not an instance sitesolide can name on Google Cloud` });
      }

      report(`-> instance ${machine.name}`);
      // The zone of the instance deleted here; null when there was none.
      let zone: string | null = null;
      if (incomplete) {
        if ((await instancesNamed(machine.name)).some((instance) => isManaged(instance.labels))) {
          throw new ProviderError({
            error: "provider-busy",
            message: `an instance named ${machine.name} appeared since the machine was read`,
            details: ["nothing was deleted: run the same command again, which destroys it whole"],
          });
        }
        report("   none: an earlier run never created it, or a destroy deleted it; what was made for it goes below");
      } else {
        zone = machine.location;
        const path = own(`/zones/${zone}/instances/${machine.name}`);
        const instance = await call<GcpInstance>("GET", path, `read the instance ${machine.name}`);
        // Read again here, never trusted from the caller: only an instance
        // carrying the label is deleted, and only the one that was listed.
        if (!isManaged(instance.labels)) {
          throw new ProviderError({ error: "machine-not-managed", message: `the instance ${machine.name} lacks the label ${MANAGED_LABEL}=${MANAGED_VALUE}: sitesolide did not create it`, details: ["nothing was deleted"] });
        }
        if (String(instance.id) !== machine.id) {
          throw new ProviderError({ error: "provider-not-found", message: `the instance ${machine.name} at ${zone} is not the one that was read: it was replaced in the meantime`, details: ["nothing was deleted"] });
        }
        const disks = instance.disks ?? [];
        const staying = disks.filter((disk) => disk.autoDelete !== true);
        // A disk a person attached goes too when it is set to: said by name.
        const going = disks.filter((disk) => disk.boot !== true && disk.autoDelete === true);
        const ipv4 = toMachine(instance).ipv4;
        const operation = await call<GcpOperation>("DELETE", path, `delete the instance ${machine.name}`);
        await waitFor(operation, `delete the instance ${machine.name}`, report);
        removed.push(`instance ${machine.name}${ipv4 === null ? "" : ` (${ipv4})`}, with its boot disk`);
        for (const disk of going) {
          removed.push(`disk ${diskName(disk)}, attached to ${machine.name} and set to go with it`);
          report(`   disk ${diskName(disk)}: deleted with the instance, as it was set to`);
        }
        for (const disk of staying) {
          kept.push(`disk ${diskName(disk)}: it was not set to go with the instance, and is billed until it is deleted from the console`);
          report(`!! disk ${diskName(disk)} outlived the instance: delete it from the console, or it stays billed`);
        }
      }

      report(`-> static address ${addressNameOf(machine.name)}`);
      // Every region, in case an interrupted run reserved one elsewhere.
      const addresses = (await aggregated<GcpAddress>("addresses", "read the addresses")).filter((address) => ownAddress(address, machine.name));
      if (addresses.length === 0) report("   none reserved by sitesolide for this machine");
      for (const address of addresses) {
        const where = lastSegment(address.region) || "unknown";
        const label = `address ${address.name} (${address.address ?? "no address"}, ${where})`;
        const elsewhere = (address.users ?? []).filter((user) => zone === null || !user.endsWith(`/zones/${zone}/instances/${machine.name}`));
        if (elsewhere.length > 0) {
          kept.push(`${label}: still used by ${elsewhere.map(lastSegment).join(", ")}`);
          report(`   kept: still used by ${elsewhere.map(lastSegment).join(", ")}`);
          continue;
        }
        // Google may still count the deleted instance for a moment.
        for (let attempt = 1; ; attempt++) {
          try {
            const deletion = await call<GcpOperation>("DELETE", own(`/regions/${where}/addresses/${address.name}`), `release the address ${address.name}`);
            await waitFor(deletion, `release the address ${address.name}`, report);
            removed.push(label);
            report("   released");
            break;
          } catch (error) {
            if (!(error instanceof GcpError) || error.failure.error !== "provider-busy") throw error;
            if (attempt >= WAITS.addressTries) {
              kept.push(`${label}: Google still says it is in use; release it from the console, or it stays billed`);
              report("   kept: Google still says it is in use; release it from the console once it is free");
              break;
            }
            await clock.sleep(WAITS.pollMs);
          }
        }
      }

      report("-> firewall rules");
      const rules: GcpFirewall[] = [];
      for (const ruleName of Object.values(ruleNamesOf(machine.name))) {
        const rule = await read<GcpFirewall>(own(`/global/firewalls/${ruleName}`), `read the firewall rule ${ruleName}`);
        if (rule === null) {
          report(`   ${ruleName}: none`);
        } else if (!ownRule(rule, machine.name)) {
          kept.push(`firewall rule ${ruleName}: sitesolide did not create it, it is left as it is`);
          report(`   ${ruleName}: not sitesolide's, left as it is`);
        } else {
          rules.push(rule);
        }
      }
      if (rules.length > 0) {
        // A rule still matters to any other instance that carries the tag:
        // deleting it would open or close ports on it.
        const tag = tagOf(machine.name);
        const carriers = (await aggregated<GcpInstance>("instances", "read the instances")).filter((other) => (other.tags?.items ?? []).includes(tag));
        for (const rule of rules) {
          if (carriers.length > 0) {
            const names = carriers.map((other) => `${other.name} (${lastSegment(other.zone)})`).join(", ");
            kept.push(`firewall rule ${rule.name}: still applies to ${names}, which carries the tag ${tag}`);
            report(`   ${rule.name}: kept, still applies to ${names}`);
            continue;
          }
          const deletion = await call<GcpOperation>("DELETE", own(`/global/firewalls/${rule.name}`), `delete the firewall rule ${rule.name}`);
          await waitFor(deletion, `delete the firewall rule ${rule.name}`, report);
          removed.push(`firewall rule ${rule.name}`);
          report(`   ${rule.name}: deleted`);
        }
      }

      report("-> SSH key");
      report("   it lived in the instance's metadata, and went with it");
      if (options.deleteKey) report("   nothing else to delete: Google Cloud keeps no copy of it");
      return { removed, kept };
    },

    async locations() {
      return zoneChoices(await readZones());
    },

    async types(location) {
      if (!ZONE_SHAPE.test(location)) return [];
      const types = await listAll<GcpMachineType>(own(`/zones/${location}/machineTypes`), "read the machine types");
      return offeredTypes(types).map((type) => ({ value: type.name, label: type.name, hint: typeHint(type) }));
    },
  };
}

/** The credentials, the help to make them, and what `create` orders when nothing else is said. */
export const GCP: ProviderEntry = {
  name: "gcp",
  title: "Google Cloud",
  credentials: [
    { variable: PROJECT_VARIABLE, label: "project ID", secret: false, shape: PROJECT_SHAPE },
    // Either the token, or the service account's email and key: see `alternatives`.
    { variable: TOKEN_VARIABLE, label: "access token", secret: true, shape: TOKEN_SHAPE, optional: true },
    { variable: EMAIL_VARIABLE, label: "service account email", secret: false, shape: EMAIL_SHAPE, optional: true },
    { variable: KEY_VARIABLE, label: "service account private key", secret: true, shape: KEY_SHAPE, optional: true },
  ],
  alternatives: [[TOKEN_VARIABLE], [EMAIL_VARIABLE, KEY_VARIABLE]],
  discover,
  credentialHelp: [
    "the gcloud CLI, signed in with `gcloud auth login`, is found by itself: its token and its project are used",
    "or a service account's JSON key: GOOGLE_APPLICATION_CREDENTIALS names the file, made in the console under IAM & Admin, Service Accounts, the account, Keys",
    "the account needs Compute Instance Admin (v1), Compute Network Admin and Compute Security Admin on the project, or Compute Admin on a project of its own",
    `${PROJECT_VARIABLE} names the project; ${TOKEN_VARIABLE} takes a token \`gcloud auth print-access-token\` printed, valid an hour`,
  ],
  docs: "docs/providers/gcp.md",
  defaults: (environment) => {
    // gcloud's own default zone, when the workstation set one.
    const zone = environment.CLOUDSDK_COMPUTE_ZONE?.trim() ?? "";
    return { type: DEFAULT_TYPE, location: STANDARD_ZONE.test(zone) ? zone : DEFAULT_ZONE, image: DEBIAN };
  },
  nameProblem,
  // No keyProblem: the guest agent writes any OpenSSH public key to authorized_keys.
  backups: false,
  apiVariable: API_VARIABLE,
  open: gcp,
};
