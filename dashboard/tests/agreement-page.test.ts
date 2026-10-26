import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { LANDING_FOLDER, buildSnapshot, type Raw, type Discrepancy, type Site } from "../src/state";
import { MAX_RESTART_MS } from "../src/secrets/protocol";
import { HASH_FILE_SETTINGS, PASSWORD_VARIABLE, PLATFORM_FILES, outsideHashRefusal } from "../src/secrets/scope";
import { OFFSITE_VARIABLES, offsiteFrom } from "../src/backup/offsite";
import { readManifest } from "../borrowed/manifest";
import { unitEnvironment } from "../borrowed/envfile";
import { SECRETS_FOLDER } from "../borrowed/store";
import { generateUnit } from "../borrowed/unit";
import { readConfig } from "../../monitor/src/config";
import { alertUrl, webhookFormat } from "../../monitor/src/notify";
import { buildStatus } from "../../monitor/src/status";
import { downServices } from "../web/src/lib/sidebar";
import { PEAK_WARNING_SHARE, serviceLevel } from "../web/src/lib/gauges";
import {
  ALERTS_UNDELIVERED_LABEL,
  HEARTBEAT_FAILED_LABEL,
  SETTINGS,
  WEBHOOK_FORMATS,
  alertAddressProblem,
  appliesOnRestart,
  detectedWebhookFormat,
  settingById,
  settingState,
  unrestartedSentence,
} from "../web/src/lib/machine-settings";
import { RESTART_SCALE_MS } from "../web/src/lib/secrets";
import { serviceRows, siteAddresses } from "../web/src/lib/site-card";
import { siteAccess, siteAddress, serviceState, type Mismatch } from "../web/src/lib/sites";

/**
 * The page copies a few of the server's rules, for want of being able to import
 * it: it is built for the browser and receives only its types. Each copy is
 * confronted here with the original, on the same snapshot, so that it does not
 * diverge in silence. A page that flags no anomaly on a door the service
 * reports out of agreement, or that says "Running" in green where the
 * discrepancies say red, lies without anything failing.
 */

const PROJECT = resolve(import.meta.dir, "..");
const WEB = join(PROJECT, "web", "src");

/**
 * The portal's own reader of its sign-in settings, imported by its path: its
 * sources are written for the portal's TypeScript, and this project's compiler
 * refuses one of them (a Uint8Array against BufferSource) that the portal's
 * accepts. Only the shape this test calls is typed.
 */
const { readSettings } = (await import(join(PROJECT, "..", "portal", "src", "oidc.ts"))) as {
  readSettings: (env: Record<string, string | undefined>, publicUrl: string) => { settings: unknown };
};

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
  test("general access out of agreement is an anomaly on both sides", () => {
    const rules: Record<Mismatch, string> = {
      "portal-absent": "Restricted in sitesolide.json, public on the server",
      "portal-extra": "Restricted on the server, public in sitesolide.json",
      "code-without-lock": "Preview code in effect although",
      "lock-without-code": "Preview code requested but none is valid",
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
});

// --- Workers and scheduled services ----------------------------------------------

/**
 * The words of a project's services against the discrepancies, on a second
 * snapshot: a worker running and down; scheduled services idle, running, with
 * a failed last run, with their timer stopped or missing; a project whose
 * every service is scheduled, its anchor active and stopped. Between two runs
 * a scheduled service is inactive: the page must not say Down where the
 * discrepancies say nothing, nor Waiting where they say the schedule stopped.
 */
describe("a project's services, on their rows and in the discrepancies", () => {
  const at = (seconds: number) => `@${Math.round(NOW / 1000) + seconds}`;
  const timer = (active = "active", load = "loaded") => ({
    LoadState: load,
    ActiveState: active,
    SubState: active === "active" ? "waiting" : "dead",
    LastTriggerUSec: at(-3600),
    NextElapseUSecRealtime: at(900),
  });
  const run = (active: string, result: string, status: string) => ({
    ...unit(active, active === "active" ? "running" : active === "failed" ? "failed" : "dead", repos),
    Result: result,
    ExecMainStatus: status,
    ExecMainStartTimestamp: at(-3600),
    ExecMainExitTimestamp: active === "active" ? "" : at(-3500),
  });
  const services = (scheduled: Record<string, Record<string, unknown>>) =>
    JSON.stringify({
      slug: "x",
      services: { web: { start: "/srv/sites/x/app/web", port: 3050 }, queue: { start: "/srv/sites/x/app/queue", internal: true }, ...scheduled },
    });
  const project = (slug: string, scheduled: Record<string, Record<string, unknown>>, units: Record<string, unknown>) => ({
    ...folder(slug, services(scheduled).replace('"slug":"x"', `"slug":"${slug}"`).replaceAll("/srv/sites/x/", `/srv/sites/${slug}/`), unit("active", "running", repos)),
    units: units as Record<string, Record<string, string> | null>,
  });
  const hourly = { sync: { start: "/srv/sites/x/app/sync", schedule: "hourly" } };
  const anchoredManifest = (slug: string) => JSON.stringify({ slug, services: { report: { start: `/srv/sites/${slug}/app/report`, schedule: "daily" } } });
  const anchor = (active: string) => ({ ...unit(active, active === "active" ? "exited" : "dead", repos), MemoryCurrent: "[not set]", MemoryMax: "infinity" });

  const RAW_SERVICES: Raw = {
    generated: NOW,
    zone: "test-zone.invalid",
    folders: [
      project("idle", hourly, { "idle.queue": unit("active", "running", repos), "idle.sync": run("inactive", "success", "0"), "idle.sync.timer": timer() }),
      project("running", hourly, { "running.queue": unit("active", "running", repos), "running.sync": run("active", "success", "0"), "running.sync.timer": timer() }),
      project("failed-run", hourly, { "failed-run.queue": unit("active", "running", repos), "failed-run.sync": run("failed", "exit-code", "1"), "failed-run.sync.timer": timer() }),
      project("timer-stopped", hourly, { "timer-stopped.queue": unit("active", "running", repos), "timer-stopped.sync": run("inactive", "success", "0"), "timer-stopped.sync.timer": timer("inactive") }),
      project("timer-missing", hourly, { "timer-missing.queue": unit("active", "running", repos), "timer-missing.sync": run("inactive", "success", "0"), "timer-missing.sync.timer": timer("inactive", "not-found") }),
      project("worker-down", hourly, { "worker-down.queue": unit("failed", "failed", repos), "worker-down.sync": run("inactive", "success", "0"), "worker-down.sync.timer": timer() }),
      { ...folder("armed", anchoredManifest("armed"), anchor("active")), units: { "armed.report": run("inactive", "success", "0"), "armed.report.timer": timer() } },
      { ...folder("disarmed", anchoredManifest("disarmed"), anchor("inactive")), units: { "disarmed.report": run("inactive", "success", "0"), "disarmed.report.timer": timer("inactive") } },
    ],
    codes: "{}",
    domains: null,
    ports: [3050],
    blocks: {},
    machine: null,
    previous: null,
  };
  const snapshot = buildSnapshot(RAW_SERVICES);
  const about = (slug: string, name: string) =>
    snapshot.discrepancies.filter((d) => d.slug === slug && d.message.startsWith(`Service ${name}`) && !d.message.includes("memory peak"));

  test("the snapshot covers every case", () => {
    expect(snapshot.sites.map((site) => site.slug).sort()).toEqual(RAW_SERVICES.folders.map((one) => one.slug).sort());
  });

  test("each service's tone is the severity of what the discrepancies say of it", () => {
    let judged = 0;
    for (const site of snapshot.sites) {
      const rows = serviceRows(site, NOW);
      for (const entry of site.services.filter((one) => !one.main)) {
        const row = rows.find((candidate) => candidate.unit === `${entry.unit}.service`)!;
        const found = about(site.slug, entry.name!);
        const severity = found.some((d) => d.severity === "error") ? "error" : found.length > 0 ? "warning" : null;
        const tone = row.state.tone === "error" ? "error" : row.state.tone === "attention" ? "warning" : null;
        expect([site.slug, entry.name, tone]).toEqual([site.slug, entry.name, severity]);
        judged += 1;
      }
    }
    expect(judged).toBe(14);
  });

  test("the row's word is the main unit's, in error exactly when the discrepancies say the project is stopped", () => {
    const stopped = (slug: string) =>
      snapshot.discrepancies.some((d) => d.slug === slug && (/^Service [a-z-]+ \(/.test(d.message) || d.message.startsWith("App project without")));
    for (const site of snapshot.sites) {
      expect([site.slug, serviceState(site).tone === "error"]).toEqual([site.slug, stopped(site.slug)]);
    }
    expect(serviceState(snapshot.sites.find((site) => site.slug === "armed")!)).toEqual({ tone: "ok", label: "Scheduled" });
    expect(downServices(snapshot.sites, NOW)).toBe(1);
  });
});

// --- The server's own settings ---------------------------------------------------

/**
 * The page names the server's settings, and judges a few things about them
 * before sending (web/src/lib/machine-settings.ts). Each of them is a copy of a
 * rule of the monitor, the steward, the portal or the backups, confronted here
 * with the original: a setting that names a variable its reader ignores would
 * be saved with a smile and do nothing.
 */
describe("the server's settings and the services that read them", () => {
  const ZONE = "test-zone.invalid";
  const variable = (id: Parameters<typeof settingById>[0], index = 0) => settingById(id).variables[index]!.name;

  const ADDRESSES = [
    "",
    "   ",
    "https://hc-ping.test-zone.invalid/0b7c",
    "  https://hc-ping.test-zone.invalid/0b7c  ",
    "HTTPS://HC-PING.TEST-ZONE.INVALID/0b7c",
    "https://user:secret@hc-ping.test-zone.invalid/",
    "https://[::1]/x",
    "https://",
    "https:/hc-ping.test-zone.invalid",
    "http://hc-ping.test-zone.invalid/0b7c",
    "http://127.0.0.1:9/x",
    "http://localhost/x",
    "ftp://files.test-zone.invalid/",
    "javascript:alert(1)",
    "mailto:someone@test-zone.invalid",
    "hc-ping.test-zone.invalid/0b7c",
    "not an address",
    "https://hooks.slack.com/services/T0/B0/x",
    "https://discord.com/api/webhooks/1/x",
    "https://canary.discord.com/api/webhooks/1/x",
    "https://discordapp.com/api/webhooks/1/x",
    "https://notdiscord.com/x",
    "https://discord.com.test-zone.invalid/x",
    "https://chat.googleapis.com/v1/spaces/A/messages?key=k",
    "https://ntfy.sh/a-topic",
    "https://ntfy.sh.test-zone.invalid/a-topic",
    "https://ntfy.test-zone.invalid/a-topic",
  ];

  test("an address is refused by the page exactly when the monitor refuses it", () => {
    let refused = 0;
    for (const address of ADDRESSES) {
      const monitor = alertUrl("HEARTBEAT_URL", address).problem !== null;
      if (monitor) refused += 1;
      expect([address, alertAddressProblem(address) !== null]).toEqual([address, monitor]);
    }
    expect(refused).toBeGreaterThan(8);
    expect(refused).toBeLessThan(ADDRESSES.length - 8);
  });

  test("the format read from an address is the monitor's", () => {
    const seen = new Set<string>();
    for (const address of ADDRESSES) {
      const monitor = webhookFormat(null, alertUrl("ALERT_WEBHOOK_URL", address).url).format;
      seen.add(monitor);
      expect([address, detectedWebhookFormat(address)]).toEqual([address, monitor]);
    }
    expect([...seen].sort()).toEqual(["discord", "googlechat", "json", "slack", "text"]);
  });

  test("the formats a choice offers are the ones the monitor accepts, and no others", () => {
    for (const { value } of WEBHOOK_FORMATS) {
      expect([value, webhookFormat(value, null)]).toEqual([value, { format: value, problem: null }]);
    }
    // The monitor names its five in the order and the words of its refusal.
    const values = WEBHOOK_FORMATS.map((format) => format.value);
    expect(webhookFormat("telegram", null).problem).toBe(`ALERT_WEBHOOK_FORMAT must be ${values.slice(0, -1).join(", ")} or ${values.at(-1)}`);
  });

  test("the monitor reads the variables the page writes for the heartbeat, the webhook and the format", () => {
    const env = {
      SITESOLIDE_ZONE: ZONE,
      [variable("heartbeat")]: "https://hc-ping.test-zone.invalid/0b7c",
      [variable("webhook")]: "https://chat.test-zone.invalid/hook",
      [variable("format")]: "discord",
    };
    const read = readConfig(env);
    if (!("config" in read)) throw new Error(read.error);
    expect(read.config).toMatchObject({
      heartbeatUrl: "https://hc-ping.test-zone.invalid/0b7c",
      webhookUrl: "https://chat.test-zone.invalid/hook",
      webhookFormat: "discord",
      problems: [],
    });
    // A name the page did not write is none of the monitor's.
    const typo = readConfig({ SITESOLIDE_ZONE: ZONE, HEARTBEAT_ULR: env[variable("heartbeat")] });
    if (!("config" in typo)) throw new Error(typo.error);
    expect(typo.config.heartbeatUrl).toBeNull();
  });

  test("the monitor's unit reads the monitoring file, and the backup's the backups'", () => {
    const read = (path: string) =>
      unitEnvironment(readFileSync(join(PROJECT, "..", path), "utf8")).files.map((file) => file.path);
    const file = (name: string) => `${SECRETS_FOLDER}/${name}`;
    expect(read("infra/monitor/sitesolide-monitor.service")).toContain(file(settingById("heartbeat").file));
    expect(read("infra/backup/sitesolide-backup.service")).toContain(file(settingById("offsite").file));
    expect(read("infra/backup/sitesolide-restore@.service")).toContain(file(settingById("offsite").file));
  });

  test("every setting's file is one the steward lists for its project, and the passwords are its hash", () => {
    for (const setting of SETTINGS) expect([setting.id, PLATFORM_FILES[setting.slug]]).toEqual([setting.id, expect.arrayContaining([setting.file])]);
    for (const id of ["dashboard-password", "portal-password"] as const) expect(settingById(id).variables.map((one) => one.name)).toEqual([PASSWORD_VARIABLE]);
  });

  test("a restart applies the file the project's generated unit reads, and no other", () => {
    const manifests = { dashboard: join(PROJECT, "sitesolide.json"), portal: join(PROJECT, "..", "portal", "sitesolide.json") };
    let judged = 0;
    for (const [slug, path] of Object.entries(manifests)) {
      const manifest = readManifest(readFileSync(path, "utf8")).manifest;
      if (manifest === undefined) throw new Error(`${slug} has no readable manifest`);
      const read = new Set(unitEnvironment(generateUnit(manifest, { slug, zone: ZONE, contact: "" })).files.map((file) => file.path));
      for (const file of PLATFORM_FILES[slug]!) {
        expect([slug, file, appliesOnRestart(slug, file)]).toEqual([slug, file, read.has(`${SECRETS_FOLDER}/${file}`)]);
        judged += 1;
      }
    }
    expect(judged).toBe(4);
  });

  test("the steward never marks the monitor's or the backups' file pending, and the page never offers a restart for them", () => {
    for (const setting of SETTINGS) {
      const restart = appliesOnRestart(setting.slug, setting.file);
      expect([setting.id, unrestartedSentence(setting.slug, setting.file, "add") === null]).toEqual([setting.id, restart]);
    }
    expect(appliesOnRestart("dashboard", "dashboard-monitor.env")).toBe(false);
    expect(appliesOnRestart("dashboard", "dashboard-backup.env")).toBe(false);
  });

  test("the company sign-in is the portal's own list of sign-in settings, and the steward lets exactly those into portal.env", () => {
    const names = settingById("company-signin").variables.map((one) => one.name);
    expect(new Set(names)).toEqual(new Set(HASH_FILE_SETTINGS["portal.env"]));
    for (const name of names) expect([name, outsideHashRefusal("portal.env", name)]).toEqual([name, null]);
    expect(outsideHashRefusal("portal.env", "PORT")).not.toBeNull();
    // Nothing else is allowed in the dashboard's own file.
    for (const name of names) expect(outsideHashRefusal("dashboard.env", name)).not.toBeNull();
  });

  test("the portal needs the issuer, the client and its secret, and takes the rest as refinements", () => {
    const values: Record<string, string> = {
      OIDC_ISSUER: "https://idp.test-zone.invalid",
      OIDC_CLIENT_ID: "client",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_ALLOWED_DOMAINS: "test-zone.invalid",
      OIDC_ADMIN_EMAILS: "owner@test-zone.invalid",
      OIDC_PROVIDER_NAME: "Company",
    };
    const portal = "https://portal.test-zone.invalid";
    for (const { name, required } of settingById("company-signin").variables) {
      const { [name]: _left, ...rest } = values;
      expect([name, readSettings(rest, portal).settings !== null]).toEqual([name, !required]);
    }
    expect(readSettings(values, portal).settings).not.toBeNull();
  });

  test("the offsite copy needs the five the backups need, and takes the region and the prefix as refinements", () => {
    const required = settingById("offsite").variables.filter((one) => one.required).map((one) => one.name);
    expect(required).toEqual([...OFFSITE_VARIABLES]);
    const values: Record<string, string> = {
      BACKUP_S3_ENDPOINT: "https://s3.test-zone.invalid",
      BACKUP_S3_BUCKET: "bucket",
      BACKUP_S3_ACCESS_KEY_ID: "id",
      BACKUP_S3_SECRET_ACCESS_KEY: "secret",
      BACKUP_ENCRYPTION_PASSPHRASE: "a passphrase of enough characters",
      BACKUP_S3_REGION: "eu",
      BACKUP_S3_PREFIX: "server",
    };
    expect(settingById("offsite").variables.map((one) => one.name).sort()).toEqual(Object.keys(values).sort());
    for (const { name, required: needed } of settingById("offsite").variables) {
      const { [name]: _left, ...rest } = values;
      const offsite = offsiteFrom(rest);
      expect([name, needed ? offsite !== null && "error" in offsite : offsite !== null && !("error" in offsite)]).toEqual([name, true]);
    }
    const whole = offsiteFrom(values);
    expect(whole).toMatchObject({ region: "eu", prefix: "server" });
  });

  test("the words the page reads in the Issues are the server's", () => {
    const raw: Raw = {
      generated: NOW,
      zone: ZONE,
      folders: [],
      codes: "{}",
      domains: null,
      ports: [],
      blocks: {},
      machine: null,
      previous: null,
      monitor: JSON.stringify(buildStatus({ now: NOW - 30_000, zone: ZONE, checks: {}, heartbeat: "failed", webhook: "failed", undelivered: 2, unchecked: 0 })),
    };
    const snapshot = buildSnapshot(raw);
    expect(snapshot.discrepancies.filter((one) => one.slug === null).map((one) => one.label).sort()).toEqual([ALERTS_UNDELIVERED_LABEL, HEARTBEAT_FAILED_LABEL]);
  });

  test("the settings read the same alerting from the snapshot as from its Issues", () => {
    const file = (variables: string[]) => ({
      name: "dashboard-monitor.env",
      state: "managed" as const,
      reason: null,
      expected: "root:root 0600",
      variables,
      passwords: [],
      modifiedAt: NOW - 3_600_000,
      previous: false,
      restartPending: false,
    });
    const projects = [{ slug: "dashboard", service: null, files: [file(["HEARTBEAT_URL", "ALERT_WEBHOOK_URL"])], portal: { requested: false, installed: false, modifiable: false, reason: null }, store: null }];
    const monitor = (heartbeat: "ok" | "failed" | "unconfigured", webhook: "ok" | "failed" | "unconfigured" | "idle", undelivered: number) =>
      JSON.stringify(buildStatus({ now: NOW - 30_000, zone: ZONE, checks: {}, heartbeat, webhook, undelivered, unchecked: 0 }));
    const stand = (monitorText: string) => {
      const snapshot = buildSnapshot({ generated: NOW, zone: ZONE, folders: [], codes: "{}", domains: null, ports: [], blocks: {}, machine: null, previous: null, monitor: monitorText });
      const withField = settingState(projects, snapshot.discrepancies, snapshot.alerting);
      const withoutField = settingState(projects, snapshot.discrepancies, undefined);
      return { withField, withoutField };
    };
    const failing = stand(monitor("failed", "failed", 2));
    expect(failing.withField["heartbeat"].channel).toBe("failed");
    expect(failing.withField["webhook"]).toMatchObject({ channel: "failed", undelivered: 2 });
    expect(failing.withoutField["heartbeat"].channel).toBe("failed");
    expect(failing.withoutField["webhook"].channel).toBe("failed");
    const working = stand(monitor("ok", "idle", 0));
    expect(working.withField["heartbeat"].channel).toBe("ok");
    expect(working.withField["webhook"].channel).toBe("idle");
    // Without the field, a page cannot tell that all is well, and says it does not know.
    expect(working.withoutField["heartbeat"].channel).toBe("unknown");
  });
});
