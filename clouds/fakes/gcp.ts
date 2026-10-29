/**
 * A local stand-in for Google Cloud's Compute Engine API v1 and its OAuth
 * token endpoint, on a random port of the loopback: the tests of the gcp
 * provider never reach the real ones.
 *
 * It keeps a project in memory (zones, machine types, the default network and
 * its four pre-populated firewall rules, addresses, instances, operations)
 * and answers the calls clouds/src/gcp.ts makes, in the shapes of
 * https://cloud.google.com/compute/docs/reference/rest/v1: errors as
 * `{"error": {"code", "message", "errors": [{"domain", "reason", "message"}]}}`,
 * `items` and `nextPageToken` on every list, `items` keyed by scope on an
 * aggregated list, operations that stay PENDING then RUNNING for a few polls
 * before they are DONE, with or without an error. A resource appears or goes
 * when its operation is done, as the real API settles it; an instance shows
 * up at once, PROVISIONING, and is gone again if its operation fails.
 *
 * Address labels are ignored on insert by default: the reference says they
 * are set through setLabels, which the provider must then call. A firewall
 * rule that mixes IPv4 and IPv6 sources is refused, as Google refuses it; so
 * is nested virtualization outside the Intel series it is documented on.
 *
 * Lists come back `pageSize` items a page whatever `maxResults` asks, two by
 * default, so that a client that reads only the first page fails a test.
 * `fail()` makes the next matching request answer an error instead;
 * `settings.failOperation` makes an operation end in error.
 *
 * The token endpoint checks the JWT a service account presents as Google
 * does: RS256 under the key `serviceAccount()` generated, the compute scope,
 * the endpoint as audience, an hour at most.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

export const FAKE_PROJECT = "sitesolide-test";
export const FAKE_TOKEN = "ya29.fake-gcp-access-token-0123456789abcdef0123456789abcdef0123456789";
export const FAKE_EXCHANGED = "ya29.fake-gcp-exchanged-token-fedcba9876543210fedcba9876543210fedcba";
export const FAKE_EMAIL = `sitesolide@${FAKE_PROJECT}.iam.gserviceaccount.com`;
export const SCOPE = "https://www.googleapis.com/auth/compute";

/** Where the real API writes its URLs: selfLinks name it, whatever host answered. */
const LINK = "https://www.googleapis.com/compute/v1";

type Labels = Record<string, string>;
type Json = Record<string, unknown>;

const zone = (name: string, status = "UP", deprecated?: string) => {
  const region = name.replace(/-[a-z0-9]+$/, "");
  return {
    kind: "compute#zone",
    id: String(2000 + name.length * 7 + name.charCodeAt(name.length - 1)),
    creationTimestamp: "1969-12-31T16:00:00.000-08:00",
    name,
    description: name,
    status,
    region: `${LINK}/projects/${FAKE_PROJECT}/regions/${region}`,
    selfLink: `${LINK}/projects/${FAKE_PROJECT}/zones/${name}`,
    availableCpuPlatforms: ["Intel Cascade Lake", "AMD Milan"],
    supportsPzs: false,
    ...(deprecated === undefined ? {} : { deprecated: { state: deprecated } }),
  };
};

/** Close enough to the real list to read like it: the default region first, a zone down, an AI zone, a deprecated one. */
export const ZONES = [
  ...["a", "b", "c"].map((letter) => zone(`europe-west4-${letter}`)),
  ...["a", "b", "c"].map((letter) => zone(`europe-west3-${letter}`)),
  zone("europe-west9-a"),
  zone("europe-west9-b"),
  zone("europe-west9-c", "DOWN"),
  ...["b", "c", "d"].map((letter) => zone(`europe-west1-${letter}`)),
  ...["a", "b", "c", "f"].map((letter) => zone(`us-central1-${letter}`)),
  zone("us-west4-a"),
  zone("us-west4-ai2b"),
  zone("asia-east1-a", "UP", "DEPRECATED"),
];

const type = (name: string, guestCpus: number, memoryMb: number, extra: Json = {}) => ({
  kind: "compute#machineType",
  id: String(3000 + name.length * 13 + guestCpus),
  creationTimestamp: "1969-12-31T16:00:00.000-08:00",
  name,
  description: `${guestCpus} vCPUs ${memoryMb / 1024} GB RAM`,
  guestCpus,
  memoryMb,
  imageSpaceGb: 0,
  maximumPersistentDisks: 128,
  maximumPersistentDisksSizeGb: "263168",
  isSharedCpu: false,
  architecture: "X86_64",
  ...extra,
});

export const MACHINE_TYPES = [
  type("e2-micro", 2, 1024, { isSharedCpu: true, description: "Efficient Instance, 2 vCPU (1/8 shared physical core) and 1 GB RAM" }),
  type("e2-small", 2, 2048, { isSharedCpu: true, description: "Efficient Instance, 2 vCPU (1/4 shared physical core) and 2 GB RAM" }),
  type("e2-medium", 2, 4096, { isSharedCpu: true, description: "Efficient Instance, 2 vCPU (1/2 shared physical core) and 4 GB RAM" }),
  type("e2-standard-2", 2, 8192),
  type("e2-standard-4", 4, 16384),
  type("e2-standard-8", 8, 32768),
  type("e2-standard-16", 16, 65536),
  type("e2-highmem-2", 2, 16384),
  type("n4-standard-2", 2, 8192),
  type("n4-standard-4", 4, 16384),
  type("n4d-standard-2", 2, 8192),
  type("c4-standard-2", 2, 7680),
  type("c4a-standard-1", 1, 4096, { architecture: "ARM64" }),
  type("n2-standard-2", 2, 8192),
  type("n2d-standard-2", 2, 8192),
  type("n2d-standard-4", 4, 16384, { deprecated: { state: "DEPRECATED" } }),
  type("n1-standard-1", 1, 3840),
  type("f1-micro", 1, 614, { isSharedCpu: true }),
];

/** The types each zone sells: all of them, but c4 only in the default region. */
function typesOf(zoneName: string) {
  return MACHINE_TYPES.filter((item) => !item.name.startsWith("c4-") || zoneName.startsWith("europe-west4-")).map((item) => ({ ...item, zone: zoneName, selfLink: `${LINK}/projects/${FAKE_PROJECT}/zones/${zoneName}/machineTypes/${item.name}` }));
}

const image = (project: string, name: string, family: string, architecture: string) => ({
  kind: "compute#image",
  id: String(4000 + name.length),
  project,
  name,
  family,
  architecture,
  status: "READY",
  sourceType: "RAW",
  diskSizeGb: "10",
  selfLink: `${LINK}/projects/${project}/global/images/${name}`,
});

export const IMAGES = [
  image("debian-cloud", "debian-13-trixie-v20261014", "debian-13", "X86_64"),
  image("debian-cloud", "debian-13-trixie-arm64-v20261014", "debian-13-arm64", "ARM64"),
  image("debian-cloud", "debian-12-bookworm-v20261014", "debian-12", "X86_64"),
  image("ubuntu-os-cloud", "ubuntu-2404-noble-amd64-v20261015", "ubuntu-2404-lts-amd64", "X86_64"),
  image("ubuntu-os-cloud", "ubuntu-2404-noble-arm64-v20261015", "ubuntu-2404-lts-arm64", "ARM64"),
];

/** An image by its path: `projects/<project>/global/images/<name>`, or `.../family/<family>`, its latest. */
const IMAGE_PATH = /^\/?projects\/([a-z0-9.:-]+)\/global\/images\/(family\/)?([a-z0-9-]+)$/;
function imageAt(path: string) {
  const match = IMAGE_PATH.exec(path);
  if (match === null) return undefined;
  return IMAGES.find((candidate) => candidate.project === match[1] && (match[2] === undefined ? candidate.name : candidate.family) === match[3]);
}

const HYPERDISK_ONLY = ["n4", "n4d", "n4a", "c4", "c4a", "c4d"];
const DISK_TYPES = ["pd-standard", "pd-balanced", "pd-ssd", "pd-extreme", "hyperdisk-balanced", "hyperdisk-extreme", "hyperdisk-throughput"];
/** The series the fake nests virtualization on: the Intel ones Google documents it for. */
const NESTING = ["n1", "n2", "c2", "c3"];

export type FakeFirewall = Json & { id: string; name: string; description?: string; network: string; targetTags?: string[]; priority: number };
export type FakeAddress = Json & {
  id: string;
  name: string;
  region: string;
  address: string;
  status: "RESERVING" | "RESERVED" | "IN_USE";
  description?: string;
  labels: Labels;
  labelFingerprint: string;
  users: string[];
  networkTier: string;
};
export type FakeInstance = {
  id: string;
  name: string;
  zone: string;
  status: string;
  machineType: string;
  labels: Labels;
  tags: string[];
  metadata: { key: string; value: string }[];
  natIP: string | null;
  networkTier: string;
  network: string;
  subnetwork: string | null;
  disk: { sourceImage: string; diskType: string; diskSizeGb: string; autoDelete: boolean; labels: Labels };
  nestedVirtualization?: boolean;
  description?: string;
  stagingReads: number;
  /** Disks a person attached besides the boot disk. */
  extraDisks?: { name: string; autoDelete: boolean }[];
};
type FakeOperation = {
  view: Json & { name: string; status: string };
  polls: number;
  /** What the operation does once done; returns an error to end it with instead. */
  apply: () => { code: string; message: string } | null;
};
type Injected = { method: string; path: RegExp; status: number; reason: string; message: string; headers?: Record<string, string>; times: number; extra?: Json };

/** Google's error body. */
export function googleError(status: number, reason: string, message: string, headers: Record<string, string> = {}, extra: Json = {}): Response {
  const named: Record<number, string> = { 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 429: "RESOURCE_EXHAUSTED" };
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: reason === "accessNotConfigured" || reason === "rateLimitExceeded" ? "usageLimits" : "global", reason }],
        ...(named[status] === undefined ? {} : { status: named[status] }),
        ...extra,
      },
    },
    { status, headers },
  );
}

const NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

export type FakeGcp = ReturnType<typeof createFakeGcp>;

/** The fake as bin/tests/cli-machine-providers.test.ts takes it. */
export function createFake(): FakeProvider {
  return createFakeGcp();
}

export function createFakeGcp(options: { pageSize?: number; operationPolls?: number } = {}) {
  let nextId = 5_000_000_000_000_000;
  let nextAddress = 10;
  const firewalls: FakeFirewall[] = [];
  const addresses: FakeAddress[] = [];
  const instances: FakeInstance[] = [];
  const operations = new Map<string, FakeOperation>();
  const requests: (FakeRequest & { url: string })[] = [];
  const failures: Injected[] = [];
  const secrets: string[] = [FAKE_TOKEN, FAKE_EXCHANGED];
  let serviceKey: { publicKey: CryptoKey; privateKey: string; keyFile: string } | null = null;
  /** What the token endpoint gave out, which the API then takes. */
  let exchangedIssued = false;

  const settings: {
    pageSize: number;
    operationPolls: number;
    labelsAtInsert: boolean;
    network: "auto" | "custom" | "none";
    failOperation: { operationType: string; target: RegExp; code: string; message: string } | null;
    /** Reads of an instance STAGING before it is RUNNING. */
    stagingReads: number;
  } = {
    pageSize: options.pageSize ?? 2,
    operationPolls: options.operationPolls ?? 2,
    labelsAtInsert: false,
    network: "auto",
    failOperation: null,
    stagingReads: 1,
  };

  const projectLink = `${LINK}/projects/${FAKE_PROJECT}`;
  const networkLink = `${projectLink}/global/networks/default`;
  const regions = [...new Set(ZONES.map((item) => item.region.split("/").pop()!))];

  const prepopulated = (): FakeFirewall[] => [
    { name: "default-allow-internal", sourceRanges: ["10.128.0.0/9"], allowed: [{ IPProtocol: "tcp", ports: ["0-65535"] }, { IPProtocol: "udp", ports: ["0-65535"] }, { IPProtocol: "icmp" }] },
    { name: "default-allow-ssh", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["22"] }] },
    { name: "default-allow-rdp", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "tcp", ports: ["3389"] }] },
    { name: "default-allow-icmp", sourceRanges: ["0.0.0.0/0"], allowed: [{ IPProtocol: "icmp" }] },
  ].map((rule) => ({
    kind: "compute#firewall",
    id: String(nextId++),
    creationTimestamp: "2026-10-01T10:00:00.000-07:00",
    description: rule.name === "default-allow-internal" ? "Allow internal traffic on the default network" : `Allow ${rule.name.slice(14)} from anywhere`,
    network: networkLink,
    priority: 65534,
    direction: "INGRESS",
    disabled: false,
    selfLink: `${projectLink}/global/firewalls/${rule.name}`,
    ...rule,
  }));
  firewalls.push(...prepopulated());

  const fingerprint = (labels: Labels) => base64url(new Bun.CryptoHasher("sha256").update(JSON.stringify(labels)).digest()).slice(0, 11) + "=";

  const page = (url: URL, items: unknown[], key = "items", group?: (item: unknown) => string, scopes: string[] = []): Response => {
    const wanted = Math.max(1, Number(url.searchParams.get("maxResults") ?? "500"));
    const size = Math.min(wanted, settings.pageSize);
    const token = url.searchParams.get("pageToken");
    const start = token === null ? 0 : Number(Buffer.from(token, "base64url").toString());
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? base64url(String(start + size)) : undefined;
    let body: Json;
    if (group === undefined) {
      body = slice.length === 0 ? {} : { items: slice };
    } else {
      // An aggregated list: every scope present, with its items or a warning.
      const map: Record<string, Json> = {};
      for (const scope of scopes) map[scope] = { warning: { code: "NO_RESULTS_ON_PAGE", message: `There are no results for scope '${scope}' on this page.`, data: [{ key: "scope", value: scope }] } };
      for (const item of slice) {
        const scope = group(item);
        const current = map[scope]?.[key];
        map[scope] = { [key]: [...(Array.isArray(current) ? current : []), item] };
      }
      body = { items: map };
    }
    return Response.json({ kind: "compute#list", id: `projects/${FAKE_PROJECT}`, ...body, ...(next === undefined ? {} : { nextPageToken: next }), selfLink: `${LINK}${url.pathname.replace(/^\/compute\/v1/, "")}` });
  };

  /** `name = x` and `name != x`, the AIP-160 the provider uses; anything else is refused, so that a filter the real API might not take shows here. */
  const filterBy = (filter: string | null): ((name: string) => boolean) | Response => {
    if (filter === null) return () => true;
    const match = /^name (=|!=) ([a-z0-9-]+)$/.exec(filter);
    if (match === null) return googleError(400, "invalid", `Invalid value for field 'filter': '${filter}'. Invalid list filter expression.`);
    return match[1] === "=" ? (name) => name === match[2] : (name) => name !== match[2];
  };

  const operation = (scope: { zone?: string; region?: string }, operationType: string, targetLink: string, targetId: string, apply: FakeOperation["apply"]): Json => {
    const name = `operation-${nextId++}-fake`;
    const where = scope.zone !== undefined ? `/zones/${scope.zone}` : scope.region !== undefined ? `/regions/${scope.region}` : "/global";
    const view = {
      kind: "compute#operation",
      id: String(nextId++),
      name,
      operationType,
      targetLink,
      targetId,
      status: "PENDING",
      user: FAKE_EMAIL,
      progress: 0,
      insertTime: "2026-10-21T10:00:00.000-07:00",
      selfLink: `${projectLink}${where}/operations/${name}`,
      ...(scope.zone === undefined ? {} : { zone: `${projectLink}/zones/${scope.zone}` }),
      ...(scope.region === undefined ? {} : { region: `${projectLink}/regions/${scope.region}` }),
    };
    operations.set(name, { view, polls: 0, apply });
    return view;
  };

  const advance = (item: FakeOperation): void => {
    if (item.view.status === "DONE") return;
    item.polls++;
    if (item.polls < settings.operationPolls) {
      item.view.status = "RUNNING";
      item.view.progress = Math.round((100 * item.polls) / settings.operationPolls);
      return;
    }
    const failing = settings.failOperation;
    let error: { code: string; message: string } | null = null;
    if (failing !== null && failing.operationType === item.view.operationType && failing.target.test(String(item.view.targetLink))) {
      error = { code: failing.code, message: failing.message };
      // The operation failed: an instance it was creating is not there.
      const index = instances.findIndex((candidate) => instanceLink(candidate) === item.view.targetLink);
      if (index !== -1 && item.view.operationType === "insert") release(instances.splice(index, 1)[0]!);
    } else {
      error = item.apply();
    }
    Object.assign(item.view, {
      status: "DONE",
      progress: 100,
      endTime: "2026-10-21T10:00:30.000-07:00",
      ...(error === null ? {} : { error: { errors: [error] }, httpErrorStatusCode: 400, httpErrorMessage: "BAD REQUEST" }),
    });
  };

  /** Frees the address an instance held. */
  const release = (instance: FakeInstance): void => {
    for (const address of addresses) {
      address.users = address.users.filter((user) => user !== instanceLink(instance));
      if (address.users.length === 0 && address.status === "IN_USE") address.status = "RESERVED";
    }
  };

  const instanceLink = (instance: { zone: string; name: string }) => `${projectLink}/zones/${instance.zone}/instances/${instance.name}`;

  const instanceView = (instance: FakeInstance) => ({
    kind: "compute#instance",
    id: instance.id,
    creationTimestamp: "2026-10-21T10:00:00.000-07:00",
    name: instance.name,
    ...(instance.description === undefined ? {} : { description: instance.description }),
    tags: { items: instance.tags, fingerprint: "42WmSpB8rSM=" },
    machineType: `${projectLink}/zones/${instance.zone}/machineTypes/${instance.machineType}`,
    status: instance.status,
    zone: `${projectLink}/zones/${instance.zone}`,
    canIpForward: false,
    networkInterfaces: [
      {
        kind: "compute#networkInterface",
        network: instance.network,
        ...(instance.subnetwork === null ? {} : { subnetwork: instance.subnetwork }),
        networkIP: "10.164.0.2",
        name: "nic0",
        accessConfigs: instance.natIP === null ? [] : [{ kind: "compute#accessConfig", type: "ONE_TO_ONE_NAT", name: "External NAT", natIP: instance.natIP, networkTier: instance.networkTier }],
        fingerprint: "s2D4mQWkSVQ=",
        stackType: "IPV4_ONLY",
      },
    ],
    disks: [
      {
        kind: "compute#attachedDisk",
        type: "PERSISTENT",
        mode: "READ_WRITE",
        source: `${projectLink}/zones/${instance.zone}/disks/${instance.name}`,
        deviceName: "persistent-disk-0",
        index: 0,
        boot: true,
        autoDelete: instance.disk.autoDelete,
        interface: "SCSI",
        diskSizeGb: instance.disk.diskSizeGb,
      },
      ...(instance.extraDisks ?? []).map((disk, index) => ({
        kind: "compute#attachedDisk",
        type: "PERSISTENT",
        mode: "READ_WRITE",
        source: `${projectLink}/zones/${instance.zone}/disks/${disk.name}`,
        deviceName: disk.name,
        index: index + 1,
        boot: false,
        autoDelete: disk.autoDelete,
        interface: "SCSI",
        diskSizeGb: "100",
      })),
    ],
    metadata: { kind: "compute#metadata", fingerprint: "tZzQh7m5n3o=", items: instance.metadata },
    selfLink: instanceLink(instance),
    scheduling: { onHostMaintenance: "MIGRATE", automaticRestart: true, preemptible: false, provisioningModel: "STANDARD" },
    cpuPlatform: "Intel Broadwell",
    ...(instance.nestedVirtualization === true ? { advancedMachineFeatures: { enableNestedVirtualization: true } } : {}),
    labels: instance.labels,
    labelFingerprint: fingerprint(instance.labels),
    startRestricted: false,
    deletionProtection: false,
  });

  const addressView = (address: FakeAddress) => ({ ...address, kind: "compute#address", addressType: "EXTERNAL", ipVersion: "IPV4", purpose: "GCE_ENDPOINT", creationTimestamp: "2026-10-21T10:00:00.000-07:00", region: `${projectLink}/regions/${address.region}`, selfLink: `${projectLink}/regions/${address.region}/addresses/${address.name}` });

  const networkView = () => {
    if (settings.network === "none") return null;
    const auto = settings.network === "auto";
    return {
      kind: "compute#network",
      id: "6000000000000000001",
      name: "default",
      description: "Default network for the project",
      selfLink: networkLink,
      autoCreateSubnetworks: auto,
      subnetworks: auto ? regions.map((region) => `${projectLink}/regions/${region}/subnetworks/default`) : [`${projectLink}/regions/us-central1/subnetworks/default`],
      routingConfig: { routingMode: "REGIONAL" },
      networkFirewallPolicyEnforcementOrder: "AFTER_CLASSIC_FIREWALL",
    };
  };

  async function handleToken(request: Request, url: URL): Promise<Response> {
    const text = await request.text();
    const form = new URLSearchParams(text);
    requests.push({ method: request.method, path: url.pathname, search: url.search, url: request.url, body: Object.fromEntries(form), headers: Object.fromEntries(request.headers) });
    const refuse = (description: string) => Response.json({ error: "invalid_grant", error_description: description }, { status: 400 });
    if (request.headers.get("content-type") !== "application/x-www-form-urlencoded") return Response.json({ error: "invalid_request", error_description: "Bad Request" }, { status: 400 });
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return Response.json({ error: "unsupported_grant_type", error_description: "Invalid grant_type" }, { status: 400 });
    const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
    if (serviceKey === null) return refuse("Invalid JWT Signature.");
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", serviceKey.publicKey, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
    if (!valid) return refuse("Invalid JWT Signature.");
    const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string; typ?: string };
    const set = JSON.parse(Buffer.from(claims, "base64url").toString()) as { iss?: string; scope?: string; aud?: string; iat?: number; exp?: number };
    if (head.alg !== "RS256" || head.typ !== "JWT") return refuse("Invalid JWT header.");
    if (set.iss !== FAKE_EMAIL) return refuse("Invalid JWT: unknown issuer.");
    if (set.aud !== `${url.origin}${url.pathname}`) return refuse("Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.");
    if (typeof set.iat !== "number" || typeof set.exp !== "number" || set.exp - set.iat > 3600 || set.exp <= set.iat) return refuse("Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.");
    if (set.scope !== SCOPE) return Response.json({ error: "invalid_scope", error_description: "Invalid OAuth scope or ID token audience provided." }, { status: 400 });
    exchangedIssued = true;
    return Response.json({ access_token: FAKE_EXCHANGED, expires_in: 3599, token_type: "Bearer" });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/token") return handleToken(request, url);
    const method = request.method;
    const path = url.pathname.replace(/^\/compute\/v1/, "");
    let body: Json | null = null;
    if (method === "POST") {
      const text = await request.text();
      try {
        body = text === "" ? null : (JSON.parse(text) as Json);
      } catch {
        return googleError(400, "parseError", "This API does not support parsing form-encoded input.");
      }
    }
    requests.push({ method, path, search: url.search, url: request.url, body, headers: Object.fromEntries(request.headers) });

    const authorization = request.headers.get("authorization");
    const accepted = authorization === `Bearer ${FAKE_TOKEN}` || (exchangedIssued && authorization === `Bearer ${FAKE_EXCHANGED}`);
    if (!accepted) {
      return googleError(401, "authError", "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.");
    }
    const injected = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (injected !== undefined) {
      injected.times--;
      return googleError(injected.status, injected.reason, injected.message, injected.headers ?? {}, injected.extra ?? {});
    }

    // --- Google's images, in its image projects
    if (method === "GET" && IMAGE_PATH.test(path)) {
      const found = imageAt(path);
      return found === undefined ? googleError(404, "notFound", `The resource '${path.slice(1)}' was not found`) : Response.json(found);
    }

    const prefix = `/projects/${FAKE_PROJECT}`;
    if (!path.startsWith(`${prefix}/`)) return googleError(404, "notFound", `The resource '${path.slice(1)}' was not found`);
    const rest = path.slice(prefix.length);
    const notFound = (what: string) => googleError(404, "notFound", `The resource 'projects/${FAKE_PROJECT}${what}' was not found`);
    let match: RegExpExecArray | null;

    // --- zones and machine types
    if (method === "GET" && rest === "/zones") return page(url, ZONES);
    if (method === "GET" && (match = /^\/zones\/([a-z0-9-]+)$/.exec(rest)) !== null) {
      const found = ZONES.find((candidate) => candidate.name === match![1]);
      return found === undefined ? notFound(rest) : Response.json(found);
    }
    if (method === "GET" && (match = /^\/zones\/([a-z0-9-]+)\/machineTypes$/.exec(rest)) !== null) {
      if (!ZONES.some((candidate) => candidate.name === match![1])) return notFound(`/zones/${match[1]}`);
      return page(url, typesOf(match[1]!));
    }
    if (method === "GET" && (match = /^\/zones\/([a-z0-9-]+)\/machineTypes\/([a-z0-9-]+)$/.exec(rest)) !== null) {
      const found = ZONES.some((candidate) => candidate.name === match![1]) ? typesOf(match[1]!).find((candidate) => candidate.name === match![2]) : undefined;
      return found === undefined ? notFound(rest) : Response.json(found);
    }

    if (method === "GET" && (match = /^\/zones\/([a-z0-9-]+)\/diskTypes\/([a-z0-9-]+)$/.exec(rest)) !== null) {
      if (!ZONES.some((candidate) => candidate.name === match![1]) || !DISK_TYPES.includes(match[2]!)) return notFound(rest);
      return Response.json({ kind: "compute#diskType", name: match[2], zone: `${projectLink}/zones/${match[1]}`, validDiskSize: "10GB-65536GB", defaultDiskSizeGb: "100", selfLink: `${projectLink}${rest}` });
    }

    // --- the network
    if (method === "GET" && rest === "/global/networks/default") {
      const network = networkView();
      return network === null ? notFound(rest) : Response.json(network);
    }

    // --- operations
    if (method === "GET" && (match = /^\/(?:zones\/([a-z0-9-]+)|regions\/([a-z0-9-]+)|global)\/operations\/([a-z0-9-]+)$/.exec(rest)) !== null) {
      const item = operations.get(match[3]!);
      const sameScope = item !== undefined && String(item.view.zone ?? "").endsWith(`/${match[1] ?? ""}`) === (match[1] !== undefined) && String(item.view.region ?? "").endsWith(`/${match[2] ?? ""}`) === (match[2] !== undefined);
      if (item === undefined || !sameScope) return notFound(rest);
      advance(item);
      return Response.json(item.view);
    }

    // --- firewall rules
    if (method === "GET" && rest === "/global/firewalls") return page(url, firewalls);
    if ((match = /^\/global\/firewalls\/([a-z0-9-]+)$/.exec(rest)) !== null) {
      const name = match[1]!;
      const found = firewalls.find((candidate) => candidate.name === name);
      if (method === "GET") return found === undefined ? notFound(rest) : Response.json(found);
      if (method === "DELETE") {
        if (found === undefined) return notFound(rest);
        return Response.json(
          operation({}, "delete", found.selfLink as string, found.id, () => {
            const index = firewalls.indexOf(found);
            if (index !== -1) firewalls.splice(index, 1);
            return null;
          }),
        );
      }
    }
    if (method === "POST" && rest === "/global/firewalls") {
      const input = (body ?? {}) as Json & { name?: string; network?: string; targetTags?: string[]; priority?: number; sourceRanges?: string[] };
      if (typeof input.name !== "string" || !NAME.test(input.name)) return googleError(400, "invalid", `Invalid value for field 'resource.name': '${String(input.name)}'. Must be a match of regex '(?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)'`);
      const families = new Set((input.sourceRanges ?? []).map((range) => (range.includes(":") ? 6 : 4)));
      if (families.size > 1) return googleError(400, "invalid", "Invalid value for field 'resource.sourceRanges': IPv4 and IPv6 source ranges cannot be mixed in a single rule.");
      if (firewalls.some((candidate) => candidate.name === input.name)) return googleError(409, "alreadyExists", `The resource 'projects/${FAKE_PROJECT}/global/firewalls/${input.name}' already exists`);
      if (input.network !== networkLink && input.network !== "global/networks/default") return googleError(400, "invalid", `Invalid value for field 'resource.network': '${String(input.network)}'. The referenced network resource cannot be found.`);
      const id = String(nextId++);
      const selfLink = `${projectLink}/global/firewalls/${input.name}`;
      return Response.json(
        operation({}, "insert", selfLink, id, () => {
          firewalls.push({ kind: "compute#firewall", creationTimestamp: "2026-10-21T10:00:00.000-07:00", direction: "INGRESS", disabled: false, priority: 1000, ...input, id, name: input.name!, network: networkLink, selfLink });
          return null;
        }),
      );
    }

    // --- addresses
    if (method === "GET" && rest === "/aggregated/addresses") {
      return page(url, addresses.map(addressView), "addresses", (item) => `regions/${(item as FakeAddress).region.split("/").pop()}`, regions.map((region) => `regions/${region}`));
    }
    if ((match = /^\/regions\/([a-z0-9-]+)\/addresses(?:\/([a-z0-9-]+))?(\/setLabels)?$/.exec(rest)) !== null) {
      const region = match[1]!;
      const name = match[2];
      if (!regions.includes(region)) return notFound(`/regions/${region}`);
      const found = name === undefined ? undefined : addresses.find((candidate) => candidate.region === region && candidate.name === name);
      if (method === "GET" && name !== undefined && match[3] === undefined) return found === undefined ? notFound(rest) : Response.json(addressView(found));
      if (method === "POST" && name === undefined) {
        const input = (body ?? {}) as { name?: string; description?: string; labels?: Labels; networkTier?: string; addressType?: string };
        if (typeof input.name !== "string" || !NAME.test(input.name)) return googleError(400, "invalid", `Invalid value for field 'resource.name': '${String(input.name)}'.`);
        if (addresses.some((candidate) => candidate.region === region && candidate.name === input.name)) return googleError(409, "alreadyExists", `The resource 'projects/${FAKE_PROJECT}/regions/${region}/addresses/${input.name}' already exists`);
        const id = String(nextId++);
        const labels = settings.labelsAtInsert ? (input.labels ?? {}) : {};
        return Response.json(
          operation({ region }, "insert", `${projectLink}/regions/${region}/addresses/${input.name}`, id, () => {
            addresses.push({
              id,
              name: input.name!,
              region,
              address: `203.0.113.${nextAddress++}`,
              status: "RESERVED",
              ...(input.description === undefined ? {} : { description: input.description }),
              labels,
              labelFingerprint: fingerprint(labels),
              users: [],
              networkTier: input.networkTier ?? "PREMIUM",
            });
            return null;
          }),
        );
      }
      if (method === "POST" && match[3] !== undefined) {
        if (found === undefined) return notFound(`/regions/${region}/addresses/${name}`);
        const input = (body ?? {}) as { labels?: Labels; labelFingerprint?: string };
        if (input.labelFingerprint !== found.labelFingerprint) return googleError(412, "conditionNotMet", "Labels fingerprint either invalid or resource labels have changed");
        return Response.json(
          operation({ region }, "setLabels", `${projectLink}/regions/${region}/addresses/${found.name}`, found.id, () => {
            found.labels = input.labels ?? {};
            found.labelFingerprint = fingerprint(found.labels);
            return null;
          }),
        );
      }
      if (method === "DELETE" && name !== undefined) {
        if (found === undefined) return notFound(rest);
        if (found.status === "IN_USE") {
          return googleError(400, "resourceInUseByAnotherResource", `The address resource 'projects/${FAKE_PROJECT}/regions/${region}/addresses/${found.name}' is already being used by '${found.users[0]?.replace(`${LINK}/`, "")}'`);
        }
        return Response.json(
          operation({ region }, "delete", `${projectLink}/regions/${region}/addresses/${found.name}`, found.id, () => {
            const index = addresses.indexOf(found);
            if (index !== -1) addresses.splice(index, 1);
            return null;
          }),
        );
      }
    }

    // --- instances
    if (method === "GET" && rest === "/aggregated/instances") {
      const keep = filterBy(url.searchParams.get("filter"));
      if (keep instanceof Response) return keep;
      const listed = instances.filter((instance) => keep(instance.name)).sort((a, b) => a.zone.localeCompare(b.zone));
      return page(url, listed.map(instanceView), "instances", (item) => `zones/${String((item as { zone: string }).zone).split("/").pop()}`, ZONES.map((item) => `zones/${item.name}`));
    }
    if ((match = /^\/zones\/([a-z0-9-]+)\/instances(?:\/([a-z0-9-]+))?$/.exec(rest)) !== null) {
      const zoneName = match[1]!;
      const name = match[2];
      if (!ZONES.some((candidate) => candidate.name === zoneName)) return notFound(`/zones/${zoneName}`);
      const found = name === undefined ? undefined : instances.find((candidate) => candidate.zone === zoneName && candidate.name === name);
      if (method === "GET" && name !== undefined) {
        if (found === undefined) return notFound(rest);
        if (found.status === "STAGING" && ++found.stagingReads > settings.stagingReads) found.status = "RUNNING";
        return Response.json(instanceView(found));
      }
      if (method === "DELETE" && name !== undefined) {
        if (found === undefined) return notFound(rest);
        found.status = "STOPPING";
        return Response.json(
          operation({ zone: zoneName }, "delete", instanceLink(found), found.id, () => {
            const index = instances.indexOf(found);
            if (index !== -1) instances.splice(index, 1);
            release(found);
            return null;
          }),
        );
      }
      if (method === "POST" && name === undefined) return insertInstance(zoneName, body ?? {});
    }

    return googleError(404, "notFound", `no such route in the fake: ${method} ${path}`);
  }

  /** instances.insert, checked as the real API checks what the provider sends. */
  function insertInstance(zoneName: string, input: Json): Response {
    const name = input.name;
    const invalid = (field: string, why: string) => googleError(400, "invalid", `Invalid value for field 'resource.${field}': ${why}`);
    if (typeof name !== "string" || !NAME.test(name)) return invalid("name", `'${String(name)}'. Must be a match of regex '(?:[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)'`);
    if (instances.some((candidate) => candidate.zone === zoneName && candidate.name === name)) return googleError(409, "alreadyExists", `The resource 'projects/${FAKE_PROJECT}/zones/${zoneName}/instances/${name}' already exists`);
    const typeName = String(input.machineType ?? "").split("/").pop() ?? "";
    const machineType = typesOf(zoneName).find((candidate) => candidate.name === typeName);
    if (machineType === undefined || !String(input.machineType).includes(`zones/${zoneName}/machineTypes/`)) return invalid("machineType", `'${String(input.machineType)}'. Machine type with name '${typeName}' does not exist in zone '${zoneName}'.`);

    const disks = input.disks as { boot?: boolean; autoDelete?: boolean; initializeParams?: { sourceImage?: string; diskSizeGb?: string; diskType?: string; labels?: Labels } }[] | undefined;
    const boot = disks?.[0];
    if (disks?.length !== 1 || boot?.boot !== true) return invalid("disks", "exactly one boot disk is expected by this fake");
    const sourceImage = imageAt(boot.initializeParams?.sourceImage ?? "");
    if (sourceImage === undefined) return invalid("disks[0].initializeParams.sourceImage", `'${String(boot.initializeParams?.sourceImage)}'. The referenced image resource cannot be found.`);
    if (sourceImage.architecture !== machineType.architecture) return invalid("disks[0].initializeParams.sourceImage", `the image's architecture ${sourceImage.architecture} does not match the machine type's ${machineType.architecture}.`);
    const diskType = boot.initializeParams?.diskType ?? "";
    const diskName = diskType.split("/").pop()!;
    if (!diskType.startsWith(`zones/${zoneName}/diskTypes/`) || !DISK_TYPES.includes(diskName)) return invalid("disks[0].initializeParams.diskType", `'${diskType}'.`);
    const series = typeName.split("-")[0]!;
    if (HYPERDISK_ONLY.includes(series) !== diskName.startsWith("hyperdisk-")) {
      return googleError(400, "invalid", `[${diskName}] disk type cannot be used by [${typeName}] machine type.`);
    }
    if (Number(boot.initializeParams?.diskSizeGb ?? sourceImage.diskSizeGb) < Number(sourceImage.diskSizeGb)) {
      return invalid("disks[0].initializeParams.diskSizeGb", `Requested disk size cannot be smaller than the image size (${sourceImage.diskSizeGb} GB)`);
    }
    const nested = (input.advancedMachineFeatures as { enableNestedVirtualization?: boolean } | undefined)?.enableNestedVirtualization === true;
    if (nested && !NESTING.includes(series)) {
      return invalid("advancedMachineFeatures.enableNestedVirtualization", `'true'. Nested virtualization is not supported for machine type '${typeName}'.`);
    }

    const nic = (input.networkInterfaces as { network?: string; subnetwork?: string; accessConfigs?: { type?: string; natIP?: string; networkTier?: string }[] }[] | undefined)?.[0];
    const network = networkView();
    if (network === null || (nic?.network !== networkLink && nic?.network !== "global/networks/default")) return invalid("networkInterfaces[0].network", `'${String(nic?.network)}'. The referenced network resource cannot be found.`);
    const region = zoneName.replace(/-[a-z0-9]+$/, "");
    if (nic.subnetwork !== undefined && !network.subnetworks.includes(nic.subnetwork)) return invalid("networkInterfaces[0].subnetwork", `'${nic.subnetwork}'.`);
    if (nic.subnetwork === undefined && !network.autoCreateSubnetworks) return invalid("networkInterfaces[0].subnetwork", "a subnetwork is required in a custom mode network.");
    const access = nic.accessConfigs?.[0];
    const address = addresses.find((candidate) => candidate.region === region && candidate.address === access?.natIP);
    if (access?.type !== "ONE_TO_ONE_NAT" || address === undefined || address.status !== "RESERVED") {
      return invalid("networkInterfaces[0].accessConfigs[0].natIP", `'${String(access?.natIP)}'. The specified external IP address '${String(access?.natIP)}' was not found in region '${region}'.`);
    }
    if ((access.networkTier ?? "PREMIUM") !== address.networkTier) return invalid("networkInterfaces[0].accessConfigs[0].networkTier", "the network tier of the address does not match.");

    const metadata = ((input.metadata as { items?: { key: string; value: string }[] } | undefined)?.items ?? []).map((item) => ({ key: item.key, value: item.value }));
    const instance: FakeInstance = {
      id: String(nextId++),
      name,
      zone: zoneName,
      status: "PROVISIONING",
      machineType: typeName,
      labels: (input.labels as Labels | undefined) ?? {},
      tags: (input.tags as { items?: string[] } | undefined)?.items ?? [],
      metadata,
      natIP: address.address,
      networkTier: address.networkTier,
      network: networkLink,
      subnetwork: nic.subnetwork ?? null,
      ...(nested ? { nestedVirtualization: true } : {}),
      disk: {
        sourceImage: boot.initializeParams?.sourceImage ?? "",
        diskType,
        diskSizeGb: String(boot.initializeParams?.diskSizeGb ?? "10"),
        autoDelete: boot.autoDelete === true,
        labels: boot.initializeParams?.labels ?? {},
      },
      ...(typeof input.description === "string" ? { description: input.description } : {}),
      stagingReads: 0,
    };
    instances.push(instance);
    address.status = "IN_USE";
    address.users = [instanceLink(instance)];
    return Response.json(
      operation({ zone: zoneName }, "insert", instanceLink(instance), instance.id, () => {
        instance.status = "STAGING";
        return null;
      }),
    );
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const origin = `http://127.0.0.1:${server.port}`;

  const fake = {
    url: `${origin}/compute/v1`,
    oauthUrl: `${origin}/token`,
    environment: {
      GOOGLE_CLOUD_PROJECT: FAKE_PROJECT,
      GOOGLE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN,
      SITESOLIDE_GCP_API: `${origin}/compute/v1`,
      SITESOLIDE_GCP_OAUTH: `${origin}/token`,
    } as Record<string, string>,
    secrets,
    requests,
    settings,
    firewalls,
    addresses,
    instances,
    operations,
    regions,
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, reason: string, message: string, extra: { headers?: Record<string, string>; times?: number; body?: Json } = {}): void {
      failures.push({ method, path, status, reason, message, headers: extra.headers, times: extra.times ?? 1, extra: extra.body });
    },
    /** An instance that exists before the test, sitesolide's or not; it holds no reserved address unless `natIP` names one. */
    addInstance(input: Partial<FakeInstance> & { name: string }): FakeInstance {
      const instance: FakeInstance = {
        id: String(nextId++),
        zone: "europe-west4-a",
        status: "RUNNING",
        machineType: "e2-small",
        labels: {},
        tags: [],
        metadata: [],
        natIP: `198.51.100.${instances.length + 10}`,
        networkTier: "PREMIUM",
        network: networkLink,
        subnetwork: null,
        disk: { sourceImage: "projects/debian-cloud/global/images/family/debian-13", diskType: "pd-balanced", diskSizeGb: "10", autoDelete: true, labels: {} },
        stagingReads: 0,
        ...input,
      };
      instances.push(instance);
      const address = addresses.find((candidate) => candidate.address === instance.natIP);
      if (address !== undefined) {
        address.status = "IN_USE";
        address.users = [instanceLink(instance)];
      }
      return instance;
    },
    addFirewall(input: Partial<FakeFirewall> & { name: string }): FakeFirewall {
      const rule: FakeFirewall = {
        kind: "compute#firewall",
        id: String(nextId++),
        network: networkLink,
        priority: 1000,
        direction: "INGRESS",
        sourceRanges: ["0.0.0.0/0"],
        // A rule allows or denies, never both.
        ...(input.denied === undefined ? { allowed: [{ IPProtocol: "tcp", ports: ["8080"] }] } : {}),
        selfLink: `${projectLink}/global/firewalls/${input.name}`,
        ...input,
      };
      firewalls.push(rule);
      return rule;
    },
    addAddress(input: Partial<FakeAddress> & { name: string; region: string }): FakeAddress {
      const labels = input.labels ?? {};
      const address: FakeAddress = { id: String(nextId++), address: `203.0.113.${nextAddress++}`, status: "RESERVED", labels, labelFingerprint: fingerprint(labels), users: [], networkTier: "PREMIUM", ...input };
      addresses.push(address);
      return address;
    },
    /** A service account and its key, generated once; the token endpoint verifies the JWTs signed with it. */
    async serviceAccount(): Promise<{ email: string; privateKey: string; keyFile: string }> {
      if (serviceKey === null) {
        const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
        const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
        const privateKey = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
        const keyFile = JSON.stringify({
          type: "service_account",
          project_id: FAKE_PROJECT,
          private_key_id: "0123456789abcdef0123456789abcdef01234567",
          private_key: privateKey,
          client_email: FAKE_EMAIL,
          client_id: "100000000000000000001",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
        });
        serviceKey = { publicKey: pair.publicKey, privateKey, keyFile };
        secrets.push(privateKey);
      }
      return { email: FAKE_EMAIL, privateKey: serviceKey.privateKey, keyFile: serviceKey.keyFile };
    },
    reset(): void {
      firewalls.length = 0;
      firewalls.push(...prepopulated());
      addresses.length = 0;
      instances.length = 0;
      operations.clear();
      requests.length = 0;
      failures.length = 0;
      exchangedIssued = false;
      nextAddress = 10;
      settings.pageSize = options.pageSize ?? 2;
      settings.operationPolls = options.operationPolls ?? 2;
      settings.labelsAtInsert = false;
      settings.network = "auto";
      settings.failOperation = null;
      settings.stagingReads = 1;
    },
    stop(): void {
      server.stop(true);
    },
  };
  return fake;
}
