import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import { API_VARIABLE, DEFAULT_API, ORGANIZATION_VARIABLE, SCALEWAY_DNS, SECRET_VARIABLE, TTL, UUID, zoneName } from "../cli/dns/scaleway-dns";
import { ProviderError, realClock } from "../cli/providers/provider";
import { tlsZoneContent } from "../cli/tls";
import { createFakeScalewayDns, FAKE_ORGANIZATION, FAKE_SECRET, ZONE, type FakeScalewayDns } from "./fake-dns-scaleway-dns";

/**
 * bin/cli/dns/scaleway-dns.ts, through SCALEWAY_DNS.open and setup's record
 * engine (ensureZoneRecords in bin/cli/dns/dns.ts), against the local fake of
 * Scaleway's Domains and DNS API (fake-dns-scaleway-dns.ts): api.scaleway.com
 * is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, a change touches the one record it names, and the secret key
 * travels in the X-Auth-Token header and nowhere else.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

const fake: FakeScalewayDns = createFakeScalewayDns();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Every message a test saw, read by the last test for the secret key. */
const said: string[] = [];

function context(overrides: Partial<DnsContext> = {}): DnsContext {
  return {
    credentials: { [SECRET_VARIABLE]: FAKE_SECRET, [ORGANIZATION_VARIABLE]: FAKE_ORGANIZATION },
    environment: fake.environment,
    fetcher: (input, init) => fetch(input, init),
    clock: realClock,
    secret: () => {},
    ...overrides,
  };
}

const open = (overrides: Partial<DnsContext> = {}): ZoneApi => SCALEWAY_DNS.open(context(overrides));

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

const lines = () => fake.records().map((record) => `${record.name} ${record.type} ${record.content}`).sort();

/** The changes of every PATCH, in order. */
const changes = () => fake.writes().flatMap((request) => (request.body as { changes: Record<string, unknown>[] }).changes);

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, TTL 60, and a second run writes nothing", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    // Named as the API names them: empty for the zone itself, `*` for its wildcard.
    expect(changes()).toEqual([
      { add: { records: [{ name: "", type: "A", data: IPV4, ttl: TTL }] } },
      { add: { records: [{ name: "", type: "AAAA", data: IPV6, ttl: TTL }] } },
      { add: { records: [{ name: "*", type: "A", data: IPV4, ttl: TTL }] } },
      { add: { records: [{ name: "*", type: "AAAA", data: IPV6, ttl: TTL }] } },
    ]);
    expect(fake.writes().every((request) => (request.body as { disallow_new_zone_creation: boolean }).disallow_new_zone_creation === true)).toBe(true);

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

  test("the zone itself is read whole and filtered here: its NS, MX and TXT are seen and left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: `www.${ZONE}`, type: "A", content: "198.51.100.7" });
    const { records } = await zoneRecords(open(), ZONE);
    expect(records.filter((record) => record.name === ZONE).map((record) => record.type).sort()).toEqual(["MX", "NS", "NS"]);
    expect(records.some((record) => record.name === `www.${ZONE}`)).toBe(false);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toContain(`${ZONE} MX 10 mail.example.net.`);
    expect(lines()).toContain(`www.${ZONE} A 198.51.100.7`);
  });

  test("a zone held as a subdomain of a Scaleway zone is found through its parent", async () => {
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    expect(changes().map((change) => (change.add as { records: { name: string }[] }).records[0]!.name)).toEqual(["sites", "*.sites"]);
    expect(fake.writes().every((request) => request.path === `/domain/v2beta1/dns-zones/${ZONE}/records`)).toBe(true);
  });

  test("a sub-zone of its own is the zone, not its parent", async () => {
    fake.zones.push({ domain: ZONE, subdomain: "sites", records: [] });
    expect(zoneName({ domain: ZONE, subdomain: "sites" })).toBe(`sites.${ZONE}`);
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(`sites.${ZONE}`);
    expect(fake.writes().every((request) => request.path === `/domain/v2beta1/dns-zones/sites.${ZONE}/records`)).toBe(true);
    expect(fake.zones.at(-1)!.records.map((record) => record.name).sort()).toEqual(["", "*"]);
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
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net." });
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:db8::99" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details.join("\n")).toContain("a CNAME, beside which an address record cannot exist");
    expect(error.details.join("\n")).toContain("the machine has no IPv6");
    expect(fake.writes()).toEqual([]);
  });

  test("replace: exactly what the plan says, by id, the CNAME deleted first and the other values kept", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net." });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" }, 600);
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"keep me"' });
    const [cname, seven, eight] = fake.stored().slice(-4).map((record) => record.id);
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "create", "create", "delete", "delete", "update"]);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`, `${ZONE} TXT "keep me"`]);
    expect(changes().slice(0, 3)).toEqual([
      { delete: { id: cname } },
      { delete: { id: eight } },
      // The record replaced keeps its TTL.
      { set: { id: seven, records: [{ name: "", type: "A", data: IPV4, ttl: 600 }] } },
    ]);
  });
});

describe("what the API refuses", () => {
  test("a secret key Scaleway does not know: kind token, before any record is read", async () => {
    const wrong = "00000000-0000-4000-8000-000000000000";
    const error = await refusal(ensureZoneRecords(open({ credentials: { [SECRET_VARIABLE]: wrong, [ORGANIZATION_VARIABLE]: FAKE_ORGANIZATION } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Scaleway refused the secret key (401 denied_authentication): authentication is denied");
    expect(fake.requests.map((request) => request.path)).toEqual(["/domain/v2beta1/dns-zones"]);
    expect([error.message, ...error.details].join("\n")).not.toContain(wrong);
  });

  test("an application without Domains and DNS permissions: kind token, on the first read", async () => {
    fake.settings.access = "none";
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("(403 permissions_denied): insufficient permissions");
    expect(error.details).toEqual(["dns_zone: read not allowed", "its application's policy needs DomainsDNSFullAccess on the project that holds the zone"]);
  });

  test("a read-only application: the write is refused, kind token", async () => {
    fake.settings.access = "read";
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("may not PATCH");
  });

  test("a zone the key cannot read: kind zone, with the names looked for", async () => {
    const error = await refusal(ensureZoneRecords(open(), "sites.missing-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe("no Scaleway DNS zone the API key can read holds sites.missing-zone.invalid");
    expect(error.details[0]).toBe("looked for: sites.missing-zone.invalid, missing-zone.invalid");
  });

  test("the API's own words and the arguments it refused", async () => {
    fake.fail("PATCH", /records$/, 400, { details: [{ argument_name: "data", reason: "constraint", help_message: "invalid IPv4" }], message: "invalid argument(s)", type: "invalid_arguments" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Scaleway refused PATCH /dns-zones/${ZONE}/records (400 invalid_arguments): invalid argument(s)`);
    expect(error.details).toEqual(["data: constraint, invalid IPv4"]);
  });

  test("nothing listening: unreachable", async () => {
    const error = await refusal(open({ environment: { [API_VARIABLE]: "http://127.0.0.1:9" } }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("an answer that is not the API's: unreachable", async () => {
    const html = async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    const error = await refusal(open({ fetcher: html }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("the address: Scaleway's, or a fake's on the loopback, never http elsewhere", () => {
    expect(DEFAULT_API).toBe("https://api.scaleway.com");
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid" } })).toThrow(ProviderError);
  });
});

describe("pagination", () => {
  test("every page of the records is read: a conflict on the last page is still found", async () => {
    fake.settings.pageSize = 1;
    fake.addRecord({ name: `*.${ZONE}`, type: "TXT", content: '"one"' });
    fake.addRecord({ name: `*.${ZONE}`, type: "TXT", content: '"two"' });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details[0]).toContain("198.51.100.7");
    const pages = fake.requests.filter((request) => request.path.endsWith("/records") && new URLSearchParams(request.search).get("name") === "*");
    expect(pages.map((request) => new URLSearchParams(request.search).get("page"))).toEqual(["1", "2", "3"]);
  });

  test("every page of the zone itself is read, its records many", async () => {
    fake.settings.pageSize = 2;
    for (let i = 0; i < 5; i++) fake.addRecord({ name: ZONE, type: "TXT", content: `"${i}"` });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details[0]).toBe(`${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
  });
});

describe("the secret key", () => {
  test("travels in the X-Auth-Token header and nowhere else", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(fake.requests.length).toBeGreaterThan(4);
    for (const request of fake.requests) {
      expect(request.headers["x-auth-token"]).toBe(FAKE_SECRET);
      expect(request.url).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(request.body ?? "")).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(request.body ?? "")).not.toContain(FAKE_ORGANIZATION);
    }
  });

  test("a text from outside that would carry it is scrubbed", async () => {
    fake.fail("GET", /dns-zones$/, 400, { message: `bad key ${FAKE_SECRET}`, type: "invalid_request_error" });
    const error = await refusal(open().verify());
    expect(error.message).toContain("bad key [secret key]");
  });

  test("its shape, and the organization's: a UUID, one line", () => {
    expect(UUID.test(FAKE_SECRET)).toBe(true);
    expect(UUID.test(`${FAKE_SECRET}\nOTHER=1`)).toBe(false);
    expect(SCALEWAY_DNS.credentials.map((field) => [field.variable, field.secret])).toEqual([
      ["SITESOLIDE_DNS_SCALEWAY_SECRET_KEY", true],
      ["SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID", false],
    ]);
  });

  test("appears in nothing any test of this file was told", () => {
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) expect(line).not.toContain(FAKE_SECRET);
  });
});

describe("the entry", () => {
  test("its page of the docs exists", async () => {
    expect(await Bun.file(new URL(`../../${SCALEWAY_DNS.docs}`, import.meta.url)).exists()).toBe(true);
  });

  test("its credentials are sitesolide's own variables, never SCW_SECRET_KEY", () => {
    expect(SCALEWAY_DNS.name).toBe("scaleway-dns");
    expect(SCALEWAY_DNS.credentials.every((field) => field.variable.startsWith("SITESOLIDE_DNS_SCALEWAY_"))).toBe(true);
    expect(SCALEWAY_DNS.apiVariable).toBe("SITESOLIDE_SCALEWAY_DNS_API");
    expect(SCALEWAY_DNS.docs).toBe("docs/dns/scaleway-dns.md");
  });

  test("the Caddy directive reads every credential from Caddy's environment, and the file holds exactly those", () => {
    const { caddy } = SCALEWAY_DNS;
    expect(caddy.package).toBe("github.com/caddy-dns/scaleway");
    expect(caddy.module).toBe("dns.providers.scaleway");
    const text = caddy.directive.join("\n");
    const placeholders = [...text.matchAll(/\{([^}\s]+)\}/g)].map((match) => match[1]!);
    expect(placeholders.every((placeholder) => placeholder.startsWith("env."))).toBe(true);
    const environment = caddy.environment({ [SECRET_VARIABLE]: FAKE_SECRET, [ORGANIZATION_VARIABLE]: FAKE_ORGANIZATION });
    expect(Object.keys(environment).sort()).toEqual(placeholders.map((placeholder) => placeholder.slice(4)).sort());
    expect(text).not.toContain(FAKE_SECRET);
    expect(tlsZoneContent({ kind: "dns", title: SCALEWAY_DNS.title, directive: caddy.directive })).toContain(`\t\tsecret_key {env.${SECRET_VARIABLE}}`);
  });

  test("its name servers are Scaleway's two, and nobody else's", async () => {
    for (const server of ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"]) expect(SCALEWAY_DNS.nameServers.test(server)).toBe(true);
    for (const server of ["nsa.scaleway.com", "ns2.dom.scw.cloud", "ns0.dom.scw.cloud.test-zone.invalid", "xns0.dom.scw.cloud", "ada.ns.cloudflare.com"]) {
      expect(SCALEWAY_DNS.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["ns0.dom.scw.cloud.", "ns1.dom.scw.cloud."] : []);
    expect((await detectDns(`sites.${ZONE}`, [SCALEWAY_DNS], lookup)).entry).toBe(SCALEWAY_DNS);
  });
});
