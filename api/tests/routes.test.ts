import { describe, expect, test } from "bun:test";
import type { Decision, Table } from "../src/domains";
import { createRoutes } from "../src/routes";

/** Simulated table: the route tests have no business touching the disk. */
function tableFictive(allowedHosts: string[]): Table {
  return {
    decide(raw): Decision {
      return allowedHosts.includes(String(raw))
        ? { allowed: true, reason: "active client domain" }
        : { allowed: false, reason: "unknown domain" };
    },
    count: () => allowedHosts.length,
  };
}

function requestFor(domain: string | null): Request {
  const url = new URL("http://127.0.0.1:3001/interne/domaine-autorise");
  if (domain !== null) url.searchParams.set("domain", domain);
  return new Request(url.toString());
}

describe("ask endpoint", () => {
  test("answers 200 for an authorized domain", () => {
    const routes = createRoutes(tableFictive(["sample-agency.example"]));
    expect(routes.domainAllowed(requestFor("sample-agency.example")).status).toBe(200);
  });

  test("answers 403 for a refused domain", () => {
    // Caddy only issues a certificate on a 200: everything else is a refusal.
    const routes = createRoutes(tableFictive([]));
    expect(routes.domainAllowed(requestFor("unknown.test")).status).toBe(403);
  });

  test("answers 403 when Caddy sends no domain", () => {
    const routes = createRoutes(tableFictive(["sample-agency.example"]));
    expect(routes.domainAllowed(requestFor(null)).status).toBe(403);
  });

  test("logs the same refusal only once per window", () => {
    // A domain pointed at the machine by mistake would otherwise produce one
    // log line per TLS handshake.
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));

    let instant = 0;
    const routes = createRoutes(tableFictive([]), () => instant);
    try {
      routes.domainAllowed(requestFor("unknown.test"));
      routes.domainAllowed(requestFor("unknown.test"));
      expect(lines).toHaveLength(1);

      instant += 5 * 60 * 1000;
      routes.domainAllowed(requestFor("unknown.test"));
      expect(lines).toHaveLength(2);

      // Another domain is logged without waiting.
      routes.domainAllowed(requestFor("other-unknown.test"));
      expect(lines).toHaveLength(3);
    } finally {
      console.warn = original;
    }
  });
});

describe("health", () => {
  test("returns the number of authorized domains", async () => {
    const routes = createRoutes(tableFictive(["a.test", "b.test"]));
    expect(await routes.health().json()).toEqual({ ok: true, domains: 2 });
  });
});
