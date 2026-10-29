import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { detectDns, DnsError, ensureZoneRecords, zoneRecords, type DnsContext } from "../cli/dns/dns";
import { absoluteName, API_VARIABLE, DEFAULT_API, KEY_SHAPE, KEY_VARIABLE, relativeName, TTL, VULTR_DNS } from "../cli/dns/vultr-dns";
import { ProviderError } from "../../clouds/src/provider";
import { createFakeVultrDns, FAKE_KEY, ZONE, type FakeVultrDns } from "./fake-dns-vultr-dns";

/**
 * Vultr's DNS, through `VULTR_DNS.open(...)` and setup's record engine,
 * against a local fake of its API (fake-dns-vultr-dns.ts): the real one is never
 * called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, and the key travels in the Authorization header and nowhere
 * else. Every refusal of this file is kept in `printed`, and every address
 * fetched in `fetched`, both read by the last tests.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

let fake: FakeVultrDns;
const printed: string[] = [];
const fetched: string[] = [];

beforeAll(() => {
  fake = createFakeVultrDns();
});

afterAll(() => fake.stop());

beforeEach(() => fake.reset());

function open(extra: Partial<DnsContext> = {}) {
  return VULTR_DNS.open({
    credentials: { [KEY_VARIABLE]: FAKE_KEY },
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

function lines(): string[] {
  return fake
    .records()
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .map((record) => `${record.name} ${record.type} ${record.content}`)
    .sort();
}

const zoneDomain = () => fake.domains.find((domain) => domain.domain === ZONE)!;

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, the empty name for the domain itself", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["", "", "*", "*"]);
    expect(zoneDomain().records.every((record) => record.ttl === TTL)).toBe(true);
    expect(fake.writes().map((request) => request.method)).toEqual(["POST", "POST", "POST", "POST"]);
  });

  test("a machine without IPv6: two records, and no AAAA", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("a second run writes nothing", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    const before = fake.writes().length;
    const again = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(fake.writes().length).toBe(before);
    expect(again.actions.every((action) => action.kind === "keep")).toBe(true);
  });

  test("names answered in full, as the reference's example of a listing shows them, read the same", async () => {
    fake.settings.absoluteNames = true;
    fake.addRecord({ name: ZONE, type: "A", content: IPV4 });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(fake.writes()).toEqual([]);
  });

  test("other records at those names, the name servers, MX and TXT, are left alone", async () => {
    fake.addRecord({ name: ZONE, type: "NS", content: "ns1.vultr.com" });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"v=spf1 -all"' });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.records().filter((record) => ["NS", "MX", "TXT"].includes(record.type)).length).toBe(3);
    expect(fake.writes().filter((request) => request.method !== "POST")).toEqual([]);
  });

  test("a zone held as a parent: the records go to the parent domain, named relative to it", async () => {
    const result = await ensureZoneRecords(open(), `apps.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.apps.${ZONE} A ${IPV4}`, `apps.${ZONE} A ${IPV4}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["*.apps", "apps"]);
  });

  test("the wizard's read writes nothing", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    const { zone, records } = await zoneRecords(open(), ZONE);
    expect(zone).toEqual({ id: ZONE, name: ZONE });
    expect(records.map((record) => `${record.name} ${record.type} ${record.content}`)).toEqual([`*.${ZONE} CNAME elsewhere.example.net`]);
    expect(fake.writes()).toEqual([]);
  });
});

describe("never someone else's record", () => {
  test("a record that points elsewhere is a conflict, and nothing is written", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(fake.writes()).toEqual([]);
  });

  test("replace updates and deletes exactly what the plan says, without ever mixing TTLs", async () => {
    // Two A records of one name and TTL, as Vultr requires them: one is
    // updated, at another TTL, which it accepts only once the other is gone.
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7", ttl: 3600 });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8", ttl: 3600 });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "AAAA", content: "2001:db8::99" });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "delete", "delete", "update"]);
    expect(fake.writes().map((request) => request.method)).toEqual(["DELETE", "DELETE", "DELETE", "PATCH", "POST"]);
    expect(fake.writes().find((request) => request.method === "PATCH")!.body).toEqual({ data: IPV4, ttl: TTL });
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
    expect(fake.records().some((record) => record.type === "MX")).toBe(true);
  });
});

describe("refusals", () => {
  test("a refused key: kind token, before anything else is asked, naming the access control list", async () => {
    const error = await failure(ensureZoneRecords(open({ credentials: { [KEY_VARIABLE]: "X".repeat(36) } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.details[0]).toContain("access control list");
    expect(fake.requests.length).toBe(1);
  });

  test("a key whose policy does not list the domains: kind token", async () => {
    fake.settings.actions = new Set(["network.dns.Read"]);
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("network.dns.List");
  });

  test("a key that may read but not create: kind token, at the first write", async () => {
    fake.settings.actions = new Set(["network.dns.List", "network.dns.Read"]);
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain(`POST /domains/${ZONE}/records`);
  });

  test("a zone no domain holds: kind zone, naming every name tried", async () => {
    const error = await failure(ensureZoneRecords(open(), "sites.unknown-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.details[0]).toBe("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
  });

  test("the API's refusal is quoted: kind refused", async () => {
    fake.fail("POST", /\/records$/, 400, { error: "Unable to create record: the zone is locked", status: 400 });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("Unable to create record: the zone is locked");
  });

  test("an answer that is not the API's, and no answer at all: kind unreachable", async () => {
    const proxy = open({ fetcher: async () => new Response("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } }) });
    expect((await failure(proxy.verify())).kind).toBe("unreachable");
    const nowhere = open({
      fetcher: async () => {
        throw new Error(`socket closed after ${FAKE_KEY}`);
      },
    });
    const error = await failure(nowhere.verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("[token]");
  });

  test("a refusal that echoes the key is scrubbed of it", async () => {
    fake.fail("GET", /^\/domains$/, 500, { error: `internal error for ${FAKE_KEY}`, status: 500 });
    const error = await failure(open().verify());
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("internal error for [token]");
  });
});

describe("pagination", () => {
  test("cursors are followed to the end, for the domains and for the records", async () => {
    for (let index = 0; index < 7; index++) fake.addRecord({ name: `host${index}.${ZONE}`, type: "A", content: `198.51.100.${index}` });
    fake.addRecord({ name: ZONE, type: "A", content: IPV4 });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: IPV4 });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(result.actions.map((action) => action.kind)).toEqual(["keep", "keep"]);
    expect(fake.writes()).toEqual([]);
    const reads = fake.requests.filter((request) => request.path === `/domains/${ZONE}/records`);
    expect(reads.length).toBe(10);
    expect(reads.filter((request) => new URLSearchParams(request.search).has("cursor")).length).toBe(8);
    expect(reads.every((request) => new URLSearchParams(request.search).get("per_page") === "500")).toBe(true);
  });
});

describe("the key", () => {
  test("travels in the Authorization header, and in no address, body or message", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(request.url).not.toContain(FAKE_KEY);
      expect(JSON.stringify(request.body)).not.toContain(FAKE_KEY);
    }
    for (const address of fetched) {
      expect(address).not.toContain(FAKE_KEY);
      expect(address.startsWith(fake.url)).toBe(true);
    }
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) expect(line).not.toContain(FAKE_KEY);
  });

  test("has a key's shape: a line break or a space is refused, and the variable is sitesolide's own", () => {
    expect(KEY_SHAPE.test(FAKE_KEY)).toBe(true);
    expect(KEY_SHAPE.test(`${FAKE_KEY}\n`)).toBe(false);
    expect(KEY_SHAPE.test(`${FAKE_KEY}\nOTHER=1`)).toBe(false);
    expect(KEY_SHAPE.test(`${FAKE_KEY.slice(0, 20)} ${FAKE_KEY.slice(20)}`)).toBe(false);
    expect(VULTR_DNS.credentials.map((field) => field.variable)).toEqual(["SITESOLIDE_DNS_VULTR_API_KEY"]);
    expect(VULTR_DNS.credentials.every((field) => field.secret && field.variable !== "VULTR_API_KEY")).toBe(true);
  });
});

describe("Caddy", () => {
  test("the directive reads every credential from Caddy's environment, and the environment holds exactly those", () => {
    const placeholders = VULTR_DNS.caddy.directive.join("\n").match(/\{[^}]*\}/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.every((placeholder) => /^\{env\.[A-Z][A-Z0-9_]*\}$/.test(placeholder))).toBe(true);
    const named = placeholders.map((placeholder) => placeholder.slice(5, -1)).sort();
    const environment = VULTR_DNS.caddy.environment({ [KEY_VARIABLE]: FAKE_KEY });
    expect(Object.keys(environment).sort()).toEqual(named);
    expect(environment[KEY_VARIABLE]).toBe(FAKE_KEY);
    expect(VULTR_DNS.caddy.directive).toEqual(["dns vultr {env.SITESOLIDE_DNS_VULTR_API_KEY}"]);
  });

  test("the module, as caddy add-package takes it and caddy list-modules prints it", () => {
    expect(VULTR_DNS.caddy.package).toBe("github.com/caddy-dns/vultr");
    expect(VULTR_DNS.caddy.module).toBe("dns.providers.vultr");
  });
});

describe("name servers", () => {
  // As `dig +short NS` answered on 2026-10-21 for zones Vultr serves, vultr.com among them.
  const REAL = ["ns1.vultr.com", "ns2.vultr.com"];

  test("match Vultr's, and nobody else's", () => {
    for (const server of REAL) expect(VULTR_DNS.nameServers.test(server)).toBe(true);
    for (const server of ["ns3.vultr.com", "ns1.vultr.com.test-zone.invalid", "xns1.vultr.com", "ns1.digitalocean.com", "ns1.linode.com", "kim.ns.cloudflare.com"]) {
      expect(VULTR_DNS.nameServers.test(server)).toBe(false);
    }
  });

  test("tell the wizard who holds a zone, from its NS records", async () => {
    const found = await detectDns(ZONE, [CLOUDFLARE, VULTR_DNS], async () => REAL.map((server) => `${server}.`));
    expect(found.entry).toBe(VULTR_DNS);
  });
});

describe("addresses and names", () => {
  test("its page of the docs exists", async () => {
    expect(VULTR_DNS.docs).toBe("docs/dns/vultr-dns.md");
    expect(await Bun.file(`${import.meta.dir}/../../${VULTR_DNS.docs}`).exists()).toBe(true);
  });

  test("the API is Vultr's unless the variable names a fake on the loopback", () => {
    expect(DEFAULT_API).toBe("https://api.vultr.com/v2");
    expect(VULTR_DNS.apiVariable).toBe(API_VARIABLE);
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid/v2" } })).toThrow(ProviderError);
  });

  test("names convert both ways, the empty name for the domain itself", () => {
    expect(absoluteName("", ZONE)).toBe(ZONE);
    expect(absoluteName("@", ZONE)).toBe(ZONE);
    expect(absoluteName("*", ZONE)).toBe(`*.${ZONE}`);
    expect(absoluteName(`foo.${ZONE}`, ZONE)).toBe(`foo.${ZONE}`);
    expect(absoluteName(ZONE, ZONE)).toBe(ZONE);
    expect(relativeName(ZONE, ZONE)).toBe("");
    expect(relativeName(`*.apps.${ZONE}`, ZONE)).toBe("*.apps");
    expect(() => relativeName("elsewhere.invalid", ZONE)).toThrow(DnsError);
  });
});
