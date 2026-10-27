/**
 * The loopback rule: on the machine, only Caddy and root open a connection
 * towards the services' ports, both blocks of SERVICE_PORT_RANGES in
 * bin/cli/manifest.ts, and towards Caddy's admin API. One exception,
 * and one only: the dashboard towards the portal, where it creates and revokes
 * guest accesses.
 *
 * Every generated unit carries `IPAddressAllow=localhost`, and nothing else
 * stopped a service from reaching another one's port. As long as each site
 * checked its own session, that was only one more door to get through. A site
 * behind the portal checks nothing any more: it trusts Caddy, and this rule is
 * what makes that trust well founded. Without it, a compromised service would
 * read the database of a protected site through its API, with no cookie.
 *
 * The same loopback led to worse: Caddy's admin API, which has no
 * authentication at all. A compromised service put a configuration without
 * `forward_auth` there, which opened all the portal's sites at once, or stopped
 * Caddy, and therefore every site on the machine. See CADDY_ADMIN_PORT.
 *
 * Behind a Cloudflare Tunnel, one more: Caddy believes the visitor's address
 * in `Cf-Connecting-Ip` from ::1 alone, where the connector reaches it, and
 * the rule keeps ::1 to the connector. Without it, any service opened a
 * connection from there with any address in that header, and was counted as
 * that visitor. See TUNNEL_ORIGIN.
 *
 * A separate nftables table, `inet` for IPv4 and IPv6 at once, which neither
 * ufw nor a Caddy reload touches. `oifname "lo"` holds there for both families,
 * and for any address of the machine: the kernel sends through the loopback
 * what a process sends to its own public address. `nft -f` applies it as one
 * block: a syntax error lets none of its lines through.
 *
 * Pure: returns text. Depositing belongs to bin/deploy-loopback.sh, which
 * checks it and removes it on its own at the slightest deviation.
 */

import { isServicePort, portRangeText, SERVICE_PORT_RANGES, servicesOf, hasServices, type Manifest, type PortRange } from "./manifest";
import { PORTAL_PORT } from "./portal";

export const LOOPBACK_TABLE = "sitesolide_boucle";

/**
 * The set of `port . uid` pairs the rule lets through: a project reaching its
 * own ports, and nobody else's (reachesOwnPorts). Without it, the front of a
 * project of several services could not call its own API, nor a service's
 * backup command reach its service, the rule refusing every account but
 * Caddy and root.
 *
 * The table declares the set empty; its elements live in PROJECT_PORTS_FILE,
 * rebuilt by `sitesolide deploy` from the manifests on the machine and loaded
 * after the table, at boot as after bin/deploy-loopback.sh. Recreating the
 * table empties the set, which is why the file is replayed each time.
 */
export const PROJECT_PORTS_SET = "project_ports";
export const PROJECT_PORTS_FILE = "/etc/sitesolide-loopback-projects.nft";

/**
 * Caddy's admin API: `localhost:2019`, its default value, the global block of
 * infra/caddy/Caddyfile carrying no `admin` directive. It authenticates nobody:
 * whoever reaches it replaces the configuration of every site or stops Caddy.
 *
 * Only two accounts have any business opening it. `caddy`, because
 * `systemctl reload caddy` goes through it: PID 1 launches the unit's
 * `ExecReload`, `caddy reload --config /etc/caddy/Caddyfile --force`, under the
 * unit's `User=caddy`, whatever account asked for the reload. And root, for the
 * gatekeeper and the repository's scripts, which only go through that
 * `systemctl reload`. No code in the repository calls it directly.
 *
 * Outside the services' blocks, hence its own two rules and their own counter.
 * bin/tests/cli-loopback.test.ts checks that the Caddyfile does not move it onto
 * a port the rule would no longer close.
 */
export const CADDY_ADMIN_PORT = 2019;

/**
 * Caddy's HTTPS, which the tunnel's connector reaches from TUNNEL_ORIGIN.
 * From any other address it stays open to every account, as on a machine
 * served directly: the monitor's and the gatekeeper's probes reach it on
 * 127.0.0.1, where Caddy believes no header.
 */
export const CADDY_HTTPS_PORT = 443;

/**
 * Where the tunnel's connector reaches Caddy: ::1, the loopback's IPv6
 * address, which nothing else on the machine uses to reach it. Caddy believes
 * the visitor's address in Cf-Connecting-Ip from there alone
 * (infra/tunnel/tunnel.caddy), and this rule refuses every other account,
 * root included, a connection from there to its 443.
 *
 * Not 127.0.0.1, where the monitor's and the gatekeeper's probes reach Caddy,
 * and any project's service can: Caddy cannot tell one account from another
 * by an address they share, and believing the header there let a project's
 * service open 127.0.0.1:443 with any address in it and be counted as that
 * visitor, by the analytics and by the dashboard's limiter (measured on the
 * test machine, 25 October 2026). Nor another address of 127.0.0.0/8: a
 * connection to it still leaves from 127.0.0.1, as `ip route get` says.
 *
 * The loopback must therefore keep its IPv6, which Debian gives it: without
 * ::1, the connector reaches no site. The tunnel's step of setup refuses a
 * machine without it (bin/cli/tunnel.ts).
 */
export const TUNNEL_ORIGIN = "::1";

/**
 * The services' ports as the rule writes them, every block in one anonymous
 * set: `{ 3000-3099, 21000-29999 }`. nftables takes several intervals in a
 * set, and walks it as one match.
 */
export function servicePortsSet(): string {
  return `{ ${SERVICE_PORT_RANGES.map(portRangeText).join(", ")} }`;
}

/**
 * Does a rule, as loopbackRule writes it or as `nft list table` renders it,
 * refuse the others on every block of the services' ports? The line it
 * looks for is the one that closes them, `ct state new` then the refusal,
 * `reject with tcp reset`, counters or not. A rule laid before the second
 * block names 3000-3099 alone there, and does not pass; nor does a rule in
 * `observe`, which lets every account connect and only counts it.
 *
 * What `deploy`, the installer and the monitor ask before letting a project
 * listen in the second block (secondBlockRefusal in bin/cli/services.ts). A
 * listing that renders the set otherwise than expected reads as not
 * reserved: the second block stays shut, never open to everyone.
 */
export function reservesEveryBlock(listing: string): boolean {
  for (const line of listing.split("\n")) {
    const match = /^\s*oifname "lo" tcp dport (?:\{ ([^}]+) \}|(\S+)) ct state new (.*)$/.exec(line);
    if (match === null) continue;
    if (!new RegExp(`^${verdictPattern("close")}$`).test(match[3]!.trim())) continue;
    const listed = (match[1] ?? match[2]!).split(",").map((element) => element.trim());
    if (SERVICE_PORT_RANGES.every((range) => listed.includes(portRangeText(range)))) return true;
  }
  return false;
}

/**
 * The two lines of the services' ports, Caddy and root let through then the
 * others refused or counted, as adminPatterns gives the API's: what
 * bin/deploy-loopback.sh looks for in the loaded rule, every block in the
 * set, in the rule's own mode.
 */
export function servicesPatterns(caddyUid: number, mode: LoopbackMode): string[] {
  checkCaddyUid(caddyUid);
  const ports = servicePortsSet().replace(/[{}]/g, (brace) => `\\${brace}`);
  return [
    `oifname "lo" tcp dport ${ports} meta skuid \\{ 0, ${caddyUid} \\} accept$`,
    `oifname "lo" tcp dport ${ports} ct state new ${verdictPattern(mode)}$`,
  ];
}

// --- the ports the kernel hands out by itself ----------------------------------

/**
 * Where the ports of every block are kept out of the kernel's own choice.
 *
 * SocketBindDeny= is a BPF program on bind(2), which compares the port the
 * process asks for with the rules (src/core/bpf/socket_bind in systemd): a
 * bind to port 0 asks for no port of a block and goes through, and a socket
 * that listens or connects without bind(2) never meets the program at all.
 * The kernel then picks a port in `net.ipv4.ip_local_port_range`, 32768 to
 * 60999 by default, clear of both blocks; on a machine whose range was
 * widened, it could hand a project a port of a block, or every free one in
 * turn. `net.ipv4.ip_local_reserved_ports` keeps the listed ports out of
 * that choice, a bind that names one still allowed; it holds for IPv6 too.
 * bin/deploy-loopback.sh lays this file and applies it before the rule.
 */
export const PORT_RESERVATION_FILE = "/etc/sysctl.d/90-sitesolide-service-ports.conf";

/** A list of ports as the kernel writes them, `3000-3099,21000-29999`, read into ranges; null when it does not read. */
function readPortList(text: string): PortRange[] | null {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const ranges: PortRange[] = [];
  for (const element of trimmed.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(element.trim());
    if (match === null) return null;
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first > last || last > 65535) return null;
    ranges.push({ first, last });
  }
  return ranges;
}

/** Ranges sorted and merged, as the kernel lists them. */
function mergeRanges(ranges: readonly PortRange[]): PortRange[] {
  const merged: { first: number; last: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.first - b.first)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.first <= previous.last + 1) previous.last = Math.max(previous.last, range.last);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * The value to write: the reservations the machine already has, kept, and
 * every block. Writing the key replaces the whole list, so what another
 * file or person reserved is carried over. Null when the live value does not
 * read: nothing is written then.
 */
export function reservedPortsValue(live: string): string | null {
  const current = readPortList(live);
  if (current === null) return null;
  return mergeRanges([...current, ...SERVICE_PORT_RANGES]).map(portRangeText).join(",");
}

/** The file PORT_RESERVATION_FILE holds, for `value`. */
export function portReservationFile(value: string): string {
  if (!/^[0-9,-]+$/.test(value)) throw new Error(`unexpected port list: ${value}`);
  return [
    "# Laid by bin/deploy-loopback.sh from bin/cli/loopback.ts: the services' ports,",
    "# kept out of the ports the kernel picks by itself, which SocketBindDeny=",
    "# never sees. Do not edit: the next deposit overwrites it.",
    `net.ipv4.ip_local_reserved_ports = ${value}`,
    "",
  ].join("\n");
}

/**
 * Can the kernel hand a process a port of a block by itself? Not when the
 * ephemeral range, `ip_local_port_range` as `32768\t60999`, misses a block,
 * nor when every port of the block it meets is reserved. Null when either
 * value does not read: then nothing opens.
 */
export function autobindReachesBlocks(portRange: string, reserved: string): boolean | null {
  const bounds = portRange.trim().split(/\s+/).map(Number);
  const list = readPortList(reserved);
  if (bounds.length !== 2 || !bounds.every((bound) => Number.isInteger(bound) && bound >= 0 && bound <= 65535) || list === null) return null;
  const [low, high] = bounds as [number, number];
  return SERVICE_PORT_RANGES.some((range) => {
    for (let port = Math.max(range.first, low); port <= Math.min(range.last, high); port++) {
      if (!list.some((kept) => port >= kept.first && port <= kept.last)) return true;
    }
    return false;
  });
}

/**
 * The listening sockets of every block, as `ss` filters them:
 * bin/deploy-loopback.sh tries Caddy and another account on each.
 */
export function listeningFilter(): string {
  return SERVICE_PORT_RANGES.map((range) => `( sport >= :${range.first} and sport <= :${range.last} )`).join(" or ");
}

/**
 * `observe` counts and logs what `close` would refuse, refusing nothing:
 * enough to know, before closing, whether a service reaches a port other than
 * its own.
 */
export type LoopbackMode = "observe" | "close";

/**
 * root is 0 and does not need naming twice; a uid that is not a positive
 * integer would come from a failed reading on the VM, and the rule would then
 * close off Caddy itself, and therefore every site.
 */
function checkCaddyUid(caddyUid: number): void {
  if (!Number.isInteger(caddyUid) || caddyUid <= 0 || caddyUid >= 65534) {
    throw new Error(`unexpected uid for Caddy: ${caddyUid}`);
  }
}

/** The connector's, read on the VM like Caddy's: a failed read must let nobody else through. */
function checkTunnelUid(tunnelUid: number): void {
  if (!Number.isInteger(tunnelUid) || tunnelUid <= 0 || tunnelUid >= 65534) {
    throw new Error(`unexpected uid for the tunnel's connector: ${tunnelUid}`);
  }
}

/** What the rule does with the other accounts, depending on the mode. */
function othersVerdict(mode: LoopbackMode): string {
  return mode === "close"
    ? "counter reject with tcp reset"
    : // The uid in the log: enough to name the service reaching another port.
      'counter limit rate 30/minute log prefix "sitesolide-loopback: " flags skuid';
}

/**
 * `dashboardUid` is that of `site-dashboard`, read on the VM like Caddy's. It
 * opens the portal's port and that one alone: the portal's `/admin/*` routes
 * have no guard other than this rule, Caddy never relaying them. See
 * portal/src/admin.ts.
 *
 * `adminMode` sets the admin API separately, and defaults to the mode of the
 * whole rule. Enough to observe it on its own: switching all of it to
 * `observe` would reopen the services' ports, already closed, for the duration
 * of the observation.
 *
 * `tunnelUid` is that of the tunnel's connector, TUNNEL_ACCOUNT in
 * bin/cli/tunnel.ts, on a machine served through a Cloudflare Tunnel, and
 * null on one served directly, whose rule stays what it was. It follows the
 * mode of the whole rule.
 */
export function loopbackRule(
  caddyUid: number,
  mode: LoopbackMode,
  dashboardUid: number,
  adminMode: LoopbackMode = mode,
  tunnelUid: number | null = null,
): string {
  checkCaddyUid(caddyUid);
  // The same refusal for the dashboard, and one more: mistaken for Caddy, it
  // would receive every port without the rule saying so.
  if (!Number.isInteger(dashboardUid) || dashboardUid <= 0 || dashboardUid >= 65534 || dashboardUid === caddyUid) {
    throw new Error(`unexpected uid for the dashboard: ${dashboardUid}`);
  }
  // The connector's, mistaken for Caddy's or the dashboard's, would let that
  // account speak from the address Caddy believes the header from.
  if (tunnelUid !== null) {
    checkTunnelUid(tunnelUid);
    if (tunnelUid === caddyUid || tunnelUid === dashboardUid) throw new Error(`unexpected uid for the tunnel's connector: ${tunnelUid}`);
  }

  const ports = servicePortsSet();
  const others = othersVerdict(mode);
  const adminOthers = othersVerdict(adminMode);

  return [
    "# Generated by bin/deploy-loopback.sh from bin/cli/loopback.ts. Do not edit:",
    "# the next deposit overwrites it.",
    adminMode === mode ? `# Mode: ${mode}.` : `# Mode: ${mode}, admin API: ${adminMode}.`,
    "",
    "# Create then delete: the table always exists at the moment of deleting it,",
    "# and the file replays without error, whether it was already laid or not.",
    `table inet ${LOOPBACK_TABLE}`,
    `delete table inet ${LOOPBACK_TABLE}`,
    "",
    `table inet ${LOOPBACK_TABLE} {`,
    "\t# Filled from PROJECT_PORTS_FILE: see PROJECT_PORTS_SET in bin/cli/loopback.ts.",
    `\tset ${PROJECT_PORTS_SET} {`,
    "\t\ttypeof tcp dport . meta skuid",
    "\t}",
    "",
    "\tchain output {",
    "\t\ttype filter hook output priority filter; policy accept;",
    "",
    "\t\t# Caddy and root, on every block of the services' ports. The owner of",
    "\t\t# an outgoing packet is that of the process that opened the connection.",
    `\t\toifname "lo" tcp dport ${ports} meta skuid { 0, ${caddyUid} } accept`,
    "",
    "\t\t# The dashboard to the portal, and to it alone: it creates and",
    "\t\t# revokes guest accesses there. See portal/src/admin.ts.",
    `\t\toifname "lo" tcp dport ${PORTAL_PORT} meta skuid ${dashboardUid} accept`,
    "",
    "\t\t# A project with several services to its own ports, and to them alone.",
    `\t\toifname "lo" tcp dport . meta skuid @${PROJECT_PORTS_SET} accept`,
    "",
    "\t\t# All the others.",
    `\t\toifname "lo" tcp dport ${ports} ct state new ${others}`,
    "",
    "\t\t# Caddy's admin API, which authenticates nobody: Caddy, for systemctl",
    "\t\t# reload caddy, and root. Nobody else, not even the dashboard. Two",
    "\t\t# separate rules for a separate counter.",
    `\t\toifname "lo" tcp dport ${CADDY_ADMIN_PORT} meta skuid { 0, ${caddyUid} } accept`,
    `\t\toifname "lo" tcp dport ${CADDY_ADMIN_PORT} ct state new ${adminOthers}`,
    ...(tunnelUid === null
      ? []
      : [
          "",
          "\t\t# Behind a Cloudflare Tunnel: Caddy believes the visitor's address in",
          "\t\t# Cf-Connecting-Ip from ::1 alone, where the connector reaches it,",
          "\t\t# and the connector alone opens a connection from there to its",
          "\t\t# HTTPS. Nobody else, not even root. See TUNNEL_ORIGIN in",
          "\t\t# bin/cli/loopback.ts.",
          `\t\toifname "lo" ip6 saddr ${TUNNEL_ORIGIN} tcp dport ${CADDY_HTTPS_PORT} meta skuid ${tunnelUid} accept`,
          `\t\toifname "lo" ip6 saddr ${TUNNEL_ORIGIN} tcp dport ${CADDY_HTTPS_PORT} ct state new ${others}`,
        ]),
    "\t}",
    "}",
    "",
  ].join("\n");
}

/**
 * The two lines of the admin API, in the order they must read, as extended
 * regular expressions: `grep -E` in bin/deploy-loopback.sh, `RegExp` in the
 * tests. They recognise the rule both as this module writes it and as
 * `nft list table` renders it, with its counters and `limit`'s default burst
 * (measured on nftables 1.0.9 and 1.1.3, the one in Debian 13). A rule in
 * another mode, or put in place for another uid, does not pass. `mode` is the
 * API's: the `adminMode` passed to loopbackRule.
 */
export function adminPatterns(caddyUid: number, mode: LoopbackMode): string[] {
  checkCaddyUid(caddyUid);
  return [
    `oifname "lo" tcp dport ${CADDY_ADMIN_PORT} meta skuid \\{ 0, ${caddyUid} \\} accept$`,
    `oifname "lo" tcp dport ${CADDY_ADMIN_PORT} ct state new ${verdictPattern(mode)}$`,
  ];
}

/**
 * The tunnel's two lines, as adminPatterns gives the API's: what
 * bin/deploy-loopback.sh looks for in the loaded rule on a machine served
 * through a tunnel. `mode` is the whole rule's.
 */
export function tunnelPatterns(tunnelUid: number, mode: LoopbackMode): string[] {
  checkTunnelUid(tunnelUid);
  const from = `oifname "lo" ip6 saddr ${TUNNEL_ORIGIN} tcp dport ${CADDY_HTTPS_PORT}`;
  return [`${from} meta skuid ${tunnelUid} accept$`, `${from} ct state new ${verdictPattern(mode)}$`];
}

/** The refusal of the others as written and as listed, with its counters and `limit`'s default burst. */
function verdictPattern(mode: LoopbackMode): string {
  const counter = "counter( packets [0-9]+ bytes [0-9]+)?";
  return mode === "close"
    ? `${counter} reject with tcp reset`
    : `${counter} limit rate 30/minute( burst [0-9]+ packets)? log prefix "sitesolide-loopback: " flags skuid`;
}

/** A project as the set sees it: its manifest, and the uid of its system user read on the VM. */
export type ProjectAccount = { manifest: Manifest; uid: number };

/**
 * Does the project reach its own ports, and so belong in PROJECT_PORTS_SET?
 * A project declaring `services`, whose services call each other; and one
 * whose service declares a backup command, which the backup component runs
 * as the project to reach that service on its port, `pg_basebackup` to its
 * PostgreSQL for one (dashboard/src/backup/hooks.ts). A single service without
 * one has nothing to call, and the rule stays what it was for every other site.
 */
export function reachesOwnPorts(manifest: Manifest): boolean {
  const services = servicesOf(manifest);
  // A project whose services all listen on nothing, workers and scheduled
  // runs, has no port of its own to reach.
  if (!services.some((service) => service.port !== null)) return false;
  return hasServices(manifest) || services.some((service) => service.backup !== null);
}

/**
 * The elements of PROJECT_PORTS_SET, as the file that replaces them all at
 * once: `flush` then `add`, which `nft -f` applies as one transaction. A file
 * that fails leaves the set as it was, and never touches the table's rules, so
 * a mistake here can cost a project its own calls, never Caddy its access.
 *
 * Only the projects that reach their own ports appear, see reachesOwnPorts.
 */
export function projectPortsFile(projects: ProjectAccount[]): string {
  const elements = projectPortPairs(projects);
  const lines = [
    "# Generated by bin/sitesolide.ts from the manifests on the machine. Do not",
    "# edit: the next deployment of a project reaching its own ports rewrites it.",
    `flush set inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET}`,
  ];
  if (elements.length > 0) {
    lines.push(`add element inet ${LOOPBACK_TABLE} ${PROJECT_PORTS_SET} { ${elements.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

/** The set's elements, `<port> . <uid>`, as nft writes and lists them. */
export function projectPortPairs(projects: ProjectAccount[]): string[] {
  const elements: string[] = [];
  for (const { manifest, uid } of projects) {
    if (!reachesOwnPorts(manifest)) continue;
    // Like Caddy's uid: a failed read must not open a port to root or to nobody.
    if (!Number.isInteger(uid) || uid <= 0 || uid >= 65534) {
      throw new Error(`unexpected uid for ${manifest.slug}: ${uid}`);
    }
    for (const service of servicesOf(manifest)) {
      // A worker or a scheduled service listens on nothing: it calls its
      // siblings' ports, which the pairs of the same uid already open.
      if (service.port === null) continue;
      if (!isServicePort(service.port)) {
        throw new Error(`${manifest.slug}: port ${service.port} is outside the services' blocks`);
      }
      elements.push(`${service.port} . ${uid}`);
    }
  }
  return elements;
}
