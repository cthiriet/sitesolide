import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import { API_KEY_SHAPE, API_KEY_VARIABLE, API_VARIABLE, DEFAULT_API, PORKBUN_DNS, SECRET_KEY_SHAPE, SECRET_KEY_VARIABLE, TTL } from "../cli/dns/porkbun";
import { ProviderError } from "../../clouds/src/provider";
import { tlsZoneContent } from "../cli/tls";
import { createFakePorkbun, FAKE_API_KEY, FAKE_SECRET_KEY, ZONE, type FakePorkbun } from "./fake-dns-porkbun";

/**
 * bin/cli/dns/porkbun.ts, through PORKBUN_DNS.open and setup's record engine
 * (ensureZoneRecords in bin/cli/dns/dns.ts), against the local fake of
 * Porkbun's API v3 (fake-dns-porkbun.ts): api.porkbun.com is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, and both keys travel in their two headers and nowhere else,
 * never in the JSON body the API also accepts them in.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const KEYS = { [API_KEY_VARIABLE]: FAKE_API_KEY, [SECRET_KEY_VARIABLE]: FAKE_SECRET_KEY };

const fake: FakePorkbun = createFakePorkbun();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Every message a test saw, read by the last test for the keys. */
const said: string[] = [];

function context(overrides: Partial<DnsContext> = {}): DnsContext {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return {
    credentials: KEYS,
    environment: fake.environment,
    fetcher: (input, init) => fetch(input, init),
    clock: { now: () => now, sleep: async (milliseconds) => void (now += milliseconds) },
    secret: () => {},
    ...overrides,
  };
}

const open = (overrides: Partial<DnsContext> = {}): ZoneApi => PORKBUN_DNS.open(context(overrides));

async function refusal(promise: Promise<unknown>): Promise<DnsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DnsError) {
      said.push(error.message, ...error.details);
      return error;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The zone's records as lines, in a stable order. */
const lines = () => fake.records().map((record) => `${record.name} ${record.type} ${record.content}`).sort();
const recordReads = () => fake.requests.filter((request) => request.path.startsWith("/dns/"));

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, TTL 600, and a second run writes nothing", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(fake.stored().every((record) => record.ttl === String(TTL))).toBe(true);
    // Created as the API names them: empty for the domain itself, `*` for its wildcard.
    expect(fake.writes().map((request) => request.body)).toEqual([
      { name: "", type: "A", content: IPV4, ttl: 600 },
      { name: "", type: "AAAA", content: IPV6, ttl: 600 },
      { name: "*", type: "A", content: IPV4, ttl: 600 },
      { name: "*", type: "AAAA", content: IPV6, ttl: 600 },
    ]);
    expect(fake.writes().every((request) => request.path === `/dns/create/${ZONE}`)).toBe(true);

    const before = fake.requests.length;
    const again = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(again.actions.every((action) => action.kind === "keep")).toBe(true);
    expect(fake.requests.slice(before).filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("a machine without IPv6: two records, and no AAAA", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("records already equal, in another spelling of the address: nothing is written", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: IPV4 });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: IPV4 });
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:DB8:0:0::10" });
    fake.addRecord({ name: `*.${ZONE}`, type: "AAAA", content: IPV6 });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.actions.every((action) => action.kind === "keep")).toBe(true);
    expect(fake.writes()).toEqual([]);
  });

  test("the zone's MX and TXT, and the records of other names, are read and left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: ZONE, type: "TXT", content: "v=spf1 -all" });
    fake.addRecord({ name: `www.${ZONE}`, type: "A", content: "198.51.100.7" });
    const { zone, records } = await zoneRecords(open(), ZONE);
    expect(zone).toEqual({ id: ZONE, name: ZONE });
    expect(records.map((record) => `${record.name} ${record.type}`).sort()).toEqual([`${ZONE} MX`, `${ZONE} TXT`]);
    expect(records.every((record) => record.proxied === false && /^[0-9]+$/.test(record.id))).toBe(true);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toContain(`${ZONE} MX mail.example.net`);
    expect(lines()).toContain(`${ZONE} TXT v=spf1 -all`);
    expect(lines()).toContain(`www.${ZONE} A 198.51.100.7`);
  });

  test("a zone held as a subdomain of a Porkbun domain is found through its parent", async () => {
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    expect(fake.writes().map((request) => (request.body as { name: string }).name).sort()).toEqual(["*.sites", "sites"]);
  });
});

describe("never someone else's record", () => {
  test("a record pointing elsewhere is a conflict, named, and nothing at all is written", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(fake.writes()).toEqual([]);
  });

  test("a CNAME and an AAAA on a machine without IPv6 are conflicts too", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:db8::99" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details.join("\n")).toContain("a CNAME, beside which an address record cannot exist");
    expect(error.details.join("\n")).toContain("the machine has no IPv6");
    expect(fake.writes()).toEqual([]);
  });

  test("replace: exactly what the plan says, the CNAME deleted before the address takes its name", async () => {
    const cname = fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    const first = fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7", ttl: 3600 });
    const second = fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "delete", "update"]);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`, `${ZONE} MX mail.example.net`]);
    // The fake refuses an address beside a CNAME, as the API does: the deletion came first.
    expect(fake.writes().map((request) => request.path)).toEqual([
      `/dns/delete/${ZONE}/${cname.id}`,
      `/dns/delete/${ZONE}/${second.id}`,
      `/dns/edit/${ZONE}/${first.id}`,
      `/dns/create/${ZONE}`,
    ]);
    // The record kept is edited in place, every field said, and keeps its id.
    expect(fake.writes()[2]!.body).toEqual({ name: "", type: "A", content: IPV4, ttl: 600 });
    expect(fake.stored().find((record) => record.id === first.id)).toMatchObject({ content: IPV4, ttl: "600" });
    expect(fake.writes()[0]!.body).toEqual({});
  });

  test("an address created beside a CNAME someone added since the read is refused, in Porkbun's words", async () => {
    const api = open();
    const zone = await api.findZone(ZONE);
    fake.addRecord({ name: ZONE, type: "CNAME", content: "elsewhere.example.net" });
    const error = await refusal(api.createRecord(zone, { name: ZONE, type: "A", content: IPV4 }));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Porkbun refused POST /dns/create/${ZONE} (400 RECORD_CONFLICT): A CNAME record cannot share its name with any other record.`);
  });
});

describe("what the API refuses", () => {
  test("keys Porkbun does not know: kind token, before any record is read", async () => {
    const wrong = { [API_KEY_VARIABLE]: `pk1_${"9".repeat(64)}`, [SECRET_KEY_VARIABLE]: FAKE_SECRET_KEY };
    const error = await refusal(ensureZoneRecords(open({ credentials: wrong }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Porkbun refused the API keys (400 INVALID_API_KEYS): Invalid API key.");
    expect(recordReads()).toEqual([]);
    expect([error.message, ...error.details].join("\n")).not.toContain("9999999999");
  });

  test("a secret that does not match the key, past /ping: kind token, (002)", async () => {
    fake.fail("GET", /^\/ping$/, 200, { body: { status: "SUCCESS", yourIp: "127.0.0.1", credentialsValid: true, scopes: ["read", "dns"] } });
    const error = await refusal(ensureZoneRecords(open({ credentials: { ...KEYS, [SECRET_KEY_VARIABLE]: `sk1_${"0".repeat(64)}` } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Porkbun refused the API keys (400 INVALID_API_KEYS_002): Invalid API key. (002)");
  });

  test("no keys at all: /ping only gives the address back, and that is a refusal", async () => {
    const error = await refusal(open({ credentials: {} }).verify());
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Porkbun did not take the API keys: /ping answered without validating them");
  });

  test("a key without the DNS permission is refused at /ping, before anything is read", async () => {
    fake.settings.scopes = ["read"];
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("the Porkbun API key may not change DNS records: its permissions are read");
    expect(fake.requests.map((request) => request.path)).toEqual(["/ping"]);
  });

  test("a key whose /ping says nothing of its permissions, refused the write: kind token, in Porkbun's words", async () => {
    fake.fail("GET", /^\/ping$/, 200, { body: { status: "SUCCESS", yourIp: "127.0.0.1", credentialsValid: true } });
    fake.settings.scopes = ["read"];
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe(`the Porkbun API key may not POST /dns/create/${ZONE} (403 INSUFFICIENT_SCOPE): This API key does not have the permission this call needs.`);
  });

  test("a key whose allowed domains leave the zone out: kind token, saying where to add it", async () => {
    fake.settings.allowedDomains = ["alpha-zone.invalid"];
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe(`the Porkbun API key may not reach that domain (403 DOMAIN_NOT_ALLOWED): This API key may not be used for ${ZONE}.`);
    expect(error.details[0]).toContain("allowed domains");
  });

  test("a key used from an address its allowlist leaves out: kind token", async () => {
    fake.settings.addressAllowed = false;
    const error = await refusal(open().verify());
    expect(error.kind).toBe("token");
    expect(error.details[0]).toContain("the workstation that runs setup, and the machine's");
  });

  test("a domain without API Access: refused, saying where to turn it on", async () => {
    fake.settings.apiAccess = false;
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Porkbun refused GET /dns/retrieve/${ZONE} (400 API_ACCESS_DISABLED): Domain is not opted in to API access.`);
    expect(error.details).toEqual(["turn API Access on for the domain: porkbun.com, Account, Domain Management, the domain's Details, API Access"]);
  });

  test("a zone no domain of the account holds: kind zone, with the names looked for", async () => {
    const error = await refusal(ensureZoneRecords(open(), "sites.unknown-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe("no domain of the Porkbun account holds sites.unknown-zone.invalid");
    expect(error.details[0]).toBe("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
  });

  test("the rate limit, and a failure on Porkbun's side, say so", async () => {
    fake.fail("GET", /^\/ping$/, 429, { body: { status: "ERROR", code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded.", ttlRemaining: 7 } });
    const limited = await refusal(open().verify());
    expect(limited.kind).toBe("refused");
    expect(limited.message).toBe("Porkbun's rate limit is reached (429 RATE_LIMIT_EXCEEDED): Rate limit exceeded.");
    fake.fail("GET", /^\/ping$/, 500, { body: { status: "ERROR", code: "INTERNAL_ERROR", message: "Internal error." } });
    expect((await refusal(open().verify())).details).toEqual(["the failure is on Porkbun's side"]);
  });

  test("nothing listening: unreachable, and no key is in the message", async () => {
    const error = await refusal(open({ environment: { [API_VARIABLE]: "http://127.0.0.1:9/api/json/v3" } }).verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).not.toContain(FAKE_API_KEY);
    expect(error.message).not.toContain(FAKE_SECRET_KEY);
  });

  test("an answer that is not the API's, the old address's 403 page among them: unreachable", async () => {
    fake.fail("GET", /^\/ping$/, 403, { raw: "<html><head><title>403 Forbidden</title></head></html>" });
    const error = await refusal(open().verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe(`${new URL(fake.url).host} answered HTTP 403 to GET /ping with something that is not Porkbun's API`);
    fake.fail("GET", /^\/ping$/, 200, { body: { hello: "world" } });
    expect((await refusal(open().verify())).kind).toBe("unreachable");
  });

  test("the address: api.porkbun.com, or a fake's on the loopback, never http elsewhere", async () => {
    let asked = "";
    const api = open({ environment: {}, fetcher: async (input) => ((asked = input), Response.json({ status: "SUCCESS", credentialsValid: true, scopes: ["full"] })) });
    await api.verify();
    expect(asked).toBe(`${DEFAULT_API}/ping`);
    expect(DEFAULT_API).toBe("https://api.porkbun.com/api/json/v3");
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.porkbun.com/api/json/v3" } })).toThrow(ProviderError);
  });
});

describe("pagination", () => {
  test("every page of the account's domains is read, by offset, until one comes back empty", async () => {
    fake.settings.pageSize = 1;
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    const starts = fake.requests.filter((request) => request.path === "/domain/listAll").map((request) => new URLSearchParams(request.search).get("start"));
    expect(starts).toEqual(["0", "1", "2", "3", "4"]);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("a zone on the last page, after a full first one, is found", async () => {
    fake.settings.pageSize = 3;
    const found = await open().findZone(`sites.${ZONE}`);
    expect(found).toEqual({ id: ZONE, name: ZONE });
    const starts = fake.requests.filter((request) => request.path === "/domain/listAll").map((request) => new URLSearchParams(request.search).get("start"));
    expect(starts).toEqual(["0", "3", "4"]);
  });
});

describe("the keys", () => {
  test("travel in X-API-Key and X-Secret-API-Key and nowhere else, never in a body", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(fake.requests.length).toBeGreaterThan(5);
    expect(new Set(fake.writes().map((request) => request.path.split("/")[2]))).toEqual(new Set(["create", "edit", "delete"]));
    for (const request of fake.requests) {
      expect(request.headers["x-api-key"]).toBe(FAKE_API_KEY);
      expect(request.headers["x-secret-api-key"]).toBe(FAKE_SECRET_KEY);
      const elsewhere = JSON.stringify([request.url, request.body, Object.entries(request.headers).filter(([name]) => !name.startsWith("x-") || !name.endsWith("api-key"))]);
      expect(elsewhere).not.toContain(FAKE_API_KEY);
      expect(elsewhere).not.toContain(FAKE_SECRET_KEY);
      if (request.method === "POST") expect(Object.keys(request.body as object)).not.toContain("apikey");
    }
  });

  test("a text from outside that would carry them is scrubbed", async () => {
    fake.fail("GET", /^\/ping$/, 400, { body: { status: "ERROR", code: "INVALID_INPUT", message: `bad ${FAKE_API_KEY} and ${FAKE_SECRET_KEY}` } });
    const error = await refusal(open().verify());
    expect(error.message).toBe("Porkbun refused GET /ping (400 INVALID_INPUT): bad [key] and [key]");
  });

  test("their shapes: pk1_ and sk1_, on one line, never one in the other's place", () => {
    expect(API_KEY_SHAPE.test(FAKE_API_KEY)).toBe(true);
    expect(SECRET_KEY_SHAPE.test(FAKE_SECRET_KEY)).toBe(true);
    expect(API_KEY_SHAPE.test("pk1_sb_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(API_KEY_SHAPE.test(FAKE_SECRET_KEY)).toBe(false);
    expect(SECRET_KEY_SHAPE.test(FAKE_API_KEY)).toBe(false);
    for (const wrong of [`${FAKE_API_KEY}\nOTHER=1`, `${FAKE_API_KEY} `, `${FAKE_API_KEY}$`, `"${FAKE_API_KEY}"`, "pk1_short", ""]) {
      expect(API_KEY_SHAPE.test(wrong)).toBe(false);
    }
  });

  test("appear in nothing any test of this file was told", () => {
    expect(said.length).toBeGreaterThan(10);
    for (const line of said) {
      expect(line).not.toContain(FAKE_API_KEY);
      expect(line).not.toContain(FAKE_SECRET_KEY);
    }
  });
});

describe("the entry", () => {
  test("its credentials are sitesolide's own variables, both secret, and its help says where API Access is", () => {
    expect(PORKBUN_DNS.name).toBe("porkbun");
    expect(PORKBUN_DNS.docs).toBe("docs/dns/porkbun.md");
    expect(PORKBUN_DNS.apiVariable).toBe("SITESOLIDE_PORKBUN_DNS_API");
    expect(PORKBUN_DNS.credentials.map((field) => [field.variable, field.secret])).toEqual([
      ["SITESOLIDE_DNS_PORKBUN_API_KEY", true],
      ["SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY", true],
    ]);
    expect(PORKBUN_DNS.credentialHelp.join("\n")).toContain("the DNS permission alone");
    expect(PORKBUN_DNS.credentialHelp.join("\n")).toContain("Domain Management, the domain's Details, API Access");
  });

  test("the Caddy directive reads every credential from Caddy's environment, and the file holds exactly those", () => {
    const { caddy } = PORKBUN_DNS;
    expect(caddy.package).toBe("github.com/caddy-dns/porkbun");
    expect(caddy.module).toBe("dns.providers.porkbun");
    expect(caddy.directive).toEqual([
      "dns porkbun {",
      "api_key {env.SITESOLIDE_DNS_PORKBUN_API_KEY}",
      "api_secret_key {env.SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY}",
      "}",
    ]);
    const named = [...caddy.directive.join("\n").matchAll(/\{env\.([A-Z0-9_]+)\}/g)].map((match) => match[1]!).sort();
    const environment = caddy.environment(KEYS);
    expect(Object.keys(environment).sort()).toEqual(named);
    expect(environment).toEqual(KEYS);
    const file = tlsZoneContent({ kind: "dns", title: PORKBUN_DNS.title, directive: caddy.directive });
    expect(file).toContain("tls {\n\tdns porkbun {\n\t\tapi_key {env.SITESOLIDE_DNS_PORKBUN_API_KEY}\n\t\tapi_secret_key {env.SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY}\n\t}\n}\n");
    expect(file).not.toContain(FAKE_API_KEY);
    expect(file).not.toContain(FAKE_SECRET_KEY);
  });

  test("its name servers are Porkbun's, those of real domains, and nothing else under porkbun.com", async () => {
    // 250kb.club, as `dig NS` answered on 21 October 2026, and the older names of the same four servers.
    for (const server of ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com", "maceio.ns.porkbun.com", "salvador.ns.porkbun.com", "curitiba.porkbun.com", "salvador.porkbun.com"]) {
      expect(PORKBUN_DNS.nameServers.test(server)).toBe(true);
    }
    for (const server of ["ns1.porkbun.com", "ns.porkbun.com", "porkbun.com", "curitiba.ns.porkbun.com.attacker.invalid", "curitiba-ns-porkbun.com", "xcuritiba.porkbun.com", "ns-1328.awsdns-38.org", "ada.ns.cloudflare.com"]) {
      expect(PORKBUN_DNS.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["Fortaleza.NS.Porkbun.com.", "curitiba.ns.porkbun.com.", "maceio.ns.porkbun.com.", "salvador.ns.porkbun.com."] : []);
    expect((await detectDns(`sites.${ZONE}`, [PORKBUN_DNS], lookup)).entry).toBe(PORKBUN_DNS);
  });
});
