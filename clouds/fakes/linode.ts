/**
 * A local stand-in for Akamai's Linode API v4, on a random port of the
 * loopback: the tests of the Linode provider never reach the real one.
 *
 * It keeps an account in memory (Linodes, Cloud Firewalls, the account's
 * interface setting) and answers the calls src/linode.ts makes,
 * in the shapes of https://techdocs.akamai.com/linode-api/reference/api: the
 * `{"errors": [{"reason", "field"}]}` errors, `data`, `page`, `pages` and
 * `results` on every list, filters in the `X-Filter` header, labels unique in
 * the account, a Linode that is `provisioning`, then `booting`, then
 * `running` over a few reads.
 *
 * It is stricter than the documentation where the documentation leaves a
 * choice open, so that a client relying on the lenient reading fails a test:
 * a Linode on Linode interfaces refuses the legacy `firewall_id`, a legacy
 * one refuses `network_helper`, a public interface without a firewall fails
 * when the account has no default one, an order needs one way into the disk
 * at least, and deleting a firewall never refuses, even while it protects
 * something, as the documentation says.
 *
 * Lists come back `pageSize` items a page whatever `page_size` asks, two by
 * default, so that a client that reads only the first page fails a test.
 * `fail()` makes the next matching request answer an error instead.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

/** The shape of a personal access token: 64 hexadecimal characters. */
export const FAKE_TOKEN = "f4ce0de5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";

export type FakeEntity = { id: number; label: string | null; type: string; url: string; parent_entity: { id: number; label: string; type: string; url: string } | null };

export type FakeFirewall = {
  id: number;
  label: string;
  tags: string[];
  status: string;
  rules: { inbound_policy?: string; outbound_policy?: string; inbound?: unknown[]; outbound?: unknown[] };
  entities: FakeEntity[];
};

export type FakeInstance = {
  id: number;
  label: string;
  region: string;
  type: string;
  image: string;
  status: string;
  ipv4: string[];
  ipv6: string | null;
  tags: string[];
  backups: boolean;
  interface_generation: "linode" | "legacy_config";
  /** The public Linode interface and its firewall, on Linode interfaces. */
  interfaces: { id: number; firewall_id: number | null }[];
  authorized_keys: string[];
  /** Whether the order carried a root password: the fake keeps no copy of it. */
  root_pass: boolean;
  /** What the order said of Network Helper, on Linode interfaces. */
  network_helper: boolean | null;
  /** Reads since its creation, which move it from `provisioning` to `running`. */
  polls: number;
};

export type FakeVolume = { id: number; label: string; size: number; region: string; linode_id: number | null; tags: string[] };

type Failure = { method: string; path: RegExp; status: number; reason: string; field?: string; headers?: Record<string, string>; body?: string; times: number };

type Region = { id: string; label: string; country: string; capabilities: string[]; status: string; resolvers: { ipv4: string; ipv6: string }; site_type: string };

const CORE = ["Linodes", "Block Storage", "Backups", "NodeBalancers", "Cloud Firewall", "Vlans", "VPCs", "Metadata", "Placement Group", "StackScripts", "Linode Interfaces"];
const resolvers = { ipv4: "192.0.2.53,192.0.2.54", ipv6: "2001:db8::53" };

/**
 * The regions, as GET /regions lists them in October 2026, a few of them
 * trimmed or altered for the tests: us-east without Linode interfaces, the
 * legacy profile's case; us-southeast without backups; ap-south in an
 * outage; one distributed site, which sells no Linode the wizard offers.
 */
export const REGIONS: Region[] = [
  { id: "de-fra-2", label: "Frankfurt 2", country: "de", capabilities: CORE, status: "ok", resolvers, site_type: "core" },
  { id: "fr-par", label: "Paris", country: "fr", capabilities: CORE, status: "ok", resolvers, site_type: "core" },
  { id: "nl-ams", label: "Amsterdam", country: "nl", capabilities: CORE, status: "ok", resolvers, site_type: "core" },
  { id: "br-gru", label: "Sao Paulo", country: "br", capabilities: CORE, status: "ok", resolvers, site_type: "core" },
  { id: "us-east", label: "Newark, NJ", country: "us", capabilities: CORE.filter((capability) => capability !== "Linode Interfaces"), status: "ok", resolvers, site_type: "core" },
  { id: "us-southeast", label: "Atlanta, GA", country: "us", capabilities: CORE.filter((capability) => capability !== "Backups"), status: "ok", resolvers, site_type: "core" },
  { id: "ap-south", label: "Singapore", country: "sg", capabilities: CORE, status: "outage", resolvers, site_type: "core" },
  { id: "test-edge-1", label: "Edge test site", country: "fr", capabilities: ["Linodes", "Cloud Firewall", "Distributed Plans"], status: "ok", resolvers, site_type: "distributed" },
];

const priced = (hourly: number, monthly: number | null) => ({ hourly, monthly });
const regional = (hourly: number, monthly: number | null) => [
  { id: "id-cgk", ...priced(Math.round(hourly * 1.2 * 10000) / 10000, monthly === null ? null : Math.round(monthly * 1.2 * 100) / 100) },
  { id: "br-gru", ...priced(Math.round(hourly * 1.4 * 10000) / 10000, monthly === null ? null : Math.round(monthly * 1.4 * 100) / 100) },
];

function type(id: string, label: string, kind: string, vcpus: number, memory: number, disk: number, hourly: number, monthly: number | null) {
  return {
    id,
    label,
    class: kind,
    vcpus,
    memory,
    disk,
    transfer: memory,
    network_out: 1000,
    gpus: 0,
    accelerated_devices: 0,
    successor: null,
    price: priced(hourly, monthly),
    region_prices: kind === "gpu" ? [] : regional(hourly, monthly),
    addons: { backups: { price: priced(Math.round(hourly * 0.2 * 10000) / 10000, monthly === null ? null : Math.round(monthly * 0.2 * 100) / 100), region_prices: [] } },
  };
}

/** What the fake sells, as GET /linode/types answered in October 2026, a few of each class. */
export const TYPES = [
  type("g6-nanode-1", "Nanode 1GB", "nanode", 1, 1024, 25600, 0.0075, 5),
  type("g6-standard-1", "Linode 2GB", "standard", 1, 2048, 51200, 0.018, 12),
  type("g6-standard-2", "Linode 4GB", "standard", 2, 4096, 81920, 0.036, 24),
  type("g6-standard-4", "Linode 8GB", "standard", 4, 8192, 163840, 0.072, 48),
  type("g6-standard-6", "Linode 16GB", "standard", 6, 16384, 327680, 0.144, 96),
  type("g6-standard-8", "Linode 32GB", "standard", 8, 32768, 655360, 0.288, 192),
  type("g6-dedicated-2", "Dedicated 4GB", "dedicated", 2, 4096, 81920, 0.054, 36),
  type("g7-premium-2", "Premium 4GB", "premium", 2, 4096, 81920, 0.0645, 43),
  type("g8-dedicated-4-2", "G8 Dedicated 4x2", "dedicated", 2, 4096, 41984, 0.07, null),
  type("g1-gpu-rtx6000-1", "Dedicated 32GB + RTX6000 GPU x1", "gpu", 8, 32768, 655360, 1.5, null),
];

const IMAGES = new Set(["linode/debian13", "linode/debian12", "linode/ubuntu24.04"]);

const LABEL = /^[a-zA-Z]((?!--|__|\.\.)[a-zA-Z0-9-_.])+$/;

function error(status: number, reason: string, field?: string, headers: Record<string, string> = {}): Response {
  return Response.json({ errors: [{ reason, ...(field === undefined ? {} : { field }) }] }, { status, headers });
}

/** `{"label": "web"}` and `{"tags": "managed-by:<owner>"}`: as much of X-Filter as the client uses. */
function matches(item: { label: string; tags: string[] }, filter: Record<string, unknown> | null): boolean {
  if (filter === null) return true;
  if (typeof filter.label === "string" && item.label !== filter.label) return false;
  if (typeof filter.tags === "string" && !item.tags.includes(filter.tags)) return false;
  return true;
}

export type FakeLinode = ReturnType<typeof createFakeLinode>;

export function createFakeLinode(options: { pageSize?: number; bootPolls?: number } = {}) {
  let nextId = 1000;
  let serial = 10;
  const instances: FakeInstance[] = [];
  const firewalls: FakeFirewall[] = [];
  const volumes: FakeVolume[] = [];
  const requests: FakeRequest[] = [];
  const failures: Failure[] = [];
  const regions: Region[] = structuredClone(REGIONS);
  const settings: {
    pageSize: number;
    bootPolls: number;
    /** The account's `interfaces_for_new_linodes`; new accounts start on Linode interfaces. */
    interfaces: "legacy_config_only" | "legacy_config_default_but_linode_allowed" | "linode_default_but_legacy_config_allowed" | "linode_only";
    /** The account's default firewall for public interfaces, or null. */
    defaultFirewall: number | null;
    /** The plans each region lists as unavailable. */
    unavailable: { region: string; plan: string }[];
    /** The next order creates the Linode, then answers 500: an order that failed on the way back. */
    createThenFail: boolean;
  } = {
    pageSize: options.pageSize ?? 2,
    bootPolls: options.bootPolls ?? 2,
    interfaces: "linode_default_but_legacy_config_allowed",
    defaultFirewall: null,
    unavailable: [],
    createThenFail: false,
  };

  const page = <T>(url: URL, items: T[]): Response => {
    const size = settings.pageSize;
    const pages = Math.max(1, Math.ceil(items.length / size));
    const current = Math.min(pages, Math.max(1, Number(url.searchParams.get("page") ?? "1")));
    return Response.json({ data: items.slice((current - 1) * size, current * size), page: current, pages, results: items.length });
  };

  const instanceUrl = (id: number) => `/v4/linode/instances/${id}`;

  const instanceView = (instance: FakeInstance) => {
    const kind = TYPES.find((candidate) => candidate.id === instance.type);
    return {
      id: instance.id,
      label: instance.label,
      region: instance.region,
      type: instance.type,
      image: instance.image,
      status: instance.status,
      ipv4: instance.ipv4,
      ipv6: instance.ipv6,
      tags: instance.tags,
      group: "",
      hypervisor: "kvm",
      watchdog_enabled: true,
      created: "2026-10-21T10:00:00",
      updated: "2026-10-21T10:00:00",
      specs: { vcpus: kind?.vcpus ?? 1, memory: kind?.memory ?? 2048, disk: kind?.disk ?? 51200, transfer: kind?.transfer ?? 2000, gpus: 0, accelerated_devices: 0 },
      alerts: { cpu: 90, io: 10000, network_in: 10, network_out: 10, transfer_quota: 80 },
      backups: { enabled: instance.backups, available: false, schedule: { day: null, window: null }, last_successful: null },
      host_uuid: "3a3ddd59d9a78bb8de041391075df44de62bfec8",
      has_user_data: false,
      disk_encryption: "enabled",
      lke_cluster_id: null,
      placement_group: null,
      site_type: "core",
      capabilities: [],
      interface_generation: instance.interface_generation,
      maintenance_policy: "linode/migrate",
    };
  };

  const firewallView = (firewall: FakeFirewall) => ({
    id: firewall.id,
    label: firewall.label,
    status: firewall.status,
    created: "2026-10-21T10:00:00",
    updated: "2026-10-21T10:00:00",
    tags: firewall.tags,
    rules: { fingerprint: "4ef67a0a", version: 1, ...firewall.rules },
    entities: firewall.entities,
  });

  /** The firewall entity a Linode's protection reads as: the Linode itself, or its public interface. */
  const attach = (instance: FakeInstance, firewallId: number, interfaceId: number | null): void => {
    const firewall = firewalls.find((candidate) => candidate.id === firewallId);
    if (firewall === undefined) return;
    const parent = { id: instance.id, label: instance.label, type: "linode", url: instanceUrl(instance.id) };
    firewall.entities.push(
      interfaceId === null
        ? { ...parent, parent_entity: null }
        : { id: interfaceId, label: null, type: "linode_interface", url: `${instanceUrl(instance.id)}/interfaces/${interfaceId}`, parent_entity: parent },
    );
  };

  const detach = (instance: FakeInstance): void => {
    for (const firewall of firewalls) {
      firewall.entities = firewall.entities.filter((entity) => !(entity.type === "linode" && entity.id === instance.id) && entity.parent_entity?.id !== instance.id);
    }
  };

  const addresses = (): { ipv4: string; ipv6: string } => {
    serial++;
    return { ipv4: `203.0.113.${serial}`, ipv6: `2001:db8::f03c:91ff:fe00:${serial.toString(16)}/128` };
  };

  const tagsProblem = (tags: unknown): string | null => {
    if (tags === undefined) return null;
    if (!Array.isArray(tags)) return "tags must be a list";
    for (const tag of tags) if (typeof tag !== "string" || tag.length < 3 || tag.length > 50) return "Length must be 3-50 characters";
    return null;
  };

  /** POST /linode/instances, as strict as the documentation lets it be. */
  function order(input: Record<string, unknown>): Response {
    const label = input.label;
    if (typeof label !== "string" || label.length < 3 || label.length > 64 || !LABEL.test(label) || !/[a-zA-Z0-9]$/.test(label)) return error(400, "Label must be 3-64 characters, start with a letter and end with a letter or a digit", "label");
    if (instances.some((instance) => instance.label.toLowerCase() === label.toLowerCase())) return error(400, "Label must be unique among your linodes", "label");
    const region = regions.find((candidate) => candidate.id === input.region);
    if (region === undefined || !region.capabilities.includes("Linodes")) return error(400, "region is not valid", "region");
    const kind = TYPES.find((candidate) => candidate.id === input.type);
    if (kind === undefined) return error(400, "A valid plan type by that ID was not found", "type");
    if (settings.unavailable.some((entry) => entry.region === region.id && entry.plan === kind.id)) return error(400, "We're sorry, this plan is currently unavailable in that region.", "type");
    if (typeof input.image !== "string" || !IMAGES.has(input.image)) return error(400, "image is not valid", "image");
    if (input.root_pass === undefined && !Array.isArray(input.authorized_keys) && !Array.isArray(input.authorized_users)) {
      return error(400, "You need to provide at least one authentication mechanism for disk access: a root_pass, authorized_keys, or authorized_users", "root_pass");
    }
    if (input.root_pass !== undefined && (typeof input.root_pass !== "string" || input.root_pass.length < 7 || input.root_pass.length > 128)) return error(400, "Password must be between 7 and 128 characters", "root_pass");
    if (input.authorized_keys !== undefined && !Array.isArray(input.authorized_keys)) return error(400, "authorized_keys must be a list", "authorized_keys");
    const tags = tagsProblem(input.tags);
    if (tags !== null) return error(400, tags, "tags");
    if (input.backups_enabled === true && !region.capabilities.includes("Backups")) return error(400, "Backups are not available in this region", "backups_enabled");

    const preferred = settings.interfaces.startsWith("linode") ? "linode" : "legacy_config";
    const generation = (input.interface_generation ?? preferred) as string;
    if (generation !== "linode" && generation !== "legacy_config") return error(400, "interface_generation must be linode or legacy_config", "interface_generation");
    if (generation === "linode" && settings.interfaces === "legacy_config_only") return error(400, "This account only allows legacy configuration interfaces for new Linodes", "interface_generation");
    if (generation === "legacy_config" && settings.interfaces === "linode_only") return error(400, "This account only allows Linode interfaces for new Linodes", "interface_generation");
    if (generation === "linode" && !region.capabilities.includes("Linode Interfaces")) return error(400, "Linode interfaces are not available in this region", "interface_generation");

    let firewallId: number | null = null;
    if (generation === "linode") {
      if (input.firewall_id !== undefined) return error(400, "firewall_id is only for legacy configuration interfaces: assign a firewall to an interface", "firewall_id");
      const list = Array.isArray(input.interfaces) ? (input.interfaces as Record<string, unknown>[]) : [];
      const index = list.findIndex((entry) => entry.public !== undefined);
      if (index === -1) return error(400, "A Linode needs a public interface to be reachable", "interfaces");
      const wanted = list[index]!.firewall_id;
      if (wanted === undefined || wanted === null) {
        if (settings.defaultFirewall === null) return error(400, "No default firewall is available: set firewall_id, or -1 for none", `interfaces[${index}].firewall_id`);
        firewallId = settings.defaultFirewall;
      } else if (wanted !== -1) {
        if (!firewalls.some((firewall) => firewall.id === wanted)) return error(400, "Firewall not found", `interfaces[${index}].firewall_id`);
        firewallId = wanted as number;
      }
    } else {
      if (input.network_helper !== undefined) return error(400, "network_helper is only for Linode interfaces", "network_helper");
      if (Array.isArray(input.interfaces) && input.interfaces.some((entry) => (entry as Record<string, unknown>).public !== undefined)) return error(400, "Linode interfaces need interface_generation linode", "interfaces");
      const wanted = input.firewall_id;
      if (wanted !== undefined && wanted !== null && wanted !== -1) {
        if (!firewalls.some((firewall) => firewall.id === wanted)) return error(400, "Firewall not found", "firewall_id");
        firewallId = wanted as number;
      }
    }

    const address = addresses();
    const instance: FakeInstance = {
      id: nextId++,
      label,
      region: region.id,
      type: kind.id,
      image: input.image,
      status: "provisioning",
      ipv4: [address.ipv4],
      ipv6: address.ipv6,
      tags: (input.tags as string[] | undefined) ?? [],
      backups: input.backups_enabled === true,
      interface_generation: generation,
      interfaces: [],
      authorized_keys: (input.authorized_keys as string[] | undefined) ?? [],
      root_pass: typeof input.root_pass === "string",
      network_helper: typeof input.network_helper === "boolean" ? input.network_helper : null,
      polls: 0,
    };
    if (generation === "linode") instance.interfaces.push({ id: nextId++, firewall_id: firewallId });
    instances.push(instance);
    if (firewallId !== null) attach(instance, firewallId, instance.interfaces[0]?.id ?? null);
    if (settings.createThenFail) {
      settings.createThenFail = false;
      return error(500, "Internal Server Error");
    }
    return Response.json(instanceView(instance));
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v4/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "Invalid JSON");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ method, path, search: url.search, body, headers });

    if (request.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) return error(401, "Invalid Token");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      if (failure.body !== undefined) return new Response(failure.body, { status: failure.status, headers: { "Content-Type": "text/html", ...(failure.headers ?? {}) } });
      return error(failure.status, failure.reason, failure.field, failure.headers ?? {});
    }

    let filter: Record<string, unknown> | null = null;
    const raw = request.headers.get("x-filter");
    if (raw !== null) {
      try {
        filter = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return error(400, "Invalid X-Filter", "X-Filter");
      }
    }
    const id = Number(/^\/[a-z/]+\/([0-9]+)(?:\/|$)/.exec(path)?.[1] ?? "0");

    if (method === "GET" && path === "/regions") return page(url, regions);
    if (method === "GET" && /^\/regions\/[a-z0-9-]+\/availability$/.test(path)) {
      const region = path.split("/")[2]!;
      if (!regions.some((candidate) => candidate.id === region)) return error(404, "Not found");
      // The plans of limited availability, as the documented example lists them.
      return Response.json([
        { region, plan: "g1-gpu-rtx6000-1", available: false },
        { region, plan: "g6-standard-1", available: !settings.unavailable.some((entry) => entry.region === region && entry.plan === "g6-standard-1") },
        ...settings.unavailable.filter((entry) => entry.region === region && entry.plan !== "g6-standard-1").map((entry) => ({ region, plan: entry.plan, available: false })),
      ]);
    }
    if (method === "GET" && path === "/linode/types") return page(url, TYPES);

    // --- Linodes
    if (method === "GET" && path === "/linode/instances") return page(url, instances.filter((instance) => matches(instance, filter)).map(instanceView));
    if (method === "POST" && path === "/linode/instances") return order((body ?? {}) as Record<string, unknown>);
    if (method === "GET" && /^\/linode\/instances\/[0-9]+$/.test(path)) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (instance === undefined) return error(404, "Not found");
      if (instance.status === "provisioning" || instance.status === "booting") {
        instance.polls++;
        if (instance.polls >= settings.bootPolls) instance.status = "running";
        else if (instance.polls * 2 >= settings.bootPolls) instance.status = "booting";
      }
      return Response.json(instanceView(instance));
    }
    if (method === "DELETE" && /^\/linode\/instances\/[0-9]+$/.test(path)) {
      const index = instances.findIndex((candidate) => candidate.id === id);
      if (index === -1) return error(404, "Not found");
      detach(instances[index]!);
      // Its volumes are detached, not deleted, as the documentation says.
      for (const volume of volumes) if (volume.linode_id === id) volume.linode_id = null;
      instances.splice(index, 1);
      return Response.json({});
    }
    if (method === "GET" && /^\/linode\/instances\/[0-9]+\/volumes$/.test(path)) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (instance === undefined) return error(404, "Not found");
      return page(
        url,
        volumes
          .filter((volume) => volume.linode_id === id)
          .map((volume) => ({ ...volume, linode_label: instance.label, status: "active", filesystem_path: `/dev/disk/by-id/scsi-0Linode_Volume_${volume.label}`, hardware_type: "nvme", encryption: "enabled", created: "2026-10-21T10:00:00", updated: "2026-10-21T10:00:00" })),
      );
    }
    if (method === "POST" && /^\/linode\/instances\/[0-9]+\/backups\/enable$/.test(path)) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (instance === undefined) return error(404, "Not found");
      instance.backups = true;
      return Response.json({});
    }

    // --- firewalls
    if (method === "GET" && path === "/networking/firewalls") return page(url, firewalls.filter((firewall) => matches(firewall, filter)).map(firewallView));
    if (method === "POST" && path === "/networking/firewalls") {
      const input = (body ?? {}) as { label?: unknown; tags?: unknown; rules?: FakeFirewall["rules"] };
      const label = input.label;
      if (typeof label !== "string" || label.length < 3 || label.length > 32 || !LABEL.test(label)) return error(400, "Label must be between 3 and 32 characters", "label");
      if (firewalls.some((firewall) => firewall.label.toLowerCase() === label.toLowerCase())) return error(400, "Label must be unique", "label");
      const rules = input.rules;
      if (rules === undefined || rules.inbound_policy === undefined || rules.outbound_policy === undefined) return error(400, "rules need inbound_policy and outbound_policy", "rules");
      for (const [index, rule] of (rules.inbound ?? []).entries()) {
        const { protocol, ports, addresses: sources } = rule as { protocol?: string; ports?: string; addresses?: { ipv4?: unknown; ipv6?: unknown } };
        if ((protocol === "ICMP" || protocol === "IPENCAP") && ports !== undefined) return error(400, "Ports must be omitted for ICMP or IPENCAP", `rules.inbound[${index}].ports`);
        if (sources === undefined || (sources.ipv4 === undefined && sources.ipv6 === undefined)) return error(400, "Must contain ipv4, ipv6, or both", `rules.inbound[${index}].addresses`);
      }
      const tags = tagsProblem(input.tags);
      if (tags !== null) return error(400, tags, "tags");
      const firewall: FakeFirewall = { id: nextId++, label, tags: (input.tags as string[] | undefined) ?? [], status: "enabled", rules, entities: [] };
      firewalls.push(firewall);
      return Response.json(firewallView(firewall));
    }
    if (method === "GET" && /^\/networking\/firewalls\/[0-9]+$/.test(path)) {
      const firewall = firewalls.find((candidate) => candidate.id === id);
      return firewall === undefined ? error(404, "Not found") : Response.json(firewallView(firewall));
    }
    if (method === "DELETE" && /^\/networking\/firewalls\/[0-9]+$/.test(path)) {
      const index = firewalls.findIndex((candidate) => candidate.id === id);
      if (index === -1) return error(404, "Not found");
      if (settings.defaultFirewall === id && firewalls[index]!.entities.length > 0) return error(400, "An assigned default firewall can't be deleted");
      firewalls.splice(index, 1);
      return Response.json({});
    }

    return error(404, `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}/v4`;

  return {
    url,
    environment: { LINODE_TOKEN: FAKE_TOKEN, SITESOLIDE_LINODE_API: url },
    secrets: [FAKE_TOKEN],
    instances,
    firewalls,
    volumes,
    regions,
    requests,
    settings,
    /** The next `times` requests matching answer this error instead; with `body`, that text rather than the API's JSON. */
    fail(method: string, path: RegExp, status: number, reason: string, extra: { field?: string; headers?: Record<string, string>; body?: string; times?: number } = {}): void {
      failures.push({ method, path, status, reason, field: extra.field, headers: extra.headers, body: extra.body, times: extra.times ?? 1 });
    },
    /** A Linode that exists before the test, ours or not, running, on Linode interfaces unless told otherwise. */
    addInstance(input: Partial<FakeInstance> & { label: string }, firewall?: number): FakeInstance {
      const address = addresses();
      const instance: FakeInstance = {
        id: nextId++,
        region: "fr-par",
        type: "g6-standard-2",
        image: "linode/debian13",
        status: "running",
        ipv4: [address.ipv4],
        ipv6: address.ipv6,
        tags: [],
        backups: false,
        interface_generation: "linode",
        interfaces: [],
        authorized_keys: [],
        root_pass: false,
        network_helper: null,
        polls: 0,
        ...input,
      };
      if (instance.interface_generation === "linode" && instance.interfaces.length === 0) instance.interfaces.push({ id: nextId++, firewall_id: firewall ?? null });
      instances.push(instance);
      if (firewall !== undefined) attach(instance, firewall, instance.interface_generation === "linode" ? instance.interfaces[0]!.id : null);
      return instance;
    },
    /** A Block Storage volume, attached to a Linode or not. */
    addVolume(input: Partial<FakeVolume> & { label: string }): FakeVolume {
      const volume: FakeVolume = { id: nextId++, size: 20, region: "fr-par", linode_id: null, tags: [], ...input };
      volumes.push(volume);
      return volume;
    },
    addFirewall(input: Partial<FakeFirewall> & { label: string }): FakeFirewall {
      const firewall: FakeFirewall = { id: nextId++, tags: [], status: "enabled", rules: { inbound_policy: "DROP", outbound_policy: "ACCEPT", inbound: [], outbound: [] }, entities: [], ...input };
      firewalls.push(firewall);
      return firewall;
    },
    reset(): void {
      instances.length = 0;
      firewalls.length = 0;
      volumes.length = 0;
      requests.length = 0;
      failures.length = 0;
      regions.splice(0, regions.length, ...structuredClone(REGIONS));
      settings.pageSize = options.pageSize ?? 2;
      settings.bootPolls = options.bootPolls ?? 2;
      settings.interfaces = "linode_default_but_legacy_config_allowed";
      settings.defaultFirewall = null;
      settings.unavailable = [];
      settings.createThenFail = false;
      serial = 10;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as every provider's fake is seen, for the tests that run them all the same way. */
export function createFake(): FakeProvider {
  return createFakeLinode();
}
