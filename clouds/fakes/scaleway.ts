/**
 * A local stand-in for the Scaleway APIs src/scaleway.ts calls, on a random
 * port of the loopback: the tests never reach the real ones.
 *
 * It keeps a project in memory (IAM SSH keys, and per zone servers, flexible
 * IPs, security groups, Block Storage and local volumes, Elastic Metal
 * servers) and answers in the shapes of Scaleway's documentation and of the
 * answers the scw CLI's recorded tests hold: `{"type", "message", ...}`
 * errors, X-Total-Count and Link headers on the Instance API's lists,
 * `total_count` on the others', servers created stopped that take a few
 * reads to start or stop, volumes that take a read to be created or
 * detached, names that are not unique, an Elastic Metal that takes reads to
 * be delivered, then installed, then deleted.
 *
 * Every list, the catalogues included, comes back `pageSize` items a page
 * whatever the client asks, two by default, so that a client that reads only
 * the first page fails a test. `fail()` makes the next matching request
 * answer an error instead.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

/** Shaped as Scaleway's are, UUIDs; neither is anyone's. */
export const FAKE_SECRET = "5c3e1a9b-7d24-4f60-9b1e-0a8c2d4f6e13";
export const FAKE_PROJECT = "0b7d2c4e-3f15-4a86-b9d0-6e2f8a1c5d37";
export const OTHER_PROJECT = "9e4a6c1b-2d73-4f58-8a0e-7b5c3d9f1e26";
const ORGANIZATION = "4d8f0a2c-6b1e-4c37-9e5a-1f3b7d9c2a64";

/** The day every resource of the fake was created. */
const CREATED = "2026-10-21T10:00:00.000000+00:00";
const MODIFIED = "2026-10-21T10:05:00.000000+00:00";

const GIB = 1024 ** 3;

type ServerType = {
  alt_names: string[];
  arch: string;
  ncpus: number;
  ram: number;
  gpu: number;
  volumes_constraint: { min_size: number; max_size: number };
  monthly_price: number;
  hourly_price: number;
  end_of_service: boolean;
  network: { ipv6_support: boolean };
  capabilities: { block_storage: boolean; boot_types: string[] };
};

const type = (arch: string, ncpus: number, ram: number, hourly: number, extra: Partial<ServerType> = {}): ServerType => ({
  alt_names: [],
  arch,
  ncpus,
  ram: ram * GIB,
  gpu: 0,
  volumes_constraint: { min_size: 0, max_size: 0 },
  monthly_price: Math.round(hourly * 730 * 100_000) / 100_000,
  hourly_price: hourly,
  end_of_service: false,
  network: { ipv6_support: true },
  capabilities: { block_storage: true, boot_types: ["local", "rescue"] },
  ...extra,
});

/** What the fake sells, as of October 2026, close enough to the real catalogue to read like it. */
export const SERVER_TYPES: Record<string, ServerType> = {
  "DEV1-S": type("x86_64", 2, 2, 0.008976, { volumes_constraint: { min_size: 0, max_size: 20_000_000_000 } }),
  "DEV1-M": type("x86_64", 3, 4, 0.020196, { volumes_constraint: { min_size: 0, max_size: 40_000_000_000 } }),
  "PLAY2-PICO": type("x86_64", 1, 2, 0.01428),
  "PLAY2-NANO": type("x86_64", 2, 4, 0.02754),
  "BASIC2-A2C-4G": type("arm64", 2, 4, 0.023),
  "BASIC3-X2C-4G": type("x86_64", 2, 4, 0.039449),
  "POP2-2C-8G": type("x86_64", 2, 8, 0.0735),
  "POP2-2C-8G-WIN": type("x86_64", 2, 8, 0.1823),
  "STARDUST1-S": type("x86_64", 1, 1, 0.00015),
  "L4-1-24G": type("x86_64", 8, 48, 0.75, { gpu: 1 }),
  "START1-S": type("x86_64", 2, 2, 0.006, { end_of_service: true }),
};

/** What each zone sells, and how much of it is left. */
export const CATALOGUE: Record<string, Record<string, "available" | "scarce" | "shortage">> = {
  "fr-par-1": {
    "DEV1-S": "available",
    "DEV1-M": "available",
    "PLAY2-PICO": "scarce",
    "PLAY2-NANO": "scarce",
    "BASIC2-A2C-4G": "available",
    "BASIC3-X2C-4G": "scarce",
    "POP2-2C-8G": "scarce",
    "POP2-2C-8G-WIN": "available",
    "STARDUST1-S": "available",
    "L4-1-24G": "available",
    "START1-S": "available",
  },
  "fr-par-2": { "DEV1-S": "available", "PLAY2-PICO": "shortage", "PLAY2-NANO": "available", "POP2-2C-8G": "available" },
  "nl-ams-1": { "DEV1-S": "available", "PLAY2-PICO": "available", "BASIC2-A2C-4G": "available" },
  "nl-ams-3": { "PLAY2-PICO": "available", "POP2-2C-8G": "available" },
};

const X86_TYPES = Object.entries(SERVER_TYPES)
  .filter(([, entry]) => entry.arch === "x86_64")
  .map(([name]) => name);
const ARM_TYPES = Object.entries(SERVER_TYPES)
  .filter(([, entry]) => entry.arch === "arm64")
  .map(([name]) => name);

/** The Marketplace's Debian 13, per zone and architecture, ids made up. */
export const LOCAL_IMAGES = Object.keys(CATALOGUE).flatMap((zone, index) => [
  { id: `a7f47d5c-ffec-43b4-942e-32df38a782${String(index).padStart(2, "0")}`, arch: "x86_64", zone, compatible_commercial_types: X86_TYPES, label: "debian_trixie", type: "instance_sbs" },
  { id: `6a47ea3a-c145-478e-9e3c-0bde831dd6${String(index).padStart(2, "0")}`, arch: "arm64", zone, compatible_commercial_types: ARM_TYPES, label: "debian_trixie", type: "instance_sbs" },
  // A local image boots an l_ssd root, the volume kind of the types that have one.
  { id: `c3b1e2f0-5d4a-4e8b-9f61-7a2d0c4e95${String(index).padStart(2, "0")}`, arch: "x86_64", zone, compatible_commercial_types: X86_TYPES.filter((type) => SERVER_TYPES[type]!.volumes_constraint.max_size > 0), label: "debian_trixie", type: "instance_local" },
]);

/** Money as the API writes it. */
const eur = (value: number) => ({ currency_code: "EUR", units: Math.floor(value), nanos: Math.round((value - Math.floor(value)) * 1e9) });

const metalOffer = (id: string, name: string, period: "hourly" | "monthly", hourly: number, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  stock: "available" as string,
  bandwidth: 1_000_000_000,
  commercial_range: name.split("-")[1]?.toLowerCase() ?? "",
  price_per_hour: eur(period === "hourly" ? hourly : 0),
  price_per_month: eur(period === "monthly" ? Math.round(hourly * 730) : 0),
  disks: [
    { capacity: 960_000_000_000, type: "SSD" },
    { capacity: 960_000_000_000, type: "SSD" },
  ],
  enable: true,
  cpus: [{ name: "Intel Xeon E3 1220 or equiv", core_count: 4, thread_count: 4, frequency: 3100 }],
  memories: [{ capacity: 32_000_000_000, type: "DDR4", frequency: 2133, is_ecc: true }],
  quota_name: "baremetal_servers",
  incompatible_os_ids: [] as string[],
  subscription_period: period,
  fee: eur(period === "monthly" ? 49.99 : 0),
  options: [],
  tags: ["cloud-init"] as string[],
  monthly_offer_id: null,
  ...extra,
});

/**
 * The Elastic Metal offers of every zone that sells them, ids made up: each
 * name twice, by the month first and by the hour, as Scaleway publishes them.
 */
export const METAL_OFFERS = [
  metalOffer("e1000000-0000-4000-8000-000000000001", "EM-A116X-SSD", "monthly", 0.077),
  metalOffer("e1000000-0000-4000-8000-000000000002", "EM-A116X-SSD", "hourly", 0.077),
  metalOffer("e1000000-0000-4000-8000-000000000003", "EM-B112X-SSD", "hourly", 0.103, { stock: "empty" }),
  metalOffer("e1000000-0000-4000-8000-000000000004", "EM-B111X-SATA", "hourly", 0.095, { tags: [] }),
  metalOffer("e1000000-0000-4000-8000-000000000005", "EM-A210R-HDD", "monthly", 0.1),
];

const metalOs = (id: string, name: string, version: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  version,
  logo_url: "",
  ssh: { editable: true, required: true, default_value: null },
  user: { editable: true, required: false, default_value: name.toLowerCase() },
  password: { editable: true, required: false, default_value: null },
  service_user: { editable: false, required: false, default_value: null },
  service_password: { editable: false, required: false, default_value: null },
  enabled: true,
  license_required: false,
  allowed: true,
  custom_partitioning_supported: true,
  cloud_init_supported: true,
  cloud_init_version: "v1",
  ...extra,
});

/** The systems Elastic Metal installs, ids made up. */
export const METAL_OS = [
  metalOs("05000000-0000-4000-8000-000000002204", "Ubuntu", "22.04 LTS (Jammy Jellyfish)"),
  metalOs("05000000-0000-4000-8000-000000002404", "Ubuntu", "24.04 LTS (Noble Numbat)"),
  metalOs("05000000-0000-4000-8000-000000000013", "Debian", "13 (Trixie)"),
  metalOs("05000000-0000-4000-8000-000000000008", "Proxmox", "8", { cloud_init_supported: false }),
];

/** The zones Elastic Metal is sold in. */
const METAL_ZONES = ["fr-par-1", "fr-par-2", "nl-ams-1", "nl-ams-2", "pl-waw-2", "pl-waw-3"];

export type FakeMetalServer = {
  id: string;
  zone: string;
  project_id: string;
  name: string;
  description: string;
  offer_id: string;
  offer_name: string;
  status: string;
  tags: string[];
  ips: { id: string; address: string; reverse: string; version: string; reverse_status: string; reverse_status_message: string }[];
  install: { os_id: string; hostname: string; ssh_key_ids: string[]; status: string; user: string; service_user: string; service_url: string } | null;
  /** The cloud-init user-data, decoded from the order's base64. */
  userData: string | null;
  /** Reads left before the server moves on: delivered, installed, deleted. */
  pending: number;
};

export type FakeKey = { id: string; name: string; public_key: string; fingerprint: string; project_id: string; disabled: boolean };
export type FakeIp = { id: string; zone: string; project: string; type: string; address: string | null; prefix: string | null; tags: string[]; server: string | null };
export type FakeGroup = {
  id: string;
  zone: string;
  project: string;
  name: string;
  description: string;
  tags: string[];
  stateful: boolean;
  inbound_default_policy: string;
  outbound_default_policy: string;
  rules: unknown[];
};
/** A Block Storage volume, `sbs_volume`, or a local SSD, `l_ssd`, which the Instance API serves and keeps once its server is deleted. */
export type FakeVolume = { id: string; zone: string; project_id: string; name: string; size: number; status: string; tags: string[]; server: string | null; volume_type: "sbs_volume" | "l_ssd" };
export type FakeServer = {
  id: string;
  zone: string;
  project: string;
  name: string;
  commercial_type: string;
  state: string;
  state_detail: string;
  tags: string[];
  image: string;
  /** Volume ids, by their index on the server. */
  volumes: string[];
  ips: string[];
  security_group: string | null;
  mac: string;
  creation_date: string;
  modification_date: string;
  /** Reads left before a start or a stop completes. */
  pending: number;
  /** The user-data, by key, as set; `booted` holds what was there when the server was first powered on. */
  userData: Record<string, string>;
  booted: Record<string, string> | null;
};
type Failure = { method: string; path: RegExp; status: number; body: Record<string, unknown>; headers?: Record<string, string>; times: number };

function hex(value: number, size: number): string {
  return value.toString(16).padStart(size, "0");
}

export type FakeScaleway = ReturnType<typeof createFakeScaleway>;

export function createFakeScaleway(options: { pageSize?: number; transitionReads?: number } = {}) {
  let serial = 1;
  const nextId = () => `00000000-0000-4000-8000-${hex(serial++, 12)}`;
  const keys: FakeKey[] = [];
  const ips: FakeIp[] = [];
  const groups: FakeGroup[] = [];
  const volumes: FakeVolume[] = [];
  const servers: FakeServer[] = [];
  const metals: FakeMetalServer[] = [];
  const requests: (FakeRequest & { url: string })[] = [];
  const failures: Failure[] = [];
  /**
   * `stuck`: servers never finish starting; `refuseStart`: the next power-on
   * answers out_of_stock. `metalReads`: the reads an Elastic Metal takes to
   * be delivered, then installed, then deleted; `metalStuck`: its install
   * never ends; `installFails`: its install ends in error; `metalDenied`: the
   * key may not use the Elastic Metal API; `periodIgnored`: the offers'
   * `subscription_period` filter is not applied, as an older API might.
   */
  const defaults = () => ({
    pageSize: options.pageSize ?? 2,
    transitionReads: options.transitionReads ?? 2,
    stuck: false,
    refuseStart: false,
    metalReads: 3,
    metalStuck: false,
    installFails: false,
    metalDenied: false,
    periodIgnored: false,
  });
  const settings = defaults();

  const error = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response => Response.json(body, { status, headers });
  const notFound = (resource: string, id: string) => error(404, { message: "resource is not found", type: "not_found", resource, resource_id: id });

  /** One page of an Instance API list, its total in X-Total-Count. */
  const page = <T>(url: URL, key: string, items: T[]): Response => {
    const size = Math.min(Math.max(1, Number(url.searchParams.get("per_page") ?? "50")), settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const last = Math.max(1, Math.ceil(items.length / size));
    const link = [`<${url.pathname}?page=${current + 1}&per_page=${size}&>; rel="next"`, `<${url.pathname}?page=${last}&per_page=${size}&>; rel="last"`];
    return Response.json({ [key]: items.slice((current - 1) * size, current * size) }, { headers: { "X-Total-Count": String(items.length), ...(current < last ? { Link: link.join(",") } : {}) } });
  };

  /** One page of a catalogue, a map by type name, its total in X-Total-Count. */
  const pageOfMap = <T>(url: URL, entries: [string, T][]): Response => {
    const size = Math.min(Math.max(1, Number(url.searchParams.get("per_page") ?? "50")), settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
    return Response.json({ servers: Object.fromEntries(sorted.slice((current - 1) * size, current * size)) }, { headers: { "X-Total-Count": String(entries.length) } });
  };

  /** One page of an IAM or Marketplace list, its total in the body. */
  const pageWithCount = <T>(url: URL, key: string, items: T[]): Response => {
    const size = Math.min(Math.max(1, Number(url.searchParams.get("page_size") ?? "20")), settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    return Response.json({ [key]: items.slice((current - 1) * size, current * size), total_count: items.length });
  };

  /** `tags=a,b`: the items carrying every one of them, as the API filters. */
  const hasTags = (tags: string[], wanted: string | null) => wanted === null || wanted.split(",").every((tag) => tags.includes(tag));

  /** The address SLAAC gives a server in a /64, from its MAC, as the API reports it. */
  const slaac = (prefix: string, mac: string): string => {
    const parts = mac.split(":");
    const suffix = ["dc00", "ff", `fe${parts[3]}`, `${parts[4]}${parts[5]}`].map((group) => group.replace(/^0+(?=.)/, ""));
    return `${prefix.replace(/::\/64$/, "")}:${suffix.join(":")}`;
  };

  const ipOfServer = (ip: FakeIp, server: FakeServer) =>
    ip.type === "routed_ipv4"
      ? { id: ip.id, address: ip.address, gateway: "62.210.0.1", netmask: "32", family: "inet", dynamic: false, provisioning_mode: "dhcp", tags: [], state: "attached", ipam_id: ip.id }
      : { id: ip.id, address: slaac(ip.prefix!, server.mac), gateway: "fe80::dc00:ff:fe00:1", netmask: "64", family: "inet6", dynamic: false, provisioning_mode: "slaac", tags: [], state: "attached", ipam_id: ip.id };

  const metalView = (server: FakeMetalServer) => ({
    id: server.id,
    organization_id: ORGANIZATION,
    project_id: server.project_id,
    name: server.name,
    description: server.description,
    updated_at: CREATED,
    created_at: CREATED,
    status: server.status,
    offer_id: server.offer_id,
    offer_name: server.offer_name,
    tags: server.tags,
    ips: server.ips,
    domain: `${server.id}.fr-par-2.baremetal.scw.cloud`,
    boot_type: "normal",
    zone: server.zone,
    install: server.install,
    ping_status: server.status === "ready" ? "ping_status_up" : "ping_status_unknown",
    options: [],
    rescue_server: null,
    protected: false,
    user_data: server.userData === null ? null : Buffer.from(server.userData).toString("base64"),
  });

  /** Reads move an Elastic Metal along: delivered, then installed; or deleted, when it is gone. */
  const advanceMetal = (server: FakeMetalServer): void => {
    if (server.pending > 0) server.pending--;
    if (server.pending > 0) return;
    if (server.status === "delivering") {
      server.status = "ready";
      if (server.install !== null) server.install.status = "installing";
      server.pending = settings.metalReads;
    } else if (server.status === "ready" && server.install?.status === "installing" && !settings.metalStuck) {
      server.install.status = settings.installFails ? "error" : "completed";
    } else if (server.status === "deleting") {
      metals.splice(metals.indexOf(server), 1);
    }
  };

  const localView = (volume: FakeVolume) => {
    const server = servers.find((candidate) => candidate.id === volume.server);
    return {
      id: volume.id,
      name: volume.name,
      export_uri: null,
      size: volume.size,
      volume_type: "l_ssd",
      creation_date: CREATED,
      modification_date: CREATED,
      organization: volume.project_id,
      project: volume.project_id,
      tags: volume.tags,
      server: server === undefined ? null : { id: server.id, name: server.name },
      state: volume.status === "creating" ? "hotsyncing" : "available",
      zone: volume.zone,
    };
  };

  const serverView = (server: FakeServer) => {
    const attached = server.ips.map((id) => ips.find((ip) => ip.id === id)).filter((ip): ip is FakeIp => ip !== undefined);
    const group = groups.find((candidate) => candidate.id === server.security_group);
    const allowed: Record<string, string[]> = {
      stopped: ["poweron", "backup"],
      starting: ["stop_in_place", "backup"],
      running: ["poweroff", "terminate", "reboot", "stop_in_place", "backup"],
      stopping: ["stop_in_place", "backup"],
    };
    return {
      id: server.id,
      name: server.name,
      arch: SERVER_TYPES[server.commercial_type]?.arch ?? "x86_64",
      commercial_type: server.commercial_type,
      boot_type: "local",
      organization: server.project,
      project: server.project,
      hostname: server.name,
      image: { id: server.image, name: "Debian 13 (Trixie)", arch: "x86_64", public: true, state: "available", zone: server.zone, tags: [] },
      volumes: Object.fromEntries(
        server.volumes.map((id, index) => {
          const volume = volumes.find((candidate) => candidate.id === id);
          return [String(index), { boot: false, volume_type: volume?.volume_type ?? "sbs_volume", id, state: "available", zone: server.zone, ...(volume === undefined ? {} : { name: volume.name, size: volume.size }) }];
        }),
      ),
      tags: server.tags,
      state: server.state,
      protected: false,
      state_detail: server.state_detail,
      public_ip: attached[0] === undefined ? null : ipOfServer(attached[0], server),
      public_ips: attached.map((ip) => ipOfServer(ip, server)),
      mac_address: server.mac,
      routed_ip_enabled: true,
      ipv6: null,
      dynamic_ip_required: false,
      enable_ipv6: false,
      private_ip: null,
      creation_date: server.creation_date,
      modification_date: server.modification_date,
      security_group: group === undefined ? null : { id: group.id, name: group.name },
      location: server.state === "running" ? { zone_id: server.zone, platform_id: "14", cluster_id: "34", hypervisor_id: "402", node_id: "34" } : null,
      maintenances: [],
      allowed_actions: allowed[server.state] ?? [],
      placement_group: null,
      private_nics: [],
      zone: server.zone,
      filesystems: [],
      end_of_service: false,
    };
  };

  const ipView = (ip: FakeIp) => {
    const server = servers.find((candidate) => candidate.id === ip.server);
    return {
      id: ip.id,
      address: ip.address,
      prefix: ip.prefix,
      reverse: null,
      server: server === undefined ? null : { id: server.id, name: server.name },
      organization: ip.project,
      project: ip.project,
      zone: ip.zone,
      type: ip.type,
      state: server === undefined ? "detached" : "attached",
      tags: ip.tags,
      ipam_id: ip.id,
    };
  };

  const groupView = (group: FakeGroup) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    enable_default_security: true,
    inbound_default_policy: group.inbound_default_policy,
    outbound_default_policy: group.outbound_default_policy,
    organization: group.project,
    project: group.project,
    tags: group.tags,
    organization_default: false,
    project_default: false,
    creation_date: CREATED,
    modification_date: CREATED,
    servers: servers.filter((server) => server.security_group === group.id).map((server) => ({ id: server.id, name: server.name })),
    stateful: group.stateful,
    state: "available",
    zone: group.zone,
  });

  const volumeView = (volume: FakeVolume) => ({
    id: volume.id,
    name: volume.name,
    type: "sbs_5k",
    size: volume.size,
    project_id: volume.project_id,
    created_at: CREATED,
    updated_at: CREATED,
    references: volume.server === null ? [] : [{ id: volume.server, product_resource_type: "instance_server", product_resource_id: volume.server, created_at: CREATED, type: "exclusive", status: "attached" }],
    parent_snapshot_id: null,
    status: volume.status,
    tags: volume.tags,
    specs: { perf_iops: 5000, class: "sbs" },
    last_detached_at: null,
    zone: volume.zone,
  });

  /** Reads move servers and volumes along, as time would. */
  const advanceServer = (server: FakeServer): void => {
    if (server.state !== "starting" && server.state !== "stopping") return;
    if (server.state === "starting" && settings.stuck) return;
    server.pending--;
    if (server.pending > 0) return;
    server.state = server.state === "starting" ? "running" : "stopped";
    server.state_detail = server.state === "running" ? "booting kernel" : "";
  };

  const advanceVolume = (volume: FakeVolume): void => {
    if (volume.status === "creating") volume.status = volume.server === null ? "available" : "in_use";
    if (volume.status === "in_use" && volume.server === null) volume.status = "available";
  };

  /** The servers' IPv4 addresses come from 203.0.113.0/24, the prefixes from 2001:db8::/32. */
  let addresses = 10;

  function reserveIp(zone: string, project: string, kind: string, tags: string[]): FakeIp {
    const index = addresses++;
    const ip: FakeIp = {
      id: nextId(),
      zone,
      project,
      type: kind,
      address: kind === "routed_ipv4" ? `203.0.113.${index}` : null,
      prefix: kind === "routed_ipv6" ? `2001:db8:${index.toString(16)}:${(index * 7).toString(16)}::/64` : null,
      tags,
      server: null,
    };
    ips.push(ip);
    return ip;
  }

  function addVolume(zone: string, project: string, name: string, size: number, server: string | null, tags: string[] = [], volume_type: FakeVolume["volume_type"] = "sbs_volume"): FakeVolume {
    const volume: FakeVolume = { id: nextId(), zone, project_id: project, name, size, status: server === null ? "available" : "in_use", tags, server, volume_type };
    volumes.push(volume);
    return volume;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    let body: unknown = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const text = await request.text();
      if (request.headers.get("content-type") === "text/plain") {
        body = text;
      } else {
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          return error(400, { message: "invalid JSON", type: "invalid_request_error" });
        }
      }
    }
    const headers = Object.fromEntries([...request.headers.entries()]);
    requests.push({ method, path, search: url.search, body, headers, url: request.url });

    if (request.headers.get("x-auth-token") !== FAKE_SECRET) {
      return error(401, { message: "authentication is denied", method: "api_key", reason: "invalid_argument", type: "denied_authentication" });
    }
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.body, failure.headers ?? {});
    }
    const query = url.searchParams;
    const input = (body ?? {}) as Record<string, unknown>;

    // --- IAM
    if (path === "/iam/v1alpha1/ssh-keys" && method === "GET") {
      const project = query.get("project_id");
      return pageWithCount(url, "ssh_keys", keys.filter((key) => project === null || key.project_id === project).map((key) => ({ ...key, organization_id: ORGANIZATION, created_at: CREATED, updated_at: CREATED })));
    }
    if (path === "/iam/v1alpha1/ssh-keys" && method === "POST") {
      const { name, public_key, project_id } = input as { name?: string; public_key?: string; project_id?: string };
      if (!name || !public_key || !project_id) return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "public_key", reason: "required", help_message: "" }] });
      const key = addKey({ name, public_key, project_id });
      return Response.json({ ...key, organization_id: ORGANIZATION, created_at: CREATED, updated_at: CREATED });
    }
    const keyPath = /^\/iam\/v1alpha1\/ssh-keys\/([^/]+)$/.exec(path);
    if (keyPath !== null && method === "DELETE") {
      const index = keys.findIndex((key) => key.id === keyPath[1]);
      if (index === -1) return notFound("ssh_key", keyPath[1]!);
      keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    // --- Marketplace
    if (path === "/marketplace/v2/local-images" && method === "GET") {
      const label = query.get("image_label");
      if (label !== "debian_trixie") return notFound("MarketplaceImage", label ?? "");
      const found = LOCAL_IMAGES.filter(
        (image) => image.zone === query.get("zone") && (query.get("arch") === null || image.arch === query.get("arch")) && (query.get("type") === null || image.type === query.get("type")),
      );
      return pageWithCount(url, "local_images", found);
    }

    // --- Block Storage
    const volumeList = /^\/block\/v1alpha1\/zones\/([a-z0-9-]+)\/volumes$/.exec(path);
    if (volumeList !== null && method === "GET") {
      const project = query.get("project_id");
      // `tags`: the volumes carrying one or more of them.
      const wanted = query.getAll("tags");
      const found = volumes.filter(
        (volume) => volume.volume_type === "sbs_volume" && volume.zone === volumeList[1] && (project === null || volume.project_id === project) && (wanted.length === 0 || wanted.some((tag) => volume.tags.includes(tag))),
      );
      for (const volume of found) advanceVolume(volume);
      return pageWithCount(url, "volumes", found.map(volumeView));
    }
    const volumePath = /^\/block\/v1alpha1\/zones\/([a-z0-9-]+)\/volumes\/([^/]+)$/.exec(path);
    if (volumePath !== null) {
      const volume = volumes.find((candidate) => candidate.id === volumePath[2] && candidate.zone === volumePath[1] && candidate.volume_type === "sbs_volume");
      if (volume === undefined) return notFound("volume", volumePath[2]!);
      if (method === "GET") {
        const view = volumeView(volume);
        advanceVolume(volume);
        return Response.json(view);
      }
      if (method === "PATCH") {
        if (volume.status === "creating") return error(409, { message: "resource is in a transient state", type: "transient_state", resource: "volume", resource_id: volume.id, current_state: "creating" });
        if (Array.isArray(input.tags)) volume.tags = input.tags.map(String);
        return Response.json(volumeView(volume));
      }
      if (method === "DELETE") {
        if (volume.status !== "available") return error(412, { message: "precondition is not respected", type: "precondition_failed", precondition: "resource_still_in_use", help_message: "the volume must be detached" });
        volumes.splice(volumes.indexOf(volume), 1);
        return new Response(null, { status: 204 });
      }
    }

    // --- Elastic Metal
    const metalZoned = /^\/baremetal\/v1\/zones\/([a-z0-9-]+)(\/.*)$/.exec(path);
    if (metalZoned !== null) {
      const zone = metalZoned[1]!;
      const rest = metalZoned[2]!;
      if (settings.metalDenied) return error(403, { message: "insufficient permissions", type: "permissions_denied", details: [{ resource: "baremetal_server", action: "read" }] });
      if (!METAL_ZONES.includes(zone)) return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "zone", reason: "constraint", help_message: "unknown zone" }] });
      if (method === "GET" && rest === "/offers") {
        const period = query.get("subscription_period");
        const name = query.get("name");
        return pageWithCount(url, "offers", METAL_OFFERS.filter((offer) => (settings.periodIgnored || period === null || offer.subscription_period === period) && (name === null || offer.name === name)).map((offer) => ({ ...offer, zone })));
      }
      if (method === "GET" && rest === "/os") {
        const offer = METAL_OFFERS.find((candidate) => candidate.id === query.get("offer_id"));
        return pageWithCount(url, "os", METAL_OS.filter((os) => offer === undefined || !offer.incompatible_os_ids.includes(os.id)).map((os) => ({ ...os, zone })));
      }
      if (method === "GET" && rest === "/servers") {
        const project = query.get("project_id");
        const name = query.get("name");
        const wanted = query.getAll("tags");
        const found = metals.filter((server) => server.zone === zone && (project === null || server.project_id === project) && (name === null || server.name.includes(name)) && wanted.every((tag) => server.tags.includes(tag)));
        return pageWithCount(url, "servers", found.map(metalView));
      }
      if (method === "POST" && rest === "/servers") {
        const order = input as { offer_id?: string; project_id?: string; name?: string; description?: string; tags?: string[]; install?: { os_id?: string; hostname?: string; ssh_key_ids?: string[] }; user_data?: string };
        const offer = METAL_OFFERS.find((candidate) => candidate.id === order.offer_id);
        if (offer === undefined) return notFound("offer", order.offer_id ?? "");
        if (offer.stock === "empty") return error(400, { message: "offer is out of stock", type: "out_of_stock", resource: "offer" });
        if (order.name === undefined || order.project_id === undefined) return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "name", reason: "required", help_message: "" }] });
        const install = order.install;
        const os = METAL_OS.find((candidate) => candidate.id === install?.os_id);
        if (install !== undefined) {
          if (os === undefined) return notFound("os", install.os_id ?? "");
          if ((install.ssh_key_ids ?? []).length === 0) return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "install.ssh_key_ids", reason: "required", help_message: "the OS requires an SSH key" }] });
          for (const keyId of install.ssh_key_ids ?? []) if (!keys.some((key) => key.id === keyId)) return notFound("ssh_key", keyId);
        }
        let userData: string | null = null;
        if (order.user_data !== undefined) {
          if (os?.cloud_init_supported !== true || !offer.tags.includes("cloud-init")) return error(400, { message: "cloud-init is not supported", type: "invalid_request_error" });
          userData = Buffer.from(order.user_data, "base64").toString("utf8");
        }
        const index = addresses++;
        const server: FakeMetalServer = {
          id: nextId(),
          zone,
          project_id: order.project_id,
          name: order.name,
          description: order.description ?? "",
          offer_id: offer.id,
          offer_name: offer.name,
          status: "delivering",
          tags: order.tags ?? [],
          ips: [
            { id: nextId(), address: `203.0.113.${index}`, reverse: "", version: "IPv4", reverse_status: "active", reverse_status_message: "" },
            { id: nextId(), address: `2001:db8:${index.toString(16)}::1`, reverse: "", version: "IPv6", reverse_status: "active", reverse_status_message: "" },
          ],
          install:
            install === undefined
              ? null
              : { os_id: os!.id, hostname: install.hostname ?? order.name, ssh_key_ids: install.ssh_key_ids ?? [], status: "to_install", user: os!.user.default_value ?? "root", service_user: "", service_url: "" },
          userData,
          pending: settings.metalReads,
        };
        metals.push(server);
        return Response.json(metalView(server));
      }
      const metalPath = /^\/servers\/([^/]+)$/.exec(rest);
      if (metalPath !== null) {
        const server = metals.find((candidate) => candidate.id === metalPath[1] && candidate.zone === zone);
        if (server === undefined) return notFound("baremetal_server", metalPath[1]!);
        if (method === "GET") {
          const view = metalView(server);
          advanceMetal(server);
          return metals.includes(server) || server.status !== "deleting" ? Response.json(view) : notFound("baremetal_server", server.id);
        }
        if (method === "DELETE") {
          server.status = "deleting";
          server.pending = settings.metalReads;
          return Response.json(metalView(server));
        }
      }
      return error(404, { message: `no such route in the fake: ${method} ${path}`, type: "not_found" });
    }

    // --- The public Product Catalog: where the prices are since products/servers answers 0.
    if (path === "/product-catalog/v2alpha1/public-catalog/products" && method === "GET") {
      const zone = query.get("zone");
      const products = Object.entries(CATALOGUE)
        .filter(([where]) => zone === null || where === zone)
        .flatMap(([where, sold]) =>
          Object.keys(sold).map((name) => {
            const hourly = SERVER_TYPES[name]!.hourly_price;
            return {
              sku: `/instance/server/${name.toLowerCase().replace(/-/g, "_")}/${where}`,
              product: name,
              locality: { zone: where },
              status: "general_availability",
              unit_of_measure: { unit: "hour", size: 1 },
              price: { retail_price: { currency_code: "EUR", units: Math.floor(hourly), nanos: Math.round((hourly % 1) * 1e9) } },
            };
          }),
        );
      return pageWithCount(url, "products", products);
    }

    // --- Instances
    const zoned = /^\/instance\/v1\/zones\/([a-z0-9-]+)(\/.*)$/.exec(path);
    if (zoned === null) return error(404, { message: `no such route in the fake: ${method} ${path}`, type: "not_found" });
    const zone = zoned[1]!;
    const rest = zoned[2]!;
    if (!/^(fr-par|nl-ams|pl-waw)-[1-3]$/.test(zone)) return error(400, { message: "unknown zone in path" });
    const id = /^\/[a-z_]+\/([^/]+)/.exec(rest)?.[1] ?? "";

    if (method === "GET" && rest === "/products/servers") {
      // Priced 0, as the real one answers every type since October 2026.
      return pageOfMap(url, Object.keys(CATALOGUE[zone] ?? {}).map((name) => [name, { ...SERVER_TYPES[name]!, hourly_price: 0, monthly_price: 0 }]));
    }
    if (method === "GET" && rest === "/products/servers/availability") {
      return pageOfMap(url, Object.entries(CATALOGUE[zone] ?? {}).map(([name, availability]) => [name, { availability }]));
    }

    // Servers
    if (method === "GET" && rest === "/servers") {
      const name = query.get("name");
      const project = query.get("project");
      const found = servers.filter((server) => server.zone === zone && (project === null || server.project === project) && (name === null || server.name.includes(name)) && hasTags(server.tags, query.get("tags")));
      return page(url, "servers", found.map(serverView));
    }
    if (method === "POST" && rest === "/servers") {
      const order = input as { name?: string; commercial_type?: string; image?: string; volumes?: Record<string, { size?: number; volume_type?: string }>; public_ips?: string[]; project?: string; tags?: string[]; security_group?: string; dynamic_ip_required?: boolean };
      if (order.name === undefined || order.commercial_type === undefined) return error(400, { message: "Validation Error", type: "invalid_request_error", fields: { name: ["required key not provided"] } });
      if (CATALOGUE[zone]?.[order.commercial_type] === undefined) {
        return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "commercial_type", reason: "constraint", help_message: "unknown commercial type" }] });
      }
      const ordered = LOCAL_IMAGES.find((image) => image.id === order.image && image.zone === zone);
      if (ordered === undefined) return notFound("instance_image", order.image ?? "");
      // What Scaleway answered on 29/10 to a Block Storage image under an l_ssd root.
      if ((order.volumes?.["0"]?.volume_type === "l_ssd") !== (ordered.type === "instance_local")) {
        const wanted = ordered.type === "instance_local" ? "l_ssd" : "sbs_volume";
        return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "volumes.0.volume_type", reason: "constraint", help_message: `requested volume type does not match the snapshot type, use '${wanted}' instead` }] });
      }
      for (const ipId of order.public_ips ?? []) {
        const ip = ips.find((candidate) => candidate.id === ipId && candidate.zone === zone);
        if (ip === undefined) return notFound("instance_ip", ipId);
        if (ip.server !== null) return error(400, { message: "IP is already attached to a server", type: "invalid_request_error" });
      }
      if (order.security_group !== undefined && !groups.some((group) => group.id === order.security_group)) return notFound("instance_security_group", order.security_group);
      const project = order.project ?? FAKE_PROJECT;
      const serverId = nextId();
      const size = order.volumes?.["0"]?.size ?? 10_000_000_000;
      const local = order.volumes?.["0"]?.volume_type === "l_ssd";
      const constraint = SERVER_TYPES[order.commercial_type]!.volumes_constraint;
      if (local && (size > constraint.max_size || size < constraint.min_size)) {
        return error(400, { message: `The total size of local-volume(s) must be equal or less than ${constraint.max_size / 1e9} GB`, type: "invalid_request_error" });
      }
      const boot = local ? addVolume(zone, project, "Debian 13 (Trixie)_l_ssd_volume_0", size, serverId, [], "l_ssd") : addVolume(zone, project, "Debian 13 (Trixie)_sbs_volume_0", size, serverId);
      if (!local) boot.status = "creating";
      const server: FakeServer = {
        id: serverId,
        zone,
        project,
        name: order.name,
        commercial_type: order.commercial_type,
        state: "stopped",
        state_detail: "",
        tags: order.tags ?? [],
        image: order.image!,
        volumes: [boot.id],
        ips: order.public_ips ?? [],
        security_group: order.security_group ?? null,
        mac: `de:00:00:${hex(serial, 2)}:${hex(serial + 1, 2)}:${hex(serial + 2, 2)}`,
        creation_date: CREATED,
        modification_date: CREATED,
        pending: 0,
        userData: {},
        booted: null,
      };
      servers.push(server);
      for (const ip of ips.filter((candidate) => server.ips.includes(candidate.id))) ip.server = server.id;
      return Response.json({ server: serverView(server) }, { status: 201 });
    }
    const userDataPath = /^\/servers\/([^/]+)\/user_data\/([^/]+)$/.exec(rest);
    if (userDataPath !== null && method === "PATCH") {
      const server = servers.find((candidate) => candidate.id === userDataPath[1] && candidate.zone === zone);
      if (server === undefined) return notFound("instance_server", userDataPath[1]!);
      if (request.headers.get("content-type") !== "text/plain") return error(400, { message: "Content-Type must be text/plain", type: "invalid_request_error" });
      server.userData[decodeURIComponent(userDataPath[2]!)] = String(body ?? "");
      return new Response(null, { status: 204 });
    }
    const serverPath = /^\/servers\/([^/]+)(\/action)?$/.exec(rest);
    if (serverPath !== null) {
      const server = servers.find((candidate) => candidate.id === serverPath[1] && candidate.zone === zone);
      if (server === undefined) return notFound("instance_server", serverPath[1]!);
      if (method === "GET" && serverPath[2] === undefined) {
        advanceServer(server);
        return Response.json({ server: serverView(server) });
      }
      if (method === "POST" && serverPath[2] === "/action") {
        const action = String(input.action ?? "poweron");
        const allowed = serverView(server).allowed_actions;
        if (!allowed.includes(action)) return error(400, { message: `server should be in a state allowing ${action}`, type: "invalid_request_error" });
        if (action === "poweron" && settings.refuseStart) {
          settings.refuseStart = false;
          return error(503, { message: "No more stock for this server type", type: "out_of_stock", resource: server.commercial_type });
        }
        if (action === "poweron") {
          server.booted ??= { ...server.userData };
          server.state = "starting";
          server.state_detail = "allocating node";
        } else if (action === "poweroff") {
          server.state = "stopping";
          server.state_detail = "stopping";
        } else {
          return error(400, { message: `the fake does not ${action}`, type: "invalid_request_error" });
        }
        server.pending = settings.transitionReads;
        server.modification_date = MODIFIED;
        return Response.json(
          {
            task: { id: nextId(), description: `server_batch_${action}`, status: "pending", href_from: `/servers/${server.id}/action`, href_result: `/servers/${server.id}`, started_at: CREATED, terminated_at: null, progress: 0, zone },
          },
          { status: 202 },
        );
      }
      if (method === "DELETE" && serverPath[2] === undefined) {
        if (server.state !== "stopped") return error(400, { message: "instance must be stopped to be deleted", type: "invalid_request_error" });
        servers.splice(servers.indexOf(server), 1);
        for (const volume of volumes.filter((candidate) => candidate.server === server.id)) {
          volume.server = null;
        }
        for (const ip of ips.filter((candidate) => candidate.server === server.id)) ip.server = null;
        return new Response(null, { status: 204 });
      }
    }

    // Local volumes
    if (method === "GET" && rest === "/volumes") {
      const project = query.get("project");
      const found = volumes.filter((volume) => volume.volume_type === "l_ssd" && volume.zone === zone && (project === null || volume.project_id === project) && hasTags(volume.tags, query.get("tags")));
      return page(url, "volumes", found.map(localView));
    }
    const localPath = /^\/volumes\/([^/]+)$/.exec(rest);
    if (localPath !== null) {
      const volume = volumes.find((candidate) => candidate.id === localPath[1] && candidate.zone === zone && candidate.volume_type === "l_ssd");
      if (volume === undefined) return notFound("instance_volume", localPath[1]!);
      if (method === "GET") return Response.json({ volume: localView(volume) });
      if (method === "PATCH") {
        if (Array.isArray(input.tags)) volume.tags = input.tags.map(String);
        return Response.json({ volume: localView(volume) });
      }
      if (method === "DELETE") {
        if (volume.server !== null) return error(400, { message: "a volume attached to a server cannot be deleted", type: "invalid_request_error" });
        volumes.splice(volumes.indexOf(volume), 1);
        return new Response(null, { status: 204 });
      }
    }

    // Flexible IPs
    if (method === "GET" && rest === "/ips") {
      const project = query.get("project");
      return page(url, "ips", ips.filter((ip) => ip.zone === zone && (project === null || ip.project === project) && hasTags(ip.tags, query.get("tags"))).map(ipView));
    }
    if (method === "POST" && rest === "/ips") {
      const kind = String(input.type ?? "");
      if (kind !== "routed_ipv4" && kind !== "routed_ipv6") return error(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "type", reason: "constraint", help_message: "" }] });
      const ip = reserveIp(zone, String(input.project ?? FAKE_PROJECT), kind, Array.isArray(input.tags) ? input.tags.map(String) : []);
      return Response.json({ ip: ipView(ip) }, { status: 201 });
    }
    if (method === "DELETE" && rest.startsWith("/ips/")) {
      const ip = ips.find((candidate) => candidate.id === id && candidate.zone === zone);
      if (ip === undefined) return notFound("instance_ip", id);
      // As documented: an attached IP is deleted all the same, and its server
      // is left without that public address.
      const holder = servers.find((candidate) => candidate.id === ip.server);
      if (holder !== undefined) holder.ips = holder.ips.filter((candidate) => candidate !== ip.id);
      ips.splice(ips.indexOf(ip), 1);
      return new Response(null, { status: 204 });
    }

    // Security groups
    if (method === "GET" && rest === "/security_groups") {
      const name = query.get("name");
      const project = query.get("project");
      return page(
        url,
        "security_groups",
        groups.filter((group) => group.zone === zone && (project === null || group.project === project) && (name === null || group.name.includes(name)) && hasTags(group.tags, query.get("tags"))).map(groupView),
      );
    }
    if (method === "POST" && rest === "/security_groups") {
      if (typeof input.name !== "string") return error(400, { message: "Validation Error", type: "invalid_request_error", fields: { name: ["required key not provided"] } });
      const group = addGroup({
        zone,
        project: String(input.project ?? FAKE_PROJECT),
        name: input.name,
        description: String(input.description ?? ""),
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        stateful: input.stateful === true,
        inbound_default_policy: String(input.inbound_default_policy ?? "accept"),
        outbound_default_policy: String(input.outbound_default_policy ?? "accept"),
      });
      return Response.json({ security_group: groupView(group) }, { status: 201 });
    }
    const groupPath = /^\/security_groups\/([^/]+)(\/rules)?$/.exec(rest);
    if (groupPath !== null) {
      const group = groups.find((candidate) => candidate.id === groupPath[1] && candidate.zone === zone);
      if (group === undefined) return notFound("instance_security_group", groupPath[1]!);
      if (method === "GET" && groupPath[2] === undefined) return Response.json({ security_group: groupView(group) });
      if (method === "PUT" && groupPath[2] === "/rules") {
        group.rules = Array.isArray(input.rules) ? input.rules : [];
        return Response.json({ rules: group.rules.map((rule, index) => ({ id: nextId(), ...(rule as object), position: index + 1, zone })) });
      }
      if (method === "DELETE" && groupPath[2] === undefined) {
        if (groupView(group).servers.length > 0) return error(409, { message: "group is in use", type: "conflict" });
        groups.splice(groups.indexOf(group), 1);
        return new Response(null, { status: 204 });
      }
    }

    return error(404, { message: `no such route in the fake: ${method} ${path}`, type: "not_found" });
  }

  function addKey(input: Partial<FakeKey> & { name: string; public_key: string }): FakeKey {
    const blob = input.public_key.split(/\s+/)[1] ?? "";
    const digest = new Bun.CryptoHasher("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "");
    const key: FakeKey = { id: nextId(), fingerprint: `256 SHA256:${digest} (${input.public_key.split(/\s+/)[0]})`, project_id: FAKE_PROJECT, disabled: false, ...input };
    keys.push(key);
    return key;
  }

  function addGroup(input: Partial<FakeGroup> & { name: string }): FakeGroup {
    const group: FakeGroup = {
      id: nextId(),
      zone: "fr-par-1",
      project: FAKE_PROJECT,
      description: "",
      tags: [],
      stateful: true,
      inbound_default_policy: "accept",
      outbound_default_policy: "accept",
      rules: [],
      ...input,
    };
    groups.push(group);
    return group;
  }

  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${listener.port}`;

  return {
    url,
    environment: { SCW_SECRET_KEY: FAKE_SECRET, SCW_DEFAULT_PROJECT_ID: FAKE_PROJECT, SITESOLIDE_SCALEWAY_API: url },
    secrets: [FAKE_SECRET],
    keys,
    ips,
    groups,
    volumes,
    servers,
    metals,
    requests,
    settings,
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, body: Record<string, unknown>, extra: { headers?: Record<string, string>; times?: number } = {}): void {
      failures.push({ method, path, status, body, headers: extra.headers, times: extra.times ?? 1 });
    },
    addKey,
    addGroup,
    reserveIp(input: { zone?: string; project?: string; type?: string; tags?: string[] } = {}): FakeIp {
      return reserveIp(input.zone ?? "fr-par-1", input.project ?? FAKE_PROJECT, input.type ?? "routed_ipv4", input.tags ?? []);
    },
    addVolume(input: { zone?: string; name: string; size?: number; tags?: string[] }): FakeVolume {
      return addVolume(input.zone ?? "fr-par-1", FAKE_PROJECT, input.name, input.size ?? 20_000_000_000, null, input.tags);
    },
    /** A server that exists before the test, ours or not, running, with a boot volume and an IPv4 address of its own. */
    addServer(input: Partial<FakeServer> & { name: string }, extra: { volumeTags?: string[]; ipTags?: string[] } = {}): FakeServer {
      const zone = input.zone ?? "fr-par-1";
      const project = input.project ?? FAKE_PROJECT;
      const serverId = nextId();
      const boot = addVolume(zone, project, `${input.name}-boot`, 40_000_000_000, serverId, extra.volumeTags ?? []);
      const ip = reserveIp(zone, project, "routed_ipv4", extra.ipTags ?? []);
      ip.server = serverId;
      const server: FakeServer = {
        id: serverId,
        zone,
        project,
        commercial_type: "DEV1-S",
        state: "running",
        state_detail: "booting kernel",
        tags: [],
        image: LOCAL_IMAGES[0]!.id,
        volumes: [boot.id],
        ips: [ip.id],
        security_group: null,
        mac: `de:00:00:${hex(serial, 2)}:${hex(serial + 1, 2)}:${hex(serial + 2, 2)}`,
        creation_date: CREATED,
        modification_date: MODIFIED,
        pending: 0,
        userData: {},
        booted: {},
        ...input,
      };
      servers.push(server);
      return server;
    },
    /** An Elastic Metal that exists before the test, ours or not, delivered and installed. */
    addMetal(input: Partial<FakeMetalServer> & { name: string }): FakeMetalServer {
      const offer = METAL_OFFERS[1]!;
      const index = addresses++;
      const server: FakeMetalServer = {
        id: nextId(),
        zone: "fr-par-2",
        project_id: FAKE_PROJECT,
        description: "",
        offer_id: offer.id,
        offer_name: offer.name,
        status: "ready",
        tags: [],
        ips: [{ id: nextId(), address: `203.0.113.${index}`, reverse: "", version: "IPv4", reverse_status: "active", reverse_status_message: "" }],
        install: { os_id: METAL_OS[1]!.id, hostname: input.name, ssh_key_ids: [], status: "completed", user: "ubuntu", service_user: "", service_url: "" },
        userData: null,
        pending: 0,
        ...input,
      };
      metals.push(server);
      return server;
    },
    /** Attaches a flexible IP to a server, as its owner would from the console. */
    attach(ip: FakeIp, server: FakeServer): void {
      ip.server = server.id;
      server.ips.push(ip.id);
    },
    reset(): void {
      keys.length = 0;
      ips.length = 0;
      groups.length = 0;
      volumes.length = 0;
      servers.length = 0;
      metals.length = 0;
      requests.length = 0;
      failures.length = 0;
      Object.assign(settings, defaults());
    },
    stop(): void {
      listener.stop(true);
    },
  };
}

/** The fake as bin/tests/cli-machine-providers.test.ts takes every provider's. */
export function createFake(): FakeProvider {
  return createFakeScaleway();
}
