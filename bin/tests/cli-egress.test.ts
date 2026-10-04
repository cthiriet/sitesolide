import { describe, expect, test } from "bun:test";
import {
  CONNECTORS_PORT,
  EGRESS_PROXY_PORT,
  egressErrors,
  egressPatterns,
  egressStateCommand,
  egressUnitLines,
  formatPattern,
  isValidConnectorName,
  matchesEgress,
  normalizeHost,
  parseEgressEntry,
  readEgressState,
  requestedConnectors,
  type HostPattern,
} from "../cli/egress";
import { CADDY_ADMIN_PORT, SERVICE_PORTS } from "../cli/loopback";
import { validate, type Manifest } from "../cli/manifest";
import { generateUnit, generateUnits } from "../cli/unit";

const APP: Manifest = { slug: "budget", port: 3022, start: "/usr/local/bin/bun run server.ts" };

function patterns(...entries: string[]): HostPattern[] {
  return entries.map((entry) => {
    const pattern = parseEgressEntry(entry);
    if (pattern === null) throw new Error(`not a pattern: ${entry}`);
    return pattern;
  });
}

describe("host names", () => {
  test("lowercase, without the final dot", () => {
    expect(normalizeHost("API.Example.COM")).toBe("api.example.com");
    expect(normalizeHost("api.example.com.")).toBe("api.example.com");
  });

  test("an international name compares in its ASCII form, the one clients send", () => {
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeHost("Bücher.Example.")).toBe("xn--bcher-kva.example");
    expect(normalizeHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  test("an address is never a name, written plainly or folded from full-width digits", () => {
    for (const raw of ["127.0.0.1", "10.0.0.1", "１２７.0.0.1", "0x7f.1", "[::1]", "::1", "169.254.169.254"]) {
      expect({ raw, host: normalizeHost(raw) }).toEqual({ raw, host: null });
    }
  });

  test("refuses what would make the URL parser read another host", () => {
    for (const raw of ["evil.com/x.example.com", "user@api.example.com", "api.example.com:443", "a b.com", "a%2e.com", "a\\b.com", "", "localhost", "a..b.com", "-a.com", "a_b.com", "a".repeat(64) + ".com"]) {
      expect({ raw, host: normalizeHost(raw) }).toEqual({ raw, host: null });
    }
  });
});

describe("egress entries", () => {
  test("an exact host, a wildcard, either with a port", () => {
    expect(parseEgressEntry("api.example.com")).toEqual({ wildcard: false, host: "api.example.com", port: null });
    expect(parseEgressEntry("*.slack.com")).toEqual({ wildcard: true, host: "slack.com", port: null });
    expect(parseEgressEntry("db.example.com:8443")).toEqual({ wildcard: false, host: "db.example.com", port: 8443 });
    expect(parseEgressEntry("*.Example.com.:8443")).toEqual({ wildcard: true, host: "example.com", port: 8443 });
  });

  test("refuses a wildcard anywhere but in front, or over a single label", () => {
    for (const entry of ["*", "*.com", "api.*.com", "*api.example.com", "**.example.com", "*.*.example.com", "api.example.*"]) {
      expect({ entry, pattern: parseEgressEntry(entry) }).toEqual({ entry, pattern: null });
    }
  });

  test("refuses a port that is not one, and anything that is not a string", () => {
    for (const entry of ["api.example.com:0", "api.example.com:65536", "api.example.com:", "api.example.com:https", 42, null]) {
      expect(parseEgressEntry(entry)).toBeNull();
    }
  });

  test("written back the way the proxy and the dashboard show it", () => {
    expect(formatPattern(parseEgressEntry("*.Slack.com.")!)).toBe("*.slack.com");
    expect(formatPattern(parseEgressEntry("DB.example.com:8443")!)).toBe("db.example.com:8443");
  });
});

describe("matching a destination", () => {
  test("an exact host matches itself, and nothing above or below it", () => {
    const list = patterns("api.example.com");
    expect(matchesEgress(list, "api.example.com", 443)).toBe(true);
    expect(matchesEgress(list, "example.com", 443)).toBe(false);
    expect(matchesEgress(list, "v2.api.example.com", 443)).toBe(false);
    expect(matchesEgress(list, "api.example.com.evil.net", 443)).toBe(false);
    expect(matchesEgress(list, "xapi.example.com", 443)).toBe(false);
  });

  test("a wildcard matches every subdomain, never the name itself", () => {
    const list = patterns("*.slack.com");
    expect(matchesEgress(list, "files.slack.com", 443)).toBe(true);
    expect(matchesEgress(list, "a.b.slack.com", 443)).toBe(true);
    expect(matchesEgress(list, "slack.com", 443)).toBe(false);
    expect(matchesEgress(list, "evilslack.com", 443)).toBe(false);
    expect(matchesEgress(list, "slack.com.evil.net", 443)).toBe(false);
  });

  test("without a port, 443 and 80; with one, that port alone", () => {
    const list = patterns("api.example.com", "db.example.com:8443");
    expect(matchesEgress(list, "api.example.com", 80)).toBe(true);
    expect(matchesEgress(list, "api.example.com", 22)).toBe(false);
    expect(matchesEgress(list, "api.example.com", 8443)).toBe(false);
    expect(matchesEgress(list, "db.example.com", 8443)).toBe(true);
    expect(matchesEgress(list, "db.example.com", 443)).toBe(false);
  });

  test("an international entry matches the punycode a client sends", () => {
    expect(matchesEgress(patterns("bücher.example"), "xn--bcher-kva.example", 443)).toBe(true);
  });
});

describe("connector names", () => {
  test("a short lowercase name, like a service's", () => {
    for (const name of ["slack", "github", "postgres-readonly", "a1"]) expect(isValidConnectorName(name)).toBe(true);
    for (const name of ["Slack", "1slack", "-slack", "slack-", "sl/ack", "sl.ack", "", "a".repeat(33), 3]) {
      expect(isValidConnectorName(name)).toBe(false);
    }
  });
});

describe("the manifest's keys", () => {
  test("an app may list hosts and ask for connectors", () => {
    const manifest = { ...APP, egress: ["api.example.com", "*.slack.com"], connectors: ["slack"] };
    expect(validate(manifest)).toEqual([]);
    expect(egressPatterns(manifest).map(formatPattern)).toEqual(["api.example.com", "*.slack.com"]);
    expect(requestedConnectors(manifest)).toEqual(["slack"]);
  });

  test("egress and network outbound together are refused: the second opens everything", () => {
    expect(validate({ ...APP, egress: ["api.example.com"], network: "outbound" })).toContainEqual(
      expect.stringContaining("egress: network outbound already reaches every host"),
    );
  });

  test("connectors go with any network: the credential stays on the machine either way", () => {
    expect(validate({ ...APP, connectors: ["slack"], network: "outbound" })).toEqual([]);
  });

  test("a static site has nothing to reach anything with", () => {
    const errors = validate({ slug: "notes", publicDir: "dist", egress: ["api.example.com"], connectors: ["slack"] });
    expect(errors).toContainEqual(expect.stringContaining("egress: without `start`"));
    expect(errors).toContainEqual(expect.stringContaining("connectors: without `start`"));
  });

  test("refuses an empty list, a bad entry, an address and a duplicate", () => {
    expect(validate({ ...APP, egress: [] })).toContainEqual(expect.stringContaining("egress: a non-empty list"));
    expect(validate({ ...APP, egress: "api.example.com" as unknown as string[] })).toContainEqual(expect.stringContaining("egress: a non-empty list"));
    expect(validate({ ...APP, egress: ["10.0.0.1"] })).toContainEqual(expect.stringContaining("never an address"));
    expect(validate({ ...APP, egress: ["*"] })).toContainEqual(expect.stringContaining('egress: "*"'));
    expect(validate({ ...APP, egress: ["API.example.com", "api.example.com."] })).toContainEqual(
      expect.stringContaining("api.example.com is listed twice"),
    );
    expect(validate({ ...APP, connectors: ["slack", "slack"] })).toContainEqual(expect.stringContaining("slack is listed twice"));
    expect(validate({ ...APP, connectors: ["Slack"] })).toContainEqual(expect.stringContaining('connectors: "Slack"'));
  });

  test("a list too long to be read is refused", () => {
    const egress = Array.from({ length: 65 }, (_, i) => `h${i}.example.com`);
    expect(validate({ ...APP, egress })).toContainEqual(expect.stringContaining("64 hosts at most"));
  });

  test("the proxy variables belong to the deployment, in the project's env or a service's", () => {
    expect(validate({ ...APP, egress: ["api.example.com"], env: { HTTPS_PROXY: "http://elsewhere" } })).toContainEqual(
      expect.stringContaining("env: HTTPS_PROXY is set by the deployment"),
    );
    const services: Manifest = {
      slug: "lab",
      connectors: ["slack"],
      services: { web: { start: "/x", port: 3050, env: { SITESOLIDE_CONNECTORS: "x" } } },
    };
    expect(validate(services)).toContainEqual(expect.stringContaining("env: SITESOLIDE_CONNECTORS is set by the deployment"));
    // Without the keys, the variable is the project's own business, as before.
    expect(validate({ ...APP, env: { HTTPS_PROXY: "http://corporate:3128" } })).toEqual([]);
  });

  test("the lowercase spellings too, which the unit also writes and systemd would let the env override", () => {
    // validate() already refuses a lowercase name in `env`, for a rule of its
    // own about variable names. The reservation must not lean on that rule: it
    // is checked here on its own, as if the names rule were relaxed one day.
    for (const name of ["https_proxy", "http_proxy", "no_proxy"]) {
      expect(egressErrors({ ...APP, egress: ["api.example.com"], env: { [name]: "http://elsewhere" } }, true)).toContainEqual(
        expect.stringContaining(`env: ${name} is set by the deployment`),
      );
    }
  });

  test("every variable the unit writes for the keys is one a manifest may not set", () => {
    // Read from the lines themselves, so that a variable added to the unit one
    // day cannot be forgotten in the list that guards it.
    const written = egressUnitLines({ ...APP, egress: ["api.example.com"], connectors: ["slack"] })
      .map((line) => /^Environment=([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(written).toHaveLength(7);
    for (const name of written) {
      const errors = egressErrors({ ...APP, egress: ["api.example.com"], connectors: ["slack"], env: { [name]: "x" } }, true);
      expect({ name, errors }).toEqual({ name, errors: [`env: ${name} is set by the deployment for egress and connectors, and cannot be redefined`] });
    }
  });
});

describe("the unit", () => {
  test("a project without the keys gets the unit it always had", () => {
    const unit = generateUnit(APP, { slug: "budget", zone: "test-zone.invalid", contact: "" });
    expect(unit).not.toContain("PROXY");
    expect(unit).not.toContain("proxy");
    expect(unit).not.toContain("SITESOLIDE_CONNECTORS");
    expect(egressUnitLines(APP)).toEqual([]);
  });

  test("egress keeps the loopback only, and points every client spelling at the proxy", () => {
    const unit = generateUnit({ ...APP, egress: ["api.example.com"] });
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=localhost");
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      expect(unit).toContain(`Environment=${name}=http://127.0.0.1:${EGRESS_PROXY_PORT}\n`);
    }
    expect(unit).toContain("Environment=NO_PROXY=localhost,127.0.0.1,::1\n");
    expect(unit).toContain("Environment=no_proxy=localhost,127.0.0.1,::1\n");
    expect(unit).not.toContain("SITESOLIDE_CONNECTORS");
  });

  test("connectors give the address of the connectors, and no proxy", () => {
    const unit = generateUnit({ ...APP, connectors: ["slack"] });
    expect(unit).toContain(`Environment=SITESOLIDE_CONNECTORS=http://127.0.0.1:${CONNECTORS_PORT}/connectors\n`);
    expect(unit).not.toContain("HTTPS_PROXY");
  });

  test("every service of a project gets them, the project's keys being shared", () => {
    const units = generateUnits({
      slug: "lab",
      egress: ["api.example.com"],
      services: { web: { start: "/x", port: 3050 }, worker: { start: "/y", port: 3051, internal: true } },
    });
    expect(units).toHaveLength(2);
    for (const { text } of units) expect(text).toContain("Environment=HTTPS_PROXY=");
  });
});

describe("the ports", () => {
  test("outside the range the loopback rule closes, and away from Caddy's admin API", () => {
    // Inside the range, the rule would refuse the very projects that need them.
    for (const port of [EGRESS_PROXY_PORT, CONNECTORS_PORT]) {
      expect(port < SERVICE_PORTS.first || port > SERVICE_PORTS.last).toBe(true);
      expect(port).not.toBe(CADDY_ADMIN_PORT);
    }
    expect(EGRESS_PROXY_PORT).not.toBe(CONNECTORS_PORT);
  });
});

describe("the deployment's read", () => {
  test("three states, and anything else is unreadable", () => {
    expect(readEgressState("active\nDONE\n")).toBe("active");
    expect(readEgressState("inactive\nDONE\n")).toBe("inactive");
    expect(readEgressState("absent\nDONE\n")).toBe("absent");
    expect(readEgressState("")).toBe("unreadable");
    expect(readEgressState("active\n")).toBe("unreadable");
    expect(readEgressState("sudo: a password is required\nDONE\n")).toBe("unreadable");
  });

  test("asks systemd, with no privilege", () => {
    expect(egressStateCommand()).not.toContain("sudo");
    expect(egressStateCommand()).toContain("systemctl is-active --quiet sitesolide-egress.service");
  });
});
