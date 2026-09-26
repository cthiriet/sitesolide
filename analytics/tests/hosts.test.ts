import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { HOSTS_FILE, knownHosts, forget, REREAD_STEP_MS, siteOf } from "../src/hosts";

/**
 * The allow list comes from a file the dashboard's collector drops as root:
 * this service cannot build it itself, its unit hiding from it the other
 * directories of `/srv` as well as `/etc/caddy`.
 *
 * What is tested here is therefore what the service does with a file it does
 * not control: missing, truncated, or changed under its feet.
 */
const T0 = 1_000_000;

function writeHosts(table: Record<string, string>): void {
  writeFileSync(HOSTS_FILE, `${JSON.stringify({ generatedAt: T0, hosts: table })}\n`);
  forget();
}

beforeEach(() => forget());
afterEach(() => {
  rmSync(HOSTS_FILE, { force: true });
  forget();
});

describe("siteOf", () => {
  test("returns the directory served by a declared host", () => {
    writeHosts({ "vineyard.test-zone.invalid": "vineyard", "vineyard-modern.test": "vineyard" });
    expect(siteOf("vineyard.test-zone.invalid", T0)).toBe("vineyard");
    expect(siteOf("vineyard-modern.test", T0)).toBe("vineyard");
  });

  test("refuses a host the machine does not serve", () => {
    writeHosts({ "vineyard.test-zone.invalid": "vineyard" });
    expect(siteOf("pirate.example", T0)).toBe(null);
  });

  test("refuses everything when the file does not exist", () => {
    // A service started before the collector's first pass writes nothing,
    // rather than accepting everything. It is the most important refusal here:
    // without it, any page on the web would fill this database during the
    // minute that follows a restart.
    rmSync(HOSTS_FILE, { force: true });
    forget();
    expect(siteOf("vineyard.test-zone.invalid", T0)).toBe(null);
    expect(knownHosts(T0)).toEqual({});
  });

  test("keeps the previous table if the file becomes unreadable", () => {
    // The collector writes by renaming, which is atomic, but a full disk would
    // leave something other than a whole JSON document: better to measure with
    // the table from a minute ago than to stop measuring.
    writeHosts({ "vineyard.test-zone.invalid": "vineyard" });
    expect(siteOf("vineyard.test-zone.invalid", T0)).toBe("vineyard");

    writeFileSync(HOSTS_FILE, "{ this is not json");
    expect(siteOf("vineyard.test-zone.invalid", T0 + REREAD_STEP_MS)).toBe("vineyard");
  });

  test("holds a file without the expected key", () => {
    writeFileSync(HOSTS_FILE, JSON.stringify({ generatedAt: T0 }));
    forget();
    expect(knownHosts(T0)).toEqual({});
  });
});

describe("the re-read", () => {
  test("sees a host added on the collector's next pass", () => {
    writeHosts({ "vineyard.test-zone.invalid": "vineyard" });
    expect(siteOf("fresh.test", T0)).toBe(null);

    writeHosts({ "vineyard.test-zone.invalid": "vineyard", "fresh.test": "fresh" });
    expect(siteOf("fresh.test", T0 + REREAD_STEP_MS)).toBe("fresh");
  });

  test("does not read the disk again on every page view", () => {
    // Reading an unchanged file again on every page view of every site on the
    // machine would cost one disk read per page view. A file replaced without
    // the clock moving on is therefore not seen straight away, and that is
    // deliberate.
    writeHosts({ "vineyard.test-zone.invalid": "vineyard" });
    siteOf("vineyard.test-zone.invalid", T0);

    writeFileSync(HOSTS_FILE, JSON.stringify({ hosts: { "fresh.test": "fresh" } }));
    expect(siteOf("fresh.test", T0 + 1)).toBe(null);
    expect(siteOf("fresh.test", T0 + REREAD_STEP_MS)).toBe("fresh");
  });

  test("forgets everything when the file disappears", () => {
    writeHosts({ "vineyard.test-zone.invalid": "vineyard" });
    expect(siteOf("vineyard.test-zone.invalid", T0)).toBe("vineyard");

    rmSync(HOSTS_FILE, { force: true });
    expect(siteOf("vineyard.test-zone.invalid", T0 + REREAD_STEP_MS)).toBe(null);
  });
});
