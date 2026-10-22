import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import { API_VARIABLE, DEFAULT_API, HETZNER_DNS, parseRecordId, recordId, TOKEN_SHAPE, TOKEN_VARIABLE, TTL, WAITS } from "../cli/dns/hetzner-dns";
import { ProviderError, type Clock } from "../cli/providers/provider";
import { tlsZoneContent } from "../cli/tls";
import { createFakeHetznerDns, FAKE_TOKEN, ZONE, type FakeHetznerDns } from "./fake-dns-hetzner-dns";

/**
 * bin/cli/dns/hetzner-dns.ts, through HETZNER_DNS.open and setup's record
 * engine (ensureZoneRecords in bin/cli/dns/dns.ts), against the local fake of
 * the Cloud API's zones (fake-dns-hetzner-dns.ts): api.hetzner.cloud is never
 * called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, a set's other values survive a change to one of them, and the
 * token travels in the Authorization header and nowhere else.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

const fake: FakeHetznerDns = createFakeHetznerDns();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Every message a test saw, read by the last test for the token. */
const said: string[] = [];

/** A clock that never waits: a sleep moves it forward. */
function testClock(): Clock & { slept: number } {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const clock = {
    slept: 0,
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
      clock.slept += milliseconds;
    },
  };
  return clock;
}

function context(overrides: Partial<DnsContext> = {}): DnsContext {
  return {
    credentials: { [TOKEN_VARIABLE]: FAKE_TOKEN },
    environment: fake.environment,
    fetcher: (input, init) => fetch(input, init),
    clock: testClock(),
    secret: () => {},
    ...overrides,
  };
}

const open = (overrides: Partial<DnsContext> = {}): ZoneApi => HETZNER_DNS.open(context(overrides));

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

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, TTL 60, and a second run writes nothing", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(fake.set(ZONE, "A")?.ttl).toBe(TTL);
    expect(fake.set(`*.${ZONE}`, "AAAA")?.ttl).toBe(TTL);
    // Created as the API names them: `@` for the zone itself, `*` for its wildcard.
    const created = fake.writes().map((request) => (request.body as { name: string; type: string }).name + " " + (request.body as { type: string }).type);
    expect(created.sort()).toEqual(["* A", "* AAAA", "@ A", "@ AAAA"]);

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

  test("the zone's SOA and NS, and its MX and TXT, are read and left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"v=spf1 -all"' });
    const { records } = await zoneRecords(open(), ZONE);
    expect(records.filter((record) => record.name === ZONE).map((record) => record.type).sort()).toEqual(["MX", "NS", "NS", "NS", "SOA", "TXT"]);
    expect(records.every((record) => record.proxied === false)).toBe(true);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toContain(`${ZONE} MX 10 mail.example.net.`);
    expect(lines()).toContain(`${ZONE} TXT "v=spf1 -all"`);
    expect(fake.set(ZONE, "NS")?.records).toHaveLength(3);
  });

  test("a zone held as a subdomain of a Hetzner zone is found through its parent", async () => {
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    const names = fake.writes().map((request) => (request.body as { name: string }).name).sort();
    expect(names).toEqual(["*.sites", "sites"]);
  });

  test("each write's action is waited for, a second between reads", async () => {
    fake.settings.actionPolls = 3;
    const clock = testClock();
    await ensureZoneRecords(open({ clock }), ZONE, { ipv4: IPV4, ipv6: null }, false);
    const reads = fake.requests.filter((request) => request.path.startsWith("/zones/actions/"));
    expect(reads).toHaveLength(6);
    expect(clock.slept).toBe(6 * WAITS.pollMs);
  });

  test("an action that fails is the API saying no", async () => {
    fake.settings.failAction = "create_rrset";
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Hetzner could not create ${ZONE} A (action action_failed): Action failed`);
  });

  test("an action still running after two minutes is given up, saying so", async () => {
    fake.settings.actionPolls = 1_000;
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("had not finished");
  });
});

describe("never someone else's record", () => {
  test("a record pointing elsewhere is a conflict, named, and nothing at all is written", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(fake.writes()).toEqual([]);
    expect(lines()).toEqual([`*.${ZONE} A 198.51.100.7`]);
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
    fake.addRecord({ name: ZONE, type: "TXT", content: '"keep me"' });
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "create", "create", "delete", "delete", "update"]);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`, `${ZONE} TXT "keep me"`]);
    const writes = fake.writes().map((request) => request.path);
    expect(writes.findIndex((path) => path === "/zones/" + fake.zones[1]!.id + "/rrsets/*/CNAME/actions/remove_records")).toBeLessThan(
      writes.findIndex((path) => path === `/zones/${fake.zones[1]!.id}/rrsets`),
    );
  });

  test("an update or a deletion touches that one value, and every other value of the set is kept", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.9" });
    fake.set(ZONE, "A")!.records[2]!.comment = "the old mail relay";
    const api = open();
    const zone = await api.findZone(ZONE);
    const records = await api.listRecords(zone, ZONE);
    const seven = records.find((record) => record.content === "198.51.100.7")!;
    const eight = records.find((record) => record.content === "198.51.100.8")!;
    expect(parseRecordId(seven.id)).toEqual({ name: "@", type: "A", value: "198.51.100.7" });

    await api.updateRecord(zone, seven, IPV4);
    expect(fake.set(ZONE, "A")!.records).toEqual([
      { value: IPV4, comment: "" },
      { value: "198.51.100.8", comment: "" },
      { value: "198.51.100.9", comment: "the old mail relay" },
    ]);
    await api.deleteRecord(zone, eight);
    expect(fake.set(ZONE, "A")!.records.map((record) => record.value)).toEqual([IPV4, "198.51.100.9"]);
    expect(fake.writes().map((request) => request.body)).toEqual([
      { records: [{ value: IPV4 }, { value: "198.51.100.8" }, { value: "198.51.100.9", comment: "the old mail relay" }] },
      { records: [{ value: "198.51.100.8" }] },
    ]);
  });

  test("a value gone since it was read is not written over", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const api = open();
    const zone = await api.findZone(ZONE);
    const [record] = await api.listRecords(zone, ZONE).then((records) => records.filter((entry) => entry.type === "A"));
    fake.set(ZONE, "A")!.records[0]!.value = "198.51.100.99";
    const error = await refusal(api.updateRecord(zone, record!, IPV4));
    expect(error.kind).toBe("refused");
    expect(fake.writes()).toEqual([]);
  });
});

describe("what the API refuses", () => {
  test("a token Hetzner does not know: kind token, before any record is read", async () => {
    const wrong = "Zz9DAWQ1ZAEFSrCNEEzLCUwhYX1U3g7wMg4dTlkkDC96fyDuyJ39nVbVjCKSDfjQ";
    const error = await refusal(ensureZoneRecords(open({ credentials: { [TOKEN_VARIABLE]: wrong } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("Hetzner refused the token (401 unauthorized): unable to authenticate");
    expect(fake.requests.map((request) => request.path)).toEqual(["/zones"]);
    expect([error.message, ...error.details].join("\n")).not.toContain(wrong);
  });

  test("a Read token: the write is refused, kind token, saying it needs Read & Write", async () => {
    fake.settings.readOnly = true;
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("(403 forbidden)");
    expect(error.details.join("\n")).toContain("Read & Write");
  });

  test("a zone no project of the token holds: kind zone, with the names looked for", async () => {
    const error = await refusal(ensureZoneRecords(open(), `sites.missing-zone.invalid`, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe("no Hetzner zone the token can read holds sites.missing-zone.invalid");
    expect(error.details[0]).toBe("looked for: sites.missing-zone.invalid, missing-zone.invalid");
  });

  test("a secondary zone, whose records the API cannot write, is refused before anything is read", async () => {
    fake.zones[1]!.mode = "secondary";
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Hetzner serves ${ZONE} as a secondary zone`);
    expect(fake.requests.some((request) => request.path.includes("/rrsets"))).toBe(false);
  });

  test("the API's own words, and its code, for a request it refuses", async () => {
    fake.fail("POST", /\/rrsets$/, 422, "invalid_input", "invalid input in field 'records': is invalid");
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`Hetzner refused POST /zones/${fake.zones[1]!.id}/rrsets (422 invalid_input): invalid input in field 'records': is invalid`);
  });

  test("nothing listening: unreachable, and the token is not in the message", async () => {
    const error = await refusal(open({ environment: { [API_VARIABLE]: "http://127.0.0.1:9/v1" } }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("an answer that is not the API's: unreachable", async () => {
    const html = async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    const error = await refusal(open({ fetcher: html }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("the address: Hetzner's, or a fake's on the loopback, never http elsewhere", () => {
    expect(DEFAULT_API).toBe("https://api.hetzner.cloud/v1");
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid/v1" } })).toThrow(ProviderError);
  });
});

describe("pagination", () => {
  test("every page of a name's sets is read: a conflict on the last page is still found", async () => {
    fake.settings.pageSize = 1;
    fake.addRecord({ name: `*.${ZONE}`, type: "TXT", content: '"one"' });
    fake.addRecord({ name: `*.${ZONE}`, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details[0]).toContain("198.51.100.7");
    const pages = fake.requests.filter((request) => request.path.endsWith("/rrsets") && new URLSearchParams(request.search).get("name") === "*");
    expect(pages.map((request) => new URLSearchParams(request.search).get("page"))).toEqual(["1", "2", "3"]);
    expect(pages.every((request) => new URLSearchParams(request.search).get("per_page") === "50")).toBe(true);
  });
});

describe("the token", () => {
  test("travels in the Authorization header and nowhere else", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(fake.requests.length).toBeGreaterThan(4);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body ?? "")).not.toContain(FAKE_TOKEN);
    }
  });

  test("a text from outside that would carry it is scrubbed", async () => {
    fake.fail("GET", /^\/zones$/, 422, "invalid_input", `bad token ${FAKE_TOKEN}`);
    const error = await refusal(open().verify());
    expect(error.message).toContain("bad token [token]");
  });

  test("its shape: 64 letters and digits, one line", () => {
    expect(TOKEN_SHAPE.test(FAKE_TOKEN)).toBe(true);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN}\nOTHER=1`)).toBe(false);
    expect(TOKEN_SHAPE.test(FAKE_TOKEN.slice(1))).toBe(false);
    expect(TOKEN_SHAPE.test(`${FAKE_TOKEN.slice(1)}$`)).toBe(false);
  });

  test("appears in nothing any test of this file was told", () => {
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) expect(line).not.toContain(FAKE_TOKEN);
  });
});

describe("the entry", () => {
  test("its page of the docs exists", async () => {
    expect(await Bun.file(new URL(`../../${HETZNER_DNS.docs}`, import.meta.url)).exists()).toBe(true);
  });

  test("its credential is sitesolide's own variable, never HCLOUD_TOKEN", () => {
    expect(HETZNER_DNS.name).toBe("hetzner-dns");
    expect(HETZNER_DNS.credentials.map((field) => field.variable)).toEqual(["SITESOLIDE_DNS_HETZNER_TOKEN"]);
    expect(HETZNER_DNS.credentials.every((field) => field.secret)).toBe(true);
    expect(HETZNER_DNS.apiVariable).toBe("SITESOLIDE_HETZNER_DNS_API");
    expect(HETZNER_DNS.docs).toBe("docs/dns/hetzner-dns.md");
  });

  test("the Caddy directive reads every credential from Caddy's environment, and the file holds exactly those", () => {
    const { caddy } = HETZNER_DNS;
    expect(caddy.package).toBe("github.com/caddy-dns/hetzner@v2.0.1");
    expect(caddy.module).toBe("dns.providers.hetzner");
    const text = caddy.directive.join("\n");
    expect(text).not.toContain(FAKE_TOKEN);
    const placeholders = [...text.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]!);
    expect(placeholders.every((placeholder) => placeholder.startsWith("env."))).toBe(true);
    const environment = caddy.environment({ [TOKEN_VARIABLE]: FAKE_TOKEN });
    expect(Object.keys(environment).sort()).toEqual(placeholders.map((placeholder) => placeholder.slice(4)).sort());
    expect(environment).toEqual({ SITESOLIDE_DNS_HETZNER_TOKEN: FAKE_TOKEN });
    expect(tlsZoneContent({ kind: "dns", title: HETZNER_DNS.title, directive: caddy.directive })).toContain(
      `\tdns hetzner {env.${TOKEN_VARIABLE}}\n\tpropagation_delay 30s\n`,
    );
  });

  test("its name servers are Hetzner's, those of DNS hosting alone", async () => {
    for (const server of ["hydrogen.ns.hetzner.com", "oxygen.ns.hetzner.com", "helium.ns.hetzner.de", "ns1.first-ns.de", "robotns2.second-ns.de", "robotns3.second-ns.com"]) {
      expect(HETZNER_DNS.nameServers.test(server)).toBe(true);
    }
    for (const server of ["ns1.your-server.de", "ns.second-ns.com", "ns3.second-ns.de", "ada.ns.cloudflare.com", "hydrogen.ns.hetzner.com.test-zone.invalid", "xhydrogen.ns.hetzner.com"]) {
      expect(HETZNER_DNS.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["hydrogen.ns.hetzner.com.", "oxygen.ns.hetzner.com.", "helium.ns.hetzner.de."] : []);
    expect((await detectDns(`sites.${ZONE}`, [HETZNER_DNS], lookup)).entry).toBe(HETZNER_DNS);
  });

  test("a record id finds its value again, whatever the value holds", () => {
    expect(parseRecordId(recordId("*.sites", "TXT", '"a/b c"'))).toEqual({ name: "*.sites", type: "TXT", value: '"a/b c"' });
  });
});
