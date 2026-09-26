import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDomainTable, createTable, normalizeHost } from "../src/domains";

const temporary: string[] = [];

/** A table on disk, specific to one test, erased at the end of the file. */
function tableOnDisk(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "sitesolide-"));
  temporary.push(dir);
  const path = join(dir, "domaines.map");
  if (content !== null) writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("normalizeHost", () => {
  test("brings equivalent forms back to the same host name", () => {
    expect(normalizeHost("SAMPLE-AGENCY.EXAMPLE")).toBe("sample-agency.example");
    expect(normalizeHost("  sample-agency.example  ")).toBe("sample-agency.example");
    expect(normalizeHost("sample-agency.example.")).toBe("sample-agency.example");
    expect(normalizeHost("sample-agency.example:443")).toBe("sample-agency.example");
  });

  test("refuses what is not a certifiable domain name", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("localhost")).toBeNull();
    expect(normalizeHost("203.0.113.10")).toBeNull();
    expect(normalizeHost("../../etc/passwd")).toBeNull();
    expect(normalizeHost("example.test/../other")).toBeNull();
    expect(normalizeHost("example .test")).toBeNull();
    // 253 characters is the maximum length of a domain name.
    expect(normalizeHost(`${"a".repeat(248)}.test`)).not.toBeNull();
    expect(normalizeHost(`${"a".repeat(249)}.test`)).toBeNull();
  });
});

describe("parseDomainTable", () => {
  test("keeps the key of each line, ignores comments and default", () => {
    const table = parseDomainTable(
      ["# comment", "", "\tsample-agency.example agency", "  other.test  showcase  ", 'default "__unknown"'].join("\n"),
    );
    expect([...table].sort()).toEqual(["other.test", "sample-agency.example"]);
  });

  test("ignores regular expression keys, which this service cannot evaluate", () => {
    // Letting them through would authorize more broadly than Caddy routes.
    expect(parseDomainTable("~.*\\.test$ agency").size).toBe(0);
  });
});

describe("decide", () => {
  const T0 = 1_000_000;

  test("authorizes a domain present in the table", () => {
    const table = createTable(tableOnDisk("\tsample-agency.example agency"));
    expect(table.decide("sample-agency.example", T0).allowed).toBe(true);
  });

  test("refuses a domain absent from the table", () => {
    const table = createTable(tableOnDisk("\tsample-agency.example agency"));
    const decision = table.decide("unknown.test", T0);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unknown domain");
  });

  test("refuses a subdomain of an authorized domain", () => {
    // Without that, a DNS pointed at admin.sample-agency.example would have a
    // certificate issued for a name nobody declared.
    const table = createTable(tableOnDisk("\tsample-agency.example agency"));
    expect(table.decide("admin.sample-agency.example", T0).allowed).toBe(false);
    expect(table.decide("sample-agency.example.evil.test", T0).allowed).toBe(false);
  });

  test("refuses the main zone, already covered by the wildcard and the apex", () => {
    const table = createTable(tableOnDisk("\ttest-zone.invalid agency\n\tagency.test-zone.invalid agency"));
    // Even listed by mistake, the zone must not get an individual certificate.
    expect(table.decide("test-zone.invalid", T0).reason).toBe("covered by the wildcard");
    expect(table.decide("agency.test-zone.invalid", T0).reason).toBe("covered by the wildcard");
  });

  test("refuses when the file does not exist", () => {
    const table = createTable(join(tableOnDisk(null), "..", "absent.map"));
    expect(table.decide("sample-agency.example", T0).allowed).toBe(false);
  });

  test("only re-reads the file once the window has elapsed", () => {
    const path = tableOnDisk("");
    const table = createTable(path, 10_000);

    expect(table.decide("sample-agency.example", T0).allowed).toBe(false);
    writeFileSync(path, "\tsample-agency.example agency");

    expect(table.decide("sample-agency.example", T0 + 9_999).allowed).toBe(false);
    expect(table.decide("sample-agency.example", T0 + 10_000).allowed).toBe(true);
  });

  test("keeps the last known table if the file becomes unreadable", () => {
    // The file is rewritten at every client switch: a failed read must not
    // make the renewals in progress fail.
    const path = tableOnDisk("\tsample-agency.example agency");
    const table = createTable(path, 10_000);
    expect(table.decide("sample-agency.example", T0).allowed).toBe(true);

    rmSync(path);
    // A deleted file is a normal case and empties the table.
    expect(table.decide("sample-agency.example", T0 + 20_000).allowed).toBe(false);
  });

  test("counts the authorized domains", () => {
    const table = createTable(tableOnDisk("\ta.test agency\n\tb.test studio"));
    expect(table.count(T0)).toBe(2);
  });
});
