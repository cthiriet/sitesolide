/**
 * A local stand-in for DigitalOcean's API v2, on a random port of the
 * loopback: the tests of the DigitalOcean provider never reach the real one.
 *
 * It keeps an account in memory (SSH keys, tags, firewalls, Droplets,
 * actions) and answers the calls bin/cli/providers/digitalocean.ts makes, in
 * the shapes of https://docs.digitalocean.com/reference/api/reference/ and of
 * its OpenAPI source, https://github.com/digitalocean/openapi: the
 * `{"id", "message", "request_id"}` errors, `links.pages` and `meta.total` on
 * every list, a 202 and `links.actions` for an order, actions `in-progress`
 * for a few polls before they are `completed`, 204 for every deletion, the
 * rate limit's headers on every answer.
 *
 * What the reference does not document, the wording of a 422 above all, is
 * the fake's own, and says so where it is written.
 *
 * Lists come back `pageSize` items a page whatever `per_page` asks, two by
 * default, so that a client that reads only the first page fails a test. Their
 * links name another host than the fake's, as the real ones name
 * api.digitalocean.com: a client that followed them as given would leave the
 * fake, and fail. `fail()` makes the next matching request answer an error
 * instead.
 */
import type { FakeProvider, FakeRequest } from "./fake-provider";

export const FAKE_TOKEN = `dop_v1_${"0123456789abcdef".repeat(4)}`;

/** Where the links of a page point: an address that resolves nowhere, as a test needs. */
export const LINK_ORIGIN = "https://api.test-zone.invalid";

export type FakeKey = { id: number; name: string; fingerprint: string; public_key: string };
export type FakeRule = { protocol: string; ports: string; sources?: Record<string, unknown>; destinations?: Record<string, unknown>; action?: string };
export type FakeFirewall = {
  id: string;
  name: string;
  status: "waiting" | "succeeded" | "failed";
  inbound_rules: FakeRule[];
  outbound_rules: FakeRule[];
  droplet_ids: number[];
  tags: string[];
  created_at: string;
};
export type FakeDroplet = {
  id: number;
  name: string;
  status: "new" | "active" | "off" | "archive";
  size: string;
  region: string;
  image: string | number;
  tags: string[];
  features: string[];
  ssh_keys: (string | number)[];
  ipv4: string | null;
  ipv6: string | null;
  monitoring: boolean;
  /** Block storage volumes attached: DigitalOcean detaches them when the Droplet is deleted, and keeps them. */
  volume_ids: string[];
  body?: unknown;
  /** Set once deleted: how many more reads still find it. */
  goneAfter?: number;
};
type FakeAction = { id: number; type: string; status: "in-progress" | "completed" | "errored"; polls: number; droplet: number };
export type Received = FakeRequest & { url: string };
type Failure = { method: string; path: RegExp; status: number; body: unknown; headers: Record<string, string>; times: number };
/** A Reserved IP, IPv4 or IPv6, and the Droplet it is assigned to. */
export type FakeReservedIp = { ip: string; region: string; droplet: number | null };

const ALL_REGIONS = ["nyc3", "ams3", "fra1", "lon1", "sgp1"];
const FEATURES = ["backups", "ipv6", "metadata", "install_agent", "storage", "image_transfer"];

const size = (slug: string, memory: number, vcpus: number, disk: number, price: number, description: string, regions = ALL_REGIONS, extra: Record<string, unknown> = {}) => ({
  slug,
  memory,
  vcpus,
  disk,
  transfer: Math.max(0.5, memory / 1024),
  price_monthly: price,
  price_hourly: Number((price / 672).toFixed(5)),
  regions,
  available: true,
  description,
  disk_info: [{ type: "local", size: { amount: disk, unit: "gib" } }],
  ...extra,
});

/** What the fake sells, close enough to the real list of October 2026 to read like it. */
export const SIZES = [
  size("s-1vcpu-512mb-10gb", 512, 1, 10, 4, "Basic"),
  size("s-1vcpu-1gb", 1024, 1, 25, 6, "Basic"),
  size("s-1vcpu-2gb", 2048, 1, 50, 12, "Basic"),
  size("s-1vcpu-2gb-amd", 2048, 1, 50, 14, "Basic AMD", ["nyc3", "ams3"]),
  size("s-2vcpu-2gb", 2048, 2, 60, 18, "Basic"),
  size("s-2vcpu-4gb", 4096, 2, 80, 24, "Basic"),
  size("c-2", 4096, 2, 25, 42, "CPU-Optimized"),
  size("s-4vcpu-8gb", 8192, 4, 160, 48, "Basic"),
  size("g-2vcpu-8gb", 8192, 2, 25, 63, "General Purpose"),
  // A size of before 2018, still listed, no longer sold.
  { ...size("2gb", 2048, 2, 40, 10, "Basic", []), available: false },
  size("gpu-h100x1-80gb", 245760, 20, 720, 3500, "GPU", ["nyc3"], { gpu_info: { count: 1, model: "nvidia_h100", vram: { amount: 80, unit: "gib" } } }),
];

const region = (slug: string, name: string, available = true, features = FEATURES) => ({
  name,
  slug,
  features,
  available,
  sizes: SIZES.filter((candidate) => candidate.available && candidate.regions.includes(slug)).map((candidate) => candidate.slug),
});

export const REGIONS = [
  region("nyc3", "New York 3"),
  region("ams3", "Amsterdam 3"),
  region("fra1", "Frankfurt 1"),
  region("lon1", "London 1"),
  region("sgp1", "Singapore 1", true, ["metadata", "install_agent", "storage"]),
  region("nyc2", "New York 2", false),
];

export const IMAGES = [
  { id: 248394734, name: "13 x64", distribution: "Debian", slug: "debian-13-x64", public: true, regions: ALL_REGIONS, type: "base", min_disk_size: 15, size_gigabytes: 1.2, status: "available" },
  { id: 199888143, name: "12 x64", distribution: "Debian", slug: "debian-12-x64", public: true, regions: ALL_REGIONS, type: "base", min_disk_size: 15, size_gigabytes: 1.1, status: "available" },
  { id: 172000001, name: "24.04 (LTS) x64", distribution: "Ubuntu", slug: "ubuntu-24-04-x64", public: true, regions: ["nyc3"], type: "base", min_disk_size: 15, size_gigabytes: 2.3, status: "available" },
];

const TAG = /^[a-zA-Z0-9_\-:]+$/;
const DROPLET_NAME = /^[a-zA-Z0-9]?[a-z0-9A-Z.-]*[a-z0-9A-Z]$/;
const FIREWALL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]+$/;

function error(status: number, id: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ id, message, request_id: "4d9d8375-3c56-4925-a3e7-eb137fed17e9" }, { status, headers });
}

function fingerprintOf(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/)[1] ?? "";
  return new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g)!.join(":");
}

export type FakeDigitalOcean = ReturnType<typeof createFakeDigitalOcean>;

export function createFakeDigitalOcean(options: { pageSize?: number; actionPolls?: number; gonePolls?: number } = {}) {
  let nextId = 5_000_000;
  const keys: FakeKey[] = [];
  const tags = new Set<string>();
  const firewalls: FakeFirewall[] = [];
  const droplets: FakeDroplet[] = [];
  const actions = new Map<number, FakeAction>();
  const requests: Received[] = [];
  const failures: Failure[] = [];
  /** Requests handled as usual, whose answer's body is then cut in half, as a connection dropped midway leaves it. */
  const cuts: { method: string; path: RegExp; times: number }[] = [];
  const reservedIps: FakeReservedIp[] = [];
  /** `failAction`: the action of that type ends `errored` rather than `completed`. */
  const settings: { pageSize: number; actionPolls: number; gonePolls: number; failAction: string | null; remaining: number } = {
    pageSize: options.pageSize ?? 2,
    actionPolls: options.actionPolls ?? 2,
    gonePolls: options.gonePolls ?? 1,
    failAction: null,
    remaining: 5000,
  };

  const page = <T>(url: URL, path: string, key: string, items: T[]): Response => {
    const wanted = Math.max(1, Math.min(200, Number(url.searchParams.get("per_page") ?? "20")));
    const size = Math.min(wanted, settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const last = Math.max(1, Math.ceil(items.length / size));
    const link = (number: number) => {
      const query = new URLSearchParams(url.searchParams);
      query.set("page", String(number));
      query.set("per_page", String(size));
      return `${LINK_ORIGIN}/v2${path}?${query}`;
    };
    const pages: Record<string, string> = {};
    if (current > 1) Object.assign(pages, { first: link(1), prev: link(current - 1) });
    if (current < last) Object.assign(pages, { next: link(current + 1), last: link(last) });
    return Response.json({ [key]: items.slice((current - 1) * size, current * size), links: Object.keys(pages).length === 0 ? {} : { pages }, meta: { total: items.length } });
  };

  const action = (type: string, droplet: number): FakeAction => {
    const created: FakeAction = { id: nextId++, type, status: "in-progress", polls: 0, droplet };
    actions.set(created.id, created);
    return created;
  };

  const actionView = (item: FakeAction) => ({
    id: item.id,
    status: item.status,
    type: item.type,
    started_at: "2026-10-21T10:00:00Z",
    completed_at: item.status === "in-progress" ? null : "2026-10-21T10:00:40Z",
    resource_id: item.droplet,
    resource_type: "droplet",
    region_slug: droplets.find((candidate) => candidate.id === item.droplet)?.region ?? null,
  });

  /**
   * One step of an action: it completes after `actionPolls` steps. Reading
   * the action is a step, and so is reading the Droplet it creates, since the
   * real one becomes active whether anyone follows its action or not.
   */
  const advance = (item: FakeAction): void => {
    if (item.status !== "in-progress") return;
    item.polls++;
    if (item.polls >= settings.actionPolls && item.type === settings.failAction) item.status = "errored";
    else if (item.polls >= settings.actionPolls) {
      item.status = "completed";
      complete(item);
    }
  };

  /** What an action does to the account once it completes. */
  const complete = (item: FakeAction): void => {
    const droplet = droplets.find((candidate) => candidate.id === item.droplet);
    if (droplet === undefined) return;
    if (item.type === "create") {
      const serial = (droplet.id % 200) + 10;
      droplet.status = "active";
      droplet.ipv4 = `203.0.113.${serial}`;
      if (droplet.features.includes("ipv6")) droplet.ipv6 = `2001:db8:${serial.toString(16)}::4d8:a001`;
    }
    if (item.type === "enable_backups" && !droplet.features.includes("backups")) droplet.features.push("backups");
  };

  const sizeView = (slug: string) => SIZES.find((candidate) => candidate.slug === slug) ?? { slug, price_monthly: 0, regions: [] };
  const regionView = (slug: string) => REGIONS.find((candidate) => candidate.slug === slug) ?? { slug, name: slug, features: [], available: true, sizes: [] };

  const dropletView = (droplet: FakeDroplet) => {
    const chosen = SIZES.find((candidate) => candidate.slug === droplet.size);
    const image = IMAGES.find((candidate) => candidate.slug === droplet.image || candidate.id === droplet.image);
    return {
      id: droplet.id,
      name: droplet.name,
      memory: chosen?.memory ?? 1024,
      vcpus: chosen?.vcpus ?? 1,
      disk: chosen?.disk ?? 25,
      locked: droplet.status === "new",
      status: droplet.status,
      kernel: null,
      created_at: "2026-10-21T10:00:00Z",
      features: droplet.features,
      backup_ids: [],
      next_backup_window: droplet.features.includes("backups") ? { start: "2026-10-22T00:00:00Z", end: "2026-10-22T04:00:00Z" } : null,
      snapshot_ids: [],
      image: image ?? { id: 0, name: String(droplet.image), slug: null },
      volume_ids: droplet.volume_ids,
      size: sizeView(droplet.size),
      size_slug: droplet.size,
      networks: {
        // The private address first: a client must pick by type, not by place.
        v4: droplet.ipv4 === null ? [] : [{ ip_address: `10.114.0.${droplet.id % 200}`, netmask: "255.255.240.0", gateway: null, type: "private" }, { ip_address: droplet.ipv4, netmask: "255.255.240.0", gateway: "203.0.113.1", type: "public" }],
        v6: droplet.ipv6 === null ? [] : [{ ip_address: droplet.ipv6, netmask: 64, gateway: "2001:db8::1", type: "public" }],
      },
      region: regionView(droplet.region),
      tags: droplet.tags,
      vpc_uuid: "760e09ef-dc84-11e8-981e-3cfdfeaae000",
    };
  };

  /** What the API answers for a rule: "0" for all ports, an ICMP rule's included. */
  const ruleView = (rule: FakeRule): FakeRule => ({ ...rule, ports: rule.protocol === "icmp" || rule.ports === "all" ? "0" : rule.ports });

  const firewallView = (firewall: FakeFirewall) => ({
    id: firewall.id,
    name: firewall.name,
    status: firewall.status,
    created_at: firewall.created_at,
    pending_changes: firewall.status === "waiting" ? droplets.filter((droplet) => droplet.tags.some((tag) => firewall.tags.includes(tag))).map((droplet) => ({ droplet_id: droplet.id, removing: false, status: "waiting" })) : [],
    inbound_rules: firewall.inbound_rules.map(ruleView),
    outbound_rules: firewall.outbound_rules.map(ruleView),
    droplet_ids: firewall.droplet_ids,
    tags: firewall.tags,
  });

  const tagView = (name: string) => {
    const count = droplets.filter((droplet) => droplet.tags.includes(name)).length;
    return {
      name,
      resources: {
        count,
        ...(count === 0 ? {} : { last_tagged_uri: `${LINK_ORIGIN}/v2/droplets/${droplets.find((droplet) => droplet.tags.includes(name))!.id}` }),
        droplets: { count },
        images: { count: 0 },
        volumes: { count: 0 },
        volume_snapshots: { count: 0 },
        databases: { count: 0 },
      },
    };
  };

  /** A deleted Droplet answers for `gonePolls` more reads, then is gone. */
  const visible = (droplet: FakeDroplet): boolean => droplet.goneAfter === undefined || droplet.goneAfter > 0;
  const forget = (): void => {
    for (let index = droplets.length - 1; index >= 0; index--) if (!visible(droplets[index]!)) droplets.splice(index, 1);
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v2/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "bad_request", "error parsing request body");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    requests.push({ method, path, search: url.search, body, headers, url: request.url });
    settings.remaining = Math.max(0, settings.remaining - 1);
    const limits = { "ratelimit-limit": "5000", "ratelimit-remaining": String(settings.remaining), "ratelimit-reset": "1792576800" };
    let answer = await route(request, url, method, path, body);
    const cut = cuts.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (cut !== undefined) {
      cut.times--;
      const text = await answer.text();
      answer = new Response(text.slice(0, Math.floor(text.length / 2)), { status: answer.status, headers: answer.headers });
    }
    for (const [name, value] of Object.entries(limits)) if (!answer.headers.has(name)) answer.headers.set(name, value);
    return answer;
  }

  async function route(request: Request, url: URL, method: string, path: string, body: unknown): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) return error(401, "unauthorized", "Unable to authenticate you");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return Response.json(failure.body, { status: failure.status, headers: failure.headers });
    }
    // The resource's id or name: `/droplets/{id}`, `/droplets/{id}/actions`, `/account/keys/{id}`.
    const parts = path.split("/");
    const segment = decodeURIComponent((path.startsWith("/account/") ? parts[3] : parts[2]) ?? "");
    const id = Number(segment);

    if (method === "GET" && path === "/regions") return page(url, path, "regions", REGIONS);
    if (method === "GET" && path === "/sizes") return page(url, path, "sizes", SIZES);
    if (method === "GET" && /^\/images\/[^/]+$/.test(path)) {
      const image = IMAGES.find((candidate) => candidate.slug === segment || String(candidate.id) === segment);
      return image === undefined ? error(404, "not_found", "The resource you were accessing could not be found.") : Response.json({ image });
    }

    // --- SSH keys
    if (method === "GET" && path === "/account/keys") return page(url, path, "ssh_keys", keys);
    if (method === "POST" && path === "/account/keys") {
      const input = body as { name?: string; public_key?: string };
      if (typeof input?.name !== "string" || typeof input.public_key !== "string") return error(422, "unprocessable_entity", "name and public_key are required");
      const fingerprint = fingerprintOf(input.public_key);
      // The wording DigitalOcean has been seen to answer; the reference documents none.
      if (keys.some((key) => key.fingerprint === fingerprint)) return error(422, "unprocessable_entity", "SSH Key is already in use on your account");
      const key: FakeKey = { id: nextId++, name: input.name, fingerprint, public_key: input.public_key };
      keys.push(key);
      return Response.json({ ssh_key: key }, { status: 201 });
    }
    if (/^\/account\/keys\/[^/]+$/.test(path)) {
      const key = keys.find((candidate) => String(candidate.id) === segment || candidate.fingerprint === segment);
      if (key === undefined) return error(404, "not_found", "The resource you were accessing could not be found.");
      if (method === "GET") return Response.json({ ssh_key: key });
      if (method === "DELETE") {
        keys.splice(keys.indexOf(key), 1);
        return new Response(null, { status: 204 });
      }
    }

    // --- tags
    if (method === "POST" && path === "/tags") {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !TAG.test(name) || name.length > 255) {
        return Response.json({ error: `Error validating resource tag: "tag-name ${JSON.stringify(name)} contains invalid characters"`, messages: null, root_causes: [] }, { status: 400 });
      }
      tags.add(name);
      return Response.json({ tag: tagView(name) }, { status: 201 });
    }
    if (/^\/tags\/[^/]+$/.test(path)) {
      const name = segment;
      if (!tags.has(name)) return error(404, "not_found", "The resource you were accessing could not be found.");
      if (method === "GET") return Response.json({ tag: tagView(name) });
      if (method === "DELETE") {
        tags.delete(name);
        for (const droplet of droplets) droplet.tags = droplet.tags.filter((tag) => tag !== name);
        for (const firewall of firewalls) firewall.tags = firewall.tags.filter((tag) => tag !== name);
        return new Response(null, { status: 204 });
      }
    }

    // --- firewalls
    if (method === "GET" && path === "/firewalls") return page(url, path, "firewalls", firewalls.map(firewallView));
    if (method === "POST" && path === "/firewalls") {
      const input = body as { name?: string; inbound_rules?: FakeRule[]; outbound_rules?: FakeRule[]; droplet_ids?: number[]; tags?: string[] };
      if (typeof input?.name !== "string" || !FIREWALL_NAME.test(input.name)) return error(422, "unprocessable_entity", "name must begin with an alphanumeric character");
      const rules = [...(input.inbound_rules ?? []), ...(input.outbound_rules ?? [])];
      if (rules.length === 0) return error(422, "unprocessable_entity", "must contain at least one inbound or outbound rule");
      for (const rule of rules) {
        if (rule.protocol !== "icmp" && (typeof rule.ports !== "string" || rule.ports === "")) return error(422, "unprocessable_entity", `ports is required for protocol ${rule.protocol}`);
      }
      // The reference says a firewall may only name a tag that exists; this wording is the fake's.
      for (const tag of input.tags ?? []) if (!tags.has(tag)) return error(422, "unprocessable_entity", `tag ${tag} does not exist`);
      const firewall: FakeFirewall = {
        id: `fb6045f1-cf1d-4ca3-bfac-18832663${String(nextId++).slice(-4)}`,
        name: input.name,
        status: "waiting",
        inbound_rules: (input.inbound_rules ?? []).map((rule) => ({ ...rule, ports: rule.ports ?? "" })),
        outbound_rules: (input.outbound_rules ?? []).map((rule) => ({ ...rule, ports: rule.ports ?? "" })),
        droplet_ids: input.droplet_ids ?? [],
        tags: input.tags ?? [],
        created_at: "2026-10-21T10:00:00Z",
      };
      firewalls.push(firewall);
      return Response.json({ firewall: firewallView(firewall) }, { status: 202 });
    }
    if (/^\/firewalls\/[^/]+$/.test(path)) {
      const firewall = firewalls.find((candidate) => candidate.id === segment);
      if (firewall === undefined) return error(404, "not_found", "The resource you were accessing could not be found.");
      if (method === "GET") {
        const view = firewallView(firewall);
        // Applied once read: the next read finds it done.
        if (firewall.status === "waiting") firewall.status = "succeeded";
        return Response.json({ firewall: view });
      }
      if (method === "DELETE") {
        firewalls.splice(firewalls.indexOf(firewall), 1);
        return new Response(null, { status: 204 });
      }
    }

    // --- Droplets
    if (method === "GET" && path === "/droplets") {
      const name = url.searchParams.get("name");
      const tag = url.searchParams.get("tag_name");
      if (tag !== null && name !== null) return error(422, "unprocessable_entity", "tag_name can not be combined with name");
      const found = droplets.filter((droplet) => visible(droplet) && (name === null || droplet.name.toLowerCase() === name.toLowerCase()) && (tag === null || droplet.tags.includes(tag)));
      return page(url, path, "droplets", found.map(dropletView));
    }
    if (method === "POST" && path === "/droplets") {
      const input = body as { name?: string; region?: string; size?: string; image?: string | number; ssh_keys?: (string | number)[]; tags?: string[]; ipv6?: boolean; backups?: boolean; monitoring?: boolean };
      // The wordings below are those DigitalOcean has been seen to answer; the reference documents none.
      if (typeof input?.name !== "string" || !DROPLET_NAME.test(input.name)) return error(422, "unprocessable_entity", "Name is invalid");
      const chosenRegion = REGIONS.find((candidate) => candidate.slug === input.region);
      if (chosenRegion === undefined || !chosenRegion.available) return error(422, "unprocessable_entity", "You specified an invalid region for Droplet creation.");
      const chosenSize = SIZES.find((candidate) => candidate.slug === input.size && candidate.available);
      if (chosenSize === undefined) return error(422, "unprocessable_entity", "You specified an invalid size for Droplet creation.");
      if (!chosenSize.regions.includes(chosenRegion.slug)) return error(422, "unprocessable_entity", "Size is not available in this region.");
      if (!IMAGES.some((candidate) => candidate.slug === input.image || candidate.id === input.image)) return error(422, "unprocessable_entity", "You specified an invalid image for Droplet creation.");
      for (const reference of input.ssh_keys ?? []) {
        if (!keys.some((key) => key.id === reference || key.fingerprint === reference)) return error(422, "unprocessable_entity", "One or more of the SSH keys you specified could not be found.");
      }
      for (const tag of input.tags ?? []) if (!TAG.test(tag)) return error(422, "unprocessable_entity", `tag ${tag} contains invalid characters`);
      for (const tag of input.tags ?? []) tags.add(tag);
      const droplet: FakeDroplet = {
        id: nextId++,
        name: input.name,
        status: "new",
        size: chosenSize.slug,
        region: chosenRegion.slug,
        image: input.image!,
        tags: [...(input.tags ?? [])],
        features: [...(input.backups === true ? ["backups"] : []), ...(input.ipv6 === true ? ["ipv6"] : []), ...(input.monitoring === true ? ["monitoring"] : []), "droplet_agent"],
        ssh_keys: input.ssh_keys ?? [],
        ipv4: null,
        ipv6: null,
        monitoring: input.monitoring === true,
        volume_ids: [],
        body,
      };
      droplets.push(droplet);
      const created = action("create", droplet.id);
      return Response.json({ droplet: dropletView(droplet), links: { actions: [{ id: created.id, rel: "create", href: `${LINK_ORIGIN}/v2/actions/${created.id}` }] } }, { status: 202 });
    }
    if (/^\/droplets\/[0-9]+$/.test(path)) {
      const droplet = droplets.find((candidate) => candidate.id === id && visible(candidate));
      if (droplet === undefined) return error(404, "not_found", "The resource you were accessing could not be found.");
      if (method === "GET") {
        for (const item of actions.values()) if (item.droplet === droplet.id && item.type === "create") advance(item);
        const view = dropletView(droplet);
        if (droplet.goneAfter !== undefined) {
          droplet.goneAfter--;
          forget();
        }
        return Response.json({ droplet: view });
      }
      if (method === "DELETE") {
        droplet.goneAfter = settings.gonePolls;
        // What was attached is detached, and kept: the volumes with their data, the reserved IPs unassigned.
        for (const address of reservedIps) if (address.droplet === droplet.id) address.droplet = null;
        forget();
        return new Response(null, { status: 204, headers: { "content-type": "application/json; charset=utf-8" } });
      }
    }
    if (method === "POST" && /^\/droplets\/[0-9]+\/actions$/.test(path)) {
      const droplet = droplets.find((candidate) => candidate.id === id && visible(candidate));
      if (droplet === undefined) return error(404, "not_found", "The resource you were accessing could not be found.");
      const type = (body as { type?: unknown } | null)?.type;
      if (type !== "enable_backups") return error(422, "unprocessable_entity", `the fake does not run ${String(type)}`);
      return Response.json({ action: actionView(action(type, droplet.id)) }, { status: 201 });
    }

    // --- Reserved IPs, the IPv4 ones and the IPv6 ones each under their own path and key
    if (method === "GET" && path === "/reserved_ips") {
      const items = reservedIps.filter((address) => !address.ip.includes(":"));
      return page(url, path, "reserved_ips", items.map((address) => {
        const assigned = droplets.find((droplet) => droplet.id === address.droplet && visible(droplet));
        return { ip: address.ip, region: regionView(address.region), droplet: assigned === undefined ? null : dropletView(assigned), locked: false, project_id: "746c6152-2fa2-11ed-92d3-27aaa54e4988" };
      }));
    }
    if (method === "GET" && path === "/reserved_ipv6") {
      const items = reservedIps.filter((address) => address.ip.includes(":"));
      return page(url, path, "reserved_ipv6s", items.map((address) => {
        const assigned = droplets.find((droplet) => droplet.id === address.droplet && visible(droplet));
        return { ip: address.ip, region_slug: address.region, reserved_at: "2026-10-01T10:00:00Z", droplet: assigned === undefined ? null : dropletView(assigned) };
      }));
    }

    // --- actions
    if (method === "GET" && /^\/actions\/[0-9]+$/.test(path)) {
      const item = actions.get(id);
      if (item === undefined) return error(404, "not_found", "The resource you were accessing could not be found.");
      advance(item);
      return Response.json({ action: actionView(item) });
    }

    return error(404, "not_found", `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}/v2`,
    environment: { DIGITALOCEAN_TOKEN: FAKE_TOKEN, SITESOLIDE_DIGITALOCEAN_API: `http://127.0.0.1:${server.port}/v2` } as Record<string, string>,
    secrets: [FAKE_TOKEN],
    keys,
    tags,
    firewalls,
    droplets,
    actions,
    requests,
    settings,
    /** The next `times` requests matching answer this error instead, `{"id", "message"}` unless `body` says otherwise. */
    /** The next `times` requests matching are handled, and their answer's body cut in half. */
    cutShort(method: string, path: RegExp, times = 1): void {
      cuts.push({ method, path, times });
    },
    /** A Reserved IP, assigned to a Droplet or not. */
    addReservedIp(input: FakeReservedIp): FakeReservedIp {
      reservedIps.push(input);
      return input;
    },
    reservedIps,
    fail(method: string, path: RegExp, status: number, id: string, message: string, extra: { headers?: Record<string, string>; times?: number; body?: unknown } = {}): void {
      failures.push({ method, path, status, body: extra.body ?? { id, message }, headers: extra.headers ?? {}, times: extra.times ?? 1 });
    },
    /** A Droplet that exists before the test, ours or not, active unless said otherwise. */
    addDroplet(input: Partial<FakeDroplet> & { name: string }): FakeDroplet {
      const serial = droplets.length + 50;
      const droplet: FakeDroplet = {
        id: nextId++,
        status: "active",
        size: "s-2vcpu-4gb",
        region: "fra1",
        image: "debian-13-x64",
        tags: [],
        features: ["ipv6"],
        ssh_keys: [],
        ipv4: `203.0.113.${serial}`,
        ipv6: `2001:db8:${serial}::a001`,
        monitoring: false,
        volume_ids: [],
        ...input,
      };
      for (const tag of droplet.tags) tags.add(tag);
      droplets.push(droplet);
      return droplet;
    },
    addKey(input: Partial<FakeKey> & { name: string; public_key: string }): FakeKey {
      const key: FakeKey = { id: nextId++, fingerprint: fingerprintOf(input.public_key), ...input };
      keys.push(key);
      return key;
    },
    addFirewall(input: Partial<FakeFirewall> & { name: string }): FakeFirewall {
      const firewall: FakeFirewall = {
        id: `0b3a9f12-0000-4000-8000-00000${String(nextId++).slice(-7)}`,
        status: "succeeded",
        inbound_rules: [{ protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0"] } }],
        outbound_rules: [],
        droplet_ids: [],
        tags: [],
        created_at: "2026-10-01T10:00:00Z",
        ...input,
      };
      for (const tag of firewall.tags) tags.add(tag);
      firewalls.push(firewall);
      return firewall;
    },
    reset(): void {
      keys.length = 0;
      tags.clear();
      firewalls.length = 0;
      droplets.length = 0;
      actions.clear();
      requests.length = 0;
      failures.length = 0;
      cuts.length = 0;
      reservedIps.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.actionPolls = options.actionPolls ?? 2;
      settings.gonePolls = options.gonePolls ?? 1;
      settings.failAction = null;
      settings.remaining = 5000;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as every provider's offers it, for bin/tests/cli-machine-providers.test.ts. */
export function createFake(): FakeProvider {
  return createFakeDigitalOcean();
}
