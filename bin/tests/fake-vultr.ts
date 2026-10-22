/**
 * A local stand-in for the Vultr API v2, on a random port of the loopback:
 * the tests of `sitesolide machine` never reach the real one.
 *
 * It keeps an account in memory (SSH keys, firewall groups and their rules,
 * instances) and answers the calls bin/cli/providers/vultr.ts makes, in the
 * shapes of https://www.vultr.com/api/ as its OpenAPI document and Vultr's Go
 * client describe them: `{"error": "...", "status": n}` errors, cursor
 * pagination through `meta.links.next`, an instance that is `pending` for a
 * few polls, then `active` and `installingbooting`, then `ok`, a root password
 * in the creation's answer only.
 *
 * Lists come back `pageSize` items a page whatever `per_page` asks, two by
 * default, so that a client that reads only the first page fails a test.
 * `fail()` makes the next matching request answer an error instead, or, with
 * `after`, carry it out and then answer the error, as a request whose answer
 * was lost.
 *
 * Deleting a firewall group detaches the instances behind it, as Vultr
 * documents (https://docs.vultr.com/products/network/firewall-groups/management/delete).
 * An order of a plan not in stock is refused with a 400 that says the plan is
 * not available: the fake's guess at a message Vultr does not document.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

/** 36 uppercase letters and digits, the shape of Vultr's keys. */
export const FAKE_KEY = "FAKEVULTRKEY0123456789ABCDEFGHIJKLMN";

export type FakeKey = { id: string; date_created: string; name: string; ssh_key: string };
export type FakeRule = { id: number; type: string; ip_type: string; action: string; protocol: string; port: string; subnet: string; subnet_size: number; source: string; notes: string };
export type FakeFirewall = { id: string; description: string; date_created: string; rules: FakeRule[]; nextRule: number; lag: number };
export type FakeInstance = {
  id: string;
  label: string;
  hostname: string;
  plan: string;
  region: string;
  os_id: number;
  status: string;
  power_status: string;
  server_status: string;
  main_ip: string;
  v6_main_ip: string;
  v6_network: string;
  v6_network_size: number;
  firewall_group_id: string;
  features: string[];
  tags: string[];
  sshkey_id: string[];
  user_scheme: string;
  polls: number;
  serial: number;
};
export type Received = FakeRequest & { url: string; authorization: string | null };
export type FakeBlock = { id: string; label: string; size_gb: number; region: string; attached_to_instance: string };
export type FakeReservedIp = { id: string; label: string; region: string; ip_type: string; subnet: string; subnet_size: number; instance_id: string };
type Failure = { method: string; path: RegExp; status: number; message: string; headers?: Record<string, string>; times: number; raw?: string; after?: boolean };

/** What the fake sells, as of October 2026, close enough to the real list to read like it. */
export const REGIONS = [
  { id: "ams", city: "Amsterdam", country: "NL", continent: "Europe", options: ["ddos_protection", "block_storage_high_perf", "load_balancers"] },
  { id: "cdg", city: "Paris", country: "FR", continent: "Europe", options: ["ddos_protection", "load_balancers"] },
  { id: "ewr", city: "New Jersey", country: "US", continent: "North America", options: ["ddos_protection", "block_storage_storage_opt", "load_balancers"] },
  { id: "fra", city: "Frankfurt", country: "DE", continent: "Europe", options: ["ddos_protection", "block_storage_high_perf", "load_balancers"] },
  { id: "lhr", city: "London", country: "GB", continent: "Europe", options: ["ddos_protection", "load_balancers"] },
  { id: "nrt", city: "Tokyo", country: "JP", continent: "Asia", options: ["ddos_protection"] },
];

const EVERYWHERE = REGIONS.map((region) => region.id);
const EUROPE = ["ams", "cdg", "fra", "lhr"];

/**
 * Some regions cost more: the real API answers `location_cost`, by region,
 * for those, `sao` among them. Here Tokyo plays that part.
 */
const dearer = (monthly: number) => ({ location_cost: { nrt: { monthly_cost: monthly, hourly_cost: Number((monthly / 730).toFixed(3)) } } });

export const PLANS = [
  { id: "vc2-1c-0.5gb-v6", vcpu_count: 1, ram: 512, disk: 10, disk_count: 1, bandwidth: 500, monthly_cost: 2.5, type: "vc2", locations: ["ewr"] },
  { id: "vc2-1c-1gb", vcpu_count: 1, ram: 1024, disk: 25, disk_count: 1, bandwidth: 1024, monthly_cost: 5, type: "vc2", locations: EVERYWHERE },
  { id: "vc2-1c-2gb", vcpu_count: 1, ram: 2048, disk: 55, disk_count: 1, bandwidth: 2048, monthly_cost: 10, type: "vc2", locations: EVERYWHERE, ...dearer(15) },
  { id: "vc2-2c-4gb", vcpu_count: 2, ram: 4096, disk: 80, disk_count: 1, bandwidth: 3072, monthly_cost: 20, type: "vc2", locations: EVERYWHERE, ...dearer(30) },
  { id: "vc2-4c-8gb", vcpu_count: 4, ram: 8192, disk: 160, disk_count: 1, bandwidth: 4096, monthly_cost: 40, type: "vc2", locations: EVERYWHERE },
  { id: "vhp-1c-2gb-amd", vcpu_count: 1, ram: 2048, disk: 50, disk_count: 1, bandwidth: 2048, monthly_cost: 12, type: "vhp", locations: EVERYWHERE },
  { id: "vhp-2c-4gb-amd", vcpu_count: 2, ram: 4096, disk: 100, disk_count: 1, bandwidth: 4096, monthly_cost: 24, type: "vhp", locations: EVERYWHERE },
  { id: "vhf-1c-2gb", vcpu_count: 1, ram: 2048, disk: 64, disk_count: 1, bandwidth: 2048, monthly_cost: 12, type: "vhf", locations: ["ams", "fra", "ewr"] },
  { id: "voc-g-2c-8gb-50s-amd", vcpu_count: 2, ram: 8192, disk: 50, disk_count: 1, bandwidth: 4096, monthly_cost: 60, type: "voc", locations: EUROPE },
  { id: "vcg-a16-2c-8g-2vram", vcpu_count: 2, ram: 8192, disk: 50, disk_count: 1, bandwidth: 1024, monthly_cost: 21.5, type: "vcg", locations: ["fra"], gpu_vram_gb: 2, gpu_type: "NVIDIA_A16" },
];

/** What each region has in stock right now: at cdg, vc2-2c-4gb is sold out. */
export const STOCK: Record<string, string[]> = Object.fromEntries(
  REGIONS.map((region) => [
    region.id,
    PLANS.filter((plan) => plan.locations.includes(region.id) && !(region.id === "cdg" && plan.id === "vc2-2c-4gb")).map((plan) => plan.id),
  ]),
);

/** Vultr's own os_ids, which vultr.ts never writes down: it reads them from /os. */
export const SYSTEMS = [
  { id: 477, name: "Debian 11 x64 (bullseye)", arch: "x64", family: "debian" },
  { id: 2136, name: "Debian 12 x64 (bookworm)", arch: "x64", family: "debian" },
  { id: 2626, name: "Debian 13 arm64 (trixie)", arch: "arm64", family: "debian" },
  { id: 2625, name: "Debian 13 x64 (trixie)", arch: "x64", family: "debian" },
  { id: 1743, name: "Ubuntu 22.04 LTS x64", arch: "x64", family: "ubuntu" },
  { id: 159, name: "Custom", arch: "x64", family: "iso" },
];

/** The id Debian 13 x64 has in the fake. */
export const DEBIAN_13_ID = 2625;

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: message, status }, { status, headers });
}

let uuidSerial = 0;
function uuid(): string {
  uuidSerial++;
  return `cb676a46-66fd-4dfb-b839-${String(uuidSerial).padStart(12, "0")}`;
}

export type FakeVultr = ReturnType<typeof createFakeVultr>;

export function createFakeVultr(options: { pageSize?: number; readyPolls?: number } = {}) {
  const keys: FakeKey[] = [];
  const firewalls: FakeFirewall[] = [];
  const instances: FakeInstance[] = [];
  const blocks: FakeBlock[] = [];
  const reservedIps: FakeReservedIp[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  let serial = 10;
  /**
   * `readyPolls`: the reads of an instance before it is active; `stuck`: it
   * never is; `refuseAddress`: every call answers as Vultr does to an address
   * the key's access control list does not allow; `firewallLag`: the reads
   * of a group that still count an instance deleted.
   */
  const settings = {
    pageSize: options.pageSize ?? 2,
    readyPolls: options.readyPolls ?? 2,
    stuck: false,
    refuseAddress: false,
    firewallLag: 0,
  };

  const page = <T>(url: URL, key: string, items: T[]): Response => {
    const wanted = Math.max(1, Number(url.searchParams.get("per_page") ?? "100"));
    const size = Math.min(wanted, settings.pageSize, 500);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor === null ? 0 : Number(atob(cursor).replace(/^next__/, ""));
    const nextOffset = offset + size;
    return Response.json({
      [key]: items.slice(offset, nextOffset),
      meta: {
        total: items.length,
        links: {
          next: nextOffset < items.length ? btoa(`next__${nextOffset}`) : "",
          prev: offset > 0 ? btoa(`next__${Math.max(0, offset - size)}`) : "",
        },
      },
    });
  };

  const instanceCount = (firewall: FakeFirewall) => instances.filter((instance) => instance.firewall_group_id === firewall.id).length + (firewall.lag > 0 ? 1 : 0);

  const firewallView = (firewall: FakeFirewall) => ({
    id: firewall.id,
    description: firewall.description,
    date_created: firewall.date_created,
    date_modified: firewall.date_created,
    instance_count: instanceCount(firewall),
    rule_count: firewall.rules.length,
    max_rule_count: 50,
  });

  const instanceView = (instance: FakeInstance, password = false) => {
    const plan = PLANS.find((candidate) => candidate.id === instance.plan);
    return {
      id: instance.id,
      os: SYSTEMS.find((os) => os.id === instance.os_id)?.name ?? "",
      ram: plan?.ram ?? 0,
      disk: plan?.disk ?? 0,
      main_ip: instance.main_ip,
      vcpu_count: plan?.vcpu_count ?? 0,
      region: instance.region,
      plan: instance.plan,
      date_created: "2026-10-05T10:00:00+00:00",
      status: instance.status,
      allowed_bandwidth: plan?.bandwidth ?? 0,
      netmask_v4: instance.main_ip === "0.0.0.0" ? "" : "255.255.254.0",
      gateway_v4: instance.main_ip === "0.0.0.0" ? "0.0.0.0" : "203.0.113.1",
      power_status: instance.power_status,
      server_status: instance.server_status,
      v6_network: instance.v6_network,
      v6_main_ip: instance.v6_main_ip,
      v6_network_size: instance.v6_network_size,
      label: instance.label,
      internal_ip: "",
      kvm: `https://my.vultr.test-zone.invalid/subs/vps/novnc/api.php?data=console${instance.serial}`,
      hostname: instance.hostname,
      os_id: instance.os_id,
      app_id: 0,
      image_id: "",
      firewall_group_id: instance.firewall_group_id,
      features: instance.features,
      tags: instance.tags,
      user_scheme: instance.user_scheme,
      ...(password ? { default_password: `v5{Fkvb#2ycPGw${instance.serial}` } : {}),
    };
  };

  /** What one more read of an instance being created shows. */
  const advance = (instance: FakeInstance): void => {
    if (settings.stuck || (instance.status !== "pending" && instance.server_status === "ok")) return;
    instance.polls++;
    if (instance.polls === 1) instance.server_status = "locked";
    if (instance.polls >= settings.readyPolls && instance.status === "pending") {
      instance.status = "active";
      instance.server_status = "installingbooting";
      instance.main_ip = `203.0.113.${instance.serial}`;
      if (instance.features.includes("ipv6")) {
        instance.v6_network = `2001:db8:${instance.serial}::`;
        instance.v6_main_ip = `2001:db8:${instance.serial}:0:5400:4ff:fe00:${instance.serial}`;
        instance.v6_network_size = 64;
      }
    } else if (instance.polls > settings.readyPolls) {
      instance.server_status = "ok";
    }
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v2/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "Invalid JSON");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    requests.push({ method, path, search: url.search, url: request.url, authorization: request.headers.get("authorization"), body, headers });

    if (request.headers.get("authorization") !== `Bearer ${FAKE_KEY}`) return error(401, "Invalid API token.");
    if (settings.refuseAddress) return error(401, "Unauthorized IP address: 127.0.0.1");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      if (failure.after === true) await route(method, path, url, body);
      if (failure.raw !== undefined) return new Response(failure.raw, { status: failure.status, headers: { "Content-Type": "text/html", ...failure.headers } });
      return error(failure.status, failure.message, failure.headers ?? {});
    }
    return route(method, path, url, body);
  }

  /** What the API does with a request, once it is authenticated. */
  async function route(method: string, path: string, url: URL, body: unknown): Promise<Response> {

    const id = decodeURIComponent(/^\/[a-z-]+\/([^/]+)/.exec(path)?.[1] ?? "");

    // --- what Vultr sells
    if (method === "GET" && path === "/regions") return page(url, "regions", REGIONS);
    if (method === "GET" && /^\/regions\/[^/]+\/availability$/.test(path)) {
      if (!REGIONS.some((region) => region.id === id)) return error(404, "Invalid region.");
      const type = url.searchParams.get("type");
      const stock = (STOCK[id] ?? []).filter((plan) => type === null || type === "all" || PLANS.find((candidate) => candidate.id === plan)?.type === type);
      return Response.json({ available_plans: stock });
    }
    if (method === "GET" && path === "/plans") {
      const type = url.searchParams.get("type");
      return page(url, "plans", PLANS.filter((plan) => type === null || type === "all" || plan.type === type || (type === "voc" && plan.type.startsWith("voc"))));
    }
    if (method === "GET" && path === "/os") return page(url, "os", SYSTEMS);

    // --- SSH keys
    if (method === "GET" && path === "/ssh-keys") return page(url, "ssh_keys", keys);
    if (method === "POST" && path === "/ssh-keys") {
      const input = body as { name?: string; ssh_key?: string } | null;
      if (!input?.name || !input.ssh_key) return error(400, "Missing name or ssh_key.");
      if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+/.test(input.ssh_key)) return error(400, "Invalid SSH key.");
      const key: FakeKey = { id: uuid(), date_created: "2026-10-05T10:00:00+00:00", name: input.name, ssh_key: input.ssh_key };
      keys.push(key);
      return Response.json({ ssh_key: key }, { status: 201 });
    }
    if (/^\/ssh-keys\/[^/]+$/.test(path)) {
      const index = keys.findIndex((key) => key.id === id);
      if (index === -1) return error(404, "SSH key not found.");
      if (method === "GET") return Response.json({ ssh_key: keys[index] });
      if (method === "DELETE") {
        keys.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }

    // --- firewall groups
    if (method === "GET" && path === "/firewalls") return page(url, "firewall_groups", firewalls.map(firewallView));
    if (method === "POST" && path === "/firewalls") {
      const input = body as { description?: string } | null;
      const firewall: FakeFirewall = { id: uuid(), description: input?.description ?? "", date_created: "2026-10-05T10:00:00+00:00", rules: [], nextRule: 1, lag: 0 };
      firewalls.push(firewall);
      return Response.json({ firewall_group: firewallView(firewall) }, { status: 201 });
    }
    if (/^\/firewalls\/[^/]+$/.test(path)) {
      const firewall = firewalls.find((candidate) => candidate.id === id);
      if (firewall === undefined) return error(404, "Firewall group not found.");
      if (method === "GET") {
        const view = firewallView(firewall);
        if (firewall.lag > 0) firewall.lag--;
        return Response.json({ firewall_group: view });
      }
      if (method === "DELETE") {
        // Vultr detaches the instances behind it, and deletes it all the same.
        for (const instance of instances) if (instance.firewall_group_id === firewall.id) instance.firewall_group_id = "";
        firewalls.splice(firewalls.indexOf(firewall), 1);
        return new Response(null, { status: 204 });
      }
    }
    if (/^\/firewalls\/[^/]+\/rules$/.test(path)) {
      const firewall = firewalls.find((candidate) => candidate.id === id);
      if (firewall === undefined) return error(404, "Firewall group not found.");
      if (method === "GET") return page(url, "firewall_rules", firewall.rules);
      if (method === "POST") {
        const input = body as { ip_type?: string; protocol?: string; subnet?: string; subnet_size?: number; port?: string; source?: string; notes?: string } | null;
        const protocol = (input?.protocol ?? "").toLowerCase();
        if (input?.ip_type !== "v4" && input?.ip_type !== "v6") return error(400, "Invalid ip_type.");
        if (!["icmp", "tcp", "udp", "gre", "esp", "ah"].includes(protocol)) return error(400, "Invalid protocol.");
        if (typeof input.subnet !== "string" || typeof input.subnet_size !== "number") return error(400, "Invalid subnet.");
        if (firewall.rules.length >= 50) return error(400, "Maximum number of rules reached.");
        const rule: FakeRule = {
          id: firewall.nextRule++,
          type: input.ip_type,
          ip_type: input.ip_type,
          action: "accept",
          protocol,
          port: input.port ?? "",
          subnet: input.subnet,
          subnet_size: input.subnet_size,
          source: input.source ?? "",
          notes: input.notes ?? "",
        };
        firewall.rules.push(rule);
        return Response.json({ firewall_rule: rule }, { status: 201 });
      }
    }

    // --- what an instance may have attached
    if (method === "GET" && path === "/blocks") return page(url, "blocks", blocks.map((block) => ({ ...block, date_created: "2026-10-05T10:00:00+00:00", cost: block.size_gb / 10, status: "active", mount_id: `${block.region}-${block.id.slice(-6)}`, block_type: "high_perf" })));
    if (method === "GET" && path === "/reserved-ips") return page(url, "reserved_ips", reservedIps);

    // --- instances
    if (method === "GET" && path === "/instances") {
      const label = url.searchParams.get("label");
      return page(url, "instances", instances.filter((instance) => label === null || instance.label === label).map((instance) => instanceView(instance)));
    }
    if (method === "POST" && path === "/instances") {
      const input = (body ?? {}) as { region?: string; plan?: string; os_id?: number; label?: string; hostname?: string; tags?: string[]; sshkey_id?: string[]; firewall_group_id?: string; enable_ipv6?: boolean; backups?: string };
      if (!REGIONS.some((region) => region.id === input.region)) return error(400, "Invalid region.");
      const plan = PLANS.find((candidate) => candidate.id === input.plan);
      if (plan === undefined) return error(400, "Invalid plan.");
      if (!plan.locations.includes(input.region!) || !(STOCK[input.region!] ?? []).includes(plan.id)) return error(400, "Plan is not available in the selected region.");
      if (!SYSTEMS.some((os) => os.id === input.os_id)) return error(400, "Invalid os_id.");
      for (const key of input.sshkey_id ?? []) if (!keys.some((candidate) => candidate.id === key)) return error(400, "Invalid SSH key.");
      if (input.firewall_group_id !== undefined && !firewalls.some((candidate) => candidate.id === input.firewall_group_id)) return error(400, "Invalid firewall group.");
      if (input.backups !== undefined && input.backups !== "enabled" && input.backups !== "disabled") return error(400, "Invalid backups value.");
      const instance: FakeInstance = {
        id: uuid(),
        label: input.label ?? "",
        hostname: input.hostname ?? "vultr.guest",
        plan: plan.id,
        region: input.region!,
        os_id: input.os_id!,
        status: "pending",
        power_status: "running",
        server_status: "none",
        main_ip: "0.0.0.0",
        v6_main_ip: "",
        v6_network: "",
        v6_network_size: 0,
        firewall_group_id: input.firewall_group_id ?? "",
        features: [...(input.enable_ipv6 === true ? ["ipv6"] : []), ...(input.backups === "enabled" ? ["auto_backups"] : [])],
        tags: input.tags ?? [],
        sshkey_id: input.sshkey_id ?? [],
        user_scheme: "root",
        polls: 0,
        serial: serial++,
      };
      instances.push(instance);
      return Response.json({ instance: instanceView(instance, true) }, { status: 202 });
    }
    if (/^\/instances\/[^/]+\/backup-schedule$/.test(path) && method === "GET") {
      const instance = instances.find((candidate) => candidate.id === id);
      if (instance === undefined) return error(404, "Instance not found.");
      const enabled = instance.features.includes("auto_backups");
      return Response.json({ backup_schedule: { enabled, type: enabled ? "daily" : "", next_scheduled_time_utc: enabled ? "2026-10-06 03:00:00" : "", hour: 3, dow: 1, dom: 1 } });
    }
    if (/^\/instances\/[^/]+$/.test(path)) {
      const instance = instances.find((candidate) => candidate.id === id);
      if (instance === undefined) return error(404, "Instance not found.");
      if (method === "GET") {
        advance(instance);
        return Response.json({ instance: instanceView(instance) });
      }
      if (method === "PATCH") {
        const input = (body ?? {}) as { backups?: string; firewall_group_id?: string };
        if (input.firewall_group_id !== undefined) {
          if (input.firewall_group_id !== "" && !firewalls.some((candidate) => candidate.id === input.firewall_group_id)) return error(400, "Invalid firewall group.");
          instance.firewall_group_id = input.firewall_group_id;
        }
        if (input.backups === "enabled" && !instance.features.includes("auto_backups")) instance.features.push("auto_backups");
        if (input.backups === "disabled") instance.features = instance.features.filter((feature) => feature !== "auto_backups");
        return Response.json({ instance: instanceView(instance) }, { status: 202 });
      }
      if (method === "DELETE") {
        if (instance.server_status === "locked") return error(400, "Unable to destroy server: Server is currently locked.");
        instances.splice(instances.indexOf(instance), 1);
        // What was attached stays, detached, and billed.
        for (const block of blocks) if (block.attached_to_instance === instance.id) block.attached_to_instance = "";
        for (const reserved of reservedIps) if (reserved.instance_id === instance.id) reserved.instance_id = "";
        const firewall = firewalls.find((candidate) => candidate.id === instance.firewall_group_id);
        if (firewall !== undefined) firewall.lag = settings.firewallLag;
        return new Response(null, { status: 204 });
      }
    }

    return error(404, `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const url = `http://127.0.0.1:${server.port}/v2`;

  return {
    url,
    environment: { VULTR_API_KEY: FAKE_KEY, SITESOLIDE_VULTR_API: url } as Record<string, string>,
    secrets: [FAKE_KEY],
    keys,
    firewalls,
    instances,
    blocks,
    reservedIps,
    requests,
    settings,
    /**
     * The next `times` requests matching answer this error instead; `raw`
     * answers that text, not JSON; `after` carries the request out first, as
     * one whose answer was lost on the way back.
     */
    fail(method: string, path: RegExp, status: number, message: string, extra: { headers?: Record<string, string>; times?: number; raw?: string; after?: boolean } = {}): void {
      failures.push({ method, path, status, message, headers: extra.headers, times: extra.times ?? 1, raw: extra.raw, after: extra.after });
    },
    addBlock(input: Partial<FakeBlock> & { attached_to_instance: string }): FakeBlock {
      const block: FakeBlock = { id: uuid(), label: "", size_gb: 40, region: "fra", ...input };
      blocks.push(block);
      return block;
    },
    addReservedIp(input: Partial<FakeReservedIp> & { instance_id: string }): FakeReservedIp {
      const reserved: FakeReservedIp = { id: uuid(), label: "", region: "fra", ip_type: "v4", subnet: "198.51.100.7", subnet_size: 32, ...input };
      reservedIps.push(reserved);
      return reserved;
    },
    /** An instance that exists before the test, ours or not, active and running. */
    addInstance(input: Partial<FakeInstance> & { label: string }): FakeInstance {
      const number = serial++;
      const instance: FakeInstance = {
        id: uuid(),
        hostname: input.label,
        plan: "vc2-2c-4gb",
        region: "fra",
        os_id: DEBIAN_13_ID,
        status: "active",
        power_status: "running",
        server_status: "ok",
        main_ip: `203.0.113.${number}`,
        v6_main_ip: `2001:db8:${number}:0:5400:4ff:fe00:${number}`,
        v6_network: `2001:db8:${number}::`,
        v6_network_size: 64,
        firewall_group_id: "",
        features: ["ipv6"],
        tags: [],
        sshkey_id: [],
        user_scheme: "root",
        polls: 0,
        serial: number,
        ...input,
      };
      instances.push(instance);
      return instance;
    },
    addKey(input: Partial<FakeKey> & { name: string; ssh_key: string }): FakeKey {
      const key: FakeKey = { id: uuid(), date_created: "2026-10-05T10:00:00+00:00", ...input };
      keys.push(key);
      return key;
    },
    addFirewall(input: Partial<FakeFirewall> & { description: string }): FakeFirewall {
      const firewall: FakeFirewall = { id: uuid(), date_created: "2026-10-05T10:00:00+00:00", rules: [], nextRule: 1, lag: 0, ...input };
      firewalls.push(firewall);
      return firewall;
    },
    reset(): void {
      keys.length = 0;
      firewalls.length = 0;
      instances.length = 0;
      blocks.length = 0;
      reservedIps.length = 0;
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.readyPolls = options.readyPolls ?? 2;
      settings.stuck = false;
      settings.refuseAddress = false;
      settings.firewallLag = 0;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/**
 * The fake as bin/tests/cli-machine-providers.test.ts runs every provider's:
 * an instance comes up at its first read, so that a run with the real clock
 * never sleeps between two polls.
 */
export function createFake(): FakeProvider {
  return createFakeVultr({ readyPolls: 1 });
}
