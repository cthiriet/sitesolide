import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import { API_VARIABLE, DEFAULT_API, GANDI_DNS, parseRecordId, recordId, TOKEN_SHAPE, TOKEN_VARIABLE, TTL } from "../cli/dns/gandi";
import { ProviderError } from "../cli/providers/provider";
import { tlsZoneContent } from "../cli/tls";
import { createFakeGandi, FAKE_TOKEN, ZONE, type FakeGandi } from "./fake-dns-gandi";

/**
 * bin/cli/dns/gandi.ts, through GANDI_DNS.open and setup's record engine
 * (ensureZoneRecords in bin/cli/dns/dns.ts), against the local fake of
 * Gandi's LiveDNS API (fake-dns-gandi.ts): api.gandi.net is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, a set's other values survive a change to one of them, and the
 * token travels in the Authorization header and nowhere else.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

const fake: FakeGandi = createFakeGandi();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Every message a test saw, read by the last test for the token. */
const said: string[] = [];

function context(overrides: Partial<DnsContext> = {}): DnsContext {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return {
    credentials: { [TOKEN_VARIABLE]: FAKE_TOKEN },
    environment: fake.environment,
    fetcher: (input, init) => fetch(input, init),
    clock: { now: () => now, sleep: async (milliseconds) => void (now += milliseconds) },
    secret: () => {},
    ...overrides,
  };
}

const open = (overrides: Partial<DnsContext> = {}): ZoneApi => GANDI_DNS.open(context(overrides));

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
const reads = (pattern: RegExp) => fake.requests.filter((request) => request.method === "GET" && pattern.test(request.path));

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, TTL 300, and a second run writes nothing", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`, ...fake.records().filter((r) => r.type === "NS").map((r) => `${ZONE} NS ${r.content}`)].sort());
    expect(fake.set(ZONE, "A")?.ttl).toBe(TTL);
    expect(fake.set(`*.${ZONE}`, "AAAA")?.ttl).toBe(TTL);
    // Created as the API names them, `@` for the domain itself and `*` for its wildcard, with POST.
    expect(fake.writes().map((request) => `${request.method} ${request.path}`).sort()).toEqual([
      `POST /livedns/domains/${ZONE}/records/*/A`,
      `POST /livedns/domains/${ZONE}/records/*/AAAA`,
      `POST /livedns/domains/${ZONE}/records/@/A`,
      `POST /livedns/domains/${ZONE}/records/@/AAAA`,
    ]);
    expect(fake.writes().map((request) => request.body)).toContainEqual({ rrset_values: [IPV4], rrset_ttl: 300 });

    const before = fake.requests.length;
    const again = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(again.actions.every((action) => action.kind === "keep")).toBe(true);
    expect(fake.requests.slice(before).filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("a machine without IPv6: two records, and no AAAA", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines().filter((line) => !line.includes(" NS "))).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
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

  test("the domain's NS, and its MX and TXT, are read and left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"v=spf1 -all"' });
    const { zone, records } = await zoneRecords(open(), ZONE);
    expect(zone).toEqual({ id: ZONE, name: ZONE });
    expect(records.map((record) => record.type).sort()).toEqual(["MX", "NS", "NS", "NS", "TXT"]);
    expect(records.every((record) => record.name === ZONE && record.proxied === false)).toBe(true);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toContain(`${ZONE} MX 10 mail.example.net.`);
    expect(lines()).toContain(`${ZONE} TXT "v=spf1 -all"`);
    expect(fake.set(ZONE, "NS")?.values).toHaveLength(3);
  });

  test("a zone held as a subdomain of a LiveDNS domain is found through its parent", async () => {
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines().filter((line) => !line.includes(" NS "))).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    expect(fake.writes().map((request) => request.path).sort()).toEqual([`/livedns/domains/${ZONE}/records/*.sites/A`, `/livedns/domains/${ZONE}/records/sites/A`]);
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

  test("replace: exactly what the plan says, the CNAME deleted before the address takes its name", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net." });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "delete", "update"]);
    expect(lines().filter((line) => !line.includes(" NS "))).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`, `${ZONE} MX 10 mail.example.net.`]);
    const writes = fake.writes().map((request) => `${request.method} ${request.path}`);
    expect(writes.indexOf(`DELETE /livedns/domains/${ZONE}/records/*/CNAME`)).toBeLessThan(writes.indexOf(`POST /livedns/domains/${ZONE}/records/*/A`));
    expect(fake.set(ZONE, "A")).toEqual({ name: "@", type: "A", ttl: TTL, values: [IPV4] });
  });

  test("an update or a deletion touches that one value, and every other value of the set is kept", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.1", ttl: 1800 });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.2" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.3" });
    const api = open();
    const zone = await api.findZone(ZONE);
    const records = await api.listRecords(zone, ZONE);
    const byContent = (content: string) => records.find((record) => record.content === content)!;
    expect(byContent("198.51.100.2").id).toBe(recordId("@", "A", "198.51.100.2"));

    await api.updateRecord(zone, byContent("198.51.100.2"), IPV4);
    expect(fake.set(ZONE, "A")?.values).toEqual(["198.51.100.1", IPV4, "198.51.100.3"]);
    expect(fake.writes().at(-1)?.method).toBe("PUT");

    await api.deleteRecord(zone, byContent("198.51.100.1"));
    expect(fake.set(ZONE, "A")).toEqual({ name: "@", type: "A", ttl: TTL, values: [IPV4, "198.51.100.3"] });

    await api.deleteRecord(zone, byContent("198.51.100.3"));
    await api.deleteRecord(zone, { ...byContent("198.51.100.3"), id: recordId("@", "A", IPV4), content: IPV4 });
    expect(fake.set(ZONE, "A")).toBeUndefined();
    expect(fake.writes().at(-1)?.method).toBe("DELETE");
  });

  test("a value gone since it was read is not written over", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const api = open();
    const zone = await api.findZone(ZONE);
    const [record] = await api.listRecords(zone, ZONE).then((records) => records.filter((entry) => entry.type === "A"));
    fake.set(ZONE, "A")!.values = ["198.51.100.9"];
    const error = await refusal(api.updateRecord(zone, record!, IPV4));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`${ZONE} A 198.51.100.7 is no longer in its Gandi record set`);
    expect(fake.set(ZONE, "A")?.values).toEqual(["198.51.100.9"]);
  });

  test("a set created by someone else since the read is a 409, and is not overwritten", async () => {
    const api = open();
    const zone = await api.findZone(ZONE);
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const error = await refusal(api.createRecord(zone, { name: ZONE, type: "A", content: IPV4 }));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Gandi refused POST /livedns/domains/${ZONE}/records/@/A (409): A DNS Record already exists with that name and type`);
    expect(fake.set(ZONE, "A")?.values).toEqual(["198.51.100.7"]);
  });
});

describe("what the API refuses", () => {
  test("a token Gandi does not know: kind token, before any record is read", async () => {
    const error = await refusal(ensureZoneRecords(open({ credentials: { [TOKEN_VARIABLE]: "fedcba9876543210fedcba9876543210fedcba98" } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("the Gandi token may not GET /livedns/domains (403): Access was denied to this resource.");
    expect(error.details[0]).toContain("Manage domain name technical configurations");
    expect(reads(/records/)).toEqual([]);
    expect([error.message, ...error.details].join("\n")).not.toContain("fedcba9876543210");
  });

  test("no token at all: Gandi's 401, kind token", async () => {
    const error = await refusal(open({ credentials: {} }).verify());
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Gandi refused the token (401): You must provide an access token or an API Key. See https://api.gandi.net/docs/authentication/");
  });

  test("a token without the permission to write: the write is refused, kind token", async () => {
    fake.settings.readOnly = true;
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toStartWith(`the Gandi token may not POST /livedns/domains/${ZONE}/records/`);
  });

  test("a zone no domain of the token holds: kind zone, with the names looked for", async () => {
    const error = await refusal(ensureZoneRecords(open(), "sites.unknown-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe("no Gandi LiveDNS domain the token can read holds sites.unknown-zone.invalid");
    expect(error.details[0]).toBe("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
  });

  test("records Gandi will not show, as for a domain of another organization: refused, saying where to look", async () => {
    fake.settings.crossOrganization = true;
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Gandi found nothing at GET /livedns/domains/${ZONE}/records (404): The resource could not be found.`);
    expect(error.details[0]).toContain("docs/dns/gandi.md");
  });

  test("the API's own words, and the fields it names, for a request it refuses", async () => {
    fake.fail("POST", /records/, 400, { body: { code: 400, message: "Bad Request", object: "HTTPBadRequest", cause: "Bad Request", errors: [{ location: "body", name: "rrset_values", description: "Invalid IPv4 address" }] } });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toEndWith("(400): Bad Request; rrset_values: Invalid IPv4 address");
  });

  test("a failure on Gandi's side, and its rate limit, say so", async () => {
    fake.fail("GET", /^\/livedns\/domains$/, 503, { body: { code: 503, message: "Service Unavailable", object: "HTTPServiceUnavailable", cause: "Service Unavailable" } });
    const failed = await refusal(open().verify());
    expect(failed.kind).toBe("refused");
    expect(failed.details).toEqual(["the failure is on Gandi's side"]);
    fake.fail("GET", /^\/livedns\/domains$/, 429, { body: { code: 429, message: "Too Many Requests", object: "HTTPTooManyRequests", cause: "Too Many Requests" } });
    expect((await refusal(open().verify())).message).toBe("Gandi's rate limit is reached (429): Too Many Requests");
  });

  test("nothing listening: unreachable, and the token is not in the message", async () => {
    const error = await refusal(open({ environment: { [API_VARIABLE]: "http://127.0.0.1:9/v5" } }).verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).not.toContain(FAKE_TOKEN);
  });

  test("an answer that is not the API's: unreachable", async () => {
    fake.fail("GET", /^\/livedns\/domains$/, 502, { raw: "<html>Bad Gateway</html>" });
    const error = await refusal(open().verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe(`${new URL(fake.url).host} answered HTTP 502 to GET /livedns/domains with something that is not Gandi's API`);
  });

  test("the address: Gandi's, or a fake's on the loopback, never http elsewhere", async () => {
    let asked = "";
    const api = open({ environment: {}, fetcher: async (input) => ((asked = input), Response.json([])) });
    await api.verify();
    expect(asked).toBe(`${DEFAULT_API}/livedns/domains?page=1&per_page=1`);
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.gandi.net/v5" } })).toThrow(ProviderError);
  });
});

describe("pagination", () => {
  test("every page of the domains is read: the zone, after two other domains, is found", async () => {
    fake.settings.pageSize = 1;
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    const pages = reads(/^\/livedns\/domains$/).map((request) => new URLSearchParams(request.search).get("page"));
    // The verification's one item, then every page, up to Total-Count.
    expect(pages).toEqual(["1", "1", "2", "3", "4"]);
  });

  test("every page of the records is read: a conflict on the last page is still found", async () => {
    fake.settings.pageSize = 1;
    fake.addRecord({ name: `*.${ZONE}`, type: "TXT", content: '"one"' });
    fake.addRecord({ name: `*.${ZONE}`, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toContain("198.51.100.7");
  });

  test("without Total-Count, pages are read until one comes back empty", async () => {
    fake.settings.pageSize = 1;
    fake.settings.totalCount = false;
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    const pages = reads(/^\/livedns\/domains$/).map((request) => new URLSearchParams(request.search).get("page"));
    expect(pages).toEqual(["1", "1", "2", "3", "4", "5"]);
    expect(lines()).toContain(`${ZONE} A ${IPV4}`);
  });
});

describe("the token", () => {
  test("travels in the Authorization header and nowhere else", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(fake.requests.length).toBeGreaterThan(5);
    for (const request of fake.requests) {
      expect(request.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body)).not.toContain(FAKE_TOKEN);
      const others = Object.entries(request.headers).filter(([name]) => name !== "authorization");
      expect(JSON.stringify(others)).not.toContain(FAKE_TOKEN);
    }
  });

  test("a text from outside that would carry it is scrubbed", async () => {
    fake.fail("GET", /^\/livedns\/domains$/, 400, { body: { code: 400, message: `bad token ${FAKE_TOKEN}`, object: "HTTPBadRequest", cause: "Bad Request" } });
    const error = await refusal(open().verify());
    expect(error.message).toBe("Gandi refused GET /livedns/domains (400): bad token [token]");
  });

  test("its shape: the letters and signs of a token, on one line, nothing systemd reads otherwise", () => {
    expect(TOKEN_SHAPE.test(FAKE_TOKEN)).toBe(true);
    expect(TOKEN_SHAPE.test("pat_0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")).toBe(true);
    for (const wrong of [`${FAKE_TOKEN}\nOTHER=1`, `${FAKE_TOKEN} `, `${FAKE_TOKEN}$`, `"${FAKE_TOKEN}"`, `${FAKE_TOKEN}\\`, "0123456789abcdef", ""]) {
      expect(TOKEN_SHAPE.test(wrong)).toBe(false);
    }
  });

  test("appears in nothing any test of this file was told", () => {
    expect(said.length).toBeGreaterThan(10);
    for (const line of said) expect(line).not.toContain(FAKE_TOKEN);
  });
});

describe("the entry", () => {
  test("its credential is sitesolide's own variable, secret, and its help names the permission", () => {
    expect(GANDI_DNS.name).toBe("gandi");
    expect(GANDI_DNS.docs).toBe("docs/dns/gandi.md");
    expect(GANDI_DNS.apiVariable).toBe("SITESOLIDE_GANDI_DNS_API");
    expect(GANDI_DNS.credentials.map((field) => [field.variable, field.secret])).toEqual([["SITESOLIDE_DNS_GANDI_TOKEN", true]]);
    expect(GANDI_DNS.credentialHelp.join("\n")).toContain("Manage domain name technical configurations");
    expect(GANDI_DNS.credentialHelp.join("\n")).toContain("this domain alone");
  });

  test("the Caddy directive reads every credential from Caddy's environment, and the file holds exactly those", () => {
    const { caddy } = GANDI_DNS;
    expect(caddy.package).toBe("github.com/caddy-dns/gandi");
    expect(caddy.module).toBe("dns.providers.gandi");
    expect(caddy.directive).toEqual(["dns gandi {env.SITESOLIDE_DNS_GANDI_TOKEN}"]);
    const text = caddy.directive.join("\n");
    const named = [...text.matchAll(/\{env\.([A-Z0-9_]+)\}/g)].map((match) => match[1]);
    expect(text.replace(/\{env\.[A-Z0-9_]+\}/g, "")).not.toMatch(/[{}]/);
    const environment = caddy.environment({ [TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(Object.keys(environment).sort()).toEqual(named.sort() as string[]);
    expect(environment).toEqual({ SITESOLIDE_DNS_GANDI_TOKEN: FAKE_TOKEN });
    const file = tlsZoneContent({ kind: "dns", title: GANDI_DNS.title, directive: caddy.directive });
    expect(file).toContain("\tdns gandi {env.SITESOLIDE_DNS_GANDI_TOKEN}\n");
    expect(file).not.toContain(FAKE_TOKEN);
  });

  test("its name servers are LiveDNS's, those of real domains, and nothing else", async () => {
    // gandi.com, gandi.blog and jvns.ca, as `dig NS` answered on 21 October 2026.
    for (const server of ["ns-151-a.gandi.net", "ns-193-b.gandi.net", "ns-165-c.gandi.net", "ns-27-a.gandi.net", "ns-246-b.gandi.net", "ns-231-c.gandi.net", "ns-2-b.gandi.net"]) {
      expect(GANDI_DNS.nameServers.test(server)).toBe(true);
    }
    // The classic DNS's, Gandi's own infrastructure's, and look-alikes.
    for (const server of ["a.dns.gandi.net", "dns0.gandi.net", "ns6.gandi.net", "ns-151-d.gandi.net", "ns-151-a.gandi.net.attacker.invalid", "ns-151-a-gandi.net", "xns-151-a.gandi.net", "ada.ns.cloudflare.com"]) {
      expect(GANDI_DNS.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["NS-151-A.GANDI.NET.", "ns-193-b.gandi.net.", "ns-165-c.gandi.net."] : []);
    expect((await detectDns(`sites.${ZONE}`, [GANDI_DNS], lookup)).entry).toBe(GANDI_DNS);
  });

  test("a record id finds its value again, whatever the value holds", () => {
    const id = recordId("*.sites", "TXT", '"a/b c"');
    expect(parseRecordId(id)).toEqual({ name: "*.sites", type: "TXT", value: '"a/b c"' });
    expect(() => parseRecordId("nothing")).toThrow(DnsError);
  });
});
