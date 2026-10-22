import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, detectDns, ensureZoneRecords, zoneRecords, type DnsRecord, type ZoneApi } from "../cli/dns/dns";
import { ACCESS_KEY_VARIABLE, decodeName, DEFAULT_ROUTE53_API, ROUTE53, ROUTE53_API_VARIABLE, SECRET_KEY_VARIABLE } from "../cli/dns/route53";
import { ProviderError, type Fetch } from "../cli/providers/provider";
import { createFakeRoute53, FAKE_ACCESS_KEY, FAKE_SECRET_KEY } from "./fake-dns-route53";

/**
 * Amazon Route 53 behind the interface of bin/cli/dns/dns.ts, against a
 * local fake of its API that checks every signature (fake-dns-route53.ts).
 * Nothing here reaches route53.amazonaws.com.
 *
 * What must hold above all: nobody's record is overwritten without
 * `replace`, the other values of a set survive a change to one of them, and
 * the credentials travel in the signature and nowhere else.
 */

const ZONE = "test-zone.invalid";
const WILDCARD = `*.${ZONE}`;
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const BOTH = { ipv4: IPV4, ipv6: IPV6 };
const V4_ONLY = { ipv4: IPV4, ipv6: null };
const CREDENTIALS = { [ACCESS_KEY_VARIABLE]: FAKE_ACCESS_KEY, [SECRET_KEY_VARIABLE]: FAKE_SECRET_KEY };

const fake = createFakeRoute53();
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

type TestClock = { now: () => number; sleep: (milliseconds: number) => Promise<void>; sleeps: number[] };

function testClock(): TestClock {
  let now = Date.UTC(2026, 9, 21, 10, 0, 0);
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    sleeps,
  };
}

function open(options: { credentials?: Record<string, string>; fetcher?: Fetch; environment?: Record<string, string | undefined> } = {}): { api: ZoneApi; clock: TestClock } {
  const clock = testClock();
  const api = ROUTE53.open({
    credentials: options.credentials ?? CREDENTIALS,
    environment: options.environment ?? fake.environment,
    fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
    clock,
    secret: () => {},
  });
  return { api, clock };
}

async function failure(promise: Promise<unknown>): Promise<DnsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DnsError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The zone's address and alias records, and its CNAMEs, as lines: what setup is about. */
function addressLines(): string[] {
  return fake
    .records()
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .map((record) => `${record.name} ${record.type} ${record.content}`)
    .sort();
}

/** What a change batch asked, in order: `DELETE *.test-zone.invalid. CNAME`. */
function changes(): string[] {
  return fake.writes().flatMap((request) =>
    [...request.text.matchAll(/<Change><Action>(\w+)<\/Action><ResourceRecordSet><Name>([^<]+)<\/Name><Type>(\w+)<\/Type>/g)].map((match) => `${match[1]} ${match[2]} ${match[3]}`),
  );
}

describe("making the records", () => {
  test("a fresh zone gets its four records, TTL 300", async () => {
    const { api } = open();
    const { zone, actions } = await ensureZoneRecords(api, ZONE, BOTH, false);
    expect(zone).toBe(ZONE);
    expect(actions.map((action) => action.kind)).toEqual(["create", "create", "create", "create"]);
    expect(addressLines()).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`].sort());
    for (const [name, type] of [[ZONE, "A"], [WILDCARD, "AAAA"]] as const) {
      const [set] = fake.sets(name, type);
      expect(set?.ttl).toBe(300);
      expect(set?.identifier).toBeNull();
    }
    // One CREATE per record, at the documented address.
    expect(fake.writes().map((request) => `${request.method} ${request.path}`)).toEqual(Array(4).fill(`POST /2013-04-01/hostedzone/${fake.main().id}/rrset/`));
    expect(changes().every((line) => line.startsWith("CREATE "))).toBe(true);
  });

  test("without IPv6, two records", async () => {
    const { api } = open();
    await ensureZoneRecords(api, ZONE, V4_ONLY, false);
    expect(addressLines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("a second run writes nothing", async () => {
    await ensureZoneRecords(open().api, ZONE, BOTH, false);
    const written = fake.writes().length;
    const { actions } = await ensureZoneRecords(open().api, ZONE, BOTH, false);
    expect(actions.map((action) => action.kind)).toEqual(["keep", "keep", "keep", "keep"]);
    expect(fake.writes().length).toBe(written);
  });

  test("a record pointing elsewhere is a conflict, and nothing is written", async () => {
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const error = await failure(ensureZoneRecords(open().api, ZONE, BOTH, false));
    expect(error.kind).toBe("conflict");
    expect(error.details.join("\n")).toContain(`${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(fake.writes()).toEqual([]);
  });

  test("an alias at the wildcard is a conflict, said as an alias", async () => {
    fake.addSet({ name: WILDCARD, type: "A", alias: { hostedZoneId: "Z2FDTNDATAQYW2", dnsName: "d111111abcdef8.cloudfront.net.", evaluateTargetHealth: false } });
    const error = await failure(ensureZoneRecords(open().api, ZONE, BOTH, false));
    expect(error.kind).toBe("conflict");
    expect(error.details.join("\n")).toContain(`${WILDCARD} A alias d111111abcdef8.cloudfront.net`);
    expect(fake.writes()).toEqual([]);
  });

  test("a CNAME at the wildcard is a conflict", async () => {
    fake.addRecord({ name: WILDCARD, type: "CNAME", content: "elsewhere.example.net." });
    const error = await failure(ensureZoneRecords(open().api, ZONE, BOTH, false));
    expect(error.kind).toBe("conflict");
    expect(error.details.join("\n")).toContain(`${WILDCARD} CNAME elsewhere.example.net: a CNAME`);
    expect(fake.writes()).toEqual([]);
  });

  test("records of other types at those names are left alone", async () => {
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"v=spf1 -all"' });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    await ensureZoneRecords(open().api, ZONE, BOTH, true);
    expect(fake.sets(ZONE, "MX")[0]?.values).toEqual(["10 mail.example.net."]);
    expect(fake.sets(ZONE, "TXT")[0]?.values).toEqual(['"v=spf1 -all"']);
    expect(fake.sets(ZONE, "NS")[0]?.values.length).toBe(4);
  });
});

describe("replacing, on the owner's decision", () => {
  test("a set holding the machine's address and another keeps the machine's, and its TTL", async () => {
    fake.addSet({ name: ZONE, type: "A", ttl: 3600, values: ["198.51.100.7", IPV4] });
    const { actions } = await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(actions.filter((action) => action.kind === "delete").map((action) => (action.kind === "delete" ? action.record.content : ""))).toEqual(["198.51.100.7"]);
    expect(fake.sets(ZONE, "A")).toMatchObject([{ values: [IPV4], ttl: 3600 }]);
    // The set is deleted as it was and created again without the value, in one batch.
    expect(fake.writes()[0]!.text).toMatch(/<Action>DELETE<\/Action>.*<Action>CREATE<\/Action>/);
  });

  test("a set of two other addresses: one pointed at the machine, the other deleted", async () => {
    fake.addSet({ name: ZONE, type: "A", ttl: 3600, values: ["198.51.100.7", "198.51.100.8"] });
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(fake.sets(ZONE, "A")).toMatchObject([{ values: [IPV4], ttl: 300 }]);
    expect(addressLines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("a CNAME is deleted before the address takes its name", async () => {
    fake.addRecord({ name: WILDCARD, type: "CNAME", content: "elsewhere.example.net." });
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(addressLines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
    const order = changes();
    expect(order.indexOf(`DELETE \\052.${ZONE}. CNAME`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`DELETE \\052.${ZONE}. CNAME`)).toBeLessThan(order.indexOf(`CREATE *.${ZONE}. A`));
  });

  test("an alias is replaced by the machine's address", async () => {
    fake.addSet({ name: WILDCARD, type: "A", alias: { hostedZoneId: "Z2FDTNDATAQYW2", dnsName: "d111111abcdef8.cloudfront.net.", evaluateTargetHealth: false } });
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(fake.sets(WILDCARD, "A")).toMatchObject([{ alias: null, values: [IPV4], ttl: 300 }]);
  });

  test("an AAAA when the machine has no IPv6 is deleted, set and all", async () => {
    fake.addRecord({ name: ZONE, type: "AAAA", content: "2001:db8::99" });
    expect((await failure(ensureZoneRecords(open().api, ZONE, V4_ONLY, false))).kind).toBe("conflict");
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(fake.sets(ZONE, "AAAA")).toEqual([]);
  });

  test("weighted sets: the kept one is pointed at the machine, its routing kept, the other deleted", async () => {
    fake.addSet({ name: ZONE, type: "A", identifier: "blue", weight: 10, ttl: 60, values: ["198.51.100.7"], healthCheckId: "abcdef11-2222-3333-4444-555555fedcba" });
    fake.addSet({ name: ZONE, type: "A", identifier: "green", weight: 20, ttl: 60, values: ["198.51.100.8"] });
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(fake.sets(ZONE, "A")).toMatchObject([{ identifier: "blue", weight: 10, values: [IPV4], healthCheckId: "abcdef11-2222-3333-4444-555555fedcba" }]);
  });

  test("a set is written in the order the API requires, whatever order it was read in", async () => {
    fake.settings.responseOrder = "alphabetical";
    fake.addSet({ name: ZONE, type: "A", identifier: "blue", weight: 10, ttl: 60, values: ["198.51.100.7", "198.51.100.9"], healthCheckId: "abcdef11-2222-3333-4444-555555fedcba" });
    await ensureZoneRecords(open().api, ZONE, V4_ONLY, true);
    expect(fake.sets(ZONE, "A")).toMatchObject([{ identifier: "blue", values: [IPV4] }]);
  });

  test("one value deleted or updated, the others of its set kept", async () => {
    fake.addSet({ name: ZONE, type: "A", ttl: 600, values: ["198.51.100.1", "198.51.100.2", "198.51.100.3"] });
    const { api } = open();
    const zone = await api.findZone(ZONE);
    const byContent = async (content: string): Promise<DnsRecord> => (await api.listRecords(zone, ZONE)).find((record) => record.type === "A" && record.content === content)!;

    await api.deleteRecord(zone, await byContent("198.51.100.2"));
    expect(fake.sets(ZONE, "A")[0]!.values.sort()).toEqual(["198.51.100.1", "198.51.100.3"]);
    expect(fake.sets(ZONE, "A")[0]!.ttl).toBe(600);

    await api.updateRecord(zone, await byContent("198.51.100.1"), IPV4);
    expect(fake.sets(ZONE, "A")[0]!.values.sort()).toEqual(["198.51.100.3", IPV4].sort());

    await api.deleteRecord(zone, await byContent("198.51.100.3"));
    await api.deleteRecord(zone, await byContent(IPV4));
    expect(fake.sets(ZONE, "A")).toEqual([]);
  });

  test("a value gone since the zone was read: an update is refused, a deletion has nothing to do", async () => {
    fake.addSet({ name: ZONE, type: "A", values: ["198.51.100.1", "198.51.100.2"] });
    const { api } = open();
    const zone = await api.findZone(ZONE);
    const [first, second] = (await api.listRecords(zone, ZONE)).filter((record) => record.type === "A");
    fake.sets(ZONE, "A")[0]!.values = ["198.51.100.9"];

    const error = await failure(api.updateRecord(zone, first!, IPV4));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("changed since the zone was read");
    await api.deleteRecord(zone, second!);
    expect(fake.writes()).toEqual([]);
    expect(fake.sets(ZONE, "A")[0]!.values).toEqual(["198.51.100.9"]);
  });

  test("a set changed between the read and the write makes Route 53 refuse the batch, quoted", async () => {
    fake.fail("ChangeResourceRecordSets", 400, "InvalidChangeBatch", `Tried to delete resource record set [name='${ZONE}.', type='A'] but the values provided do not match the current values`, { batch: true });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    const error = await failure(ensureZoneRecords(open().api, ZONE, V4_ONLY, true));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("InvalidChangeBatch");
    expect(error.message).toContain("do not match the current values");
  });
});

describe("finding the zone", () => {
  test("a zone held as a parent: the records go in the parent", async () => {
    const { zone } = await ensureZoneRecords(open().api, `apps.${ZONE}`, V4_ONLY, false);
    expect(zone).toBe(ZONE);
    expect(addressLines()).toEqual([`*.apps.${ZONE} A ${IPV4}`, `apps.${ZONE} A ${IPV4}`]);
  });

  test("a hosted zone of its own is preferred to its parent", async () => {
    const own = fake.addZone({ name: `apps.${ZONE}` });
    const found = await open().api.findZone(`apps.${ZONE}`);
    expect(found).toEqual({ id: own.id, name: `apps.${ZONE}` });
  });

  test("a private hosted zone is never chosen", async () => {
    fake.addZone({ name: `apps.${ZONE}`, private: true });
    const found = await open().api.findZone(`apps.${ZONE}`);
    expect(found).toEqual({ id: fake.main().id, name: ZONE });
  });

  test("a private zone listed before the public one of its name is refused: Caddy's module would take it", async () => {
    fake.addZone({ name: "other-zone.invalid", private: true, id: "Z0AAAAPRIVATE" });
    fake.addZone({ name: "other-zone.invalid", id: "Z0BBBBPUBLIC" });
    const error = await failure(open().api.findZone("other-zone.invalid"));
    expect(error.kind).toBe("zone");
    expect(error.message).toContain("private");
  });

  test("the public zone is found on the next page, after a private one listed later", async () => {
    fake.settings.zonePageSize = 1;
    fake.addZone({ name: "other-zone.invalid", id: "Z0AAAAPUBLIC" });
    fake.addZone({ name: "other-zone.invalid", private: true, id: "Z0BBBBPRIVATE" });
    fake.addZone({ name: "zzz-zone.invalid" });
    const found = await open().api.findZone("other-zone.invalid");
    expect(found).toEqual({ id: "Z0AAAAPUBLIC", name: "other-zone.invalid" });
    const listings = fake.requests.filter((request) => request.action === "ListHostedZonesByName" && request.search.includes("dnsname"));
    expect(listings.length).toBeGreaterThanOrEqual(2);
    expect(listings[1]!.search).toContain("hostedzoneid=Z0BBBBPRIVATE");
  });

  test("two public zones of one name are refused", async () => {
    fake.addZone({ name: "other-zone.invalid" });
    fake.addZone({ name: "other-zone.invalid" });
    const error = await failure(open().api.findZone("other-zone.invalid"));
    expect(error.kind).toBe("zone");
    expect(error.message).toContain("more than one public");
  });

  test("an unknown zone: kind zone, naming the names tried", async () => {
    const error = await failure(ensureZoneRecords(open().api, "sites.unknown-zone.invalid", V4_ONLY, false));
    expect(error.kind).toBe("zone");
    expect(error.details).toContain("looked for: sites.unknown-zone.invalid, unknown-zone.invalid");
    expect(fake.writes()).toEqual([]);
  });

  test("a key whose policy names another hosted zone: kind zone, before any plan", async () => {
    fake.settings.readable = new Set(["Z0SOMEOTHERZONE"]);
    const error = await failure(ensureZoneRecords(open().api, ZONE, V4_ONLY, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toContain(`may not read the hosted zone ${ZONE}`);
    expect(error.message).toContain("AccessDenied");
  });
});

describe("the credentials", () => {
  test("an access key AWS does not know: kind token", async () => {
    const error = await failure(open({ credentials: { ...CREDENTIALS, [ACCESS_KEY_VARIABLE]: "AKIAUNKNOWNKEY000001" } }).api.verify());
    expect(error.kind).toBe("token");
    expect(error.message).toContain("InvalidClientTokenId");
  });

  test("a secret that does not go with the key: kind token", async () => {
    const error = await failure(ensureZoneRecords(open({ credentials: { ...CREDENTIALS, [SECRET_KEY_VARIABLE]: "anotherSecret0123456789abcdefghijklmnopq" } }).api, ZONE, V4_ONLY, false));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("SignatureDoesNotMatch");
    expect(fake.writes()).toEqual([]);
  });

  test("a policy without ListHostedZonesByName: kind token, on the first read", async () => {
    fake.settings.denied.add("ListHostedZonesByName");
    const error = await failure(zoneRecords(open().api, ZONE));
    expect(error.kind).toBe("token");
    expect(error.message).toContain("route53:ListHostedZonesByName");
  });

  test("a policy that may read the zone but not change it: refused at the write, AWS's words quoted", async () => {
    fake.settings.writable = new Set();
    const error = await failure(ensureZoneRecords(open().api, ZONE, V4_ONLY, false));
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("route53:ChangeResourceRecordSets");
  });

  test("the shapes: a long-term key, and nothing a line break could split", () => {
    const [access, secret] = ROUTE53.credentials;
    expect(access!.shape.test(FAKE_ACCESS_KEY)).toBe(true);
    expect(secret!.shape.test(FAKE_SECRET_KEY)).toBe(true);
    expect(access!.shape.test("ASIAFAKEROUTE53DNS01")).toBe(false);
    expect(access!.shape.test(`${FAKE_ACCESS_KEY}\nX=1`)).toBe(false);
    expect(secret!.shape.test(`${FAKE_SECRET_KEY}\nX=1`)).toBe(false);
    expect(secret!.shape.test(`${FAKE_SECRET_KEY} `)).toBe(false);
    expect(ROUTE53.credentials.every((field) => field.secret && field.variable.startsWith("SITESOLIDE_DNS_ROUTE53_"))).toBe(true);
  });

  test("no credential in a URL or a body, the secret in no header, the key ID in the signature alone", async () => {
    fake.addSet({ name: ZONE, type: "A", values: ["198.51.100.7", "198.51.100.8"] });
    fake.addRecord({ name: WILDCARD, type: "CNAME", content: "elsewhere.example.net." });
    await ensureZoneRecords(open().api, ZONE, BOTH, true);
    expect(fake.requests.length).toBeGreaterThan(5);
    for (const request of fake.requests) {
      for (const secret of fake.secrets) {
        expect(request.url).not.toContain(secret);
        expect(request.text).not.toContain(secret);
      }
      for (const [name, value] of Object.entries(request.headers)) {
        expect(value).not.toContain(FAKE_SECRET_KEY);
        if (name !== "authorization") expect(value).not.toContain(FAKE_ACCESS_KEY);
      }
      expect(request.headers.authorization).toStartWith(`AWS4-HMAC-SHA256 Credential=${FAKE_ACCESS_KEY}/`);
    }
  });

  test("a message from outside that carries a credential is scrubbed", async () => {
    fake.fail("ListHostedZonesByName", 400, "InvalidInput", `the key ${FAKE_ACCESS_KEY} with ${FAKE_SECRET_KEY} is odd`);
    const error = await failure(open().api.verify());
    const said = [error.message, ...error.details].join("\n");
    for (const secret of fake.secrets) expect(said).not.toContain(secret);
    expect(said).toContain("[access key ID]");
    expect(said).toContain("[secret access key]");
  });
});

describe("the calls", () => {
  test("every fetch refuses redirects and is bounded in time", async () => {
    const inits: RequestInit[] = [];
    const { api } = open({
      fetcher: (input, init) => {
        inits.push(init ?? {});
        return fetch(input, init);
      },
    });
    await ensureZoneRecords(api, ZONE, BOTH, false);
    expect(inits.length).toBeGreaterThan(0);
    for (const init of inits) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("Route 53's address unless the variable names another: https, or http on the loopback only", async () => {
    const urls: string[] = [];
    const { api } = open({
      environment: {},
      fetcher: async (input) => {
        urls.push(input);
        return new Response("<html>no</html>", { status: 503 });
      },
    });
    await failure(api.verify());
    expect(urls[0]).toBe(`${DEFAULT_ROUTE53_API}/2013-04-01/hostedzonesbyname?maxitems=1`);
    expect(() => open({ environment: { [ROUTE53_API_VARIABLE]: "http://route53.example.invalid" } })).toThrow(ProviderError);
  });

  test("no answer, or not the API's: kind unreachable", async () => {
    const down = await failure(open({ fetcher: async () => Promise.reject(new Error("connection refused")) }).api.verify());
    expect(down.kind).toBe("unreachable");
    const html = await failure(open({ fetcher: async () => new Response("<html><body>a portal</body></html>", { status: 200 }) }).api.verify());
    expect(html.kind).toBe("unreachable");
    const proxy = await failure(open({ fetcher: async () => new Response("Forbidden", { status: 403 }) }).api.verify());
    expect(proxy.kind).toBe("unreachable");
  });

  test("a change refused while the previous one is processed is tried again, the waits on the clock", async () => {
    fake.fail("ChangeResourceRecordSets", 400, "PriorRequestNotComplete", "The request was rejected because Route 53 was still processing a prior request.", { times: 2 });
    const { api, clock } = open();
    await ensureZoneRecords(api, ZONE, V4_ONLY, false);
    expect(addressLines()).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  test("throttled for good: refused after a minute, never more", async () => {
    fake.fail("ListHostedZonesByName", 400, "Throttling", "Rate exceeded", { times: 1000 });
    const { api, clock } = open();
    const error = await failure(api.verify());
    expect(error.kind).toBe("refused");
    expect(error.message).toContain("Rate exceeded");
    expect(error.details.join("\n")).toContain("kept answering Throttling");
    expect(clock.sleeps.reduce((sum, wait) => sum + wait, 0)).toBeLessThanOrEqual(60_000);
  });

  test("a failure on AWS's side is tried again on a read, never on a write", async () => {
    fake.fail("ListResourceRecordSets", 500, "InternalFailure", "An internal error occurred.", { times: 1 });
    fake.fail("ChangeResourceRecordSets", 500, "InternalFailure", "An internal error occurred.", { times: 1 });
    const error = await failure(ensureZoneRecords(open().api, ZONE, V4_ONLY, false));
    expect(error.kind).toBe("refused");
    expect(fake.writes().length).toBe(1);
  });
});

describe("listing", () => {
  test("every page of a name's records, every type, and only that name's", async () => {
    fake.settings.pageSize = 1;
    fake.addRecord({ name: ZONE, type: "MX", content: "10 mail.example.net." });
    fake.addRecord({ name: ZONE, type: "TXT", content: '"v=spf1 -all"' });
    fake.addRecord({ name: ZONE, type: "A", content: "198.51.100.7" });
    fake.addRecord({ name: `www.${ZONE}`, type: "A", content: "198.51.100.8" });
    const { api } = open();
    const records = await api.listRecords(await api.findZone(ZONE), ZONE);
    expect(records.map((record) => record.type).sort()).toEqual(["A", "MX", "NS", "NS", "NS", "NS", "SOA", "TXT"]);
    expect(records.every((record) => record.name === ZONE)).toBe(true);
    expect(fake.requests.filter((request) => request.action === "ListResourceRecordSets" && request.search.includes("name=")).length).toBeGreaterThanOrEqual(5);
  });

  test("the sets of one name and type across pages are followed by their identifier", async () => {
    fake.settings.pageSize = 1;
    fake.addSet({ name: WILDCARD, type: "A", identifier: "blue", weight: 10, values: ["198.51.100.7"] });
    fake.addSet({ name: WILDCARD, type: "A", identifier: "green", weight: 10, values: ["198.51.100.8"] });
    const { api } = open();
    const records = await api.listRecords(await api.findZone(ZONE), WILDCARD);
    expect(records.map((record) => record.content).sort()).toEqual(["198.51.100.7", "198.51.100.8"]);
    expect(fake.requests.some((request) => request.search.includes("identifier=green"))).toBe(true);
  });

  test("the wildcard, which Route 53 writes \\052, is *", async () => {
    fake.addRecord({ name: WILDCARD, type: "A", content: IPV4 });
    const { api } = open();
    const records = await api.listRecords(await api.findZone(ZONE), WILDCARD);
    expect(records).toMatchObject([{ name: WILDCARD, type: "A", content: IPV4, proxied: false }]);
    expect(decodeName("\\052.Test-Zone.invalid.")).toBe(WILDCARD);
  });
});

describe("Caddy and the name servers", () => {
  test("the directive reads every credential from Caddy's environment, and the environment holds exactly those", () => {
    const text = ROUTE53.caddy.directive.join("\n");
    const placeholders = [...text.matchAll(/\{env\.([A-Z0-9_]+)\}/g)].map((match) => match[1]!);
    expect(placeholders.sort()).toEqual([ACCESS_KEY_VARIABLE, SECRET_KEY_VARIABLE].sort());
    expect(text.replace(/\{env\.[A-Z0-9_]+\}/g, "")).not.toMatch(/[{}][^\n]*[{}]/);
    const environment = ROUTE53.caddy.environment(CREDENTIALS);
    expect(Object.keys(environment).sort()).toEqual(placeholders.sort());
    expect(environment).toEqual(CREDENTIALS);
    for (const secret of fake.secrets) expect(text).not.toContain(secret);
    expect(ROUTE53.caddy.directive[0]).toBe("dns route53 {");
    expect(ROUTE53.caddy.directive).toContain("\tregion us-east-1");
    expect(ROUTE53.caddy.package).toBe("github.com/caddy-dns/route53");
    expect(ROUTE53.caddy.module).toBe("dns.providers.route53");
  });

  test("the name servers of zones Route 53 serves, and no others", async () => {
    for (const server of ["ns-1372.awsdns-43.org", "ns-81.awsdns-10.com", "ns-659.awsdns-18.net", "ns-1984.awsdns-56.co.uk", "ns-0.awsdns-00.com"]) {
      expect(ROUTE53.nameServers.test(server)).toBe(true);
    }
    for (const server of ["ada.ns.cloudflare.com", "ns1.amzndns.net", "ns-81.awsdns-10.com.example.invalid", "xns-81.awsdns-10.com", "ns-81.awsdns-10.co", "ns1.digitalocean.com"]) {
      expect(ROUTE53.nameServers.test(server)).toBe(false);
    }
    const lookup = async (name: string) => (name === ZONE ? ["ns-1372.awsdns-43.org.", "ns-81.awsdns-10.Com."] : []);
    const found = await detectDns(`apps.${ZONE}`, [ROUTE53], lookup);
    expect(found.entry?.name).toBe("route53");
  });

  test("the entry: its name, its page, its variable", async () => {
    expect(ROUTE53.name).toBe("route53");
    expect(ROUTE53.apiVariable).toBe(ROUTE53_API_VARIABLE);
    expect(await Bun.file(`${import.meta.dir}/../../${ROUTE53.docs}`).exists()).toBe(true);
  });
});
