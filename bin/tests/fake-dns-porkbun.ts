/**
 * A local stand-in for Porkbun's API v3, on a random port of the loopback:
 * the tests of bin/cli/dns/porkbun.ts never reach api.porkbun.com.
 *
 * It holds an account of a few domains, `test-zone.invalid` among them, and
 * the zone's records, and answers the calls the provider makes in the shapes
 * of https://porkbun.com/api/json/v3/spec (3.63) and of Porkbun's own
 * credential-free mock, https://api.porkbun.com/api/json/v3/mock: records
 * named in full, `ttl` and `prio` as strings, ids numeric strings, a domain
 * list cut in pages by the `start` offset, every answer `{"status": "SUCCESS"}`
 * or `{"status": "ERROR", "code", "message", "next_action"}`.
 *
 * The keys are taken from `X-API-Key` and `X-Secret-API-Key`, or from the
 * body's `apikey` and `secretapikey` when it has them, as the API documents.
 * What api.porkbun.com answered on 21 October 2026 to keys it did not know,
 * and to none, is what the fake answers: /ping without keys gives the
 * caller's address alone, `INVALID_API_KEYS` "Invalid API key." on /ping and
 * `INVALID_API_KEYS_001` "Invalid API key. (001)" elsewhere, HTTP 400,
 * `API_KEY_REQUIRED` without keys. The other codes and their HTTP status are
 * the documentation's; their messages are the fake's guess.
 *
 * It enforces what a key's restrictions and a domain's setting do: a key
 * without the `dns` permission is refused writes (403 INSUFFICIENT_SCOPE), one
 * whose allowed domains leave the zone out is refused it (403
 * DOMAIN_NOT_ALLOWED), a domain without API access answers 400
 * API_ACCESS_DISABLED; and RFC 1034's rule, a CNAME alone at its name (400
 * RECORD_CONFLICT). The domain list comes back `pageSize` domains a page, two
 * by default where Porkbun gives a thousand, so that a client that reads only
 * the first page fails a test.
 */
import type { FakeDns } from "./fake-dns";
import type { FakeRequest } from "../../clouds/fakes/fake-provider";

/** `pk1_` and `sk1_`, then 64 hexadecimal digits: the shape of Porkbun's keys. */
export const FAKE_API_KEY = "pk1_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
export const FAKE_SECRET_KEY = "sk1_ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
export const ZONE = "test-zone.invalid";

/** The account's other domains: the zone is on the second page of two. */
export const OTHER_DOMAINS = ["alpha-zone.invalid", "beta-zone.invalid", "omega-zone.invalid"];

export type FakeRecord = { id: string; name: string; type: string; content: string; ttl: string; prio: string; notes: string };
export type Received = FakeRequest & { url: string };
type Failure = { method: string; path: RegExp; status: number; body?: unknown; raw?: string; times: number };

const TYPES = ["A", "AAAA", "MX", "CNAME", "ALIAS", "TXT", "NS", "SRV", "TLSA", "CAA", "SSHFP", "HTTPS", "SVCB", "DS"];

let requestSerial = 0;
function requestId(): string {
  requestSerial++;
  return `01a1604b-0000-7000-8000-${String(requestSerial).padStart(12, "0")}`;
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ status: "ERROR", message, code, ...extra, requestId: requestId() }, { status, headers: { "X-API-Version": "3.63", ...headers } });
}

function success(body: Record<string, unknown>): Response {
  return Response.json({ status: "SUCCESS", ...body, requestId: requestId() }, { headers: { "X-API-Version": "3.63" } });
}

const authenticate = (hint: string) => ({ next_action: { type: "authenticate", hint, retryable: false, url: "https://porkbun.com/account/api" } });

export type FakePorkbun = ReturnType<typeof createFakePorkbun>;

export function createFakePorkbun(options: { pageSize?: number } = {}) {
  const records: FakeRecord[] = [];
  const requests: Received[] = [];
  const failures: Failure[] = [];
  let serial = 500_000_000;
  /**
   * `pageSize`: the domains of a page of /domain/listAll; `scopes`: the key's
   * permissions, as /ping reports them; `allowedDomains`: the key's domain
   * allowlist, null for none; `apiAccess`: the zone's API Access switch;
   * `addressAllowed`: false answers every call as to an address outside the
   * key's IP allowlist.
   */
  const settings = {
    pageSize: options.pageSize ?? 2,
    scopes: ["read", "dns"] as string[],
    allowedDomains: null as string[] | null,
    apiAccess: true,
    addressAllowed: true,
  };
  const account = () => [OTHER_DOMAINS[0]!, OTHER_DOMAINS[1]!, ZONE, OTHER_DOMAINS[2]!];

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const base = `http://127.0.0.1:${server.port}/api/json/v3`;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/^\/api\/json\/v3/, "");
    let body: Record<string, unknown> | null = null;
    if (method === "POST") {
      const text = await request.text();
      try {
        const parsed: unknown = text === "" ? null : JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        requests.push({ method, path, search: url.search, url: request.url, body: text, headers: headersOf(request) });
        return error(400, "INVALID_OR_EMPTY_JSON", "Request body is missing or not valid JSON.");
      }
    }
    requests.push({ method, path, search: url.search, url: request.url, body, headers: headersOf(request) });

    const scripted = failures.find((candidate) => candidate.times > 0 && candidate.method === method && candidate.path.test(path));
    if (scripted !== undefined) {
      scripted.times--;
      if (scripted.raw !== undefined) return new Response(scripted.raw, { status: scripted.status, headers: { "Content-Type": "text/html" } });
      return Response.json(scripted.body ?? {}, { status: scripted.status });
    }

    // Header keys count only when the body carries none, as the API says.
    const inBody = body !== null && (typeof body.apikey === "string" || typeof body.secretapikey === "string");
    const apiKey = inBody ? body!.apikey : request.headers.get("x-api-key");
    const secretKey = inBody ? body!.secretapikey : request.headers.get("x-secret-api-key");
    const given = typeof apiKey === "string" && apiKey !== "";

    if (path === "/ping") {
      if (!given) return success({ yourIp: "127.0.0.1", xForwardedFor: "127.0.0.1" });
      if (apiKey !== FAKE_API_KEY || secretKey !== FAKE_SECRET_KEY) {
        return error(400, "INVALID_API_KEYS", "Invalid API key.", authenticate("Your API key or secret is invalid. Verify them, or create a new key."));
      }
    } else {
      if (!given) return error(400, "API_KEY_REQUIRED", "All API requests require an API key or API token.");
      if (apiKey !== FAKE_API_KEY) return error(400, "INVALID_API_KEYS_001", "Invalid API key. (001)", authenticate("Your API key or secret is invalid. Verify them, or create a new key."));
      if (typeof secretKey !== "string" || secretKey === "") return error(400, "MISSING_SECRETAPIKEY", "The secret API key is missing: the field is secretapikey.");
      if (secretKey !== FAKE_SECRET_KEY) return error(400, "INVALID_API_KEYS_002", "Invalid API key. (002)", authenticate("Your API key or secret is invalid. Verify them, or create a new key."));
    }
    if (!settings.addressAllowed) return error(403, "IP_NOT_ALLOWED", "This API key may not be used from 127.0.0.1.");
    return route(method, path, url, body ?? {});
  }

  function headersOf(request: Request): Record<string, string> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value));
    return headers;
  }

  function route(method: string, path: string, url: URL, body: Record<string, unknown>): Response {
    if (path === "/ping") {
      return success({ yourIp: "127.0.0.1", xForwardedFor: "127.0.0.1", credentialsValid: true, account: "fake-account", scopes: [...settings.scopes] });
    }
    if (path === "/domain/listAll") {
      const start = Math.max(0, Number(url.searchParams.get("start") ?? body.start ?? 0) || 0);
      const listed = account()
        .slice(start, start + settings.pageSize)
        .map((domain) => ({
          domain,
          status: "ACTIVE",
          tld: domain.slice(domain.lastIndexOf(".") + 1),
          createDate: "2025-01-15 10:00:00",
          expireDate: "2027-01-15 10:00:00",
          securityLock: 1,
          whoisPrivacy: 1,
          autoRenew: 1,
          apiAccess: domain === ZONE && !settings.apiAccess ? 0 : 1,
          notLocal: 0,
        }));
      return success({ count: listed.length, domains: listed });
    }

    const match = /^\/dns\/(retrieve|create|edit|delete)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (match === null) return error(400, "INVALID_ENDPOINT", "Invalid endpoint.");
    const [, action, rawDomain, id] = match;
    const domain = decodeURIComponent(rawDomain!).toLowerCase();
    if (action === "retrieve" ? method !== "GET" && method !== "POST" : method !== "POST") return error(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
    if (settings.allowedDomains !== null && !settings.allowedDomains.includes(domain)) {
      return error(403, "DOMAIN_NOT_ALLOWED", `This API key may not be used for ${domain}.`);
    }
    if (!account().includes(domain)) return error(400, "INVALID_DOMAIN", "Invalid domain.", { account: "fake-account" });
    if (domain === ZONE && !settings.apiAccess) {
      return error(400, "API_ACCESS_DISABLED", "Domain is not opted in to API access.", {
        account: "fake-account",
        next_action: { type: "enable_setting", hint: "Turn on API access for this domain in Domain Management.", retryable: false, url: "https://porkbun.com/account/domainsSpeedy" },
      });
    }
    const zoneRecords = domain === ZONE ? records : [];
    if (action === "retrieve") return success({ cloudflare: "disabled", records: zoneRecords.map((record) => ({ ...record })) });

    if (!settings.scopes.includes("dns") && !settings.scopes.includes("full")) {
      return error(403, "INSUFFICIENT_SCOPE", "This API key does not have the permission this call needs.", { requiredScope: "dns", keyScopes: [...settings.scopes] });
    }
    if (domain !== ZONE) return error(400, "INVALID_DOMAIN", "Invalid domain.", { account: "fake-account" });

    if (action === "delete") {
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return error(400, "INVALID_RECORD_ID", "Invalid record ID.");
      records.splice(index, 1);
      return success({});
    }

    const target = action === "edit" ? records.find((record) => record.id === id) : undefined;
    if (action === "edit" && target === undefined) return error(400, "INVALID_RECORD_ID", "Invalid record ID.");
    // Since 3.48 an edit keeps what it is not told; a create needs a type and a content.
    const name = typeof body.name === "string" ? body.name.toLowerCase() : target === undefined ? "" : relative(target.name);
    const type = typeof body.type === "string" ? body.type.toUpperCase() : target?.type;
    const content = typeof body.content === "string" ? body.content : target?.content;
    if (type === undefined || !TYPES.includes(type)) return error(400, "INVALID_TYPE", "Invalid type.");
    if (content === undefined || content === "") return error(400, "MISSING_PARAMETER", "Missing parameter: content.");
    const ttlGiven = body.ttl === undefined || body.ttl === 0 || body.ttl === "0" ? null : Number(body.ttl);
    if (ttlGiven !== null && (!Number.isInteger(ttlGiven) || ttlGiven < 600)) return error(400, "INVALID_INPUT", "TTL must be at least 600 seconds.");
    const ttl = ttlGiven === null ? (target?.ttl ?? "600") : String(ttlGiven);
    const full = name === "" ? ZONE : `${name}.${ZONE}`;

    const others = records.filter((record) => record.name === full && record !== target);
    if (others.some((record) => record.type === type && record.content === content)) {
      return error(400, "DUPLICATE_RECORD", "A record with that name, type and content already exists.", { existingId: others.find((record) => record.type === type && record.content === content)!.id });
    }
    const conflicting = type === "CNAME" ? others : others.filter((record) => record.type === "CNAME");
    if (conflicting.length > 0) {
      return error(400, "RECORD_CONFLICT", "A CNAME record cannot share its name with any other record.", { conflictingRecords: conflicting.map((record) => ({ ...record })) });
    }
    if (target !== undefined) {
      Object.assign(target, { name: full, type, content, ttl });
      return success({});
    }
    const created: FakeRecord = { id: String(++serial), name: full, type, content, ttl, prio: "0", notes: "" };
    records.push(created);
    return success({ id: created.id });
  }

  /** A name of the zone, relative as the API takes it: empty for the zone itself. */
  function relative(name: string): string {
    const lowered = name.toLowerCase();
    if (lowered === ZONE) return "";
    if (!lowered.endsWith(`.${ZONE}`)) throw new Error(`${name} is not a name of ${ZONE}`);
    return lowered.slice(0, -(ZONE.length + 1));
  }

  return {
    url: base,
    zone: ZONE,
    environment: { SITESOLIDE_DNS_PORKBUN_API_KEY: FAKE_API_KEY, SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY: FAKE_SECRET_KEY, SITESOLIDE_PORKBUN_DNS_API: base } as Record<string, string>,
    secrets: [FAKE_API_KEY, FAKE_SECRET_KEY],
    requests,
    settings,
    /** The requests that changed something: Porkbun's writes are POSTs to create, edit and delete. */
    writes(): Received[] {
      return requests.filter((request) => request.method === "POST" && /^\/dns\/(create|edit|delete)\//.test(request.path));
    },
    /** Puts a record in the zone, as an earlier owner left it. */
    addRecord(record: { name: string; type: string; content: string; ttl?: number }): FakeRecord {
      relative(record.name);
      const created: FakeRecord = { id: String(++serial), name: record.name.toLowerCase(), type: record.type, content: record.content, ttl: String(record.ttl ?? 600), prio: "0", notes: "" };
      records.push(created);
      return created;
    },
    /** The zone's records, names absolute. */
    records(): { name: string; type: string; content: string }[] {
      return records.map((record) => ({ name: record.name, type: record.type, content: record.content }));
    },
    /** The zone's records as the fake keeps them, ids and TTLs included. */
    stored(): FakeRecord[] {
      return records;
    },
    /** The next `times` requests matching answer this instead: a JSON body, or `raw` text. */
    fail(method: string, path: RegExp, status: number, answer: { body?: unknown; raw?: string; times?: number }): void {
      failures.push({ method, path, status, body: answer.body, raw: answer.raw, times: answer.times ?? 1 });
    },
    reset(): void {
      records.length = 0;
      requests.length = 0;
      failures.length = 0;
      settings.pageSize = options.pageSize ?? 2;
      settings.scopes = ["read", "dns"];
      settings.allowedDomains = null;
      settings.apiAccess = true;
      settings.addressAllowed = true;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The fake as bin/tests/dns-providers.test.ts runs every provider's. */
export function createFake(): FakeDns {
  return createFakePorkbun();
}
