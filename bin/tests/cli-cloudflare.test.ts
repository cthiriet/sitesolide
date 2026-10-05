import { afterEach, describe, expect, test } from "bun:test";
import {
  canonicalAddress,
  cloudflareBase,
  CloudflareError,
  DEFAULT_CLOUDFLARE_API,
  desiredRecords,
  ensureRecords,
  manualRecords,
  planRecords,
  scrub,
  zoneCandidates,
  type DnsRecord,
} from "../cli/cloudflare";
import { startCloudflareMock, type CloudflareMock } from "./cloudflare-mock";

/**
 * The DNS records setup makes, against a mock of Cloudflare's API on the
 * loopback. Nothing here reaches api.cloudflare.com: the module is pointed at
 * the mock by its base URL, as SITESOLIDE_CLOUDFLARE_API does for the CLI.
 *
 * What must hold above all: nobody's record is overwritten without
 * --dns-replace, and the token travels in the Authorization header and
 * nowhere else.
 */

const TOKEN = "cf-test-token-0123456789abcdefABCDEF";
const ZONE = "test-zone.invalid";
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
let mock: CloudflareMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
});

function start(options: Partial<Parameters<typeof startCloudflareMock>[0]> = {}): CloudflareMock {
  mock = startCloudflareMock({ token: TOKEN, ...options });
  return mock;
}

const record = (name: string, type: string, content: string, proxied = false) => ({ name, type, content, proxied, ttl: 1 });

/** What the zone holds now, as lines, in a stable order. */
function zoneLines(m: CloudflareMock): string[] {
  return m.records.map((r) => `${r.name} ${r.type} ${r.content}${r.proxied ? " proxied" : ""}`).sort();
}

/** The token appears in the Authorization header of every request, and in nothing else. */
function tokenOnlyInHeaders(m: CloudflareMock, also: string[] = []): void {
  expect(m.requests.length).toBeGreaterThan(0);
  for (const request of m.requests) {
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.url).not.toContain(TOKEN);
    expect(request.body).not.toContain(TOKEN);
  }
  for (const text of also) expect(text).not.toContain(TOKEN);
}

async function failure(promise: Promise<unknown>): Promise<CloudflareError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudflareError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the base URL", () => {
  test("is Cloudflare's unless the environment names another, a mock", () => {
    expect(cloudflareBase({})).toBe(DEFAULT_CLOUDFLARE_API);
    expect(cloudflareBase({ SITESOLIDE_CLOUDFLARE_API: "http://127.0.0.1:9/client/v4/" })).toBe("http://127.0.0.1:9/client/v4");
  });
});

describe("making the records", () => {
  test("an empty zone: the four records, DNS only, TTL auto", async () => {
    const m = start();
    const result = await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(result.zone).toBe(ZONE);
    expect(zoneLines(m)).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    expect(m.records.every((r) => r.proxied === false && r.ttl === 1)).toBe(true);
    tokenOnlyInHeaders(m);
  });

  test("a machine without IPv6: two records, and no AAAA", async () => {
    const m = start();
    await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(zoneLines(m)).toEqual([`*.${ZONE} A ${IPV4}`, `${ZONE} A ${IPV4}`]);
  });

  test("records already equal: nothing is written, in any spelling of the address", async () => {
    const m = start({
      records: [record(ZONE, "A", IPV4), record(`*.${ZONE}`, "A", IPV4), record(ZONE, "AAAA", "2001:DB8:0:0::10"), record(`*.${ZONE}`, "AAAA", IPV6)],
    });
    const result = await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: IPV6 }, false);
    expect(m.writes()).toEqual([]);
    expect(result.actions.every((action) => action.kind === "keep")).toBe(true);
  });

  test("other records at those names, MX and TXT at the bare zone, are left alone", async () => {
    const m = start({ records: [record(ZONE, "MX", "mail.example.net"), record(ZONE, "TXT", "v=spf1 -all")] });
    await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(zoneLines(m)).toContain(`${ZONE} MX mail.example.net`);
    expect(zoneLines(m)).toContain(`${ZONE} TXT v=spf1 -all`);
    expect(m.writes().filter((request) => request.method !== "POST")).toEqual([]);
  });

  test("a zone that is a subdomain of a Cloudflare zone is found through its parent", async () => {
    const m = start({ zones: [{ id: "zone-parent", name: ZONE }] });
    const result = await ensureRecords({ base: m.base, token: TOKEN }, `sites.${ZONE}`, { ipv4: IPV4, ipv6: null }, false);
    expect(result.zone).toBe(ZONE);
    expect(zoneLines(m)).toEqual([`*.sites.${ZONE} A ${IPV4}`, `sites.${ZONE} A ${IPV4}`]);
    expect(zoneCandidates(`a.sites.${ZONE}`)).toEqual([`a.sites.${ZONE}`, `sites.${ZONE}`, ZONE]);
  });
});

describe("never someone else's record", () => {
  test("a record pointing elsewhere is refused, named, and nothing at all is written", async () => {
    const m = start({ records: [record(`*.${ZONE}`, "A", "198.51.100.7")] });
    const error = await failure(ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("conflict");
    expect(error.message).toBe("records that point elsewhere");
    expect(error.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    // Not even the bare zone's record, which nothing stood in the way of.
    expect(m.writes()).toEqual([]);
    expect(zoneLines(m)).toEqual([`*.${ZONE} A 198.51.100.7`]);
  });

  test("a CNAME, a proxied record, and an AAAA on a machine without IPv6 are refused too", async () => {
    const m = start({
      records: [record(`*.${ZONE}`, "CNAME", "elsewhere.example.net"), record(ZONE, "A", IPV4, true), record(ZONE, "AAAA", "2001:db8::99")],
    });
    const error = await failure(ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details.join("\n")).toContain("a CNAME, beside which an address record cannot exist");
    expect(error.details.join("\n")).toContain("proxied through Cloudflare");
    expect(error.details.join("\n")).toContain("the machine has no IPv6");
    expect(m.writes()).toEqual([]);
  });

  test("--dns-replace: the owner's decision, records updated or deleted until the zone says what it should", async () => {
    const m = start({
      records: [
        record(`*.${ZONE}`, "CNAME", "elsewhere.example.net"),
        record(ZONE, "A", "198.51.100.7"),
        record(ZONE, "A", "198.51.100.8"),
        record(ZONE, "AAAA", IPV6, true),
      ],
    });
    await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: IPV6 }, true);
    expect(zoneLines(m)).toEqual([`*.${ZONE} A ${IPV4}`, `*.${ZONE} AAAA ${IPV6}`, `${ZONE} A ${IPV4}`, `${ZONE} AAAA ${IPV6}`]);
    // The CNAME went first, before an address record took its name.
    const methods = m.writes().map((request) => request.method);
    expect(methods.indexOf("DELETE")).toBeLessThan(methods.indexOf("POST"));
    tokenOnlyInHeaders(m);
  });
});

describe("what the API refuses", () => {
  test("a bad token is refused before any record is read, and the message carries no token", async () => {
    const m = start();
    const error = await failure(ensureRecords({ base: m.base, token: "cf-wrong-token-000000000000" }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("token");
    expect(error.message).toBe("the Cloudflare token is not valid");
    expect(m.requests.some((request) => request.url.includes("dns_records"))).toBe(false);
    expect([error.message, ...error.details].join("\n")).not.toContain("cf-wrong-token");
  });

  test("a token Cloudflare cannot verify as a user's, but that reads the zone, is used all the same", async () => {
    const m = start({ verify: "refused" });
    await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(zoneLines(m)).toHaveLength(2);
  });

  test("a zone the token cannot see is named, with the names looked for", async () => {
    const m = start({ zones: [{ id: "zone-other", name: "other-zone.invalid" }] });
    const error = await failure(ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("zone");
    expect(error.message).toBe(`no Cloudflare zone the token can read holds ${ZONE}`);
    expect(error.details[0]).toBe(`looked for: ${ZONE}`);
  });

  test("a token without DNS / Edit: the write is refused with Cloudflare's own words", async () => {
    const m = start({ readOnly: true });
    const error = await failure(ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.message).toContain("Cloudflare refused POST");
    expect(error.message).toContain("Authentication error");
    expect(error.message).not.toContain(TOKEN);
  });

  test("nothing listening: unreachable, and the token is not in the message", async () => {
    const error = await failure(ensureRecords({ base: "http://127.0.0.1:9/client/v4", token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.kind).toBe("unreachable");
    expect(error.message).not.toContain(TOKEN);
  });

  test("a text from outside that would carry the token is scrubbed", () => {
    expect(scrub(`bad request for ${TOKEN}`, TOKEN)).toBe("bad request for [token]");
  });
});

describe("pagination", () => {
  test("every page of the records is read: a conflict on the last page is still found", async () => {
    const m = start({
      pageSize: 1,
      records: [record(`*.${ZONE}`, "TXT", "one"), record(`*.${ZONE}`, "TXT", "two"), record(`*.${ZONE}`, "A", "198.51.100.7")],
    });
    const error = await failure(ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false));
    expect(error.details[0]).toContain("198.51.100.7");
    const pages = m.requests.filter((request) => request.url.includes("dns_records") && request.url.includes(encodeURIComponent(`*.${ZONE}`)));
    expect(pages.map((request) => new URL(request.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  test("every page of the zones is read: the match on the third page is found", async () => {
    const m = start({
      pageSize: 1,
      listAllZones: true,
      zones: [
        { id: "zone-a", name: "a-zone.invalid" },
        { id: "zone-b", name: "b-zone.invalid" },
        { id: "zone-1", name: ZONE },
      ],
    });
    await ensureRecords({ base: m.base, token: TOKEN }, ZONE, { ipv4: IPV4, ipv6: null }, false);
    expect(m.records).toHaveLength(2);
    expect(m.writes().every((request) => request.url.includes("/zones/zone-1/"))).toBe(true);
  });
});

describe("the plan, decided before anything is written", () => {
  const existing = (records: ReturnType<typeof record>[]): DnsRecord[] => records.map((r, i) => ({ ...r, id: `r${i}` }));

  test("equal is kept, absent is created, elsewhere is a conflict", () => {
    const plan = planRecords(existing([record(ZONE, "A", IPV4), record(`*.${ZONE}`, "A", "198.51.100.7")]), desiredRecords(ZONE, IPV4, null), false);
    expect(plan.map((action) => action.kind)).toEqual(["keep", "conflict"]);
  });

  test("an address has one spelling", () => {
    expect(canonicalAddress("2001:DB8:0:0:0:0:0:10")).toBe("2001:db8::10");
    expect(canonicalAddress(IPV4)).toBe(IPV4);
  });

  test("--skip-dns lists the records to make by hand", () => {
    expect(manualRecords(ZONE, IPV4, IPV6)).toEqual([
      `${ZONE}    A     ${IPV4}   DNS only, TTL auto`,
      `${ZONE}    AAAA  ${IPV6}   DNS only, TTL auto`,
      `*.${ZONE}  A     ${IPV4}   DNS only, TTL auto`,
      `*.${ZONE}  AAAA  ${IPV6}   DNS only, TTL auto`,
    ]);
  });
});
