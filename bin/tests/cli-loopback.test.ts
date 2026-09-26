import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import { type LoopbackMode, adminPatterns, CADDY_ADMIN_PORT, SERVICE_PORTS, loopbackRule, LOOPBACK_TABLE } from "../cli/loopback";
import { PORTAL_PORT } from "../cli/portal";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** uid 997 for caddy, as on a Debian; 1022 for the dashboard; 1500 any other. */
const CADDY = 997;
const DASHBOARD = 1022;
const OTHER = 1500;
const NOBODY = 65534;

interface Issue {
  verdict: "accepted" | "refused";
  logged: boolean;
}

/**
 * Replays the chain the way the kernel walks it for a new connection going out
 * through the loopback: from top to bottom, the first rule with a final
 * verdict decides, a rule that only counts and logs lets it continue, and the
 * `accept` policy settles it last. Only reads the grammar that loopbackRule
 * writes, and throws on any other line: a rule it skipped would make the test
 * green without checking anything.
 */
function walk(rule: string, uid: number, port: number): Issue {
  let logged = false;
  for (const line of rulesOf(rule)) {
    const m = line.match(/^oifname "lo" tcp dport (\d+)(?:-(\d+))?(?: meta skuid (?:\{ ([\d, ]+) \}|(\d+)))?(?: ct state new)? (.+)$/);
    if (m === null) throw new Error(`unreadable rule: ${line}`);
    const [, first, last, set, single, action] = m;
    if (port < Number(first) || port > Number(last ?? first)) continue;
    const uids = set?.split(",").map((u) => Number(u.trim())) ?? (single === undefined ? null : [Number(single)]);
    if (uids !== null && !uids.includes(uid)) continue;
    if (action === "accept") return { verdict: "accepted", logged };
    if (action!.endsWith("reject with tcp reset")) return { verdict: "refused", logged };
    if (action!.includes(" log prefix ")) {
      logged = true;
      continue;
    }
    throw new Error(`unknown action: ${action}`);
  }
  return { verdict: "accepted", logged };
}

function rulesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("oifname"));
}

/** The first line recognised by each pattern, -1 if none. */
function ranks(patterns: string[], text: string): number[] {
  const lines = text.split("\n");
  return patterns.map((pattern) => lines.findIndex((line) => new RegExp(pattern).test(line)));
}

describe("the loopback rule", () => {
  test("close refuses the others, observe refuses nothing", () => {
    expect(loopbackRule(CADDY, "close", DASHBOARD)).toInclude("reject with tcp reset");
    const observedRule = loopbackRule(CADDY, "observe", DASHBOARD);
    expect(observedRule).not.toInclude("reject");
    expect(observedRule).toInclude('log prefix "sitesolide-loopback: "');
  });

  test("Caddy and root go through, and only on the loopback", () => {
    const rule = loopbackRule(CADDY, "close", DASHBOARD);
    expect(rule).toInclude('oifname "lo" tcp dport 3000-3099 meta skuid { 0, 997 } accept');
  });

  test("the dashboard goes through to the portal, and to no other port", () => {
    const rule = loopbackRule(CADDY, "close", DASHBOARD);
    const lines = rule.split("\n").filter((line) => line.includes("1022"));
    expect(lines).toEqual([`\t\toifname "lo" tcp dport ${PORTAL_PORT} meta skuid 1022 accept`]);
    // Before the refusal: nftables stops at the first rule that decides.
    expect(rule.indexOf("skuid 1022 accept")).toBeLessThan(rule.indexOf("ct state new"));
  });

  test("Caddy's admin API: Caddy and root go through, the others are refused or logged", () => {
    const closedRule = loopbackRule(CADDY, "close", DASHBOARD);
    const observedRule = loopbackRule(CADDY, "observe", DASHBOARD);
    const acceptLine = `\t\toifname "lo" tcp dport 2019 meta skuid { 0, 997 } accept`;
    expect(CADDY_ADMIN_PORT).toBe(2019);
    expect(closedRule).toInclude(`${acceptLine}\n\t\toifname "lo" tcp dport 2019 ct state new counter reject with tcp reset\n`);
    expect(observedRule).toInclude(
      `${acceptLine}\n\t\toifname "lo" tcp dport 2019 ct state new counter limit rate 30/minute log prefix "sitesolide-loopback: " flags skuid\n`,
    );
    // Outside the services range: without rules of its own, nothing would
    // cover it.
    expect(CADDY_ADMIN_PORT < SERVICE_PORTS.first || CADDY_ADMIN_PORT > SERVICE_PORTS.last).toBe(true);
  });

  test.each(["close", "observe"] as const)("%s: walked in order, the chain decides what is expected of each account", (mode: LoopbackMode) => {
    const rule = loopbackRule(CADDY, mode, DASHBOARD);
    expect(rulesOf(rule)).toHaveLength(5);

    const allowed: Issue = { verdict: "accepted", logged: false };
    const other: Issue = mode === "close" ? { verdict: "refused", logged: false } : { verdict: "accepted", logged: true };
    const expected: [uid: number, port: number, issue: Issue][] = [
      // The admin API: Caddy and root only, the dashboard counted among the
      // others.
      [0, CADDY_ADMIN_PORT, allowed],
      [CADDY, CADDY_ADMIN_PORT, allowed],
      [DASHBOARD, CADDY_ADMIN_PORT, other],
      [OTHER, CADDY_ADMIN_PORT, other],
      [NOBODY, CADDY_ADMIN_PORT, other],
      // The services, at both ends of the range.
      [0, SERVICE_PORTS.first, allowed],
      [CADDY, SERVICE_PORTS.last, allowed],
      [OTHER, SERVICE_PORTS.first, other],
      [OTHER, SERVICE_PORTS.last, other],
      [DASHBOARD, SERVICE_PORTS.first, other],
      // The portal, the dashboard's only exception.
      [DASHBOARD, PORTAL_PORT, allowed],
      [CADDY, PORTAL_PORT, allowed],
      [OTHER, PORTAL_PORT, other],
      // Outside the rule, nothing changes for anyone.
      [OTHER, CADDY_ADMIN_PORT - 1, allowed],
      [OTHER, CADDY_ADMIN_PORT + 1, allowed],
      [OTHER, SERVICE_PORTS.first - 1, allowed],
      [OTHER, SERVICE_PORTS.last + 1, allowed],
      [OTHER, 8080, allowed],
    ];
    for (const [uid, port, issue] of expected) {
      expect({ uid, port, issue: walk(rule, uid, port) }).toEqual({ uid, port, issue });
    }
  });

  test("the API is observed on its own, the services ports staying closed", () => {
    // The whole rule in observe would reopen the services for as long as the
    // API is observed.
    const rule = loopbackRule(CADDY, "close", DASHBOARD, "observe");
    expect(rule).toInclude("# Mode: close, admin API: observe.");
    const refused: Issue = { verdict: "refused", logged: false };
    const logged: Issue = { verdict: "accepted", logged: true };
    expect(walk(rule, OTHER, SERVICE_PORTS.first)).toEqual(refused);
    expect(walk(rule, DASHBOARD, SERVICE_PORTS.first)).toEqual(refused);
    expect(walk(rule, OTHER, CADDY_ADMIN_PORT)).toEqual(logged);
    expect(walk(rule, DASHBOARD, CADDY_ADMIN_PORT)).toEqual(logged);
    expect(walk(rule, CADDY, CADDY_ADMIN_PORT)).toEqual({ verdict: "accepted", logged: false });
    // The check looks for the API's rule according to its own mode.
    expect(ranks(adminPatterns(CADDY, "observe"), rule).every((index) => index >= 0)).toBe(true);
    expect(ranks(adminPatterns(CADDY, "close"), rule)[1]).toBe(-1);
    // Without adminMode, the whole rule follows the same mode.
    expect(loopbackRule(CADDY, "close", DASHBOARD)).toBe(loopbackRule(CADDY, "close", DASHBOARD, "close"));
  });

  test("the check's patterns recognise the API's rule, in order, and it alone", () => {
    for (const mode of ["close", "observe"] as const) {
      const found = ranks(adminPatterns(CADDY, mode), loopbackRule(CADDY, mode, DASHBOARD));
      expect(found.every((index) => index >= 0)).toBe(true);
      expect(found[0]!).toBeLessThan(found[1]!);
    }
    // The other mode, or another uid for Caddy, does not pass for the expected
    // rule.
    expect(ranks(adminPatterns(CADDY, "close"), loopbackRule(CADDY, "observe", DASHBOARD))[1]).toBe(-1);
    expect(ranks(adminPatterns(CADDY, "observe"), loopbackRule(CADDY, "close", DASHBOARD))[1]).toBe(-1);
    expect(ranks(adminPatterns(98, "close"), loopbackRule(CADDY, "close", DASHBOARD))[0]).toBe(-1);
    expect(ranks(adminPatterns(9997, "close"), loopbackRule(CADDY, "close", DASHBOARD))[0]).toBe(-1);
  });

  test("the patterns also recognise the rule as nft list table renders it", () => {
    // Recorded on nftables 1.1.3, the one from Debian 13, and identical on
    // 1.0.9: the kernel adds the counters, and limit's default burst.
    const closedRule = [
      '\t\toifname "lo" tcp dport 2019 meta skuid { 0, 997 } accept',
      '\t\toifname "lo" tcp dport 2019 ct state new counter packets 3 bytes 180 reject with tcp reset',
    ].join("\n");
    const observedRule = [
      '\t\toifname "lo" tcp dport 2019 meta skuid { 0, 997 } accept',
      '\t\toifname "lo" tcp dport 2019 ct state new counter packets 0 bytes 0 limit rate 30/minute burst 5 packets log prefix "sitesolide-loopback: " flags skuid',
    ].join("\n");
    expect(ranks(adminPatterns(CADDY, "close"), closedRule)).toEqual([0, 1]);
    expect(ranks(adminPatterns(CADDY, "observe"), observedRule)).toEqual([0, 1]);
    // Out of order, the refusal first: the check sees it.
    const outOfOrder = closedRule.split("\n").reverse().join("\n");
    expect(ranks(adminPatterns(CADDY, "close"), outOfOrder)).toEqual([1, 0]);
  });

  test("a uid read wrong is refused: the rule would close Caddy itself out", () => {
    for (const uid of [0, -1, Number.NaN, 1.5, 65534, 70000]) {
      expect(() => loopbackRule(uid, "close", DASHBOARD)).toThrow();
      expect(() => loopbackRule(uid, "observe", DASHBOARD)).toThrow();
      expect(() => adminPatterns(uid, "close")).toThrow();
    }
  });

  test("a dashboard uid read wrong is refused, Caddy's one included", () => {
    for (const uid of [0, -1, Number.NaN, 1.5, 65534, CADDY]) {
      expect(() => loopbackRule(CADDY, "close", uid)).toThrow(/dashboard/);
    }
  });

  test("the file replays itself, whether the table is laid down or not", () => {
    const rule = loopbackRule(CADDY, "close", DASHBOARD);
    expect(rule.indexOf(`table inet ${LOOPBACK_TABLE}\n`)).toBeLessThan(rule.indexOf(`delete table inet ${LOOPBACK_TABLE}`));
  });

  test("every service the workstation knows listens inside the closed range", () => {
    // A service outside the range would escape the rule without anything
    // saying so: that is what this test prevents. It reads the ports in the
    // manifests, from which the units are generated, plus the shared service's
    // unit, which has no manifest.
    const ports: number[] = [PORTAL_PORT];
    const api = readFileSync(join(REPO_ROOT, "api", "deploy", "sitesolide-api.service"), "utf8");
    const apiPort = api.match(/^Environment=PORT=(\d+)$/m)?.[1];
    if (apiPort !== undefined) ports.push(Number(apiPort));
    for (const manifest of knownManifests()) if (manifest.port !== undefined) ports.push(manifest.port);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(SERVICE_PORTS.first);
      expect(port).toBeLessThanOrEqual(SERVICE_PORTS.last);
    }
  });

  test("the Caddyfile leaves the admin API on the port the rule closes", () => {
    // An admin directive that moved it to another port would reopen it to
    // every service without anything saying so. Still allowed: no directive at
    // all (localhost:2019), the same port, off, or a Unix socket, which its
    // file permissions guard rather than the firewall.
    const lines = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8").split("\n");
    const first = lines.findIndex((line) => line === "{");
    const end = lines.findIndex((line, i) => i > first && line === "}");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(first);
    // The global block is the first of the file: only comments precede it.
    expect(lines.slice(0, first).every((line) => line.trim() === "" || line.startsWith("#"))).toBe(true);
    // The reading of the block holds: it does carry the known options.
    expect(lines.slice(first, end).join("\n")).toInclude("on_demand_tls");

    for (const line of lines.slice(first + 1, end).map((l) => l.trim())) {
      if (!/^admin(\s|$)/.test(line)) continue;
      const address = line.split(/\s+/)[1] ?? "";
      const covered =
        address === "" || address === "{" || address === "off" || address.startsWith("unix/") || address.endsWith(`:${CADDY_ADMIN_PORT}`);
      expect({ line, covered }).toEqual({ line, covered: true });
    }
  });
});

/**
 * The rule in a real Linux kernel, a container on the workstation: nothing is
 * tried on the VM. Opt-in, like the VM tests, because Docker and the network
 * are needed to install nftables:
 *
 *   LOOPBACK_TEST=1 bun test bin/tests/cli-loopback.test.ts
 */
const DOCKER = Bun.which("docker");
describe.skipIf(process.env.LOOPBACK_TEST !== "1" || DOCKER === null)("in a Linux kernel", () => {
  function container(mode: LoopbackMode, adminMode: LoopbackMode = mode): { code: number; output: string } {
    // The admin API listens on both of its loopbacks and on the container's
    // address: a future configuration could change Caddy's one, and the kernel
    // routes through lo what a process sends to its own address.
    const script = `
set -e
apk add --quiet --no-progress nftables curl busybox-extras >/dev/null
adduser -D -u ${CADDY} caddy
adduser -D -u ${DASHBOARD} dashboard
adduser -D -u ${OTHER} other
mkdir -p /srv/www && echo ok > /srv/www/index.html
IP=$(ip -4 addr show dev eth0 | awk '/inet /{print $2; exit}' | cut -d/ -f1)
[ -n "$IP" ]
httpd -p 127.0.0.1:3022 -h /srv/www
httpd -p 127.0.0.1:${PORTAL_PORT} -h /srv/www
httpd -p 127.0.0.1:8080 -h /srv/www
httpd -p [::1]:3043 -h /srv/www
httpd -p 127.0.0.1:${CADDY_ADMIN_PORT} -h /srv/www
httpd -p [::1]:${CADDY_ADMIN_PORT} -h /srv/www
httpd -p $IP:${CADDY_ADMIN_PORT} -h /srv/www
cat > /rule.nft <<'RULE'
${loopbackRule(CADDY, mode, DASHBOARD, adminMode)}
RULE
nft -f /rule.nft
nft -f /rule.nft
code() { su -s /bin/sh "$1" -c "curl -s -o /dev/null -w %{http_code} --max-time 3 $2" || true; }
root() { curl -s -o /dev/null -w %{http_code} --max-time 3 "$1" || true; }
echo "caddy:3022=$(code caddy http://127.0.0.1:3022/)"
echo "root:3022=$(root http://127.0.0.1:3022/)"
echo "other:3022=$(code other http://127.0.0.1:3022/)"
echo "other:v6:3043=$(code other 'http://[::1]:3043/')"
echo "caddy:v6:3043=$(code caddy 'http://[::1]:3043/')"
echo "other:8080=$(code other http://127.0.0.1:8080/)"
echo "dashboard:portal=$(code dashboard http://127.0.0.1:${PORTAL_PORT}/)"
echo "dashboard:3022=$(code dashboard http://127.0.0.1:3022/)"
echo "other:portal=$(code other http://127.0.0.1:${PORTAL_PORT}/)"
for target in "127.0.0.1" "[::1]" "$IP"; do
  family=v4; case "$target" in "[::1]") family=v6 ;; 127.*) ;; *) family=ip ;; esac
  echo "caddy:admin:$family=$(code caddy "http://$target:${CADDY_ADMIN_PORT}/")"
  echo "root:admin:$family=$(root "http://$target:${CADDY_ADMIN_PORT}/")"
  echo "other:admin:$family=$(code other "http://$target:${CADDY_ADMIN_PORT}/")"
  echo "dashboard:admin:$family=$(code dashboard "http://$target:${CADDY_ADMIN_PORT}/")"
done
echo "--- list"
nft list table inet ${LOOPBACK_TABLE}
echo "--- end"
`;
    const r = Bun.spawnSync([DOCKER!, "run", "--rm", "--cap-add", "NET_ADMIN", "alpine:3.20", "sh", "-c", script]);
    return { code: r.exitCode, output: r.stdout.toString() + r.stderr.toString() };
  }

  function list(output: string): string {
    return output.split("--- list\n")[1]?.split("--- end")[0] ?? "";
  }

  test("close: Caddy and root go through, the others are refused, IPv6 included", () => {
    const { code, output } = container("close");
    expect(code).toBe(0);
    expect(output).toInclude("caddy:3022=200");
    expect(output).toInclude("root:3022=200");
    expect(output).toInclude("other:3022=000");
    expect(output).toInclude("other:v6:3043=000");
    expect(output).toInclude("caddy:v6:3043=200");
    // Outside the range, nothing changes.
    expect(output).toInclude("other:8080=200");
    // The dashboard reaches the portal, and nothing else; the exception
    // benefits nobody else.
    expect(output).toInclude("dashboard:portal=200");
    expect(output).toInclude("dashboard:3022=000");
    expect(output).toInclude("other:portal=000");
    // The admin API, through 127.0.0.1, ::1 and the machine's address.
    for (const family of ["v4", "v6", "ip"]) {
      expect(output).toInclude(`caddy:admin:${family}=200`);
      expect(output).toInclude(`root:admin:${family}=200`);
      expect(output).toInclude(`other:admin:${family}=000`);
      expect(output).toInclude(`dashboard:admin:${family}=000`);
    }
    // What bin/deploy-loopback.sh looks for in the loaded rule, in order.
    const found = ranks(adminPatterns(CADDY, "close"), list(output));
    expect(found.every((index) => index >= 0)).toBe(true);
    expect(found[0]!).toBeLessThan(found[1]!);
  }, 120_000);

  test("observe: nobody is refused, the others are counted", () => {
    const { code, output } = container("observe");
    expect(code).toBe(0);
    expect(output).toInclude("other:3022=200");
    expect(output).toInclude("other:v6:3043=200");
    for (const family of ["v4", "v6", "ip"]) {
      expect(output).toInclude(`other:admin:${family}=200`);
      expect(output).toInclude(`dashboard:admin:${family}=200`);
    }
    expect(output).toMatch(/counter packets [1-9]/);
    const lines = list(output).split("\n");
    const found = ranks(adminPatterns(CADDY, "observe"), lines.join("\n"));
    expect(found.every((index) => index >= 0)).toBe(true);
    expect(found[0]!).toBeLessThan(found[1]!);
    // Six attempts towards the API, counted on its own rule.
    expect(lines[found[1]!]).toMatch(/counter packets [1-9]/);
  }, 120_000);

  test("close, API observed: the services stay closed, the API is counted without refusal", () => {
    const { code, output } = container("close", "observe");
    expect(code).toBe(0);
    expect(output).toInclude("other:3022=000");
    expect(output).toInclude("other:v6:3043=000");
    expect(output).toInclude("dashboard:3022=000");
    expect(output).toInclude("dashboard:portal=200");
    for (const family of ["v4", "v6", "ip"]) {
      expect(output).toInclude(`caddy:admin:${family}=200`);
      expect(output).toInclude(`other:admin:${family}=200`);
      expect(output).toInclude(`dashboard:admin:${family}=200`);
    }
    const lines = list(output).split("\n");
    const found = ranks(adminPatterns(CADDY, "observe"), lines.join("\n"));
    expect(found.every((index) => index >= 0)).toBe(true);
    expect(found[0]!).toBeLessThan(found[1]!);
    expect(lines[found[1]!]).toMatch(/counter packets [1-9]/);
  }, 120_000);
});
