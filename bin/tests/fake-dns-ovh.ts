/**
 * A local stand-in for the OVHcloud API's DNS zones, on a random port of the
 * loopback: the tests of bin/cli/dns/ovh.ts never reach eu.api.ovh.com.
 *
 * It answers in the shapes of the API's own description,
 * https://eu.api.ovh.com/1.0/domain.json and auth.json: GET /auth/time, the
 * API's clock in seconds, without credentials; GET /auth/currentCredential;
 * a zone's SOA; a name's records as a list of ids, `subDomain` filtering them
 * case-insensitively, each record then read alone, `{"id", "zone",
 * "subDomain", "fieldType", "target", "ttl"}`; a record created (the record),
 * changed or deleted (null); POST refresh (null). Its errors are those
 * OVHcloud's libraries read, `{"errorCode", "httpCode", "message"}` for the
 * credentials and the rules, `{"class", "message"}` for a missing object.
 *
 * It checks every signed request as OVHcloud does: the application key, the
 * consumer key, the timestamp against its clock, which runs `skew` seconds
 * ahead of the workstation's so that a client must read /auth/time, and the
 * signature over the method, the whole address, the body and the timestamp.
 * The consumer key's access rules are enforced, `*` matching anything, the
 * query left out: by default the seven rules bin/cli/dns/ovh.ts asks for on
 * the zone, which do not grant /auth/currentCredential.
 *
 * What the reference does not document is the fake's own, and stricter than
 * the real API may be: a TTL under 60 seconds, the lowest OVHcloud's console
 * takes, is refused, and so is an address that is not one, in wordings of the
 * fake's. `fail()` makes the next matching requests answer an error instead.
 */
import { accessRules, signature } from "../cli/dns/ovh";
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "./fake-provider";

/** Shaped as OVHcloud's are, 16 and 32 letters and digits; nobody's. */
export const FAKE_APPLICATION_KEY = "Hq4Lm8Rt2Vb6Nw9K";
export const FAKE_APPLICATION_SECRET = "Zp3Xc7Vb1Nm5Qw9Er2Ty6Ui0Op4As8Df";
export const FAKE_CONSUMER_KEY = "Gk2Hj6Kl0Zx4Cv8Bn3Mq7Wr1Te5Yu9Ip";

export const ZONE = "test-zone.invalid";

/** How far ahead of the workstation the fake's clock runs, in seconds. */
export const SKEW = 3_600;

const TYPES = new Set(["A", "AAAA", "CAA", "CNAME", "DKIM", "DMARC", "DNAME", "HTTPS", "LOC", "MX", "NAPTR", "NS", "PTR", "RP", "SPF", "SRV", "SSHFP", "SVCB", "TLSA", "TXT"]);

export type FakeRecord = { id: number; subDomain: string; fieldType: string; target: string; ttl: number };
export type FakeZone = { name: string; records: FakeRecord[]; refreshed: number };
export type Rule = { method: string; path: string };
type Failure = { method: string; path: RegExp; status: number; body: Record<string, unknown>; times: number };

function error(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

const NOT_GRANTED = () => error(403, { errorCode: "NOT_GRANTED_CALL", httpCode: "403 Forbidden", message: "This call has not been granted" });
const NOT_FOUND = () => error(404, { class: "Client::NotFound", message: "This service does not exist" });

/** Whether a rule grants a call: the method, and the path, `*` matching anything. */
function grants(rule: Rule, method: string, path: string): boolean {
  if (rule.method !== method) return false;
  const pattern = rule.path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}$`).test(path);
}

export type FakeOvhDns = ReturnType<typeof createFakeOvhDns>;

export function createFakeOvhDns() {
  let nextId = 5_123_400_000;
  const zones: FakeZone[] = [];
  const requests: (FakeRequest & { url: string })[] = [];
  const failures: Failure[] = [];
  /** `filterSubDomain` false: `subDomain` filters nothing, as an empty filter may not on the real API. */
  const settings: { rules: Rule[]; status: "validated" | "pendingValidation" | "expired" | "refused"; filterSubDomain: boolean } = {
    rules: accessRules(ZONE),
    status: "validated",
    filterSubDomain: true,
  };

  function fresh(): void {
    zones.length = 0;
    for (const name of ["a-first.invalid", ZONE, "other-zone.invalid"]) {
      zones.push({
        name,
        refreshed: 0,
        records: ["dns200.ovh.net.", "ns200.ovh.net."].map((target) => ({ id: nextId++, subDomain: "", fieldType: "NS", target, ttl: 0 })),
      });
    }
  }
  fresh();

  const now = () => Math.floor(Date.now() / 1000) + SKEW;
  const recordView = (zone: FakeZone, record: FakeRecord) => ({ id: record.id, zone: zone.name, subDomain: record.subDomain, fieldType: record.fieldType, target: record.target, ttl: record.ttl });

  /** The body of a create or an update, checked as the fake checks it. */
  function invalid(fieldType: string, target: unknown, ttl: unknown): Response | null {
    if (typeof target !== "string" || target === "") return error(400, { class: "Client::BadRequest", message: "Invalid target" });
    if (fieldType === "A" && !/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return error(400, { class: "Client::BadRequest", message: `Invalid IPv4 address: ${target}` });
    if (fieldType === "AAAA" && !target.includes(":")) return error(400, { class: "Client::BadRequest", message: `Invalid IPv6 address: ${target}` });
    if (ttl !== undefined && ttl !== null && (typeof ttl !== "number" || ttl < 60)) return error(400, { class: "Client::BadRequest", message: "The TTL must be at least 60 seconds" });
    return null;
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
        return error(400, { class: "Client::BadRequest", message: "Invalid JSON" });
      }
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const path = url.pathname.replace(/^\/1\.0/, "");
    requests.push({ method, path, search: url.search, body, headers, url: request.url });

    if (method === "GET" && path === "/auth/time") return Response.json(now());

    if (headers["x-ovh-application"] !== FAKE_APPLICATION_KEY) return error(403, { errorCode: "INVALID_KEY", httpCode: "403 Forbidden", message: "Invalid application key" });
    if (headers["x-ovh-consumer"] !== FAKE_CONSUMER_KEY) return error(403, { errorCode: "INVALID_CREDENTIAL", httpCode: "403 Forbidden", message: "This credential is not valid" });
    const timestamp = Number(headers["x-ovh-timestamp"]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp - now()) > 10) return error(400, { errorCode: "QUERY_TIME_OUT", httpCode: "400 Bad Request", message: "Query out of time" });
    if (headers["x-ovh-signature"] !== signature(FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY, method, request.url, text, timestamp)) {
      return error(400, { errorCode: "INVALID_SIGNATURE", httpCode: "400 Bad Request", message: "Invalid signature" });
    }
    const credentialCall = method === "GET" && path === "/auth/currentCredential";
    // A key not validated reads its own state, when its rules grant that, and nothing else.
    if (settings.status !== "validated" && !credentialCall) return error(403, { errorCode: "INVALID_CREDENTIAL", httpCode: "403 Forbidden", message: "This credential is not valid" });
    if (!settings.rules.some((rule) => grants(rule, method, path))) return NOT_GRANTED();
    const failure = failures.find((candidate) => candidate.method === method && candidate.path.test(path) && candidate.times > 0);
    if (failure !== undefined) {
      failure.times--;
      return error(failure.status, failure.body);
    }

    if (credentialCall) {
      return Response.json({
        allowedIPs: null,
        applicationId: 271_828,
        creation: "2026-10-21T10:00:00+02:00",
        credentialId: 314_159_265,
        expiration: null,
        lastUse: "2026-10-21T10:05:00+02:00",
        ovhSupport: false,
        rules: settings.rules,
        status: settings.status,
      });
    }

    const match = /^\/domain\/zone\/([^/]+)\/(soa|refresh|record)(?:\/([^/]+))?$/.exec(path);
    if (match === null) return NOT_FOUND();
    const zone = zones.find((candidate) => candidate.name === decodeURIComponent(match[1]!));
    if (zone === undefined) return NOT_FOUND();
    const [, , kind, id] = match;

    if (kind === "soa" && method === "GET" && id === undefined) {
      return Response.json({ email: "tech@ovh.net", expire: 1_209_600, nxDomainTtl: 86_400, refresh: 86_400, serial: 2026102100 + zone.refreshed, server: "dns200.ovh.net", ttl: 86_400 });
    }
    if (kind === "refresh" && method === "POST" && id === undefined) {
      zone.refreshed++;
      return Response.json(null);
    }
    if (kind === "record" && id === undefined) {
      if (method === "GET") {
        const fieldType = url.searchParams.get("fieldType");
        const subDomain = settings.filterSubDomain ? url.searchParams.get("subDomain") : null;
        return Response.json(
          zone.records.filter((record) => (fieldType === null || record.fieldType === fieldType) && (subDomain === null || record.subDomain.toLowerCase() === subDomain.toLowerCase())).map((record) => record.id),
        );
      }
      if (method === "POST") {
        const order = body as { fieldType?: unknown; subDomain?: unknown; target?: unknown; ttl?: unknown } | null;
        if (typeof order?.fieldType !== "string" || !TYPES.has(order.fieldType)) return error(400, { class: "Client::BadRequest", message: "Invalid fieldType" });
        const refused = invalid(order.fieldType, order.target, order.ttl);
        if (refused !== null) return refused;
        const created: FakeRecord = { id: nextId++, subDomain: typeof order.subDomain === "string" ? order.subDomain : "", fieldType: order.fieldType, target: order.target as string, ttl: typeof order.ttl === "number" ? order.ttl : 0 };
        zone.records.push(created);
        return Response.json(recordView(zone, created));
      }
    }
    if (kind === "record" && id !== undefined) {
      const record = zone.records.find((candidate) => String(candidate.id) === id);
      if (record === undefined) return error(404, { class: "Client::NotFound", message: `The requested object (id = ${id}) does not exist` });
      if (method === "GET") return Response.json(recordView(zone, record));
      if (method === "PUT") {
        const order = body as { subDomain?: unknown; target?: unknown; ttl?: unknown } | null;
        const refused = invalid(record.fieldType, order?.target ?? record.target, order?.ttl);
        if (refused !== null) return refused;
        if (typeof order?.target === "string") record.target = order.target;
        if (typeof order?.subDomain === "string") record.subDomain = order.subDomain;
        if (typeof order?.ttl === "number") record.ttl = order.ttl;
        return Response.json(null);
      }
      if (method === "DELETE") {
        zone.records.splice(zone.records.indexOf(record), 1);
        return Response.json(null);
      }
    }
    return NOT_FOUND();
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const base = `${server.url.origin}/1.0`;
  const theZone = () => zones.find((zone) => zone.name === ZONE)!;

  return {
    zone: ZONE,
    environment: {
      SITESOLIDE_DNS_OVH_ENDPOINT: "ovh-eu",
      SITESOLIDE_DNS_OVH_APPLICATION_KEY: FAKE_APPLICATION_KEY,
      SITESOLIDE_DNS_OVH_APPLICATION_SECRET: FAKE_APPLICATION_SECRET,
      SITESOLIDE_DNS_OVH_CONSUMER_KEY: FAKE_CONSUMER_KEY,
      SITESOLIDE_OVH_DNS_API: base,
    },
    secrets: [FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY],
    requests,
    base,
    zones,
    settings,
    addRecord(record: { name: string; type: string; content: string }, ttl = 0): void {
      const subDomain = record.name === ZONE ? "" : record.name.slice(0, -(ZONE.length + 1));
      theZone().records.push({ id: nextId++, subDomain, fieldType: record.type, target: record.content, ttl });
    },
    records(): { name: string; type: string; content: string }[] {
      return theZone()
        .records.filter((record) => !(record.subDomain === "" && record.fieldType === "NS"))
        .map((record) => ({ name: record.subDomain === "" ? ZONE : `${record.subDomain}.${ZONE}`, type: record.fieldType, content: record.target }));
    },
    /** The records of the zone as the fake keeps them, ids and TTLs included. */
    stored(): FakeRecord[] {
      return theZone().records;
    },
    /** How many times the zone was refreshed. */
    refreshed(): number {
      return theZone().refreshed;
    },
    writes(): (FakeRequest & { url: string })[] {
      return requests.filter((request) => request.method !== "GET");
    },
    /** The next `times` requests matching answer this error instead. */
    fail(method: string, path: RegExp, status: number, body: Record<string, unknown>, times = 1): void {
      failures.push({ method, path, status, body, times });
    },
    reset(): void {
      fresh();
      requests.length = 0;
      failures.length = 0;
      settings.rules = accessRules(ZONE);
      settings.status = "validated";
      settings.filterSubDomain = true;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

export function createFake(): FakeDns {
  return createFakeOvhDns();
}
