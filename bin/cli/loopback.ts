/**
 * The loopback rule: on the machine, only Caddy and root open a connection
 * towards the services' ports, and towards Caddy's admin API. One exception,
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
 * A separate nftables table, `inet` for IPv4 and IPv6 at once, which neither
 * ufw nor a Caddy reload touches. `oifname "lo"` holds there for both families,
 * and for any address of the machine: the kernel sends through the loopback
 * what a process sends to its own public address. `nft -f` applies it as one
 * block: a syntax error lets none of its lines through.
 *
 * Pure: returns text. Depositing belongs to bin/deploy-loopback.sh, which
 * checks it and removes it on its own at the slightest deviation.
 */

import { PORTAL_PORT } from "./portal";

export const LOOPBACK_TABLE = "sitesolide_boucle";

/**
 * The services' ports: 3000 the landing, 3001 the shared service, then the
 * sites and the projects. bin/tests/cli-loopback.test.ts checks that every unit
 * in the repository listens inside this range.
 */
export const SERVICE_PORTS = { first: 3000, last: 3099 };

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
 * Outside the services' range, hence its own two rules and their own counter.
 * bin/tests/cli-loopback.test.ts checks that the Caddyfile does not move it onto
 * a port the rule would no longer close.
 */
export const CADDY_ADMIN_PORT = 2019;

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
 */
export function loopbackRule(caddyUid: number, mode: LoopbackMode, dashboardUid: number, adminMode: LoopbackMode = mode): string {
  checkCaddyUid(caddyUid);
  // The same refusal for the dashboard, and one more: mistaken for Caddy, it
  // would receive every port without the rule saying so.
  if (!Number.isInteger(dashboardUid) || dashboardUid <= 0 || dashboardUid >= 65534 || dashboardUid === caddyUid) {
    throw new Error(`unexpected uid for the dashboard: ${dashboardUid}`);
  }

  const ports = `${SERVICE_PORTS.first}-${SERVICE_PORTS.last}`;
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
    "\tchain output {",
    "\t\ttype filter hook output priority filter; policy accept;",
    "",
    "\t\t# Caddy and root. The owner of an outgoing packet is that of the",
    "\t\t# process that opened the connection.",
    `\t\toifname "lo" tcp dport ${ports} meta skuid { 0, ${caddyUid} } accept`,
    "",
    "\t\t# The dashboard to the portal, and to it alone: it creates and",
    "\t\t# revokes guest accesses there. See portal/src/admin.ts.",
    `\t\toifname "lo" tcp dport ${PORTAL_PORT} meta skuid ${dashboardUid} accept`,
    "",
    "\t\t# All the others.",
    `\t\toifname "lo" tcp dport ${ports} ct state new ${others}`,
    "",
    "\t\t# Caddy's admin API, which authenticates nobody: Caddy, for systemctl",
    "\t\t# reload caddy, and root. Nobody else, not even the dashboard. Two",
    "\t\t# separate rules for a separate counter.",
    `\t\toifname "lo" tcp dport ${CADDY_ADMIN_PORT} meta skuid { 0, ${caddyUid} } accept`,
    `\t\toifname "lo" tcp dport ${CADDY_ADMIN_PORT} ct state new ${adminOthers}`,
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
  const counter = "counter( packets [0-9]+ bytes [0-9]+)?";
  const verdict =
    mode === "close"
      ? `${counter} reject with tcp reset`
      : `${counter} limit rate 30/minute( burst [0-9]+ packets)? log prefix "sitesolide-loopback: " flags skuid`;
  return [
    `oifname "lo" tcp dport ${CADDY_ADMIN_PORT} meta skuid \\{ 0, ${caddyUid} \\} accept$`,
    `oifname "lo" tcp dport ${CADDY_ADMIN_PORT} ct state new ${verdict}$`,
  ];
}
