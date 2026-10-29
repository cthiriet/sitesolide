import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AZURE_DNS, API_VARIABLE, LOGIN_VARIABLE, TTL } from "../cli/dns/azure-dns";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { detectDns, DnsError, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import { ProviderError, type Clock } from "../../clouds/src/provider";
import { CLIENT, CLIENT_SECRET, createFake, GROUP, SUBSCRIPTION, TENANT, type FakeAzureDns } from "./fake-dns-azure-dns";

/**
 * Azure DNS, through `AZURE_DNS.open(...)` and setup's record engine
 * (ensureZoneRecords in bin/cli/dns/dns.ts), against a local fake of
 * Microsoft Entra and Resource Manager (fake-dns-azure-dns.ts): the real
 * ones are never called. The clock does not wait.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, a record set's other values are kept, and neither the client
 * secret nor a token is ever in an address, a body that is not the token
 * request's, or a refusal. Every test's requests are checked after it, and
 * every refusal is kept in `printed`, read by the last test.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const OTHER = "198.51.100.7";
const ROOT = join(import.meta.dir, "..", "..");

let fake: FakeAzureDns;
/** Every refusal's message and details, read by the last test. */
const printed: string[] = [];
/** Every token the fake handed out, across resets, and every value given to `context.secret`. */
const issued = new Set<string>();
const scrubbed = new Set<string>();

beforeAll(() => {
  fake = createFake();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
});

/** The secret travels in the token request alone, the token in the Authorization header of Resource Manager's calls alone. */
afterEach(() => {
  for (const token of fake.issued) issued.add(token);
  for (const request of fake.requests) {
    const tokenRequest = request.path.endsWith("/oauth2/v2.0/token");
    expect(request.url).not.toContain(CLIENT_SECRET);
    expect(request.url).not.toContain(encodeURIComponent(CLIENT_SECRET));
    for (const token of fake.issued) {
      expect(request.url).not.toContain(token);
      expect(JSON.stringify(request.body ?? "")).not.toContain(token);
    }
    if (tokenRequest) continue;
    expect(JSON.stringify(request.body ?? "")).not.toContain(CLIENT_SECRET);
    const { authorization, ...others } = request.headers;
    expect(authorization).toMatch(/^Bearer /);
    expect(fake.issued).toContain(authorization!.slice(7));
    expect(JSON.stringify(others)).not.toContain(CLIENT_SECRET);
  }
});

function fakeClock(): Clock & { sleeps: number[]; advance: (milliseconds: number) => void } {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (milliseconds: number) => void (sleeps.push(milliseconds), (now += milliseconds)),
    sleeps,
    advance: (milliseconds) => void (now += milliseconds),
  };
}

function credentialsOf(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(AZURE_DNS.credentials.map((field) => [field.variable, environment[field.variable] ?? ""]).filter(([, value]) => value !== ""));
}

function open(environment: Record<string, string> = fake.environment, extra: Partial<DnsContext> = {}): ZoneApi {
  return AZURE_DNS.open({ credentials: credentialsOf(environment), environment, fetcher: fetch, clock: fakeClock(), secret: (value) => void scrubbed.add(value), ...extra });
}

async function refusal(promise: Promise<unknown>): Promise<DnsError> {
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

/** The zone's records as lines, in a stable order. */
function zoneLines(): string[] {
  return fake.records().map((record) => `${record.name} ${record.type} ${record.content}`).sort();
}

/** A request's path inside the zone, decoded: `/A/@`. */
function short(path: string): string {
  return decodeURIComponent(path).replace(new RegExp(`^/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/Microsoft\\.Network/dnsZones/${fake.zone.replaceAll(".", "\\.")}`, "i"), "");
}

/** What changed something at Resource Manager, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/oauth2/v2.0/token")).map((entry) => `${entry.method} ${short(entry.path)}`);
}

const addresses = { ipv4: IPV4, ipv6: IPV6 };

// --- the entry ---------------------------------------------------------------------------------

describe("the entry", () => {
  test("its credentials are sitesolide's own variables, never those Azure's tools read", () => {
    const variables = AZURE_DNS.credentials.map((field) => field.variable);
    expect(variables).toEqual([
      "SITESOLIDE_DNS_AZURE_TENANT_ID",
      "SITESOLIDE_DNS_AZURE_CLIENT_ID",
      "SITESOLIDE_DNS_AZURE_CLIENT_SECRET",
      "SITESOLIDE_DNS_AZURE_SUBSCRIPTION_ID",
      "SITESOLIDE_DNS_AZURE_RESOURCE_GROUP",
    ]);
    for (const variable of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID", "ARM_CLIENT_SECRET"]) expect(variables).not.toContain(variable);
    expect(AZURE_DNS.credentials.filter((field) => field.secret).map((field) => field.variable)).toEqual(["SITESOLIDE_DNS_AZURE_CLIENT_SECRET"]);
    expect(AZURE_DNS.credentials.every((field) => field.optional !== true)).toBe(true);
    expect(AZURE_DNS.name).toBe("azure-dns");
    expect(AZURE_DNS.apiVariable).toBe("SITESOLIDE_AZURE_DNS_API");
  });

  test("each credential's shape takes a real value and refuses one a line of an environment file cannot hold", () => {
    for (const field of AZURE_DNS.credentials) {
      const value = fake.environment[field.variable]!;
      expect({ field: field.variable, ok: field.shape.test(value) }).toEqual({ field: field.variable, ok: true });
      for (const wrong of [`${value}\n`, `${value.slice(0, 3)}\n${value.slice(3)}`, `${value}\r`, "", " "]) {
        expect({ field: field.variable, wrong, ok: field.shape.test(wrong) }).toEqual({ field: field.variable, wrong, ok: false });
      }
    }
    const shape = (variable: string) => AZURE_DNS.credentials.find((field) => field.variable === variable)!.shape;
    expect(shape("SITESOLIDE_DNS_AZURE_TENANT_ID").test("contoso.onmicrosoft.com")).toBe(true);
    expect(shape("SITESOLIDE_DNS_AZURE_CLIENT_SECRET").test('abc"defghij')).toBe(false);
    expect(shape("SITESOLIDE_DNS_AZURE_CLIENT_SECRET").test("abc defghij")).toBe(false);
    expect(shape("SITESOLIDE_DNS_AZURE_CLIENT_SECRET").test("abc\\defghij")).toBe(false);
    for (const group of ["dns", "rg_1(prod).zones", "a".repeat(90)]) expect({ group, ok: shape("SITESOLIDE_DNS_AZURE_RESOURCE_GROUP").test(group) }).toEqual({ group, ok: true });
    // A name Azure takes in another script is refused: Caddy's environment file holds ASCII alone.
    for (const group of ["ends.", "a".repeat(91), "has space", "slash/no", "Zonen-\u00dc"]) expect({ group, ok: shape("SITESOLIDE_DNS_AZURE_RESOURCE_GROUP").test(group) }).toEqual({ group, ok: false });
  });

  test("Caddy's directive reads every credential from its environment, and names nothing else", () => {
    const credentials = credentialsOf(fake.environment);
    const directive = AZURE_DNS.caddy.directive;
    const text = directive.join("\n");
    expect(AZURE_DNS.caddy.package).toBe("github.com/caddy-dns/azure");
    expect(AZURE_DNS.caddy.module).toBe("dns.providers.azure");
    expect(directive[0]).toBe("dns azure {");
    expect(directive.at(-1)).toBe("}");
    // The subdirectives of github.com/caddy-dns/azure's UnmarshalCaddyfile, each a placeholder its Provision replaces.
    const inner = directive.slice(1, -1).map((line) => line.trim().split(/\s+/));
    expect(inner.map(([name]) => name)).toEqual(["tenant_id", "client_id", "client_secret", "subscription_id", "resource_group_name"]);
    expect(inner.every((words) => words.length === 2 && /^\{env\.[A-Z0-9_]+\}$/.test(words[1]!))).toBe(true);
    const placeholders = [...text.matchAll(/\{([^{}\s]+)\}/g)].map((match) => match[1]!);
    expect(placeholders.every((placeholder) => placeholder.startsWith("env."))).toBe(true);
    const named = placeholders.map((placeholder) => placeholder.slice(4)).sort();
    const environment = AZURE_DNS.caddy.environment(credentials);
    expect(Object.keys(environment).sort()).toEqual(named);
    expect(named).toEqual(AZURE_DNS.credentials.map((field) => field.variable).sort());
    for (const [variable, value] of Object.entries(environment)) expect(value).toBe(fake.environment[variable]!);
    for (const value of Object.values(credentials)) expect(text).not.toContain(value);
  });

  test("the name servers it recognises are Azure's public ones, as real zones show them", () => {
    // From `dig NS` of zones Azure DNS serves: microsoft.com, xbox.com, office.com, minecraft.net.
    for (const server of ["ns1-39.azure-dns.com", "ns2-39.azure-dns.net", "ns3-39.azure-dns.org", "ns4-39.azure-dns.info", "ns1-205.azure-dns.com", "ns4-05.azure-dns.info", "ns2-33.azure-dns.net", "ns1-01.azure-dns.com"]) {
      expect({ server, ok: AZURE_DNS.nameServers.test(server) }).toEqual({ server, ok: true });
    }
    for (const server of [
      "ada.ns.cloudflare.com",
      "ns-cloud-a1.googledomains.com",
      "ns-1234.awsdns-26.org",
      "ns1.digitalocean.com",
      "dns1.p09.nsone.net",
      "ns1-01.azure-dns.cn",
      "ns1-01.azure-dns.us",
      "ns1-01.azure-dns.com.",
      "ns1-01.azure-dns.com.example.net",
      "xns1-01.azure-dns.com",
      "ns5-01.azure-dns.com",
    ]) {
      expect({ server, ok: AZURE_DNS.nameServers.test(server) }).toEqual({ server, ok: false });
    }
  });

  test("a zone whose name servers are Azure's is detected as Azure DNS", async () => {
    const lookup = async (name: string) => (name === "test-zone.invalid" ? ["NS1-39.azure-dns.com.", "ns2-39.azure-dns.net.", "ns3-39.azure-dns.org.", "ns4-39.azure-dns.info."] : []);
    expect((await detectDns("apps.test-zone.invalid", [CLOUDFLARE, AZURE_DNS], lookup)).entry).toBe(AZURE_DNS);
    const elsewhere = async () => ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
    expect((await detectDns("test-zone.invalid", [CLOUDFLARE, AZURE_DNS], elsewhere)).entry).toBe(CLOUDFLARE);
  });

  test("its page of the docs exists", () => {
    expect(AZURE_DNS.docs).toBe("docs/dns/azure-dns.md");
    expect(existsSync(join(ROOT, AZURE_DNS.docs))).toBe(true);
  });

  test("the addresses are Azure's by default; another only over https, or http on the loopback", () => {
    const credentials = credentialsOf(fake.environment);
    expect(() => AZURE_DNS.open({ credentials, environment: {}, fetcher: fetch, clock: fakeClock(), secret: () => {} })).not.toThrow();
    for (const variable of [API_VARIABLE, LOGIN_VARIABLE]) {
      for (const wrong of ["http://management.test-zone.invalid", "https://user:secret@management.test-zone.invalid", "https://management.test-zone.invalid/?x=1", "not an address"]) {
        expect(() => AZURE_DNS.open({ credentials, environment: { [variable]: wrong }, fetcher: fetch, clock: fakeClock(), secret: () => {} })).toThrow(ProviderError);
      }
    }
  });
});

// --- the records ---------------------------------------------------------------------------------

describe("the records", () => {
  test("a fresh zone gets its four records, TTL 300, each set created only if it is still absent", async () => {
    const outcome = await ensureZoneRecords(open(), fake.zone, addresses, false);
    expect(outcome.zone).toBe(fake.zone);
    expect(outcome.actions.map((action) => action.kind)).toEqual(["create", "create", "create", "create"]);
    expect(zoneLines()).toEqual([`*.${fake.zone} A ${IPV4}`, `*.${fake.zone} AAAA ${IPV6}`, `${fake.zone} A ${IPV4}`, `${fake.zone} AAAA ${IPV6}`].sort());
    expect(writes().sort()).toEqual(["PUT /A/*", "PUT /A/@", "PUT /AAAA/*", "PUT /AAAA/@"]);
    for (const request of fake.requests.filter((entry) => entry.method === "PUT")) {
      expect(request.headers["if-none-match"]).toBe("*");
      expect(request.search).toBe("?api-version=2018-05-01");
      expect((request.body as { properties: { TTL: number } }).properties.TTL).toBe(TTL);
    }
    expect(fake.set("A", fake.zone)!.values).toEqual({ ARecords: [{ ipv4Address: IPV4 }] });
    expect(fake.set("AAAA", `*.${fake.zone}`)!.values).toEqual({ AAAARecords: [{ ipv6Address: IPV6 }] });
    // One exchange for the whole run, handed to `secret` before it was used.
    expect(fake.issued.length).toBe(1);
    expect(scrubbed.has(fake.issued[0]!)).toBe(true);
  });

  test("without IPv6, two records", async () => {
    const outcome = await ensureZoneRecords(open(), fake.zone, { ipv4: IPV4, ipv6: null }, false);
    expect(outcome.actions.map((action) => action.kind)).toEqual(["create", "create"]);
    expect(zoneLines()).toEqual([`*.${fake.zone} A ${IPV4}`, `${fake.zone} A ${IPV4}`]);
  });

  test("a second run writes nothing", async () => {
    await ensureZoneRecords(open(), fake.zone, addresses, false);
    fake.requests.length = 0;
    const again = await ensureZoneRecords(open(), fake.zone, addresses, false);
    expect(again.actions.map((action) => action.kind)).toEqual(["keep", "keep", "keep", "keep"]);
    expect(writes()).toEqual([]);
  });

  test("a run reads the zone afresh, whatever the same API read before", async () => {
    const api = open();
    expect((await zoneRecords(api, fake.zone)).records.filter((record) => record.type === "A")).toEqual([]);
    fake.addRecord({ name: fake.zone, type: "A", content: OTHER });
    const error = await refusal(ensureZoneRecords(api, fake.zone, addresses, false));
    expect(error.kind).toBe("conflict");
    expect(writes()).toEqual([]);
  });

  test("the same address spelled otherwise is the same record", async () => {
    fake.addRecord({ name: fake.zone, type: "AAAA", content: "2001:DB8:0::10" });
    const outcome = await ensureZoneRecords(open(), fake.zone, addresses, false);
    expect(outcome.actions.filter((action) => action.kind === "keep").length).toBe(1);
    expect(writes().sort()).toEqual(["PUT /A/*", "PUT /A/@", "PUT /AAAA/*"]);
  });

  test("records that point elsewhere are a conflict, and nothing is written", async () => {
    fake.addRecord({ name: fake.zone, type: "A", content: OTHER });
    fake.addRecord({ name: `*.${fake.zone}`, type: "CNAME", content: "elsewhere.test-zone.invalid" });
    fake.addRecord({ name: fake.zone, type: "MX", content: "10 mail.test-zone.invalid" });
    fake.addAlias({ name: fake.zone, type: "AAAA", target: `/subscriptions/${SUBSCRIPTION}/resourceGroups/web/providers/Microsoft.Network/publicIPAddresses/web-ip` });
    const before = zoneLines();
    const error = await refusal(ensureZoneRecords(open(), fake.zone, addresses, false));
    expect(error.kind).toBe("conflict");
    expect(error.details.join("\n")).toContain(`${fake.zone} A ${OTHER}: points at ${OTHER}, not at the machine`);
    expect(error.details.join("\n")).toContain(`*.${fake.zone} CNAME elsewhere.test-zone.invalid: a CNAME`);
    expect(error.details.join("\n")).toContain(`${fake.zone} AAAA alias of Microsoft.Network/publicIPAddresses/web-ip`);
    expect(error.details.join("\n")).not.toContain("MX");
    expect(writes()).toEqual([]);
    expect(zoneLines()).toEqual(before);
    expect(fake.set("AAAA", fake.zone)!.target).not.toBeNull();
  });

  test("an AAAA record when the machine has no IPv6 is a conflict", async () => {
    fake.addRecord({ name: `*.${fake.zone}`, type: "AAAA", content: "2001:db8::99" });
    const error = await refusal(ensureZoneRecords(open(), fake.zone, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.details[0]).toContain("the machine has no IPv6");
    expect(writes()).toEqual([]);
  });

  test("replace updates and deletes what the plan says, and keeps everything else of the sets", async () => {
    fake.addRecord({ name: fake.zone, type: "A", content: OTHER });
    fake.addRecord({ name: fake.zone, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: fake.zone, type: "MX", content: "10 mail.test-zone.invalid" });
    fake.addRecord({ name: fake.zone, type: "TXT", content: "v=spf1 -all" });
    fake.addRecord({ name: `*.${fake.zone}`, type: "CNAME", content: "elsewhere.test-zone.invalid" });
    fake.addRecord({ name: `*.${fake.zone}`, type: "AAAA", content: IPV6 });
    fake.addRecord({ name: `*.${fake.zone}`, type: "AAAA", content: "2001:db8::99" });
    fake.set("A", fake.zone)!.metadata = { owner: "ops" };
    const outcome = await ensureZoneRecords(open(), fake.zone, addresses, true);
    expect(outcome.actions.map((action) => `${action.kind} ${"record" in action ? `${action.record.type} ${action.record.content}` : `${action.type} ${action.content}`}`).sort()).toEqual(
      [`delete A 198.51.100.8`, `update A ${OTHER}`, `delete CNAME elsewhere.test-zone.invalid`, `create A ${IPV4}`, `create AAAA ${IPV6}`, `keep AAAA ${IPV6}`, `delete AAAA 2001:db8::99`].sort(),
    );
    expect(zoneLines()).toEqual(
      [`${fake.zone} A ${IPV4}`, `${fake.zone} AAAA ${IPV6}`, `${fake.zone} MX 10 mail.test-zone.invalid`, `${fake.zone} TXT v=spf1 -all`, `*.${fake.zone} A ${IPV4}`, `*.${fake.zone} AAAA ${IPV6}`].sort(),
    );
    // The apex's A set was rewritten in place: its TTL and metadata are still the owner's.
    expect(fake.set("A", fake.zone)).toMatchObject({ ttl: 3600, metadata: { owner: "ops" } });
    // The CNAME went before the wildcard's A took its name.
    const order = writes();
    expect(order.indexOf("DELETE /CNAME/*")).toBeLessThan(order.indexOf("PUT /A/*"));
    expect(order).not.toContain("DELETE /A/@");
    for (const request of fake.requests.filter((entry) => (entry.method === "PUT" || entry.method === "DELETE") && entry.headers["if-none-match"] === undefined)) {
      expect(request.headers["if-match"]).toMatch(/^[0-9a-f]{8}-/);
    }
  });

  test("replace turns an alias record set into a plain one, and deletes an AAAA the machine cannot answer", async () => {
    fake.addAlias({ name: fake.zone, type: "A", target: `/subscriptions/${SUBSCRIPTION}/resourceGroups/web/providers/Microsoft.Network/frontDoors/edge` });
    fake.addRecord({ name: fake.zone, type: "AAAA", content: "2001:db8::99" });
    const outcome = await ensureZoneRecords(open(), fake.zone, { ipv4: IPV4, ipv6: null }, true);
    expect(outcome.actions.map((action) => action.kind).sort()).toEqual(["create", "delete", "update"]);
    expect(fake.set("A", fake.zone)).toMatchObject({ target: null, values: { ARecords: [{ ipv4Address: IPV4 }] } });
    expect(fake.set("AAAA", fake.zone)).toBeUndefined();
    expect(zoneLines()).toEqual([`*.${fake.zone} A ${IPV4}`, `${fake.zone} A ${IPV4}`]);
  });

  test("one value deleted or updated through the API leaves the set's other values", async () => {
    for (const content of [OTHER, "198.51.100.8", "198.51.100.9"]) fake.addRecord({ name: fake.zone, type: "A", content });
    const api = open();
    const zone = await api.findZone(fake.zone);
    const [first, second] = (await api.listRecords(zone, fake.zone)).filter((record) => record.type === "A");
    await api.deleteRecord(zone, first!);
    expect(fake.records().filter((record) => record.type === "A").map((record) => record.content)).toEqual(["198.51.100.8", "198.51.100.9"]);
    await api.updateRecord(zone, second!, IPV4);
    expect(fake.records().filter((record) => record.type === "A").map((record) => record.content)).toEqual([IPV4, "198.51.100.9"]);
    // A value already gone is no error, and writes nothing.
    fake.requests.length = 0;
    await api.deleteRecord(zone, first!);
    expect(writes()).toEqual([]);
  });

  test("a set written by somebody else between the read and the write is read again", async () => {
    fake.addRecord({ name: fake.zone, type: "A", content: OTHER });
    fake.settings.concurrentWrites = 1;
    await ensureZoneRecords(open(), fake.zone, addresses, true);
    expect(fake.set("A", fake.zone)!.values).toEqual({ ARecords: [{ ipv4Address: IPV4 }] });
    expect(fake.requests.filter((entry) => entry.method === "GET" && short(entry.path) === "/A/@").length).toBe(2);
    expect(fake.requests.filter((entry) => entry.method === "PUT" && short(entry.path) === "/A/@").length).toBe(2);
  });

  test("a set somebody keeps writing ends in a refusal, after three attempts", async () => {
    fake.addRecord({ name: fake.zone, type: "A", content: OTHER });
    fake.settings.concurrentWrites = 10;
    const error = await refusal(ensureZoneRecords(open(), fake.zone, addresses, true));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain(`the A record set of ${fake.zone} changed every time it was read`);
    expect(fake.requests.filter((entry) => entry.method === "PUT" && short(entry.path) === "/A/@").length).toBe(3);
  });
});

describe("the zone", () => {
  test("a zone held as a parent: the records go into it, relative to it", async () => {
    const outcome = await ensureZoneRecords(open(), `apps.${fake.zone}`, addresses, false);
    expect(outcome.zone).toBe(fake.zone);
    expect(zoneLines()).toEqual([`*.apps.${fake.zone} A ${IPV4}`, `*.apps.${fake.zone} AAAA ${IPV6}`, `apps.${fake.zone} A ${IPV4}`, `apps.${fake.zone} AAAA ${IPV6}`].sort());
    expect(writes().sort()).toEqual(["PUT /A/*.apps", "PUT /A/apps", "PUT /AAAA/*.apps", "PUT /AAAA/apps"]);
    // The role on the zone alone: Resource Manager refuses to say whether apps.<zone> exists.
    const zoneReads = fake.requests.filter((entry) => entry.method === "GET" && /\/dnsZones\/[^/]+$/i.test(entry.path)).map((entry) => decodeURIComponent(entry.path).split("/").pop());
    expect(zoneReads).toEqual([`apps.${fake.zone}`, fake.zone]);
  });

  test("with the role on the resource group, a missing child zone is a 404, and the parent is found all the same", async () => {
    fake.settings.scope = "group";
    const found = await zoneRecords(open(), `deep.apps.${fake.zone}`);
    expect(found.zone).toEqual({ id: fake.zone, name: fake.zone });
  });

  test("an unknown zone is kind zone, naming every name tried", async () => {
    const error = await refusal(zoneRecords(open(), "a.other-zone.invalid"));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe(`no Azure DNS zone the credentials can read holds a.other-zone.invalid, in the resource group ${GROUP}`);
    expect(error.details[0]).toBe("looked for: a.other-zone.invalid, other-zone.invalid");
    expect(error.details.join("\n")).toContain("AuthorizationFailed");
    expect(error.details.at(-1)).toContain("DNS Zone Contributor");
  });

  test("a resource group that is not the zone's is kind zone too", async () => {
    fake.settings.scope = "group";
    const error = await refusal(zoneRecords(open({ ...fake.environment, SITESOLIDE_DNS_AZURE_RESOURCE_GROUP: "elsewhere" }), fake.zone));
    expect(error.kind).toBe("zone");
    expect(error.details.join("\n")).toContain("ResourceGroupNotFound");
  });
});

describe("the credentials", () => {
  test("a wrong secret is kind token, said in Entra's words, and the secret is in no message", async () => {
    const error = await refusal(zoneRecords(open({ ...fake.environment, SITESOLIDE_DNS_AZURE_CLIENT_SECRET: "Wr0ng~secret.value_0123456789" }), fake.zone));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("AADSTS7000215");
    expect(error.details[0]).toContain("copy its Value, not its Secret ID");
    expect(`${error.message}${error.details.join("")}`).not.toContain("Wr0ng~secret");
    // Nothing reached Resource Manager.
    expect(fake.requests.every((entry) => entry.path.endsWith("/oauth2/v2.0/token"))).toBe(true);
  });

  test("an unknown client or tenant is kind token", async () => {
    const client = await refusal(zoneRecords(open({ ...fake.environment, SITESOLIDE_DNS_AZURE_CLIENT_ID: "11111111-2222-4333-8444-555555555555" }), fake.zone));
    expect(client.kind).toBe("token");
    expect(client.details[0]).toContain("SITESOLIDE_DNS_AZURE_CLIENT_ID");
    const tenant = await refusal(zoneRecords(open({ ...fake.environment, SITESOLIDE_DNS_AZURE_TENANT_ID: "contoso.onmicrosoft.com" }), fake.zone));
    expect(tenant.kind).toBe("token");
    expect(tenant.details[0]).toContain("SITESOLIDE_DNS_AZURE_TENANT_ID");
  });

  test("a token Resource Manager refuses is kind token", async () => {
    fake.fail("GET", /\/dnsZones\//i, 401, "InvalidAuthenticationTokenTenant", "The access token is from the wrong issuer. It must match the tenant associated with this subscription.");
    const error = await refusal(zoneRecords(open(), fake.zone));
    expect(error.kind).toBe("token");
    expect(error.details[0]).toContain("is not in the tenant");
  });

  test("the secret goes in the Basic header, or in the form when Entra refuses it there", async () => {
    await zoneRecords(open(), fake.zone);
    const basic = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(basic.length).toBe(1);
    expect(basic[0]!.path).toBe(`/${TENANT}/oauth2/v2.0/token`);
    expect(basic[0]!.headers.authorization).toBe(`Basic ${btoa(`${CLIENT}:${encodeURIComponent(CLIENT_SECRET)}`)}`);
    expect(String(basic[0]!.body)).not.toContain(CLIENT_SECRET);
    fake.reset();
    fake.settings.basicAccepted = false;
    await zoneRecords(open(), fake.zone);
    const tokens = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(tokens.length).toBe(2);
    expect(new URLSearchParams(String(tokens[1]!.body)).get("client_secret")).toBe(CLIENT_SECRET);
    expect(tokens[1]!.headers.authorization).toBeUndefined();
  });

  test("the token is exchanged again once it is about to expire", async () => {
    const clock = fakeClock();
    const api = open(fake.environment, { clock });
    await api.verify();
    await api.verify();
    expect(fake.issued.length).toBe(1);
    clock.advance(3599_000 - 300_000);
    await api.verify();
    expect(fake.issued.length).toBe(2);
  });
});

describe("the API", () => {
  test("a listing is read to its last page", async () => {
    for (let index = 0; index < 9; index++) fake.addRecord({ name: `host${index}.${fake.zone}`, type: "TXT", content: `value ${index}` });
    fake.addRecord({ name: `*.${fake.zone}`, type: "A", content: OTHER });
    const found = await zoneRecords(open(), fake.zone);
    expect(found.records.map((record) => `${record.name} ${record.type} ${record.content}`)).toContain(`*.${fake.zone} A ${OTHER}`);
    const pages = fake.requests.filter((entry) => entry.method === "GET" && entry.path.toLowerCase().endsWith("/recordsets"));
    // Two record sets a page: SOA, NS, nine TXT and the A make six pages, read once for both names.
    expect(pages.length).toBe(6);
    expect(pages.slice(1).every((entry) => entry.search.includes("%24skipToken=") || entry.search.includes("$skipToken="))).toBe(true);
    // The zone's own SOA and NS are records like any other, of no concern to the plan.
    expect(found.records.filter((record) => record.name === fake.zone).map((record) => record.type).sort()).toEqual(["NS", "NS", "NS", "NS", "SOA"]);
  });

  test("a nextLink at another host is not followed", async () => {
    fake.addRecord({ name: `www.${fake.zone}`, type: "A", content: OTHER });
    fake.settings.foreignNextLink = true;
    const error = await refusal(zoneRecords(open(), fake.zone));
    expect(error.kind).toBe("unreachable");
    expect(error.message).toContain("elsewhere.test-zone.invalid");
    expect(fake.requests.every((entry) => !entry.url.includes("elsewhere"))).toBe(true);
  });

  test("a 429 is waited out as Retry-After asks, on the clock", async () => {
    fake.fail("GET", /\/recordsets$/i, 429, "TooManyRequests", "The request is being throttled.", { headers: { "Retry-After": "7" } });
    const clock = fakeClock();
    await ensureZoneRecords(open(fake.environment, { clock }), fake.zone, addresses, false);
    expect(clock.sleeps).toEqual([7000]);
    expect(zoneLines().length).toBe(4);
  });

  test("a refusal of a write quotes Azure, and stops", async () => {
    fake.fail("PUT", /\/A\/@$/, 403, "AuthorizationFailed", `The client '${CLIENT}' does not have authorization to perform action 'Microsoft.Network/dnszones/A/write'.`);
    const error = await refusal(ensureZoneRecords(open(), fake.zone, addresses, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("may not write the A record set of test-zone.invalid (403 AuthorizationFailed)");
    expect(error.details[0]).toContain("DNS Zone Contributor");
  });

  test("no answer, or an answer that is not the API's, is kind unreachable", async () => {
    const down = await refusal(zoneRecords(open(fake.environment, { fetcher: async () => Promise.reject(new TypeError("connection refused")) }), fake.zone));
    expect(down.kind).toBe("unreachable");
    const html = async (input: string, init?: RequestInit) =>
      input.includes("/oauth2/") ? fetch(input, init) : new Response("<html>sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const other = await refusal(zoneRecords(open(fake.environment, { fetcher: html }), fake.zone));
    expect(other.kind).toBe("unreachable");
    expect(other.message).toContain("not Azure Resource Manager");
  });
});

describe("what is printed", () => {
  test("no refusal carries the secret or a token", () => {
    const text = printed.join("\n");
    expect(printed.length).toBeGreaterThan(20);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(encodeURIComponent(CLIENT_SECRET));
    expect(issued.size).toBeGreaterThan(5);
    for (const token of issued) {
      expect(text).not.toContain(token);
      expect(scrubbed.has(token)).toBe(true);
    }
  });
});
