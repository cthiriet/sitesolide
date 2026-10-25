import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePlan, planTunnelRecords, tunnelManualRecords, tunnelRecordLines, type DnsRecord } from "../cli/cloudflare";
import { generateFragment } from "../cli/fragment";
import { firewallCheck, firewallPorts, firewallRun, webPortsCheck, webPortsRun } from "../cli/harden";
import { domainHosts, type Manifest } from "../cli/manifest";
import { CLOUDFLARE_POLICY, tlsZoneContent } from "../cli/tls";
import {
  CADDY_TUNNEL_FILE,
  caddyHandshakeCommand,
  caddyReasonCommand,
  domainCarriers,
  EDGE_TRACE_PATH,
  edgeOrigin,
  isTunnelId,
  NO_CREDENTIALS_EXIT,
  PACKAGE_UNIT,
  readCaddyHandshake,
  readCaddyReason,
  readEdgeTrace,
  readTunnelCredentials,
  tunnelConditions,
  tunnelConfig,
  tunnelRouteProblem,
  tunnelRun,
  tunnelTarget,
  TUNNEL_CONFIG,
  TUNNEL_CREDENTIALS,
  TUNNEL_KIT_FILES,
  TUNNEL_METRICS,
  TUNNEL_UNIT,
  TUNNEL_UNIT_FILE,
  TUNNEL_ACCOUNT,
  TUNNEL_AFTER_UPGRADE,
  TUNNEL_AFTER_UPGRADE_CONTENT,
  TUNNEL_UPGRADES,
  TUNNEL_UPGRADES_CONTENT,
  type EdgeReading,
  type TunnelFiles,
} from "../cli/tunnel";
import { TUNNEL_ORIGIN } from "../cli/loopback";

/**
 * A machine served through a Cloudflare Tunnel, bin/cli/tunnel.ts: the
 * credentials read without ever being shown, the connector's configuration,
 * the run's order, the zone's records, the firewall, the kit's two files as
 * the machine gets them, and what `domain --activate` reads of a site's own
 * domain there. setup's whole sequence under --tunnel is
 * cli-setup-tunnel.test.ts's, and the activation's, run for real in a dry
 * run, e2e/deployment.test.ts's.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ZONE = "test-zone.invalid";
const ID = "6f1c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "c2VjcmV0LW9mLXRoZS10dW5uZWwtZm9yLXRlc3RzLW9ubHktMTIzNA==";

function files(): TunnelFiles {
  const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
  return { id: ID, unit: read(TUNNEL_KIT_FILES.unit), caddy: read(TUNNEL_KIT_FILES.caddy) };
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
  test("every name goes to Caddy on ::1, with its own name as SNI, in one rule that names none", () => {
    const config = tunnelConfig(ID);
    expect(config).toContain(`tunnel: ${ID}\n`);
    expect(config).toContain(`metrics: ${TUNNEL_METRICS}\n`);
    // ::1, the one address Caddy believes Cf-Connecting-Ip from, and the
    // loopback rule keeps to the connector: never 127.0.0.1, which everyone uses.
    expect(TUNNEL_ORIGIN).toBe("::1");
    // The whole ingress: Cloudflare routes into the tunnel the names whose
    // records point at it, a site's own domain among them, and Caddy decides
    // by host what it serves. No name to keep in step, no 404 of the
    // connector's own.
    expect(config.slice(config.indexOf("ingress:\n"))).toBe("ingress:\n  - service: https://[::1]:443\n    originRequest:\n      matchSNItoHost: true\n      noTLSVerify: true\n");
    expect(config).not.toContain("hostname:");
    expect(config).not.toContain("http_status");
    expect(config).not.toContain("127.0.0.1:443");
    // The credentials are the unit's to hand over, from systemd's copy.
    expect(config).not.toContain("credentials-file");
    expect(() => tunnelConfig("x\ningress: []")).toThrow();
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

  test("a loopback without ::1 is refused before anything; the account is made before the unit that names it", () => {
    const script = tunnelRun(files(), null);
    const ipv6 = script.indexOf("/proc/net/if_inet6");
    expect(ipv6).toBeGreaterThan(0);
    expect(ipv6).toBeLessThan(script.indexOf("dpkg-query"));
    // The static account alone: a unit from before it runs as a dynamic one
    // of the same name, which id and useradd would otherwise take for it.
    const account = script.indexOf(`SYSTEMD_NSS_DYNAMIC_BYPASS=1 useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${TUNNEL_ACCOUNT}`);
    expect(account).toBeGreaterThan(0);
    expect(account).toBeLessThan(script.indexOf(`mv -f "$next" ${TUNNEL_UNIT_FILE}`));
    // Restarted until it runs as that account, whose uid the loopback rule names.
    expect(script).toContain(`|| ! { pid=$(systemctl show -p MainPID --value ${TUNNEL_UNIT}) && [ "$pid" != 0 ] && [ "$(stat -c %u /proc/$pid)" = "$(SYSTEMD_NSS_DYNAMIC_BYPASS=1 id -u ${TUNNEL_ACCOUNT})" ]; }; then`);
    expect(Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script), stderr: "pipe" }).exitCode).toBe(0);
  });

  test("::1 is read in the kernel's list of IPv6 addresses, as Debian 13 writes it", () => {
    const test = tunnelConditions(files()).find((condition) => condition.label === "loopback-ipv6")!.test;
    const folder = mkdtempSync(join(tmpdir(), "tunnel-ipv6-"));
    try {
      // Recorded on the test machine, Debian 13 on arm64; the second without ::1.
      const lists = {
        with: "00000000000000000000000000000001 01 80 10 80       lo\nfe80000000000000505555fffeb38da2 02 40 20 80     eth0\n",
        without: "fe80000000000000505555fffeb38da2 02 40 20 80     eth0\n",
      };
      const verdicts = Object.entries(lists).map(([name, text]) => {
        writeFileSync(join(folder, name), text);
        return [name, Bun.spawnSync(["sh", "-c", test.replace("/proc/net/if_inet6", join(folder, name))]).exitCode];
      });
      expect(Object.fromEntries(verdicts)).toEqual({ with: 0, without: 1 });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
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
      "loopback-ipv6",
      "cloudflared-package",
      "tunnel-credentials",
      "tunnel-credentials-permissions",
      "tunnel-config",
      "tunnel-config-permissions",
      "tunnel-account",
      "tunnel-unit",
      "tunnel-unit-permissions",
      "tunnel-caddy",
      "tunnel-caddy-permissions",
      "tunnel-upgrades",
      "tunnel-upgrades-permissions",
      "tunnel-after-upgrade",
      "tunnel-after-upgrade-permissions",
      "tunnel-enabled",
      "tunnel-active",
      "tunnel-as-account",
      "tunnel-ready",
      "no-second-connector",
    ]);
  });
});

describe("cloudflared kept current", () => {
  test("its repository among the security updates, and the connector restarted once dpkg replaced its binary", () => {
    expect(TUNNEL_UPGRADES_CONTENT).toContain('Unattended-Upgrade::Origins-Pattern { "origin=cloudflared,label=cloudflared"; };');
    expect(TUNNEL_UPGRADES_CONTENT).toContain(`DPkg::Post-Invoke { "${TUNNEL_AFTER_UPGRADE} || true"; };`);
    // The change time: dpkg sets the modification time to the package's build date.
    expect(TUNNEL_AFTER_UPGRADE_CONTENT).toContain("stat -c %Z /usr/bin/cloudflared");
    expect(TUNNEL_AFTER_UPGRADE_CONTENT).toContain(`systemctl try-restart ${TUNNEL_UNIT}`);
    const run = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(TUNNEL_AFTER_UPGRADE_CONTENT), stderr: "pipe" });
    expect(run.exitCode).toBe(0);
  });

  test("laid once the connector runs, so that laying them restarts nothing", () => {
    const script = tunnelRun(files(), null);
    expect(script.indexOf(TUNNEL_UPGRADES)).toBeGreaterThan(script.indexOf(`systemctl restart ${TUNNEL_UNIT}`));
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

describe("a site's own domain behind a tunnel", () => {
  const target = tunnelTarget(ID);
  const DOMAIN = "shop.example";

  /** The trace Cloudflare's edge answers at /cdn-cgi/trace, as it writes it. */
  const trace = (name: string) =>
    [`fl=29f512`, `h=${name}`, "ip=203.0.113.7", "ts=1792946441.066", "visit_scheme=https", "uag=Bun/1.3.11", "colo=CDG", "sliver=none", "http=http/1.1", "loc=FR", "tls=TLSv1.3", "sni=plaintext", "warp=off", "gateway=off", "rbi=off", "kex=X25519", ""].join("\n");

  test("the edge's trace is read at the path every proxied name answers", () => {
    expect(EDGE_TRACE_PATH).toBe("/cdn-cgi/trace");
    expect(readEdgeTrace(trace(DOMAIN), DOMAIN)).toBe(true);
    expect(readEdgeTrace(trace(DOMAIN), "SHOP.example")).toBe(true);
  });

  test("anything else is no trace of the edge: another name's, a page, a trace with no location", () => {
    expect(readEdgeTrace(trace(`www.${DOMAIN}`), DOMAIN)).toBe(false);
    expect(readEdgeTrace("<!doctype html><title>shop</title>h=shop.example", DOMAIN)).toBe(false);
    expect(readEdgeTrace(trace(DOMAIN).replace("colo=CDG", "colo="), DOMAIN)).toBe(false);
    expect(readEdgeTrace("", DOMAIN)).toBe(false);
  });

  test("its records are one proxied CNAME to the tunnel per name the table adds, in the zone's own format", () => {
    const names = domainHosts({ name: DOMAIN, aliases: ["old-shop.example"] });
    expect(names).toEqual([DOMAIN, `www.${DOMAIN}`, "old-shop.example", "www.old-shop.example"]);
    expect(tunnelRecordLines(names, target)).toEqual([
      `${DOMAIN}          CNAME ${target}   proxied, TTL auto`,
      `www.${DOMAIN}      CNAME ${target}   proxied, TTL auto`,
      `old-shop.example      CNAME ${target}   proxied, TTL auto`,
      `www.old-shop.example  CNAME ${target}   proxied, TTL auto`,
    ]);
    // The zone's two, under --skip-dns, are the same lines for its two names.
    expect(tunnelRecordLines([ZONE, `*.${ZONE}`], target)).toEqual(tunnelManualRecords(ZONE, target));
  });

  test("what an origin's failure says: the connector's 502, the edge's own 520 to 526 for an address", () => {
    expect(edgeOrigin("502")).toBe("tunnel");
    for (const code of ["520", "521", "522", "523", "524", "525", "526"]) expect(edgeOrigin(code)).toBe("address");
    for (const code of ["200", "404", "500", "503", "527", "530", "unreachable: ENOTFOUND"]) expect(edgeOrigin(code)).toBeNull();
  });

  test("a name reaches the tunnel when the edge serves it and its root answers the connector's 502, before activation", () => {
    const server = "203.0.113.10";
    const reading = (fields: Partial<EdgeReading>): EdgeReading => ({ name: DOMAIN, here: false, edge: true, root: "502", ...fields });
    expect(tunnelRouteProblem(reading({}), server)).toBeNull();
    // A record from before the tunnel, DNS only, still pointing at the machine.
    expect(tunnelRouteProblem(reading({ here: true, edge: false, root: null }), server)).toContain(`${DOMAIN} points at ${server}, a record from before the tunnel`);
    // Not proxied by Cloudflare, or no edge certificate yet.
    expect(tunnelRouteProblem(reading({ edge: false, root: null }), server)).toContain(`https://${DOMAIN}/cdn-cgi/trace answers no trace of Cloudflare's`);
    // Proxied, but at an address: the edge's own 52x, never the tunnel's.
    for (const root of ["521", "522", "523"]) {
      expect(tunnelRouteProblem(reading({ root }), server)).toContain(`answers ${root}, Cloudflare's own answer for an origin it reaches by its address`);
    }
    // Anything else is not taken for an address: a host that answers is not caught.
    for (const root of ["200", "403", "unreachable: timed out"]) expect(tunnelRouteProblem(reading({ root }), server)).toBeNull();
  });

  test("the files that carry a site's own domain are the connector's configuration and Caddy's options, as this release lays them", () => {
    const caddy = readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8");
    expect(domainCarriers(ID, caddy)).toEqual([
      { path: TUNNEL_CONFIG, content: tunnelConfig(ID) },
      { path: CADDY_TUNNEL_FILE, content: caddy },
    ]);
    // The very files the tunnel's step lays and checks, upgrade's too.
    const checked = tunnelConditions(files()).filter((condition) => condition.label === "tunnel-config" || condition.label === "tunnel-caddy");
    expect(checked.map((condition) => condition.test.includes(TUNNEL_CONFIG) || condition.test.includes(CADDY_TUNNEL_FILE))).toEqual([true, true]);
  });

  /** A folder holding `name`, a stand-in for a command of the machine, first on the PATH. */
  function standInCommand(name: string, script: string): { path: string; remove: () => void } {
    const folder = mkdtempSync(join(tmpdir(), `stand-in-${name}-`));
    writeFileSync(join(folder, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { path: `${folder}:${process.env.PATH ?? ""}`, remove: () => rmSync(folder, { recursive: true, force: true }) };
  }

  test("the handshake is read on the loopback, verified, the name quoted, and tells Caddy's answer from a refusal", () => {
    const command = caddyHandshakeCommand(DOMAIN);
    expect(command).toContain(`--resolve '${DOMAIN}:443:127.0.0.1' 'https://${DOMAIN}/'`);
    expect(command).not.toMatch(/ -k | --insecure/);
    expect(caddyHandshakeCommand("a'b")).toContain(`'a'\\''b:443:127.0.0.1'`);
    // Run for real against a curl that answers as Caddy would: a status, or
    // curl's exit 35 and 000 for a handshake Caddy refuses.
    for (const [script, expected] of [
      ["printf 200", { kind: "answered", status: 200 }],
      ["printf 502", { kind: "answered", status: 502 }],
      ["printf 000; exit 35", { kind: "refused", exit: 35 }],
      ["printf 000; exit 60", { kind: "refused", exit: 60 }],
    ] as const) {
      const curl = standInCommand("curl", script);
      const run = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", env: { PATH: curl.path } });
      curl.remove();
      expect(readCaddyHandshake(run.stdout.toString())).toEqual(expected);
    }
    expect(readCaddyHandshake("")).toBeNull();
    expect(readCaddyHandshake("Permission denied")).toBeNull();
  });

  test("Caddy's reason is the last error its TLS logged about the name, never an entry that says it went well", () => {
    const entry = (fields: Record<string, unknown>) => JSON.stringify({ ts: 1792946441.06, identifier: DOMAIN, ...fields });
    const failed = entry({
      level: "error",
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      issuer: "acme-v02.api.letsencrypt.org-directory",
      error: `[${DOMAIN}] solving challenges: presenting for challenge: could not find zone for domain "${DOMAIN}"`,
    });
    expect(readCaddyReason(failed)).toBe(`could not get certificate from issuer: [${DOMAIN}] solving challenges: presenting for challenge: could not find zone for domain "${DOMAIN}"`);
    expect(readCaddyReason(entry({ level: "info", logger: "tls.obtain", msg: "certificate obtained successfully" }))).toBeNull();
    expect(readCaddyReason(entry({ level: "error", logger: "tls.obtain" }))).toBeNull();
    const long = readCaddyReason(entry({ level: "error", msg: "could not get certificate from issuer", error: "x".repeat(400) }))!;
    expect(long.length).toBe(300);
    expect(long.endsWith("...")).toBe(true);
    expect(readCaddyReason("")).toBeNull();
    expect(readCaddyReason("Oct 25 12:00:00 machine caddy[812]: not JSON")).toBeNull();

    // The command, run against a journal that holds the name's success after
    // its failure, another name's error, and an error of another logger:
    // the failure alone comes back.
    const command = caddyReasonCommand(DOMAIN);
    expect(command).toContain(`grep -F -- '${DOMAIN}'`);
    const journal = [
      failed,
      entry({ level: "info", logger: "tls.obtain", msg: "certificate obtained successfully" }),
      entry({ level: "error", logger: "tls.obtain", msg: "could not get certificate from issuer", identifier: "other.example", error: "another name's" }).replaceAll(DOMAIN, "other.example"),
      entry({ level: "error", logger: "http.log.error", msg: "dial tcp: connection refused" }),
    ].join("\n");
    const sudo = standInCommand("sudo", `cat <<'JOURNAL'\n${journal}\nJOURNAL`);
    const run = Bun.spawnSync(["sh", "-c", command], { stdout: "pipe", env: { PATH: sudo.path } });
    sudo.remove();
    expect(readCaddyReason(run.stdout.toString().trim())).toBe(readCaddyReason(failed));
  });
});

describe("the firewall behind a tunnel", () => {
  test("ssh alone is opened; the web's ports an earlier run opened close later, once the tunnel carries the visitors", () => {
    expect(firewallPorts(22, true)).toEqual([22]);
    expect(firewallPorts(22)).toEqual([22, 80, 443]);
    const run = firewallRun(22, true);
    expect(run).toContain(`for port in 22; do ufw allow "$port/tcp"`);
    // Never in the firewall step: a machine served directly would lose its visitors before the tunnel took them.
    expect(run).not.toContain("delete");
    expect(firewallCheck(22, true)).not.toContain("closed");
    expect(webPortsRun(22)).toContain(`for port in 80 443; do ufw delete allow "$port/tcp"`);
    expect(webPortsCheck(22)).toContain("ufw-443-closed");
    // ssh answering on 443 stays open.
    expect(webPortsRun(443)).toContain(`for port in 80; do ufw delete allow`);
  });
});

const CADDY = Bun.which("caddy");

/** Whether the local Caddy reads `dns cloudflare`: a stock build does not, the machine's does. */
const WITH_MODULE =
  CADDY !== null &&
  Bun.spawnSync([CADDY, "list-modules"], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .split("\n")
    .some((line) => line.trim() === "dns.providers.cloudflare");

/** The DNS challenge, the same directive in the zone's policy and in the tunnel's issuer. */
const DIRECTIVE = "dns cloudflare {env.CLOUDFLARE_API_TOKEN}";

/**
 * What stands for it in a Caddy without the Cloudflare module, as
 * cli-tls-caddy.test.ts stands in for the zone's, and it has to keep the real
 * directive's shape. Caddy builds the issuer a tls block's shortcuts imply,
 * the zone's `dns` among them, on top of the global `cert_issuer acme`
 * (implicitACMEIssuers in caddyconfig/httpcaddyfile/tlsapp.go, measured with
 * 2.11.4): every field the block leaves empty comes from the global issuer.
 * The real directive is the same in both places and overwrites itself, so
 * the zone's issuer comes out as its own. The stand-in is the same in both
 * places too, and merges into itself to nothing new: a file of trusted roots,
 * `ca_root` in a tls block and `trusted_roots` in an issuer, which Caddy
 * appends without duplicates. No `ca` nor `dir`, which a global issuer's
 * would fill in the zone's, and no mark of the tunnel's own, which would
 * reach the zone's issuer the same way: either would hide what the
 * comparison of the zone's policy is there to see, anything the global
 * issuer carries beyond the zone's directive.
 */
function standIn(text: string, which: "zone" | "tunnel", roots: string): string {
  if (WITH_MODULE) return text;
  expect(text.split(DIRECTIVE).length).toBe(2);
  return text.replace(DIRECTIVE, which === "zone" ? `ca_root ${roots}` : `trusted_roots ${roots}`);
}

type Issuer = { module?: string; ca?: string; email?: string; trusted_roots_pem_files?: string[]; challenges?: { dns?: { provider?: { name?: string } } } };

/** The DNS challenge through Cloudflare, or its stand-in, and nothing of another issuer's. */
function isDnsIssuer(issuer: Issuer, roots: string): boolean {
  if (issuer.module !== "acme" || issuer.ca !== undefined) return false;
  return WITH_MODULE ? issuer.challenges?.dns?.provider?.name === "cloudflare" : JSON.stringify(issuer.trusted_roots_pem_files) === JSON.stringify([roots]);
}

describe("the kit's files", () => {
  const unit = readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.unit), "utf8");
  const caddy = readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8");

  test("the unit runs the configuration setup lays, its credentials handed over by systemd, as its own account", () => {
    expect(unit).toContain(`ExecStart=/usr/bin/cloudflared --no-autoupdate --config ${TUNNEL_CONFIG} tunnel run --credentials-file %d/tunnel.json\n`);
    expect(unit).toContain(`LoadCredential=tunnel.json:${TUNNEL_CREDENTIALS}\n`);
    // A static account, which the loopback rule names by its uid: a dynamic
    // one is drawn at each start.
    expect(unit).toContain(`User=${TUNNEL_ACCOUNT}\nGroup=${TUNNEL_ACCOUNT}\n`);
    expect(unit).not.toMatch(/^DynamicUser=/m);
    expect(unit).toContain("RemoveIPC=yes\n");
    expect(unit).toContain("CapabilityBoundingSet=\n");
    expect(unit).toContain("InaccessiblePaths=-/etc/sitesolide -/etc/caddy");
    // The home network the machine may sit on is out of its reach.
    expect(unit).toMatch(/^IPAddressDeny=.*192\.168\.0\.0\/16/m);
    expect(unit).toContain(`${TUNNEL_METRICS}, which the monitor reads`);
  });

  test("Caddy trusts ::1 alone and that one header from it, and certifies what names no issuer through the DNS challenge", () => {
    const directives = caddy.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(directives).toEqual([
      "servers {",
      `\ttrusted_proxies static ${TUNNEL_ORIGIN}/128`,
      "\tclient_ip_headers Cf-Connecting-Ip",
      "}",
      "cert_issuer acme {",
      `\t${DIRECTIVE}`,
      "}",
    ]);
    // The zone's own directive, with the token setup laid for Caddy: no
    // second secret on the machine.
    expect(CLOUDFLARE_POLICY.directive).toEqual([DIRECTIVE]);
  });

  test("the Caddyfile imports the folder by glob in its global options, which a machine served directly leaves empty", () => {
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const global = caddyfile.slice(caddyfile.indexOf("\n{\n"), caddyfile.indexOf("\n}\n") + 1);
    expect(global).toContain(`\timport ${CADDY_TUNNEL_FILE.slice(0, CADDY_TUNNEL_FILE.lastIndexOf("/"))}/*.caddy\n`);
  });
});

const STOOD_IN = WITH_MODULE ? "" : " (without the Cloudflare module: the directive stood in for)";

describe.skipIf(CADDY === null)(`the tunnel's options, in Caddy${STOOD_IN}`, () => {
  let folder = "";
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tunnel-caddy-"));
    writeFileSync(join(folder, "roots.pem"), "");
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  /** The Caddyfile's own global block, its imports moved into the test's folder, and one site. */
  function adapt(withTunnel: boolean): Record<string, unknown> {
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    const global = caddyfile.slice(caddyfile.indexOf("\n{\n") + 1, caddyfile.indexOf("\n}\n") + 3).replaceAll("/etc/caddy/", `${folder}/`);
    rmSync(join(folder, "global.d"), { recursive: true, force: true });
    mkdirSync(join(folder, "global.d"));
    if (withTunnel) writeFileSync(join(folder, "global.d", "tunnel.caddy"), standIn(readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8"), "tunnel", join(folder, "roots.pem")));
    writeFileSync(join(folder, "Caddyfile"), `${global.replace("{$SITESOLIDE_ACME_EMAIL}", "ops@test-zone.invalid")}\nhttp://site.test-zone.invalid {\n\trespond ok\n}\n`);
    const run = Bun.spawnSync([CADDY!, "adapt", "--config", join(folder, "Caddyfile")], { stdout: "pipe", stderr: "pipe" });
    expect({ code: run.exitCode, said: run.exitCode === 0 ? "" : run.stderr.toString() }).toEqual({ code: 0, said: "" });
    return JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  }

  test("with the file, every server trusts ::1 for Cf-Connecting-Ip; without it, nothing is trusted", () => {
    const servers = (json: Record<string, unknown>) => Object.values(((json.apps as Record<string, unknown>).http as { servers: Record<string, Record<string, unknown>> }).servers);
    const trusted = servers(adapt(true));
    expect(trusted.length).toBeGreaterThan(0);
    for (const server of trusted) {
      expect(server.trusted_proxies).toEqual({ ranges: ["::1/128"], source: "static" });
      expect(server.client_ip_headers).toEqual(["Cf-Connecting-Ip"]);
    }
    for (const server of servers(adapt(false))) {
      expect(server.trusted_proxies).toBeUndefined();
      expect(server.client_ip_headers).toBeUndefined();
    }
  });
});

/**
 * The tunnel's issuer in the machine's whole Caddyfile: the zone's policy
 * laid as setup lays Cloudflare's, an app's block with its own domain, the
 * customer domains' table. `caddy adapt` only, on the workstation: no server
 * starts. Never `caddy stop` nor `caddy start`, see CLAUDE.md.
 */
describe.skipIf(CADDY === null)(`the tunnel's certificate issuer, in Caddy${STOOD_IN}`, () => {
  type Policy = { subjects?: string[]; on_demand?: boolean; issuers?: Issuer[] };

  const APP: Manifest = { slug: "kanban", port: 3040, publicDir: "public", start: "bun run server.ts", domain: { name: "kanban.example", active: true } };

  let folder = "";
  let etc = "";
  let roots = "";
  const localize = (text: string): string => text.replaceAll("/etc/caddy/", `${etc}/`);

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "tunnel-issuer-"));
    etc = join(folder, "etc");
    roots = join(folder, "roots.pem");
    writeFileSync(roots, "");
    mkdirSync(join(etc, "sites"), { recursive: true });
    mkdirSync(join(etc, "locks"));
    mkdirSync(join(etc, "global.d"));
    writeFileSync(join(etc, "sites", `${APP.slug}.caddy`), localize(generateFragment(APP)!));
    writeFileSync(join(etc, "domaines.map"), "\tsample-agency.example agency\n");
    writeFileSync(join(etc, "tls-zone.caddy"), standIn(tlsZoneContent(CLOUDFLARE_POLICY), "zone", roots));
    writeFileSync(join(folder, "Caddyfile"), localize(readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8")));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  /**
   * Every TLS policy Caddy adapts the Caddyfile to, with the tunnel's file in
   * global.d or without it; `extra`, a line added to its issuer after the
   * directive.
   */
  function policies(withTunnel: boolean, extra?: string): Policy[] {
    const file = join(etc, "global.d", "tunnel.caddy");
    rmSync(file, { force: true });
    if (withTunnel) {
      const caddy = standIn(readFileSync(join(REPO_ROOT, TUNNEL_KIT_FILES.caddy), "utf8"), "tunnel", roots);
      writeFileSync(file, extra === undefined ? caddy : caddy.replace("cert_issuer acme {\n", `cert_issuer acme {\n\t${extra}\n`));
    }
    const run = Bun.spawnSync([CADDY!, "adapt", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: folder,
        XDG_DATA_HOME: join(folder, "data"),
        XDG_CONFIG_HOME: join(folder, "config"),
        SITESOLIDE_ZONE: ZONE,
        SITESOLIDE_ACME_EMAIL: `ops@${ZONE}`,
        SITESOLIDE_SLUG: "{labels.2}",
      },
    });
    expect({ code: run.exitCode, said: run.exitCode === 0 ? "" : run.stderr.toString() }).toEqual({ code: 0, said: "" });
    const json = JSON.parse(run.stdout.toString()) as { apps?: { tls?: { automation?: { policies?: Policy[] } } } };
    return json.apps?.tls?.automation?.policies ?? [];
  }

  const zoneOf = (all: Policy[]) => all.find((one) => one.subjects?.includes(`*.${ZONE}`));
  const onDemandOf = (all: Policy[]) => all.filter((one) => one.on_demand === true);

  test("without the file, the customer domains keep Caddy's defaults, none of them the DNS challenge", () => {
    const onDemand = onDemandOf(policies(false));
    expect(onDemand).toHaveLength(1);
    expect(onDemand[0]!.subjects).toBeUndefined();
    expect((onDemand[0]!.issuers ?? []).some((issuer) => isDnsIssuer(issuer, roots))).toBe(false);
  });

  test("with it, the on-demand policy, every customer domain's, takes the tunnel's issuer alone; the zone's comes out as it was", () => {
    const without = policies(false);
    const all = policies(true);
    expect(all).toHaveLength(without.length);

    // The one policy the nameless block of customer domains and the app's own
    // domain share: the global issuer and no other, with the contact address
    // the global `email` gives every ACME issuer.
    const onDemand = onDemandOf(all);
    expect(onDemand).toHaveLength(1);
    expect(onDemand[0]!.subjects).toBeUndefined();
    expect(onDemand[0]!.issuers).toHaveLength(1);
    expect(isDnsIssuer(onDemand[0]!.issuers![0]!, roots)).toBe(true);
    expect(onDemand[0]!.issuers![0]!.email).toBe(`ops@${ZONE}`);

    // The zone's, the app's preview among its names, exactly as without the
    // file. Caddy builds its issuer on top of the global one, and the global
    // one holds nothing the zone's directive does not: see the next test for
    // what the comparison sees otherwise.
    const zone = zoneOf(all);
    expect(zone?.subjects).toEqual(expect.arrayContaining([ZONE, `www.${ZONE}`, `*.${ZONE}`, `${APP.slug}.${ZONE}`]));
    expect(zone).toEqual(zoneOf(without));
    expect(zone?.on_demand).toBeUndefined();
    expect(zone?.issuers).toHaveLength(1);
    expect(isDnsIssuer(zone!.issuers![0]!, roots)).toBe(true);
  });

  test("anything the global issuer carries beyond the zone's directive reaches the zone's policy, which the comparison sees", () => {
    const without = zoneOf(policies(false));
    // A timeout, a directory, a challenge turned off: each would reach the
    // wildcard and every preview, and each fails the comparison above.
    for (const extra of ["timeout 10s", "dir https://leak.stand-in.invalid/directory", "disable_tlsalpn_challenge"]) {
      expect(zoneOf(policies(true, extra))).not.toEqual(without);
    }
  });
});
