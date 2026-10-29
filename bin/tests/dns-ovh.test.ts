import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsContext, type ZoneApi } from "../cli/dns/dns";
import {
  accessRules,
  API_VARIABLE,
  APPLICATION_KEY_VARIABLE,
  APPLICATION_SECRET_VARIABLE,
  CONSUMER_KEY_VARIABLE,
  ENDPOINT_SHAPE,
  ENDPOINT_VARIABLE,
  ENDPOINTS,
  KEY_SHAPE,
  OVH_DNS,
  signature,
  tokenPage,
  TTL,
} from "../cli/dns/ovh";
import { ProviderError, realClock } from "../../clouds/src/provider";
import { tlsZoneContent } from "../cli/tls";
import { createFakeOvhDns, FAKE_APPLICATION_KEY, FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY, SKEW, ZONE, type FakeOvhDns } from "./fake-dns-ovh";

/**
 * bin/cli/dns/ovh.ts, through OVH_DNS.open and setup's record engine
 * (ensureZoneRecords in bin/cli/dns/dns.ts), against the local fake of the
 * OVHcloud API (fake-dns-ovh.ts), which checks every signature and enforces
 * the consumer key's access rules: eu.api.ovh.com is never called.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, a change touches the one record it names, the seven narrow
 * rules are enough, and the secrets travel in a header or a signature and
 * nowhere else.
 */

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

const fake: FakeOvhDns = createFakeOvhDns();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** Every message a test saw, read by the last test for the secrets. */
const said: string[] = [];

const CREDENTIALS = {
  [ENDPOINT_VARIABLE]: "ovh-eu",
  [APPLICATION_KEY_VARIABLE]: FAKE_APPLICATION_KEY,
  [APPLICATION_SECRET_VARIABLE]: FAKE_APPLICATION_SECRET,
  [CONSUMER_KEY_VARIABLE]: FAKE_CONSUMER_KEY,
};

function context(overrides: Partial<DnsContext> = {}): DnsContext {
  return {
    credentials: CREDENTIALS,
    environment: fake.environment,
    fetcher: (input, init) => fetch(input, init),
    clock: realClock,
    secret: () => {},
    ...overrides,
  };
}

const open = (overrides: Partial<DnsContext> = {}): ZoneApi => OVH_DNS.open(context(overrides));

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

describe("the records setup makes", () => {
  test("a fresh zone gets its four records, TTL 60, each served at once, and a second run writes nothing", async () => {
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    // Named as the API names them: empty for the zone itself, `*` for its wildcard.
    expect(fake.writes().filter((request) => request.path.endsWith("/record")).map((request) => request.body)).toEqual([
      { fieldType: "A", subDomain: "", target: IPV4, ttl: TTL },
      { fieldType: "AAAA", subDomain: "", target: IPV6, ttl: TTL },
      { fieldType: "A", subDomain: "*", target: IPV4, ttl: TTL },
      { fieldType: "AAAA", subDomain: "*", target: IPV6, ttl: TTL },
    ]);
    expect(fake.refreshed()).toBe(4);
    expect(fake.writes().map((request) => request.path.split("/").at(-1))).toEqual(["record", "refresh", "record", "refresh", "record", "refresh", "record", "refresh"]);

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

  test("a filter that filters nothing still yields the records of that name alone", async () => {
    fake.settings.filterSubDomain = false;
    fake.addRecord({ name: `www.${ZONE}`, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    const { records } = await zoneRecords(open(), ZONE);
    expect(records.map((record) => `${record.name} ${record.type}`).sort()).toEqual([`${ZONE} MX`, `${ZONE} NS`, `${ZONE} NS`]);
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(lines()).toContain(`www.${ZONE} A 198.51.100.7`);
    expect(lines()).toContain(`${ZONE} MX 10 mail.example.net.`);
  });

  test("a zone held as a subdomain of an OVHcloud zone is found through its parent, with the zone's rules alone", async () => {
    const result = await ensureZoneRecords(open(), `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(lines()).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    // The name itself is no zone the rules reach: NOT_GRANTED_CALL, and the next name.
    expect(fake.requests.filter((request) => request.path.endsWith("/soa")).map((request) => request.path)).toEqual([`/domain/zone/sites.${ZONE}/soa`, `/domain/zone/${ZONE}/soa`]);
    expect(fake.writes().filter((request) => request.path.endsWith("/record")).map((request) => (request.body as { subDomain: string }).subDomain)).toEqual(["sites", "*.sites"]);
  });

  test("the API's clock is read once, and every signed request is on it", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(fake.requests.filter((request) => request.path === "/auth/time")).toHaveLength(1);
    const local = Math.floor(Date.now() / 1000);
    for (const request of fake.requests.filter((candidate) => candidate.path !== "/auth/time")) {
      expect(Math.abs(Number(request.headers["x-ovh-timestamp"]) - (local + SKEW))).toBeLessThan(10);
    }
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

  test("replace: exactly what the plan says, by id, the CNAME deleted first and every other record kept", async () => {
    fake.addRecord({ name: `*.${ZONE}`, type: "CNAME", content: "elsewhere.example.net." });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" }, 600);
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.8" });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"keep me"' });
    const [cname, seven, eight] = fake.stored().slice(-4).map((record) => record.id);
    const result = await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(result.actions.map((action) => action.kind).sort()).toEqual(["create", "create", "create", "delete", "delete", "update"]);
    expect(lines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`, `${ZONE} TXT "keep me"`]);
    const changes = fake.writes().filter((request) => !request.path.endsWith("/refresh"));
    expect(changes.slice(0, 3).map((request) => `${request.method} ${request.path} ${JSON.stringify(request.body)}`)).toEqual([
      `DELETE /domain/zone/${ZONE}/record/${cname} null`,
      `DELETE /domain/zone/${ZONE}/record/${eight} null`,
      `PUT /domain/zone/${ZONE}/record/${seven} {"target":"${IPV4}"}`,
    ]);
    // The record changed keeps its TTL.
    expect(fake.stored().find((record) => record.id === seven)?.ttl).toBe(600);
  });
});

describe("what the API refuses", () => {
  test("an application key OVHcloud does not know: kind token, before any record is read", async () => {
    const wrong = "Aa1Bb2Cc3Dd4Ee5F";
    const error = await refusal(ensureZoneRecords(open({ credentials: { ...CREDENTIALS, [APPLICATION_KEY_VARIABLE]: wrong } }), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("OVHcloud refused the credentials (403 INVALID_KEY): Invalid application key");
    expect(fake.requests.map((request) => request.path)).toEqual(["/auth/time", "/auth/currentCredential"]);
  });

  test("a consumer key OVHcloud does not know, or a secret that is not the key's: kind token", async () => {
    const consumer = await refusal(open({ credentials: { ...CREDENTIALS, [CONSUMER_KEY_VARIABLE]: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk" } }).verify());
    expect(consumer.kind).toBe("token");
    expect(consumer.message).toBe("OVHcloud refused the credentials (403 INVALID_CREDENTIAL): This credential is not valid");
    expect(consumer.message + consumer.details.join("\n")).not.toContain("Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk");
    const secret = await refusal(open({ credentials: { ...CREDENTIALS, [APPLICATION_SECRET_VARIABLE]: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk" } }).verify());
    expect(secret.kind).toBe("token");
    expect(secret.message).toBe("OVHcloud refused the credentials (400 INVALID_SIGNATURE): Invalid signature");
    expect(secret.details[0]).toBe("the application secret is not the application key's");
  });

  test("a consumer key whose rules grant reading its own state says it, and one not validated is refused", async () => {
    fake.settings.rules = [...accessRules(ZONE), { method: "GET", path: "/auth/currentCredential" }];
    await open().verify();
    fake.settings.status = "pendingValidation";
    const error = await refusal(open().verify());
    expect(error.kind).toBe("token");
    expect(error.message).toBe("the OVHcloud consumer key is pendingValidation, not validated");
  });

  test("a consumer key that may read the zone and not write it: kind token, naming the rules", async () => {
    fake.settings.rules = accessRules(ZONE).filter((rule) => rule.method === "GET");
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe(`the OVHcloud consumer key may not POST /domain/zone/${ZONE}/record (403 NOT_GRANTED_CALL): This call has not been granted`);
    expect(error.details.join("\n")).toContain("POST /domain/zone/<zone>/refresh");
  });

  test("a zone the rules do not reach, or the account does not hold: kind zone, with the names looked for", async () => {
    const error = await refusal(ensureZoneRecords(open(), "sites.missing-zone.invalid", { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe("no OVHcloud zone the consumer key can read holds sites.missing-zone.invalid");
    expect(error.details[0]).toBe("looked for: sites.missing-zone.invalid, missing-zone.invalid");
    fake.settings.rules = [{ method: "GET", path: "/domain/zone/*" }];
    const missing = await refusal(open().findZone("missing-zone.invalid"));
    expect(missing.kind).toBe("zone");
  });

  test("the API's own words for a request it refuses", async () => {
    fake.fail("POST", /\/record$/, 400, { class: "Client::BadRequest", message: "Invalid subDomain" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(`OVHcloud refused POST /domain/zone/${ZONE}/record (400): Invalid subDomain`);
  });

  test("nothing listening: unreachable", async () => {
    const error = await refusal(open({ environment: { [API_VARIABLE]: "http://127.0.0.1:9/1.0" } }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("an answer that is not the API's: unreachable", async () => {
    const html = async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    const error = await refusal(open({ fetcher: html }).verify());
    expect(error.kind).toBe("unreachable");
  });

  test("the address: the region's, or a fake's on the loopback, never http elsewhere", () => {
    expect(ENDPOINTS).toEqual({ "ovh-eu": "https://eu.api.ovh.com/1.0", "ovh-ca": "https://ca.api.ovh.com/1.0", "ovh-us": "https://api.us.ovhcloud.com/1.0" });
    expect(() => open({ environment: { [API_VARIABLE]: "http://api.test-zone.invalid/1.0" } })).toThrow(ProviderError);
    expect(() => open({ credentials: { ...CREDENTIALS, [ENDPOINT_VARIABLE]: "kimsufi-eu" } })).toThrow(DnsError);
  });
});

describe("every record of a name is read", () => {
  test("the API pages nothing: each id it lists is read, and a conflict among many is found", async () => {
    for (let i = 0; i < 5; i++) fake.addRecord({ name: `*.${ZONE}`, type: "TXT", content: `"${i}"` });
    fake.addRecord({ name: `*.${ZONE}`, type: "A", content: "198.51.100.7" });
    const error = await refusal(ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details[0]).toContain("198.51.100.7");
    const reads = fake.requests.filter((request) => /\/record\/\d+$/.test(request.path));
    // Two NS at the zone itself, six records at its wildcard.
    expect(reads).toHaveLength(8);
  });
});

describe("the credentials", () => {
  test("travel in their headers and the signature, and nowhere else", async () => {
    await ensureZoneRecords(open(), ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    for (const request of fake.requests) {
      expect(request.headers["x-ovh-application"]).toBe(FAKE_APPLICATION_KEY);
      const others = Object.entries(request.headers).filter(([name]) => name !== "x-ovh-application" && name !== "x-ovh-consumer");
      for (const secret of [FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY, FAKE_APPLICATION_KEY]) {
        expect(request.url).not.toContain(secret);
        expect(JSON.stringify(request.body ?? "")).not.toContain(secret);
        expect(others.some(([, value]) => value.includes(secret))).toBe(false);
      }
      if (request.path !== "/auth/time") expect(request.headers["x-ovh-consumer"]).toBe(FAKE_CONSUMER_KEY);
    }
  });

  test("the signature is OVHcloud's: $1$ and the SHA-1 of the secret, the key, the method, the address, the body and the time", () => {
    const hash = new Bun.CryptoHasher("sha1").update("AS+CK+GET+https://eu.api.ovh.com/1.0/auth/currentCredential++1792615720").digest("hex");
    expect(signature("AS", "CK", "GET", "https://eu.api.ovh.com/1.0/auth/currentCredential", "", 1792615720)).toBe(`$1$${hash}`);
  });

  test("a text from outside that would carry them is scrubbed", async () => {
    fake.fail("POST", /\/record$/, 400, { message: `bad ${FAKE_APPLICATION_SECRET} and ${FAKE_CONSUMER_KEY}` });
    const error = await refusal(open().createRecord({ id: ZONE, name: ZONE }, { name: ZONE, type: "A", content: IPV4 }));
    expect(error.message).toContain("bad [application secret] and [consumer key]");
  });

  test("their shapes: a region, then letters and digits, one line", () => {
    expect(ENDPOINT_SHAPE.test("ovh-eu")).toBe(true);
    expect(ENDPOINT_SHAPE.test("https://eu.api.ovh.com/1.0")).toBe(false);
    for (const value of [FAKE_APPLICATION_KEY, FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY]) {
      expect(KEY_SHAPE.test(value)).toBe(true);
      expect(KEY_SHAPE.test(`${value}\nOTHER=1`)).toBe(false);
    }
    expect(OVH_DNS.credentials.map((field) => [field.variable, field.secret])).toEqual([
      ["SITESOLIDE_DNS_OVH_ENDPOINT", false],
      ["SITESOLIDE_DNS_OVH_APPLICATION_KEY", false],
      ["SITESOLIDE_DNS_OVH_APPLICATION_SECRET", true],
      ["SITESOLIDE_DNS_OVH_CONSUMER_KEY", true],
    ]);
  });

  test("appear in nothing any test of this file was told", () => {
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) {
      expect(line).not.toContain(FAKE_APPLICATION_SECRET);
      expect(line).not.toContain(FAKE_CONSUMER_KEY);
    }
  });
});

describe("the entry", () => {
  test("its page of the docs exists", async () => {
    expect(await Bun.file(new URL(`../../${OVH_DNS.docs}`, import.meta.url)).exists()).toBe(true);
  });

  test("its credentials are sitesolide's own variables, never OVH's", () => {
    expect(OVH_DNS.name).toBe("ovh");
    expect(OVH_DNS.credentials.every((field) => field.variable.startsWith("SITESOLIDE_DNS_OVH_"))).toBe(true);
    expect(OVH_DNS.apiVariable).toBe("SITESOLIDE_OVH_DNS_API");
    expect(OVH_DNS.docs).toBe("docs/dns/ovh.md");
  });

  test("the key page takes the seven rules of the zone in its address", () => {
    expect(tokenPage("ovh-eu", "test-zone.invalid")).toBe(
      "https://api.eu.ovhcloud.com/createToken/?GET=/domain/zone/test-zone.invalid/soa&GET=/domain/zone/test-zone.invalid/record&GET=/domain/zone/test-zone.invalid/record/*" +
        "&POST=/domain/zone/test-zone.invalid/record&PUT=/domain/zone/test-zone.invalid/record/*&DELETE=/domain/zone/test-zone.invalid/record/*&POST=/domain/zone/test-zone.invalid/refresh",
    );
  });

  test("the Caddy directive reads every credential from Caddy's environment, and the file holds exactly those", () => {
    const { caddy } = OVH_DNS;
    expect(caddy.package).toBe("github.com/caddy-dns/ovh");
    expect(caddy.module).toBe("dns.providers.ovh");
    const text = caddy.directive.join("\n");
    const placeholders = [...text.matchAll(/\{([^}\s]+)\}/g)].map((match) => match[1]!);
    expect(placeholders).toHaveLength(4);
    expect(placeholders.every((placeholder) => placeholder.startsWith("env."))).toBe(true);
    const environment = caddy.environment(CREDENTIALS);
    expect(Object.keys(environment).sort()).toEqual(placeholders.map((placeholder) => placeholder.slice(4)).sort());
    for (const secret of [FAKE_APPLICATION_SECRET, FAKE_CONSUMER_KEY]) expect(text).not.toContain(secret);
    expect(tlsZoneContent({ kind: "dns", title: OVH_DNS.title, directive: caddy.directive })).toContain(`\t\tconsumer_key {env.${CONSUMER_KEY_VARIABLE}}`);
  });

  test("its name servers are OVHcloud's, and nobody else's", async () => {
    for (const server of ["dns10.ovh.net", "ns10.ovh.net", "dns104.ovh.net", "ns104.ovh.net", "dns.ovh.net", "ns.ovh.net", "dns100.ovh.us", "ns100.ovh.us", "dns200.anycast.me", "ns200.anycast.me"]) {
      expect(OVH_DNS.nameServers.test(server)).toBe(true);
    }
    for (const server of ["ns1.dom.scw.cloud", "dns10.ovh.net.test-zone.invalid", "xdns10.ovh.net", "dns10.ovh.com", "mx1.ovh.net", "ada.ns.cloudflare.com"]) {
      expect(OVH_DNS.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["dns10.ovh.net.", "ns10.ovh.net."] : []);
    expect((await detectDns(`sites.${ZONE}`, [OVH_DNS], lookup)).entry).toBe(OVH_DNS);
  });
});
