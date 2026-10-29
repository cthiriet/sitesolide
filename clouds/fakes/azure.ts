/**
 * A local stand-in for Azure, on a random port of the loopback: Microsoft
 * Entra's token endpoint, Resource Manager, and the public retail price list,
 * all three at one address. The tests of src/azure.ts never reach the real
 * ones.
 *
 * It keeps a subscription in memory (resource groups, the resources in them,
 * the registration of resource providers, the sizes sold, the quotas, the
 * images) and answers in the shapes of Microsoft's documentation:
 *
 *   - the token endpoint takes the client credentials grant, the client's ID
 *     and secret in a Basic Authorization header or in the form body, and
 *     answers `{token_type,
 *     expires_in, access_token}`, or `{error, error_description,
 *     error_codes}`;
 *   - Resource Manager wants a bearer token it issued, or the one the Azure
 *     CLI stands for here, and the api-version of each resource provider;
 *     it answers `{"error": {"code", "message"}}` on failure, pages lists
 *     with `nextLink`, and runs PUTs and DELETEs as operations followed
 *     through Azure-AsyncOperation and Location for a few polls;
 *   - the price list pages `Items` with `NextPageLink`, and holds Linux,
 *     Windows, Spot, Low Priority and Cloud Services lines, as the real one.
 *
 * Lists come back `pageSize` items a page, two by default, so that a client
 * that reads only the first page fails a test. `fail()` makes the next
 * matching request answer an error instead.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

export const SUBSCRIPTION = "8f2c1e4a-0b7d-4c3e-9a61-5d2e7f9b3c10";
export const TENANT = "3b9d2f61-7a4c-4e8b-b5d0-1c6e9f2a7d43";
export const CLIENT = "c4e1a7b2-9d3f-4b6a-8e5c-2f7d1a9b6e30";
export const CLIENT_SECRET = "Fk8Q~fake.client-secret_0123456789abcdefABCD";

function jwt(subject: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ typ: "JWT", alg: "RS256", kid: "fake-key" })}.${part({ aud: "https://management.azure.com/", tid: TENANT, sub: subject, iss: "https://sts.test-zone.invalid/" })}.${Buffer.alloc(64, subject.length).toString("base64url")}`;
}

/** The token `az account get-access-token` stands for in these tests. */
export const CLI_TOKEN = jwt("azure-cli-user-0123456789");

type Tags = Record<string, string>;

export type FakeGroup = { name: string; location: string; tags: Tags; state: "Succeeded" | "Deleting" };

export type FakeResource = {
  id: string;
  name: string;
  type: string;
  group: string;
  location: string;
  tags: Tags;
  sku?: unknown;
  managedBy?: string;
  properties: Record<string, unknown>;
  /** The operation still making it: reading the resource advances it, as time does at Azure. */
  pending?: string;
};

type Operation = { id: string; polls: number; needed: number; status: "InProgress" | "Succeeded" | "Failed"; error: { code: string; message: string } | null; done: () => void; failed: () => void };
type Injected = { method: string; path: RegExp; status: number; code: string; message: string; headers?: Record<string, string>; details?: unknown; times: number };

export type Received = FakeRequest & { url: string; authorization: string | null };

const LOCATIONS = [
  { name: "germanywestcentral", displayName: "Germany West Central", physicalLocation: "Frankfurt", geography: "Germany", geographyGroup: "Europe", regionCategory: "Recommended" },
  { name: "francecentral", displayName: "France Central", physicalLocation: "Paris", geography: "France", geographyGroup: "Europe", regionCategory: "Recommended" },
  { name: "westeurope", displayName: "West Europe", physicalLocation: "Netherlands", geography: "Europe", geographyGroup: "Europe", regionCategory: "Recommended" },
  { name: "northeurope", displayName: "North Europe", physicalLocation: "Ireland", geography: "Europe", geographyGroup: "Europe", regionCategory: "Recommended" },
  { name: "eastus", displayName: "East US", physicalLocation: "Virginia", geography: "United States", geographyGroup: "US", regionCategory: "Recommended" },
  { name: "germanynorth", displayName: "Germany North", physicalLocation: "Berlin", geography: "Germany", geographyGroup: "Europe", regionCategory: "Other" },
];

function locationView(entry: (typeof LOCATIONS)[number]) {
  return {
    id: `/subscriptions/${SUBSCRIPTION}/locations/${entry.name}`,
    name: entry.name,
    type: "Region",
    displayName: entry.displayName,
    regionalDisplayName: `(${entry.geographyGroup}) ${entry.displayName}`,
    metadata: {
      regionType: "Physical",
      regionCategory: entry.regionCategory,
      geography: entry.geography,
      geographyGroup: entry.geographyGroup,
      physicalLocation: entry.physicalLocation,
      latitude: "50.110924",
      longitude: "8.682127",
      pairedRegion: [],
    },
  };
}

/** A logical region and an edge zone, which are no place to order a machine. */
const OTHER_LOCATIONS = [
  { id: `/subscriptions/${SUBSCRIPTION}/locations/europe`, name: "europe", type: "Region", displayName: "Europe", regionalDisplayName: "Europe", metadata: { regionType: "Logical", regionCategory: "Other", geography: "Europe", geographyGroup: "Europe" } },
  { id: `/subscriptions/${SUBSCRIPTION}/locations/eastus/edgeZones/edgelab1`, name: "edgelab1", type: "EdgeZone", displayName: "Edge Lab 1", metadata: { regionType: "Physical", regionCategory: "Extended", geography: "United States", geographyGroup: "US" } },
];

type Size = { name: string; family: string; vcpus: number; memory: number; arch: "x64" | "Arm64"; generations: string; hourly: number };

/** What the fake sells, close enough to Azure's October 2026 list to read like it; hourly Linux prices of Frankfurt. */
export const SIZES: Size[] = [
  { name: "Standard_B2ats_v2", family: "standardBasv2Family", vcpus: 2, memory: 1, arch: "x64", generations: "V1,V2", hourly: 0.0108 },
  { name: "Standard_B2als_v2", family: "standardBasv2Family", vcpus: 2, memory: 4, arch: "x64", generations: "V1,V2", hourly: 0.0432 },
  { name: "Standard_B2as_v2", family: "standardBasv2Family", vcpus: 2, memory: 8, arch: "x64", generations: "V1,V2", hourly: 0.0864 },
  { name: "Standard_B4als_v2", family: "standardBasv2Family", vcpus: 4, memory: 8, arch: "x64", generations: "V1,V2", hourly: 0.153 },
  { name: "Standard_B4as_v2", family: "standardBasv2Family", vcpus: 4, memory: 16, arch: "x64", generations: "V1,V2", hourly: 0.173 },
  { name: "Standard_B2ls_v2", family: "standardBsv2Family", vcpus: 2, memory: 4, arch: "x64", generations: "V1,V2", hourly: 0.048 },
  { name: "Standard_B2s_v2", family: "standardBsv2Family", vcpus: 2, memory: 8, arch: "x64", generations: "V1,V2", hourly: 0.096 },
  { name: "Standard_B2pls_v2", family: "standardBpsv2Family", vcpus: 2, memory: 4, arch: "Arm64", generations: "V2", hourly: 0.0384 },
  { name: "Standard_B2ps_v2", family: "standardBpsv2Family", vcpus: 2, memory: 8, arch: "Arm64", generations: "V2", hourly: 0.0768 },
  { name: "Standard_D2as_v5", family: "standardDASv5Family", vcpus: 2, memory: 8, arch: "x64", generations: "V1,V2", hourly: 0.104 },
  { name: "Standard_D4as_v5", family: "standardDASv5Family", vcpus: 4, memory: 16, arch: "x64", generations: "V1,V2", hourly: 0.208 },
  { name: "Standard_D2s_v5", family: "standardDSv5Family", vcpus: 2, memory: 8, arch: "x64", generations: "V1,V2", hourly: 0.115 },
  { name: "Standard_D2ls_v5", family: "standardDLSv5Family", vcpus: 2, memory: 4, arch: "x64", generations: "V1,V2", hourly: 0.101 },
  { name: "Standard_A1_v2", family: "standardAv2Family", vcpus: 1, memory: 2, arch: "x64", generations: "V1", hourly: 0.043 },
];

/** Debian's images, as `Debian:debian-13:<sku>`, with their versions. */
const IMAGE_VERSIONS = ["0.20260801.2200", "0.20260915.2240"];

const DISALLOWED_ADMINS = new Set(["administrator", "admin", "user", "user1", "test", "user2", "test1", "user3", "admin1", "1", "123", "a", "actuser", "adm", "admin2", "aspnet", "backup", "console", "david", "guest", "john", "owner", "root", "server", "sql", "support", "support_388945a0", "sys", "test2", "test3", "user4", "user5"]);

function error(status: number, code: string, message: string, extra: { details?: unknown; headers?: Record<string, string> } = {}): Response {
  return Response.json({ error: { code, message, ...(extra.details === undefined ? {} : { details: extra.details }) } }, { status, headers: extra.headers ?? {} });
}

const API_VERSIONS = { resources: "2021-04-01", subscriptions: "2022-12-01", compute: "2025-04-01", skus: "2021-07-01", network: "2025-05-01" };

export type FakeAzure = ReturnType<typeof createFakeAzure>;

export function createFakeAzure(options: { pageSize?: number } = {}) {
  let nextId = 1;
  let serial = 10;
  const groups = new Map<string, FakeGroup>();
  const resources = new Map<string, FakeResource>();
  const operations = new Map<string, Operation>();
  const requests: Received[] = [];
  const injected: Injected[] = [];
  /** The tokens the token endpoint handed out, which Resource Manager takes. */
  const issued: string[] = [];
  const revoked = new Set<string>();
  const providers: Record<string, string> = {};
  const registering: Record<string, number> = {};

  const defaults = () => ({
    pageSize: options.pageSize ?? 2,
    /** How many polls an operation stays InProgress. */
    operationPolls: 2,
    /** How many polls a resource group's deletion stays 202. */
    deletePolls: 3,
    /** How many polls a registration stays Registering. */
    registerPolls: 2,
    /** Retry-After on the answers that start an operation, in seconds. */
    retryAfter: "10",
    /** The token endpoint's answer for the token's lifetime. */
    tokenLifetime: 3599,
    /** `size` or `location/size`: sold, but not to this subscription. */
    restricted: new Set<string>(),
    /** What the next machine's creation ends in, when not Succeeded. */
    failVm: null as { code: string; message: string } | null,
    /** The power state of a machine once created. */
    power: "running",
    /** vCPUs in use and allowed per family, `cores` for the whole location. */
    quota: { cores: { limit: 10, used: 0 }, standardBasv2Family: { limit: 10, used: 0 }, standardBpsv2Family: { limit: 10, used: 0 }, standardBsv2Family: { limit: 10, used: 0 }, standardDASv5Family: { limit: 10, used: 0 } } as Record<string, { limit: number; used: number }>,
    /** Which images exist, `publisher:offer:sku`. */
    images: new Set(["Debian:debian-13:13", "Debian:debian-13:13-gen2", "Debian:debian-13:13-arm64"]),
    /** Answers an Azure-AsyncOperation address on another host, which no client should follow. */
    foreignOperation: false,
    /** Whether the price list answers. */
    pricesUp: true,
    /** Whether the token endpoint takes the client's secret in a Basic header; it always takes it in the form. */
    basicAccepted: true,
  });
  const settings = defaults();

  const providersReset = () => {
    for (const namespace of ["Microsoft.Compute", "Microsoft.Network", "Microsoft.Resources"]) providers[namespace.toLowerCase()] = "Registered";
  };
  providersReset();

  let origin = "";

  const page = (url: URL, items: unknown[]): Response => {
    const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
    const slice = items.slice(skip, skip + settings.pageSize);
    const more = skip + settings.pageSize < items.length;
    const next = new URL(url.toString());
    next.searchParams.set("$skiptoken", String(skip + settings.pageSize));
    return Response.json({ value: slice, ...(more ? { nextLink: next.toString() } : {}) });
  };

  const operation = (provider: string, location: string, done: () => void, failure: { code: string; message: string } | null = null, failed: () => void = () => {}): { id: string; url: string } => {
    const id = `op-${nextId++}`;
    operations.set(id, { id, polls: 0, needed: settings.operationPolls, status: "InProgress", error: failure, done, failed });
    const host = settings.foreignOperation ? "https://operations.test-zone.invalid" : origin;
    return { id, url: `${host}/subscriptions/${SUBSCRIPTION}/providers/${provider}/locations/${location}/operations/${id}?api-version=2025-05-01` };
  };

  /** One more poll of an operation: it ends once it has been asked about often enough. */
  const progress = (item: Operation): void => {
    if (item.status !== "InProgress") return;
    item.polls++;
    if (item.polls < item.needed) return;
    item.status = item.error === null ? "Succeeded" : "Failed";
    if (item.error === null) item.done();
    else item.failed();
  };

  const locationOperation = (done: () => void): string => {
    const id = `delete-${nextId++}`;
    operations.set(id, { id, polls: 0, needed: settings.deletePolls, status: "InProgress", error: null, done, failed: () => {} });
    return `${origin}/subscriptions/${SUBSCRIPTION}/operationresults/${id}?api-version=2021-04-01`;
  };

  const skuView = (size: Size, location: string) => ({
    resourceType: "virtualMachines",
    name: size.name,
    tier: "Standard",
    size: size.name.replace(/^Standard_/, ""),
    family: size.family,
    locations: [location],
    locationInfo: [{ location, zones: ["1", "2", "3"], zoneDetails: [] }],
    capabilities: [
      { name: "MaxResourceVolumeMB", value: "0" },
      { name: "OSVhdSizeMB", value: "1047552" },
      { name: "vCPUs", value: String(size.vcpus) },
      { name: "MemoryGB", value: String(size.memory) },
      { name: "HyperVGenerations", value: size.generations },
      { name: "CpuArchitectureType", value: size.arch },
      { name: "LowPriorityCapable", value: "True" },
      { name: "PremiumIO", value: "True" },
      { name: "vCPUsAvailable", value: String(size.vcpus) },
    ],
    restrictions:
      settings.restricted.has(size.name) || settings.restricted.has(`${location}/${size.name}`)
        ? [{ type: "Location", values: [location], restrictionInfo: { locations: [location] }, reasonCode: "NotAvailableForSubscription" }]
        : [],
  });

  /** A disk SKU and an availability set SKU besides the machines', as the real list holds every resource type. */
  const otherSkus = (location: string) => [
    { resourceType: "disks", name: "StandardSSD_LRS", tier: "Standard", size: "E4", locations: [location], capabilities: [], restrictions: [] },
    { resourceType: "availabilitySets", name: "Aligned", locations: [location], capabilities: [], restrictions: [] },
  ];

  const resourceKey = (id: string) => id.toLowerCase();
  const resourceId = (group: string, provider: string, type: string, name: string) => `/subscriptions/${SUBSCRIPTION}/resourceGroups/${group}/providers/${provider}/${type}/${name}`;

  const vmView = (resource: FakeResource, expand: boolean) => {
    const properties: Record<string, unknown> = { ...resource.properties };
    if (!expand) delete properties.instanceView;
    return { id: resource.id, name: resource.name, type: resource.type, location: resource.location, tags: resource.tags, properties };
  };

  const view = (resource: FakeResource) => ({
    id: resource.id,
    name: resource.name,
    type: resource.type,
    location: resource.location,
    tags: resource.tags,
    ...(resource.sku === undefined ? {} : { sku: resource.sku }),
    ...(resource.managedBy === undefined ? {} : { managedBy: resource.managedBy }),
    etag: `W/"${resource.name}"`,
    properties: resource.properties,
  });

  const groupView = (group: FakeGroup) => ({
    id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/${group.name}`,
    name: group.name,
    type: "Microsoft.Resources/resourceGroups",
    location: group.location,
    ...(Object.keys(group.tags).length === 0 ? {} : { tags: group.tags }),
    properties: { provisioningState: group.state },
  });

  const instanceView = (provisioning: string, power: string | null) => ({
    statuses: [
      { code: `ProvisioningState/${provisioning.toLowerCase()}`, level: "Info", displayStatus: `Provisioning ${provisioning.toLowerCase()}`, ...(provisioning === "Failed" ? { message: "the allocation failed" } : {}) },
      ...(power === null ? [] : [{ code: `PowerState/${power}`, level: "Info", displayStatus: `VM ${power}` }]),
    ],
  });

  const deleteFromGroup = (group: string) => {
    for (const [key, resource] of resources) if (resource.group.toLowerCase() === group.toLowerCase()) resources.delete(key);
  };

  const usage = (key: string): { limit: number; used: number } => {
    settings.quota[key] ??= { limit: 10, used: 0 };
    return settings.quota[key]!;
  };

  /** Resource Manager's answer to a call on an unregistered namespace. */
  const unregistered = (namespace: string) =>
    error(409, "MissingSubscriptionRegistration", `The subscription is not registered to use namespace '${namespace}'. See https://aka.ms/rps-not-found for how to register subscriptions.`, {
      details: [{ code: "MissingSubscriptionRegistration", target: namespace, message: `The subscription is not registered to use namespace '${namespace}'.` }],
    });

  function token(request: Request): Response | null {
    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (presented === "") return error(401, "AuthenticationFailed", "Authentication failed. The 'Authorization' header is missing.");
    if (revoked.has(presented)) return error(401, "ExpiredAuthenticationToken", "The access token expiry UTC time is earlier than current UTC time.");
    if (presented !== CLI_TOKEN && !issued.includes(presented)) return error(401, "InvalidAuthenticationToken", "The access token is invalid.");
    return null;
  }

  async function login(request: Request, tenant: string, body: string): Promise<Response> {
    const failure = (status: number, code: string, number: number, said: string) =>
      Response.json(
        { error: code, error_description: `AADSTS${number}: ${said}\r\nTrace ID: 0000aaaa-11bb-cccc-dd22-eeeeee333333\r\nCorrelation ID: aaaa0000-bb11-2222-33cc-444444dddddd\r\nTimestamp: 2026-10-21 10:00:00Z`, error_codes: [number], timestamp: "2026-10-21 10:00:00Z", trace_id: "0000aaaa-11bb-cccc-dd22-eeeeee333333", correlation_id: "aaaa0000-bb11-2222-33cc-444444dddddd" },
        { status },
      );
    if (tenant !== TENANT) return failure(400, "invalid_request", 90002, `Tenant '${tenant}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`);
    const form = new URLSearchParams(body);
    if (form.get("grant_type") !== "client_credentials") return failure(400, "unsupported_grant_type", 70003, "The app requested an unsupported grant type.");
    if (form.get("scope") !== "https://management.azure.com/.default") return failure(400, "invalid_scope", 70011, "The provided value for the input parameter 'scope' is not valid.");
    const authorization = request.headers.get("authorization") ?? "";
    let client = form.get("client_id") ?? "";
    let secret = form.get("client_secret") ?? "";
    if (authorization.startsWith("Basic ")) {
      if (!settings.basicAccepted) return failure(401, "invalid_client", 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
      const decoded = Buffer.from(authorization.slice(6), "base64").toString();
      [client = "", secret = ""] = decoded.split(":").map((part) => decodeURIComponent(part));
    } else if (secret === "") {
      return failure(401, "invalid_client", 7000218, "The request body must contain the following parameter: 'client_assertion' or 'client_secret'.");
    }
    if (client !== CLIENT) return failure(400, "unauthorized_client", 700016, `Application with identifier '${client}' was not found in the directory '${tenant}'.`);
    if (secret !== CLIENT_SECRET) return failure(401, "invalid_client", 7000215, "Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.");
    const access = jwt(`service-principal-${issued.length + 1}-0123456789`);
    issued.push(access);
    return Response.json({ token_type: "Bearer", expires_in: settings.tokenLifetime, ext_expires_in: settings.tokenLifetime, access_token: access });
  }

  function prices(url: URL): Response {
    if (!settings.pricesUp) return new Response("<html>unavailable</html>", { status: 503, headers: { "Content-Type": "text/html" } });
    const filter = url.searchParams.get("$filter") ?? "";
    const region = /armRegionName eq '([^']+)'/.exec(filter)?.[1] ?? "";
    const wanted = [...filter.matchAll(/armSkuName eq '([^']+)'/g)].map((match) => match[1]!);
    const factor = region === "germanywestcentral" ? 1 : region === "eastus" ? 0.85 : 1.05;
    const items: unknown[] = [];
    for (const size of SIZES.filter((candidate) => wanted.includes(candidate.name))) {
      const short = size.name.replace(/^Standard_/, "").replaceAll("_", " ");
      const hourly = Number((size.hourly * factor).toFixed(4));
      const row = (productName: string, meterName: string, price: number, type = "Consumption") => ({
        currencyCode: "USD",
        tierMinimumUnits: 0,
        retailPrice: price,
        unitPrice: price,
        armRegionName: region,
        location: "DE West Central",
        effectiveStartDate: "2023-09-01T00:00:00Z",
        meterId: `meter-${size.name}-${meterName}`,
        meterName,
        productId: "DZH318Z0FAKE",
        skuId: "DZH318Z0FAKE/0001",
        productName,
        skuName: meterName,
        serviceName: "Virtual Machines",
        serviceId: "DZH313Z7MMC8",
        serviceFamily: "Compute",
        unitOfMeasure: "1 Hour",
        type,
        isPrimaryMeterRegion: true,
        armSkuName: size.name,
      });
      const series = `Virtual Machines ${size.family.replace(/^standard|Family$/g, "")} Series`;
      items.push(
        row(`${series} Windows`, short, hourly * 2),
        row(series, `${short} Spot`, hourly / 10),
        row(series, `${short} Low Priority`, hourly / 5),
        row(`${size.family} Cloud Services`, short, hourly * 1.2),
        row(series, short, hourly * 0.6, "DevTestConsumption"),
        row(series, short, hourly),
      );
    }
    const skip = Number(url.searchParams.get("$skip") ?? "0");
    // The real list gives a thousand lines a page; a few dozen here still makes several pages.
    const size = 25;
    const next = new URL(url.toString());
    next.searchParams.set("$skip", String(skip + size));
    return Response.json({
      BillingCurrency: "USD",
      CustomerEntityId: "Default",
      CustomerEntityType: "Retail",
      Items: items.slice(skip, skip + size),
      NextPageLink: skip + size < items.length ? next.toString() : null,
      Count: Math.min(size, Math.max(0, items.length - skip)),
    });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const lower = path.toLowerCase();
    const text = method === "GET" || method === "DELETE" ? "" : await request.text();
    let body: unknown = null;
    if (text !== "" && !(request.headers.get("content-type") ?? "").includes("x-www-form-urlencoded")) {
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, "InvalidRequestContent", "The request content was invalid and could not be deserialized.");
      }
    } else if (text !== "") {
      body = text;
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ method, path, search: url.search, url: request.url, body, headers, authorization: request.headers.get("authorization") });

    // --- the token endpoint and the price list, which take no bearer
    const tokenRoute = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(path);
    if (tokenRoute !== null && method === "POST") return login(request, decodeURIComponent(tokenRoute[1]!), text);
    if (method === "GET" && lower === "/api/retail/prices") return prices(url);

    const refused = token(request);
    if (refused !== null) return refused;
    const injectedFailure = injected.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (injectedFailure !== undefined) {
      injectedFailure.times--;
      return error(injectedFailure.status, injectedFailure.code, injectedFailure.message, { details: injectedFailure.details, headers: injectedFailure.headers });
    }

    const subscription = `/subscriptions/${SUBSCRIPTION}`.toLowerCase();
    if (!lower.startsWith(`${subscription}/`) && lower !== subscription) return error(404, "SubscriptionNotFound", "The subscription could not be found.");
    const version = url.searchParams.get("api-version");
    const wants = (expected: string) => (version === expected ? null : error(400, "InvalidApiVersionParameter", `The api-version '${version}' is invalid. The supported versions are '${expected}'.`));
    const rest = path.slice(subscription.length);
    const restLower = rest.toLowerCase();
    const location = (url.searchParams.get("$filter") ?? "").match(/location eq '([^']+)'/)?.[1] ?? "";

    // --- operations
    const operationRoute = /^\/providers\/(microsoft\.network|microsoft\.compute)\/locations\/[^/]+\/operations\/([^/]+)$/i.exec(rest);
    if (method === "GET" && operationRoute !== null) {
      const item = operations.get(operationRoute[2]!);
      if (item === undefined) return error(404, "NotFound", "operation not found");
      progress(item);
      return Response.json(
        { name: item.id, status: item.status, startTime: "2026-10-21T10:00:00Z", ...(item.status === "InProgress" ? {} : { endTime: "2026-10-21T10:01:00Z" }), ...(item.error === null || item.status !== "Failed" ? {} : { error: item.error }) },
        { headers: item.status === "InProgress" ? { "Retry-After": settings.retryAfter } : {} },
      );
    }
    const resultRoute = /^\/operationresults\/([^/]+)$/i.exec(rest);
    if (method === "GET" && resultRoute !== null) {
      const item = operations.get(resultRoute[1]!);
      if (item === undefined) return error(404, "NotFound", "operation not found");
      if (item.status === "InProgress") {
        item.polls++;
        if (item.polls >= item.needed) {
          item.status = "Succeeded";
          item.done();
        }
      }
      if (item.status === "InProgress") return new Response(null, { status: 202, headers: { Location: request.url, "Retry-After": settings.retryAfter } });
      return new Response(null, { status: 200 });
    }

    // --- the subscription
    if (method === "GET" && restLower === "/locations") return wants(API_VERSIONS.subscriptions) ?? page(url, [...LOCATIONS.map(locationView), ...OTHER_LOCATIONS]);
    const providerRoute = /^\/providers\/(microsoft\.[a-z]+)(\/register)?$/i.exec(rest);
    if (providerRoute !== null && (method === "GET" || (method === "POST" && providerRoute[2] !== undefined))) {
      const wrong = wants(API_VERSIONS.resources);
      if (wrong !== null) return wrong;
      const namespace = providerRoute[1]!;
      const key = namespace.toLowerCase();
      if (method === "POST" && providers[key] !== "Registered") {
        providers[key] = "Registering";
        registering[key] = 0;
      } else if (method === "GET" && providers[key] === "Registering") {
        registering[key] = (registering[key] ?? 0) + 1;
        if (registering[key]! >= settings.registerPolls) providers[key] = "Registered";
      }
      return Response.json({ id: `/subscriptions/${SUBSCRIPTION}/providers/${namespace}`, namespace, registrationState: providers[key] ?? "NotRegistered", registrationPolicy: "RegistrationRequired", resourceTypes: [] });
    }
    if (method === "GET" && restLower === "/providers/microsoft.compute/skus") {
      const wrong = wants(API_VERSIONS.skus);
      if (wrong !== null) return wrong;
      if (providers["microsoft.compute"] !== "Registered") return unregistered("Microsoft.Compute");
      const where = LOCATIONS.some((entry) => entry.name === location) ? location : "";
      const sold = where === "" ? [] : where === "germanynorth" ? SIZES.slice(0, 2) : SIZES;
      return page(url, [...otherSkus(where), ...sold.map((size) => skuView(size, where))]);
    }
    const usagesRoute = /^\/providers\/microsoft\.compute\/locations\/([^/]+)\/usages$/i.exec(rest);
    if (method === "GET" && usagesRoute !== null) {
      const wrong = wants(API_VERSIONS.compute);
      if (wrong !== null) return wrong;
      if (providers["microsoft.compute"] !== "Registered") return unregistered("Microsoft.Compute");
      const names: Record<string, string> = { cores: "Total Regional vCPUs", standardBasv2Family: "Standard Basv2 Family vCPUs", standardBpsv2Family: "Standard Bpsv2 Family vCPUs", standardBsv2Family: "Standard Bsv2 Family vCPUs", standardDASv5Family: "Standard DASv5 Family vCPUs" };
      return page(
        url,
        [{ unit: "Count", currentValue: 0, limit: 25000, name: { value: "virtualMachines", localizedValue: "Virtual Machines" } }, ...Object.entries(settings.quota).map(([key, value]) => ({ unit: "Count", currentValue: value.used, limit: value.limit, name: { value: key, localizedValue: names[key] ?? key } }))],
      );
    }
    const imageRoute = /^\/providers\/microsoft\.compute\/locations\/([^/]+)\/publishers\/([^/]+)\/artifacttypes\/vmimage\/offers\/([^/]+)\/skus\/([^/]+)\/versions$/i.exec(rest);
    if (method === "GET" && imageRoute !== null) {
      const wrong = wants(API_VERSIONS.compute);
      if (wrong !== null) return wrong;
      if (providers["microsoft.compute"] !== "Registered") return unregistered("Microsoft.Compute");
      const [, where, publisher, offer, variant] = imageRoute;
      if (!settings.images.has(`${publisher}:${offer}:${variant}`)) return error(404, "NotFound", "Artifact: VMImage was not found.");
      // A bare array, as the API answers this list.
      return Response.json(IMAGE_VERSIONS.map((name) => ({ name, location: where, id: `/Subscriptions/${SUBSCRIPTION}/Providers/Microsoft.Compute/Locations/${where}/Publishers/${publisher}/ArtifactTypes/VMImage/Offers/${offer}/Skus/${variant}/Versions/${name}` })));
    }

    // --- resource groups
    if (method === "GET" && restLower === "/resourcegroups") {
      const wrong = wants(API_VERSIONS.resources);
      if (wrong !== null) return wrong;
      const filter = url.searchParams.get("$filter") ?? "";
      const tagName = /tagName eq '([^']+)'/.exec(filter)?.[1];
      const tagValue = /tagValue eq '([^']+)'/.exec(filter)?.[1];
      const matching = [...groups.values()].filter((group) => tagName === undefined || (Object.hasOwn(group.tags, tagName) && (tagValue === undefined || group.tags[tagName] === tagValue)));
      return page(url, matching.map(groupView));
    }
    const groupRoute = /^\/resourcegroups\/([^/]+)$/i.exec(rest);
    if (groupRoute !== null) {
      const wrong = wants(API_VERSIONS.resources);
      if (wrong !== null) return wrong;
      const name = groupRoute[1]!;
      const group = groups.get(name.toLowerCase());
      if (method === "GET") return group === undefined ? error(404, "ResourceGroupNotFound", `Resource group '${name}' could not be found.`) : Response.json(groupView(group));
      if (method === "PUT") {
        const input = body as { location?: string; tags?: Tags };
        if (group !== undefined) {
          if (input.location !== group.location) return error(409, "InvalidResourceGroupLocation", `Invalid resource group location '${input.location}'. The Resource group already exists in location '${group.location}'.`);
          group.tags = input.tags ?? {};
          return Response.json(groupView(group));
        }
        if (!LOCATIONS.some((entry) => entry.name === input.location)) return error(400, "LocationNotAvailableForResourceGroup", `The provided location '${input.location}' is not available for resource group.`);
        const created: FakeGroup = { name, location: input.location!, tags: input.tags ?? {}, state: "Succeeded" };
        groups.set(name.toLowerCase(), created);
        return Response.json(groupView(created), { status: 201 });
      }
      if (method === "DELETE") {
        if (group === undefined) return error(404, "ResourceGroupNotFound", `Resource group '${name}' could not be found.`);
        group.state = "Deleting";
        const poll = locationOperation(() => {
          deleteFromGroup(group.name);
          groups.delete(group.name.toLowerCase());
        });
        return new Response(null, { status: 202, headers: { Location: poll, "Retry-After": "15" } });
      }
    }
    const contentsRoute = /^\/resourcegroups\/([^/]+)\/resources$/i.exec(rest);
    if (method === "GET" && contentsRoute !== null) {
      const wrong = wants(API_VERSIONS.resources);
      if (wrong !== null) return wrong;
      const name = contentsRoute[1]!;
      if (!groups.has(name.toLowerCase())) return error(404, "ResourceGroupNotFound", `Resource group '${name}' could not be found.`);
      return page(url, [...resources.values()].filter((resource) => resource.group.toLowerCase() === name.toLowerCase()).map((resource) => ({ id: resource.id, name: resource.name, type: resource.type, location: resource.location, tags: resource.tags, ...(resource.managedBy === undefined ? {} : { managedBy: resource.managedBy }) })));
    }

    // --- tags at a resource's scope
    const tagsRoute = /^(\/resourcegroups\/[^/]+\/providers\/.+)\/providers\/microsoft\.resources\/tags\/default$/i.exec(rest);
    if (tagsRoute !== null) {
      const wrong = wants(API_VERSIONS.resources);
      if (wrong !== null) return wrong;
      const target = resources.get(resourceKey(`/subscriptions/${SUBSCRIPTION}${tagsRoute[1]}`));
      if (target === undefined) return error(404, "ResourceNotFound", "The resource was not found.");
      if (method === "PATCH") {
        const input = body as { operation?: string; properties?: { tags?: Tags } };
        if (input.operation !== "Merge") return error(400, "InvalidRequestContent", "only Merge is faked");
        target.tags = { ...target.tags, ...(input.properties?.tags ?? {}) };
      } else if (method !== "GET") {
        return error(405, "MethodNotAllowed", "not faked");
      }
      return Response.json({ id: `${target.id}/providers/Microsoft.Resources/tags/default`, name: "default", type: "Microsoft.Resources/tags", properties: { tags: target.tags } });
    }

    // --- resources in a group
    const resourceRoute = /^\/resourcegroups\/([^/]+)\/providers\/(microsoft\.network|microsoft\.compute)\/([a-z]+)\/([^/]+)$/i.exec(rest);
    if (resourceRoute !== null) {
      const [, groupName, provider, type, name] = resourceRoute as unknown as [string, string, string, string, string];
      const isCompute = provider.toLowerCase() === "microsoft.compute";
      const wrong = wants(isCompute ? API_VERSIONS.compute : API_VERSIONS.network);
      if (wrong !== null) return wrong;
      const canonicalProvider = isCompute ? "Microsoft.Compute" : "Microsoft.Network";
      const id = resourceId(groupName, canonicalProvider, type, name);
      const existing = resources.get(resourceKey(id));
      const fullType = `${canonicalProvider}/${type}`;
      const missing = () => error(404, "ResourceNotFound", `The Resource '${fullType}/${name}' under resource group '${groupName}' was not found.`);

      if (method === "GET") {
        if (existing === undefined) return missing();
        const making = existing.pending === undefined ? undefined : operations.get(existing.pending);
        if (making !== undefined) progress(making);
        return Response.json(type.toLowerCase() === "virtualmachines" ? vmView(existing, url.searchParams.get("$expand") === "instanceView") : view(existing));
      }
      if (method === "DELETE") {
        if (existing === undefined) return new Response(null, { status: 204 });
        const poll = locationOperation(() => {
          resources.delete(resourceKey(id));
          if (type.toLowerCase() === "virtualmachines") {
            for (const [key, resource] of resources) if (resource.managedBy?.toLowerCase() === id.toLowerCase()) resources.delete(key);
          }
        });
        return new Response(null, { status: 202, headers: { Location: poll, "Retry-After": "10" } });
      }
      if (method !== "PUT") return error(405, "MethodNotAllowed", "not faked");

      const group = groups.get(groupName.toLowerCase());
      if (group === undefined) return error(404, "ResourceGroupNotFound", `Resource group '${groupName}' could not be found.`);
      if (providers[canonicalProvider.toLowerCase()] !== "Registered") return unregistered(canonicalProvider);
      const input = body as { location?: string; tags?: Tags; sku?: unknown; properties?: Record<string, unknown> };
      if (input.location !== group.location) return error(400, "InvalidLocation", `The location '${input.location}' of the resource does not match its resource group's '${group.location}'.`);

      if (type.toLowerCase() === "virtualmachines") {
        if (existing !== undefined && request.headers.get("if-none-match") === "*") return error(412, "PreconditionFailed", "The resource already exists and If-None-Match: * was given.");
        const properties = input.properties as {
          hardwareProfile?: { vmSize?: string };
          storageProfile?: { imageReference?: { publisher?: string; offer?: string; sku?: string; version?: string }; osDisk?: { name?: string; deleteOption?: string; managedDisk?: { storageAccountType?: string } } };
          osProfile?: { computerName?: string; adminUsername?: string; adminPassword?: string; customData?: string; linuxConfiguration?: { disablePasswordAuthentication?: boolean; ssh?: { publicKeys?: { path?: string; keyData?: string }[] } } };
          networkProfile?: { networkInterfaces?: { id?: string }[] };
        };
        const size = SIZES.find((candidate) => candidate.name === properties.hardwareProfile?.vmSize);
        if (size === undefined || settings.restricted.has(size.name) || settings.restricted.has(`${group.location}/${size.name}`)) {
          return error(409, "SkuNotAvailable", `The requested VM size for resource 'Following SKUs have failed for Capacity Restrictions: ${properties.hardwareProfile?.vmSize}' is currently not available in location '${group.location}'. Please try another size or deploy to a different location or different zone. See https://aka.ms/azureskunotavailable for details.`);
        }
        const family = usage(size.family);
        const cores = usage("cores");
        if (family.used + size.vcpus > family.limit || cores.used + size.vcpus > cores.limit) {
          return error(409, "OperationNotAllowed", `Operation could not be completed as it results in exceeding approved ${size.family} Cores quota. Additional details - Deployment Model: Resource Manager, Location: ${group.location}, Current Limit: ${family.limit}, Current Usage: ${family.used}, Additional Required: ${size.vcpus}.`);
        }
        const admin = properties.osProfile?.adminUsername ?? "";
        if (DISALLOWED_ADMINS.has(admin)) return error(400, "InvalidParameter", `The Admin Username specified is not allowed.`, { details: [{ code: "InvalidParameter", target: "adminUsername", message: "The Admin Username specified is not allowed." }] });
        const keys = properties.osProfile?.linuxConfiguration?.ssh?.publicKeys ?? [];
        if (keys.length === 0 || keys.some((key) => !/^(ssh-rsa|ssh-ed25519) /.test(key.keyData ?? ""))) return error(400, "InvalidParameter", "The value of parameter linuxConfiguration.ssh.publicKeys.keyData is invalid.");
        const image = properties.storageProfile?.imageReference;
        if (!settings.images.has(`${image?.publisher}:${image?.offer}:${image?.sku}`)) return error(404, "PlatformImageNotFound", "The platform image requested is not available.");
        const nic = properties.networkProfile?.networkInterfaces?.[0]?.id ?? "";
        if (!resources.has(resourceKey(nic))) return error(400, "InvalidResourceReference", `Resource ${nic} referenced by resource ${id} was not found.`);
        const diskId = resourceId(groupName, "Microsoft.Compute", "disks", properties.storageProfile?.osDisk?.name ?? `${name}_OsDisk_1`);
        const vm: FakeResource = {
          id,
          name,
          type: fullType,
          group: groupName,
          location: group.location,
          tags: input.tags ?? {},
          properties: {
            ...properties,
            vmId: `5a1b2c3d-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
            provisioningState: "Creating",
            storageProfile: { ...properties.storageProfile, osDisk: { ...properties.storageProfile?.osDisk, osType: "Linux", managedDisk: { ...properties.storageProfile?.osDisk?.managedDisk, id: diskId } } },
            instanceView: instanceView("Creating", "starting"),
          },
        };
        resources.set(resourceKey(id), vm);
        family.used += size.vcpus;
        cores.used += size.vcpus;
        const failure = settings.failVm;
        settings.failVm = null;
        const making = operation(
          "Microsoft.Compute",
          group.location,
          () => {
            vm.properties.provisioningState = "Succeeded";
            vm.properties.instanceView = instanceView("Succeeded", settings.power);
            resources.set(resourceKey(diskId), { id: diskId, name: diskId.split("/").at(-1)!, type: "Microsoft.Compute/disks", group: groupName, location: group.location, tags: {}, managedBy: id, properties: { provisioningState: "Succeeded", diskSizeGB: 30 } });
          },
          failure,
          () => {
            vm.properties.provisioningState = "Failed";
            vm.properties.instanceView = instanceView("Failed", null);
          },
        );
        vm.pending = making.id;
        return Response.json(vmView(vm, false), { status: 201, headers: { "Azure-AsyncOperation": making.url, "Retry-After": settings.retryAfter } });
      }

      // The network's resources: checked for their references, created in an operation.
      const properties = { ...(input.properties ?? {}) } as Record<string, unknown>;
      if (type.toLowerCase() === "networkinterfaces") {
        const configuration = (properties.ipConfigurations as { properties?: { subnet?: { id?: string }; publicIPAddress?: { id?: string } } }[] | undefined)?.[0]?.properties;
        const subnet = configuration?.subnet?.id ?? "";
        const network = subnet.replace(/\/subnets\/[^/]+$/i, "");
        const nsg = (properties.networkSecurityGroup as { id?: string } | undefined)?.id ?? "";
        for (const reference of [network, configuration?.publicIPAddress?.id ?? "", nsg]) {
          if (!resources.has(resourceKey(reference))) return error(400, "InvalidResourceReference", `Resource ${reference} referenced by resource ${id} was not found.`);
        }
      }
      const resource: FakeResource = { id, name, type: fullType, group: groupName, location: group.location, tags: input.tags ?? {}, ...(input.sku === undefined ? {} : { sku: input.sku }), properties: { ...properties, provisioningState: "Updating" } };
      const status = existing === undefined ? 201 : 200;
      resources.set(resourceKey(id), resource);
      const address = `203.0.113.${serial++}`;
      const making = operation("Microsoft.Network", group.location, () => {
        resource.properties.provisioningState = "Succeeded";
        if (type.toLowerCase() === "publicipaddresses") resource.properties.ipAddress = address;
      });
      resource.pending = making.id;
      return Response.json(view(resource), { status, headers: { "Azure-AsyncOperation": making.url, "Retry-After": settings.retryAfter } });
    }

    return error(404, "NoRegisteredProviderFound", `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  origin = `http://127.0.0.1:${server.port}`;

  /** A resource of a group, as an earlier run or somebody else left it. */
  function addResource(group: string, provider: "Microsoft.Network" | "Microsoft.Compute", type: string, name: string, extra: Partial<FakeResource> = {}): FakeResource {
    const id = resourceId(group, provider, type, name);
    const resource: FakeResource = { id, name, type: `${provider}/${type}`, group, location: groups.get(group.toLowerCase())?.location ?? "germanywestcentral", tags: {}, properties: { provisioningState: "Succeeded" }, ...extra };
    resources.set(resourceKey(id), resource);
    return resource;
  }

  return {
    url: origin,
    environment: {
      AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
      AZURE_TENANT_ID: TENANT,
      AZURE_CLIENT_ID: CLIENT,
      AZURE_CLIENT_SECRET: CLIENT_SECRET,
      SITESOLIDE_AZURE_API: origin,
      SITESOLIDE_AZURE_LOGIN: origin,
      SITESOLIDE_AZURE_PRICES: origin,
    } as Record<string, string>,
    secrets: [CLIENT_SECRET],
    requests,
    groups,
    resources,
    operations,
    providers,
    issued,
    settings,
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, code: string, message: string, extra: { headers?: Record<string, string>; details?: unknown; times?: number } = {}): void {
      injected.push({ method, path, status, code, message, headers: extra.headers, details: extra.details, times: extra.times ?? 1 });
    },
    /** Resource Manager stops taking a token it issued, as it does once the token expires. */
    expire(token: string): void {
      revoked.add(token);
    },
    addGroup(name: string, extra: Partial<FakeGroup> = {}): FakeGroup {
      const group: FakeGroup = { name, location: "germanywestcentral", tags: {}, state: "Succeeded", ...extra };
      groups.set(name.toLowerCase(), group);
      return group;
    },
    addResource,
    /** A whole machine an owner, sitesolide unless said, created earlier, every resource tagged, running. */
    addMachine(name: string, extra: { owner?: string; location?: string; size?: string; power?: string; diskTagged?: boolean } = {}): void {
      const owner = extra.owner ?? "sitesolide";
      const tags = { "managed-by": owner, [`${owner}-machine`]: name };
      const group = `${owner}-${name}`;
      groups.set(group.toLowerCase(), { name: group, location: extra.location ?? "germanywestcentral", tags, state: "Succeeded" });
      const ip = `203.0.113.${serial++}`;
      addResource(group, "Microsoft.Network", "networkSecurityGroups", `${name}-nsg`, { tags });
      addResource(group, "Microsoft.Network", "virtualNetworks", `${name}-vnet`, { tags });
      addResource(group, "Microsoft.Network", "publicIPAddresses", `${name}-ip`, { tags, properties: { provisioningState: "Succeeded", ipAddress: ip, publicIPAllocationMethod: "Static" } });
      addResource(group, "Microsoft.Network", "networkInterfaces", `${name}-nic`, { tags });
      const vmId = resourceId(group, "Microsoft.Compute", "virtualMachines", name);
      const diskId = resourceId(group, "Microsoft.Compute", "disks", `${name}-osdisk`);
      addResource(group, "Microsoft.Compute", "virtualMachines", name, {
        tags,
        properties: {
          provisioningState: "Succeeded",
          hardwareProfile: { vmSize: extra.size ?? "Standard_B2als_v2" },
          storageProfile: { osDisk: { name: `${name}-osdisk`, managedDisk: { id: diskId } } },
          instanceView: instanceView("Succeeded", extra.power ?? "running"),
        },
      });
      addResource(group, "Microsoft.Compute", "disks", `${name}-osdisk`, { tags: extra.diskTagged === false ? {} : tags, managedBy: vmId });
    },
    /** Empties the subscription, the requests and the settings. */
    reset(): void {
      groups.clear();
      resources.clear();
      operations.clear();
      requests.length = 0;
      injected.length = 0;
      issued.length = 0;
      revoked.clear();
      providersReset();
      Object.assign(settings, defaults());
      serial = 10;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake, as bin/tests/cli-machine-providers.test.ts drives every provider's. */
export function createFake(): FakeProvider & FakeAzure {
  return createFakeAzure();
}
