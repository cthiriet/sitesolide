import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { LANDING_FOLDER, buildSnapshot, type Raw, type Discrepancy, type Site } from "../src/state";
import { invitableHosts } from "../src/guests";
import { MAX_RESTART_MS } from "../src/secrets/protocol";
import { downServices } from "../web/src/lib/sidebar";
import { guestRefusal, canHaveGuests, sitesWithGuests } from "../web/src/lib/invitations";
import { PEAK_WARNING_SHARE, serviceLevel } from "../web/src/lib/gauges";
import { RESTART_SCALE_MS } from "../web/src/lib/secrets";
import { siteAddresses } from "../web/src/lib/site-card";
import { siteAccess, siteAddress, serviceState, type Mismatch } from "../web/src/lib/sites";

/**
 * The page copies a few of the server's rules, for want of being able to import
 * it: it is built for the browser and receives only its types. Each copy is
 * confronted here with the original, on the same snapshot, so that it does not
 * diverge in silence. A page that offers a guest on a site the service will
 * refuse, or that says "Running" in green where the discrepancies say red, lies
 * without anything failing.
 */

const PROJECT = resolve(import.meta.dir, "..");
const WEB = join(PROJECT, "web", "src");

// --- The page receives only types ------------------------------------------------

function pageSources(): string[] {
  return readdirSync(WEB, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(ts|tsx|astro)$/.test(name))
    .map((name) => join(WEB, name));
}

/** What the browser must never bundle: the service's code, under src/. */
function towardsServer(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = relative(join(PROJECT, "src"), resolve(dirname(file), specifier));
  return !target.startsWith("..");
}

describe("the page imports only types from the server", () => {
  test("there really are imports to check", () => {
    const tous = pageSources().flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].filter((m) => towardsServer(file, m[1]!)),
    );
    expect(tous.length).toBeGreaterThan(0);
  });

  /**
   * `import type` and `export type` at statement level: with
   * `verbatimModuleSyntax`, an `import { type A }` keeps the import and the
   * module would end up in the bundle.
   */
  test("every import from src/ is a type import, erased at build time", () => {
    const faults: string[] = [];
    for (const file of pageSources()) {
      const text = readFileSync(file, "utf8");
      const instructions = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
      for (const m of text.matchAll(instructions)) {
        if (towardsServer(file, m[3]!) && m[2] === undefined) faults.push(`${relative(PROJECT, file)}: ${m[0].trim()}`);
      }
      for (const m of text.matchAll(/(await\s+)?import\(\s*["']([^"']+)["']\s*\)(\.\w+)?/g)) {
        const typeOnly = m[1] === undefined && m[3] !== undefined && !/^\.(then|catch|finally)$/.test(m[3]);
        if (towardsServer(file, m[2]!) && !typeOnly) faults.push(`${relative(PROJECT, file)}: ${m[0]}`);
      }
    }
    expect(faults).toEqual([]);
  });
});

// --- A varied snapshot -----------------------------------------------------------

const NOW = 1_758_000_000_000;
const MO = 1024 * 1024;
const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";
const NO_GATE = "reverse_proxy 127.0.0.1:3040";

function unit(active: string, subState: string, memory: { current: number; peak: number; limit: number }) {
  return {
    LoadState: "loaded",
    ActiveState: active,
    SubState: subState,
    MemoryCurrent: String(memory.current * MO),
    MemoryPeak: String(memory.peak * MO),
    MemoryMax: String(memory.limit * MO),
    NRestarts: "0",
    ActiveEnterTimestamp: `@${Math.round(NOW / 1000) - 3600}`,
    CPUUsageNSec: "1000000",
  };
}

const app = (slug: string, port: number, nextStep: Record<string, unknown> = {}) =>
  JSON.stringify({ slug, port, start: "bun run server.ts", ...nextStep });

const repos = { current: 40, peak: 60, limit: 256 };

function folder(slug: string, manifest: string | null, rawUnit: Record<string, string> | null = null) {
  return { slug, manifest, unit: rawUnit, bytes: 1024, deployed: NOW };
}

/**
 * Every copied rule in both directions: portal wanted and in place, wanted
 * alone, in place alone, neither; lock with and without a code; domain active
 * or routed; services active, looping, starting, fallen, incomplete; peak below and
 * above the threshold; the landing, which serves the bare domain.
 */
const RAW: Raw = {
  generated: NOW,
  zone: "test-zone.invalid",
  folders: [
    folder("gate", app("gate", 3001, { portal: true }), unit("active", "running", repos)),
    folder("wanted-only", app("wanted-only", 3002, { portal: true }), unit("active", "running", repos)),
    folder("installed-only", JSON.stringify({ slug: "installed-only", publicDir: "public" })),
    folder("no-gate", JSON.stringify({ slug: "no-gate", publicDir: "public" })),
    folder("static-gate", JSON.stringify({ slug: "static-gate", portal: true })),
    folder("lock", JSON.stringify({ slug: "lock", lock: true })),
    folder("lock-without-code", JSON.stringify({ slug: "lock-without-code", lock: true })),
    folder("code-without-lock", JSON.stringify({ slug: "code-without-lock" })),
    folder(
      "domain-active",
      JSON.stringify({ slug: "domain-active", domain: { name: "active.test", aliases: ["www.active.test"], active: true } }),
    ),
    folder("domain-routed", JSON.stringify({ slug: "domain-routed", domain: { name: "routed.test", active: false } })),
    folder("domain-ok", JSON.stringify({ slug: "domain-ok", domain: { name: "ok.test", active: true } })),
    folder("domain-pending", JSON.stringify({ slug: "domain-pending", domain: { name: "pending.test" } })),
    folder("looping", app("looping", 3010), unit("activating", "auto-restart", repos)),
    folder("starting", app("starting", 3011), unit("activating", "start", repos)),
    folder("stopping", app("stopping", 3012), unit("deactivating", "stop", repos)),
    folder("fallen", app("fallen", 3013), unit("failed", "failed", repos)),
    folder("no-unit", app("no-unit", 3014)),
    folder("peak-under", app("peak-under", 3015), unit("active", "running", { current: 40, peak: 204, limit: 256 })),
    folder("peak-over", app("peak-over", 3016), unit("active", "running", { current: 40, peak: 205, limit: 256 })),
    folder(LANDING_FOLDER, null, unit("active", "running", repos)),
  ],
  codes: JSON.stringify({ "lock": "K7PX3M", "code-without-lock": "H4RT9Q" }),
  domains: "\tactive-other.test other\n\trouted.test domain-routed\n\tok.test domain-ok\n",
  ports: [3001, 3002, 3010, 3011, 3012, 3013, 3014, 3015, 3016],
  blocks: {
    "gate": WITH_DOOR,
    "wanted-only": NO_GATE,
    "installed-only": WITH_DOOR,
    "static-gate": WITH_DOOR,
  },
  machine: null,
  previous: null,
};

const SNAPSHOT = buildSnapshot(RAW);
const SITES = SNAPSHOT.sites;

function discrepanciesOf(slug: string): Discrepancy[] {
  return SNAPSHOT.discrepancies.filter((discrepancy) => discrepancy.slug === slug);
}

function hasDiscrepancy(site: Site, start: string): boolean {
  return discrepanciesOf(site.slug).some((discrepancy) => discrepancy.message.startsWith(start));
}

test("the snapshot covers every case", () => {
  expect(SITES).toHaveLength(RAW.folders.length);
  const portals = SITES.map((site) => `${site.portal.wanted}/${site.portal.installed}`);
  for (const combination of ["true/true", "true/false", "false/true", "false/false"]) expect(portals).toContain(combination);
});

// --- The copied rules ------------------------------------------------------------

describe("the page and the server say the same thing", () => {
  /** src/guests.ts refuses a guest outside these hosts: the page must offer only them. */
  test("the sites open to guests are those where the service accepts a guest", () => {
    const server = invitableHosts(SNAPSHOT);
    expect(server.length).toBeGreaterThan(0);
    expect(sitesWithGuests(SITES).map((site) => site.address).sort()).toEqual([...server].sort());
    for (const site of SITES) expect([site.slug, canHaveGuests(site)]).toEqual([site.slug, server.includes(site.address)]);
  });

  test("a door out of agreement is an anomaly on both sides", () => {
    const rules: Record<Mismatch, string> = {
      "portal-absent": "Portal requested but missing",
      "portal-extra": "Portal in the live Caddy block although",
      "code-without-lock": "Code in effect without a lock",
      "lock-without-code": "Lock requested without a valid code",
    };
    let anomalies = 0;
    for (const site of SITES) {
      const access = siteAccess(site);
      const server = (Object.keys(rules) as Mismatch[]).filter((key) => hasDiscrepancy(site, rules[key]));
      if (access.kind === "mismatch") {
        anomalies += 1;
        expect([site.slug, server.includes(access.key)]).toEqual([site.slug, true]);
      } else {
        expect([site.slug, server]).toEqual([site.slug, []]);
      }
    }
    expect(anomalies).toBe(4);
  });

  test("an app service that is not running is red on its row and in the discrepancies", () => {
    const fallen = (site: Site) => hasDiscrepancy(site, "Service ") || hasDiscrepancy(site, "App project without a loaded unit");
    const apps = SITES.filter((site) => site.type === "app");
    expect(apps.length).toBeGreaterThan(5);
    for (const site of apps) {
      expect([site.slug, serviceState(site).tone === "error"]).toEqual([site.slug, fallen(site)]);
    }
    expect(downServices(SITES, NOW)).toBe(apps.filter(fallen).length);
  });

  /** The memory bar turns amber exactly when the list of discrepancies flags the peak. */
  test("the memory peak alerts at the same threshold", () => {
    for (const site of SITES) {
      const service = site.service;
      if (service === null) continue;
      const warn = serviceLevel(service.memory, service.peak, service.limit) !== "normal";
      expect([site.slug, warn]).toEqual([site.slug, hasDiscrepancy(site, "Memory peak")]);
    }
    expect(SITES.some((site) => hasDiscrepancy(site, "Memory peak"))).toBe(true);
    expect(PEAK_WARNING_SHARE).toBeGreaterThan(0);
  });

  test("a domain active without a route, or routed without being active, is flagged on both sides", () => {
    for (const site of SITES) {
      const warn = siteAddress(site).note?.warn === true;
      const server = hasDiscrepancy(site, `${site.domain?.name} is active in the manifest`) || hasDiscrepancy(site, `${site.domain?.name} is routed`);
      expect([site.slug, warn]).toEqual([site.slug, server]);
    }
  });

  test("only the landing serves the bare domain", () => {
    for (const site of SITES) {
      const main = siteAddresses(site).at(-1)?.role === "main";
      expect([site.slug, main]).toEqual([site.slug, site.slug === LANDING_FOLDER]);
    }
  });

  /** Waiting on a restart promises a verdict within the minute: the steward has to answer before that. */
  test("the waiting track covers the longest restart the relay waits for", () => {
    expect(RESTART_SCALE_MS).toBeGreaterThanOrEqual(MAX_RESTART_MS);
  });

  /** The codes the page translates, emitted by the service or relayed from the portal. */
  test("every translated guest refusal still exists where it is emitted", () => {
    const sources = [join(PROJECT, "src", "routes.ts"), join(PROJECT, "..", "portal", "src", "admin.ts")]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const translated = readFileSync(join(WEB, "lib", "invitations.ts"), "utf8")
      .split("export function guestRefusal")[1]!
      .split("\n}")[0]!;
    const codes = [...translated.matchAll(/case "([^"]+)":/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(3);
    for (const code of codes) {
      expect([code, sources.includes(`error: "${code}"`)]).toEqual([code, true]);
      expect(guestRefusal(400, { error: code }).message).not.toContain(code);
    }
  });
});
