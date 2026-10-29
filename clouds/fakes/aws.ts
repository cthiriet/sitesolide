/**
 * A local stand-in for the EC2 Query API, on a random port of the loopback:
 * the tests of the AWS provider never reach the real one.
 *
 * SITESOLIDE_AWS_API points every region at it; it tells them apart by the
 * region of each request's signature, which it checks against its own copy
 * of the secret, exactly as AWS does, so that a request signed wrong fails
 * here as it would there. It keeps an account in memory, region by region
 * (key pairs, security groups, elastic IPs, instances and their volumes,
 * images, a default VPC), and answers the calls src/aws.ts makes, in the
 * shapes of the API reference
 * (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/): XML in the
 * 2016-11-15 namespace, `<Response><Errors><Error>` errors, `nextToken`
 * pages, filters with their wildcards, a filter it does not know refused.
 *
 * Lists come back `pageSize` items a page whatever MaxResults asks, two by
 * default, so that a client that reads only the first page fails a test, and
 * `emptyFirstPage` sends an empty first page with a token, which the API may.
 * Instances go from pending to running, and from shutting-down to
 * terminated, after a few reads by ID; a security group stays held by a
 * terminated instance's interface for a few tries, as on AWS. `fail()` makes
 * the next matching request answer an error instead.
 */
import { parseAuthorization, signature, signingParts } from "../src/aws-sigv4";
import { escapeXml } from "../src/aws-xml";
import type { FakeProvider, FakeRequest } from "./fake-provider";

export const FAKE_ACCESS_KEY = "AKIAFAKEFAKE01234567";
export const FAKE_SECRET_KEY = "fakeSecretKey0123456789abcdefghijklmnop/+";
export const DEBIAN_OWNER = "136693071363";

type Tags = Record<string, string>;

export type FakeKeyPair = { id: string; name: string; type: string; fingerprint: string; publicKey: string; tags: Tags; invisibleFor?: number };
export type FakeRule = { protocol: string; from: number | null; to: number | null; cidr: string; description: string };
export type FakeGroup = { id: string; name: string; description: string; vpcId: string; tags: Tags; rules: FakeRule[]; invisibleFor: number; heldFor: number; invisibleToRunFor?: number };
export type FakeAddress = { allocationId: string; publicIp: string; tags: Tags; instanceId: string | null; associationId: string | null };
export type FakeVolume = { id: string; size: number; type: string; deleteOnTermination: boolean; encrypted: boolean; status: string; tags: Tags; instanceId: string | null; device: string };
export type FakeImage = { id: string; name: string; owner: string; architecture: string; created: string; rootDevice: string; state: string };
export type FakeSubnet = { id: string; vpcId: string; zone: string; defaultForAz: boolean; ipv6: boolean };
export type FakeInstance = {
  id: string;
  type: string;
  imageId: string;
  architecture: string;
  state: string;
  polls: number;
  invisibleFor: number;
  zone: string;
  subnetId: string;
  vpcId: string;
  keyName: string | null;
  groupIds: string[];
  tags: Tags;
  privateIp: string;
  publicIp: string | null;
  ipv6: string | null;
  volumeIds: string[];
  rootDevice: string;
  metadata: Record<string, string>;
  clientToken: string;
  /** The order's parameters, for a token used again. */
  order: string;
  stateReason: string | null;
};
export type FakeRegion = {
  name: string;
  geography: string;
  optIn: "opt-in-not-required" | "opted-in" | "not-opted-in";
  /** Every call refused with UnauthorizedOperation, as an organisation's policy refuses a region. */
  forbidden: boolean;
  vpcs: { id: string; isDefault: boolean }[];
  subnets: FakeSubnet[];
  /** Instance type -> the zones that sell it. */
  offerings: Record<string, string[]>;
  images: FakeImage[];
  keyPairs: FakeKeyPair[];
  groups: FakeGroup[];
  addresses: FakeAddress[];
  instances: FakeInstance[];
  volumes: FakeVolume[];
};

export type Received = FakeRequest & { action: string; region: string; url: string; body: Record<string, string> };
type Failure = { action: string; status: number; code: string; message: string; times: number; region: string | null; headers: Record<string, string>; match: (body: Record<string, string>) => boolean };

/**
 * What the fake sells, close enough to AWS's catalog to read like it; `free`,
 * Free Tier eligible as AWS lists them for an account created since 15 July
 * 2025 (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html).
 */
export const INSTANCE_TYPES: Record<string, { vcpus: number; memoryMiB: number; architecture: string; burstable: boolean; free?: boolean }> = {
  "t3.micro": { vcpus: 2, memoryMiB: 1024, architecture: "x86_64", burstable: true, free: true },
  "t4g.micro": { vcpus: 2, memoryMiB: 1024, architecture: "arm64", burstable: true, free: true },
  "t3a.micro": { vcpus: 2, memoryMiB: 1024, architecture: "x86_64", burstable: true },
  "t3a.small": { vcpus: 2, memoryMiB: 2048, architecture: "x86_64", burstable: true },
  "t3a.medium": { vcpus: 2, memoryMiB: 4096, architecture: "x86_64", burstable: true },
  "t3a.large": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64", burstable: true },
  "t3.small": { vcpus: 2, memoryMiB: 2048, architecture: "x86_64", burstable: true, free: true },
  "t3.medium": { vcpus: 2, memoryMiB: 4096, architecture: "x86_64", burstable: true },
  "t3.large": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64", burstable: true },
  "t4g.small": { vcpus: 2, memoryMiB: 2048, architecture: "arm64", burstable: true, free: true },
  "t4g.medium": { vcpus: 2, memoryMiB: 4096, architecture: "arm64", burstable: true },
  "t4g.large": { vcpus: 2, memoryMiB: 8192, architecture: "arm64", burstable: true },
  "c7i-flex.large": { vcpus: 2, memoryMiB: 4096, architecture: "x86_64", burstable: false, free: true },
  "m7i-flex.large": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64", burstable: false, free: true },
  "m7i.large": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64", burstable: false },
  "m7a.large": { vcpus: 2, memoryMiB: 8192, architecture: "x86_64", burstable: false },
  "c7i.large": { vcpus: 2, memoryMiB: 4096, architecture: "x86_64", burstable: false },
  "mac2.metal": { vcpus: 8, memoryMiB: 16384, architecture: "arm64_mac", burstable: false },
};

const STATE_CODES: Record<string, number> = { pending: 0, running: 16, "shutting-down": 32, terminated: 48, stopping: 64, stopped: 80 };

function hex(n: number, width = 17): string {
  return n.toString(16).padStart(width, "0");
}

/** `debian-13-amd64-*` as a pattern: `*` any run, `?` one character. */
function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
}

const el = (name: string, value: string | number | boolean | null | undefined): string => (value === null || value === undefined ? "" : `<${name}>${escapeXml(String(value))}</${name}>`);
const set = (name: string, entries: string[]): string => (entries.length === 0 ? `<${name}/>` : `<${name}>${entries.map((entry) => `<item>${entry}</item>`).join("")}</${name}>`);
const tagSet = (tags: Tags): string => set("tagSet", Object.entries(tags).map(([key, value]) => `${el("key", key)}${el("value", value)}`));

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error></Errors><RequestID>ea966190-f9aa-478e-9ede-example</RequestID></Response>`;
  return new Response(body, { status, headers: { "Content-Type": "text/xml;charset=UTF-8", ...headers } });
}

/** `InstanceId.1`, `InstanceId.2`... in order. */
function listOf(form: Record<string, string>, name: string): string[] {
  const values: string[] = [];
  for (let index = 1; form[`${name}.${index}`] !== undefined; index++) values.push(form[`${name}.${index}`]!);
  return values;
}

type Filter = { name: string; values: string[] };

function filtersOf(form: Record<string, string>): Filter[] {
  const found: Filter[] = [];
  for (let index = 1; form[`Filter.${index}.Name`] !== undefined; index++) found.push({ name: form[`Filter.${index}.Name`]!, values: listOf(form, `Filter.${index}.Value`) });
  return found;
}

/**
 * Whether a resource passes every filter, any of each filter's values; a
 * filter the resource type does not know is refused, as AWS refuses it.
 */
function passes(filters: Filter[], valuesOf: (name: string) => (string | null)[] | null, tags: Tags | null): boolean {
  return filters.every((filter) => {
    let actual: (string | null)[] | null;
    if (filter.name.startsWith("tag:") && tags !== null) actual = [tags[filter.name.slice(4)] ?? null];
    else if (filter.name === "tag-key" && tags !== null) actual = Object.keys(tags);
    else actual = valuesOf(filter.name);
    if (actual === null) throw new ApiError(400, "InvalidParameterValue", `The filter '${filter.name}' is invalid`);
    return filter.values.some((value) => actual!.some((candidate) => candidate !== null && glob(value).test(candidate)));
  });
}

function tagsFrom(form: Record<string, string>, resourceType: string): Tags {
  const tags: Tags = {};
  for (let index = 1; form[`TagSpecification.${index}.ResourceType`] !== undefined; index++) {
    if (form[`TagSpecification.${index}.ResourceType`] !== resourceType) continue;
    for (let tag = 1; form[`TagSpecification.${index}.Tag.${tag}.Key`] !== undefined; tag++) {
      tags[form[`TagSpecification.${index}.Tag.${tag}.Key`]!] = form[`TagSpecification.${index}.Tag.${tag}.Value`] ?? "";
    }
  }
  return tags;
}

function md5Fingerprint(blob: Uint8Array): string {
  return new Bun.CryptoHasher("md5").update(blob).digest("hex").match(/../g)!.join(":");
}

export type FakeAws = ReturnType<typeof createFakeAws>;

export function createFakeAws(options: { pageSize?: number } = {}) {
  let serial = 1;
  const next = (): number => serial++;
  /** The last byte of the next elastic IP, in 203.0.113.0/24. */
  let addressNumber = 10;
  const regions = new Map<string, FakeRegion>();
  const requests: Received[] = [];
  const failures: Failure[] = [];
  const settings = {
    pageSize: options.pageSize ?? 2,
    /** The first page of every list comes back empty, with a token. */
    emptyFirstPage: false,
    /** Reads by ID before a pending instance runs; Infinity, never. */
    runningPolls: 2,
    terminatePolls: 2,
    /** Reads by ID an instance just ordered is not found by. */
    instanceInvisible: 0,
    /** Calls a security group just created is not found by. */
    groupInvisible: 0,
    /** Deletions a terminated instance's security group still refuses. */
    groupHeld: 1,
    /** Orders a key pair, or a security group, just created is not found by. */
    keyInvisible: 0,
    groupInvisibleAtRun: 0,
    /** The account is on AWS's Free plan: an order for a type not Free Tier eligible is refused. */
    freePlan: false,
    addressLimit: 5,
    sessionToken: null as string | null,
    accessKey: FAKE_ACCESS_KEY,
    secretKey: FAKE_SECRET_KEY,
  };

  function region(name: string, geography: string, optIn: FakeRegion["optIn"], offeringsFor: (type: string) => string[]): FakeRegion {
    const zones = ["a", "b", "c"].map((letter) => `${name}${letter}`);
    const vpc = `vpc-${hex(next())}`;
    const offerings: Record<string, string[]> = {};
    for (const type of Object.keys(INSTANCE_TYPES)) {
      const sold = offeringsFor(type).filter((zone) => zones.includes(zone));
      if (sold.length > 0) offerings[type] = sold;
    }
    const image = (imageName: string, owner: string, architecture: string, created: string): FakeImage => ({
      id: `ami-${hex(next())}`,
      name: imageName,
      owner,
      architecture,
      created,
      rootDevice: "/dev/xvda",
      state: "available",
    });
    const state: FakeRegion = {
      name,
      geography,
      optIn,
      forbidden: false,
      vpcs: [{ id: vpc, isDefault: true }],
      subnets: zones.map((zone) => ({ id: `subnet-${hex(next())}`, vpcId: vpc, zone, defaultForAz: true, ipv6: false })),
      offerings,
      images: [
        image("debian-13-amd64-20260901-2400", DEBIAN_OWNER, "x86_64", "2026-09-01T10:00:00.000Z"),
        image("debian-13-amd64-20261017-2634", DEBIAN_OWNER, "x86_64", "2026-10-17T10:00:00.000Z"),
        image("debian-13-arm64-20261017-2634", DEBIAN_OWNER, "arm64", "2026-10-17T10:00:00.000Z"),
        image("debian-13-backports-amd64-20261020-2640", DEBIAN_OWNER, "x86_64", "2026-10-20T10:00:00.000Z"),
        // Named like Debian's, newer, and not Debian's: never chosen.
        image("debian-13-amd64-20270101-9999", "999988887777", "x86_64", "2027-01-01T10:00:00.000Z"),
      ],
      keyPairs: [],
      groups: [{ id: `sg-${hex(next())}`, name: "default", description: "default VPC security group", vpcId: vpc, tags: {}, rules: [], invisibleFor: 0, heldFor: 0 }],
      addresses: [],
      instances: [],
      volumes: [],
    };
    return state;
  }

  function seed(): void {
    regions.clear();
    const everywhere = (name: string) => () => ["a", "b", "c"].map((letter) => `${name}${letter}`);
    regions.set("eu-central-1", region("eu-central-1", "Germany", "opt-in-not-required", (type) => (type === "m7a.large" ? ["eu-central-1b", "eu-central-1c"] : type === "c7i.large" ? ["eu-central-1c"] : everywhere("eu-central-1")())));
    // Paris sells no t3 nor t3a here, for the refusals that suggest other types.
    regions.set("eu-west-3", region("eu-west-3", "France", "opt-in-not-required", (type) => (type.startsWith("t3a.") || type.startsWith("t3.") ? [] : everywhere("eu-west-3")())));
    regions.set("us-east-1", region("us-east-1", "United States of America", "opt-in-not-required", everywhere("us-east-1")));
    regions.set("ap-southeast-7", region("ap-southeast-7", "Thailand", "not-opted-in", everywhere("ap-southeast-7")));
  }
  seed();

  function regionOf(name: string): FakeRegion {
    const found = regions.get(name);
    if (found === undefined || found.optIn === "not-opted-in") throw new ApiError(401, "AuthFailure", "AWS was not able to validate the provided access credentials");
    if (found.forbidden) throw new ApiError(403, "UnauthorizedOperation", "You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/sitesolide is not authorized in this region");
    return found;
  }

  /** One page of a list, and the token of the next. */
  function paginate<T>(form: Record<string, string>, entries: T[], range: [number, number] | null): { page: T[]; token: string | null } {
    const wanted = form.MaxResults === undefined ? Number.POSITIVE_INFINITY : Number(form.MaxResults);
    if (form.MaxResults !== undefined && range === null) throw new ApiError(400, "UnknownParameter", "The parameter MaxResults is not recognized");
    if (range !== null && form.MaxResults !== undefined && (wanted < range[0] || wanted > range[1])) {
      throw new ApiError(400, "InvalidParameterValue", `Value ( ${form.MaxResults} ) for parameter maxResults is invalid. Expecting a value between ${range[0]} and ${range[1]}.`);
    }
    if (range === null) return { page: entries, token: null };
    let start = 0;
    if (form.NextToken !== undefined) {
      const match = /^token-([0-9]+)$/.exec(form.NextToken);
      if (match === null) throw new ApiError(400, "InvalidParameterValue", "Invalid NextToken");
      start = Number(match[1]);
    } else if (settings.emptyFirstPage && entries.length > 0) {
      return { page: [], token: "token-0" };
    }
    const size = Math.min(wanted, settings.pageSize);
    const page = entries.slice(start, start + size);
    return { page, token: start + size < entries.length ? `token-${start + size}` : null };
  }

  const tokenElement = (token: string | null): string => el("nextToken", token);

  function answer(action: string, body: string): Response {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>${body}</${action}Response>`;
    return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml;charset=UTF-8" } });
  }

  // --- views

  function instanceView(state: FakeRegion, instance: FakeInstance): string {
    const groups = instance.groupIds.map((id) => `${el("groupId", id)}${el("groupName", state.groups.find((group) => group.id === id)?.name ?? "")}`);
    const volumes = instance.volumeIds
      .map((id) => state.volumes.find((volume) => volume.id === id))
      .filter((volume): volume is FakeVolume => volume !== undefined && instance.state !== "terminated")
      .map((volume) => `${el("deviceName", volume.device)}<ebs>${el("volumeId", volume.id)}${el("status", "attached")}${el("attachTime", "2026-10-21T10:00:00.000Z")}${el("deleteOnTermination", volume.deleteOnTermination)}</ebs>`);
    const association = instance.publicIp === null ? "" : `<association>${el("publicIp", instance.publicIp)}${el("ipOwnerId", "amazon")}</association>`;
    const ipv6 = instance.ipv6 === null ? "" : set("ipv6AddressesSet", [el("ipv6Address", instance.ipv6)]);
    const networkInterfaces = instance.state === "terminated" ? set("networkInterfaceSet", []) : set("networkInterfaceSet", [
      `${el("networkInterfaceId", `eni-${instance.id.slice(2)}`)}${el("subnetId", instance.subnetId)}${el("vpcId", instance.vpcId)}${el("status", "in-use")}${el("privateIpAddress", instance.privateIp)}${set("groupSet", groups)}${association}${ipv6}`,
    ]);
    return [
      el("instanceId", instance.id),
      el("imageId", instance.imageId),
      `<instanceState>${el("code", STATE_CODES[instance.state])}${el("name", instance.state)}</instanceState>`,
      "<privateDnsName/><dnsName/><reason/>",
      el("keyName", instance.keyName),
      el("amiLaunchIndex", 0),
      "<productCodes/>",
      el("instanceType", instance.type),
      el("launchTime", "2026-10-21T10:00:00.000Z"),
      `<placement>${el("availabilityZone", instance.zone)}<groupName/>${el("tenancy", "default")}</placement>`,
      `<monitoring>${el("state", "disabled")}</monitoring>`,
      el("subnetId", instance.subnetId),
      el("vpcId", instance.vpcId),
      el("privateIpAddress", instance.privateIp),
      el("ipAddress", instance.state === "terminated" ? null : instance.publicIp),
      el("ipv6Address", instance.ipv6),
      el("sourceDestCheck", true),
      set("groupSet", groups),
      instance.stateReason === null ? "" : `<stateReason>${el("code", instance.stateReason)}${el("message", instance.stateReason)}</stateReason>`,
      el("architecture", instance.architecture),
      el("rootDeviceType", "ebs"),
      el("rootDeviceName", instance.rootDevice),
      set("blockDeviceMapping", volumes),
      el("virtualizationType", "hvm"),
      el("clientToken", instance.clientToken),
      tagSet(instance.tags),
      el("hypervisor", "xen"),
      networkInterfaces,
      `<metadataOptions>${el("state", "applied")}${el("httpTokens", instance.metadata.HttpTokens ?? "optional")}${el("httpEndpoint", instance.metadata.HttpEndpoint ?? "enabled")}</metadataOptions>`,
      el("ebsOptimized", false),
    ].join("");
  }

  function groupView(group: FakeGroup): string {
    const permissions = new Map<string, FakeRule[]>();
    for (const rule of group.rules) {
      const key = `${rule.protocol} ${rule.from} ${rule.to}`;
      permissions.set(key, [...(permissions.get(key) ?? []), rule]);
    }
    const ipPermissions = [...permissions.values()].map((rules) => {
      const first = rules[0]!;
      const v4 = rules.filter((rule) => !rule.cidr.includes(":")).map((rule) => `${el("cidrIp", rule.cidr)}${el("description", rule.description)}`);
      const v6 = rules.filter((rule) => rule.cidr.includes(":")).map((rule) => `${el("cidrIpv6", rule.cidr)}${el("description", rule.description)}`);
      return `${el("ipProtocol", first.protocol)}${el("fromPort", first.from)}${el("toPort", first.to)}<groups/>${set("ipRanges", v4)}${set("ipv6Ranges", v6)}<prefixListIds/>`;
    });
    return [
      el("ownerId", "123456789012"),
      el("groupId", group.id),
      el("groupName", group.name),
      el("groupDescription", group.description),
      el("vpcId", group.vpcId),
      set("ipPermissions", ipPermissions),
      set("ipPermissionsEgress", [`${el("ipProtocol", "-1")}<groups/>${set("ipRanges", [el("cidrIp", "0.0.0.0/0")])}<ipv6Ranges/><prefixListIds/>`]),
      tagSet(group.tags),
    ].join("");
  }

  function addressView(address: FakeAddress): string {
    return [
      el("publicIp", address.publicIp),
      el("allocationId", address.allocationId),
      el("domain", "vpc"),
      el("instanceId", address.instanceId),
      el("associationId", address.associationId),
      address.instanceId === null ? "" : el("networkInterfaceId", `eni-${address.instanceId.slice(2)}`),
      tagSet(address.tags),
    ].join("");
  }

  // --- what happens to an instance with time

  function finishTermination(state: FakeRegion, instance: FakeInstance): void {
    instance.state = "terminated";
    for (const id of instance.volumeIds) {
      const index = state.volumes.findIndex((volume) => volume.id === id);
      if (index === -1) continue;
      if (state.volumes[index]!.deleteOnTermination) state.volumes.splice(index, 1);
      else Object.assign(state.volumes[index]!, { status: "available", instanceId: null });
    }
    for (const address of state.addresses.filter((candidate) => candidate.instanceId === instance.id)) Object.assign(address, { instanceId: null, associationId: null });
    for (const id of instance.groupIds) {
      const group = state.groups.find((candidate) => candidate.id === id);
      if (group !== undefined) group.heldFor = settings.groupHeld;
    }
  }

  /** A read by ID moves an instance on. */
  function advance(state: FakeRegion, instance: FakeInstance): void {
    if (instance.state === "pending" && ++instance.polls >= settings.runningPolls) {
      instance.state = "running";
      instance.polls = 0;
    } else if (instance.state === "shutting-down" && ++instance.polls >= settings.terminatePolls) {
      finishTermination(state, instance);
    }
  }

  function visibleInstance(state: FakeRegion, id: string): FakeInstance {
    const instance = state.instances.find((candidate) => candidate.id === id);
    if (instance === undefined) throw new ApiError(400, "InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
    if (instance.invisibleFor > 0) {
      instance.invisibleFor--;
      throw new ApiError(400, "InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
    }
    return instance;
  }

  function group(state: FakeRegion, id: string): FakeGroup {
    const found = state.groups.find((candidate) => candidate.id === id);
    if (found === undefined) throw new ApiError(400, "InvalidGroup.NotFound", `The security group '${id}' does not exist`);
    return found;
  }

  // --- the actions

  const actions: Record<string, (state: FakeRegion, form: Record<string, string>, regionName: string) => Response> = {
    DescribeRegions(_state, form) {
      if (form.MaxResults !== undefined) throw new ApiError(400, "UnknownParameter", "The parameter MaxResults is not recognized");
      const all = [...regions.values()].filter((candidate) => form.AllRegions === "true" || candidate.optIn !== "not-opted-in");
      const shown = all.filter((candidate) => passes(filtersOf(form), (name) => (name === "region-name" ? [candidate.name] : name === "opt-in-status" ? [candidate.optIn] : null), null));
      return answer(
        "DescribeRegions",
        set(
          "regionInfo",
          shown.map((candidate) => `${el("regionName", candidate.name)}${el("regionEndpoint", `ec2.${candidate.name}.amazonaws.com`)}${el("optInStatus", candidate.optIn)}${set("geographySet", [el("name", candidate.geography)])}`),
        ),
      );
    },

    DescribeInstances(state, form) {
      const ids = listOf(form, "InstanceId");
      if (ids.length > 0 && form.MaxResults !== undefined) throw new ApiError(400, "InvalidParameterCombination", "The parameter instancesSet cannot be used with the parameter maxResults");
      const chosen = ids.length > 0 ? ids.map((id) => visibleInstance(state, id)) : state.instances.filter((instance) => instance.invisibleFor === 0);
      if (ids.length > 0) for (const instance of chosen) advance(state, instance);
      const shown = chosen.filter((instance) =>
        passes(
          filtersOf(form),
          (name) =>
            ({
              "instance-state-name": [instance.state],
              "instance-id": [instance.id],
              "instance.group-id": instance.groupIds,
              "instance-type": [instance.type],
              "ip-address": [instance.publicIp],
            })[name] ?? null,
          instance.tags,
        ),
      );
      const { page, token } = paginate(form, shown, ids.length > 0 ? null : [5, 1000]);
      const reservations = page.map((instance) => `${el("reservationId", `r-${instance.id.slice(2)}`)}${el("ownerId", "123456789012")}<groupSet/>${set("instancesSet", [instanceView(state, instance)])}`);
      return answer("DescribeInstances", `${set("reservationSet", reservations)}${tokenElement(token)}`);
    },

    DescribeInstanceTypes(state, form) {
      const names = listOf(form, "InstanceType");
      const unknown = names.filter((name) => INSTANCE_TYPES[name] === undefined);
      if (unknown.length > 0) throw new ApiError(400, "InvalidInstanceType", `The following supplied instance types do not exist: [${unknown.join(", ")}]`);
      const sold = (names.length > 0 ? names : Object.keys(INSTANCE_TYPES)).filter(
        (name) =>
          state.offerings[name] !== undefined &&
          passes(
            filtersOf(form),
            (filter) =>
              ({
                "instance-type": [name],
                "free-tier-eligible": [String(INSTANCE_TYPES[name]!.free === true)],
                "current-generation": ["true"],
                "processor-info.supported-architecture": [INSTANCE_TYPES[name]!.architecture],
              })[filter] ?? null,
            null,
          ),
      );
      const { page, token } = paginate(form, sold, [5, 100]);
      const entries = page.map((name) => {
        const type = INSTANCE_TYPES[name]!;
        return [
          el("instanceType", name),
          el("currentGeneration", true),
          el("freeTierEligible", type.free === true),
          el("burstablePerformanceSupported", type.burstable),
          `<vCpuInfo>${el("defaultVCpus", type.vcpus)}${el("defaultCores", type.vcpus / 2)}${el("defaultThreadsPerCore", 2)}</vCpuInfo>`,
          `<memoryInfo>${el("sizeInMiB", type.memoryMiB)}</memoryInfo>`,
          `<processorInfo><supportedArchitectures><item>${type.architecture}</item></supportedArchitectures>${el("sustainedClockSpeedInGhz", 2.5)}</processorInfo>`,
          el("hypervisor", "nitro"),
        ].join("");
      });
      return answer("DescribeInstanceTypes", `${set("instanceTypeSet", entries)}${tokenElement(token)}`);
    },

    DescribeInstanceTypeOfferings(state, form, regionName) {
      const locationType = form.LocationType ?? "region";
      const offerings: { type: string; location: string }[] = [];
      for (const [type, zones] of Object.entries(state.offerings)) {
        if (locationType === "region") offerings.push({ type, location: regionName });
        else if (locationType === "availability-zone") for (const zone of zones) offerings.push({ type, location: zone });
        else throw new ApiError(400, "InvalidParameterValue", `Value (${locationType}) for parameter locationType is invalid`);
      }
      const shown = offerings.filter((offering) => passes(filtersOf(form), (name) => (name === "instance-type" ? [offering.type] : name === "location" ? [offering.location] : null), null));
      const { page, token } = paginate(form, shown, [5, 1000]);
      return answer(
        "DescribeInstanceTypeOfferings",
        `${set("instanceTypeOfferingSet", page.map((offering) => `${el("instanceType", offering.type)}${el("locationType", locationType)}${el("location", offering.location)}`))}${tokenElement(token)}`,
      );
    },

    DescribeImages(state, form) {
      const ids = listOf(form, "ImageId");
      const owners = listOf(form, "Owner");
      for (const id of ids) if (!state.images.some((image) => image.id === id)) throw new ApiError(400, "InvalidAMIID.NotFound", `The image id '[${id}]' does not exist`);
      const shown = state.images.filter(
        (image) =>
          (ids.length === 0 || ids.includes(image.id)) &&
          (owners.length === 0 || owners.includes(image.owner)) &&
          passes(
            filtersOf(form),
            (name) => ({ name: [image.name], architecture: [image.architecture], state: [image.state], "image-type": ["machine"], "owner-id": [image.owner], "image-id": [image.id] })[name] ?? null,
            {},
          ),
      );
      const { page, token } = paginate(form, shown, ids.length > 0 ? null : [5, 1000]);
      const entries = page.map((image) =>
        [
          el("imageId", image.id),
          el("imageLocation", `${image.owner}/${image.name}`),
          el("imageState", image.state),
          el("imageOwnerId", image.owner),
          el("ownerId", image.owner),
          el("creationDate", image.created),
          el("isPublic", true),
          el("architecture", image.architecture),
          el("imageType", "machine"),
          el("name", image.name),
          el("rootDeviceType", "ebs"),
          el("rootDeviceName", image.rootDevice),
          set("blockDeviceMapping", [`${el("deviceName", image.rootDevice)}<ebs>${el("snapshotId", "snap-0123456789abcdef0")}${el("volumeSize", 8)}${el("deleteOnTermination", true)}${el("volumeType", "gp3")}</ebs>`]),
          el("virtualizationType", "hvm"),
          el("enaSupport", true),
          "<tagSet/>",
        ].join(""),
      );
      return answer("DescribeImages", `${set("imagesSet", entries)}${tokenElement(token)}`);
    },

    DescribeVpcs(state, form) {
      const shown = state.vpcs.filter((vpc) => passes(filtersOf(form), (name) => ({ "is-default": [String(vpc.isDefault)], "vpc-id": [vpc.id], state: ["available"] })[name] ?? null, {}));
      const { page, token } = paginate(form, shown, [5, 1000]);
      return answer(
        "DescribeVpcs",
        `${set("vpcSet", page.map((vpc) => `${el("vpcId", vpc.id)}${el("ownerId", "123456789012")}${el("state", "available")}${el("cidrBlock", "172.31.0.0/16")}${el("instanceTenancy", "default")}${el("isDefault", vpc.isDefault)}`))}${tokenElement(token)}`,
      );
    },

    DescribeSubnets(state, form) {
      const shown = state.subnets.filter((subnet) =>
        passes(filtersOf(form), (name) => ({ "vpc-id": [subnet.vpcId], "default-for-az": [String(subnet.defaultForAz)], state: ["available"], "availability-zone": [subnet.zone], "subnet-id": [subnet.id] })[name] ?? null, {}),
      );
      const { page, token } = paginate(form, shown, [5, 1000]);
      const entries = page.map(
        (subnet) =>
          `${el("subnetId", subnet.id)}${el("state", "available")}${el("vpcId", subnet.vpcId)}${el("cidrBlock", "172.31.0.0/20")}${subnet.ipv6 ? set("ipv6CidrBlockAssociationSet", [el("ipv6CidrBlock", "2001:db8:1::/64")]) : "<ipv6CidrBlockAssociationSet/>"}${el("availableIpAddressCount", 4091)}${el("availabilityZone", subnet.zone)}${el("defaultForAz", subnet.defaultForAz)}${el("mapPublicIpOnLaunch", true)}${el("assignIpv6AddressOnCreation", subnet.ipv6)}`,
      );
      return answer("DescribeSubnets", `${set("subnetSet", entries)}${tokenElement(token)}`);
    },

    DescribeKeyPairs(state, form) {
      if (form.MaxResults !== undefined) throw new ApiError(400, "UnknownParameter", "The parameter MaxResults is not recognized");
      const names = listOf(form, "KeyName");
      for (const name of names) if (!state.keyPairs.some((pair) => pair.name === name)) throw new ApiError(400, "InvalidKeyPair.NotFound", `The key pair '${name}' does not exist`);
      const shown = state.keyPairs.filter(
        (pair) =>
          (names.length === 0 || names.includes(pair.name)) &&
          passes(filtersOf(form), (name) => ({ "key-name": [pair.name], "key-pair-id": [pair.id], fingerprint: [pair.fingerprint] })[name] ?? null, pair.tags),
      );
      const entries = shown.map(
        (pair) =>
          `${el("keyPairId", pair.id)}${el("keyFingerprint", pair.fingerprint)}${el("keyName", pair.name)}${el("keyType", pair.type)}${tagSet(pair.tags)}${form.IncludePublicKey === "true" ? el("publicKey", pair.publicKey) : ""}${el("createTime", "2026-10-21T10:00:00.000Z")}`,
      );
      return answer("DescribeKeyPairs", set("keySet", entries));
    },

    ImportKeyPair(state, form) {
      const name = form.KeyName;
      if (name === undefined || form.PublicKeyMaterial === undefined) throw new ApiError(400, "MissingParameter", "The request must contain the parameter KeyName and PublicKeyMaterial");
      const line = Buffer.from(form.PublicKeyMaterial, "base64").toString("utf8").trim();
      const [algorithm = "", blob = ""] = line.split(/\s+/);
      if (algorithm !== "ssh-ed25519" && algorithm !== "ssh-rsa") throw new ApiError(400, "InvalidKeyPair.Format", "Key is not in valid OpenSSH public key format");
      if (state.keyPairs.some((pair) => pair.name === name)) throw new ApiError(400, "InvalidKeyPair.Duplicate", `The keypair already exists`);
      const raw = Buffer.from(blob, "base64");
      const fingerprint = algorithm === "ssh-rsa" ? md5Fingerprint(raw) : new Bun.CryptoHasher("sha256").update(raw).digest("base64");
      const pair: FakeKeyPair = { id: `key-${hex(next())}`, name, type: algorithm === "ssh-rsa" ? "rsa" : "ed25519", fingerprint, publicKey: `${algorithm} ${blob}`, tags: tagsFrom(form, "key-pair"), invisibleFor: settings.keyInvisible };
      state.keyPairs.push(pair);
      return answer("ImportKeyPair", `${el("keyName", pair.name)}${el("keyPairId", pair.id)}${el("keyFingerprint", pair.fingerprint)}${tagSet(pair.tags)}`);
    },

    DeleteKeyPair(state, form) {
      const index = state.keyPairs.findIndex((pair) => pair.id === form.KeyPairId || pair.name === form.KeyName);
      const removed = index === -1 ? null : state.keyPairs.splice(index, 1)[0]!;
      return answer("DeleteKeyPair", `${el("return", true)}${el("keyPairId", removed?.id ?? form.KeyPairId)}`);
    },

    DescribeSecurityGroups(state, form) {
      const ids = listOf(form, "GroupId");
      for (const id of ids) group(state, id);
      const shown = state.groups.filter(
        (candidate) =>
          candidate.invisibleFor === 0 &&
          (ids.length === 0 || ids.includes(candidate.id)) &&
          passes(filtersOf(form), (name) => ({ "group-name": [candidate.name], "vpc-id": [candidate.vpcId], "group-id": [candidate.id] })[name] ?? null, candidate.tags),
      );
      const { page, token } = paginate(form, shown, [5, 1000]);
      return answer("DescribeSecurityGroups", `${set("securityGroupInfo", page.map(groupView))}${tokenElement(token)}`);
    },

    CreateSecurityGroup(state, form) {
      const name = form.GroupName ?? "";
      if (name === "" || form.GroupDescription === undefined) throw new ApiError(400, "MissingParameter", "The request must contain the parameter GroupName and GroupDescription");
      if (name.startsWith("sg-")) throw new ApiError(400, "InvalidParameterValue", "Group names may not be in the format sg-*");
      if (!/^[A-Za-z0-9 ._\-:/()#,@[\]+=&;{}!$*]{1,255}$/.test(form.GroupDescription)) throw new ApiError(400, "InvalidParameterValue", "Invalid group description");
      const vpcId = form.VpcId ?? state.vpcs.find((vpc) => vpc.isDefault)?.id;
      if (vpcId === undefined) throw new ApiError(400, "VPCIdNotSpecified", "No default VPC for this user");
      if (state.groups.some((candidate) => candidate.vpcId === vpcId && candidate.name.toLowerCase() === name.toLowerCase())) {
        throw new ApiError(400, "InvalidGroup.Duplicate", `The security group '${name}' already exists for VPC '${vpcId}'`);
      }
      const created: FakeGroup = { id: `sg-${hex(next())}`, name, description: form.GroupDescription, vpcId, tags: tagsFrom(form, "security-group"), rules: [], invisibleFor: settings.groupInvisible, heldFor: 0, invisibleToRunFor: settings.groupInvisibleAtRun };
      state.groups.push(created);
      return answer("CreateSecurityGroup", `${el("return", true)}${el("groupId", created.id)}${el("securityGroupArn", `arn:aws:ec2:eu-central-1:123456789012:security-group/${created.id}`)}${tagSet(created.tags)}`);
    },

    AuthorizeSecurityGroupIngress(state, form) {
      const target = group(state, form.GroupId ?? "");
      if (target.invisibleFor > 0) {
        target.invisibleFor--;
        throw new ApiError(400, "InvalidGroup.NotFound", `The security group '${target.id}' does not exist`);
      }
      const added: FakeRule[] = [];
      for (let index = 1; form[`IpPermissions.${index}.IpProtocol`] !== undefined; index++) {
        const prefix = `IpPermissions.${index}`;
        const protocol = form[`${prefix}.IpProtocol`]!;
        if (!["tcp", "udp", "icmp", "icmpv6", "-1"].includes(protocol)) throw new ApiError(400, "InvalidParameterValue", `Invalid value '${protocol}' for IP protocol`);
        const from = form[`${prefix}.FromPort`] === undefined ? null : Number(form[`${prefix}.FromPort`]);
        const to = form[`${prefix}.ToPort`] === undefined ? null : Number(form[`${prefix}.ToPort`]);
        if ((protocol === "tcp" || protocol === "icmp") && (from === null || to === null)) throw new ApiError(400, "InvalidParameterValue", "Invalid value for portRange. Must specify both from and to ports with TCP/UDP.");
        for (let range = 1; form[`${prefix}.IpRanges.${range}.CidrIp`] !== undefined; range++) {
          added.push({ protocol, from, to, cidr: form[`${prefix}.IpRanges.${range}.CidrIp`]!, description: form[`${prefix}.IpRanges.${range}.Description`] ?? "" });
        }
        for (let range = 1; form[`${prefix}.Ipv6Ranges.${range}.CidrIpv6`] !== undefined; range++) {
          added.push({ protocol, from, to, cidr: form[`${prefix}.Ipv6Ranges.${range}.CidrIpv6`]!, description: form[`${prefix}.Ipv6Ranges.${range}.Description`] ?? "" });
        }
      }
      for (const rule of added) {
        const same = (other: FakeRule) => other.protocol === rule.protocol && other.from === rule.from && other.to === rule.to && other.cidr === rule.cidr;
        if (target.rules.some(same)) throw new ApiError(400, "InvalidPermission.Duplicate", `the specified rule "peer: ${rule.cidr}, ${rule.protocol.toUpperCase()}, from port: ${rule.from}, to port: ${rule.to}, ALLOW" already exists`);
      }
      target.rules.push(...added);
      return answer(
        "AuthorizeSecurityGroupIngress",
        `${el("return", true)}${set("securityGroupRuleSet", added.map((rule) => `${el("securityGroupRuleId", `sgr-${hex(next())}`)}${el("groupId", target.id)}${el("isEgress", false)}${el("ipProtocol", rule.protocol)}${el("fromPort", rule.from)}${el("toPort", rule.to)}${el(rule.cidr.includes(":") ? "cidrIpv6" : "cidrIpv4", rule.cidr)}`))}`,
      );
    },

    DeleteSecurityGroup(state, form) {
      const target = group(state, form.GroupId ?? "");
      const users = state.instances.filter((instance) => instance.state !== "terminated" && instance.groupIds.includes(target.id));
      if (users.length > 0 || target.heldFor > 0) {
        if (users.length === 0) target.heldFor--;
        throw new ApiError(400, "DependencyViolation", `resource ${target.id} has a dependent object`);
      }
      state.groups.splice(state.groups.indexOf(target), 1);
      return answer("DeleteSecurityGroup", `${el("return", true)}${el("groupId", target.id)}`);
    },

    DescribeAddresses(state, form) {
      if (form.MaxResults !== undefined) throw new ApiError(400, "UnknownParameter", "The parameter MaxResults is not recognized");
      const ids = listOf(form, "AllocationId");
      for (const id of ids) if (!state.addresses.some((address) => address.allocationId === id)) throw new ApiError(400, "InvalidAllocationID.NotFound", `The allocation ID '${id}' does not exist`);
      const shown = state.addresses.filter(
        (address) =>
          (ids.length === 0 || ids.includes(address.allocationId)) &&
          passes(
            filtersOf(form),
            (name) => ({ "allocation-id": [address.allocationId], "instance-id": [address.instanceId], "public-ip": [address.publicIp], "association-id": [address.associationId], domain: ["vpc"] })[name] ?? null,
            address.tags,
          ),
      );
      return answer("DescribeAddresses", set("addressesSet", shown.map(addressView)));
    },

    AllocateAddress(state, form) {
      if (form.Domain !== undefined && form.Domain !== "vpc" && form.Domain !== "standard") throw new ApiError(400, "InvalidParameterValue", `Invalid value '${form.Domain}' for domain`);
      if (state.addresses.length >= settings.addressLimit) throw new ApiError(400, "AddressLimitExceeded", "The maximum number of addresses has been reached.");
      const address: FakeAddress = { allocationId: `eipalloc-${hex(next())}`, publicIp: `203.0.113.${addressNumber++}`, tags: tagsFrom(form, "elastic-ip"), instanceId: null, associationId: null };
      state.addresses.push(address);
      return answer("AllocateAddress", `${el("publicIp", address.publicIp)}${el("domain", "vpc")}${el("allocationId", address.allocationId)}${el("networkBorderGroup", "eu-central-1")}`);
    },

    AssociateAddress(state, form) {
      const address = state.addresses.find((candidate) => candidate.allocationId === form.AllocationId);
      if (address === undefined) throw new ApiError(400, "InvalidAllocationID.NotFound", `The allocation ID '${form.AllocationId}' does not exist`);
      const instance = visibleInstance(state, form.InstanceId ?? "");
      if (instance.state !== "running" && instance.state !== "stopped") throw new ApiError(400, "IncorrectInstanceState", `The ${instance.state} instance '${instance.id}' is not in a valid state for this operation.`);
      if (address.instanceId !== null && address.instanceId !== instance.id && form.AllowReassociation === "false") {
        throw new ApiError(400, "Resource.AlreadyAssociated", `resource ${address.allocationId} is already associated with associate-id ${address.associationId}`);
      }
      // An instance holds one: the address it had goes back to its pool.
      for (const other of state.addresses.filter((candidate) => candidate.instanceId === instance.id)) Object.assign(other, { instanceId: null, associationId: null });
      address.instanceId = instance.id;
      address.associationId = `eipassoc-${hex(next())}`;
      instance.publicIp = address.publicIp;
      return answer("AssociateAddress", `${el("return", true)}${el("associationId", address.associationId)}`);
    },

    ReleaseAddress(state, form) {
      const index = state.addresses.findIndex((candidate) => candidate.allocationId === form.AllocationId);
      if (index === -1) throw new ApiError(400, "InvalidAllocationID.NotFound", `The allocation ID '${form.AllocationId}' does not exist`);
      const address = state.addresses[index]!;
      // In the default VPC, releasing disassociates.
      const holder = state.instances.find((instance) => instance.id === address.instanceId);
      if (holder !== undefined) holder.publicIp = null;
      state.addresses.splice(index, 1);
      return answer("ReleaseAddress", el("return", true));
    },

    RunInstances(state, form) {
      if (form.MinCount !== "1" || form.MaxCount !== "1") throw new ApiError(400, "InvalidParameterValue", "the fake launches one instance at a time");
      const order = JSON.stringify(Object.entries(form).filter(([name]) => name !== "ClientToken" && name !== "Action" && name !== "Version").sort());
      const token = form.ClientToken ?? `token-${hex(next())}`;
      const again = state.instances.find((instance) => instance.clientToken === token);
      if (again !== undefined) {
        if (again.order !== order) throw new ApiError(400, "IdempotentParameterMismatch", "The client token you have provided is associated with a resource that is already deleted or has different parameters");
        return answer("RunInstances", `${el("reservationId", `r-${again.id.slice(2)}`)}${el("ownerId", "123456789012")}<groupSet/>${set("instancesSet", [instanceView(state, again)])}`);
      }
      const image = state.images.find((candidate) => candidate.id === form.ImageId);
      if (image === undefined) throw new ApiError(400, "InvalidAMIID.NotFound", `The image id '[${form.ImageId}]' does not exist`);
      const type = INSTANCE_TYPES[form.InstanceType ?? ""];
      if (type === undefined) throw new ApiError(400, "InvalidParameterValue", `Invalid value '${form.InstanceType}' for InstanceType.`);
      if (type.architecture !== image.architecture) {
        throw new ApiError(400, "InvalidParameterValue", `The architecture '${type.architecture}' of the specified instance type does not match the architecture '${image.architecture}' of the specified AMI.`);
      }
      const subnet = form.SubnetId === undefined ? state.subnets.find((candidate) => candidate.defaultForAz) : state.subnets.find((candidate) => candidate.id === form.SubnetId);
      if (subnet === undefined) throw new ApiError(400, form.SubnetId === undefined ? "VPCIdNotSpecified" : "InvalidSubnetID.NotFound", form.SubnetId === undefined ? "No default VPC for this user" : `The subnet ID '${form.SubnetId}' does not exist`);
      if (!(state.offerings[form.InstanceType!] ?? []).includes(subnet.zone)) {
        throw new ApiError(400, "Unsupported", `Your requested instance type (${form.InstanceType}) is not supported in your requested Availability Zone (${subnet.zone}).`);
      }
      if (settings.freePlan && type.free !== true) {
        throw new ApiError(400, "InvalidParameterCombination", "The specified instance type is not eligible for Free Tier. For a list of Free Tier instance types, run 'describe-instance-types' with the filter 'free-tier-eligible=true'.");
      }
      const pair = state.keyPairs.find((candidate) => candidate.name === form.KeyName);
      if (form.KeyName !== undefined && (pair === undefined || (pair.invisibleFor ?? 0) > 0)) {
        if (pair !== undefined) pair.invisibleFor = (pair.invisibleFor ?? 0) - 1;
        throw new ApiError(400, "InvalidKeyPair.NotFound", `The key pair '${form.KeyName}' does not exist`);
      }
      const groupIds = listOf(form, "SecurityGroupId");
      for (const id of groupIds) {
        const found = group(state, id);
        if ((found.invisibleToRunFor ?? 0) > 0) {
          found.invisibleToRunFor = (found.invisibleToRunFor ?? 0) - 1;
          throw new ApiError(400, "InvalidGroup.NotFound", `The security group '${id}' does not exist in VPC '${subnet.vpcId}'`);
        }
        if (found.vpcId !== subnet.vpcId) throw new ApiError(400, "InvalidParameter", "Security group and subnet belong to different networks.");
      }
      const id = `i-${hex(next())}`;
      const device = form["BlockDeviceMapping.1.DeviceName"];
      const volume: FakeVolume = {
        id: `vol-${hex(next())}`,
        size: device === image.rootDevice ? Number(form["BlockDeviceMapping.1.Ebs.VolumeSize"] ?? "8") : 8,
        type: device === image.rootDevice ? (form["BlockDeviceMapping.1.Ebs.VolumeType"] ?? "gp2") : "gp2",
        deleteOnTermination: device === image.rootDevice ? form["BlockDeviceMapping.1.Ebs.DeleteOnTermination"] !== "false" : true,
        encrypted: device === image.rootDevice && form["BlockDeviceMapping.1.Ebs.Encrypted"] === "true",
        status: "in-use",
        tags: tagsFrom(form, "volume"),
        instanceId: id,
        device: image.rootDevice,
      };
      state.volumes.push(volume);
      const metadata: Record<string, string> = {};
      for (const [name, value] of Object.entries(form)) if (name.startsWith("MetadataOptions.")) metadata[name.slice("MetadataOptions.".length)] = value;
      const number = state.instances.length + 10;
      const instance: FakeInstance = {
        id,
        type: form.InstanceType!,
        imageId: image.id,
        architecture: image.architecture,
        state: "pending",
        polls: 0,
        invisibleFor: settings.instanceInvisible,
        zone: subnet.zone,
        subnetId: subnet.id,
        vpcId: subnet.vpcId,
        keyName: form.KeyName ?? null,
        groupIds,
        tags: tagsFrom(form, "instance"),
        privateIp: `172.31.0.${number}`,
        // A default subnet gives an address of its own, which an elastic IP replaces.
        publicIp: `198.51.100.${number}`,
        ipv6: subnet.ipv6 ? `2001:db8:1::${number}` : null,
        volumeIds: [volume.id],
        rootDevice: image.rootDevice,
        metadata,
        clientToken: token,
        order,
        stateReason: null,
      };
      state.instances.push(instance);
      return answer("RunInstances", `${el("reservationId", `r-${id.slice(2)}`)}${el("ownerId", "123456789012")}<groupSet/>${set("instancesSet", [instanceView(state, instance)])}`);
    },

    TerminateInstances(state, form) {
      const ids = listOf(form, "InstanceId");
      const chosen = ids.map((id) => visibleInstance(state, id));
      const changes = chosen.map((instance) => {
        const previous = instance.state;
        if (instance.state !== "terminated" && instance.state !== "shutting-down") {
          instance.state = "shutting-down";
          instance.polls = 0;
        }
        return `${el("instanceId", instance.id)}<currentState>${el("code", STATE_CODES[instance.state])}${el("name", instance.state)}</currentState><previousState>${el("code", STATE_CODES[previous])}${el("name", previous)}</previousState>`;
      });
      return answer("TerminateInstances", set("instancesSet", changes));
    },

    DescribeVolumes(state, form) {
      const ids = listOf(form, "VolumeId");
      for (const id of ids) if (!state.volumes.some((volume) => volume.id === id)) throw new ApiError(400, "InvalidVolume.NotFound", `The volume '${id}' does not exist.`);
      const shown = state.volumes.filter((volume) => (ids.length === 0 || ids.includes(volume.id)) && passes(filtersOf(form), (name) => ({ "volume-id": [volume.id], status: [volume.status] })[name] ?? null, volume.tags));
      const { page, token } = paginate(form, shown, ids.length > 0 ? null : [5, 500]);
      const entries = page.map(
        (volume) =>
          `${el("volumeId", volume.id)}${el("size", volume.size)}<snapshotId/>${el("availabilityZone", "eu-central-1a")}${el("status", volume.status)}${el("createTime", "2026-10-21T10:00:00.000Z")}${set("attachmentSet", volume.instanceId === null ? [] : [`${el("volumeId", volume.id)}${el("instanceId", volume.instanceId)}${el("device", volume.device)}${el("status", "attached")}${el("deleteOnTermination", volume.deleteOnTermination)}`])}${el("volumeType", volume.type)}${el("encrypted", volume.encrypted)}${tagSet(volume.tags)}`,
      );
      return answer("DescribeVolumes", `${set("volumeSet", entries)}${tokenElement(token)}`);
    },
  };

  /** Checks the request's signature as AWS does, with the fake's copy of the secret. */
  function authenticate(request: Request, body: string): { region: string } {
    const auth = parseAuthorization(request.headers.get("authorization"));
    if (auth === null) throw new ApiError(401, "MissingAuthenticationToken", "Request is missing Authentication Token");
    if (auth.accessKeyId !== settings.accessKey) throw new ApiError(401, "AuthFailure", "AWS was not able to validate the provided access credentials");
    if (auth.service !== "ec2") throw new ApiError(401, "SignatureDoesNotMatch", "Credential should be scoped to correct service: 'ec2'");
    const date = request.headers.get("x-amz-date") ?? "";
    if (!auth.scope.startsWith(date.slice(0, 8)) || date.length !== 16) throw new ApiError(401, "SignatureDoesNotMatch", "Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP");
    for (const required of ["host", "x-amz-date", "content-type"]) {
      if (!auth.signedHeaders.includes(required)) throw new ApiError(401, "SignatureDoesNotMatch", `'${required}' must be a signed header`);
    }
    if (settings.sessionToken !== null && (request.headers.get("x-amz-security-token") !== settings.sessionToken || !auth.signedHeaders.includes("x-amz-security-token"))) {
      throw new ApiError(401, "AuthFailure", "AWS was not able to validate the provided access credentials");
    }
    const headers: Record<string, string> = {};
    for (const name of auth.signedHeaders) if (name !== "host") headers[name] = request.headers.get(name) ?? "";
    const parts = signingParts({ method: request.method, url: request.url, headers, body, region: auth.region, service: "ec2", credentials: { accessKeyId: auth.accessKeyId, secretAccessKey: settings.secretKey }, now: 0 }, date);
    if (parts.signedHeaders !== auth.signedHeaders.join(";") || signature(settings.secretKey, parts.scope, parts.stringToSign) !== auth.signature) {
      throw new ApiError(401, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.");
    }
    return { region: auth.region };
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = Object.fromEntries(new URLSearchParams(text));
    const headers = Object.fromEntries([...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]));
    const received: Received = { method: request.method, path: url.pathname, search: url.search, url: request.url, body, headers, action: body.Action ?? "", region: "" };
    requests.push(received);
    try {
      if (request.method !== "POST") throw new ApiError(400, "InvalidAction", "the fake takes POST requests only");
      const { region: regionName } = authenticate(request, text);
      received.region = regionName;
      const state = regionOf(regionName);
      if (body.Version !== "2016-11-15") throw new ApiError(400, "NoSuchVersion", `An invalid or out-of-range value '${body.Version}' was supplied for the parameter Version`);
      const failure = failures.find((candidate) => candidate.times > 0 && candidate.action === received.action && (candidate.region === null || candidate.region === regionName) && candidate.match(body));
      if (failure !== undefined) {
        failure.times--;
        return errorResponse(failure.status, failure.code, failure.message, failure.headers);
      }
      const action = actions[received.action];
      if (action === undefined) throw new ApiError(400, "InvalidAction", `The action ${received.action} is not valid for this web service.`);
      return action(state, body, regionName);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message);
      throw error;
    }
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}`;

  return {
    url,
    regions,
    requests,
    settings,
    environment: { [`AWS_ACCESS_KEY_ID`]: FAKE_ACCESS_KEY, [`AWS_SECRET_ACCESS_KEY`]: FAKE_SECRET_KEY, SITESOLIDE_AWS_API: url } as Record<string, string>,
    secrets: [FAKE_ACCESS_KEY, FAKE_SECRET_KEY],
    region(name: string): FakeRegion {
      const found = regions.get(name);
      if (found === undefined) throw new Error(`the fake has no region ${name}`);
      return found;
    },
    /** The next `times` requests for that action, in that region, whose parameters match, answer this error instead. */
    fail(action: string, status: number, code: string, message: string, extra: { times?: number; region?: string; headers?: Record<string, string>; match?: (body: Record<string, string>) => boolean } = {}): void {
      failures.push({ action, status, code, message, times: extra.times ?? 1, region: extra.region ?? null, headers: extra.headers ?? {}, match: extra.match ?? (() => true) });
    },
    /** An instance that exists before the test, ours or not, running. */
    addInstance(regionName: string, input: Partial<FakeInstance> & { tags: Tags }): FakeInstance {
      const state = this.region(regionName);
      const subnet = state.subnets[0]!;
      const number = state.instances.length + 50;
      const instance: FakeInstance = {
        id: `i-${hex(next())}`,
        type: "t3.small",
        imageId: state.images[1]!.id,
        architecture: "x86_64",
        state: "running",
        polls: 0,
        invisibleFor: 0,
        zone: subnet.zone,
        subnetId: subnet.id,
        vpcId: subnet.vpcId,
        keyName: null,
        groupIds: [],
        privateIp: `172.31.1.${number}`,
        publicIp: `198.51.100.${number}`,
        ipv6: null,
        volumeIds: [],
        rootDevice: "/dev/xvda",
        metadata: {},
        clientToken: `preexisting-${hex(next())}`,
        order: "",
        stateReason: null,
        ...input,
      };
      state.instances.push(instance);
      return instance;
    },
    /** A volume a person attached to an instance, deleted with it or not. */
    addVolume(regionName: string, instanceId: string, input: { device: string; deleteOnTermination: boolean; size?: number }): FakeVolume {
      const state = this.region(regionName);
      const volume: FakeVolume = { id: `vol-${hex(next())}`, size: input.size ?? 100, type: "gp3", deleteOnTermination: input.deleteOnTermination, encrypted: false, status: "in-use", tags: {}, instanceId, device: input.device };
      state.volumes.push(volume);
      state.instances.find((instance) => instance.id === instanceId)?.volumeIds.push(volume.id);
      return volume;
    },
    addKeyPair(regionName: string, input: { name: string; publicKey: string; tags?: Tags }): FakeKeyPair {
      const [algorithm = "", blob = ""] = input.publicKey.split(/\s+/);
      const raw = Buffer.from(blob, "base64");
      const pair: FakeKeyPair = {
        id: `key-${hex(next())}`,
        name: input.name,
        type: algorithm === "ssh-rsa" ? "rsa" : "ed25519",
        fingerprint: algorithm === "ssh-rsa" ? md5Fingerprint(raw) : new Bun.CryptoHasher("sha256").update(raw).digest("base64"),
        publicKey: `${algorithm} ${blob}`,
        tags: input.tags ?? {},
      };
      this.region(regionName).keyPairs.push(pair);
      return pair;
    },
    addGroup(regionName: string, input: { name: string; tags?: Tags; rules?: FakeRule[] }): FakeGroup {
      const state = this.region(regionName);
      const created: FakeGroup = { id: `sg-${hex(next())}`, name: input.name, description: "added by a test", vpcId: state.vpcs[0]!.id, tags: input.tags ?? {}, rules: input.rules ?? [], invisibleFor: 0, heldFor: 0 };
      state.groups.push(created);
      return created;
    },
    addAddress(regionName: string, input: { tags?: Tags; instanceId?: string }): FakeAddress {
      const state = this.region(regionName);
      const address: FakeAddress = { allocationId: `eipalloc-${hex(next())}`, publicIp: `203.0.113.${addressNumber++}`, tags: input.tags ?? {}, instanceId: null, associationId: null };
      if (input.instanceId !== undefined) {
        address.instanceId = input.instanceId;
        address.associationId = `eipassoc-${hex(next())}`;
        const holder = state.instances.find((instance) => instance.id === input.instanceId);
        if (holder !== undefined) holder.publicIp = address.publicIp;
      }
      state.addresses.push(address);
      return address;
    },
    /** The failures still to come are forgotten: AWS is well again. */
    heal(): void {
      failures.length = 0;
    },
    /** The write actions received, in order: what a test of "nothing written" reads. */
    writes(): Received[] {
      return requests.filter((request) => !/^Describe/.test(request.action));
    },
    reset(): void {
      seed();
      addressNumber = 10;
      requests.length = 0;
      failures.length = 0;
      Object.assign(settings, {
        pageSize: options.pageSize ?? 2,
        emptyFirstPage: false,
        runningPolls: 2,
        terminatePolls: 2,
        instanceInvisible: 0,
        groupInvisible: 0,
        groupHeld: 1,
        keyInvisible: 0,
        groupInvisibleAtRun: 0,
        freePlan: false,
        addressLimit: 5,
        sessionToken: null,
        accessKey: FAKE_ACCESS_KEY,
        secretKey: FAKE_SECRET_KEY,
      });
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as the shared test of every provider takes it. */
export function createFake(): FakeProvider {
  return createFakeAws();
}
