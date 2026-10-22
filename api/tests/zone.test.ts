import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_ZONE_NAMES_CAP, NEW_ZONE_NAMES_WINDOW_MS, TLS_ZONE_FILE, ZONE_NAMES_FILE } from "../src/config";
import { createTable } from "../src/domains";
import { createZone, onDemandPolicy, parseZoneNames, type ZoneOptions } from "../src/zone";
import { NOT_ON_DEMAND, readZoneNamesAnswer, ZONE_NAMES_COMMAND, zoneNamesScript } from "../src/zone-names";

/**
 * The zone's own names in the ask endpoint: refused as covered by the
 * wildcard while the zone's TLS policy is a DNS provider's, exactly as before
 * the policy moved to a file; with manual DNS, allowed for the zone, its www
 * and the sites deployed under it, and for nothing else.
 */

const ZONE = "test-zone.invalid";
const T0 = 1_000_000;

/** What `sitesolide setup` lays, as far as this service reads it: see bin/cli/tls.ts. */
const DNS_POLICY = "# The served zone's TLS policy.\ntls {\n\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n}\n";
const ON_DEMAND_POLICY = "# The served zone's TLS policy.\n# on_demand in a comment says nothing.\ntls {\n\ton_demand\n}\n";

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

/** The zone's two files in a folder of their own, null for a file left absent. */
function zoneFiles(policy: string | null, names: string | null): Required<Pick<ZoneOptions, "policyFile" | "namesFile">> {
  const dir = mkdtempSync(join(tmpdir(), "sitesolide-zone-"));
  temporary.push(dir);
  const files = { policyFile: join(dir, "tls-zone.caddy"), namesFile: join(dir, "zone-names") };
  if (policy !== null) writeFileSync(files.policyFile, policy);
  if (names !== null) writeFileSync(files.namesFile, names);
  return files;
}

/** A table whose customer domains are `table`, around a zone opened on these files. */
function tableWith(files: Required<Pick<ZoneOptions, "policyFile" | "namesFile">>, table = "\tsample-agency.example agency"): ReturnType<typeof createTable> {
  const dir = mkdtempSync(join(tmpdir(), "sitesolide-table-"));
  temporary.push(dir);
  const path = join(dir, "domaines.map");
  writeFileSync(path, table);
  return createTable(path, 10_000, createZone({ zone: ZONE, ...files }));
}

const NAMES = "# The sites deployed under the zone.\nkanban\nportal\ndashboard\n";

describe("the tests' own files", () => {
  test("the policy and the list the tables open by default are none of the workstation's", () => {
    // tests/setup.ts aims them at a folder that does not exist: an /etc/caddy
    // on the workstation must not decide what the domain table's tests see.
    expect([TLS_ZONE_FILE, ZONE_NAMES_FILE].every((path) => path.startsWith("/nonexistent/"))).toBe(true);
  });
});

describe("onDemandPolicy", () => {
  test("reads on_demand as Caddy does, a line of its own, and never in a comment", () => {
    expect(onDemandPolicy(ON_DEMAND_POLICY)).toBe(true);
    expect(onDemandPolicy("tls {\r\n  on_demand  \r\n}\r\n")).toBe(true);
    expect(onDemandPolicy(DNS_POLICY)).toBe(false);
    expect(onDemandPolicy("# on_demand\ntls {\n\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n}\n")).toBe(false);
    expect(onDemandPolicy("tls {\n\ton_demand_tls\n}\n")).toBe(false);
    expect(onDemandPolicy("")).toBe(false);
  });
});

describe("parseZoneNames", () => {
  test("keeps the labels, and ignores comments, blank lines and anything that is not one label", () => {
    const names = parseZoneNames(["# comment", "", "kanban", "  portal  ", "two.labels", "-dash", "dash-", "UPPER", "under_score", "a".repeat(64), "a".repeat(63)].join("\n"));
    expect([...names].sort()).toEqual(["a".repeat(63), "kanban", "portal"]);
  });
});

describe("the script that writes the list", () => {
  test("ends on one line its readers know, and nothing else is taken for an answer", () => {
    expect(readZoneNamesAnswer(`${NOT_ON_DEMAND}\n`)).toEqual({ onDemand: false });
    expect(readZoneNamesAnswer("zone-names: 3 site(s) under the zone\n")).toEqual({ onDemand: true, sites: 3 });
    expect(readZoneNamesAnswer("noise\nzone-names: 0 site(s) under the zone")).toEqual({ onDemand: true, sites: 0 });
    for (const output of ["", "zone-names: many site(s) under the zone", "sudo: a password is required"]) expect(readZoneNamesAnswer(output)).toBeNull();
  });

  test("names only plain paths, and travels inside single quotes untouched", () => {
    expect(() => zoneNamesScript({ sites: "/srv/sites'; rm -rf /" })).toThrow("unexpected path");
    expect(() => zoneNamesScript({ names: "relative/zone-names" })).toThrow("unexpected path");
    expect(ZONE_NAMES_COMMAND).toBe(`sudo sh -c '${zoneNamesScript()}'`);
    expect(zoneNamesScript()).not.toContain("'");
  });
});

describe("a zone certified through a DNS provider", () => {
  test("refuses every name of the zone as covered by the wildcard, listed or not", () => {
    // The answer of every release before the policy moved to a file, word for
    // word: the zone's blocks never ask, and a name that reaches the endpoint
    // must not get a second certificate.
    for (const files of [zoneFiles(DNS_POLICY, NAMES), zoneFiles(null, NAMES), zoneFiles(null, null)]) {
      const table = tableWith(files, `\t${ZONE} agency\n\tkanban.${ZONE} kanban`);
      for (const host of [ZONE, `www.${ZONE}`, `kanban.${ZONE}`, `random.${ZONE}`, `a.b.${ZONE}`]) {
        expect({ host, decision: table.decide(host, T0) }).toEqual({ host, decision: { allowed: false, reason: "covered by the wildcard" } });
      }
    }
  });

  test("leaves the customer domains to the table", () => {
    const table = tableWith(zoneFiles(DNS_POLICY, null));
    expect(table.decide("sample-agency.example", T0)).toEqual({ allowed: true, reason: "active client domain" });
    expect(table.decide("unknown.test", T0)).toEqual({ allowed: false, reason: "unknown domain" });
  });
});

describe("a zone certified on demand, with manual DNS", () => {
  test("allows the zone itself and its www, which the landing's block serves", () => {
    const table = tableWith(zoneFiles(ON_DEMAND_POLICY, null));
    expect(table.decide(ZONE, T0)).toEqual({ allowed: true, reason: "the zone itself" });
    expect(table.decide(`WWW.${ZONE}.`, T0)).toEqual({ allowed: true, reason: "the zone's www" });
  });

  test("allows a site deployed under the zone, and only one", () => {
    const table = tableWith(zoneFiles(ON_DEMAND_POLICY, NAMES));
    for (const label of ["kanban", "portal", "dashboard"]) {
      expect(table.decide(`${label}.${ZONE}`, T0)).toEqual({ allowed: true, reason: "a site deployed under the zone" });
    }
    // The wildcard record points every name at the machine: a name nobody
    // deployed is how someone would spend the authority's weekly limit.
    expect(table.decide(`random.${ZONE}`, T0)).toEqual({ allowed: false, reason: "no site deployed under that name" });
    expect(table.decide(`kanban2.${ZONE}`, T0).allowed).toBe(false);
  });

  test("refuses a name of two labels under the zone, which the wildcard does not route", () => {
    const table = tableWith(zoneFiles(ON_DEMAND_POLICY, NAMES));
    expect(table.decide(`admin.kanban.${ZONE}`, T0)).toEqual({ allowed: false, reason: "not a single label under the zone" });
    expect(table.decide(`www.kanban.${ZONE}`, T0).allowed).toBe(false);
  });

  test("refuses every site when the list is absent, the zone and its www staying allowed", () => {
    const table = tableWith(zoneFiles(ON_DEMAND_POLICY, null));
    expect(table.decide(`kanban.${ZONE}`, T0).allowed).toBe(false);
    expect(table.decide(ZONE, T0).allowed).toBe(true);
  });

  test("never lets the customer domain table allow a name of the zone", () => {
    // A name of the zone listed in domaines.map by mistake is decided by the
    // zone's rule, as it always was.
    const table = tableWith(zoneFiles(ON_DEMAND_POLICY, NAMES), `\trandom.${ZONE} agency\n\tsample-agency.example agency`);
    expect(table.decide(`random.${ZONE}`, T0).allowed).toBe(false);
    expect(table.decide("sample-agency.example", T0)).toEqual({ allowed: true, reason: "active client domain" });
    expect(table.decide(`sample-agency.example.${ZONE}`, T0).allowed).toBe(false);
  });

  test("finds a site deployed a moment ago at once, and reads the list at most once a second for unknown names", () => {
    const files = zoneFiles(ON_DEMAND_POLICY, NAMES);
    const zone = createZone({ zone: ZONE, ...files, ttlMs: 10_000, missMs: 1_000 });
    expect(zone.decide(`kanban.${ZONE}`, T0)!.allowed).toBe(true);

    writeFileSync(files.namesFile, `${NAMES}fresh\n`);
    // Within a second of the last read, a miss is not worth a read.
    expect(zone.decide(`fresh.${ZONE}`, T0 + 999)!.allowed).toBe(false);
    // A second later, well within the table's ten seconds, it is.
    expect(zone.decide(`fresh.${ZONE}`, T0 + 1_999)!.allowed).toBe(true);

    // A name removed stays allowed until the window has passed: a hit is
    // never a reason to read again.
    writeFileSync(files.namesFile, "fresh\n");
    expect(zone.decide(`kanban.${ZONE}`, T0 + 5_000)!.allowed).toBe(true);
    expect(zone.decide(`kanban.${ZONE}`, T0 + 12_000)!.allowed).toBe(false);
  });

  test("keeps the last list read when the file becomes unreadable", () => {
    const files = zoneFiles(ON_DEMAND_POLICY, NAMES);
    const zone = createZone({ zone: ZONE, ...files, ttlMs: 10_000, missMs: 1_000 });
    expect(zone.decide(`kanban.${ZONE}`, T0)!.allowed).toBe(true);
    rmSync(files.namesFile);
    // A deleted file is an empty list, as for the domain table.
    expect(zone.decide(`kanban.${ZONE}`, T0 + 20_000)!.allowed).toBe(false);
  });

  test("follows the policy when it changes, within the table's window", () => {
    const files = zoneFiles(DNS_POLICY, NAMES);
    const zone = createZone({ zone: ZONE, ...files, ttlMs: 10_000, missMs: 1_000 });
    expect(zone.decide(`kanban.${ZONE}`, T0)).toEqual({ allowed: false, reason: "covered by the wildcard" });
    writeFileSync(files.policyFile, ON_DEMAND_POLICY);
    expect(zone.decide(`kanban.${ZONE}`, T0 + 9_999)!.allowed).toBe(false);
    expect(zone.decide(`kanban.${ZONE}`, T0 + 10_000)!.allowed).toBe(true);
  });
});

describe("the cap on names new to the zone, with manual DNS", () => {
  const HOUR = 3_600_000;

  /** A zone whose list holds `initial` at its first reading, with a cap of two a day. */
  function capped(initial: string[]) {
    const files = zoneFiles(ON_DEMAND_POLICY, `${initial.join("\n")}\n`);
    const said: string[] = [];
    const zone = createZone({ zone: ZONE, ...files, ttlMs: 10_000, missMs: 1_000, newNamesCap: 2, newNamesWindowMs: 24 * HOUR, log: (line) => said.push(line) });
    const list = (labels: string[]) => writeFileSync(files.namesFile, `${labels.join("\n")}\n`);
    return { zone, said, list };
  }

  test("twenty a day by default, the cap the README documents", () => {
    expect(NEW_ZONE_NAMES_CAP).toBe(20);
    expect(NEW_ZONE_NAMES_WINDOW_MS).toBe(24 * HOUR);
  });

  test("the names listed at the first reading are known: none of them counts, however many", () => {
    const labels = Array.from({ length: 25 }, (_, i) => `site${i}`);
    const { zone } = capped(labels);
    for (const label of labels) expect(zone.decide(`${label}.${ZONE}`, T0)!.allowed).toBe(true);
  });

  test("past the cap a new name is refused, said once, while known names, renewals included, stay allowed", () => {
    const { zone, said, list } = capped(["kanban"]);
    expect(zone.decide(`kanban.${ZONE}`, T0)!.allowed).toBe(true);
    list(["kanban", "burn1", "burn2", "burn3", "burn4"]);
    expect(zone.decide(`burn1.${ZONE}`, T0 + 2_000)).toEqual({ allowed: true, reason: "a site deployed under the zone" });
    expect(zone.decide(`burn2.${ZONE}`, T0 + 3_000)!.allowed).toBe(true);
    expect(zone.decide(`burn3.${ZONE}`, T0 + 4_000)).toEqual({ allowed: false, reason: "the cap of 2 names new to the zone per 24 h is reached" });
    expect(zone.decide(`burn4.${ZONE}`, T0 + 5_000)!.allowed).toBe(false);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("renewals included, are not affected");
    // A renewal asks again: a name already allowed is never refused by the cap.
    for (const label of ["kanban", "burn1", "burn2"]) expect(zone.decide(`${label}.${ZONE}`, T0 + 6_000)!.allowed).toBe(true);
    // The zone and its www are no new names.
    expect(zone.decide(ZONE, T0 + 6_000)!.allowed).toBe(true);
    expect(zone.decide(`www.${ZONE}`, T0 + 6_000)!.allowed).toBe(true);
  });

  test("a day after the first new names, the next ones are allowed again", () => {
    const { zone, said, list } = capped([]);
    expect(zone.decide(`kanban.${ZONE}`, T0)!.allowed).toBe(false);
    list(["a", "b", "c"]);
    expect(zone.decide(`a.${ZONE}`, T0 + 2_000)!.allowed).toBe(true);
    expect(zone.decide(`b.${ZONE}`, T0 + 3 * HOUR)!.allowed).toBe(true);
    expect(zone.decide(`c.${ZONE}`, T0 + 20 * HOUR)!.allowed).toBe(false);
    expect(zone.decide(`c.${ZONE}`, T0 + 24 * HOUR + 2_000)!.allowed).toBe(true);
    expect(said).toHaveLength(1);
  });

  test("a name not listed is refused as before, the cap never consulted", () => {
    const { zone, said } = capped(["kanban"]);
    expect(zone.decide(`random.${ZONE}`, T0)).toEqual({ allowed: false, reason: "no site deployed under that name" });
    expect(said).toEqual([]);
  });
});

describe("a name outside the zone", () => {
  test("is not the zone's to decide, even when its name ends like the zone's", () => {
    const zone = createZone({ zone: ZONE, ...zoneFiles(ON_DEMAND_POLICY, NAMES) });
    expect(zone.decide("sample-agency.example", T0)).toBeNull();
    expect(zone.decide(`kanban${ZONE}`, T0)).toBeNull();
    expect(zone.decide(`kanban.${ZONE}.evil.test`, T0)).toBeNull();
  });

  test("with no zone configured, no name is the zone's", () => {
    const zone = createZone({ zone: "", ...zoneFiles(ON_DEMAND_POLICY, NAMES) });
    expect(zone.decide(`kanban.${ZONE}`, T0)).toBeNull();
  });
});
