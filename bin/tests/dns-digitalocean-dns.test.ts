import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { absoluteName, API_VARIABLE, DEFAULT_API, DIGITALOCEAN_DNS, relativeName, TOKEN_SHAPE, TOKEN_VARIABLE, TTL } from "../cli/dns/digitalocean-dns";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { detectDns, DnsError, ensureZoneRecords, zoneRecords, type DnsContext } from "../cli/dns/dns";
import { ProviderError } from "../../clouds/src/provider";
import { createFakeDigitalOceanDns, FAKE_TOKEN, LINK_ORIGIN, ZONE, type FakeDigitalOceanDns } from "./fake-dns-digitalocean-dns";

/**
 * DigitalOcean's DNS, through `DIGITALOCEAN_DNS.open(...)` and setup's record
 * engine, against a local fake of its API (fake-dns-digitalocean-dns.ts): the
 * real one is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, and the token travels in the Authorization header and nowhere
 * else. Every refusal of this file is kept in `printed`, and every address
 * fetched in `fetched`, both read by the last tests.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

let fake: FakeDigitalOceanDns;
const printed: string[] = [];
const fetched: string[] = [];

beforeAll(() => {
  fake = createFakeDigitalOceanDns();
});

afterAll(() => fake.stop());

beforeEach(() => fake.reset());

function open(extra: Partial<DnsContext> = {}) {
  return DIGITALOCEAN_DNS.open({
    credentials: { [TOKEN_VARIABLE]: FAKE_TOKEN },
    environment: { [API_VARIABLE]: fake.url },
    fetcher: (input, init) => {
      fetched.push(input);
      return fetch(input, init);
    },
    clock: { now: () => Date.parse("2026-10-21T10:00:00Z"), sleep: async () => {} },
    secret: () => {},
    ...extra,
  });
}

async function failure(promise: Promise<unknown>): Promise<DnsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DnsError) {
      printed.push(error.message, ...error.details);
      return error;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The zone's address records and CNAMEs, as lines, in a stable order. */
function lines(): string[] {
  return fake
    .records()
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .map((record) => `${record.name} ${record.type} ${record.content}`)
    .sort();
}

const zoneDomain = () => fake.domains.find((domain) => domain.name === ZONE)!;

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, named relative to the domain, at the lowest TTL", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["*", "*", "@", "@"]);
    expect(zoneDomain().records.every((record) => record.ttl === TTL)).toBe(true);
    expect(fake.writes().map((request) => request.method)).toEqual(["POST", "POST", "POST", "POST"]);
  });

  test("a zone written in capitals is the same zone, and its records the same records", async () => {
    await ensureZoneRecords(open(), ZONE.toUpperCase(), { ipv4: IPV4, ipv6: null }, false);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["*", "@"]);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.writes().length).toBe(2);
  });

  test("a machine without IPv6: two records, and no AAAA", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("a second run writes nothing", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    const before = fake.writes().length;
    const again = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: "2001:DB8:0::10" }, false);
    expect(fake.writes().length).toBe(before);
    expect(again.actions.every((action) => action.kind === "keep")).toBe(true);
  });

  test("other records at those names, the name servers, MX and TXT, are left alone", async () => {
    for (const server of ["ns1", "ns2", "ns3"]) fake.addRecord({ name: ZONE, type: "NS", content: `${server}.digitalocean.com` });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: ZONE, type: "TXT", content: "v=spf1 -all" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.records().filter((record) => ["NS", "MX", "TXT"].includes(record.type)).length).toBe(5);
    expect(fake.writes().filter((request) => request.method !== "POST")).toEqual([]);
  });

  test("a zone held as a parent: the records go to the parent domain, named relative to it", async () => {
    const result = await ensureZoneRecords(open(), `apps.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.apps.${ZONE} A ${IPV4}`, `apps.${ZONE} A ${IPV4}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["*.apps", "apps"]);
  });

  test("the wizard's read writes nothing", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const { zone, records } = await zoneRecords(open(), ZONE);
    expect(zone).toEqual({ id: ZONE, name: ZONE });
    expect(records.map((record) => `${record.name} ${record.type} ${record.content} ${record.proxied}`)).toEqual([`${ZONE} A 198.51.100.7 false`]);
    expect(fake.writes()).toEqual([]);
  });
});

describe("never someone else's record", () => {
  test("a record that points elsewhere is a conflict, and nothing is written", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(fake.writes()).toEqual([]);
  });

  test("a CNAME, or an AAAA when the machine has no IPv6, is a conflict too", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:db8::99" });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details.length).toBe(3);
    expect(fake.writes()).toEqual([]);
  });

  test("replace updates and deletes exactly what the plan says, deletions first", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "AAAA", content: "2001:db8::99" });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "delete", "delete", "update"]);
    // The fake refuses an A record beside a CNAME: the CNAME went first.
    expect(fake.writes().map((request) => request.method)).toEqual(["DELETE", "DELETE", "DELETE", "PATCH", "POST"]);
    expect(fake.writes().find((request) => request.method === "PATCH")!.body).toEqual({ type: "A", data: IPV4, ttl: TTL });
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
    expect(fake.records().some((record) => record.type === "MX")).toBe(true);
  });
});

describe("refusals", () => {
  test("refused credentials: kind token, before anything else is asked", async () => {
    const error = await failure(ensureZoneRecords(open({ credentials: { [TOKEN_VARIABLE]: `dop_v1_${"0".repeat(64)}` } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("Unable to authenticate you");
    expect(fake.requests.length).toBe(1);
  });

  test("a token without domain:read: kind token", async () => {
    fake.settings.scopes = new Set(["domain:create"]);
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.details).toContain("the token needs the custom scopes domain:read and domain:update");
  });

  test("domain:read alone reads, and is refused the first write: kind token", async () => {
    fake.settings.scopes = new Set(["domain:read"]);
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain(`POST /domains/${ZONE}/records`);
  });

  test("a zone no domain holds: kind zone, naming every name tried", async () => {
    const error = await failure(ensureZoneRecords(open(), "sites.unknown-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.details[0]).toBe("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
    expect(fake.writes()).toEqual([]);
  });

  test("the API's refusal is quoted: kind refused", async () => {
    fake.fail("POST", /\/records$/, 422, { id: "unprocessable_entity", message: "Data needs to end with a dot (.)" });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("Data needs to end with a dot (.)");
  });

  test("an answer that is not the API's, and no answer at all: kind unreachable", async () => {
    const proxy = open({ fetcher: async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) });
    expect((await failure(proxy.verify())).kind).toBe("unreachable");
    const nowhere = open({
      fetcher: async () => {
        throw new Error(`connection refused while sending ${FAKE_TOKEN}`);
      },
    });
    const error = await failure(nowhere.verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("[token]");
  });

  test("a refusal that echoes the token is scrubbed of it", async () => {
    fake.fail("GET", /^\/domains$/, 500, { id: "server_error", message: `unexpected token ${FAKE_TOKEN}`, request_id: FAKE_TOKEN });
    const error = await failure(open().verify());
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("unexpected token [token]");
  });
});

describe("pagination", () => {
  test("the zone on a later page of domains, and records past the first page, are all read", async () => {
    for (let index = 0; index < 7; index++) fake.addRecord({ name: `host${index}.${ZONE}`, type: "A", content: `198.51.100.${index}` });
    fake.addRecord({ name: ZONE, type: "A", content: IPV4 });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: IPV4 });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(result.actions.map((action) => action.kind)).toEqual(["keep", "keep"]);
    expect(fake.writes()).toEqual([]);
    const pages = fake.requests.filter((request) => request.path === `/domains/${ZONE}/records`).map((request) => new URLSearchParams(request.search).get("page"));
    expect(pages).toEqual(["1", "2", "3", "4", "5", "1", "2", "3", "4", "5"]);
    expect(fake.requests.filter((request) => request.path === "/domains" && new URLSearchParams(request.search).get("page") === "2").length).toBe(1);
  });

  test("the links of a page are read for their page number, never followed as given", () => {
    expect(fetched.length).toBeGreaterThan(0);
    for (const address of fetched) expect(address.startsWith(LINK_ORIGIN)).toBe(false);
  });
});

describe("the token", () => {
  test("travels in the Authorization header, and in no address, body or message", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body)).not.toContain(FAKE_TOKEN);
    }
    for (const address of fetched) expect(address).not.toContain(FAKE_TOKEN);
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) expect(line).not.toContain(FAKE_TOKEN);
  });

  test("has a personal access token's shape: a line break, a legacy token or an OAuth token is refused", () => {
    expect(TOKEN_SHAPE.test(FAKE_TOKEN)).toBe(true);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN}\n`)).toBe(false);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN}\nOTHER=1`)).toBe(false);
    expect(TOKEN_SHAPE.test("0123456789abcdef".repeat(4))).toBe(false);
    expect(TOKEN_SHAPE.test(`doo_v1_${"0123456789abcdef".repeat(4)}`)).toBe(false);
    expect(DIGITALOCEAN_DNS.credentials.map((field) => field.variable)).toEqual(["SITESOLIDE_DNS_DIGITALOCEAN_TOKEN"]);
    expect(DIGITALOCEAN_DNS.credentials.every((field) => field.secret && !/^DIGITALOCEAN_/.test(field.variable))).toBe(true);
  });
});

describe("Caddy", () => {
  test("the directive reads every credential from Caddy's environment, and the environment holds exactly those", () => {
    const placeholders = DIGITALOCEAN_DNS.caddy.directive.join("\n").match(/\{[^}]*\}/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.every((placeholder) => /^\{env\.[A-Z][A-Z0-9_]*\}$/.test(placeholder))).toBe(true);
    const named = placeholders.map((placeholder) => placeholder.slice(5, -1)).sort();
    const environment = DIGITALOCEAN_DNS.caddy.environment({ [TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(Object.keys(environment).sort()).toEqual(named);
    expect(environment[TOKEN_VARIABLE]).toBe(FAKE_TOKEN);
    expect(DIGITALOCEAN_DNS.caddy.directive.join("\n")).not.toContain(FAKE_TOKEN);
    expect(DIGITALOCEAN_DNS.caddy.directive).toEqual(["dns digitalocean {env.SITESOLIDE_DNS_DIGITALOCEAN_TOKEN}"]);
  });

  test("the module, as caddy add-package takes it and caddy list-modules prints it", () => {
    expect(DIGITALOCEAN_DNS.caddy.package).toBe("github.com/caddy-dns/digitalocean");
    expect(DIGITALOCEAN_DNS.caddy.module).toBe("dns.providers.digitalocean");
  });
});

describe("name servers", () => {
  // As `dig +short NS` answered on 2026-10-21 for zones DigitalOcean serves.
  const REAL = ["ns1.digitalocean.com", "ns2.digitalocean.com", "ns3.digitalocean.com"];

  test("match DigitalOcean's, and nobody else's", () => {
    for (const server of REAL) expect(DIGITALOCEAN_DNS.nameServers.test(server)).toBe(true);
    for (const server of ["ns4.digitalocean.com", "ns1.digitalocean.com.test-zone.invalid", "xns1.digitalocean.com", "kim.ns.cloudflare.com", "ns1.vultr.com", "ns1.linode.com"]) {
      expect(DIGITALOCEAN_DNS.nameServers.test(server)).toBe(false);
    }
  });

  test("tell the wizard who holds a zone, from its NS records", async () => {
    const found = await detectDns(`apps.${ZONE}`, [CLOUDFLARE, DIGITALOCEAN_DNS], async (name) => (name === ZONE ? REAL.map((server) => `${server}.`) : []));
    expect(found.entry).toBe(DIGITALOCEAN_DNS);
    expect(found.nameServers).toEqual(REAL);
  });
});

describe("addresses and names", () => {
  test("its page of the docs exists", async () => {
    expect(DIGITALOCEAN_DNS.docs).toBe("docs/dns/digitalocean-dns.md");
    expect(await Bun.file(`${import.meta.dir}/../../${DIGITALOCEAN_DNS.docs}`).exists()).toBe(true);
  });

  test("the API is DigitalOcean's unless the variable names a fake on the loopback", () => {
    expect(DEFAULT_API).toBe("https://api.digitalocean.com/v2");
    expect(DIGITALOCEAN_DNS.apiVariable).toBe(API_VARIABLE);
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid/v2" } })).toThrow(ProviderError);
  });

  test("names convert both ways, `@` for the domain itself", () => {
    expect(absoluteName("@", ZONE)).toBe(ZONE);
    expect(absoluteName("*", ZONE)).toBe(`*.${ZONE}`);
    expect(absoluteName("*.Apps", ZONE)).toBe(`*.apps.${ZONE}`);
    expect(absoluteName(`www.${ZONE}.`, ZONE)).toBe(`www.${ZONE}`);
    expect(relativeName(ZONE, ZONE)).toBe("@");
    expect(relativeName(`*.apps.${ZONE}`, ZONE)).toBe("*.apps");
    expect(() => relativeName("elsewhere.invalid", ZONE)).toThrow(DnsError);
  });
});
