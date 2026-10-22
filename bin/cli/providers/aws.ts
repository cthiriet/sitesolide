/**
 * Amazon EC2, through its Query API, version 2016-11-15: form-encoded POSTs
 * to `https://ec2.<region>.amazonaws.com`, signed with Signature Version 4
 * (aws-sigv4.ts), answered in XML (aws-xml.ts). No SDK and no `aws` binary:
 * the CLI is only asked for credentials, by `discover`, when it holds some.
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/Query-Requests.html
 *
 * A location is a region, `eu-central-1`; a type is an instance type,
 * `t3.small`. A machine is five resources in that region, each tagged
 * `managed-by=sitesolide`, `sitesolide-machine=<name>` and `Name=<name>`:
 *
 *   - the workstation's SSH key, as a key pair: reused when the region
 *     already holds the same key under any name, imported otherwise;
 *   - a security group `sitesolide-<name>` in the default VPC: inbound TCP 22,
 *     80 and 443 and ping from everywhere, IPv4 and IPv6, the rest dropped;
 *   - an elastic IP: the address an instance gets by default changes at
 *     every stop and start, and DNS records point at it;
 *   - the instance, Debian 13 from Debian's own account, IMDSv2 only, a
 *     20 GB encrypted gp3 root volume deleted with it, and no user data:
 *     `sitesolide setup` hardens it over SSH, as `admin`, the account
 *     Debian's images let in with the key.
 *
 * EC2 names nothing uniquely: an instance's name is its `Name` tag. sitesolide
 * keeps one machine per name across every region the account has enabled, so
 * that `find` and `destroy` are never ambiguous: `create` looks in all of them
 * first, and an instance of that name it did not create, anywhere, stops it.
 * What a run left without an instance, an elastic IP billed by the hour above
 * all, makes an `incomplete` machine, which `list` shows, `find` returns and
 * `destroy` removes, in every region where it is; `create` reuses it.
 *
 * Everything that can refuse is read before the first write: the name, the
 * region, the type and the zones that sell it, the image, the default VPC and
 * its subnets, the security group's name. When AWS refuses the order itself,
 * capacity or a zone's constraint, what this run created for it is deleted
 * again. When the order's outcome is unknown, a timeout or a failure on AWS's
 * side, nothing is undone: the order carries a client token derived from the
 * elastic IP it was made with, which the next run reuses, so that running the
 * command again returns the same instance rather than a second one.
 *
 * Every call carries the access key ID in its Authorization header and the
 * secret only as an HMAC there, follows no redirect, and fails with a
 * ProviderError whose code bin/cli/hints.ts knows. The API's own errors are
 * `<Response><Errors><Error><Code>` and `<Message>`; `failureFrom` reads them.
 * https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html
 *
 * Lists are paginated: `nextToken` is followed until it is absent, even past
 * an empty page, which the API may send. The API is eventually consistent: a
 * resource just created may be unknown to the next call for a moment, which
 * the waits tolerate up to their deadline.
 */
import { signRequest, uriEncode, type AwsCredentials } from "./aws-sigv4";
import { at, items, parseXml, tagsOf, textAt, XmlError, type XmlElement } from "./aws-xml";
import {
  apiAddress,
  DEBIAN,
  isManaged,
  labelsFor,
  MACHINE_LABEL,
  MANAGED_LABEL,
  MANAGED_VALUE,
  ProviderError,
  retryAfter,
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
  type PublicKey,
  type Report,
  type Resource,
  type Workstation,
} from "./provider";
import type { Failure } from "../remote";

export const API_VERSION = "2016-11-15";

/** The API's address for every region, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_AWS_API";

/** The variables the aws CLI and every SDK read. */
export const ACCESS_KEY_VARIABLE = "AWS_ACCESS_KEY_ID";
export const SECRET_KEY_VARIABLE = "AWS_SECRET_ACCESS_KEY";
export const SESSION_TOKEN_VARIABLE = "AWS_SESSION_TOKEN";

/** Debian's account, which publishes the official images: https://wiki.debian.org/Cloud/AmazonEC2Image/Trixie */
export const DEBIAN_OWNER = "136693071363";

/** The account Debian's images let in with the key, with sudo and no password; root logs in with nothing. */
export const LOGIN = "admin";

/** The root volume: Debian's images come with 8 GB, too little for builds and backups. */
export const ROOT_VOLUME_GB = 20;

/**
 * Frankfurt and t3.small unless said otherwise: a current generation x86 type
 * with 2 GB of memory, in AWS's oldest region of continental Europe, which
 * sells every type the wizard offers. t3a.small costs a little less, but an
 * account on AWS's Free plan, any account created since 15 July 2025 until it
 * is upgraded, refuses every type that is not Free Tier eligible, and
 * t3.small is: the default works on both plans.
 * https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html
 * AWS_REGION, or AWS_DEFAULT_REGION, as the aws CLI reads them, moves the
 * default region.
 */
export const DEFAULT_REGION = "eu-central-1";
export const DEFAULT_TYPE = "t3.small";

export function awsDefaults(environment: Record<string, string | undefined>): { type: string; location: string; image: string } {
  const region = environment.AWS_REGION?.trim() || environment.AWS_DEFAULT_REGION?.trim() || DEFAULT_REGION;
  return { type: DEFAULT_TYPE, location: region, image: DEBIAN };
}

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  runningMs: 5 * 60_000,
  terminatedMs: 10 * 60_000,
  /** A resource just created that the next call does not know yet. */
  settleMs: 2 * 60_000,
  /** A security group still held by the network interface of an instance just terminated. */
  groupMs: 3 * 60_000,
  /** An order that meets a key pair or a group just created, not known everywhere yet. */
  orderMs: 60_000,
  pollMs: 5_000,
};

/**
 * The types the wizard offers: current generations with at least 2 GB of
 * memory. Those a Free plan account may order come first, since such an
 * account refuses the others; then the rest, roughly cheapest first by AWS's
 * on-demand prices, which the EC2 API does not give. Only those sold in the
 * region are shown.
 */
export const CURATED_TYPES = [
  // Free Tier eligible on the Free plan.
  "t3.small",
  "t4g.small",
  "c7i-flex.large",
  "m7i-flex.large",
  // The others.
  "t3a.small",
  "t3a.medium",
  "t4g.medium",
  "t3.medium",
  "t3a.large",
  "t4g.large",
  "t3.large",
  "m7i.large",
];

/** Where each region is, for the wizard; a region missing here is named as the API names its country. */
export const REGIONS: Readonly<Record<string, readonly [string, string]>> = {
  "eu-central-1": ["Frankfurt", "DE"],
  "eu-central-2": ["Zurich", "CH"],
  "eu-west-1": ["Dublin", "IE"],
  "eu-west-2": ["London", "GB"],
  "eu-west-3": ["Paris", "FR"],
  "eu-north-1": ["Stockholm", "SE"],
  "eu-south-1": ["Milan", "IT"],
  "eu-south-2": ["Aragon", "ES"],
  "us-east-1": ["N. Virginia", "US"],
  "us-east-2": ["Ohio", "US"],
  "us-west-1": ["N. California", "US"],
  "us-west-2": ["Oregon", "US"],
  "ca-central-1": ["Montreal", "CA"],
  "ca-west-1": ["Calgary", "CA"],
  "mx-central-1": ["Queretaro", "MX"],
  "sa-east-1": ["Sao Paulo", "BR"],
  "af-south-1": ["Cape Town", "ZA"],
  "il-central-1": ["Tel Aviv", "IL"],
  "me-south-1": ["Bahrain", "BH"],
  "me-central-1": ["UAE", "AE"],
  "ap-south-1": ["Mumbai", "IN"],
  "ap-south-2": ["Hyderabad", "IN"],
  "ap-east-1": ["Hong Kong", "HK"],
  "ap-east-2": ["Taipei", "TW"],
  "ap-northeast-1": ["Tokyo", "JP"],
  "ap-northeast-2": ["Seoul", "KR"],
  "ap-northeast-3": ["Osaka", "JP"],
  "ap-southeast-1": ["Singapore", "SG"],
  "ap-southeast-2": ["Sydney", "AU"],
  "ap-southeast-3": ["Jakarta", "ID"],
  "ap-southeast-4": ["Melbourne", "AU"],
  "ap-southeast-5": ["Malaysia", "MY"],
  "ap-southeast-6": ["New Zealand", "NZ"],
  "ap-southeast-7": ["Thailand", "TH"],
};

/** A region's name as AWS writes it, and nothing a hostname could be made to say. */
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$/;

/** An instance type as AWS names them: `t3.small`, `m7i-flex.large`. */
const TYPE_SHAPE = /^[a-z][a-z0-9-]{0,30}\.[a-z0-9-]{1,30}$/;

/** What `--image` takes here: `debian-13`, or an AMI's ID. */
const AMI_SHAPE = /^ami-[0-9a-f]{8,17}$/;
const IMAGE_SHAPE = /^(debian-[0-9]{1,3}|ami-[0-9a-f]{8,17})$/;

/**
 * A value a person gave, said back only when it has the shape it should:
 * anything else may be a secret pasted in the wrong place, which the scrubber
 * of printed lines would miss once cut.
 */
export function shown(value: string, shape: RegExp): string {
  return shape.test(value) ? value : "(not shown)";
}

/** One inbound rule: a protocol, a port or an ICMP type (-1 for all), a source. */
export type Rule = { protocol: "tcp" | "icmp" | "icmpv6"; from: number; to: number; cidr: string; description: string };

/**
 * Every rule allows these sources, as infra/main.tf did. IPv6 too: the
 * default VPC has no IPv6 range unless its owner gave it one, and then the
 * instance gets an address that must answer like the IPv4 one.
 */
export const FIREWALL_RULES: readonly Rule[] = [
  ...(["22", "80", "443"] as const).flatMap((port) =>
    ["0.0.0.0/0", "::/0"].map((cidr) => ({ protocol: "tcp" as const, from: Number(port), to: Number(port), cidr, description: { "22": "ssh", "80": "http", "443": "https" }[port] })),
  ),
  // Ping serves diagnosis and external monitoring.
  { protocol: "icmp", from: -1, to: -1, cidr: "0.0.0.0/0", description: "ping" },
  { protocol: "icmpv6", from: -1, to: -1, cidr: "::/0", description: "ping" },
];

/** The states of an instance that has not gone: terminated ones stay listed for about an hour. */
const LIVE_STATES = ["pending", "running", "shutting-down", "stopping", "stopped"];

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and its own code kept for the callers that tell them apart. */
export class AwsError extends ProviderError {
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

const UNAUTHENTICATED = new Set(["AuthFailure", "InvalidClientTokenId", "SignatureDoesNotMatch", "IncompleteSignature", "MissingAuthenticationToken", "UnrecognizedClientException", "ExpiredToken"]);
const FORBIDDEN = new Set(["UnauthorizedOperation", "OptInRequired", "PendingVerification", "Blocked"]);
const THROTTLED = new Set(["RequestLimitExceeded", "Throttling", "ThrottlingException"]);
const LIMITS = new Set([
  "AddressLimitExceeded",
  "InstanceLimitExceeded",
  "VcpuLimitExceeded",
  "SecurityGroupLimitExceeded",
  "KeyPairLimitExceeded",
  "RulesPerSecurityGroupLimitExceeded",
  "ResourceLimitExceeded",
  "VolumeLimitExceeded",
]);
/** What AWS cannot sell there right now, rather than what the request got wrong. */
export const CAPACITY = new Set(["InsufficientInstanceCapacity", "InsufficientAddressCapacity", "InsufficientCapacity", "InsufficientVolumeCapacity", "Unsupported"]);
const DUPLICATES = new Set(["InvalidKeyPair.Duplicate", "InvalidGroup.Duplicate"]);
const BUSY = new Set(["DependencyViolation", "IncorrectInstanceState", "IncorrectState", "InvalidGroup.InUse", "Resource.AlreadyAssociated", "InvalidIPAddress.InUse"]);
const LATER = new Set(["InternalError", "InternalFailure", "ServiceUnavailable", "Unavailable", "ServerInternal"]);

/**
 * An authorization message carries an encoded blob longer than anyone reads:
 * the start says it. Cut between two words, never inside one, so that nothing
 * token-like is printed in half, where the scrubber would not recognise it.
 */
export function short(said: string): string {
  if (said.length <= 400) return said;
  const cut = said.slice(0, 401).search(/\s\S*$/);
  return cut > 0 ? `${said.slice(0, cut).trimEnd()} ...` : "(a message too long to show)";
}

/**
 * An error answer of the API as a failure the CLI reports, with the code its
 * hint is found by. `what` says what was being done, in the infinitive, for
 * the message: `create the security group sitesolide-web`.
 */
export function failureFrom(status: number, code: string, said: string, headers: Headers, what: string): AwsError {
  const answer = `${status}${code === "" ? "" : ` ${code}`}`;
  const text = short(said || `answered ${status}`);
  const make = (failure: Failure) => new AwsError(failure, status, code, said);

  if (code === "RequestExpired") {
    return make({
      error: "provider-unauthenticated",
      message: `AWS refused the request as expired (${answer}): ${text}`,
      details: [
        "AWS refuses a request dated more than 15 minutes away from its own clock, and one signed with temporary credentials that have expired",
        "check this workstation's clock, or sign in again (aws sso login, or new session credentials), then run the same command",
      ],
    });
  }
  if (UNAUTHENTICATED.has(code) || (status === 401 && !FORBIDDEN.has(code))) {
    return make({
      error: "provider-unauthenticated",
      message: `AWS refused the credentials (${answer}): ${text}`,
      details: [
        "the access key ID and the secret access key go together, and temporary ones with their session token, AWS_SESSION_TOKEN",
        "a key that was deactivated or deleted in IAM, or session credentials that expired, are refused alike",
      ],
    });
  }
  if (FORBIDDEN.has(code)) {
    return make({
      error: "provider-forbidden",
      message: `the credentials may not ${what} (${answer}): ${text}`,
      details: ["the IAM user or role lacks a permission this command needs, or the account may not use EC2 there yet: docs/providers/aws.md lists the permissions"],
    });
  }
  if (THROTTLED.has(code) || status === 429) {
    return make({
      error: "provider-rate-limited",
      message: `AWS's request rate limit is reached, nothing more can be asked of it for now (${answer})`,
      details: ["EC2 refills its request buckets every second: a short wait is enough"],
      wait: retryAfter(headers, 10),
    });
  }
  if (LIMITS.has(code)) {
    return make({ error: "provider-limit", message: `AWS refused to ${what} (${answer}): ${text}`, details: ["the account reached one of its quotas in this region, listed in the console under Service Quotas, Amazon EC2"] });
  }
  if (CAPACITY.has(code)) return make({ error: "provider-unavailable", message: `AWS could not ${what} (${answer}): ${text}` });
  if (DUPLICATES.has(code)) return make({ error: "provider-name-taken", message: `AWS refused to ${what} (${answer}): ${text}` });
  if (BUSY.has(code)) return make({ error: "provider-busy", message: `AWS could not ${what} right now (${answer}): ${text}` });
  if (code.endsWith(".NotFound")) return make({ error: "provider-not-found", message: `AWS could not ${what} (${answer}): ${text}` });
  if (LATER.has(code) || status >= 500) return make({ error: "provider-failure", message: `AWS failed to ${what} (${answer}): ${text}`, details: ["the failure is on AWS's side"] });
  return make({ error: "provider-invalid", message: `AWS refused to ${what} (${answer}): ${text}` });
}

/** `Filter.1.Name=tag:Name&Filter.1.Value.1=web`, from pairs. */
export function filters(pairs: readonly (readonly [string, readonly string[]])[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  pairs.forEach(([name, values], index) => {
    parameters[`Filter.${index + 1}.Name`] = name;
    values.forEach((value, valueIndex) => (parameters[`Filter.${index + 1}.Value.${valueIndex + 1}`] = value));
  });
  return parameters;
}

/** `InstanceId.1=i-...`, from a list. */
export function numbered(name: string, values: readonly string[]): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${name}.${index + 1}`, value]));
}

/** The three tags of everything sitesolide creates for a machine: its two labels, and Name, which the console shows. */
export function tagsFor(name: string): Record<string, string> {
  return { Name: name, ...labelsFor(name) };
}

/** `TagSpecification.<n>.ResourceType` and its tags. */
export function tagSpecification(index: number, resourceType: string, tags: Record<string, string>): Record<string, string> {
  const parameters: Record<string, string> = { [`TagSpecification.${index}.ResourceType`]: resourceType };
  Object.entries(tags).forEach(([key, value], tagIndex) => {
    parameters[`TagSpecification.${index}.Tag.${tagIndex + 1}.Key`] = key;
    parameters[`TagSpecification.${index}.Tag.${tagIndex + 1}.Value`] = value;
  });
  return parameters;
}

// --- what the answers mean -------------------------------------------------------------------

function ipv6Of(instance: XmlElement): string | null {
  const direct = textAt(instance, "ipv6Address");
  if (direct !== null) return direct;
  for (const networkInterface of items(instance, "networkInterfaceSet")) {
    for (const address of items(networkInterface, "ipv6AddressesSet")) {
      const value = textAt(address, "ipv6Address");
      if (value !== null) return value;
    }
  }
  return null;
}

export function toMachine(instance: XmlElement, region: string): Machine {
  const tags = tagsOf(instance);
  const id = textAt(instance, "instanceId") ?? "";
  return {
    provider: "aws",
    id,
    name: tags.Name ?? id,
    type: textAt(instance, "instanceType") ?? "unknown",
    location: region,
    status: textAt(instance, "instanceState", "name") ?? "unknown",
    ipv4: textAt(instance, "ipAddress"),
    ipv6: ipv6Of(instance),
    // An instance holds one address of its subnet's /64, not a network of its own.
    ipv6Network: null,
    // The EC2 API gives no price.
    monthlyPrice: null,
    backups: false,
    managed: isManaged(tags),
    labels: tags,
    login: LOGIN,
  };
}

function sha256(data: string | Uint8Array, encoding: "hex" | "base64"): string {
  return new Bun.CryptoHasher("sha256").update(data).digest(encoding);
}

/**
 * Whether a key pair of the region is the workstation's key. Its public key,
 * which DescribeKeyPairs returns with IncludePublicKey, says it; failing that,
 * its fingerprint, which AWS computes as MD5 for an imported RSA key and as
 * the base64 SHA-256 OpenSSH prints for an ED25519 one.
 */
export function sameKey(pair: XmlElement, key: PublicKey): boolean {
  const material = textAt(pair, "publicKey");
  if (material !== null) return material.split(/\s+/).slice(0, 2).join(" ") === `${key.algorithm} ${key.blob}`;
  const fingerprint = textAt(pair, "keyFingerprint");
  if (fingerprint === null) return false;
  const digest = sha256(Buffer.from(key.blob, "base64"), "base64");
  const bare = digest.replace(/=+$/, "");
  return [key.fingerprint, digest, bare, `SHA256:${bare}`].includes(fingerprint);
}

/** `6` and `tcp` are one protocol to EC2, which may answer with either. */
function protocolName(value: string | null): string {
  return { "6": "tcp", "1": "icmp", "58": "icmpv6" }[value ?? ""] ?? value ?? "";
}

/** The rules of FIREWALL_RULES a security group lacks, from its `ipPermissions`. */
export function missingRules(group: XmlElement): Rule[] {
  const present = new Set<string>();
  for (const permission of items(group, "ipPermissions")) {
    const protocol = protocolName(textAt(permission, "ipProtocol"));
    const from = Number(textAt(permission, "fromPort") ?? "-1");
    const to = Number(textAt(permission, "toPort") ?? "-1");
    for (const range of items(permission, "ipRanges")) present.add(`${protocol} ${from} ${to} ${textAt(range, "cidrIp")}`);
    for (const range of items(permission, "ipv6Ranges")) present.add(`${protocol} ${from} ${to} ${textAt(range, "cidrIpv6")}`);
  }
  return FIREWALL_RULES.filter((rule) => !present.has(`${rule.protocol} ${rule.from} ${rule.to} ${rule.cidr}`));
}

/** AuthorizeSecurityGroupIngress's parameters for these rules, one permission each. */
export function permissions(rules: readonly Rule[]): Record<string, string> {
  const parameters: Record<string, string> = {};
  rules.forEach((rule, index) => {
    const prefix = `IpPermissions.${index + 1}`;
    parameters[`${prefix}.IpProtocol`] = rule.protocol;
    parameters[`${prefix}.FromPort`] = String(rule.from);
    parameters[`${prefix}.ToPort`] = String(rule.to);
    const v6 = rule.cidr.includes(":");
    parameters[`${prefix}.${v6 ? "Ipv6Ranges.1.CidrIpv6" : "IpRanges.1.CidrIp"}`] = rule.cidr;
    parameters[`${prefix}.${v6 ? "Ipv6Ranges" : "IpRanges"}.1.Description`] = rule.description;
  });
  return parameters;
}

/** EC2's architectures, as Debian names its images. */
const DEBIAN_ARCHITECTURE: Record<string, string> = { x86_64: "amd64", arm64: "arm64" };

type TypeInfo = { name: string; vcpus: number; memoryMiB: number; architecture: string | null; burstable: boolean; freeTier: boolean };

function typeInfo(item: XmlElement): TypeInfo {
  const architectures = items(item, "processorInfo", "supportedArchitectures").map((entry) => entry.text.trim());
  return {
    name: textAt(item, "instanceType") ?? "",
    vcpus: Number(textAt(item, "vCpuInfo", "defaultVCpus") ?? "0"),
    memoryMiB: Number(textAt(item, "memoryInfo", "sizeInMiB") ?? "0"),
    architecture: architectures.find((entry) => entry === "x86_64") ?? architectures.find((entry) => entry === "arm64") ?? null,
    burstable: textAt(item, "burstablePerformanceSupported") === "true",
    freeTier: textAt(item, "freeTierEligible") === "true",
  };
}

/** What the wizard says beside a type. */
function typeHint(info: TypeInfo): string | null {
  const said = [info.burstable ? "burstable CPU" : null, info.freeTier ? "Free Tier eligible" : null].filter((part): part is string => part !== null);
  return said.length === 0 ? null : said.join(", ");
}

/** Why AWS would refuse the workstation's key: it imports ed25519 and RSA keys only. */
export function awsKeyProblem(key: PublicKey): string | null {
  if (key.algorithm === "ssh-ed25519" || key.algorithm === "ssh-rsa") return null;
  return `AWS imports ed25519 and RSA keys only, and this one is ${shown(key.algorithm, /^[a-z0-9@.-]{1,64}$/)}`;
}

/** The refusal of an account on AWS's Free plan, for a type that is not Free Tier eligible. */
export function refusesFreePlan(error: AwsError): boolean {
  return error.code === "InvalidParameterCombination" && /free tier/i.test(error.said);
}

/** `2 vCPU, 2 GB RAM, 20 GB disk, arm64`: a type said for a person. */
export function describeType(info: TypeInfo): string {
  const memory = info.memoryMiB / 1024;
  const shown = Number.isInteger(memory) ? String(memory) : memory.toFixed(1);
  return `${info.vcpus} vCPU, ${shown} GB RAM, ${ROOT_VOLUME_GB} GB disk${info.architecture === "arm64" ? ", arm64" : ""}`;
}

/** Where a region is, for a person: `Frankfurt, DE`. */
export function regionLabel(region: string, geography: string | null): string {
  const known = REGIONS[region];
  return known === undefined ? (geography ?? region) : `${known[0]}, ${known[1]}`;
}

/** The workstation's key as AWS takes it: OpenSSH's line without its comment, which may name a person or a host. */
function keyLine(key: PublicKey): string {
  return `${key.algorithm} ${key.blob}`;
}

// --- the provider ---------------------------------------------------------------------------

export function aws(context: ProviderContext): Provider {
  const { clock, fetcher, environment } = context;
  const credentials: AwsCredentials = {
    accessKeyId: context.credentials[ACCESS_KEY_VARIABLE] ?? "",
    secretAccessKey: context.credentials[SECRET_KEY_VARIABLE] ?? "",
    sessionToken: context.credentials[SESSION_TOKEN_VARIABLE] || undefined,
  };
  const home = awsDefaults(environment).location;
  // Checked once, before any call: a wrong override fails here, not mid-run.
  apiAddress(environment, API_VARIABLE, `https://ec2.${DEFAULT_REGION}.amazonaws.com`);

  function checkRegion(region: string): string {
    if (!REGION_SHAPE.test(region)) {
      throw new ProviderError({
        error: "invalid-location",
        message: "the location given is not written like an AWS region",
        details: [
          "a region is written like eu-central-1 or eu-west-3; AWS_REGION, or AWS_DEFAULT_REGION, gives the default one",
          "the value is not shown, in case it is something else pasted there",
        ],
      });
    }
    return region;
  }

  /** One call: signed, form-encoded, XML back, every failure said in the CLI's words. */
  async function call(region: string, action: string, parameters: Record<string, string>, what: string): Promise<XmlElement> {
    const base = apiAddress(environment, API_VARIABLE, `https://ec2.${checkRegion(region)}.amazonaws.com`);
    const url = `${base}/`;
    const host = new URL(base).host;
    // Percent-encoded as the AWS SDKs encode a Query body, a space as %20 rather than +.
    const body = Object.entries({ Action: action, Version: API_VERSION, ...parameters })
      .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
      .join("&");
    const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" };
    const signed = signRequest({ method: "POST", url, headers, body, region, service: "ec2", credentials, now: clock.now() });
    let response: Response;
    try {
      response = await fetcher(url, { method: "POST", redirect: "error", headers: { ...headers, ...signed }, body, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by bin/cli/machine.ts.
      throw new AwsError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, "");
    }
    const text = await response.text().catch(() => "");
    let root: XmlElement | null = null;
    try {
      root = parseXml(text);
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
    }
    if (!response.ok) {
      // EC2 answers `<Response><Errors><Error>`; the other Query APIs, and
      // AWS's front door, `<ErrorResponse><Error>`.
      const error = root === null ? undefined : (at(root, "Errors", "Error") ?? at(root, "Error"));
      const code = textAt(error, "Code") ?? "";
      if (code === "" && response.status < 500 && response.status !== 429) {
        throw new AwsError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not EC2's API, while trying to ${what}` }, response.status, "");
      }
      // A proxy in front of the API may answer a 503 in HTML: still AWS saying "later".
      throw failureFrom(response.status, code, textAt(error, "Message") ?? "", response.headers, what);
    }
    if (root === null || root.name !== `${action}Response`) {
      throw new AwsError({ error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not EC2's answer to ${action}, while trying to ${what}` }, response.status, "");
    }
    return root;
  }

  /** Every page of a list, following `nextToken`, an empty page included. */
  async function describe(region: string, action: string, parameters: Record<string, string>, set: string, what: string, maxResults?: number): Promise<XmlElement[]> {
    const found: XmlElement[] = [];
    const seen = new Set<string>();
    let token: string | null = null;
    for (let pages = 0; pages < 500; pages++) {
      const page: Record<string, string> = { ...parameters, ...(maxResults === undefined ? {} : { MaxResults: String(maxResults) }), ...(token === null ? {} : { NextToken: token }) };
      const answer = await call(region, action, page, what);
      found.push(...items(answer, set));
      const next = textAt(answer, "nextToken");
      if (next === null) return found;
      if (seen.has(next)) throw new AwsError({ error: "provider-unreadable", message: `AWS answered the same page twice while trying to ${what}` }, 200, "");
      seen.add(next);
      token = next;
    }
    return found;
  }

  /** The instances a DescribeInstances names, out of their reservations. */
  async function instances(region: string, parameters: Record<string, string>, what: string): Promise<XmlElement[]> {
    // MaxResults may not go with a list of IDs.
    const byId = Object.keys(parameters).some((name) => name.startsWith("InstanceId."));
    const reservations = await describe(region, "DescribeInstances", parameters, "reservationSet", what, byId ? undefined : 1000);
    return reservations.flatMap((reservation) => items(reservation, "instancesSet"));
  }

  async function readInstance(region: string, id: string, what: string): Promise<XmlElement | null> {
    try {
      return (await instances(region, numbered("InstanceId", [id]), what))[0] ?? null;
    } catch (error) {
      if (error instanceof AwsError && error.code === "InvalidInstanceID.NotFound") return null;
      throw error;
    }
  }

  /**
   * The regions the account has enabled, each with the country the API
   * names. Asked of the home region, AWS_REGION's or Frankfurt, whose
   * endpoint answers for an account that has it: a region not enabled may
   * refuse the credentials outright, and a name AWS does not have resolves
   * nowhere. When an organisation forbids the home region, `also` is asked.
   */
  async function enabledRegions(also: string = home): Promise<{ name: string; geography: string | null }[]> {
    let answer: XmlElement | null = null;
    let refusal: unknown = null;
    for (const from of [...new Set([checkRegion(home), checkRegion(also)])]) {
      try {
        answer = await call(from, "DescribeRegions", {}, "read the regions");
        break;
      } catch (error) {
        const refused = error instanceof ProviderError && (error.failure.error === "provider-forbidden" || error.failure.error === "provider-unauthenticated");
        if (!refused) throw error;
        refusal ??= error;
      }
    }
    if (answer === null) throw refusal;
    return items(answer, "regionInfo")
      .filter((region) => textAt(region, "optInStatus") !== "not-opted-in")
      .map((region) => ({ name: textAt(region, "regionName") ?? "", geography: textAt(region, "geographySet", "item", "name") }))
      .filter((region) => region.name !== "");
  }

  /**
   * Something asked of every enabled region at once. A region other than
   * `from` that refuses the credentials is skipped and named: an organisation
   * may forbid regions it does not use, which says nothing of the others.
   */
  async function everyRegion<T>(from: string, ask: (region: string) => Promise<T[]>, known?: { name: string }[]): Promise<{ found: T[]; skipped: string[] }> {
    const regions = known ?? (await enabledRegions(from));
    const skipped: string[] = [];
    const answers = await Promise.all(
      regions.map(async ({ name }) => {
        try {
          return await ask(name);
        } catch (error) {
          const refused = error instanceof ProviderError && (error.failure.error === "provider-forbidden" || error.failure.error === "provider-unauthenticated");
          if (!refused || name === from) throw error;
          skipped.push(name);
          return [];
        }
      }),
    );
    return { found: answers.flat(), skipped: skipped.sort() };
  }

  type Located = { instance: XmlElement; region: string };

  /** The instances of that name that have not gone, in every region. */
  async function named(name: string, from: string, known?: { name: string }[]): Promise<{ found: Located[]; skipped: string[] }> {
    return everyRegion(
      from,
      async (region) => (await instances(region, filters([["tag:Name", [name]], ["instance-state-name", LIVE_STATES]]), "read the instances")).map((instance) => ({ instance, region })),
      known,
    );
  }

  function ambiguous(name: string, found: Located[]): ProviderError {
    return new ProviderError({
      error: "machine-ambiguous",
      message: `${found.length} instances created by sitesolide are named ${name}`,
      details: [...found.map(({ instance, region }) => `${textAt(instance, "instanceId")} at ${region}, ${textAt(instance, "instanceState", "name")}`), "sitesolide keeps one machine per name: it cannot tell which one is meant"],
    });
  }

  /**
   * A call that may meet a resource the API does not know yet, or a failure
   * that says "later": tried again until the deadline, then its failure stands.
   */
  async function settling<T>(attempt: () => Promise<T>, codes: ReadonlySet<string>, deadline: number, report: Report): Promise<T> {
    let warned = false;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        const again = error instanceof AwsError && (codes.has(error.code) || TRANSIENT.has(error.failure.error));
        if (!again || clock.now() >= deadline) throw error;
        if (!warned) report(`   ${(error as AwsError).code === "" ? error.failure.message : `AWS answered ${(error as AwsError).code}`}: trying again`);
        warned = true;
        await clock.sleep(WAITS.pollMs);
      }
    }
  }

  async function waitRunning(region: string, id: string, name: string, report: Report, justCreated: boolean): Promise<XmlElement> {
    const deadline = clock.now() + WAITS.runningMs;
    let last = "";
    for (;;) {
      const instance = await settling(
        async () => {
          const read = await readInstance(region, id, `read the instance ${name}`);
          // Just ordered, the instance may not be known to every call yet.
          if (read === null && justCreated) throw new AwsError({ error: "provider-not-found", message: `${id} not visible yet` }, 400, "InvalidInstanceID.NotFound");
          return read;
        },
        new Set(["InvalidInstanceID.NotFound"]),
        deadline,
        report,
      );
      if (instance === null) throw new ProviderError({ error: "provider-not-found", message: `the instance ${name} (${id}) is gone`, details: ["run `sitesolide machine list --provider aws`, then the same command again"] });
      const state = textAt(instance, "instanceState", "name") ?? "unknown";
      if (state !== last) report(`   state: ${state}`);
      last = state;
      if (state === "running") return instance;
      if ((state === "stopped" || state === "stopping") && !justCreated) {
        throw new ProviderError({ error: "machine-off", message: `${name} exists but is ${state}`, details: ["sitesolide never starts or stops a machine by itself"] });
      }
      if (state === "terminated" || state === "shutting-down") {
        throw new ProviderError({
          error: "action-failed",
          message: `AWS is terminating the instance ${name}: ${textAt(instance, "stateReason", "message") ?? "no reason given"}`,
          details: [`instance ${id} at ${region}`, "run `sitesolide machine destroy` to remove what was created for it, then create it again"],
        });
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last state: ${state}`, `instance ${id} at ${region}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  /** The types of CURATED_TYPES sold in a region, in that order, with their size. */
  async function soldTypes(region: string): Promise<TypeInfo[]> {
    const offered = await describe(
      region,
      "DescribeInstanceTypeOfferings",
      { LocationType: "region", ...filters([["instance-type", CURATED_TYPES]]) },
      "instanceTypeOfferingSet",
      "read the types sold in the region",
      1000,
    );
    const names = new Set(offered.map((offering) => textAt(offering, "instanceType")));
    const sold = CURATED_TYPES.filter((name) => names.has(name));
    if (sold.length === 0) return [];
    const infos = (await describe(region, "DescribeInstanceTypes", numbered("InstanceType", sold), "instanceTypeSet", "read the instance types")).map(typeInfo);
    return sold.flatMap((name) => infos.filter((info) => info.name === name));
  }

  async function suggestedTypes(region: string, except: string): Promise<string[]> {
    const sold = (await soldTypes(region).catch(() => [])).filter((info) => info.name !== except).slice(0, 6);
    if (sold.length === 0) return [`no type sitesolide suggests is sold at ${region}`];
    return [`types sold at ${region}, roughly cheapest first:`, ...sold.map((info) => `${info.name.padEnd(15)} ${describeType(info)}`)];
  }

  /** The types an account on the Free plan may order in a region, for its refusal. */
  async function freeTierTypes(region: string): Promise<string[]> {
    const eligible = (
      await describe(region, "DescribeInstanceTypes", filters([["free-tier-eligible", ["true"]]]), "instanceTypeSet", "read the Free Tier types", 100).catch(() => [])
    )
      .map(typeInfo)
      .filter((info) => info.architecture !== null)
      .sort((a, b) => a.memoryMiB - b.memoryMiB || a.vcpus - b.vcpus || a.name.localeCompare(b.name));
    if (eligible.length === 0) return [`AWS names no Free Tier eligible type at ${region}`];
    return [`the types the Free plan takes at ${region}:`, ...eligible.map((info) => `${info.name.padEnd(15)} ${describeType(info)}`)];
  }

  type Offer = { info: TypeInfo; zones: string[] };

  /** Refuses a type the region does not sell; returns its size and the zones that sell it. */
  async function checkOffer(region: string, request: CreateRequest, report: Report): Promise<Offer> {
    if (!TYPE_SHAPE.test(request.type)) {
      throw new ProviderError({
        error: "invalid-server-type",
        message: "the type given is not written like an EC2 instance type",
        details: [...(await suggestedTypes(region, request.type)), "the value is not shown, in case it is something else pasted there"],
      });
    }
    report(`-> ${request.type} at ${region}, what AWS sells there`);
    let found: XmlElement[] = [];
    try {
      found = await describe(region, "DescribeInstanceTypes", numbered("InstanceType", [request.type]), "instanceTypeSet", `read the instance type ${request.type}`);
    } catch (error) {
      if (!(error instanceof AwsError) || (error.code !== "InvalidInstanceType" && error.code !== "InvalidParameterValue")) throw error;
    }
    const info = found.map(typeInfo).find((candidate) => candidate.name === request.type);
    if (info === undefined) {
      throw new ProviderError({ error: "invalid-server-type", message: `${request.type} is not an instance type AWS sells at ${region}`, details: await suggestedTypes(region, request.type) });
    }
    if (info.architecture === null) {
      throw new ProviderError({ error: "invalid-server-type", message: `${request.type} is neither x86_64 nor arm64, the architectures Debian publishes`, details: await suggestedTypes(region, request.type) });
    }
    const offerings = await describe(
      region,
      "DescribeInstanceTypeOfferings",
      { LocationType: "availability-zone", ...filters([["instance-type", [request.type]]]) },
      "instanceTypeOfferingSet",
      `read the zones that sell ${request.type}`,
      1000,
    );
    const zones = offerings.map((offering) => textAt(offering, "location") ?? "").filter((zone) => zone !== "").sort();
    if (zones.length === 0) {
      throw new ProviderError({ error: "invalid-server-type", message: `${request.type} is not sold at ${region}`, details: await suggestedTypes(region, request.type) });
    }
    report(`   ${describeType(info)}${info.burstable ? ", burstable CPU" : ""}, sold in ${zones.join(", ")}`);
    return { info, zones };
  }

  type Image = { id: string; name: string; rootDevice: string };

  /** `debian-13` as the newest Debian 13 image of Debian's account for that architecture, or an AMI given by its ID. */
  async function resolveImage(region: string, image: string, architecture: string, report: Report): Promise<Image> {
    report(`-> image ${shown(image, IMAGE_SHAPE)}`);
    const debian = DEBIAN_ARCHITECTURE[architecture] ?? architecture;
    let found: XmlElement[];
    if (image === DEBIAN) {
      found = await describe(
        region,
        "DescribeImages",
        { ...numbered("Owner", [DEBIAN_OWNER]), ...filters([["name", [`debian-13-${debian}-*`]], ["architecture", [architecture]], ["state", ["available"]], ["image-type", ["machine"]]]) },
        "imagesSet",
        "read Debian's images",
        1000,
      );
      found = found.filter((candidate) => textAt(candidate, "ownerId") === DEBIAN_OWNER || textAt(candidate, "imageOwnerId") === DEBIAN_OWNER);
    } else if (AMI_SHAPE.test(image)) {
      try {
        found = await describe(region, "DescribeImages", numbered("ImageId", [image]), "imagesSet", `read the image ${image}`);
      } catch (error) {
        if (!(error instanceof AwsError) || !error.code.startsWith("InvalidAMIID.")) throw error;
        found = [];
      }
    } else {
      throw new ProviderError({ error: "invalid-image", message: `the image given, ${shown(image, IMAGE_SHAPE)}, is not one sitesolide can order at AWS`, details: ["--image takes debian-13, the default, or the ID of an AMI of the region, ami-..."] });
    }
    const newest = found
      .filter((candidate) => textAt(candidate, "architecture") === architecture)
      .sort((a, b) => (textAt(b, "creationDate") ?? "").localeCompare(textAt(a, "creationDate") ?? ""))[0];
    if (newest === undefined) {
      throw new ProviderError({
        error: "invalid-image",
        message: image === DEBIAN ? `Debian publishes no Debian 13 image for ${architecture} at ${region}` : `no ${architecture} image ${image} at ${region} that this account may launch`,
        details: image === DEBIAN ? ["Debian's images are listed at https://wiki.debian.org/Cloud/AmazonEC2Image/Trixie: try another --location"] : ["an AMI belongs to one region, and must have the type's architecture"],
      });
    }
    const chosen = { id: textAt(newest, "imageId") ?? "", name: textAt(newest, "name") ?? image, rootDevice: textAt(newest, "rootDeviceName") ?? "/dev/xvda" };
    report(`   ${chosen.name} (${chosen.id})`);
    if (image !== DEBIAN) report(`!! sitesolide setup is only verified on Debian 13, and connects first as ${LOGIN}, the account of Debian's images`);
    return chosen;
  }

  type Placement = { vpcId: string; subnetId: string; zone: string };

  /** The default VPC's subnet in the first zone that sells the type. */
  async function placement(region: string, type: string, zones: string[], report: Report): Promise<Placement> {
    report("-> the default VPC");
    const vpcs = await describe(region, "DescribeVpcs", filters([["is-default", ["true"]]]), "vpcSet", "read the default VPC", 1000);
    const vpcId = textAt(vpcs[0], "vpcId");
    if (vpcId === null) {
      throw new ProviderError({
        error: "no-default-vpc",
        message: `${region} has no default VPC`,
        details: ["sitesolide launches into the default VPC: its owner creates one in the VPC console, Your VPCs, Actions, Create default VPC", "or pick another --location"],
      });
    }
    const subnets = await describe(region, "DescribeSubnets", filters([["vpc-id", [vpcId]], ["default-for-az", ["true"]], ["state", ["available"]]]), "subnetSet", "read the default subnets", 1000);
    if (subnets.length === 0) {
      throw new ProviderError({ error: "no-default-vpc", message: `the default VPC of ${region} has no default subnet`, details: [`${vpcId}: its owner creates one per zone in the VPC console, or with aws ec2 create-default-subnet`] });
    }
    const ordered = [...subnets].sort((a, b) => (textAt(a, "availabilityZone") ?? "").localeCompare(textAt(b, "availabilityZone") ?? ""));
    const chosen = ordered.find((subnet) => zones.includes(textAt(subnet, "availabilityZone") ?? ""));
    if (chosen === undefined) {
      throw new ProviderError({
        error: "type-unavailable",
        message: `${type} is sold at ${region} only in ${zones.join(", ")}, where the default VPC has no default subnet`,
        details: [...(await suggestedTypes(region, type)), "this run had created nothing"],
      });
    }
    const zone = textAt(chosen, "availabilityZone") ?? "";
    report(`   ${vpcId}, subnet ${textAt(chosen, "subnetId")} in ${zone}`);
    return { vpcId, subnetId: textAt(chosen, "subnetId") ?? "", zone };
  }

  /** The security group of that name in the VPC, when sitesolide created it; read before anything is created. */
  async function findGroup(region: string, vpcId: string, groupName: string): Promise<XmlElement | null> {
    const groups = await describe(region, "DescribeSecurityGroups", filters([["vpc-id", [vpcId]], ["group-name", [groupName]]]), "securityGroupInfo", "read the security groups", 1000);
    const same = groups.find((group) => (textAt(group, "groupName") ?? "").toLowerCase() === groupName.toLowerCase());
    if (same !== undefined && !isManaged(tagsOf(same))) {
      throw new ProviderError({
        error: "firewall-taken",
        message: `a security group named ${groupName} exists in the default VPC of ${region}, and sitesolide did not create it`,
        details: [`${textAt(same, "groupId")} lacks the tag ${MANAGED_LABEL}=${MANAGED_VALUE}: it is never adopted nor changed`],
      });
    }
    return same ?? null;
  }

  type Made = { kind: string; name: string; action: string; parameters: Record<string, string> };

  /**
   * Deletes what this run created before an order AWS refused: the key pair,
   * the security group and the address were made for an instance that does
   * not exist, and nothing in sitesolide would ever list or remove them, since
   * `list` and `destroy` start from an instance. What an earlier run made, or
   * the account already held, is left as it was. A deletion that fails leaves
   * the resource tagged, where the next run finds and reuses it. Returns what
   * happened, one line each, for the refusal's details.
   */
  async function undo(region: string, made: Made[], report: Report): Promise<string[]> {
    if (made.length === 0) return ["this run had created nothing"];
    report("-> undo what this run created");
    const said: string[] = [];
    for (const resource of [...made].reverse()) {
      try {
        await call(region, resource.action, resource.parameters, `delete the ${resource.kind} ${resource.name}`);
        said.push(`deleted the ${resource.kind} ${resource.name} this run had created`);
      } catch {
        said.push(`left the ${resource.kind} ${resource.name}: the next run finds it and reuses it`);
      }
      report(`   ${said.at(-1)}`);
    }
    return said;
  }

  async function ensureKey(region: string, request: CreateRequest, pairs: XmlElement[], report: Report): Promise<{ name: string; id: string; reused: boolean; ours: boolean }> {
    report("-> key pair");
    const same = pairs.find((pair) => sameKey(pair, request.key));
    if (same !== undefined) {
      const name = textAt(same, "keyName") ?? "";
      report(`   ${name}, already in ${region} (${request.key.fingerprint}), reused`);
      const tags = tagsOf(same);
      return { name, id: textAt(same, "keyPairId") ?? "", reused: true, ours: isManaged(tags) && tags[MACHINE_LABEL] === request.name };
    }
    // A name of its own, never one the region already uses for another key.
    const taken = new Set(pairs.map((pair) => textAt(pair, "keyName")));
    const plain = `sitesolide-${request.name}`;
    const name = taken.has(plain) ? `${plain}-${request.key.fingerprint.replaceAll(":", "").slice(0, 8)}` : plain;
    const answer = await call(
      region,
      "ImportKeyPair",
      { KeyName: name, PublicKeyMaterial: btoa(keyLine(request.key)), ...tagSpecification(1, "key-pair", tagsFor(request.name)) },
      `import the key pair ${name}`,
    );
    report(`   ${name}, imported (${request.key.fingerprint})`);
    return { name, id: textAt(answer, "keyPairId") ?? "", reused: false, ours: true };
  }

  async function authorize(region: string, groupId: string, rules: readonly Rule[], report: Report): Promise<void> {
    if (rules.length === 0) return;
    const deadline = clock.now() + WAITS.settleMs;
    // A group just created may be unknown to the next call for a moment.
    const add = (some: readonly Rule[]) =>
      settling(() => call(region, "AuthorizeSecurityGroupIngress", { GroupId: groupId, ...permissions(some) }, `open the security group ${groupId}`), new Set(["InvalidGroup.NotFound"]), deadline, report);
    try {
      await add(rules);
    } catch (error) {
      // One rule already there, added by a call whose answer was lost, refuses
      // them all: added one at a time, those already there are passed over.
      if (!(error instanceof AwsError) || error.code !== "InvalidPermission.Duplicate") throw error;
      for (const rule of rules) {
        try {
          await add([rule]);
        } catch (each) {
          if (!(each instanceof AwsError) || each.code !== "InvalidPermission.Duplicate") throw each;
        }
      }
    }
  }

  async function ensureGroup(region: string, placed: Placement, request: CreateRequest, found: XmlElement | null, report: Report): Promise<{ name: string; id: string; reused: boolean }> {
    const groupName = `sitesolide-${request.name}`;
    report(`-> security group ${groupName}`);
    if (found !== null) {
      const id = textAt(found, "groupId") ?? "";
      const missing = missingRules(found);
      // An earlier run may have stopped between the group and its rules.
      await authorize(region, id, missing, report);
      report(`   already created by sitesolide, reused${missing.length === 0 ? "" : `, ${missing.length} missing rules added`}`);
      return { name: groupName, id, reused: true };
    }
    const answer = await call(
      region,
      "CreateSecurityGroup",
      {
        GroupName: groupName,
        GroupDescription: `sitesolide machine ${request.name}: inbound ssh, http, https and ping from everywhere`,
        VpcId: placed.vpcId,
        ...tagSpecification(1, "security-group", tagsFor(request.name)),
      },
      `create the security group ${groupName}`,
    );
    const id = textAt(answer, "groupId") ?? "";
    report(`   created, ${id}`);
    return { name: groupName, id, reused: false };
  }

  type Address = { ip: string; allocationId: string; reused: boolean };

  /** The addresses of a region: there are few, and the call takes no pages. */
  async function addresses(region: string): Promise<XmlElement[]> {
    return items(await call(region, "DescribeAddresses", {}, "read the elastic IPs"), "addressesSet");
  }

  function ownAddress(address: XmlElement, name: string): boolean {
    const tags = tagsOf(address);
    return isManaged(tags) && tags[MACHINE_LABEL] === name;
  }

  async function allocate(region: string, name: string, report: Report): Promise<Address> {
    const answer = await call(region, "AllocateAddress", { Domain: "vpc", ...tagSpecification(1, "elastic-ip", tagsFor(name)) }, `allocate an elastic IP for ${name}`);
    const address = { ip: textAt(answer, "publicIp") ?? "", allocationId: textAt(answer, "allocationId") ?? "", reused: false };
    report(`   ${address.ip}, allocated`);
    return address;
  }

  /**
   * The instance's elastic IP: the one already associated with it, else one
   * an earlier run allocated for this machine and left free, else a new one.
   * The association never takes an address from another instance.
   */
  async function ensureAddress(region: string, name: string, instanceId: string, given: Address | null, report: Report): Promise<Address> {
    report(`-> ${name}'s elastic IP`);
    const all = await addresses(region);
    const held = all.find((address) => textAt(address, "instanceId") === instanceId);
    if (held !== undefined) {
      const ip = textAt(held, "publicIp") ?? "";
      report(ownAddress(held, name) ? `   ${ip}, already associated` : `   ${ip}, associated by someone else: kept as it is`);
      return { ip, allocationId: textAt(held, "allocationId") ?? "", reused: true };
    }
    let address = given;
    if (address === null) {
      const free = all.find((candidate) => ownAddress(candidate, name) && textAt(candidate, "associationId") === null);
      address = free === undefined ? await allocate(region, name, report) : { ip: textAt(free, "publicIp") ?? "", allocationId: textAt(free, "allocationId") ?? "", reused: true };
      if (free !== undefined) report(`   ${address.ip}, allocated for ${name} by an earlier run, reused`);
    }
    const chosen = address;
    await settling(
      () => call(region, "AssociateAddress", { AllocationId: chosen.allocationId, InstanceId: instanceId, AllowReassociation: "false" }, `associate ${chosen.ip} with ${name}`),
      new Set(["InvalidAllocationID.NotFound", "InvalidInstanceID.NotFound", "IncorrectInstanceState"]),
      clock.now() + WAITS.settleMs,
      report,
    );
    report(`   ${chosen.ip}, associated with ${instanceId}`);
    return chosen;
  }

  type Tagged = { region: string; kind: "elastic IP" | "security group" | "key pair"; element: XmlElement; machine: string };

  /**
   * What sitesolide created in a region, tagged, for one machine or for every
   * one: its elastic IPs and security groups, and its key pairs when
   * `withKeys`.
   */
  async function tagged(region: string, machine: string | null, withKeys: boolean): Promise<Tagged[]> {
    const wanted = filters([[`tag:${MANAGED_LABEL}`, [MANAGED_VALUE]], ...(machine === null ? [] : [[`tag:${MACHINE_LABEL}`, [machine]] as const])]);
    const found: Tagged[] = [];
    const keep = (kind: Tagged["kind"], element: XmlElement): void => {
      const tags = tagsOf(element);
      const owner = tags[MACHINE_LABEL];
      if (isManaged(tags) && owner !== undefined && owner !== "" && (machine === null || owner === machine)) found.push({ region, kind, element, machine: owner });
    };
    for (const address of items(await call(region, "DescribeAddresses", wanted, "read the elastic IPs"), "addressesSet")) keep("elastic IP", address);
    for (const group of await describe(region, "DescribeSecurityGroups", wanted, "securityGroupInfo", "read the security groups", 1000)) keep("security group", group);
    if (withKeys) for (const pair of items(await call(region, "DescribeKeyPairs", wanted, "read the key pairs"), "keySet")) keep("key pair", pair);
    return found;
  }

  /**
   * A machine with no instance, but what a run left for it: an order that
   * never went through, or a destroy that stopped halfway. An elastic IP among
   * it is billed by the hour; as a machine, it is listed, and destroy reaches it.
   */
  function incomplete(name: string, left: Tagged[]): Machine {
    const address = left.find((entry) => entry.kind === "elastic IP");
    return {
      provider: "aws",
      id: "",
      name,
      type: "no instance",
      location: address?.region ?? left[0]!.region,
      status: "incomplete",
      ipv4: address === undefined ? null : textAt(address.element, "publicIp"),
      ipv6: null,
      ipv6Network: null,
      monthlyPrice: null,
      backups: false,
      managed: true,
      labels: labelsFor(name),
      login: LOGIN,
    };
  }

  /** The machine as it stands, its elastic IP said even when the instance's own read lags behind. */
  function finished(region: string, instance: XmlElement, address: Address): Machine {
    const machine = toMachine(instance, region);
    return { ...machine, ipv4: address.ip || machine.ipv4 };
  }

  return {
    name: "aws",

    async find(name) {
      const regions = await enabledRegions();
      const { found } = await named(name, checkRegion(home), regions);
      const managed = found.filter(({ instance }) => isManaged(tagsOf(instance)));
      if (managed.length > 1) throw ambiguous(name, managed);
      const chosen = managed[0] ?? found[0];
      if (chosen !== undefined) return toMachine(chosen.instance, chosen.region);
      // No instance, but what a run left for one, in any region, a key pair
      // included: only a machine of that name lets destroy reach it.
      const { found: left } = await everyRegion(home, (region) => tagged(region, name, true), regions);
      return left.length === 0 ? null : incomplete(name, left);
    },

    async create(request, report): Promise<CreateOutcome> {
      const region = checkRegion(request.location);
      const keyProblem = awsKeyProblem(request.key);
      if (keyProblem !== null) {
        throw new ProviderError({ error: "no-ssh-key", message: keyProblem, details: ["pass an ed25519 key with --ssh-key, the .pub file; nothing was created"] });
      }
      const resources: Resource[] = [];
      report(`-> an instance named ${request.name} in the account`);
      const regions = await enabledRegions(region);
      if (!regions.some((candidate) => candidate.name === region)) {
        throw new ProviderError({
          error: "invalid-location",
          message: `${region} is not a region the account has enabled`,
          details: ["the regions enabled:", ...regions.map(({ name, geography }) => `${name.padEnd(15)} ${regionLabel(name, geography)}`), "a region that is not enabled is enabled from the console's Account page, AWS Regions"],
        });
      }
      const { found, skipped } = await named(request.name, region, regions);
      if (skipped.length > 0) report(`!! the credentials may not read ${skipped.join(", ")}: an instance of that name there is not seen`);
      const managed = found.filter(({ instance }) => isManaged(tagsOf(instance)));
      if (managed.length > 1) throw ambiguous(request.name, managed);

      if (managed.length === 1) {
        const existing = managed[0]!;
        const machine = toMachine(existing.instance, existing.region);
        report(`   already created by sitesolide: ${machine.type} at ${machine.location}, ${machine.status}`);
        if (machine.type !== request.type || machine.location !== region) {
          report(`!! it is ${machine.type} at ${machine.location}: --type and --location only apply to a machine being created`);
        }
        resources.push({ kind: "instance", name: machine.name, id: machine.id, reused: true });
        report(`-> ${request.name} running`);
        const running = await waitRunning(existing.region, machine.id, request.name, report, false);
        const address = await ensureAddress(existing.region, request.name, machine.id, null, report);
        resources.push({ kind: "elastic ip", name: address.ip, id: address.allocationId, reused: address.reused });
        return { machine: finished(existing.region, running, address), created: false, resources };
      }
      if (found.length > 0) {
        const other = toMachine(found[0]!.instance, found[0]!.region);
        throw new ProviderError({
          error: "machine-exists",
          message: `an instance named ${request.name} exists in the account, and sitesolide did not create it`,
          details: [
            `${other.id}, ${other.type} at ${other.location}, ${other.status}, ${[other.ipv4, other.ipv6].filter(Boolean).join(", ") || "no public address"}`,
            `it lacks the tag ${MANAGED_LABEL}=${MANAGED_VALUE}: nothing was created, nothing was changed`,
          ],
        });
      }
      report(`   none of that name in the ${regions.length - skipped.length} regions read`);

      // Everything that can refuse, read before the first write.
      const offer = await checkOffer(region, request, report);
      const image = await resolveImage(region, request.image, offer.info.architecture!, report);
      const placed = await placement(region, request.type, offer.zones, report);
      const pairs = items(await call(region, "DescribeKeyPairs", { IncludePublicKey: "true" }, "read the key pairs"), "keySet");
      const existingGroup = await findGroup(region, placed.vpcId, `sitesolide-${request.name}`);
      const free = (await addresses(region)).find((address) => ownAddress(address, request.name) && textAt(address, "associationId") === null);

      // What this run creates before the instance, undone if the order is
      // refused; what an earlier run left and this one reuses, said then.
      const made: Made[] = [];
      const leftBefore: string[] = [];
      let ordering = false;
      let address: Address;
      let ordered: XmlElement | undefined;
      try {
        const key = await ensureKey(region, request, pairs, report);
        resources.push({ kind: "key pair", name: key.name, id: key.id, reused: key.reused });
        if (!key.reused) made.push({ kind: "key pair", name: key.name, action: "DeleteKeyPair", parameters: { KeyPairId: key.id } });
        else if (key.ours) leftBefore.push(`key pair ${key.name}`);

        const group = await ensureGroup(region, placed, request, existingGroup, report);
        resources.push({ kind: "security group", name: group.name, id: group.id, reused: group.reused });
        if (group.reused) leftBefore.push(`security group ${group.name}`);
        if (!group.reused) {
          made.push({ kind: "security group", name: group.name, action: "DeleteSecurityGroup", parameters: { GroupId: group.id } });
          await authorize(region, group.id, FIREWALL_RULES, report);
          report("   inbound tcp 22, 80, 443 and icmp, from everywhere, IPv4 and IPv6");
        }

        report("-> elastic IP, the address that stays across a stop and a start");
        if (free === undefined) {
          address = await allocate(region, request.name, report);
          made.push({ kind: "elastic IP", name: address.ip, action: "ReleaseAddress", parameters: { AllocationId: address.allocationId } });
        } else {
          address = { ip: textAt(free, "publicIp") ?? "", allocationId: textAt(free, "allocationId") ?? "", reused: true };
          leftBefore.push(`elastic IP ${address.ip}, billed by the hour while it exists`);
          report(`   ${address.ip}, allocated for ${request.name} by an earlier run, reused`);
        }
        resources.push({ kind: "elastic ip", name: address.ip, id: address.allocationId, reused: address.reused });

        report(`-> instance ${request.name}: ${request.type} at ${placed.zone}, ${image.name}`);
        ordering = true;
        // The same order, made again with the same address after a run that
        // lost its answer, returns the instance that order created.
        const clientToken = `sitesolide-${sha256(JSON.stringify([request.name, address.allocationId, image.id, request.type, placed.subnetId]), "hex").slice(0, 48)}`;
        // A key pair or a group created a moment ago may be unknown to the
        // order for a while; the token makes asking again harmless.
        const order = (): Promise<XmlElement> => call(
          region,
          "RunInstances",
          {
            ImageId: image.id,
            InstanceType: request.type,
            MinCount: "1",
            MaxCount: "1",
            KeyName: key.name,
            SubnetId: placed.subnetId,
            "SecurityGroupId.1": group.id,
            ClientToken: clientToken,
            // IMDSv2 only: a request forged through the machine cannot read its metadata.
            "MetadataOptions.HttpTokens": "required",
            "MetadataOptions.HttpEndpoint": "enabled",
            "BlockDeviceMapping.1.DeviceName": image.rootDevice,
            "BlockDeviceMapping.1.Ebs.VolumeSize": String(ROOT_VOLUME_GB),
            "BlockDeviceMapping.1.Ebs.VolumeType": "gp3",
            "BlockDeviceMapping.1.Ebs.DeleteOnTermination": "true",
            // With the account's default key, aws/ebs unless its owner chose another: no cost, and the vault's disk is encrypted at rest.
            "BlockDeviceMapping.1.Ebs.Encrypted": "true",
            ...tagSpecification(1, "instance", tagsFor(request.name)),
            ...tagSpecification(2, "volume", tagsFor(request.name)),
          },
          `create the instance ${request.name}`,
        );
        const answer = await settling(order, new Set(["InvalidGroup.NotFound", "InvalidKeyPair.NotFound"]), clock.now() + WAITS.orderMs, report);
        ordered = items(answer, "instancesSet")[0];
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const aws = error instanceof AwsError ? error : null;
        // What an earlier run left, and this one kept: billed or not, nothing
        // but this says where it is once the order is refused.
        const left =
          leftBefore.length === 0
            ? []
            : [
                `left by an earlier run, and kept: ${leftBefore.join("; ")}`,
                `\`sitesolide machine destroy ${request.name} --provider aws${leftBefore.some((line) => line.startsWith("key pair")) ? " --delete-key" : ""}\` removes them, if you give up on this machine`,
              ];
        // Refused for sure: a 4xx other than the rate limit, or no capacity.
        const refused = aws !== null && (CAPACITY.has(aws.code) || (aws.status >= 400 && aws.status < 500 && error.failure.error !== "provider-rate-limited"));
        if (ordering && !refused) {
          throw new ProviderError({
            ...error.failure,
            details: [
              ...(error.failure.details ?? []),
              "whether AWS created the instance is not known: run the same command again, it finds the instance if there is one, and orders it again with the same token otherwise",
              "nothing was deleted: the key pair, the security group and the elastic IP are reused by the next run",
              `if you give up on this machine, \`sitesolide machine destroy ${request.name} --provider aws --delete-key\` removes them`,
            ],
          });
        }
        const undone = await undo(region, made, report);
        if (ordering && aws !== null && refusesFreePlan(aws)) {
          throw new ProviderError({
            error: "type-unavailable",
            message: `the account is on AWS's Free plan, which refuses ${request.type} (${aws.status} ${aws.code}): ${short(aws.said)}`,
            details: [...(await freeTierTypes(region)), "or upgrade the account: Billing console, Upgrade plan", ...undone, ...left],
          });
        }
        if (ordering && aws !== null && (CAPACITY.has(aws.code) || (aws.code === "InvalidParameterValue" && /instance type|availability zone/i.test(aws.said)))) {
          throw new ProviderError({
            error: "type-unavailable",
            message: `AWS would not create ${request.type} at ${placed.zone} (${aws.status} ${aws.code}): ${short(aws.said)}`,
            details: [...(await suggestedTypes(region, request.type)), "or try another --location", ...undone, ...left],
          });
        }
        throw new ProviderError({ ...error.failure, details: [...(error.failure.details ?? []), ...undone, ...left] });
      }
      const id = textAt(ordered, "instanceId");
      if (id === null) throw new AwsError({ error: "provider-unreadable", message: "AWS answered the order without an instance ID" }, 200, "");
      resources.push({ kind: "instance", name: request.name, id, reused: false });
      report(`   ordered, id ${id}`);
      report(`-> ${request.name} running`);
      const running = await waitRunning(region, id, request.name, report, true);
      const associated = await ensureAddress(region, request.name, id, address, report);
      return { machine: finished(region, running, associated), created: true, resources };
    },

    async list() {
      const regions = await enabledRegions();
      const { found } = await everyRegion(
        checkRegion(home),
        async (region) =>
          (await instances(region, filters([[`tag:${MANAGED_LABEL}`, [MANAGED_VALUE]], ["instance-state-name", LIVE_STATES]]), "read the instances")).map((instance) => ({ instance, region })),
        regions,
      );
      const machines = found.filter(({ instance }) => isManaged(tagsOf(instance))).map(({ instance, region }) => toMachine(instance, region));
      // What a run left without an instance, an elastic IP billed by the
      // hour above all, is listed as an incomplete machine. A key pair alone
      // is not: destroy keeps it on purpose, and it costs nothing.
      const alive = new Set(machines.flatMap((machine) => [machine.name, machine.labels[MACHINE_LABEL] ?? machine.name]));
      const { found: left } = await everyRegion(home, (region) => tagged(region, null, false), regions);
      const unfinished = new Map<string, Tagged[]>();
      for (const entry of left) if (!alive.has(entry.machine)) unfinished.set(entry.machine, [...(unfinished.get(entry.machine) ?? []), entry]);
      return [...machines, ...[...unfinished].map(([name, entries]) => incomplete(name, entries))].sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      const region = checkRegion(machine.location);
      const removed: string[] = [];
      const kept: string[] = [];
      const regions = await enabledRegions(region);
      // What was created for it carries the machine's tag, which outlives a
      // change of its Name.
      let owner = machine.name;
      let instanceId: string | null = null;
      // Addresses someone else associated with the instance: never released here.
      let foreign: XmlElement[] = [];

      if (machine.status === "incomplete") {
        report(`-> ${machine.name} has no instance: what was created for it goes`);
      } else {
        report(`-> instance ${machine.name}`);
        const instance = await readInstance(region, machine.id, `read the instance ${machine.name}`);
        if (instance === null) throw new ProviderError({ error: "provider-not-found", message: `the instance ${machine.id} is not at ${region} any more`, details: ["run `sitesolide machine list --provider aws`: nothing was destroyed"] });
        if (!isManaged(tagsOf(instance))) {
          throw new ProviderError({ error: "machine-not-managed", message: `the instance ${machine.id} lacks the tag ${MANAGED_LABEL}=${MANAGED_VALUE}`, details: ["sitesolide only destroys what it created: nothing was destroyed"] });
        }
        owner = tagsOf(instance)[MACHINE_LABEL] ?? machine.name;
        instanceId = machine.id;
        const addressesShown = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");
        // What the instance holds, read before it goes: its volumes, the
        // root one and any attached since, and its addresses.
        const root = textAt(instance, "rootDeviceName");
        const volumes = items(instance, "blockDeviceMapping")
          .map((mapping) => ({ id: textAt(mapping, "ebs", "volumeId"), device: textAt(mapping, "deviceName") ?? "" }))
          .filter((volume): volume is { id: string; device: string } => volume.id !== null);
        foreign = (await addresses(region)).filter((address) => textAt(address, "instanceId") === machine.id && !ownAddress(address, owner));
        if (textAt(instance, "instanceState", "name") !== "terminated") {
          await call(region, "TerminateInstances", numbered("InstanceId", [machine.id]), `terminate the instance ${machine.name}`);
          const deadline = clock.now() + WAITS.terminatedMs;
          let last = "";
          for (;;) {
            const read = await settling(() => readInstance(region, machine.id, `read the instance ${machine.name}`), new Set(), deadline, report);
            const state = read === null ? "terminated" : (textAt(read, "instanceState", "name") ?? "unknown");
            if (state !== last) report(`   state: ${state}`);
            last = state;
            if (state === "terminated") break;
            if (clock.now() >= deadline) {
              throw new ProviderError({
                error: "machine-timeout",
                message: `${machine.name} is still ${state} after ${WAITS.terminatedMs / 60_000} minutes`,
                details: ["AWS terminates it all the same: run the same destroy again in a few minutes, it removes what is left"],
              });
            }
            await clock.sleep(WAITS.pollMs);
          }
        } else {
          report("   already terminated");
        }
        removed.push(`instance ${machine.name}${addressesShown === "" ? "" : ` (${addressesShown})`}`);
        // A volume marked DeleteOnTermination goes with it, the root one and
        // any a person attached so: each of the latter is named, since its
        // data is gone too. One that stayed is billed: checked, and said.
        for (const volume of volumes) {
          const label = `volume ${volume.id}${volume.device === "" ? "" : ` (${volume.device})`}`;
          try {
            const left = items(await call(region, "DescribeVolumes", numbered("VolumeId", [volume.id]), `read the ${label}`), "volumeSet")[0];
            const status = textAt(left, "status");
            if (left !== undefined && status !== "deleting" && status !== "deleted") {
              kept.push(`${label}: AWS kept it after the instance, and bills it until it is deleted from the console`);
              report(`!! ${label} outlived the instance: delete it from the console, or it stays billed`);
              continue;
            }
          } catch (error) {
            if (!(error instanceof AwsError) || error.code !== "InvalidVolume.NotFound") {
              report(`!! could not check that the ${label} went with the instance: look in the console`);
              continue;
            }
          }
          if (volume.device !== root) {
            removed.push(`${label}, attached to ${machine.name}: deleted with it`);
            report(`   ${label}: deleted with the instance`);
          }
        }
      }

      // What was created for the machine, in every region: an interrupted
      // run may have left an address or a group in another one.
      const { found: created, skipped } = await everyRegion(region, (each) => tagged(each, owner, true), regions);
      if (skipped.length > 0) report(`!! the credentials may not read ${skipped.join(", ")}: what was created there for ${machine.name} is not seen`);
      const where = (entry: Tagged): string => (entry.region === region ? "" : ` at ${entry.region}`);

      report("-> elastic IP");
      const ownAddresses = created.filter((entry) => entry.kind === "elastic IP");
      for (const entry of ownAddresses) {
        const ip = `${textAt(entry.element, "publicIp") ?? ""}${where(entry)}`;
        const holder = textAt(entry.element, "instanceId");
        if (holder !== null && holder !== instanceId) {
          kept.push(`elastic IP ${ip}: associated with ${holder} since`);
          report(`   ${ip}: kept, associated with ${holder}`);
          continue;
        }
        await call(entry.region, "ReleaseAddress", { AllocationId: textAt(entry.element, "allocationId") ?? "" }, `release the elastic IP ${ip}`);
        removed.push(`elastic IP ${ip}`);
        report(`   ${ip}: released`);
      }
      for (const address of foreign) {
        const ip = textAt(address, "publicIp") ?? "";
        kept.push(`elastic IP ${ip}: sitesolide did not allocate it; AWS bills it until it is released from the console`);
        report(`!! elastic IP ${ip} was associated with ${machine.name} but sitesolide did not allocate it: kept, and billed until it is released`);
      }
      if (ownAddresses.length === 0 && foreign.length === 0) report(`   none was allocated for ${machine.name}`);

      report(`-> security group sitesolide-${owner}`);
      const groups = created.filter((entry) => entry.kind === "security group");
      if (groups.length === 0) report("   none created by sitesolide for it");
      for (const entry of groups) {
        const id = textAt(entry.element, "groupId") ?? "";
        const name = `${textAt(entry.element, "groupName") ?? id}${where(entry)}`;
        const users = (await instances(entry.region, filters([["instance.group-id", [id]], ["instance-state-name", LIVE_STATES]]), "read the instances of the security group")).map(
          (user) => textAt(user, "instanceId") ?? "",
        );
        if (users.length > 0) {
          kept.push(`security group ${name}: still used by ${users.join(", ")}`);
          report(`   kept: still used by ${users.join(", ")}`);
          continue;
        }
        // The terminated instance's network interface holds the group for a moment.
        const deadline = clock.now() + WAITS.groupMs;
        for (;;) {
          try {
            await call(entry.region, "DeleteSecurityGroup", { GroupId: id }, `delete the security group ${name}`);
            removed.push(`security group ${name}`);
            report(`   ${name}: deleted`);
            break;
          } catch (error) {
            if (!(error instanceof AwsError) || (error.code !== "DependencyViolation" && !TRANSIENT.has(error.failure.error))) throw error;
            if (clock.now() >= deadline) {
              kept.push(`security group ${name}: AWS still says it is in use`);
              report(`   ${name}: kept, AWS still says it is in use; delete it from the console once it is free`);
              break;
            }
            await clock.sleep(WAITS.pollMs);
          }
        }
      }

      report("-> key pair");
      const pairs = created.filter((entry) => entry.kind === "key pair");
      if (pairs.length === 0) report(`   none was imported for ${machine.name}: the key it used was already in the region`);
      for (const entry of pairs) {
        const name = `${textAt(entry.element, "keyName") ?? ""}${where(entry)}`;
        if (options.deleteKey) {
          await call(entry.region, "DeleteKeyPair", { KeyPairId: textAt(entry.element, "keyPairId") ?? "" }, `delete the key pair ${name}`);
          removed.push(`key pair ${name}`);
          report(`   ${name}: deleted`);
        } else {
          kept.push(`key pair ${name}: other machines may be created with it; --delete-key deletes it`);
          report(`   ${name}: kept, other machines may be created with it`);
        }
      }
      return { removed, kept };
    },

    async locations(): Promise<Choice[]> {
      const regions = await enabledRegions();
      const first = (name: string) => (name === home ? 0 : 1);
      return [...regions]
        .sort((a, b) => first(a.name) - first(b.name) || a.name.localeCompare(b.name))
        .map(({ name, geography }) => ({ value: name, label: regionLabel(name, geography), hint: name }));
    },

    async types(location): Promise<Choice[]> {
      const sold = await soldTypes(checkRegion(location));
      return sold.map((info) => {
        const hint = typeHint(info);
        return { value: info.name, label: `${info.name}  ${describeType(info)}`, ...(hint === null ? {} : { hint }) };
      });
    },
  };
}

// --- credentials ------------------------------------------------------------------------------

const ACCESS_KEY_SHAPE = /^[A-Z0-9]{16,128}$/;
const SECRET_KEY_SHAPE = /^[A-Za-z0-9/+=]{16,128}$/;
const SESSION_TOKEN_SHAPE = /^[A-Za-z0-9/+=]{16,8192}$/;

/**
 * The credentials the aws CLI resolves, profiles, IAM Identity Center and
 * AWS_PROFILE included, through `aws configure export-credentials`, whose
 * default format is the JSON of a credential process: `Version` 1,
 * `AccessKeyId`, `SecretAccessKey`, and `SessionToken` for temporary ones.
 * https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html
 * Nothing the command prints, its errors included, is ever repeated.
 */
export async function discoverAws(workstation: Workstation): Promise<Discovery | null> {
  const answer = await workstation.run(["aws", "configure", "export-credentials", "--format", "process"]);
  if (answer.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.stdout);
  } catch {
    return null;
  }
  const { Version, AccessKeyId, SecretAccessKey, SessionToken } = (parsed ?? {}) as Record<string, unknown>;
  if (Version !== 1 || typeof AccessKeyId !== "string" || typeof SecretAccessKey !== "string") return null;
  if (!ACCESS_KEY_SHAPE.test(AccessKeyId) || !SECRET_KEY_SHAPE.test(SecretAccessKey)) return null;
  const token = typeof SessionToken === "string" && SESSION_TOKEN_SHAPE.test(SessionToken) ? SessionToken : null;
  const profile = workstation.environment.AWS_PROFILE?.trim() ?? "";
  return {
    source: `the aws CLI${/^[A-Za-z0-9_.@+=,-]{1,64}$/.test(profile) ? `, profile ${profile}` : ""}`,
    credentials: {
      [ACCESS_KEY_VARIABLE]: AccessKeyId,
      [SECRET_KEY_VARIABLE]: SecretAccessKey,
      ...(token === null ? {} : { [SESSION_TOKEN_VARIABLE]: token }),
    },
  };
}

/** Read from the variables every AWS tool reads, or from the aws CLI when it is signed in. */
export const AWS: ProviderEntry = {
  name: "aws",
  title: "AWS",
  credentials: [
    { variable: ACCESS_KEY_VARIABLE, label: "access key ID", secret: true, shape: ACCESS_KEY_SHAPE },
    { variable: SECRET_KEY_VARIABLE, label: "secret access key", secret: true, shape: SECRET_KEY_SHAPE },
    { variable: SESSION_TOKEN_VARIABLE, label: "session token", secret: true, shape: SESSION_TOKEN_SHAPE, optional: true },
  ],
  discover: discoverAws,
  keyProblem: awsKeyProblem,
  credentialHelp: [
    "create an access key for an IAM user given only the EC2 permissions docs/providers/aws.md lists: IAM, Users, the user, Security credentials, Create access key",
    "or sign the aws CLI in, aws sso login or aws configure, and sitesolide asks it for credentials",
    "an AWS account of its own for sitesolide keeps the key away from everything else you run at AWS",
  ],
  docs: "docs/providers/aws.md",
  defaults: awsDefaults,
  backups: false,
  apiVariable: API_VARIABLE,
  open: aws,
};
