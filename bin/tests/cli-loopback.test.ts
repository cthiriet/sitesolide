import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import {
  type LoopbackMode,
  adminPatterns,
  CADDY_ADMIN_PORT,
  CADDY_HTTPS_PORT,
  autobindReachesBlocks,
  listeningFilter,
  loopbackRule,
  PORT_RESERVATION_FILE,
  portReservationFile,
  reservedPortsValue,
  servicesPatterns,
  LOOPBACK_TABLE,
  PROJECT_PORTS_SET,
  projectPortPairs,
  projectPortsFile,
  reachesOwnPorts,
  reservesEveryBlock,
  servicePortsSet,
  TUNNEL_ORIGIN,
  tunnelPatterns,
} from "../cli/loopback";
import { FIRST_BLOCK, isServicePort, SERVICE_PORT_RANGES, servicesOf, type Manifest } from "../cli/manifest";

/** The second block, where a machine lets a project listen once it has opened it. */
const SECOND_BLOCK = SERVICE_PORT_RANGES[1]!;
import { PORTAL_PORT } from "../cli/portal";
import { secondBlockStateCommand } from "../cli/services";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** uid 997 for caddy, as on a Debian; 1022 for the dashboard; 1500 any other; 1600 a project with several services; 987 the tunnel's connector. */
const CADDY = 997;
const DASHBOARD = 1022;
const OTHER = 1500;
const PROJECT = 1600;
const TUNNEL = 987;
const NOBODY = 65534;

/** A project with a front, an API and an internal worker. */
const SEVERAL: Manifest = {
  slug: "lab",
  services: {
    web: { start: "/srv/sites/lab/app/web", port: 3050 },
    api: { start: "/srv/sites/lab/app/api", port: 3051, routes: ["/v1/*"] },
    worker: { start: "/srv/sites/lab/app/worker", port: 3052, internal: true },
  },
};
/** The set PROJECT_PORTS_FILE fills for SEVERAL, as `port . uid` pairs. */
const PROJECT_PAIRS: [port: number, uid: number][] = [
  [3050, PROJECT],
  [3051, PROJECT],
  [3052, PROJECT],
];

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
 * green without checking anything. `from` is the connection's source, which
 * only the tunnel's lines look at.
 */
function walk(rule: string, uid: number, port: number, pairs: [number, number][] = PROJECT_PAIRS, from = "127.0.0.1"): Issue {
  let logged = false;
  for (const line of rulesOf(rule)) {
    if (line === `oifname "lo" tcp dport . meta skuid @${PROJECT_PORTS_SET} accept`) {
      if (pairs.some(([p, u]) => p === port && u === uid)) return { verdict: "accepted", logged };
      continue;
    }
    const m = line.match(/^oifname "lo"(?: ip6 saddr (\S+))? tcp dport (?:\{ ([\d, -]+) \}|(\d+(?:-\d+)?))(?: meta skuid (?:\{ ([\d, ]+) \}|(\d+)))?(?: ct state new)? (.+)$/);
    if (m === null) throw new Error(`unreadable rule: ${line}`);
    const [, source, intervals, interval, set, single, action] = m;
    if (source !== undefined && source !== from) continue;
    // One port, one interval, or a set of them, as nftables reads `{ 3000-3099, 21000-29999 }`.
    const matches = (intervals ?? interval!).split(",").some((element) => {
      const [first, last] = element.trim().split("-");
      return port >= Number(first) && port <= Number(last ?? first);
    });
    if (!matches) continue;
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
    expect(rule).toInclude('oifname "lo" tcp dport { 3000-3099, 21000-29999 } meta skuid { 0, 997 } accept');
  });

  test("every block in one set, on the line that lets Caddy through and on the one that refuses the others", () => {
    expect(servicePortsSet()).toBe("{ 3000-3099, 21000-29999 }");
    for (const mode of ["close", "observe"] as const) {
      const lines = rulesOf(loopbackRule(CADDY, mode, DASHBOARD)).filter((line) => line.includes(servicePortsSet()));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEndWith(`meta skuid { 0, ${CADDY} } accept`);
      expect(lines[1]).toInclude(" ct state new counter ");
    }
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
    expect(isServicePort(CADDY_ADMIN_PORT)).toBe(false);
  });

  test.each(["close", "observe"] as const)("%s: walked in order, the chain decides what is expected of each account", (mode: LoopbackMode) => {
    const rule = loopbackRule(CADDY, mode, DASHBOARD);
    expect(rulesOf(rule)).toHaveLength(6);

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
      // The services, at both ends of each block.
      [0, FIRST_BLOCK.first, allowed],
      [CADDY, FIRST_BLOCK.last, allowed],
      [OTHER, FIRST_BLOCK.first, other],
      [OTHER, FIRST_BLOCK.last, other],
      [DASHBOARD, FIRST_BLOCK.first, other],
      [0, SECOND_BLOCK.first, allowed],
      [CADDY, SECOND_BLOCK.first, allowed],
      [CADDY, SECOND_BLOCK.last, allowed],
      [OTHER, SECOND_BLOCK.first, other],
      [OTHER, SECOND_BLOCK.last, other],
      [DASHBOARD, SECOND_BLOCK.first, other],
      [TUNNEL, SECOND_BLOCK.first, other],
      // The portal, the dashboard's only exception.
      [DASHBOARD, PORTAL_PORT, allowed],
      [CADDY, PORTAL_PORT, allowed],
      [OTHER, PORTAL_PORT, other],
      // A project with several services reaches its own ports, and nothing
      // else; nobody else reaches them.
      [PROJECT, 3050, allowed],
      [PROJECT, 3052, allowed],
      [PROJECT, 3022, other],
      [PROJECT, PORTAL_PORT, other],
      [PROJECT, CADDY_ADMIN_PORT, other],
      [OTHER, 3052, other],
      [DASHBOARD, 3051, other],
      [CADDY, 3052, allowed],
      // Outside the rule, nothing changes for anyone.
      [OTHER, CADDY_ADMIN_PORT - 1, allowed],
      [OTHER, CADDY_ADMIN_PORT + 1, allowed],
      [OTHER, FIRST_BLOCK.first - 1, allowed],
      [OTHER, FIRST_BLOCK.last + 1, allowed],
      [OTHER, SECOND_BLOCK.first - 1, allowed],
      [OTHER, SECOND_BLOCK.last + 1, allowed],
      // Between the blocks, the tunnel's metrics, which the monitor reads as its own account.
      [OTHER, 20240, allowed],
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
    expect(walk(rule, OTHER, FIRST_BLOCK.first)).toEqual(refused);
    expect(walk(rule, DASHBOARD, FIRST_BLOCK.first)).toEqual(refused);
    expect(walk(rule, OTHER, SECOND_BLOCK.first)).toEqual(refused);
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

  test("the project set is declared in the table, and consulted before the refusal", () => {
    const rule = loopbackRule(CADDY, "close", DASHBOARD);
    expect(rule).toInclude(`\tset ${PROJECT_PORTS_SET} {\n\t\ttypeof tcp dport . meta skuid\n\t}`);
    expect(rule.indexOf(`@${PROJECT_PORTS_SET} accept`)).toBeLessThan(rule.indexOf(`tcp dport ${servicePortsSet()} ct state new`));
    // Emptied, the set lets nothing through: the rule is the one of before.
    expect(walk(rule, PROJECT, 3050, [])).toEqual({ verdict: "refused", logged: false });
  });

  test("the file replays itself, whether the table is laid down or not", () => {
    const rule = loopbackRule(CADDY, "close", DASHBOARD);
    expect(rule.indexOf(`table inet ${LOOPBACK_TABLE}\n`)).toBeLessThan(rule.indexOf(`delete table inet ${LOOPBACK_TABLE}`));
  });

  test("every service the workstation knows listens inside the closed blocks", () => {
    // A service outside the blocks would escape the rule without anything
    // saying so: that is what this test prevents. It reads the ports in the
    // manifests, from which the units are generated, plus the shared service's
    // unit, which has no manifest.
    const ports: number[] = [PORTAL_PORT];
    const api = readFileSync(join(REPO_ROOT, "api", "deploy", "sitesolide-api.service"), "utf8");
    const apiPort = api.match(/^Environment=PORT=(\d+)$/m)?.[1];
    if (apiPort !== undefined) ports.push(Number(apiPort));
    for (const manifest of knownManifests()) ports.push(...servicesOf(manifest).flatMap((service) => (service.port === null ? [] : [service.port])));
    for (const port of ports) expect({ port, closed: isServicePort(port) }).toEqual({ port, closed: true });
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

describe("every block reserved, as a deployment reads it before a port of the second", () => {
  test("the rule this release writes in close reserves every block, behind a tunnel too, the API observed or not", () => {
    expect(reservesEveryBlock(loopbackRule(CADDY, "close", DASHBOARD))).toBe(true);
    expect(reservesEveryBlock(loopbackRule(CADDY, "close", DASHBOARD, "close", TUNNEL))).toBe(true);
    expect(reservesEveryBlock(loopbackRule(CADDY, "close", DASHBOARD, "observe"))).toBe(true);
  });

  test("a rule in observe reserves nothing: every account still connects, the second block stays shut", () => {
    expect(reservesEveryBlock(loopbackRule(CADDY, "observe", DASHBOARD))).toBe(false);
    expect(reservesEveryBlock(loopbackRule(CADDY, "observe", DASHBOARD, "observe", TUNNEL))).toBe(false);
    expect(reservesEveryBlock(loopbackRule(CADDY, "observe", DASHBOARD, "close"))).toBe(false);
  });

  test("the script's patterns recognise the services' two lines, in their mode and order, every block in the set", () => {
    for (const mode of ["close", "observe"] as const) {
      const found = ranks(servicesPatterns(CADDY, mode), loopbackRule(CADDY, mode, DASHBOARD));
      expect(found.every((index) => index >= 0)).toBe(true);
      expect(found[0]!).toBeLessThan(found[1]!);
    }
    expect(ranks(servicesPatterns(CADDY, "close"), loopbackRule(CADDY, "observe", DASHBOARD))[1]).toBe(-1);
    // A rule of the release before, the first block alone, does not pass.
    const before = loopbackRule(CADDY, "close", DASHBOARD).replaceAll(servicePortsSet(), "3000-3099");
    expect(ranks(servicesPatterns(CADDY, "close"), before)).toEqual([-1, -1]);
    expect(() => servicesPatterns(0, "close")).toThrow();
  });

  test("as nft list table renders it, counters and all", () => {
    // The rendering nftables gives an anonymous set of intervals; the
    // counters as the kernel adds them, recorded on nftables 1.1.3.
    const listed = [
      'table inet sitesolide_boucle {',
      '\tchain output {',
      '\t\toifname "lo" tcp dport { 3000-3099, 21000-29999 } meta skuid { 0, 997 } accept',
      '\t\toifname "lo" tcp dport { 3000-3099, 21000-29999 } ct state new counter packets 2 bytes 120 reject with tcp reset',
      '\t\toifname "lo" tcp dport 2019 ct state new counter packets 0 bytes 0 reject with tcp reset',
      '\t}',
      '}',
    ].join("\n");
    expect(reservesEveryBlock(listed)).toBe(true);
    expect(ranks(servicesPatterns(CADDY, "close"), listed)).toEqual([2, 3]);
    const observed = listed.replace("counter packets 2 bytes 120 reject with tcp reset", 'counter packets 0 bytes 0 limit rate 30/minute burst 5 packets log prefix "sitesolide-loopback: " flags skuid');
    expect(reservesEveryBlock(observed)).toBe(false);
    expect(ranks(servicesPatterns(CADDY, "observe"), observed)).toEqual([2, 3]);
  });

  test("a rule laid before the second block, or one that refuses the others on part of it, does not", () => {
    const before = [
      '\t\toifname "lo" tcp dport 3000-3099 meta skuid { 0, 997 } accept',
      '\t\toifname "lo" tcp dport 3000-3099 ct state new counter packets 0 bytes 0 reject with tcp reset',
      '\t\toifname "lo" tcp dport 2019 ct state new counter packets 0 bytes 0 reject with tcp reset',
    ].join("\n");
    expect(reservesEveryBlock(before)).toBe(false);
    // Caddy let through on both blocks is not the others refused on both.
    expect(reservesEveryBlock(before.replace("3000-3099 meta", "{ 3000-3099, 21000-29999 } meta"))).toBe(false);
    // A block cut short is not the block.
    expect(reservesEveryBlock(before.replace("3000-3099 ct state", "{ 3000-3099, 21000-25000 } ct state"))).toBe(false);
    expect(reservesEveryBlock("")).toBe(false);
  });

  test("the listening sockets of every block, as ss filters them", () => {
    expect(listeningFilter()).toBe("( sport >= :3000 and sport <= :3099 ) or ( sport >= :21000 and sport <= :29999 )");
  });
});

describe("the ports the kernel hands out by itself", () => {
  /**
   * SocketBindDeny= is a BPF program on bind(2), compared with the port asked
   * for: a bind to port 0, or a listen without bind, gets a port the kernel
   * picks in ip_local_port_range, which the program never sees. Reserved,
   * the blocks' ports are never picked.
   */
  test("every block reserved, what the machine reserved kept, written as the kernel lists it", () => {
    expect(reservedPortsValue("")).toBe("3000-3099,21000-29999");
    expect(reservedPortsValue("\n")).toBe("3000-3099,21000-29999");
    expect(reservedPortsValue("8080,3050-3200,29999-30010")).toBe("3000-3200,8080,21000-30010");
    expect(reservedPortsValue("3000-3099,21000-29999")).toBe("3000-3099,21000-29999");
    expect(reservedPortsValue("every port")).toBeNull();
    expect(reservedPortsValue("70000")).toBeNull();
  });

  test("the file sets the key alone, and refuses anything but ports", () => {
    const file = portReservationFile("3000-3099,21000-29999");
    expect(file.split("\n").filter((line) => line !== "" && !line.startsWith("#"))).toEqual(["net.ipv4.ip_local_reserved_ports = 3000-3099,21000-29999"]);
    expect(PORT_RESERVATION_FILE).toBe("/etc/sysctl.d/90-sitesolide-service-ports.conf");
    expect(() => portReservationFile("3000; reboot")).toThrow();
  });

  test("the kernel reaches a block only when its range meets one and a port of it is not reserved", () => {
    // Debian's default, 32768 to 60999: clear of both blocks, reserved or not.
    expect(autobindReachesBlocks("32768\t60999", "")).toBe(false);
    // Widened: it meets both, until both are reserved.
    expect(autobindReachesBlocks("1024\t65535", "")).toBe(true);
    expect(autobindReachesBlocks("1024\t65535", "3000-3099")).toBe(true);
    expect(autobindReachesBlocks("1024\t65535", "3000-3099,21000-29999")).toBe(false);
    expect(autobindReachesBlocks("25000 40000", "21000-24999")).toBe(true);
    expect(autobindReachesBlocks("25000 40000", "21000-29999")).toBe(false);
    expect(autobindReachesBlocks("x", "")).toBeNull();
    expect(autobindReachesBlocks("1024 65535", "x")).toBeNull();
  });
});

describe("behind a tunnel", () => {
  test("a machine served directly gets the rule it had, with nothing of the tunnel", () => {
    for (const mode of ["close", "observe"] as const) {
      const rule = loopbackRule(CADDY, mode, DASHBOARD);
      expect(rule).toBe(loopbackRule(CADDY, mode, DASHBOARD, mode, null));
      expect(rule).not.toContain(`dport ${CADDY_HTTPS_PORT}`);
      expect(rule).not.toContain("saddr");
    }
  });

  test.each(["close", "observe"] as const)("%s: from ::1 to Caddy's 443, the connector alone; from 127.0.0.1, everyone as before", (mode: LoopbackMode) => {
    const rule = loopbackRule(CADDY, mode, DASHBOARD, mode, TUNNEL);
    expect(rule).toInclude(
      `\t\toifname "lo" ip6 saddr ::1 tcp dport 443 meta skuid ${TUNNEL} accept\n\t\toifname "lo" ip6 saddr ::1 tcp dport 443 ct state new counter `,
    );
    expect(rulesOf(rule)).toHaveLength(8);
    const allowed: Issue = { verdict: "accepted", logged: false };
    const other: Issue = mode === "close" ? { verdict: "refused", logged: false } : { verdict: "accepted", logged: true };
    const expected: [uid: number, port: number, from: string, issue: Issue][] = [
      [TUNNEL, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, allowed],
      // Nobody else, root and Caddy included: nothing of theirs uses ::1.
      [0, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      [CADDY, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      [DASHBOARD, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      [PROJECT, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      [OTHER, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      [NOBODY, CADDY_HTTPS_PORT, TUNNEL_ORIGIN, other],
      // 127.0.0.1, where Caddy believes no header: the monitor's and the
      // gatekeeper's probes, and anyone's, as on a machine served directly.
      [OTHER, CADDY_HTTPS_PORT, "127.0.0.1", allowed],
      [PROJECT, CADDY_HTTPS_PORT, "127.0.0.1", allowed],
      [TUNNEL, CADDY_HTTPS_PORT, "127.0.0.1", allowed],
      // ::1 to any other port: the rule of before.
      [OTHER, 8443, TUNNEL_ORIGIN, allowed],
      [OTHER, FIRST_BLOCK.first, TUNNEL_ORIGIN, other],
      [OTHER, SECOND_BLOCK.first, TUNNEL_ORIGIN, other],
      // The connector is no exception elsewhere.
      [TUNNEL, FIRST_BLOCK.first, "127.0.0.1", other],
      [TUNNEL, CADDY_ADMIN_PORT, "127.0.0.1", other],
      [TUNNEL, PORTAL_PORT, "127.0.0.1", other],
    ];
    for (const [uid, port, from, issue] of expected) {
      expect({ uid, port, from, issue: walk(rule, uid, port, PROJECT_PAIRS, from) }).toEqual({ uid, port, from, issue });
    }
    // The rest walks as without the tunnel.
    expect(walk(rule, OTHER, FIRST_BLOCK.first)).toEqual(walk(loopbackRule(CADDY, mode, DASHBOARD), OTHER, FIRST_BLOCK.first));
    expect(walk(rule, CADDY, CADDY_ADMIN_PORT)).toEqual(allowed);
  });

  test("the check's patterns recognise the tunnel's lines, as written and as nft list table renders them, for this uid and mode alone", () => {
    for (const mode of ["close", "observe"] as const) {
      const found = ranks(tunnelPatterns(TUNNEL, mode), loopbackRule(CADDY, mode, DASHBOARD, mode, TUNNEL));
      expect(found.every((index) => index >= 0)).toBe(true);
      expect(found[0]!).toBeLessThan(found[1]!);
    }
    expect(ranks(tunnelPatterns(TUNNEL, "close"), loopbackRule(CADDY, "observe", DASHBOARD, "observe", TUNNEL))[1]).toBe(-1);
    expect(ranks(tunnelPatterns(TUNNEL + 1, "close"), loopbackRule(CADDY, "close", DASHBOARD, "close", TUNNEL))[0]).toBe(-1);
    expect(ranks(tunnelPatterns(TUNNEL, "close"), loopbackRule(CADDY, "close", DASHBOARD)).every((index) => index === -1)).toBe(true);
    // Recorded on the test machine, nftables 1.1.3 on Debian 13.
    const listed = [
      '\t\toifname "lo" ip6 saddr ::1 tcp dport 443 meta skuid 987 accept',
      '\t\toifname "lo" ip6 saddr ::1 tcp dport 443 ct state new counter packets 1 bytes 80 limit rate 30/minute burst 5 packets log prefix "sitesolide-loopback: " flags skuid',
      '\t\toifname "lo" ip6 saddr ::1 tcp dport 443 ct state new counter packets 1 bytes 80 reject with tcp reset',
    ];
    expect(ranks(tunnelPatterns(TUNNEL, "observe"), listed.slice(0, 2).join("\n"))).toEqual([0, 1]);
    expect(ranks(tunnelPatterns(TUNNEL, "close"), [listed[0], listed[2]].join("\n"))).toEqual([0, 1]);
  });

  test("a connector uid read wrong is refused, Caddy's and the dashboard's included", () => {
    for (const uid of [0, -1, Number.NaN, 1.5, 65534, 70000, CADDY, DASHBOARD]) {
      expect(() => loopbackRule(CADDY, "close", DASHBOARD, "close", uid)).toThrow(/tunnel's connector/);
    }
    for (const uid of [0, -1, Number.NaN, 65534]) expect(() => tunnelPatterns(uid, "close")).toThrow();
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
  function container(mode: LoopbackMode, adminMode: LoopbackMode = mode, tunnelUid: number | null = null): { code: number; output: string } {
    // The admin API listens on both of its loopbacks and on the container's
    // address: a future configuration could change Caddy's one, and the kernel
    // routes through lo what a process sends to its own address.
    const script = `
set -e
apk add --quiet --no-progress nftables curl busybox-extras >/dev/null
adduser -D -u ${CADDY} caddy
adduser -D -u ${DASHBOARD} dashboard
adduser -D -u ${OTHER} other
adduser -D -u ${PROJECT} project
adduser -D -u ${TUNNEL} tunnel
mkdir -p /srv/www && echo ok > /srv/www/index.html
IP=$(ip -4 addr show dev eth0 | awk '/inet /{print $2; exit}' | cut -d/ -f1)
[ -n "$IP" ]
httpd -p 127.0.0.1:3022 -h /srv/www
httpd -p 127.0.0.1:${PORTAL_PORT} -h /srv/www
httpd -p 127.0.0.1:8080 -h /srv/www
httpd -p 127.0.0.1:3050 -h /srv/www
httpd -p 127.0.0.1:3052 -h /srv/www
httpd -p 127.0.0.1:${SECOND_BLOCK.first} -h /srv/www
httpd -p 127.0.0.1:${SECOND_BLOCK.last} -h /srv/www
httpd -p [::1]:3043 -h /srv/www
httpd -p 127.0.0.1:${CADDY_ADMIN_PORT} -h /srv/www
httpd -p [::1]:${CADDY_ADMIN_PORT} -h /srv/www
httpd -p $IP:${CADDY_ADMIN_PORT} -h /srv/www
httpd -p 127.0.0.1:${CADDY_HTTPS_PORT} -h /srv/www
httpd -p [::1]:${CADDY_HTTPS_PORT} -h /srv/www
cat > /rule.nft <<'RULE'
${loopbackRule(CADDY, mode, DASHBOARD, adminMode, tunnelUid)}
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
echo "caddy:second=$(code caddy http://127.0.0.1:${SECOND_BLOCK.first}/)"
echo "root:second=$(root http://127.0.0.1:${SECOND_BLOCK.last}/)"
echo "other:second=$(code other http://127.0.0.1:${SECOND_BLOCK.first}/)"
echo "other:second:last=$(code other http://127.0.0.1:${SECOND_BLOCK.last}/)"
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
# Caddy's HTTPS, from ::1 and from 127.0.0.1: the tunnel's lines, when laid.
for who in tunnel caddy other project dashboard; do
  echo "$who:https:v6=$(code $who 'http://[::1]:${CADDY_HTTPS_PORT}/')"
  echo "$who:https:v4=$(code $who http://127.0.0.1:${CADDY_HTTPS_PORT}/)"
done
echo "root:https:v6=$(root 'http://[::1]:${CADDY_HTTPS_PORT}/')"
echo "root:https:v4=$(root http://127.0.0.1:${CADDY_HTTPS_PORT}/)"
echo "--- list"
nft list table inet ${LOOPBACK_TABLE}
echo "--- end"
# After the listing: replaying the table below resets its counters.
cat > /projects.nft <<'RULE'
${projectPortsFile([{ manifest: SEVERAL, uid: PROJECT }])}
RULE
echo "project:3052:empty=$(code project http://127.0.0.1:3052/)"
nft -c -f /projects.nft
nft -f /projects.nft
nft -f /projects.nft
echo "project:3050=$(code project http://127.0.0.1:3050/)"
echo "project:3052=$(code project http://127.0.0.1:3052/)"
echo "project:3022=$(code project http://127.0.0.1:3022/)"
echo "project:admin=$(code project http://127.0.0.1:${CADDY_ADMIN_PORT}/)"
echo "other:3052=$(code other http://127.0.0.1:3052/)"
echo "caddy:3052=$(code caddy http://127.0.0.1:3052/)"
nft -f /rule.nft
echo "project:3052:replayed=$(code project http://127.0.0.1:3052/)"
nft -f /projects.nft
echo "project:3052:refilled=$(code project http://127.0.0.1:3052/)"
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
    // Outside the blocks, nothing changes.
    expect(output).toInclude("other:8080=200");
    // The second block, as closed as the first, and read as reserved in the listing.
    expect(output).toInclude("caddy:second=200");
    expect(output).toInclude("root:second=200");
    expect(output).toInclude("other:second=000");
    expect(output).toInclude("other:second:last=000");
    expect(reservesEveryBlock(list(output))).toBe(true);
    // The dashboard reaches the portal, and nothing else; the exception
    // benefits nobody else.
    expect(output).toInclude("dashboard:portal=200");
    expect(output).toInclude("dashboard:3022=000");
    expect(output).toInclude("other:portal=000");
    // A project with several services: its own ports, and nothing else. The
    // set is empty until its file is loaded, emptied again when the table is
    // replayed, and filled again by replaying the file, as the boot unit and
    // bin/deploy-loopback.sh do.
    expect(output).toInclude("project:3052:empty=000");
    expect(output).toInclude("project:3050=200");
    expect(output).toInclude("project:3052=200");
    expect(output).toInclude("project:3022=000");
    expect(output).toInclude("project:admin=000");
    expect(output).toInclude("other:3052=000");
    expect(output).toInclude("caddy:3052=200");
    expect(output).toInclude("project:3052:replayed=000");
    expect(output).toInclude("project:3052:refilled=200");
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
    // Served directly, Caddy's 443 stays everyone's, from either loopback.
    for (const who of ["root", "tunnel", "caddy", "other", "project", "dashboard"]) {
      expect(output).toInclude(`${who}:https:v6=200`);
      expect(output).toInclude(`${who}:https:v4=200`);
    }
  }, 120_000);

  test("behind a tunnel: Caddy's 443 from ::1 to the connector alone, from 127.0.0.1 to all, the rest as served directly", () => {
    const { code, output } = container("close", "close", TUNNEL);
    expect(code).toBe(0);
    expect(output).toInclude("tunnel:https:v6=200");
    for (const who of ["root", "caddy", "other", "project", "dashboard"]) expect(output).toInclude(`${who}:https:v6=000`);
    for (const who of ["root", "tunnel", "caddy", "other", "project", "dashboard"]) expect(output).toInclude(`${who}:https:v4=200`);
    expect(output).toInclude("caddy:3022=200");
    expect(output).toInclude("other:3022=000");
    expect(output).toInclude("dashboard:portal=200");
    expect(output).toInclude("project:3052=200");
    for (const family of ["v4", "v6", "ip"]) expect(output).toInclude(`other:admin:${family}=000`);
    // What bin/deploy-loopback.sh looks for, both blocks, as the kernel lists them.
    for (const patterns of [adminPatterns(CADDY, "close"), tunnelPatterns(TUNNEL, "close")]) {
      const found = ranks(patterns, list(output));
      expect(found.every((index) => index >= 0)).toBe(true);
      expect(found[0]!).toBeLessThan(found[1]!);
    }
  }, 120_000);

  test("observe: nobody is refused, the others are counted", () => {
    const { code, output } = container("observe");
    expect(code).toBe(0);
    expect(output).toInclude("other:3022=200");
    expect(output).toInclude("other:v6:3043=200");
    expect(output).toInclude("project:3022=200");
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

describe("the project set", () => {
  test("replaces every element at once, the projects with several services alone", () => {
    const single: Manifest = { slug: "budget", port: 3022, start: "/usr/local/bin/bun run server.ts" };
    const file = projectPortsFile([
      { manifest: SEVERAL, uid: PROJECT },
      { manifest: single, uid: 1700 },
    ]);
    const lines = file.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines).toEqual([
      `flush set inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET}`,
      `add element inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET} { 3050 . ${PROJECT}, 3051 . ${PROJECT}, 3052 . ${PROJECT} }`,
    ]);
  });

  test("with no such project, the set is emptied", () => {
    const lines = projectPortsFile([]).split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines).toEqual([`flush set inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET}`]);
  });

  test("a uid read wrong is refused: the ports would open to root or to nobody", () => {
    for (const uid of [0, -1, Number.NaN, 1.5, 65534]) {
      expect(() => projectPortsFile([{ manifest: SEVERAL, uid }])).toThrow(/uid/);
    }
  });

  test("a worker or a scheduled service has no port to open: its siblings' ports are the project's pairs", () => {
    const mixed: Manifest = {
      slug: "relay",
      services: {
        web: { start: "/srv/sites/relay/app/web", port: 3060 },
        queue: { start: "/srv/sites/relay/app/queue", internal: true },
        sync: { start: "/srv/sites/relay/app/sync", schedule: "hourly" },
      },
    };
    expect(reachesOwnPorts(mixed)).toBe(true);
    expect(projectPortPairs([{ manifest: mixed, uid: PROJECT }])).toEqual([`3060 . ${PROJECT}`]);
  });

  test("a project whose services all listen on nothing reaches no port of its own, and stays out of the set", () => {
    const background: Manifest = {
      slug: "relay",
      services: {
        queue: { start: "/srv/sites/relay/app/queue", internal: true },
        sync: { start: "/srv/sites/relay/app/sync", schedule: "hourly" },
      },
    };
    expect(reachesOwnPorts(background)).toBe(false);
    expect(projectPortPairs([{ manifest: background, uid: PROJECT }])).toEqual([]);
    expect(reachesOwnPorts(SEVERAL)).toBe(true);
  });
});

describe("what the script reads from the CLI", () => {
  test("the machine's read and the listening filter come back as the modules write them, in a terminal that forces colour too", () => {
    const script = readFileSync(join(REPO_ROOT, "bin", "deploy-loopback.sh"), "utf8");
    const commands = [...script.matchAll(/^(STATE_COMMAND|LISTENING_FILTER)="\$\(cd "\$REPO_ROOT" && bun -e '([^']+)'\)"$/gm)];
    expect(commands.map((match) => match[1])).toEqual(["STATE_COMMAND", "LISTENING_FILTER"]);
    const expected: Record<string, string> = { STATE_COMMAND: secondBlockStateCommand(), LISTENING_FILTER: listeningFilter() };
    for (const [, name, code] of commands) {
      const run = Bun.spawnSync(["bun", "-e", code!], { cwd: REPO_ROOT, env: { ...process.env, FORCE_COLOR: "1" }, stdout: "pipe" });
      expect({ name, printed: run.stdout.toString() }).toEqual({ name, printed: `${expected[name!]}\n` });
    }
  });

  test("the machine is read before anything is laid, the ports reserved before the rule, the loaded rule checked for every block", () => {
    const script = readFileSync(join(REPO_ROOT, "bin", "deploy-loopback.sh"), "utf8");
    // Before the rule is even generated: nothing is laid while a unit or a component may listen in the second block.
    const read = script.indexOf('STATE_ANSWER="$(ssh');
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(script.indexOf('> "$WORK/loopback.nft"'));
    expect(script).toInclude("unguardedUnits(state)");
    expect(script).toInclude('state.components[name] === "outdated"');
    // Anything already listening on the second block that no deposited manifest accounts for, named down to its unit.
    expect(script).toInclude("strayListeners(state.listeners, deposited.manifests)");
    expect(script.indexOf('MANIFESTS_ANSWER="$(ssh')).toBeLessThan(script.indexOf('> "$WORK/loopback.nft"'));
    expect(script).toInclude("ps -o pid=,unit=,args=");
    // The reservation, laid and read back from the kernel before the safety net and the rule.
    const reserved = script.indexOf("sudo sysctl -q -p $RESERVATION");
    expect(reserved).toBeGreaterThan(read);
    expect(reserved).toBeLessThan(script.indexOf("--on-active=120"));
    expect(script.indexOf("autobindReachesBlocks(range, reserved) === false")).toBeGreaterThan(reserved);
    expect(script).toInclude(`RESERVATION=${PORT_RESERVATION_FILE}`);
    // The services' lines found in what the kernel loaded, in the rule's mode.
    expect(script.indexOf('done <<< "$SERVICES_PATTERNS"')).toBeGreaterThan(script.indexOf('LOADED="$(ssh'));
    expect(script).toInclude("ss -ltnH '( $LISTENING_FILTER )'");
  });

  test("its ports come back as digits alone, in a terminal that forces colour too", () => {
    // A port printed by console.log came back as \e[33m2019\e[0m under
    // FORCE_COLOR=1, and every probe of the script asked a URL curl could
    // not read: setup failed at the loopback rule from such a terminal.
    const script = readFileSync(join(REPO_ROOT, "bin", "deploy-loopback.sh"), "utf8");
    const commands = [...script.matchAll(/^(PORTAL_PORT|ADMIN_PORT)="\$\(cd "\$REPO_ROOT" && bun -e '([^']+)'\)"$/gm)];
    expect(commands.map((match) => match[1])).toEqual(["PORTAL_PORT", "ADMIN_PORT"]);
    for (const [, name, code] of commands) {
      const run = Bun.spawnSync(["bun", "-e", code!], { cwd: REPO_ROOT, env: { ...process.env, FORCE_COLOR: "1" }, stdout: "pipe" });
      expect({ name, printed: run.stdout.toString() }).toEqual({ name, printed: expect.stringMatching(/^\d+\n$/) });
    }
  });
});
