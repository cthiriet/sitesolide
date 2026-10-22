import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { detectDns, DnsError, ensureZoneRecords, zoneRecords, type DnsContext } from "../cli/dns/dns";
import { absoluteName, API_VARIABLE, DEFAULT_API, LINODE_DNS, relativeName, TOKEN_SHAPE, TOKEN_VARIABLE, TTL } from "../cli/dns/linode-dns";
import { ProviderError } from "../cli/providers/provider";
import { createFakeLinodeDns, FAKE_TOKEN, ZONE, type FakeLinodeDns } from "./fake-dns-linode-dns";

/**
 * Akamai's Linode DNS Manager, through `LINODE_DNS.open(...)` and setup's
 * record engine, against a local fake of its API (fake-dns-linode-dns.ts): the
 * real one is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, and the token travels in the Authorization header and nowhere
 * else. Every refusal of this file is kept in `printed`, and every address
 * fetched in `fetched`, both read by the last tests.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

let fake: FakeLinodeDns;
const printed: string[] = [];
const fetched: string[] = [];

beforeAll(() => {
  fake = createFakeLinodeDns();
});

afterAll(() => fake.stop());

beforeEach(() => fake.reset());

function open(extra: Partial<DnsContext> = {}) {
  return LINODE_DNS.open({
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

function lines(): string[] {
  return fake
    .records()
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .map((record) => `${record.name} ${record.type} ${record.content}`)
    .sort();
}

const zoneDomain = () => fake.domains.find((domain) => domain.domain === ZONE)!;

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, the empty name for the domain itself, at the lowest TTL", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["", "", "*", "*"]);
    expect(zoneDomain().records.every((record) => record.ttl_sec === TTL)).toBe(true);
    expect(fake.writes().map((request) => request.method)).toEqual(["POST", "POST", "POST", "POST"]);
    expect(fake.writes().every((request) => request.path === `/domains/${zoneDomain().id}/records`)).toBe(true);
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

  test("a TTL the API did not keep at creation is set again at once", async () => {
    fake.settings.ignoreTtlOnCreate = true;
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.writes().map((request) => request.method)).toEqual(["POST", "PUT", "POST", "PUT"]);
    expect(fake.writes().filter((request) => request.method === "PUT").map((request) => request.body)).toEqual([{ ttl_sec: TTL }, { ttl_sec: TTL }]);
    expect(zoneDomain().records.every((record) => record.ttl_sec === TTL)).toBe(true);
  });

  test("other records at those names, MX and TXT, are left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: ZONE, type: "TXT", content: "v=spf1 -all" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.records().filter((record) => ["MX", "TXT"].includes(record.type)).length).toBe(2);
    expect(fake.writes().filter((request) => request.method !== "POST")).toEqual([]);
  });

  test("a zone held as a parent: the records go to the parent domain, named relative to it", async () => {
    const result = await ensureZoneRecords(open(), `apps.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.apps.${ZONE} A ${IPV4}`, `apps.${ZONE} A ${IPV4}`]);
    expect(zoneDomain().records.map((record) => record.name).sort()).toEqual(["*.apps", "apps"]);
  });

  test("the wizard's read writes nothing", async () => {
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:db8::99" });
    const { zone, records } = await zoneRecords(open(), ZONE);
    expect(zone).toEqual({ id: String(zoneDomain().id), name: ZONE });
    expect(records.map((record) => `${record.name} ${record.type} ${record.content}`)).toEqual([`${ZONE} AAAA 2001:db8::99`]);
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

  test("replace updates and deletes exactly what the plan says, deletions first", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "MX", content: "mail.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net" });
    fake.addRecord({ name: `*.${ZONE}`, type: "AAAA", content: "2001:db8::99" });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "delete", "delete", "update"]);
    // The fake refuses an A record beside a CNAME: the CNAME went first.
    expect(fake.writes().map((request) => request.method)).toEqual(["DELETE", "DELETE", "DELETE", "PUT", "POST"]);
    expect(fake.writes().find((request) => request.method === "PUT")!.body).toEqual({ target: IPV4, ttl_sec: TTL });
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
    expect(fake.records().some((record) => record.type === "MX")).toBe(true);
  });
});

describe("refusals", () => {
  test("a refused token: kind token, before anything else is asked", async () => {
    const error = await failure(ensureZoneRecords(open({ credentials: { [TOKEN_VARIABLE]: "0".repeat(64) } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("Invalid Token");
    expect(fake.requests.length).toBe(1);
  });

  test("a token without Domains: kind token, saying so", async () => {
    fake.settings.scope = "none";
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("not authorized to use this endpoint");
    expect(error.details[0]).toContain("Read/Write on Domains");
  });

  test("a Read Only token reads, and is refused the first write: kind token", async () => {
    fake.settings.scope = "read_only";
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain(`POST /domains/${zoneDomain().id}/records`);
  });

  test("a zone no domain holds: kind zone, naming every name tried", async () => {
    const error = await failure(ensureZoneRecords(open(), "sites.unknown-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.details[0]).toBe("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
  });

  test("a domain Linode serves as a secondary copy: refused before anything is written", async () => {
    fake.addDomain("secondary-zone.invalid", "slave");
    const error = await failure(ensureZoneRecords(open(), "secondary-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("secondary copy");
    expect(fake.writes()).toEqual([]);
  });

  test("the API's refusal is quoted, with the field it names: kind refused", async () => {
    fake.fail("POST", /\/records$/, 400, { errors: [{ field: "target", reason: "Target is reserved" }] });
    const error = await failure(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("target: Target is reserved");
  });

  test("an answer that is not the API's, and no answer at all: kind unreachable", async () => {
    const proxy = open({ fetcher: async () => new Response("<html>503 Service Unavailable</html>", { status: 503, headers: { "content-type": "text/html" } }) });
    expect((await failure(proxy.verify())).kind).toBe("unreachable");
    const nowhere = open({
      fetcher: async () => {
        throw new Error(`timed out sending ${FAKE_TOKEN}`);
      },
    });
    const error = await failure(nowhere.verify());
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("[token]");
  });

  test("a refusal that echoes the token is scrubbed of it", async () => {
    fake.fail("GET", /^\/domains$/, 500, { errors: [{ reason: `failure for ${FAKE_TOKEN}` }] });
    const error = await failure(open().verify());
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("failure for [token]");
  });
});

describe("pagination", () => {
  test("every page is read, the domains' and the records', within the bounds of page_size", async () => {
    for (let index = 0; index < 7; index++) fake.addRecord({ name: `host${index}.${ZONE}`, type: "A", content: `198.51.100.${index}` });
    fake.addRecord({ name: ZONE, type: "A", content: IPV4 });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: IPV4 });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(result.actions.map((action) => action.kind)).toEqual(["keep", "keep"]);
    expect(fake.writes()).toEqual([]);
    const pages = fake.requests.filter((request) => request.path === `/domains/${zoneDomain().id}/records`).map((request) => new URLSearchParams(request.search).get("page"));
    expect(pages).toEqual(["1", "2", "3", "4", "5", "1", "2", "3", "4", "5"]);
    expect(fake.requests.filter((request) => request.path === "/domains" && new URLSearchParams(request.search).get("page") === "2").length).toBe(1);
    for (const request of fake.requests) {
      const size = Number(new URLSearchParams(request.search).get("page_size"));
      expect(size >= 25 && size <= 500).toBe(true);
    }
  });
});

describe("the token", () => {
  test("travels in the Authorization header, and in no address, body or message", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body)).not.toContain(FAKE_TOKEN);
    }
    for (const address of fetched) {
      expect(address).not.toContain(FAKE_TOKEN);
      expect(address.startsWith(fake.url)).toBe(true);
    }
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) expect(line).not.toContain(FAKE_TOKEN);
  });

  test("has a token's shape: a line break or a space is refused, and the variable is sitesolide's own", () => {
    expect(TOKEN_SHAPE.test(FAKE_TOKEN)).toBe(true);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN}\n`)).toBe(false);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN}\nOTHER=1`)).toBe(false);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN.slice(0, 32)} ${FAKE_TOKEN.slice(32)}`)).toBe(false);
    expect(LINODE_DNS.credentials.map((field) => field.variable)).toEqual(["SITESOLIDE_DNS_LINODE_TOKEN"]);
    expect(LINODE_DNS.credentials.every((field) => field.secret && !["LINODE_TOKEN", "LINODE_CLI_TOKEN"].includes(field.variable))).toBe(true);
  });
});

describe("Caddy", () => {
  test("the directive reads every credential from Caddy's environment, and the environment holds exactly those", () => {
    const placeholders = LINODE_DNS.caddy.directive.join("\n").match(/\{[^}]*\}/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.every((placeholder) => /^\{env\.[A-Z][A-Z0-9_]*\}$/.test(placeholder))).toBe(true);
    const named = placeholders.map((placeholder) => placeholder.slice(5, -1)).sort();
    const environment = LINODE_DNS.caddy.environment({ [TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(Object.keys(environment).sort()).toEqual(named);
    expect(environment[TOKEN_VARIABLE]).toBe(FAKE_TOKEN);
    expect(LINODE_DNS.caddy.directive).toEqual(["dns linode {env.SITESOLIDE_DNS_LINODE_TOKEN}", "dns_ttl 30s", "propagation_timeout 20m"]);
  });

  test("the module, as caddy add-package takes it and caddy list-modules prints it", () => {
    expect(LINODE_DNS.caddy.package).toBe("github.com/caddy-dns/linode");
    expect(LINODE_DNS.caddy.module).toBe("dns.providers.linode");
  });
});

describe("name servers", () => {
  // As `dig +short NS` answered on 2026-10-21 for zones the DNS Manager serves.
  const REAL = ["ns1.linode.com", "ns2.linode.com", "ns3.linode.com", "ns4.linode.com", "ns5.linode.com"];

  test("match Linode's, and nobody else's, Akamai's own zones included", () => {
    for (const server of REAL) expect(LINODE_DNS.nameServers.test(server)).toBe(true);
    // linode.com itself is served by Akamai's Edge DNS, which is not the DNS Manager.
    for (const server of ["ns6.linode.com", "ns1.linode.com.test-zone.invalid", "xns1.linode.com", "a1-249.akam.net", "ns1.digitalocean.com", "ns1.vultr.com"]) {
      expect(LINODE_DNS.nameServers.test(server)).toBe(false);
    }
  });

  test("tell the wizard who holds a zone, from its NS records", async () => {
    const found = await detectDns(ZONE, [CLOUDFLARE, LINODE_DNS], async () => REAL.map((server) => `${server}.`));
    expect(found.entry).toBe(LINODE_DNS);
  });
});

describe("addresses and names", () => {
  test("its page of the docs exists", async () => {
    expect(LINODE_DNS.docs).toBe("docs/dns/linode-dns.md");
    expect(await Bun.file(`${import.meta.dir}/../../${LINODE_DNS.docs}`).exists()).toBe(true);
  });

  test("the API is Akamai's unless the variable names a fake on the loopback", () => {
    expect(DEFAULT_API).toBe("https://api.linode.com/v4");
    expect(LINODE_DNS.apiVariable).toBe(API_VARIABLE);
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid/v4" } })).toThrow(ProviderError);
  });

  test("names convert both ways, the empty name for the domain itself", () => {
    expect(absoluteName("", ZONE)).toBe(ZONE);
    expect(absoluteName("*", ZONE)).toBe(`*.${ZONE}`);
    expect(absoluteName("*.apps", ZONE)).toBe(`*.apps.${ZONE}`);
    expect(relativeName(ZONE, ZONE)).toBe("");
    expect(relativeName(`apps.${ZONE}`, ZONE)).toBe("apps");
    expect(() => relativeName("elsewhere.invalid", ZONE)).toThrow(DnsError);
  });
});
