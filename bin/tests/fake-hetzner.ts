/**
 * A local stand-in for the Hetzner Cloud API, on a random port of the
 * loopback: the tests of `sitesolide machine` never reach the real one.
 *
 * It keeps a project in memory (SSH keys, firewalls, servers, actions) and
 * answers the calls bin/cli/providers/hetzner.ts makes, in the shapes of
 * https://docs.hetzner.cloud/reference/cloud: the `{"error": {"code",
 * "message", "details"}}` errors, `meta.pagination` on every list, actions
 * that run for a few polls before they succeed, names unique per project.
 *
 * Lists come back `pageSize` items a page whatever `per_page` asks, two by
 * default, so that a client that reads only the first page fails a test.
 * `fail()` makes the next matching request answer an error instead.
 */

export const FAKE_TOKEN = "fake-hcloud-token-0123456789abcdef0123456789abcdef0123456789abcdef";

type Labels = Record<string, string>;
export type FakeKey = { id: number; name: string; fingerprint: string; public_key: string; labels: Labels; created: string };
export type FakeFirewall = {
  id: number;
  name: string;
  labels: Labels;
  rules: unknown[];
  applied_to: { type: string; server?: { id: number }; label_selector?: { selector: string } }[];
  created: string;
};
export type FakeServer = {
  id: number;
  name: string;
  status: string;
  labels: Labels;
  backup_window: string | null;
  server_type: string;
  location: string;
  image: string;
  ssh_keys: number[];
  firewalls: number[];
  ipv4: string | null;
  ipv6: string | null;
  user_data?: unknown;
};
type FakeAction = { id: number; command: string; status: "running" | "success" | "error"; progress: number; polls: number; resource: number; error: { code: string; message: string } | null };
export type Received = { method: string; path: string; search: string; url: string; authorization: string | null; body: unknown };
type Failure = { method: string; path: RegExp; status: number; code: string; message: string; headers?: Record<string, string>; details?: unknown; times: number };

const price = (net: string) => ({
  price_hourly: { net: (Number(net) / 720).toFixed(10), gross: (Number(net) / 600).toFixed(10) },
  price_monthly: { net, gross: (Number(net) * 1.19).toFixed(10) },
  included_traffic: 21990232555520,
  price_per_tb_traffic: { net: "1.0000000000", gross: "1.1900000000" },
});

const at = (locations: string[], net: string) => locations.map((location) => ({ location, ...price(net) }));
const sold = (locations: string[], extra: Record<string, object> = {}) =>
  locations.map((name, id) => ({ id: id + 1, name, deprecation: null, recommended: true, available: true, ...(extra[name] ?? {}) }));

const EU = ["fsn1", "nbg1", "hel1"];

/** What the fake sells, as of October 2026, close enough to the real list to read like it. */
export const SERVER_TYPES = [
  { id: 104, name: "cx22", description: "CX22", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: true, prices: at(EU, "3.7900000000"), locations: sold(EU, { fsn1: { deprecation: { announced: "2025-10-01T00:00:00Z", unavailable_after: "2026-01-01T00:00:00Z" } }, nbg1: { deprecation: { announced: "2025-10-01T00:00:00Z", unavailable_after: "2026-01-01T00:00:00Z" } }, hel1: { deprecation: { announced: "2025-10-01T00:00:00Z", unavailable_after: "2026-01-01T00:00:00Z" } } }) },
  { id: 108, name: "cx23", description: "CX23", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false, prices: at(EU, "3.4900000000"), locations: sold(EU) },
  { id: 109, name: "cx33", description: "CX33", cores: 4, memory: 8, disk: 80, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false, prices: at(EU, "5.4900000000"), locations: sold(EU) },
  { id: 110, name: "cx43", description: "CX43", cores: 8, memory: 16, disk: 160, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false, prices: at(EU, "9.4900000000"), locations: sold(EU, { hel1: { available: false } }) },
  { id: 45, name: "cax11", description: "CAX11", cores: 2, memory: 4, disk: 40, cpu_type: "shared", architecture: "arm", storage_type: "local", deprecated: false, prices: at(["fsn1", "nbg1", "hel1"], "3.7900000000"), locations: sold(["fsn1", "nbg1", "hel1"]) },
  { id: 96, name: "ccx13", description: "CCX13", cores: 2, memory: 8, disk: 80, cpu_type: "dedicated", architecture: "x86", storage_type: "local", deprecated: false, prices: at(["fsn1", "nbg1", "hel1", "ash"], "12.4900000000"), locations: sold(["fsn1", "nbg1", "hel1", "ash"]) },
  { id: 120, name: "cpx11", description: "CPX11", cores: 2, memory: 2, disk: 40, cpu_type: "shared", architecture: "x86", storage_type: "local", deprecated: false, prices: at(["ash"], "4.9900000000"), locations: sold(["ash"]) },
];

export const LOCATIONS = [
  { id: 1, name: "fsn1", description: "Falkenstein DC Park 1", country: "DE", city: "Falkenstein", latitude: 50.47612, longitude: 12.370071, network_zone: "eu-central" },
  { id: 2, name: "nbg1", description: "Nuremberg DC Park 1", country: "DE", city: "Nuremberg", latitude: 49.452102, longitude: 11.076665, network_zone: "eu-central" },
  { id: 3, name: "hel1", description: "Helsinki DC Park 1", country: "FI", city: "Helsinki", latitude: 60.169855, longitude: 24.938379, network_zone: "eu-central" },
  { id: 4, name: "ash", description: "Ashburn, VA", country: "US", city: "Ashburn, VA", latitude: 39.045, longitude: -77.487, network_zone: "us-east" },
];

/** `k=v`, `k==v` and `k` joined by commas: as much of the label selector as the client uses. */
function matches(labels: Labels, selector: string | null): boolean {
  if (selector === null || selector === "") return true;
  return selector.split(",").every((term) => {
    const [key = "", value] = term.split(/==?/);
    return value === undefined ? Object.hasOwn(labels, key.trim()) : labels[key.trim()] === value.trim();
  });
}

function error(status: number, code: string, message: string, details: unknown = null, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message, details } }, { status, headers });
}

export type FakeHetzner = ReturnType<typeof createFakeHetzner>;

export function createFakeHetzner(options: { pageSize?: number; actionPolls?: number } = {}) {
  let nextId = 1000;
  const keys: FakeKey[] = [];
  const firewalls: FakeFirewall[] = [];
  const servers: FakeServer[] = [];
  const actions = new Map<number, FakeAction>();
  /** The addresses, Primary IPs of their own: the IPv4's id is ten times the server's plus one, the IPv6's plus two. */
  const primaryIps = new Map<number, { id: number; ip: string; type: string; auto_delete: boolean; assignee_id: number | null }>();
  const assignAddresses = (server: FakeServer): void => {
    if (server.ipv4 !== null) primaryIps.set(server.id * 10 + 1, { id: server.id * 10 + 1, ip: server.ipv4, type: "ipv4", auto_delete: true, assignee_id: server.id });
    if (server.ipv6 !== null) primaryIps.set(server.id * 10 + 2, { id: server.id * 10 + 2, ip: server.ipv6, type: "ipv6", auto_delete: true, assignee_id: server.id });
  };
  const requests: Received[] = [];
  const failures: Failure[] = [];
  /** `failCommand`: the action of that command ends in error rather than success. */
  const settings: { pageSize: number; actionPolls: number; currency: string; failCommand: string | null } = {
    pageSize: options.pageSize ?? 2,
    actionPolls: options.actionPolls ?? 2,
    currency: "EUR",
    failCommand: null,
  };

  const page = <T>(url: URL, key: string, items: T[]): Response => {
    const wanted = Math.max(1, Number(url.searchParams.get("per_page") ?? "25"));
    const size = Math.min(wanted, settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const last = Math.max(1, Math.ceil(items.length / size));
    return Response.json({
      [key]: items.slice((current - 1) * size, current * size),
      meta: {
        pagination: {
          page: current,
          per_page: size,
          previous_page: current > 1 ? current - 1 : null,
          next_page: current < last ? current + 1 : null,
          last_page: last,
          total_entries: items.length,
        },
      },
    });
  };

  const action = (command: string, resource: number): FakeAction => {
    const created: FakeAction = { id: nextId++, command, status: "running", progress: 0, polls: 0, resource, error: null };
    actions.set(created.id, created);
    return created;
  };

  const actionView = (item: FakeAction) => ({
    id: item.id,
    command: item.command,
    status: item.status,
    progress: item.progress,
    started: "2026-10-05T10:00:00Z",
    finished: item.status === "running" ? null : "2026-10-05T10:00:30Z",
    resources: [{ id: item.resource, type: "server" }],
    error: item.error,
  });

  /** What an action does to the project once it succeeds. */
  const complete = (item: FakeAction): void => {
    const server = servers.find((candidate) => candidate.id === item.resource);
    if (item.command === "create_server" && server !== undefined) server.status = "off";
    if (item.command === "start_server" && server !== undefined) server.status = "running";
    if (item.command === "enable_backup" && server !== undefined) server.backup_window = "22-02";
    if (item.command === "delete_server") {
      const index = servers.findIndex((candidate) => candidate.id === item.resource);
      if (index !== -1) servers.splice(index, 1);
      for (const address of [...primaryIps.values()].filter((candidate) => candidate.assignee_id === item.resource)) {
        if (address.auto_delete) primaryIps.delete(address.id);
        else address.assignee_id = null;
      }
      for (const firewall of firewalls) firewall.applied_to = firewall.applied_to.filter((target) => target.server?.id !== item.resource);
    }
  };

  const serverView = (server: FakeServer) => {
    const type = SERVER_TYPES.find((candidate) => candidate.name === server.server_type);
    return {
      id: server.id,
      name: server.name,
      status: server.status,
      created: "2026-10-05T10:00:00Z",
      public_net: {
        ipv4: server.ipv4 === null ? null : { id: server.id * 10 + 1, ip: server.ipv4, blocked: false, dns_ptr: `static.${server.ipv4}.clients.your-server.test-zone.invalid` },
        ipv6: server.ipv6 === null ? null : { id: server.id * 10 + 2, ip: server.ipv6, blocked: false, dns_ptr: [] },
        floating_ips: [],
        firewalls: server.firewalls.map((id) => ({ id, status: "applied" })),
      },
      private_net: [],
      server_type: type ?? { name: server.server_type, prices: [] },
      location: LOCATIONS.find((candidate) => candidate.name === server.location) ?? { name: server.location },
      image: { id: 114690387, type: "system", status: "available", name: server.image, os_flavor: "debian" },
      iso: null,
      rescue_enabled: false,
      locked: false,
      backup_window: server.backup_window,
      outgoing_traffic: 0,
      ingoing_traffic: 0,
      included_traffic: 21990232555520,
      protection: { delete: false, rebuild: false },
      labels: server.labels,
      volumes: [],
      load_balancers: [],
      primary_disk_size: type?.disk ?? 40,
    };
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/v1/, "");
    let body: unknown = null;
    if (method === "POST" || method === "PUT") {
      const text = await request.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        return error(400, "json_error", "invalid JSON input");
      }
    }
    requests.push({ method, path, search: url.search, url: request.url, authorization: request.headers.get("authorization"), body });

    if (request.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) return error(401, "unauthorized", "unable to authenticate");
    const failure = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.code, failure.message, failure.details ?? null, failure.headers ?? {});
    }

    const selector = url.searchParams.get("label_selector");
    const name = url.searchParams.get("name");
    const id = Number(/\/([0-9]+)(?:\/|$)/.exec(path)?.[1] ?? "0");

    if (method === "GET" && path === "/locations") return page(url, "locations", LOCATIONS);
    if (method === "GET" && path === "/server_types") return page(url, "server_types", SERVER_TYPES);
    if (method === "GET" && path === "/pricing") return Response.json({ pricing: { currency: settings.currency, vat_rate: "19.00", server_types: [] } });

    // --- SSH keys
    if (method === "GET" && path === "/ssh_keys") {
      return page(url, "ssh_keys", keys.filter((key) => matches(key.labels, selector) && (name === null || key.name === name)));
    }
    if (method === "POST" && path === "/ssh_keys") {
      const input = body as { name: string; public_key: string; labels?: Labels };
      const blob = input.public_key.split(/\s+/)[1] ?? "";
      const fingerprint = new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g)!.join(":");
      if (keys.some((key) => key.name === input.name)) return error(409, "uniqueness_error", "name is already used", { fields: [{ name: "name" }] });
      if (keys.some((key) => key.fingerprint === fingerprint)) return error(409, "uniqueness_error", "SSH key with the same fingerprint already exists", { fields: [{ name: "public_key" }] });
      const key: FakeKey = { id: nextId++, name: input.name, fingerprint, public_key: input.public_key, labels: input.labels ?? {}, created: "2026-10-05T10:00:00Z" };
      keys.push(key);
      return Response.json({ ssh_key: key }, { status: 201 });
    }
    if (method === "DELETE" && /^\/ssh_keys\/[0-9]+$/.test(path)) {
      const index = keys.findIndex((key) => key.id === id);
      if (index === -1) return error(404, "not_found", "SSH key not found");
      keys.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    // --- firewalls
    if (method === "GET" && path === "/firewalls") {
      return page(url, "firewalls", firewalls.filter((firewall) => matches(firewall.labels, selector) && (name === null || firewall.name === name)));
    }
    if (method === "POST" && path === "/firewalls") {
      const input = body as { name: string; labels?: Labels; rules?: unknown[] };
      if (firewalls.some((firewall) => firewall.name === input.name)) return error(409, "uniqueness_error", "name is already used", { fields: [{ name: "name" }] });
      const firewall: FakeFirewall = { id: nextId++, name: input.name, labels: input.labels ?? {}, rules: input.rules ?? [], applied_to: [], created: "2026-10-05T10:00:00Z" };
      firewalls.push(firewall);
      return Response.json({ firewall, actions: [] }, { status: 201 });
    }
    if (method === "GET" && /^\/firewalls\/[0-9]+$/.test(path)) {
      const firewall = firewalls.find((candidate) => candidate.id === id);
      return firewall === undefined ? error(404, "not_found", "firewall not found") : Response.json({ firewall });
    }
    if (method === "DELETE" && /^\/firewalls\/[0-9]+$/.test(path)) {
      const index = firewalls.findIndex((candidate) => candidate.id === id);
      if (index === -1) return error(404, "not_found", "firewall not found");
      if (firewalls[index]!.applied_to.length > 0) return error(422, "resource_in_use", "firewall is still in use");
      firewalls.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    // --- servers
    if (method === "GET" && path === "/servers") {
      return page(url, "servers", servers.filter((server) => matches(server.labels, selector) && (name === null || server.name === name)).map(serverView));
    }
    if (method === "POST" && path === "/servers") {
      const input = body as { name: string; server_type: string; location: string; image: string; ssh_keys?: number[]; firewalls?: { firewall: number }[]; labels?: Labels; user_data?: unknown; public_net?: { enable_ipv4?: boolean; enable_ipv6?: boolean } };
      if (servers.some((server) => server.name === input.name)) return error(409, "uniqueness_error", "server name is already used", { fields: [{ name: "name" }] });
      const type = SERVER_TYPES.find((candidate) => candidate.name === input.server_type);
      if (type === undefined) return error(422, "invalid_input", "invalid input in field 'server_type'", { fields: [{ name: "server_type", messages: ["unknown server type"] }] });
      for (const key of input.ssh_keys ?? []) if (!keys.some((candidate) => candidate.id === key)) return error(422, "invalid_input", "invalid input in field 'ssh_keys'", { fields: [{ name: "ssh_keys", messages: [`ssh key ${key} not found`] }] });
      const serial = servers.length + 10;
      const server: FakeServer = {
        id: nextId++,
        name: input.name,
        status: "initializing",
        labels: input.labels ?? {},
        backup_window: null,
        server_type: input.server_type,
        location: input.location,
        image: input.image,
        ssh_keys: input.ssh_keys ?? [],
        firewalls: (input.firewalls ?? []).map((entry) => entry.firewall),
        ipv4: input.public_net?.enable_ipv4 === false ? null : `203.0.113.${serial}`,
        ipv6: input.public_net?.enable_ipv6 === false ? null : `2001:db8:${serial}::/64`,
        ...(input.user_data === undefined ? {} : { user_data: input.user_data }),
      };
      servers.push(server);
      assignAddresses(server);
      for (const firewallId of server.firewalls) firewalls.find((candidate) => candidate.id === firewallId)?.applied_to.push({ type: "server", server: { id: server.id } });
      const created = action("create_server", server.id);
      const start = action("start_server", server.id);
      return Response.json({ server: serverView(server), action: actionView(created), next_actions: [actionView(start)], root_password: null }, { status: 201 });
    }
    if (method === "GET" && /^\/servers\/[0-9]+$/.test(path)) {
      const server = servers.find((candidate) => candidate.id === id);
      return server === undefined ? error(404, "not_found", "server not found") : Response.json({ server: serverView(server) });
    }
    if (method === "DELETE" && /^\/servers\/[0-9]+$/.test(path)) {
      const server = servers.find((candidate) => candidate.id === id);
      if (server === undefined) return error(404, "not_found", "server not found");
      server.status = "deleting";
      return Response.json({ action: actionView(action("delete_server", server.id)) });
    }
    if (method === "POST" && /^\/servers\/[0-9]+\/actions\/enable_backup$/.test(path)) {
      const server = servers.find((candidate) => candidate.id === id);
      if (server === undefined) return error(404, "not_found", "server not found");
      return Response.json({ action: actionView(action("enable_backup", server.id)) }, { status: 201 });
    }

    if (method === "GET" && /^\/primary_ips\/[0-9]+$/.test(path)) {
      const address = primaryIps.get(id);
      if (address === undefined) return error(404, "not_found", "primary IP not found");
      return Response.json({ primary_ip: { ...address, name: `primary_ip-${address.id}`, labels: {}, blocked: false, assignee_type: address.assignee_id === null ? "unassigned" : "server" } });
    }

    // --- actions
    if (method === "GET" && /^\/actions\/[0-9]+$/.test(path)) {
      const item = actions.get(id);
      if (item === undefined) return error(404, "not_found", "action not found");
      if (item.status === "running") {
        item.polls++;
        item.progress = Math.min(100, Math.round((100 * item.polls) / settings.actionPolls));
        if (item.polls >= settings.actionPolls && item.command === settings.failCommand) {
          item.status = "error";
          item.error = { code: "action_failed", message: "the host could not complete the action" };
        } else if (item.polls >= settings.actionPolls) {
          item.status = "success";
          complete(item);
        }
      }
      return Response.json({ action: actionView(item) });
    }

    return error(404, "not_found", `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    keys,
    firewalls,
    servers,
    actions,
    primaryIps,
    requests,
    settings,
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, code: string, message: string, extra: { headers?: Record<string, string>; details?: unknown; times?: number } = {}): void {
      failures.push({ method, path, status, code, message, headers: extra.headers, details: extra.details, times: extra.times ?? 1 });
    },
    /** A server that exists before the test, ours or not. */
    addServer(input: Partial<FakeServer> & { name: string }): FakeServer {
      const serial = servers.length + 50;
      const server: FakeServer = {
        id: nextId++,
        status: "running",
        labels: {},
        backup_window: null,
        server_type: "cx33",
        location: "fsn1",
        image: "debian-13",
        ssh_keys: [],
        firewalls: [],
        ipv4: `203.0.113.${serial}`,
        ipv6: `2001:db8:${serial}::/64`,
        ...input,
      };
      servers.push(server);
      assignAddresses(server);
      for (const firewallId of server.firewalls) firewalls.find((candidate) => candidate.id === firewallId)?.applied_to.push({ type: "server", server: { id: server.id } });
      return server;
    },
    addKey(input: Partial<FakeKey> & { name: string; public_key: string }): FakeKey {
      const blob = input.public_key.split(/\s+/)[1] ?? "";
      const fingerprint = new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g)!.join(":");
      const key: FakeKey = { id: nextId++, fingerprint, labels: {}, created: "2026-10-05T10:00:00Z", ...input };
      keys.push(key);
      return key;
    },
    addFirewall(input: Partial<FakeFirewall> & { name: string }): FakeFirewall {
      const firewall: FakeFirewall = { id: nextId++, labels: {}, rules: [], applied_to: [], created: "2026-10-05T10:00:00Z", ...input };
      firewalls.push(firewall);
      return firewall;
    },
    reset(): void {
      keys.length = 0;
      firewalls.length = 0;
      servers.length = 0;
      actions.clear();
      primaryIps.clear();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.actionPolls = options.actionPolls ?? 2;
      settings.currency = "EUR";
      settings.failCommand = null;
    },
    stop(): void {
      server.stop(true);
    },
  };
}
