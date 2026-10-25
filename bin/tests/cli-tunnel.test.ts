import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePlan, planTunnelRecords, tunnelManualRecords, type DnsRecord } from "../cli/cloudflare";
import { firewallCheck, firewallPorts, firewallRun } from "../cli/harden";
import {
  CADDY_TUNNEL_FILE,
  isTunnelId,
  NO_CREDENTIALS_EXIT,
  PACKAGE_UNIT,
  readTunnelCredentials,
  tunnelConditions,
  tunnelConfig,
  tunnelRun,
  tunnelTarget,
  TUNNEL_CONFIG,
  TUNNEL_CREDENTIALS,
  TUNNEL_KIT_FILES,
  TUNNEL_METRICS,
  TUNNEL_UNIT,
  type TunnelFiles,
} from "../cli/tunnel";

/**
 * A machine served through a Cloudflare Tunnel, bin/cli/tunnel.ts: the
 * credentials read without ever being shown, the connector's configuration,
 * the run's order, the zone's records, the firewall, and the kit's two files
 * as the machine gets them. setup's whole sequence under --tunnel is
 * cli-setup-tunnel.test.ts's.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ZONE = "test-zone.invalid";
const ID = "6f1c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "c2VjcmV0LW9mLXRoZS10dW5uZWwtZm9yLXRlc3RzLW9ubHktMTIzNA==";

function files(): TunnelFiles {
  const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
  return { zone: ZONE, id: ID, unit: read(TUNNEL_KIT_FILES.unit), caddy: read(TUNNEL_KIT_FILES.caddy) };
}

describe("the tunnel's credentials", () => {
  test("the file cloudflared tunnel create writes is read, down to its three fields", () => {
    const text = JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET, TunnelID: ID, Endpoint: "" });
    const read = readTunnelCredentials(text);
    expect(read).toEqual({ id: ID, text: `{"AccountTag":"${ACCOUNT}","TunnelSecret":"${SECRET}","TunnelID":"${ID}"}\n` });
  });

  test("anything else is refused, with a problem that names a field and never a value", () => {
    const cases = [
      "not json",
      "[]",
      JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET }),
      JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET, TunnelID: "not-an-id" }),
      JSON.stringify({ AccountTag: "x", TunnelSecret: SECRET, TunnelID: ID }),
      JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: "short", TunnelID: ID }),
      JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: `${SECRET}\nUser=root`, TunnelID: ID }),
    ];
    for (const text of cases) {
      const read = readTunnelCredentials(text);
      expect("problem" in read).toBe(true);
      expect(JSON.stringify(read)).not.toContain(SECRET.slice(0, 20));
      expect(JSON.stringify(read)).not.toContain(ACCOUNT);
    }
  });

  test("an id is told from a file's path", () => {
    expect(isTunnelId(ID)).toBe(true);
    expect(isTunnelId("~/.cloudflared/6f1c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f.json")).toBe(false);
    expect(isTunnelId(ID.toUpperCase())).toBe(false);
  });
});

describe("the connector's configuration", () => {
  test("the zone and its wildcard go to Caddy on the loopback, with their own name as SNI; anything else 404", () => {
    const config = tunnelConfig(ZONE, ID);
    expect(config).toContain(`tunnel: ${ID}\n`);
    expect(config).toContain(`metrics: ${TUNNEL_METRICS}\n`);
    expect(config).toContain(`  - hostname: ${ZONE}\n    service: https://127.0.0.1:443\n    originRequest:\n      matchSNItoHost: true\n      noTLSVerify: true\n`);
    expect(config).toContain(`  - hostname: "*.${ZONE}"\n    service: https://127.0.0.1:443\n`);
    expect(config.trimEnd().endsWith("  - service: http_status:404")).toBe(true);
    // The credentials are the unit's to hand over, from systemd's copy.
    expect(config).not.toContain("credentials-file");
    expect(() => tunnelConfig(ZONE, "x\ningress: []")).toThrow();
  });

  test("its metrics sit outside the ports cloudflared takes by default, where a second connector would answer for it", () => {
    const port = Number(TUNNEL_METRICS.split(":")[1]);
    expect(TUNNEL_METRICS.startsWith("127.0.0.1:")).toBe(true);
    expect(port >= 20241 && port <= 20245).toBe(false);
  });

  test("the records point at the tunnel's own name", () => {
    expect(tunnelTarget(ID)).toBe(`${ID}.cfargotunnel.com`);
  });
});

describe("the step's run", () => {
  test("credentials given are laid 0600 through a heredoc, and named nowhere else in the script", () => {
    const text = readTunnelCredentials(JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET, TunnelID: ID }));
    if ("problem" in text) throw new Error(text.problem);
    const script = tunnelRun(files(), text.text);
    expect(script.split(SECRET).length - 1).toBe(1);
    expect(script).toContain(`cat > "$next" <<'CREDENTIALS'\n${text.text}CREDENTIALS\nchmod 600 "$next"`);
    expect(script).toContain(`mv -f "$next" ${TUNNEL_CREDENTIALS}`);
    expect(script).not.toContain(`/etc/cloudflared/${ID}.json`);
  });

  test("without them, the machine's own file for this tunnel is taken, or the run says it has none", () => {
    const script = tunnelRun(files(), null);
    expect(script).toContain(`install -m 600 -o root -g root /etc/cloudflared/${ID}.json ${TUNNEL_CREDENTIALS}`);
    expect(script).toContain(`exit ${NO_CREDENTIALS_EXIT}`);
    expect(script).not.toContain("CREDENTIALS\n");
  });

  test("the connector is up and connected before the package's own is stopped, and Caddy reloaded after", () => {
    const script = tunnelRun(files(), null);
    const restart = script.indexOf(`systemctl restart ${TUNNEL_UNIT}`);
    const ready = script.indexOf(`http://${TUNNEL_METRICS}/ready`);
    const second = script.indexOf(`systemctl disable --now ${PACKAGE_UNIT}`);
    const reload = script.indexOf("systemctl reload caddy");
    expect(restart).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(restart);
    expect(second).toBeGreaterThan(ready);
    expect(reload).toBeGreaterThan(second);
    // Never Caddy's own commands, which address whatever instance runs (CLAUDE.md).
    expect(script).not.toMatch(/caddy (stop|start)\b/);
  });

  test("Caddy is reloaded only when its file changed under a Caddyfile that imports it, and the previous file comes back if Caddy refuses it", () => {
    const script = tunnelRun(files(), null);
    expect(script).toContain(`if [ -n "$changed" ] && grep -Eq '^[[:space:]]*import /etc/caddy/global\\.d/' /etc/caddy/Caddyfile 2>/dev/null && systemctl is-active --quiet caddy; then`);
    expect(script).toContain(`if [ -n "$previous" ]; then mv -f "$previous" ${CADDY_TUNNEL_FILE}; else rm -f ${CADDY_TUNNEL_FILE}; fi`);
  });

  test("every file is replaced whole or not at all, and only when its text differs", () => {
    const script = tunnelRun(files(), null);
    for (const path of [TUNNEL_CONFIG, "/etc/systemd/system/sitesolide-tunnel.service", CADDY_TUNNEL_FILE]) {
      expect(script).toContain(`if cmp -s "$next" ${path}; then rm -f "$next"; else mv -f "$next" ${path};`);
    }
  });

  test("the check reads the connector connected, its files the kit's, and no second connector", () => {
    const labels = tunnelConditions(files()).map((condition) => condition.label);
    expect(labels).toEqual([
      "cloudflared-package",
      "tunnel-credentials",
      "tunnel-credentials-permissions",
      "tunnel-config",
      "tunnel-config-permissions",
      "tunnel-unit",
      "tunnel-unit-permissions",
      "tunnel-caddy",
      "tunnel-caddy-permissions",
      "tunnel-enabled",
      "tunnel-active",
      "tunnel-ready",
      "no-second-connector",
    ]);
  });
});

describe("the zone's records behind a tunnel", () => {
  const target = tunnelTarget(ID);
  let counter = 0;
  const record = (name: string, type: string, content: string, proxied = false): DnsRecord => ({ id: `r${++counter}`, name, type, content, proxied, ttl: 1 });

  test("an empty zone gets two proxied CNAMEs", () => {
    const actions = planTunnelRecords([], ZONE, target, false);
    expect(actions).toEqual([
      { kind: "create", name: ZONE, type: "CNAME", content: target, proxied: true },
      { kind: "create", name: `*.${ZONE}`, type: "CNAME", content: target, proxied: true },
    ]);
    expect(describePlan(actions)).toEqual([`created ${ZONE} CNAME ${target}, proxied`, `created *.${ZONE} CNAME ${target}, proxied`]);
  });

  test("a zone that pointed at a machine conflicts, unless replaced", () => {
    const existing = [record(ZONE, "A", "203.0.113.10"), record(`*.${ZONE}`, "A", "203.0.113.10"), record(ZONE, "MX", "mail.example.invalid")];
    expect(planTunnelRecords(existing, ZONE, target, false).filter((action) => action.kind === "conflict")).toHaveLength(2);
    const replaced = planTunnelRecords(existing, ZONE, target, true);
    expect(replaced.map((action) => action.kind)).toEqual(["delete", "create", "delete", "create"]);
    // The MX is none of setup's business.
    expect(replaced.some((action) => "record" in action && action.record.type === "MX")).toBe(false);
  });

  test("the tunnel's own CNAMEs are kept; left DNS only, they go into the proxy; pointing elsewhere, they conflict", () => {
    expect(planTunnelRecords([record(ZONE, "CNAME", target, true), record(`*.${ZONE}`, "CNAME", `${target.toUpperCase()}.`, true)], ZONE, target, false).map((a) => a.kind)).toEqual(["keep", "keep"]);
    const unproxied = planTunnelRecords([record(ZONE, "CNAME", target), record(`*.${ZONE}`, "CNAME", target, true)], ZONE, target, false);
    expect(unproxied[0]).toMatchObject({ kind: "update", content: target, proxied: true });
    const elsewhere = planTunnelRecords([record(ZONE, "CNAME", "other.cfargotunnel.com", true)], ZONE, target, false);
    expect(elsewhere[0]).toMatchObject({ kind: "conflict", reason: "points at other.cfargotunnel.com, not at the tunnel" });
    expect(planTunnelRecords([record(ZONE, "CNAME", "other.cfargotunnel.com", true)], ZONE, target, true)[0]).toMatchObject({ kind: "update", content: target });
  });

  test("by hand, the same two records", () => {
    expect(tunnelManualRecords(ZONE, target)).toEqual([
      `${ZONE}    CNAME ${target}   proxied, TTL auto`,
      `*.${ZONE}  CNAME ${target}   proxied, TTL auto`,
    ]);
  });
});

describe("the firewall behind a tunnel", () => {
  test("ssh alone is open, and the web's ports closed when an earlier run opened them", () => {
    expect(firewallPorts(22, true)).toEqual([22]);
    expect(firewallPorts(22)).toEqual([22, 80, 443]);
    const run = firewallRun(22, true);
    expect(run).toContain(`for port in 22; do ufw allow "$port/tcp"`);
    expect(run).toContain(`for port in 80 443; do ufw delete allow "$port/tcp"`);
    expect(firewallRun(22)).not.toContain("delete");
    expect(firewallCheck(22, true)).toContain("ufw-443-closed");
    // ssh answering on 443 stays open.
    expect(firewallPorts(443, true)).toEqual([443]);
    expect(firewallRun(443, true)).toContain(`for port in 80; do ufw delete allow`);
  });
});

describe("the kit's files", () => {
  const unit = readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.unit), "utf8");
  const caddy = readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8");

  test("the unit runs the configuration setup lays, its credentials handed over by systemd, as nobody in particular", () => {
    expect(unit).toContain(`ExecStart=/usr/bin/cloudflared --no-autoupdate --config ${TUNNEL_CONFIG} tunnel run --credentials-file %d/tunnel.json\n`);
    expect(unit).toContain(`LoadCredential=tunnel.json:${TUNNEL_CREDENTIALS}\n`);
    expect(unit).toContain("DynamicUser=true\n");
    expect(unit).toContain("CapabilityBoundingSet=\n");
    expect(unit).toContain("InaccessiblePaths=-/etc/sitesolide -/etc/caddy");
    // The home network the machine may sit on is out of its reach.
    expect(unit).toMatch(/^IPAddressDeny=.*192\.168\.0\.0\/16/m);
    expect(unit).toContain(`${TUNNEL_METRICS}, which the monitor reads`);
  });

  test("Caddy trusts the loopback alone, and that one header from it", () => {
    const directives = caddy.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(directives).toEqual(["servers {", "\ttrusted_proxies static 127.0.0.1/32 ::1/128", "\tclient_ip_headers Cf-Connecting-Ip", "}"]);
  });

  test("the Caddyfile imports the folder by glob in its global options, which a machine served directly leaves empty", () => {
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const global = caddyfile.slice(caddyfile.indexOf("\n{\n"), caddyfile.indexOf("\n}\n") + 1);
    expect(global).toContain(`\timport ${CADDY_TUNNEL_FILE.slice(0, CADDY_TUNNEL_FILE.lastIndexOf("/"))}/*.caddy\n`);
  });
});

const CADDY = Bun.which("caddy");

describe.skipIf(CADDY === null)("the tunnel's options, in Caddy", () => {
  let folder = "";
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tunnel-caddy-"));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  /** The Caddyfile's own global block, its imports moved into the test's folder, and one site. */
  function adapt(withTunnel: boolean): Record<string, unknown> {
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const global = caddyfile.slice(caddyfile.indexOf("\n{\n") + 1, caddyfile.indexOf("\n}\n") + 3).replaceAll("/etc/caddy/", `${folder}/`);
    rmSync(join(folder, "global.d"), { recursive: true, force: true });
    mkdirSync(join(folder, "global.d"));
    if (withTunnel) writeFileSync(join(folder, "global.d", "tunnel.caddy"), readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8"));
    writeFileSync(join(folder, "Caddyfile"), `${global.replace("{$SITESOLIDE_ACME_EMAIL}", "ops@test-zone.invalid")}\nhttp://site.test-zone.invalid {\n\trespond ok\n}\n`);
    const run = Bun.spawnSync([CADDY!, "adapt", "--config", join(folder, "Caddyfile")], { stdout: "pipe", stderr: "pipe" });
    expect({ code: run.exitCode, said: run.exitCode === 0 ? "" : run.stderr.toString() }).toEqual({ code: 0, said: "" });
    return JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  }

  test("with the file, every server trusts the loopback for Cf-Connecting-Ip; without it, nothing is trusted", () => {
    const servers = (json: Record<string, unknown>) => Object.values(((json.apps as Record<string, unknown>).http as { servers: Record<string, Record<string, unknown>> }).servers);
    const trusted = servers(adapt(true));
    expect(trusted.length).toBeGreaterThan(0);
    for (const server of trusted) {
      expect(server.trusted_proxies).toEqual({ ranges: ["127.0.0.1/32", "::1/128"], source: "static" });
      expect(server.client_ip_headers).toEqual(["Cf-Connecting-Ip"]);
    }
    for (const server of servers(adapt(false))) {
      expect(server.trusted_proxies).toBeUndefined();
      expect(server.client_ip_headers).toBeUndefined();
    }
  });
});
