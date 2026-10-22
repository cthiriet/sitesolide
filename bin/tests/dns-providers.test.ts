import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DnsError, ensureZoneRecords, type DnsEntry } from "../cli/dns/dns";
import { DNS_PROVIDERS } from "../cli/dns/registry";
import { tlsZoneContent } from "../cli/tls";
import type { FakeDns } from "./fake-dns";

/**
 * What setup asks of every DNS provider, against each one's local fake
 * (bin/tests/fake-dns-<name>.ts): the zone's four records made on a fresh
 * zone, a second run that writes nothing, a record pointing elsewhere refused
 * with nothing written, the credentials in no URL, and a Caddy directive that
 * names its credentials only through Caddy's environment. Each provider's own
 * tests, dns-<name>.test.ts, check the rest against its API. Cloudflare,
 * whose mock predates this contract, is covered by cli-cloudflare.test.ts and
 * cli-setup.test.ts.
 */

const MACHINE = { ipv4: "203.0.113.10", ipv6: "2001:db8::10" };

function clock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

/** The variables a directive reads from Caddy's environment. */
function placeholders(directive: readonly string[]): string[] {
  return [...directive.join("\n").matchAll(/\{env\.([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

for (const entry of DNS_PROVIDERS.filter((candidate) => candidate.name !== "cloudflare")) {
  describe(`--dns ${entry.name}`, () => {
    let fake: FakeDns;
    const secrets: string[] = [];

    beforeAll(async () => {
      fake = ((await import(`./fake-dns-${entry.name}`)) as { createFake: () => FakeDns }).createFake();
    });
    afterAll(() => fake.stop());
    beforeEach(() => fake.reset());

    function open(given: DnsEntry = entry) {
      const credentials = Object.fromEntries(given.credentials.map((field) => [field.variable, fake.environment[field.variable] ?? ""]).filter(([, value]) => value !== ""));
      return given.open({ credentials, environment: fake.environment, fetcher: fetch, clock: clock(), secret: (value) => secrets.push(value) });
    }

    const addresses = () =>
      fake
        .records()
        .filter((record) => record.type === "A" || record.type === "AAAA" || record.type === "CNAME")
        .map((record) => `${record.name} ${record.type} ${record.content}`)
        .sort();
    const writes = () => fake.requests.filter((request) => request.method !== "GET" && !/token|oauth2|auth\/time|ping|retrieve/i.test(request.path));

    test("its credentials are its own, never a cloud's broad ones, and say how to make them", () => {
      expect(entry.docs).toBe(`docs/dns/${entry.name}.md`);
      expect(entry.credentials.length).toBeGreaterThan(0);
      for (const field of entry.credentials) expect(field.variable).toStartWith("SITESOLIDE_DNS_");
      expect(entry.credentialHelp.length).toBeGreaterThan(0);
    });

    test("a fresh zone gets its four records; a second run writes nothing", async () => {
      const first = await ensureZoneRecords(open(), fake.zone, MACHINE, false);
      expect(first.zone).toBe(fake.zone);
      expect(addresses()).toEqual(
        [`${fake.zone} A ${MACHINE.ipv4}`, `${fake.zone} AAAA ${MACHINE.ipv6}`, `*.${fake.zone} A ${MACHINE.ipv4}`, `*.${fake.zone} AAAA ${MACHINE.ipv6}`].sort(),
      );
      const before = writes().length;
      const again = await ensureZoneRecords(open(), fake.zone, MACHINE, false);
      expect(again.actions.every((action) => action.kind === "keep")).toBe(true);
      expect(writes().length).toBe(before);
    });

    test("a record that points elsewhere is refused, and nothing is written; --dns-replace replaces it", async () => {
      fake.addRecord({ name: fake.zone, type: "A", content: "198.51.100.7" });
      const before = writes().length;
      const refused = await ensureZoneRecords(open(), fake.zone, MACHINE, false).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(DnsError);
      expect((refused as DnsError).kind).toBe("conflict");
      expect(writes().length).toBe(before);
      await ensureZoneRecords(open(), fake.zone, MACHINE, true);
      expect(addresses().filter((line) => line.startsWith(`${fake.zone} A `))).toEqual([`${fake.zone} A ${MACHINE.ipv4}`]);
    });

    test("no credential in any URL", async () => {
      await ensureZoneRecords(open(), fake.zone, MACHINE, false);
      for (const request of fake.requests) {
        for (const secret of [...fake.secrets, ...secrets]) expect(`${request.path}?${request.search}`).not.toContain(secret);
      }
    });

    test("Caddy reads every credential from its environment, and the file setup lays takes the directive", () => {
      const named = placeholders(entry.caddy.directive);
      expect(named.length).toBeGreaterThan(0);
      const credentials = Object.fromEntries(entry.credentials.map((field) => [field.variable, fake.environment[field.variable] ?? ""]));
      expect(Object.keys(entry.caddy.environment(credentials)).sort()).toEqual(named);
      const text = tlsZoneContent({ kind: "dns", title: entry.title, directive: entry.caddy.directive });
      for (const secret of fake.secrets) expect(text).not.toContain(secret);
      expect(entry.caddy.module).toStartWith("dns.providers.");
      expect(entry.caddy.package).toStartWith("github.com/");
    });

    test("its name server pattern is anchored: a look-alike host is not the provider's", () => {
      expect(entry.nameServers.test(`attacker.test-zone.invalid`)).toBe(false);
      expect(entry.nameServers.source.startsWith("^") || entry.nameServers.source.startsWith("\\.")).toBe(true);
      expect(entry.nameServers.source.endsWith("$")).toBe(true);
    });
  });
}
