import { describe, expect, test } from "bun:test";
import type { Notice, Tracked } from "../src/alerts";
import { TEST_TREE_FLAG, readConfig } from "../src/config";
import { MAX_OUTBOX, OUTBOX_MAX_AGE_MS, STATE_VERSION, emptyState, parseState, trimOutbox, type State } from "../src/store";

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

const TRACKED: Tracked = {
  kind: "caddy",
  label: "caddy",
  severity: "critical",
  slug: null,
  status: "down",
  streak: 0,
  since: T0,
  summary: "Caddy is inactive (dead), result success",
};

function notice(at: number, id = "caddy"): Notice {
  return { event: "down", id, kind: "caddy", label: "caddy", severity: "critical", slug: null, summary: "x", at, since: at };
}

describe("the memory between two runs", () => {
  test("no file is a first run, said nowhere", () => {
    expect(parseState(null)).toEqual({ state: emptyState(), problem: null });
  });

  test("what was written is read back", () => {
    const state: State = { version: STATE_VERSION, checks: { caddy: TRACKED }, restarts: { count: 2, increasedAt: T0 }, outbox: [notice(T0)] };
    expect(parseState(JSON.stringify(state))).toEqual({ state, problem: null });
  });

  test("a truncated or foreign file is a fresh start with a reason, never a crash", () => {
    expect(parseState('{"version": 1, "checks": {')).toEqual({ state: emptyState(), problem: "state.json is not valid JSON, starting afresh" });
    expect(parseState('{"version": 99}').problem).toBe("state.json is from another version, starting afresh");
    expect(parseState("[]").state).toEqual(emptyState());
  });

  test("one malformed check is dropped, the others kept", () => {
    const text = JSON.stringify({
      version: STATE_VERSION,
      checks: { caddy: TRACKED, broken: { ...TRACKED, status: "sideways" }, other: "nonsense" },
      restarts: { count: "two" },
      outbox: [notice(T0), { event: "exploded" }],
    });
    const { state } = parseState(text);
    expect(Object.keys(state.checks)).toEqual(["caddy"]);
    expect(state.restarts).toBeNull();
    expect(state.outbox).toEqual([notice(T0)]);
  });

  test("the outbox keeps a day and fifty notices at most, the newest", () => {
    const old = notice(T0 - OUTBOX_MAX_AGE_MS - 1, "old");
    const recent = Array.from({ length: MAX_OUTBOX + 10 }, (_, index) => notice(T0 - index * 1000, `n${index}`));
    const kept = trimOutbox([old, ...recent.reverse()], T0);
    expect(kept).toHaveLength(MAX_OUTBOX);
    expect(kept.some((n) => n.id === "old")).toBe(false);
    expect(kept.at(-1)!.id).toBe("n0");
  });
});

describe("the configuration", () => {
  test("no zone, no run: none is assumed", () => {
    const read = readConfig({});
    expect("error" in read && read.error).toContain("SITESOLIDE_ZONE is missing");
  });

  const MACHINE = {
    zone: "test-zone.invalid",
    sitesDir: "/srv/sites",
    domainsFile: "/etc/caddy/domaines.map",
    stateDir: "/var/lib/sitesolide-monitor",
    backupFile: "/var/lib/sitesolide-backup/last-run.json",
    diskPaths: ["/", "/srv", "/var"],
    probe: { address: "127.0.0.1", port: 443, ca: null },
    heartbeatUrl: null,
    webhookUrl: null,
    webhookFormat: "json",
    problems: [],
  };

  /**
   * What dashboard-monitor.env, edited from the dashboard, could add to the
   * alerting it is meant for: each one blinds the monitor without a word, no
   * disk checked, every probe answered by somebody else, no backup read.
   */
  const BLINDING = {
    SITES_DIR: "/nonexistent",
    DOMAINS_FILE: "/dev/null",
    PROBE_ADDRESS: "192.0.2.1",
    PROBE_PORT: "8443",
    DISK_PATHS: "",
    BACKUP_STATUS_FILE: "/nonexistent.json",
    STATE_DIRECTORY: "/tmp/elsewhere",
  };

  test("in production, the machine's paths whatever the environment says: only the zone and the alerting are read", () => {
    const read = readConfig({ SITESOLIDE_ZONE: "test-zone.invalid", ...BLINDING });
    if (!("config" in read)) throw new Error("expected a configuration");
    expect(read.config).toMatchObject(MACHINE);
    expect(readConfig({ SITESOLIDE_ZONE: "test-zone.invalid", PROBE_PORT: "https" })).toHaveProperty("config");
  });

  test("on a test tree, given by an argument the unit never passes, every path is overridable", () => {
    expect(TEST_TREE_FLAG).toBe("--test-tree");
    const plain = readConfig({ SITESOLIDE_ZONE: "test-zone.invalid" }, { testTree: true });
    if (!("config" in plain)) throw new Error("expected a configuration");
    expect(plain.config).toMatchObject(MACHINE);
    const custom = readConfig({ SITESOLIDE_ZONE: "test-zone.invalid", STATE_DIRECTORY: "/tmp/x", PROBE_PORT: "8443", DISK_PATHS: "/, /data" }, { testTree: true });
    if (!("config" in custom)) throw new Error("expected a configuration");
    expect(custom.config).toMatchObject({ stateDir: "/tmp/x", probe: { port: 8443 }, diskPaths: ["/", "/data"] });
    expect(readConfig({ SITESOLIDE_ZONE: "test-zone.invalid", PROBE_PORT: "https" }, { testTree: true })).toEqual({ error: "PROBE_PORT is not a port" });
  });

  test("an alerting address in plain http is refused, the loopback of a test tree aside", () => {
    const env = { SITESOLIDE_ZONE: "test-zone.invalid", HEARTBEAT_URL: "http://hc.test-zone.invalid/ping/secret", ALERT_WEBHOOK_URL: "http://127.0.0.1:8080/hook" };
    const production = readConfig(env);
    if (!("config" in production)) throw new Error("expected a configuration");
    expect(production.config).toMatchObject({ heartbeatUrl: null, webhookUrl: null });
    expect(production.config.problems).toEqual(["HEARTBEAT_URL must be an https URL", "ALERT_WEBHOOK_URL must be an https URL"]);

    const tree = readConfig(env, { testTree: true });
    if (!("config" in tree)) throw new Error("expected a configuration");
    expect(tree.config).toMatchObject({ heartbeatUrl: null, webhookUrl: "http://127.0.0.1:8080/hook" });
    expect(tree.config.problems).toEqual(["HEARTBEAT_URL must be an https URL"]);
  });

  test("a wrong alerting address is a problem of the monitor, the channel stays silent", () => {
    const read = readConfig({
      SITESOLIDE_ZONE: "test-zone.invalid",
      HEARTBEAT_URL: "hc-ping-secret",
      ALERT_WEBHOOK_URL: "https://hooks.test-zone.invalid/T000/B000/secret",
      ALERT_WEBHOOK_FORMAT: "yaml",
    });
    if (!("config" in read)) throw new Error("expected a configuration");
    expect(read.config.heartbeatUrl).toBeNull();
    expect(read.config.webhookUrl).toBe("https://hooks.test-zone.invalid/T000/B000/secret");
    expect(read.config.problems).toEqual(["HEARTBEAT_URL is not a URL", "ALERT_WEBHOOK_FORMAT must be slack, discord, googlechat, text or json"]);
    expect(read.config.problems.join(" ")).not.toContain("secret");
  });
});
