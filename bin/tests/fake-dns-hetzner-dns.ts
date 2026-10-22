/**
 * A local stand-in for the zones of Hetzner's Cloud API, on a random port of
 * the loopback: the tests of bin/cli/dns/hetzner-dns.ts never reach
 * api.hetzner.cloud.
 *
 * It answers in the shapes of the API's OpenAPI document,
 * https://docs.hetzner.cloud/cloud.spec.json: `{"zones": [...]}` and
 * `{"rrsets": [...]}` with `meta.pagination`, a set's name relative to its
 * zone, `@` for the zone itself, its id `<name>/<type>`, its values in
 * `records[].value`; `{"rrset", "action"}` for a set created (201),
 * `{"action"}` for the actions on a set (201), each action `running` for
 * `actionPolls` reads of GET /zones/actions/{id}, then `success`; and
 * `{"error": {"code", "message", "details"}}` errors, with the codes of the
 * reference's table. A fresh zone holds the SOA and NS sets every Hetzner
 * zone has, which `records()` leaves out.
 *
 * What the reference does not document is the fake's own, and stricter than
 * the real API may be: the wording of its messages, and a value removed that
 * the set does not hold, a 422. Lists come back `pageSize` items a page
 * whatever `per_page` asks, two by default, so that a client that reads one
 * page fails a test. `readOnly` makes the token a Read token, whose writes
 * answer 403 `forbidden`; `fail()` makes the next matching requests answer an
 * error instead.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** Shaped as a Cloud API token is, 64 letters and digits; nobody's. */
export const FAKE_TOKEN = "Tq7mZ2xK9pLw4Rv8Nc3Hb6Yd1Fs5Gj0Ae2Ui7Ok4Pl9Qz3Xw8Cv5Bn1Mt6Ry0SxW";

export const ZONE = "test-zone.invalid";

/** A zone of the project that is not the one the tests work on. */
export const OTHER_ZONE = "other-zone.invalid";

const NAME_SERVERS = ["hydrogen.ns.hetzner.com.", "oxygen.ns.hetzner.com.", "helium.ns.hetzner.de."];

const TYPES = new Set(["A", "AAAA", "CAA", "CNAME", "DS", "HINFO", "HTTPS", "MX", "NS", "PTR", "RP", "SOA", "SRV", "SVCB", "TLSA", "TXT"]);

export type FakeSet = { name: string; type: string; ttl: number | null; records: { value: string; comment: string }[]; change: boolean };
export type FakeZone = { id: number; name: string; mode: "primary" | "secondary"; ttl: number; sets: FakeSet[] };
type FakeAction = { id: number; command: string; status: "running" | "success" | "error"; reads: number; zone: number; error: { code: string; message: string } | null };
type Failure = { method: string; path: RegExp; status: number; code: string; message: string; times: number };

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, details: {} } }, { status });
}

const CREATED = "2026-10-21T10:00:00Z";

export type FakeHetznerDns = ReturnType<typeof createFakeHetznerDns>;

export function createFakeHetznerDns(options: { pageSize?: number; actionPolls?: number } = {}) {
  let nextId = 4_200;
  const zones: FakeZone[] = [];
  const actions = new Map<number, FakeAction>();
  const requests: (FakeRequest & { url: string })[] = [];
  const failures: Failure[] = [];
  const settings = { pageSize: options.pageSize ?? 2, actionPolls: options.actionPolls ?? 1, readOnly: false, failAction: null as string | null };

  /** What Hetzner creates with every zone, and lets nobody change. */
  const apex = (): FakeSet[] => [
    { name: "@", type: "SOA", ttl: null, records: [{ value: "hydrogen.ns.hetzner.com. dns.hetzner.com. 2026102100 86400 10800 3600000 3600", comment: "" }], change: true },
    { name: "@", type: "NS", ttl: null, records: NAME_SERVERS.map((value) => ({ value, comment: "" })), change: true },
  ];

  function fresh(): void {
    zones.length = 0;
    actions.clear();
    for (const name of ["a-first.invalid", ZONE, OTHER_ZONE]) zones.push({ id: nextId++, name, mode: "primary", ttl: 3600, sets: apex() });
  }
  fresh();

  const zoneView = (zone: FakeZone) => ({
    id: zone.id,
    name: zone.name,
    created: CREATED,
    mode: zone.mode,
    primary_nameservers: [],
    labels: {},
    protection: { delete: false },
    ttl: zone.ttl,
    status: "ok",
    record_count: zone.sets.reduce((count, set) => count + set.records.length, 0),
    authoritative_nameservers: { assigned: NAME_SERVERS, delegated: NAME_SERVERS, delegation_last_check: CREATED, delegation_status: "valid" },
    registrar: "other",
  });

  const setView = (zone: FakeZone, set: FakeSet) => ({
    id: `${set.name}/${set.type}`,
    name: set.name,
    type: set.type,
    ttl: set.ttl,
    labels: {},
    protection: { change: set.change },
    records: set.records.map((record) => ({ value: record.value, comment: record.comment })),
    zone: zone.id,
  });

  const actionView = (action: FakeAction) => ({
    id: action.id,
    command: action.command,
    status: action.status,
    progress: action.status === "running" ? 50 : 100,
    started: CREATED,
    finished: action.status === "running" ? null : CREATED,
    resources: [{ id: action.zone, type: "zone" }],
    error: action.error,
  });

  /** An action the API answers a write with, running until it has been read `actionPolls` times. */
  function start(command: string, zone: FakeZone): FakeAction {
    const failed = settings.failAction === command;
    const action: FakeAction = {
      id: nextId++,
      command,
      status: settings.actionPolls === 0 ? (failed ? "error" : "success") : "running",
      reads: 0,
      zone: zone.id,
      error: failed && settings.actionPolls === 0 ? { code: "action_failed", message: "Action failed" } : null,
    };
    actions.set(action.id, action);
    return action;
  }

  function page<T>(url: URL, key: string, items: T[]): Response {
    const wanted = Math.max(1, Math.min(50, Number(url.searchParams.get("per_page") ?? "25") || 25));
    const size = Math.min(wanted, settings.pageSize);
    const current = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
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
  }

  const zoneOf = (idOrName: string) => zones.find((zone) => String(zone.id) === idOrName || zone.name === idOrName);
  const setOf = (zone: FakeZone, name: string, type: string) => zone.sets.find((set) => set.name === name && set.type === type);

  /** The records of a request's body, as the reference requires them: not empty, distinct values. */
  function recordsOf(body: unknown): { value: string; comment: string }[] | Response {
    const records = (body as { records?: unknown } | null)?.records;
    if (!Array.isArray(records) || records.length === 0) return error(422, "invalid_input", "invalid input in field 'records': must not be empty");
    const values = records.map((record) => (record as { value?: unknown })?.value);
    if (values.some((value) => typeof value !== "string" || value === "")) return error(422, "invalid_input", "invalid input in field 'records': value is required");
    if (new Set(values).size !== values.length) return error(422, "invalid_input", "invalid input in field 'records': values must be distinct");
    return records.map((record) => ({ value: String((record as { value: string }).value), comment: String((record as { comment?: unknown }).comment ?? "") }));
  }

  function validName(name: unknown, zone: FakeZone): name is string {
    return typeof name === "string" && name !== "" && name === name.toLowerCase() && !name.endsWith(".") && !name.endsWith(zone.name);
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const text = method === "GET" || method === "DELETE" ? "" : await request.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return error(400, "json_error", "invalid JSON");
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const path = url.pathname.replace(/^\/v1/, "");
    requests.push({ method, path, search: url.search, body, headers, url: request.url });

    if (headers.authorization !== `Bearer ${FAKE_TOKEN}`) return error(401, "unauthorized", "unable to authenticate");
    const failure = failures.find((candidate) => candidate.method === method && candidate.path.test(path) && candidate.times > 0);
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.code, failure.message);
    }
    const write = method !== "GET";
    if (write && settings.readOnly) return error(403, "forbidden", "insufficient permissions for this request");

    if (method === "GET" && path === "/zones") {
      const name = url.searchParams.get("name");
      return page(url, "zones", zones.filter((zone) => name === null || zone.name === name).map(zoneView));
    }
    const action = /^\/zones\/actions\/(\d+)$/.exec(path);
    if (method === "GET" && action !== null) {
      const found = actions.get(Number(action[1]));
      if (found === undefined) return error(404, "not_found", "action not found");
      if (found.status === "running" && ++found.reads >= settings.actionPolls) {
        const failed = settings.failAction === found.command;
        found.status = failed ? "error" : "success";
        found.error = failed ? { code: "action_failed", message: "Action failed" } : null;
      }
      return Response.json({ action: actionView(found) });
    }

    const list = /^\/zones\/([^/]+)\/rrsets$/.exec(path);
    if (list !== null) {
      const zone = zoneOf(decodeURIComponent(list[1]!));
      if (zone === undefined) return error(404, "not_found", "zone not found");
      if (zone.mode !== "primary") return error(422, "incorrect_zone_mode", "This operation is not supported for this Zone's mode.");
      if (method === "GET") {
        const name = url.searchParams.get("name");
        const types = url.searchParams.getAll("type");
        const sets = zone.sets.filter((set) => (name === null || set.name === name) && (types.length === 0 || types.includes(set.type)));
        return page(url, "rrsets", sets.map((set) => setView(zone, set)));
      }
      if (method === "POST") {
        const order = body as { name?: unknown; type?: unknown; ttl?: unknown } | null;
        if (!validName(order?.name, zone)) return error(422, "invalid_input", "invalid input in field 'name'");
        if (typeof order?.type !== "string" || !TYPES.has(order.type)) return error(422, "invalid_input", "invalid input in field 'type'");
        if (order.ttl !== undefined && order.ttl !== null && (typeof order.ttl !== "number" || order.ttl < 60)) return error(422, "invalid_input", "invalid input in field 'ttl': must be at least 60");
        const records = recordsOf(body);
        if (records instanceof Response) return records;
        if (setOf(zone, order.name, order.type) !== undefined) return error(409, "uniqueness_error", "RRSet with the same name and type already exists");
        const created: FakeSet = { name: order.name, type: order.type, ttl: typeof order.ttl === "number" ? order.ttl : null, records, change: false };
        zone.sets.push(created);
        return Response.json({ rrset: setView(zone, created), action: actionView(start("create_rrset", zone)) }, { status: 201 });
      }
    }

    const one = /^\/zones\/([^/]+)\/rrsets\/([^/]+)\/([^/]+)(?:\/actions\/([a-z_]+))?$/.exec(path);
    if (one !== null) {
      const zone = zoneOf(decodeURIComponent(one[1]!));
      if (zone === undefined) return error(404, "not_found", "zone not found");
      if (zone.mode !== "primary") return error(422, "incorrect_zone_mode", "This operation is not supported for this Zone's mode.");
      const name = decodeURIComponent(one[2]!);
      const type = decodeURIComponent(one[3]!);
      const verb = one[4];
      const set = setOf(zone, name, type);
      if (verb === undefined && method === "GET") return set === undefined ? error(404, "not_found", "rrset not found") : Response.json({ rrset: setView(zone, set) });
      if (verb === "add_records" && method === "POST") {
        const records = recordsOf(body);
        if (records instanceof Response) return records;
        const ttl = (body as { ttl?: unknown }).ttl;
        if (set === undefined) {
          if (!validName(name, zone)) return error(422, "invalid_input", "invalid input in field 'name'");
          zone.sets.push({ name, type, ttl: typeof ttl === "number" ? ttl : null, records, change: false });
        } else {
          if (typeof ttl === "number" && set.ttl !== null && ttl !== set.ttl) return error(422, "invalid_input", "invalid input in field 'ttl': must match the RRSet's TTL");
          for (const record of records) if (!set.records.some((kept) => kept.value === record.value)) set.records.push(record);
        }
        return Response.json({ action: actionView(start("add_rrset_records", zone)) }, { status: 201 });
      }
      if (set === undefined) return error(404, "not_found", "rrset not found");
      if (verb === "set_records" && method === "POST") {
        const records = recordsOf(body);
        if (records instanceof Response) return records;
        if (set.change) return error(423, "protected", "RRSet is protected");
        set.records = records;
        return Response.json({ action: actionView(start("set_rrset_records", zone)) }, { status: 201 });
      }
      if (verb === "remove_records" && method === "POST") {
        const records = recordsOf(body);
        if (records instanceof Response) return records;
        if (set.change) return error(423, "protected", "RRSet is protected");
        if (records.some((record) => !set.records.some((kept) => kept.value === record.value))) return error(422, "invalid_input", "invalid input in field 'records': value not found in RRSet");
        set.records = set.records.filter((kept) => !records.some((record) => record.value === kept.value));
        if (set.records.length === 0) zone.sets.splice(zone.sets.indexOf(set), 1);
        return Response.json({ action: actionView(start("remove_rrset_records", zone)) }, { status: 201 });
      }
      if (verb === undefined && method === "DELETE") {
        if (set.change) return error(423, "protected", "RRSet is protected");
        zone.sets.splice(zone.sets.indexOf(set), 1);
        return Response.json({ action: actionView(start("delete_rrset", zone)) }, { status: 201 });
      }
    }
    return error(404, "not_found", `no such route in the fake: ${method} ${path}`);
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const base = `${server.url.origin}/v1`;

  const relative = (name: string, zone: FakeZone) => (name === zone.name ? "@" : name.slice(0, -(zone.name.length + 1)));
  const absolute = (name: string, zone: FakeZone) => (name === "@" ? zone.name : `${name}.${zone.name}`);
  const theZone = () => zones.find((zone) => zone.name === ZONE)!;

  return {
    zone: ZONE,
    environment: { SITESOLIDE_DNS_HETZNER_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_DNS_API: base },
    secrets: [FAKE_TOKEN],
    requests,
    base,
    zones,
    settings,
    addRecord(record: { name: string; type: string; content: string }, extra: { ttl?: number; protected?: boolean } = {}): void {
      const zone = theZone();
      const name = relative(record.name, zone);
      const set = setOf(zone, name, record.type);
      if (set === undefined) zone.sets.push({ name, type: record.type, ttl: extra.ttl ?? null, records: [{ value: record.content, comment: "" }], change: extra.protected ?? false });
      else set.records.push({ value: record.content, comment: "" });
    },
    records(): { name: string; type: string; content: string }[] {
      const zone = theZone();
      return zone.sets
        .filter((set) => !(set.name === "@" && (set.type === "SOA" || set.type === "NS")))
        .flatMap((set) => set.records.map((record) => ({ name: absolute(set.name, zone), type: set.type, content: record.value })));
    },
    /** The set of that absolute name and type, as the fake keeps it. */
    set(name: string, type: string): FakeSet | undefined {
      const zone = theZone();
      return setOf(zone, relative(name, zone), type);
    },
    /** The requests that changed something. */
    writes(): (FakeRequest & { url: string })[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, code: string, message: string, times = 1): void {
      failures.push({ method, path, status, code, message, times });
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.actionPolls = options.actionPolls ?? 1;
      settings.readOnly = false;
      settings.failAction = null;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export function createFake(): FakeDns {
  return createFakeHetznerDns();
}
