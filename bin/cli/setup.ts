/**
 * `sitesolide setup <user@host> --zone <zone> --email <email>`: the whole base
 * install of docs/install.md in one command, on a fresh Debian 13 machine.
 *
 *   configuration      ~/.config/sitesolide/config.json, as `init` writes it
 *   dns                the zone and its wildcard at the machine, through the DNS
 *                      provider's API (bin/cli/dns/), or by hand under --dns manual
 *   packages ... fail2ban   the hardening, see bin/cli/harden.ts
 *   caddy, bun         from their own repositories, Caddy with the provider's DNS module
 *   dns-credentials    /etc/caddy/cloudflare.env, root:caddy 0640, the provider's credentials
 *   tls-zone           /etc/caddy/tls-zone.caddy, the zone's tls block (bin/cli/tls.ts)
 *   resolution         this workstation resolves the zone to the machine
 *   caddy-zone ...     bin/deploy-caddy.sh, the drop-in, bin/deploy-caddy.sh again
 *   api ... monitor    every component, in the order docs/install.md verified
 *   backups, installer, egress   the optional ones, left out with --minimal
 *
 * IDEMPOTENT AND RESUMABLE. Every step is a check that only reads, and a run
 * that does only what the check found missing: see bin/cli/steps.ts. A second
 * run on an installed machine reads everything and changes nothing, no Caddy
 * reload, no component redeployed, no password drawn again; a run after a
 * failure finds the steps before it done and starts at the one that failed.
 * A component already active is never deployed again here: bringing one to a
 * newer release's code is `sitesolide upgrade`'s, see bin/cli/upgrade.ts,
 * which reuses these checks, these scripts and this runner.
 *
 * NEVER A MACHINE IN SERVICE BY MISTAKE. Before anything leaves the
 * workstation, the configuration is read: one that names another server,
 * another zone or another account stops setup, since that file may point at
 * production, and a second installation gets its own folder through
 * SITESOLIDE_CONFIG_DIR. One that names this very machine is only setup's to
 * resume when setup started it, which `setup.json` beside it records; a
 * machine installed otherwise is only ever read, and setup ends on a report
 * when every step is done, or refuses. On the machine, a zone file naming
 * another zone stops it too.
 *
 * CADDY IS ONLY EVER TOUCHED THROUGH bin/deploy-caddy.sh AND systemctl. Never
 * `caddy stop` nor `caddy start`, which address the admin API of whatever
 * instance runs: see the Production section of CLAUDE.md.
 *
 * THE DNS CREDENTIALS come from the provider's variables, CLOUDFLARE_API_TOKEN
 * for Cloudflare and SITESOLIDE_DNS_<...> for the others, from standard input
 * with --dns-credentials-stdin (--cloudflare-token-stdin for Cloudflare), from
 * the wizard, or from a prompt that does not echo. They are asked for only
 * when a step needs them, and they are never printed, never an argument of
 * any command, never in a URL nor an error: they reach the API in a header or
 * a signature, and the machine inside a script on ssh's standard input, where
 * Caddy keeps them to renew the wildcard. The scripts setup launches do not
 * inherit them. `--dns manual` needs none.
 *
 * THE PASSWORDS. The dashboard's is drawn by bin/dashboard-password.sh, which
 * shows it once on standard error, and only when the machine has none. The
 * portal's is drawn here, its argon2id hash written on the machine when it has
 * none, and the password shown once at the end of the run, on standard error,
 * whether the run succeeded or not. Neither ever lands in a `--json` event.
 *
 * Everything that reaches the outside goes through `SetupDependencies`, so
 * that the tests run the whole sequence against a machine, a kit, a resolver
 * and an API they fake.
 */
import { lookup, resolve6 } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { generatePassword } from "../../dashboard/src/password";
import { canonicalAddress, describePlan, manualRecords } from "./cloudflare";
import { DnsError, ensureZoneRecords, type DnsEntry } from "./dns/dns";
import { DNS_PROVIDERS, dnsEntry, dnsVariables, MANUAL } from "./dns/registry";
import { fieldsToAsk, fromEnvironment, isFailure, missingFields, parseStdinCredentials, scrubSecrets, secretValues } from "./machine";
import { ProviderError, type Credentials, type Fetch } from "./providers/provider";
import { CADDY_RESTART, caddyRestartScript, policyPending, tlsZoneCheck, tlsZoneContent, tlsZoneRun, TLS_ZONE_FILE, TLS_ZONE_RESTARTED } from "./tls";
import { ACME_STAGING, adoptLegacyKeys, composeConfig, CONFIG_DIR_VARIABLE, privateFolder, writeConfig } from "./config";
import {
  APT,
  BAN_ADVICE,
  CONNECTION_LOST,
  HOST_KEY_CHANGED,
  hostKeyAdvice,
  fail2banRelease,
  asRoot,
  hardeningSteps,
  machineCheck,
  rootCheck,
  rootRun,
  runScript,
  type Execution,
  type HardenContext,
  type Machine,
} from "./harden";
import { hintFor } from "./hints";
import { isCompiled, kitEnv, kitRoot } from "./kit";
import { eventFor, forEachLine, formatEvent, type OutputEvent } from "./output";
import { runSteps, StepFailure, type Check, type Condition, type Step, type StepReport } from "./steps";

// --- the command line ----------------------------------------------------------

export type SetupOptions = {
  /** The account setup connects as first: root on a fresh machine, or a sudoer. */
  login: string;
  host: string;
  zone: string;
  email: string;
  contact: string | null;
  /** The account that deploys and owns the served files: `deploy` by default when connected as root. */
  user: string;
  skipDns: boolean;
  dnsReplace: boolean;
  minimal: boolean;
  anyOs: boolean;
  dryRun: boolean;
  tokenStdin: boolean;
  /**
   * Who serves the zone's DNS: a provider of bin/cli/dns/registry.ts, whose
   * API makes the records and whose Caddy module obtains the wildcard, or
   * `manual`: records made by hand, a certificate per name. Null when
   * `--dns` was not given: the configuration's, else `cloudflare`.
   */
  dns: string | null;
  /**
   * The zone's certificate authority: `production`, Let's Encrypt's, or
   * `staging`, its test environment, for a test installation. Null when
   * `--acme` was not given: the configuration's, else production.
   */
  acme: string | null;
  configDir: string | null;
  json: boolean;
};

const VALUED = ["--zone", "--email", "--contact", "--user", "--config-dir", "--dns", "--acme"] as const;
const FLAGS = ["--skip-dns", "--dns-replace", "--minimal", "--any-os", "--dry-run", "--cloudflare-token-stdin", "--dns-credentials-stdin", "--json"] as const;

export const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
export const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
export const ZONE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Refusal = { message: string; details: string[] };

export const USAGE = "usage: sitesolide setup <user@host> --zone <dns.zone> --email <address>";

/** The refusals setup can print before any step, each with its wording in one place: the tests read them back. */
export const REFUSALS = {
  usage: (detail: string): Refusal => ({ message: USAGE, details: [detail, "see docs/setup.md"] }),
  invalid: (option: string, value: string, expected: string): Refusal => ({ message: `setup: ${option} is not valid: ${value}`, details: [expected] }),
  otherServer: (path: string, configured: string, wanted: string): Refusal => ({
    message: `the configuration names another server: ${configured}`,
    details: [
      `${path} says ${configured}; setup was asked for ${wanted}`,
      "that file may point at a machine in service: setup does not touch it, nor that machine",
      `a second installation keeps its own folder: --config-dir <dir> on setup, then ${CONFIG_DIR_VARIABLE}=<dir> for every command`,
    ],
  }),
  otherZone: (path: string, configured: string, wanted: string): Refusal => ({
    message: `the configuration names another zone: ${configured}`,
    details: [
      `${path} says ${configured}; setup was asked for ${wanted}`,
      "that file may point at a machine in service: setup does not touch it",
      `a second installation keeps its own folder: --config-dir <dir> on setup, then ${CONFIG_DIR_VARIABLE}=<dir> for every command`,
    ],
  }),
  otherAccount: (path: string, configured: string, wanted: string): Refusal => ({
    message: `the configuration names another account on this server: ${configured}`,
    details: [`${path} says ${configured}; setup would deploy as ${wanted}`, `pass --user ${configured.split("@")[0]} to keep it`],
  }),
  installed: (host: string, todo: readonly StepReport[]): Refusal => ({
    message: `${host} is the configured server, installed without setup, and setup would change it`,
    details: [
      ...todo.map((report) => `not done: ${report.step}${report.detail === null ? "" : ` (${report.detail})`}`),
      "setup only changes a machine it is installing itself, or a new one; on this one it only reads",
    ],
  }),
  unreachable: (server: string, said: string): Refusal => ({
    message: `cannot reach ${server} over SSH`,
    details: [
      said,
      ...(CONNECTION_LOST.test(said) ? BAN_ADVICE : []),
      ...(HOST_KEY_CHANGED.test(said) ? hostKeyAdvice(server.slice(server.indexOf("@") + 1)) : []),
      "setup connects without a prompt: the key loaded in the agent (ssh-add), the machine up and its port 22 open",
      ...(server.startsWith("root@") ? ["once an earlier run has closed root login, connect as the deploy account instead: sitesolide setup deploy@<host> ..."] : []),
    ],
  }),
  unreadable: (server: string, said: string): Refusal => ({
    message: `cannot read ${server}: the preflight gave no answer setup recognises`,
    details: [said],
  }),
  notDebian: (host: string, system: string): Refusal => ({
    message: `${host} runs ${system}, not Debian 13`,
    details: ["setup is verified on Debian 13 alone; --any-os goes on anyway, at your own risk"],
  }),
  noSudo: (server: string): Refusal => ({
    message: `${server} has no sudo without a password`,
    details: ["connect as root, or give that account passwordless sudo first: setup never types a password"],
  }),
  architecture: (host: string, architecture: string): Refusal => ({
    message: `unsupported architecture on ${host}: ${architecture}`,
    details: ["Caddy and Bun are installed for amd64 and arm64"],
  }),
  disk: (host: string, free: string): Refusal => ({
    message: `only ${free} free on / of ${host}, setup needs ${MINIMUM_FREE_GB} GB`,
    details: ["Caddy, Bun and the components take about 1 GB, and every project its own"],
  }),
  servesOtherZone: (host: string, zone: string): Refusal => ({
    message: `${host} already serves the zone ${zone}`,
    details: ["/etc/caddy/sitesolide.env names it: setup never installs a machine over the zone it serves"],
  }),
  privateAddress: (address: string): Refusal => ({
    message: `the machine's IPv4 is private, ${address}: it is behind a NAT`,
    details: ["give its public IPv4 as the host, setup root@<public address>, or create the records by hand with --skip-dns"],
  }),
};

const MINIMUM_FREE_GB = 2;

/** The command line, read; a refusal for anything it does not recognise. */
export function parseSetupArguments(arguments_: readonly string[]): SetupOptions | Refusal {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < arguments_.length; i++) {
    const argument = arguments_[i]!;
    if ((VALUED as readonly string[]).includes(argument)) {
      const value = arguments_[i + 1];
      if (value === undefined || value.startsWith("--")) return REFUSALS.usage(`${argument} needs a value`);
      values[argument] = value;
      i++;
    } else if ((FLAGS as readonly string[]).includes(argument)) {
      flags.add(argument);
    } else if (argument.startsWith("-")) {
      return REFUSALS.usage(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) return REFUSALS.usage(positional.length === 0 ? "the machine is missing: user@host" : `one machine at a time: ${positional.join(" ")}`);
  const target = positional[0]!;
  const at = target.indexOf("@");
  if (at <= 0) return REFUSALS.usage(`the machine is given as user@host, root@203.0.113.10 for instance: ${target}`);
  const login = target.slice(0, at);
  const host = target.slice(at + 1);
  if (!ACCOUNT.test(login)) return REFUSALS.invalid("the account", login, "lowercase letters, digits, dashes, as Linux takes them");
  if (!HOST.test(host)) return REFUSALS.invalid("the host", host, "an address or a name");

  const zone = values["--zone"];
  const email = values["--email"];
  if (zone === undefined) return REFUSALS.usage("--zone is missing: the DNS zone every project gets a subdomain of");
  if (email === undefined) return REFUSALS.usage("--email is missing: the address the certificate authority writes to");
  if (!ZONE.test(zone)) return REFUSALS.invalid("--zone", zone, "a lowercase DNS name with at least two labels, example.com");
  if (!EMAIL.test(email)) return REFUSALS.invalid("--email", email, "an email address");
  const contact = values["--contact"] ?? null;
  if (contact !== null && !EMAIL.test(contact)) return REFUSALS.invalid("--contact", contact, "an email address");
  const user = values["--user"] ?? (login === "root" ? "deploy" : login);
  if (!ACCOUNT.test(user) || user === "root") return REFUSALS.invalid("--user", user, "an account other than root: lowercase letters, digits, dashes");
  const json = flags.has("--json");
  const dns = values["--dns"] ?? null;
  const known = [...DNS_PROVIDERS.map((entry) => entry.name), MANUAL];
  if (dns !== null && dnsEntry(dns) === undefined) return REFUSALS.invalid("--dns", /^[a-z0-9-]{1,40}$/.test(dns) ? dns : "(not shown)", `one of ${known.join(", ")}; see docs/dns/`);
  if (flags.has("--cloudflare-token-stdin") && dns !== null && dns !== "cloudflare" && dns !== MANUAL) return REFUSALS.usage(`--cloudflare-token-stdin is Cloudflare's: with --dns ${dns}, pipe the credentials to --dns-credentials-stdin`);
  if (dns === MANUAL && (flags.has("--dns-credentials-stdin") || flags.has("--cloudflare-token-stdin") || flags.has("--dns-replace"))) {
    return REFUSALS.usage("--dns manual uses no DNS API: the records are made by hand, and nothing reads credentials nor replaces records");
  }
  const acme = values["--acme"] ?? null;
  if (acme !== null && acme !== "production" && acme !== ACME_STAGING) {
    return REFUSALS.invalid("--acme", /^[a-z]{1,20}$/.test(acme) ? acme : "(not shown)", "production, the default, or staging, for a test installation whose certificates no browser trusts");
  }

  return {
    login,
    host,
    zone,
    email,
    contact,
    user,
    dnsReplace: flags.has("--dns-replace"),
    minimal: flags.has("--minimal"),
    anyOs: flags.has("--any-os"),
    dryRun: flags.has("--dry-run"),
    tokenStdin: flags.has("--cloudflare-token-stdin") || flags.has("--dns-credentials-stdin"),
    skipDns: flags.has("--skip-dns"),
    dns,
    acme,
    configDir: values["--config-dir"] ?? null,
    json,
  };
}

// --- the configuration on the workstation --------------------------------------

/**
 * What setup records beside the configuration when it starts installing a
 * machine. `rootClosed`: the ssh step is done there, so that a later run given
 * `root@` connects as the deploy account at once, rather than knocking with a
 * refused root login that fail2ban would count.
 */
export type Marker = { server: string; zone: string; startedAt: string; rootClosed?: boolean };

export const MARKER_NAME = "setup.json";

/** The host of `user@host`, or the whole string without an account. */
export function hostOf(server: string): string {
  const at = server.lastIndexOf("@");
  return at === -1 ? server : server.slice(at + 1);
}

/** Whether two hosts are one machine: the same name, or names that resolve to a shared address. */
export type SameMachine = (a: string, b: string) => Promise<boolean>;

export type Guard =
  | { kind: "fresh" }
  | { kind: "ours"; server: string }
  | { kind: "installed"; server: string }
  | ({ kind: "refuse" } & Refusal);

/**
 * What the configuration already in place allows, decided before anything
 * leaves the workstation. The server and the zone are the effective ones, the
 * environment's over the file's, as every other command reads them.
 *
 * - none: a fresh workstation, or one with a token only: setup writes it.
 * - another zone, another machine, another account: refused, untouched.
 * - this machine, and setup's marker for it: setup's own install, resumed.
 * - this machine, no marker: installed some other way, read only.
 */
export async function configGuard(
  path: string,
  configured: { server?: string; zone?: string },
  marker: Marker | null,
  wanted: { host: string; user: string; zone: string },
  sameMachine: SameMachine,
): Promise<Guard> {
  const wantedServer = `${wanted.user}@${wanted.host}`;
  if (configured.zone !== undefined && configured.zone !== "" && configured.zone !== wanted.zone) {
    return { kind: "refuse", ...REFUSALS.otherZone(path, configured.zone, wanted.zone) };
  }
  if (configured.server === undefined || configured.server === "") return { kind: "fresh" };
  if (!(await sameMachine(hostOf(configured.server), wanted.host))) {
    return { kind: "refuse", ...REFUSALS.otherServer(path, configured.server, wantedServer) };
  }
  const account = configured.server.includes("@") ? configured.server.slice(0, configured.server.lastIndexOf("@")) : "";
  if (account !== wanted.user) return { kind: "refuse", ...REFUSALS.otherAccount(path, configured.server, wantedServer) };
  const ours = marker !== null && marker.zone === wanted.zone && (await sameMachine(hostOf(marker.server), wanted.host));
  return ours ? { kind: "ours", server: configured.server } : { kind: "installed", server: configured.server };
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readMarker(folder: string): Marker | null {
  const raw = readJson(join(folder, MARKER_NAME));
  if (raw === null || typeof raw.server !== "string" || typeof raw.zone !== "string") return null;
  return { server: raw.server, zone: raw.zone, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "", rootClosed: raw.rootClosed === true };
}

/** The marker says root login is closed now: written once, when the ssh step is done. */
function noteRootClosed(folder: string): void {
  const marker = readMarker(folder);
  if (marker === null || marker.rootClosed === true) return;
  writeFileSync(join(folder, MARKER_NAME), `${JSON.stringify({ ...marker, rootClosed: true }, null, 2)}\n`);
}

/**
 * The accounts the preflight tries, in order. A fresh install knows only the
 * one given. Setup's own install, once it has closed root, goes straight to
 * the deploy account. Otherwise a second account is tried only after the
 * first was refused by the machine itself, and only one that exists: the
 * deploy account of setup's own install, or the one the configuration names.
 */
export function preflightAccounts(login: string, user: string, guard: Guard, marker: Marker | null): { first: string; then: string | null } {
  if (guard.kind === "fresh" || guard.kind === "refuse") return { first: login, then: null };
  if (guard.kind === "ours" && login === "root" && marker?.rootClosed === true) return { first: user, then: null };
  const configured = guard.server.slice(0, Math.max(0, guard.server.lastIndexOf("@")));
  const then = guard.kind === "ours" ? user : configured;
  return { first: login, then: then === "" || then === login ? null : then };
}

// --- the preflight -------------------------------------------------------------

/** What the preflight reads on the machine, as the account setup connects as. */
export type Facts = {
  os: string;
  version: string;
  system: string;
  architecture: string;
  uid: number;
  freeKb: number;
  sshPort: number;
  /** The workstation's address as the machine sees it, from $SSH_CONNECTION; null when not an address. */
  clientAddress: string | null;
  sudo: "root" | "yes" | "no";
  /** The zone the machine already serves, from /etc/caddy/sitesolide.env; null on a fresh one. */
  zone: string | null;
  ipv4: string | null;
  ipv6: string | null;
};

/**
 * Read only. cloud-init may still be running on a machine created a minute
 * ago, installing packages and writing sshd's configuration: it is waited for,
 * ten minutes at most, so that no check reads a machine half way through its
 * first boot. `ip -j` answers in JSON, read on the workstation.
 */
export function preflightScript(): string {
  return [
    "# sitesolide setup:preflight:read",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 </dev/null || true; fi",
    ". /etc/os-release 2>/dev/null",
    'echo "os=${ID:-unknown}"',
    'echo "version=${VERSION_ID:-}"',
    'echo "system=${PRETTY_NAME:-unknown}"',
    'echo "architecture=$(dpkg --print-architecture 2>/dev/null || uname -m)"',
    'echo "uid=$(id -u)"',
    "echo \"free=$(df -Pk / | awk 'NR==2 {print $4}')\"",
    'echo "ssh=${SSH_CONNECTION:-}"',
    'if [ "$(id -u)" = 0 ]; then echo "sudo=root"; elif sudo -n true >/dev/null 2>&1 </dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi',
    "echo \"zone=$(sed -n 's/^SITESOLIDE_ZONE=//p' /etc/caddy/sitesolide.env 2>/dev/null | head -n 1)\"",
    'echo "route4=$(ip -j -4 route show default 2>/dev/null)"',
    'echo "route6=$(ip -j -6 route show default 2>/dev/null)"',
    'echo "addresses=$(ip -j addr show scope global 2>/dev/null)"',
    'echo "end=preflight"',
    "",
  ].join("\n");
}

type IpAddress = { family?: string; local?: string; scope?: string; temporary?: boolean; deprecated?: boolean; tentative?: boolean };
type IpInterface = { ifname?: string; addr_info?: IpAddress[] };
type IpRoute = { dev?: string };

function parseJsonList<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

/** Whether an IPv4 is one the Internet cannot reach: RFC 1918, shared, loopback, link-local. */
export function privateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** Whether an IPv6 is global: not loopback, link-local (fe80::/10) nor unique-local (fc00::/7). */
export function globalIpv6(address: string): boolean {
  const first = address.toLowerCase().split(":")[0] ?? "";
  if (address === "::1" || first === "") return false;
  const value = Number.parseInt(first.padStart(4, "0"), 16);
  return !((value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80);
}

/**
 * The machine's addresses on the interface of its default route, one per
 * family: the one the Internet reaches it by. Temporary and deprecated IPv6
 * addresses are left out, they change.
 */
export function machineAddresses(route4: string, route6: string, addresses: string): { ipv4: string | null; ipv6: string | null } {
  const interfaces = parseJsonList<IpInterface>(addresses);
  const pick = (routes: string, family: "inet" | "inet6"): string | null => {
    const device = parseJsonList<IpRoute>(routes)[0]?.dev;
    const candidates = interfaces
      .filter((entry) => device === undefined || entry.ifname === device)
      .flatMap((entry) => entry.addr_info ?? [])
      .filter((info) => info.family === family && info.scope === "global" && info.temporary !== true && info.deprecated !== true && info.tentative !== true)
      .map((info) => info.local ?? "")
      .filter((address) => address !== "");
    if (family === "inet6") return candidates.find(globalIpv6) ?? null;
    return candidates.find((address) => !privateIpv4(address)) ?? candidates[0] ?? null;
  };
  return { ipv4: pick(route4, "inet"), ipv6: parseJsonList<IpRoute>(route6).length === 0 ? null : pick(route6, "inet6") };
}

/** The preflight's output, read; null when it is not the preflight's. */
export function readFacts(output: string): Facts | null {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const equal = line.indexOf("=");
    if (equal > 0) values.set(line.slice(0, equal), line.slice(equal + 1).trim());
  }
  if (values.get("end") !== "preflight") return null;
  const connection = (values.get("ssh") ?? "").split(" ");
  const port = Number(connection[3]);
  const client = connection[0] ?? "";
  const sudo = values.get("sudo");
  const { ipv4, ipv6 } = machineAddresses(values.get("route4") ?? "", values.get("route6") ?? "", values.get("addresses") ?? "");
  return {
    os: values.get("os") ?? "unknown",
    version: (values.get("version") ?? "").replaceAll('"', ""),
    system: values.get("system") || "an unknown system",
    architecture: values.get("architecture") ?? "unknown",
    uid: Number(values.get("uid") ?? "-1"),
    freeKb: Number(values.get("free") ?? "0") || 0,
    sshPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    // Only an address goes into fail2ban's configuration: nothing else this
    // field could carry is written into a script.
    clientAddress: isIP(client) === 0 ? null : client,
    sudo: sudo === "root" || sudo === "yes" ? sudo : "no",
    zone: values.get("zone") || null,
    ipv4,
    ipv6,
  };
}

/** What stops setup in what the preflight read, the first refusal found. */
export function judgeFacts(facts: Facts, options: Pick<SetupOptions, "host" | "zone" | "anyOs">, account: string): Refusal | null {
  if (!options.anyOs && !(facts.os === "debian" && facts.version === "13")) return REFUSALS.notDebian(options.host, facts.system);
  if (!["amd64", "arm64", "x86_64", "aarch64"].includes(facts.architecture)) return REFUSALS.architecture(options.host, facts.architecture);
  if (facts.sudo === "no") return REFUSALS.noSudo(`${account}@${options.host}`);
  if (facts.freeKb < MINIMUM_FREE_GB * 1024 * 1024) return REFUSALS.disk(options.host, `${(facts.freeKb / 1024 / 1024).toFixed(1)} GB`);
  if (facts.zone !== null && facts.zone !== options.zone) return REFUSALS.servesOtherZone(options.host, facts.zone);
  return null;
}

/**
 * The addresses the records point at. A host given as an address is the one
 * this workstation reaches the machine by, so it wins; otherwise the machine's
 * own, which must be public: a private IPv4 behind a NAT would be published
 * for the whole Internet to miss.
 */
export function chooseAddresses(host: string, facts: Pick<Facts, "ipv4" | "ipv6">): { ipv4: string; ipv6: string | null } | Refusal {
  const ipv6 = isIP(host) === 6 && globalIpv6(host) ? host : facts.ipv6;
  if (isIP(host) === 4 && !privateIpv4(host)) return { ipv4: host, ipv6 };
  if (facts.ipv4 === null) return REFUSALS.privateAddress("none found");
  if (privateIpv4(facts.ipv4)) return REFUSALS.privateAddress(facts.ipv4);
  return { ipv4: facts.ipv4, ipv6 };
}

// --- what setup depends on -------------------------------------------------------

/**
 * A script of the kit's bin/, or `sitesolide deploy` in one of its folders,
 * with the options given. `quiet`: what it prints is kept for the caller,
 * never shown.
 */
export type KitTask =
  | { kind: "script"; name: string; args: string[]; quiet?: boolean; passwordOnStderr?: boolean }
  | { kind: "deploy"; folder: "dashboard" | "portal"; args?: string[]; quiet?: boolean };

/** Runs a task with this environment; never throws. `output` holds what it printed when quiet. */
export type KitRunner = (task: KitTask, environment: Record<string, string>) => Promise<{ code: number; output: string }>;

/** What a name resolves to from this workstation. */
export type Observed = { ipv4: string[]; ipv6: string[] };

export type SetupOutput = {
  json: boolean;
  /** A line of the human output; under --json, the event it stands for. */
  say(line: string): void;
  check(report: StepReport): void;
  /** What a command printed, as it comes. */
  relay(stream: "stdout" | "stderr", line: string): void;
  /** A password: standard error, in either mode, never an event. */
  secret(lines: string[]): void;
  error(message: string, details: string[]): void;
  result(fields: Record<string, unknown>): void;
};

/** The password setup drew and has not shown yet: shown at the end, or on an interruption. */
export type Secrets = { portal: string | null };

export type SetupDependencies = {
  machine: Machine;
  kit: KitRunner;
  /** What the workstation resolves a name to, through its own resolver. */
  resolve(name: string): Promise<Observed>;
  sameMachine: SameMachine;
  /** Where the DNS provider's API is reached: the environment its address variable is read from, and the fetch. */
  dnsApi: { environment: Record<string, string | undefined>; fetcher?: Fetch };
  /**
   * The DNS provider's credentials, scoped to the zone: from the wizard, the
   * environment or standard input, and from a prompt only when `ask`. Null
   * when they are not at hand.
   */
  dnsCredentials(entry: DnsEntry, ask: boolean): Promise<Credentials | null>;
  drawPassword(): Promise<{ password: string; hash: string }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): string;
  home: string;
  environment: Record<string, string | undefined>;
  output: SetupOutput;
  secrets: Secrets;
};

// --- the context the steps share --------------------------------------------------

export type SetupContext = HardenContext & {
  options: SetupOptions;
  deps: SetupDependencies;
  folder: string;
  /** `user@host` as the configuration says it. */
  server: string;
  contact: string | null;
  addresses: { ipv4: string; ipv6: string | null };
  /** Who serves the zone's DNS; null for `--dns manual`. */
  dns: DnsEntry | null;
  /** Its credentials once obtained; undefined until a step asked for them. */
  dnsCredentials: Credentials | null | undefined;
  dashboardDrawn: boolean;
  /** What every script and every `sitesolide deploy` setup launches receives. */
  childEnvironment: Record<string, string>;
};

/** The DNS provider's credentials, asked for when a step needs them, once. */
async function requireDnsCredentials(context: SetupContext, entry: DnsEntry): Promise<Credentials> {
  if (context.dnsCredentials !== undefined && context.dnsCredentials !== null) return context.dnsCredentials;
  const credentials = await context.deps.dnsCredentials(entry, true);
  const missing = missingFields(entry, credentials ?? {});
  if (credentials === null || missing.length > 0) {
    throw new StepFailure(`no ${entry.title} credentials`, [
      `set ${(missing.length > 0 ? missing : fieldsToAsk(entry)).map((field) => field.variable).join(", ")} in the environment, or pipe them to ${entry.name === "cloudflare" ? "--cloudflare-token-stdin" : "--dns-credentials-stdin"}`,
      ...entry.credentialHelp,
      `see ${entry.docs}; with a DNS no module serves, --dns manual and docs/setup.md`,
    ]);
  }
  const wrong = entry.credentials.find((field) => credentials[field.variable] !== undefined && credentials[field.variable] !== "" && !field.shape.test(credentials[field.variable]!));
  if (wrong !== undefined) throw new StepFailure(`the ${entry.title} ${wrong.label} given is not one: it has characters or a length a ${wrong.label} never has`, []);
  context.dnsCredentials = credentials;
  return credentials;
}

/** The credentials if they are known without asking anyone: given, or asked for earlier. */
async function knownDnsCredentials(context: SetupContext, entry: DnsEntry): Promise<Credentials | null> {
  if (context.dnsCredentials !== undefined) return context.dnsCredentials;
  const credentials = await context.deps.dnsCredentials(entry, false);
  const usable = credentials !== null && missingFields(entry, credentials).length === 0 && entry.credentials.every((field) => (credentials[field.variable] ?? "") === "" || field.shape.test(credentials[field.variable]!));
  context.dnsCredentials = usable ? credentials : undefined;
  return context.dnsCredentials ?? null;
}

// --- the install steps ------------------------------------------------------------

export const LIB = "/usr/local/lib/sitesolide";
export const UNITS = "/etc/systemd/system";

/**
 * A check run as root through the operator: the deploy account once the ssh
 * step has proven its login, the account setup connected as until then. A dry
 * run on a fresh machine therefore reads every step through root, and never
 * tries to log in as an account that does not exist yet.
 */
function installCheck(tag: string, conditions: Parameters<typeof machineCheck>[1], prelude = "") {
  return (context: SetupContext): Promise<Check> => rootCheck(context.machine, context.operator, tag, machineCheck(tag, conditions, prelude));
}

export function active(label: string, unit: string): Condition {
  return { label, test: `systemctl is-active --quiet ${unit}` };
}

export function enabled(label: string, unit: string): Condition {
  return { label, test: `systemctl is-enabled --quiet ${unit}` };
}

export function present(label: string, path: string): Condition {
  return { label, test: `test -f ${path}` };
}

function journal(context: SetupContext, unit: string): string {
  return `ssh ${context.server} 'sudo journalctl -u ${unit} -n 50'`;
}

/** A script of bin/, run with the setup's environment, a failure stopping the step. */
async function script(context: SetupContext, name: string, args: string[] = []): Promise<void> {
  const { code } = await context.deps.kit({ kind: "script", name, args }, context.childEnvironment);
  if (code !== 0) throw new StepFailure(`bin/${name}${args.length === 0 ? "" : ` ${args.join(" ")}`} failed (exit code ${code})`, ["its own message is just above"]);
}

async function deployFolder(context: SetupContext, folder: "dashboard" | "portal"): Promise<void> {
  const { code } = await context.deps.kit({ kind: "deploy", folder }, context.childEnvironment);
  if (code !== 0) throw new StepFailure(`sitesolide deploy in ${folder}/ failed (exit code ${code})`, ["its own message is just above"]);
}

/** The steward started after `path` was last written: the folder it opened to it then exists for it. */
export function stewardAfter(label: string, path: string): Condition {
  return {
    label,
    test: `started=$(systemctl show -p ActiveEnterTimestamp --value sitesolide-steward) && [ -n "$started" ] && [ "$(date -d "$started" +%s)" -ge "$(stat -c %Y ${path})" ]`,
  };
}

export const CADDY_DROP_IN = "/etc/systemd/system/caddy.service.d/override.conf";

/**
 * What a component looks like once its step is done, condition by condition:
 * the checks of the steps below, and of `sitesolide upgrade`, which brings a
 * component that passes them to the code of a newer release and must leave it
 * passing them still. A run of setup after an upgrade then finds every step
 * done, and an upgrade never leaves behind a state setup would redo.
 */
export const COMPONENT_CONDITIONS = {
  "caddy-unit": [
    present("drop-in", CADDY_DROP_IN),
    { label: "restart-always", test: `[ "$(systemctl show caddy -p Restart --value)" = always ]` },
    { label: "zone-variables", test: "systemctl show caddy -p EnvironmentFiles --value | grep -q /etc/caddy/sitesolide.env" },
    active("caddy-active", "caddy"),
  ],
  "caddy-config": [{ label: "caddyfile", test: "grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile" }, active("caddy-active", "caddy")],
  api: [active("api-active", "sitesolide-api"), enabled("api-enabled", "sitesolide-api")],
  gatekeeper: [
    present("gatekeeper-code", `${LIB}/gatekeeper.js`),
    present("gatekeeper-on", `${UNITS}/sitesolide-gatekeeper-on@.service`),
    present("gatekeeper-off", `${UNITS}/sitesolide-gatekeeper-off@.service`),
    present("gatekeeper-code-unit", `${UNITS}/sitesolide-gatekeeper-code@.service`),
    present("gatekeeper-renew", `${UNITS}/sitesolide-gatekeeper-renew@.service`),
    // What the units open for writing and cannot create: the preview locks.
    present("locks-codes", "/etc/caddy/locks-codes.json"),
  ],
  dashboard: [active("dashboard-active", "dashboard")],
  steward: [active("steward-active", "sitesolide-steward"), present("steward-code", `${LIB}/steward.js`)],
  collector: [enabled("collector-enabled", "sitesolide-collector.timer"), active("collector-active", "sitesolide-collector.timer")],
  portal: [active("portal-active", "portal")],
  monitor: [enabled("monitor-enabled", "sitesolide-monitor.timer"), active("monitor-active", "sitesolide-monitor.timer")],
  // restic, which stores the snapshots, the server's repository and its key, which install lays.
  "backups-installed": [
    present("backup-code", `${LIB}/backup.js`),
    present("backup-timer", `${UNITS}/sitesolide-backup.timer`),
    present("backup-restic", "/usr/bin/restic"),
    present("backup-key", "/var/backups/sitesolide-restic.key"),
    present("backup-repository", "/var/backups/sitesolide-restic/config"),
  ],
  backups: [enabled("backup-enabled", "sitesolide-backup.timer"), active("backup-active", "sitesolide-backup.timer")],
  installer: [present("installer-code", `${LIB}/installer.js`), present("installer-unit", `${UNITS}/sitesolide-installer@.service`)],
  "egress-proxy": [active("egress-active", "sitesolide-egress")],
  "steward-after-egress": [stewardAfter("steward-after-egress", `${UNITS}/sitesolide-egress.service`)],
} satisfies Record<string, Condition[]>;

function caddyRun(dns: DnsEntry | null): string {
  return runScript(
    "setup:caddy:run",
    `
if ! dpkg-query -W -f='\${Status}' caddy 2>/dev/null | grep -q 'ok installed'; then
  command -v gpg >/dev/null 2>&1 || ${APT} install -y -q gpg </dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  ${APT} update -q </dev/null
  ${APT} install -y -q caddy </dev/null
fi
${
  dns === null
    ? "# --dns manual: certificates name by name, through HTTP-01 or TLS-ALPN-01, which the standard build carries."
    : `# The standard build lacks the DNS module the wildcard certificate needs.
if ! caddy list-modules 2>/dev/null | grep -q '^${dns.caddy.module}$'; then
${caddyModuleScript(dns.caddy.package, dns.caddy.module)}
fi`
}
`,
  );
}

/** How long Caddy's build service gets to deliver a build with the module, in seconds. */
export const CADDY_BUILD_SERVICE_SECONDS = 300;

/** The xcaddy that builds Caddy on the machine when the build service does not deliver. */
export const XCADDY = "github.com/caddyserver/xcaddy/cmd/xcaddy@v0.4.7";

/**
 * Caddy with the module: from Caddy's build service, `caddy add-package`, or,
 * when it does not deliver in time, built on the machine. That service is a
 * single one, sometimes down for hours, and an add-package waiting on it
 * waits for ever. The build here takes Caddy at the version the package
 * installed, with Debian's Go, which fetches the toolchain Caddy asks for
 * through Go's proxy and checksum database, and xcaddy at a pinned version.
 * Go and everything it fetched are removed afterwards, the build failed or not.
 */
function caddyModuleScript(module: string, id: string): string {
  return `if ! timeout ${CADDY_BUILD_SERVICE_SECONDS} caddy add-package ${module} </dev/null; then
  echo "Caddy's build service did not deliver within ${CADDY_BUILD_SERVICE_SECONDS / 60} minutes: Caddy is built here instead, which takes a few minutes"
  # On disk: Debian 13's /tmp is a tmpfs of half the memory, which Go's module cache alone fills.
  work=$(mktemp -d /var/tmp/sitesolide-caddy.XXXXXX)
  had_go=no
  dpkg-query -W -f='\${Status}' golang-go 2>/dev/null | grep -q 'ok installed' && had_go=yes
  cleanup() {
    status=$?
    rm -rf "$work"
    [ "$had_go" = yes ] || ${APT} purge -y -q --autoremove golang-go </dev/null >/dev/null 2>&1 || true
    exit $status
  }
  trap cleanup EXIT
  [ "$had_go" = yes ] || ${APT} install -y -q --no-install-recommends golang-go </dev/null
  version=$(caddy version | cut -d' ' -f1)
  (
    export HOME="$work" TMPDIR="$work" GOPATH="$work/go" GOCACHE="$work/cache" CGO_ENABLED=0
    export GOTOOLCHAIN=auto GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
    go install ${XCADDY}
    "$GOPATH/bin/xcaddy" build "$version" --with ${module} --output "$work/caddy"
  ) </dev/null
  "$work/caddy" list-modules | grep -q '^${id}$'
  install -m 0755 "$work/caddy" /usr/bin/caddy
fi`;
}

function bunRun(): string {
  return runScript(
    "setup:bun:run",
    `
command -v unzip >/dev/null 2>&1 || ${APT} install -y -q unzip </dev/null
curl -fsSL https://bun.com/install | BUN_INSTALL=/usr/local bash
`,
  );
}

/**
 * Caddy's environment file, the DNS provider's credentials for the
 * wildcard's renewals. Its name is the first provider's: machines in service
 * load it by that name, through the drop-in, the gatekeeper's validation and
 * the scripts that run `caddy validate`; it holds whichever provider's
 * variables now, or none under `--dns manual`.
 */
export const CADDY_ENV_FILE = "/etc/caddy/cloudflare.env";

/**
 * The file's whole text. One `NAME=value` line per variable the provider's
 * module reads; under `--dns manual`, a comment alone, since systemd and the
 * scripts load the file whatever the mode.
 *
 * TWO READERS, ONE MEANING. systemd reads the file as an EnvironmentFile, and
 * bin/deploy-caddy.sh, bin/generate-domains.sh and the tls-zone step source it
 * with bash, as root, to validate Caddy's configuration as systemd would run
 * it. A value made of letters, digits and `_ - . / : + = @ % ,` alone means
 * the same to both, and is written bare, as Cloudflare's token always was;
 * any other is single-quoted, which both read literally. A value that a quote
 * could not hold, a single quote, a backslash, a line break or a control
 * character, is refused: in bash it could end the quote and run what follows.
 */
export function caddyEnvironmentText(dns: DnsEntry | null, credentials: Credentials | null): string {
  if (dns === null) return "# --dns manual: no DNS credentials, the zone's certificates are obtained name by name\n";
  const variables = dns.caddy.environment(credentials ?? {});
  const lines = Object.entries(variables).map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || value === "" || /['\\\x00-\x1f\x7f]/.test(value) || !/^[\x20-\x7e]+$/.test(value)) {
      throw new StepFailure(`${dns.title}'s ${name} cannot be written to ${CADDY_ENV_FILE} as it is: empty, or holding a single quote, a backslash, a line break or a character outside printable ASCII`, []);
    }
    return /^[A-Za-z0-9_\-.\/:+=@%,]+$/.test(value) ? `${name}=${value}` : `${name}='${value}'`;
  });
  return `${lines.join("\n")}\n`;
}

/** A value's fingerprint, compared on the machine with the file's: neither travels in the clear. */
function fingerprintOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Each variable the file must hold, by its name and its value's fingerprint;
 * null when the values are not known. Compared value by value, as setup
 * always compared Cloudflare's token, not byte for byte: a file written by
 * hand, with a comment, another line or CRLF endings, holding the right
 * values, is the right file.
 */
export function expectedVariables(dns: DnsEntry | null, credentials: Credentials | null): { name: string; fingerprint: string | null }[] {
  if (dns === null) return [];
  if (credentials !== null) return Object.entries(dns.caddy.environment(credentials)).map(([name, value]) => ({ name, fingerprint: fingerprintOf(value) }));
  // The values unknown, the names are not: every variable the module's
  // directive reads must at least be there, or a switch of provider made
  // without credentials would pass with the previous provider's file.
  return [...new Set([...dns.caddy.directive.join("\n").matchAll(/\{env\.([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]!))].map((name) => ({ name, fingerprint: null }));
}

/**
 * Whether a running Caddy has read the file since it was last written: it
 * fills its {env.X} at its start, and a rotation whose restart failed would
 * otherwise never be finished. True when no Caddy runs the platform's
 * configuration, a first install.
 */
const CADDY_READ_ENV = `! systemctl is-active --quiet caddy || ! grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile || { started=$(systemctl show -p ActiveEnterTimestamp --value caddy) && [ -n "$started" ] && [ "$(date -d "$started" +%s)" -ge "$(stat -c %Y ${CADDY_ENV_FILE})" ]; }`;

/**
 * `policy`, the zone's policy this run lays: when the tls-zone step will
 * restart Caddy for it, a switch of provider, Caddy reads the new credentials
 * then, and this step does not restart it a step too early.
 */
export function dnsCredentialsCheck(variables: { name: string; fingerprint: string | null }[] | null, policy: string | null = null): string {
  // The value after NAME=, its line ending and its single quotes taken off.
  const value = (name: string) => `sed -n 's/^[[:space:]]*${name}=//p' ${CADDY_ENV_FILE} | head -n 1 | tr -d '\\r\\n' | sed "s/^'\\(.*\\)'$/\\1/"`;
  return machineCheck("setup:dns-credentials:check", [
    present("env-file", CADDY_ENV_FILE),
    { label: "env-permissions", test: `[ "$(stat -c '%U:%G %a' ${CADDY_ENV_FILE})" = 'root:caddy 640' ]` },
    { label: "caddy-read-env", test: policy === null ? CADDY_READ_ENV : `${policyPending(policy)} || { ${CADDY_READ_ENV}; }` },
    ...(variables === null || variables.length === 0
      ? []
      : [
          {
            label: "env-same",
            test: variables
              .map((variable) =>
                variable.fingerprint === null ? `[ -n "$(${value(variable.name)})" ]` : `[ "$(${value(variable.name)} | sha256sum | cut -d' ' -f1)" = '${variable.fingerprint}' ]`,
              )
              .join(" && "),
          },
        ]),
  ]);
}

/** What names a DNS credential in Caddy's environment file, whichever provider's: grep's words. */
const CREDENTIAL_LINE = "^[[:space:]]*(CLOUDFLARE_API_TOKEN|SITESOLIDE_DNS_[A-Z0-9_]+)=";

/** The names a text of caddyEnvironmentText defines. */
function definedNames(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The file written with these values, every other credential line it held
 * KEPT: a switch of provider writes the new one's variables a step before
 * the zone's policy names them, and the previous provider's must still be
 * there, for the policy in service, should anything stop in between. The
 * dns-leftovers step takes them out once the new policy is in service.
 */
export function dnsCredentialsRun(text: string): string {
  const names = definedNames(text);
  const others = names.length === 0 ? `grep -E '${CREDENTIAL_LINE}' ${CADDY_ENV_FILE}` : `grep -E '${CREDENTIAL_LINE}' ${CADDY_ENV_FILE} | grep -Ev '^[[:space:]]*(${names.join("|")})='`;
  return runScript(
    "setup:dns-credentials:run",
    `next=$(mktemp)
trap 'rm -f "$next"' EXIT
cat > "$next" <<'VARIABLES'
${text}VARIABLES
if [ -f ${CADDY_ENV_FILE} ]; then { ${others} || true; } >> "$next"; fi
install -m 0640 -o root -g caddy "$next" ${CADDY_ENV_FILE}`,
  );
}

/** Whether the file holds a credential line the provider in place does not read: its previous provider's. */
export function dnsLeftoversCheck(text: string): string {
  const names = definedNames(text);
  const foreign = names.length === 0 ? `grep -E '${CREDENTIAL_LINE}' ${CADDY_ENV_FILE}` : `grep -E '${CREDENTIAL_LINE}' ${CADDY_ENV_FILE} | grep -Ev '^[[:space:]]*(${names.join("|")})='`;
  return machineCheck("setup:dns-leftovers:check", [{ label: "env-own-only", test: `! { ${foreign}; } | grep -q .` }]);
}

/** The file keeping every line but the credentials the provider in place does not read. */
export function dnsLeftoversRun(text: string): string {
  const names = definedNames(text);
  // Under --dns manual, no credential is left: the file is the comment alone.
  const rewrite =
    names.length === 0
      ? `cat > "$next" <<'VARIABLES'\n${text}VARIABLES`
      : `grep -Ev '${CREDENTIAL_LINE}' ${CADDY_ENV_FILE} > "$next" || true\ngrep -E '^[[:space:]]*(${names.join("|")})=' ${CADDY_ENV_FILE} >> "$next" || true`;
  // What leaves is what Caddy no longer reads: the file keeps its time, so
  // that the credentials step still finds Caddy started after its last
  // change, and asks for no restart over it.
  return runScript(
    "setup:dns-leftovers:run",
    `next=$(mktemp)
trap 'rm -f "$next"' EXIT
${rewrite}
touch -r ${CADDY_ENV_FILE} "$next"
install -p -m 0640 -o root -g caddy "$next" ${CADDY_ENV_FILE}`,
  );
}

function envPermissionsRun(): string {
  return runScript("setup:dns-credentials:run", `chown root:caddy ${CADDY_ENV_FILE}\nchmod 640 ${CADDY_ENV_FILE}`);
}

export function caddyUnitRun(dropIn: string): string {
  return runScript(
    "setup:caddy-unit:run",
    `
mkdir -p /etc/systemd/system/caddy.service.d
install -m 644 -o root -g root /dev/stdin ${CADDY_DROP_IN} <<'UNIT'
${dropIn.endsWith("\n") ? dropIn : `${dropIn}\n`}UNIT
systemctl daemon-reload
systemctl restart caddy
`,
  );
}

const PORTAL_ENV = "/etc/sitesolide/portal.env";
const PORTAL_ACCOUNT = "site-portal";

/**
 * The portal's account first, made exactly as `deploy` makes a project's
 * (prepareService in bin/sitesolide.ts), so that the deploy that follows finds
 * it and makes nothing; then the hash, only if the file is still absent at the
 * moment of writing. The script says which: a password whose hash was not
 * written is never shown.
 */
export function portalPasswordRun(hash: string): string {
  return runScript(
    "setup:portal-password:run",
    `
id -u ${PORTAL_ACCOUNT} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${PORTAL_ACCOUNT}
[ -d /etc/sitesolide ] || install -d -m 755 -o root -g root /etc/sitesolide
if [ -e ${PORTAL_ENV} ]; then echo "portal-password: present"; exit 0; fi
install -m 600 -o ${PORTAL_ACCOUNT} -g ${PORTAL_ACCOUNT} /dev/stdin ${PORTAL_ENV} <<'HASH'
PASSWORD_HASH=${hash}
HASH
echo "portal-password: written"
`,
  );
}

/** Whether the workstation resolves a name to the machine, and nothing else. */
export function resolvesToMachine(observed: Observed, addresses: { ipv4: string; ipv6: string | null }): boolean {
  if (observed.ipv4.length === 0 || observed.ipv4.some((address) => address !== addresses.ipv4)) return false;
  // An AAAA the workstation does not see is not held against the zone, some
  // networks drop them; one that points elsewhere is.
  return observed.ipv6.every((address) => addresses.ipv6 !== null && canonicalAddress(address) === canonicalAddress(addresses.ipv6));
}

function describeObserved(name: string, observed: Observed): string {
  const all = [...observed.ipv4, ...observed.ipv6];
  return `${name} answers ${all.length === 0 ? "nothing" : all.join(", ")}`;
}

/**
 * The wildcard first, through a name drawn at random that no resolver has
 * cached; the bare zone only once the wildcard answers. Asked before its
 * record exists, the bare zone's absence would be kept by the resolver for as
 * long as the zone's SOA says, half an hour at Cloudflare, and the wait that
 * follows the record's creation would see it for that long.
 */
async function resolution(context: SetupContext): Promise<{ check: Check; seen: string[] }> {
  const { zone } = context.options;
  const random = `x${context.deps.random()}.${zone}`;
  const wildcard = await context.deps.resolve(random);
  if (!resolvesToMachine(wildcard, context.addresses)) {
    return { check: { state: "missing", missing: [`*.${zone}`] }, seen: [describeObserved(random, wildcard)] };
  }
  const bare = await context.deps.resolve(zone);
  if (!resolvesToMachine(bare, context.addresses)) return { check: { state: "missing", missing: [zone] }, seen: [describeObserved(zone, bare)] };
  return { check: { state: "done" }, seen: [] };
}

const WAIT_STEP_MS = 10_000;
const WAIT_MS = 10 * 60_000;
const WAIT_BY_HAND_MS = 30 * 60_000;

async function waitForResolution(context: SetupContext): Promise<string> {
  const { deps, options } = context;
  const bound = options.skipDns ? WAIT_BY_HAND_MS : WAIT_MS;
  const deadline = deps.now() + bound;
  let said = deps.now();
  deps.output.say(`   waiting until this workstation resolves ${options.zone} and *.${options.zone} to ${[context.addresses.ipv4, context.addresses.ipv6].filter(Boolean).join(" and ")}, ${bound / 60_000} minutes at most`);
  for (;;) {
    const { check, seen } = await resolution(context);
    if (check.state === "done") return "the zone and its wildcard resolve to the machine";
    if (deps.now() >= deadline) {
      throw new StepFailure(`${options.zone} does not resolve to ${context.addresses.ipv4} from this workstation yet`, [
        ...seen,
        options.skipDns ? "create the records listed at the start of the run, DNS only" : "the records are created: a resolver may still be serving an older answer",
        "a resolver keeps an absence for as long as the zone's SOA says, up to half an hour: run setup again later, it resumes here",
      ]);
    }
    if (deps.now() - said >= 60_000) {
      deps.output.say(`   still waiting: ${seen.join(", ")}`);
      said = deps.now();
    }
    await deps.sleep(WAIT_STEP_MS);
  }
}

/** The steps that follow the hardening, every one of them run through the deploy account. */
export function installSteps(): Step<SetupContext>[] {
  const optional = (context: SetupContext): string | null => (context.options.minimal ? "--minimal" : null);
  return [
    {
      id: "caddy",
      title: "Caddy, with the zone's DNS module",
      check: (context) =>
        installCheck("setup:caddy:check", [
          { label: "caddy-package", test: "dpkg-query -W -f='${Status}' caddy | grep -q 'ok installed'" },
          ...(context.dns === null ? [] : [{ label: "dns-module", test: `caddy list-modules | grep -q '^${context.dns.caddy.module}$'` }]),
        ])(context),
      run: (context) => rootRun(context.machine, context.operator, "setup:caddy:run", caddyRun(context.dns), "Caddy could not be installed"),
      inspect: (context) => `ssh ${context.server} 'caddy list-modules | grep dns.providers'`,
    },
    {
      id: "bun",
      title: "Bun, at /usr/local/bin/bun",
      check: installCheck("setup:bun:check", [{ label: "bun", test: "test -x /usr/local/bin/bun" }]),
      run: (context) => rootRun(context.machine, context.operator, "setup:bun:run", bunRun(), "Bun could not be installed"),
      inspect: (context) => `ssh ${context.server} '/usr/local/bin/bun --version'`,
    },
    {
      id: "dns-credentials",
      title: "Caddy's DNS credentials",
      check: async (context) => {
        // Under --dns manual the file holds a comment alone; otherwise its
        // text is known once the credentials are, and compared whole.
        const credentials = context.dns === null ? null : await knownDnsCredentials(context, context.dns);
        return rootCheck(context.machine, context.operator, "setup:dns-credentials:check", dnsCredentialsCheck(expectedVariables(context.dns, credentials), zoneTls(context)));
      },
      run: async (context, missing) => {
        if (missing.every((label) => label === "env-permissions")) {
          await rootRun(context.machine, context.operator, "setup:dns-credentials:run", envPermissionsRun(), `${CADDY_ENV_FILE} could not be given to root:caddy 0640`);
          return "root:caddy 0640 again";
        }
        const what = context.dns === null ? "no credentials, under --dns manual" : `${context.dns.title}'s`;
        let written = false;
        if (missing.some((label) => label !== "env-permissions" && label !== "caddy-read-env")) {
          const credentials = context.dns === null ? null : await requireDnsCredentials(context, context.dns);
          // Tried before they reach the machine: the records may already
          // resolve, a rotation or a switch, and nothing else would ask the
          // provider anything before the renewal that needs them. Not under
          // --skip-dns, which promises the provider's API is left alone.
          if (context.dns !== null && credentials !== null && !context.options.skipDns) await proveDnsCredentials(context, context.dns, credentials);
          const execution = await asRoot(context.machine, context.operator, "setup:dns-credentials:run", dnsCredentialsRun(caddyEnvironmentText(context.dns, credentials)));
          if (execution.code !== 0) throw new StepFailure(`${CADDY_ENV_FILE} could not be written (exit code ${execution.code})`, []);
          if (missing.includes("env-file")) return `${CADDY_ENV_FILE} in place, root:caddy 0640, ${what}`;
          written = true;
        }
        // A running Caddy filled its {env.X} at its start: new values reach
        // it only through a restart. When the zone's policy file still has
        // to change, a switch of provider, the tls-zone step restarts it with
        // both; otherwise, a rotation, or one whose restart failed earlier,
        // it is restarted here.
        // Only a Caddy that runs the policy file is restarted by that step: a
        // Caddyfile from before it, or a Caddy at rest, is not.
        const policy = await rootCheck(context.machine, context.operator, "setup:tls-zone:check", tlsZoneCheck(zoneTls(context), true));
        const switching =
          policy.state === "missing" && policy.missing.some((label) => label === "tls-zone-file" || label === "tls-zone-same") && !policy.missing.includes("tls-zone-live");
        const said = written ? `${CADDY_ENV_FILE} held other values, now ${what}` : `${CADDY_ENV_FILE} holds ${what}`;
        if (switching) return `${said}: the next step restarts Caddy with them`;
        const restart = await asRoot(context.machine, context.operator, "setup:caddy-restart:run", caddyRestartScript("the DNS credentials changed"), true);
        if (restart.code !== 0) {
          throw new StepFailure(`${said}, but Caddy could not be restarted to read them: run setup again, it tries again`, `${restart.output}\n${restart.error}`.split("\n").filter((line) => line.trim() !== "").slice(-5));
        }
        return `${said}${restart.output.includes(CADDY_RESTART.restarted) ? ", and Caddy restarted to read them" : ""}`;
      },
      inspect: (context) => `ssh ${context.server} 'sudo stat -c "%U:%G %a" ${CADDY_ENV_FILE}'`,
    },
    {
      id: "tls-zone",
      title: "how the zone's certificates are obtained",
      check: (context) => rootCheck(context.machine, context.operator, "setup:tls-zone:check", tlsZoneCheck(zoneTls(context))),
      run: async (context) => {
        const execution = await asRoot(context.machine, context.operator, "setup:tls-zone:run", tlsZoneRun(zoneTls(context)), true);
        if (execution.code !== 0) {
          throw new StepFailure(`${TLS_ZONE_FILE} could not be laid: the previous one is back`, `${execution.output}\n${execution.error}`.split("\n").filter((line) => line.trim() !== "").slice(-5));
        }
        const restarted = execution.output.includes(TLS_ZONE_RESTARTED) ? ", Caddy restarted with it" : "";
        return context.dns === null ? `${TLS_ZONE_FILE}: a certificate per name, on demand${restarted}` : `${TLS_ZONE_FILE}: the wildcard, through ${context.dns.title}'s DNS${restarted}`;
      },
      inspect: (context) => `ssh ${context.server} 'cat ${TLS_ZONE_FILE}'`,
    },
    {
      id: "dns-leftovers",
      title: "no other provider's credentials left",
      check: (context) => rootCheck(context.machine, context.operator, "setup:dns-leftovers:check", dnsLeftoversCheck(caddyEnvironmentText(context.dns, placeholderCredentials(context.dns)))),
      run: async (context) => {
        // Once the zone's policy in service is this provider's: the
        // previous one's credentials, kept until now, can go.
        await rootRun(
          context.machine,
          context.operator,
          "setup:dns-leftovers:run",
          dnsLeftoversRun(caddyEnvironmentText(context.dns, placeholderCredentials(context.dns))),
          `${CADDY_ENV_FILE} could not be rewritten`,
        );
        return `the previous provider's credentials taken out of ${CADDY_ENV_FILE}`;
      },
      inspect: (context) => `ssh ${context.server} "sudo grep -Eo '^[[:space:]]*[A-Z_]+=' ${CADDY_ENV_FILE}"`,
    },
    {
      id: "resolution",
      title: "DNS seen from this workstation",
      check: async (context) => (await resolution(context)).check,
      run: (context) => waitForResolution(context),
      inspect: (context) => `dig +short ${context.options.zone}; dig +short check.${context.options.zone}`,
    },
    {
      id: "caddy-zone",
      title: "zone file and domain table",
      check: installCheck("setup:caddy-zone:check", [present("zone-file", "/etc/caddy/sitesolide.env"), present("domain-table", "/etc/caddy/domaines.map")]),
      // On a first install bin/deploy-caddy.sh lays the two files, then stops:
      // Caddy's unit does not load the zone variables yet. That stop is
      // expected, and printed only if the files are not there afterwards.
      run: async (context) => {
        const { output } = await context.deps.kit({ kind: "script", name: "deploy-caddy.sh", args: [], quiet: true }, context.childEnvironment);
        const after = await installCheck("setup:caddy-zone:check", [present("zone-file", "/etc/caddy/sitesolide.env"), present("domain-table", "/etc/caddy/domaines.map")])(context);
        if (after.state !== "done") {
          throw new StepFailure("bin/deploy-caddy.sh did not lay the zone file and the domain table", output.split("\n").filter((line) => line.trim() !== "").slice(-8));
        }
        return "laid by bin/deploy-caddy.sh, which stops until Caddy's unit loads them";
      },
      recheck: false,
      inspect: (context) => `ssh ${context.server} 'cat /etc/caddy/sitesolide.env'`,
    },
    {
      id: "caddy-unit",
      title: "Caddy's drop-in",
      check: installCheck("setup:caddy-unit:check", COMPONENT_CONDITIONS["caddy-unit"]),
      run: async (context) => {
        const dropIn = readFileSync(join(kitRoot(), "infra", "caddy", "caddy.service.d", "override.conf"), "utf8");
        await rootRun(context.machine, context.operator, "setup:caddy-unit:run", caddyUnitRun(dropIn), "Caddy did not restart with its drop-in");
        return "the zone variables loaded, Restart=always, Caddy restarted";
      },
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "caddy-config",
      title: "the Caddyfile",
      check: installCheck("setup:caddy-config:check", COMPONENT_CONDITIONS["caddy-config"]),
      run: (context) => script(context, "deploy-caddy.sh"),
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "api",
      title: "shared service",
      check: installCheck("setup:api:check", COMPONENT_CONDITIONS.api),
      run: (context) => script(context, "deploy-api.sh"),
      inspect: (context) => journal(context, "sitesolide-api"),
    },
    {
      id: "gatekeeper",
      title: "gatekeeper",
      check: installCheck("setup:gatekeeper:check", COMPONENT_CONDITIONS.gatekeeper),
      run: (context) => script(context, "deploy-gatekeeper.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB} ${UNITS}/sitesolide-gatekeeper-*'`,
    },
    {
      id: "dashboard-password",
      title: "dashboard password",
      check: installCheck("setup:dashboard-password:check", [present("dashboard-password", "/etc/sitesolide/dashboard.env")]),
      run: async (context) => {
        context.deps.output.say("-> the dashboard's password is drawn now and shown ONCE, on standard error: store it in a password manager");
        const { code } = await context.deps.kit({ kind: "script", name: "dashboard-password.sh", args: [], passwordOnStderr: true }, context.childEnvironment);
        if (code !== 0) throw new StepFailure(`bin/dashboard-password.sh failed (exit code ${code})`, ["its own message is just above"]);
        context.dashboardDrawn = true;
        return "drawn, shown once above; its hash in /etc/sitesolide/dashboard.env";
      },
      inspect: (context) => `ssh ${context.server} 'sudo stat -c "%U:%G %a" /etc/sitesolide/dashboard.env'`,
    },
    {
      id: "dashboard",
      title: "dashboard",
      check: installCheck("setup:dashboard:check", COMPONENT_CONDITIONS.dashboard),
      run: (context) => deployFolder(context, "dashboard"),
      inspect: (context) => journal(context, "dashboard"),
    },
    {
      id: "steward",
      title: "steward",
      check: installCheck("setup:steward:check", COMPONENT_CONDITIONS.steward),
      run: (context) => script(context, "deploy-steward.sh"),
      inspect: (context) => journal(context, "sitesolide-steward"),
    },
    {
      id: "collector",
      title: "collector",
      check: installCheck("setup:collector:check", COMPONENT_CONDITIONS.collector),
      run: (context) => script(context, "deploy-collector.sh"),
      inspect: (context) => journal(context, "sitesolide-collector"),
    },
    {
      id: "portal-password",
      title: "portal password",
      check: installCheck("setup:portal-password:check", [present("portal-password", PORTAL_ENV)]),
      run: async (context) => {
        const { password, hash } = await context.deps.drawPassword();
        const execution = await asRoot(context.machine, context.operator, "setup:portal-password:run", portalPasswordRun(hash));
        if (execution.code !== 0) throw new StepFailure(`${PORTAL_ENV} could not be written (exit code ${execution.code})`, [execution.error.trim()].filter(Boolean));
        if (/portal-password: written/.test(execution.output)) {
          context.deps.secrets.portal = password;
          return "drawn here, its hash on the machine; the password is shown at the end, once";
        }
        return `${PORTAL_ENV} appeared meanwhile: kept, nothing drawn is shown`;
      },
      inspect: (context) => `ssh ${context.server} 'sudo stat -c "%U:%G %a" ${PORTAL_ENV}'`,
    },
    {
      id: "portal",
      title: "portal",
      check: installCheck("setup:portal:check", COMPONENT_CONDITIONS.portal),
      run: (context) => deployFolder(context, "portal"),
      inspect: (context) => journal(context, "portal"),
    },
    {
      id: "loopback",
      title: "loopback rule",
      check: installCheck("setup:loopback:check", [
        { label: "loopback-table", test: "nft list table inet sitesolide_boucle" },
        enabled("loopback-unit", "sitesolide-loopback"),
      ]),
      run: (context) => script(context, "deploy-loopback.sh", ["close"]),
      inspect: (context) => `ssh ${context.server} 'sudo nft list table inet sitesolide_boucle'`,
    },
    {
      id: "monitor",
      title: "monitor",
      check: installCheck("setup:monitor:check", COMPONENT_CONDITIONS.monitor),
      run: (context) => script(context, "deploy-monitor.sh"),
      inspect: (context) => journal(context, "sitesolide-monitor"),
    },
    {
      id: "backups",
      title: "backups",
      skip: optional,
      check: installCheck("setup:backups:check", COMPONENT_CONDITIONS.backups),
      // install, then the steward, whose unit opens /var/lib/sitesolide-backup
      // only if it exists when it starts, then the first run and the timer.
      run: async (context) => {
        const installed = await installCheck("setup:backups:installed", COMPONENT_CONDITIONS["backups-installed"])(context);
        if (installed.state !== "done") await script(context, "deploy-backup.sh", ["install"]);
        await script(context, "deploy-steward.sh");
        await script(context, "deploy-backup.sh", ["enable"]);
        return "installed, the steward told, a first run, the hourly timer";
      },
      inspect: (context) => journal(context, "sitesolide-backup"),
    },
    {
      id: "installer",
      title: "installer",
      skip: optional,
      check: installCheck("setup:installer:check", COMPONENT_CONDITIONS.installer),
      run: (context) => script(context, "deploy-installer.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB}/installer.js'`,
    },
    {
      id: "egress",
      title: "egress proxy",
      skip: optional,
      check: installCheck("setup:egress:check", [...COMPONENT_CONDITIONS["egress-proxy"], ...COMPONENT_CONDITIONS["steward-after-egress"]]),
      // The steward after the proxy, so that it may write the connectors'
      // folder the proxy's script makes.
      run: async (context, missing) => {
        if (missing.includes("egress-active")) await script(context, "deploy-egress.sh");
        await script(context, "deploy-steward.sh");
        return "running, and the steward restarted to write its connectors";
      },
      inspect: (context) => journal(context, "sitesolide-egress"),
    },
  ];
}

/** The configuration, written as `init` writes it, and setup's marker beside it. */
function configurationStep(): Step<SetupContext> {
  const path = (context: SetupContext) => join(context.folder, "config.json");
  return {
    id: "configuration",
    title: "workstation configuration",
    check: async (context) => {
      const file = adoptLegacyKeys(readJson(path(context)) as never).config;
      const same =
        file.server === context.server &&
        file.zone === context.options.zone &&
        file.email === context.options.email &&
        (file.contact ?? null) === context.contact &&
        (file.dns ?? "cloudflare") === (context.options.dns ?? "cloudflare") &&
        (file.acme ?? "production") === (context.options.acme ?? "production");
      return same ? { state: "done" } : { state: "missing", missing: [path(context)] };
    },
    run: async (context) => {
      const previous = adoptLegacyKeys(readJson(path(context)) as never).config as Record<string, unknown>;
      const config = composeConfig({ server: context.server, zone: context.options.zone, email: context.options.email }, context.contact === null ? {} : { contact: context.contact }, previous);
      // Cloudflare is what an absent key means: written only otherwise.
      if (context.options.dns === null || context.options.dns === "cloudflare") delete config.dns;
      else config.dns = context.options.dns;
      // Production too: written only for staging.
      if (context.options.acme === ACME_STAGING) config.acme = ACME_STAGING;
      else delete config.acme;
      // The marker first, so that a run stopped anywhere after this point is
      // this install's to resume. One left by an install on another machine
      // or zone, whose configuration is gone, is replaced: this step only
      // runs for a configuration absent or setup's own.
      const marker = readMarker(context.folder);
      if (marker === null || marker.server !== context.server || marker.zone !== context.options.zone) {
        const written: Marker = { server: context.server, zone: context.options.zone, startedAt: new Date(context.deps.now()).toISOString() };
        mkdirSync(context.folder, { recursive: true });
        await Bun.write(join(context.folder, MARKER_NAME), `${JSON.stringify(written, null, 2)}\n`);
      }
      await writeConfig(path(context), config);
      return `written: ${path(context)}`;
    },
    inspect: (context) => `cat ${path(context)}`,
  };
}

/**
 * Values that only stand for the names a provider's module reads: what the
 * leftovers step needs, which looks at names alone and never at values.
 */
function placeholderCredentials(dns: DnsEntry | null): Credentials | null {
  if (dns === null) return null;
  return Object.fromEntries(dns.credentials.map((field) => [field.variable, "placeholder"]));
}

/** The credentials, tried with a read of the zone: refused ones stop the step before anything is written. */
async function proveDnsCredentials(context: SetupContext, entry: DnsEntry, credentials: Credentials): Promise<void> {
  const secrets = secretValues(entry, credentials);
  const scrub = (text: string): string => scrubSecrets(text, secrets);
  try {
    const api = entry.open({
      credentials,
      environment: context.deps.dnsApi.environment,
      fetcher: context.deps.dnsApi.fetcher ?? fetch,
      clock: { now: () => context.deps.now(), sleep: (ms) => context.deps.sleep(ms) },
      secret: (value) => {
        if (value !== "") secrets.push(value);
      },
    });
    await api.verify();
    await api.findZone(context.options.zone);
  } catch (error) {
    if (error instanceof DnsError) throw new StepFailure(`${entry.title} refused the credentials given: ${scrub(error.message)}`, error.details.map(scrub));
    if (error instanceof ProviderError) throw new StepFailure(scrub(error.failure.message), (error.failure.details ?? []).map(scrub));
    throw error;
  }
}

/** What /etc/caddy/tls-zone.caddy holds for this machine: the provider's DNS challenge, or certificates on demand. */
function zoneTls(context: SetupContext): string {
  return tlsZoneContent(
    context.dns === null ? { kind: "on-demand" } : { kind: "dns", title: context.dns.title, directive: context.dns.caddy.directive },
    context.options.acme === ACME_STAGING,
  );
}

/** The records, through the DNS provider's API, at the start: they propagate while the machine installs. */
function dnsStep(): Step<SetupContext> {
  return {
    id: "dns",
    title: "DNS records",
    skip: (context) => (context.options.skipDns ? `${context.dns === null ? "--dns manual" : "--skip-dns"}: by hand, as listed above` : null),
    check: async (context) => (await resolution(context)).check,
    run: async (context) => {
      // Never reached under --dns manual, which skips this step.
      const entry = context.dns!;
      const credentials = await requireDnsCredentials(context, entry);
      // The credentials, and a token the provider obtains for them, are
      // scrubbed from whatever a failure says, whichever provider wrote it.
      const secrets = secretValues(entry, credentials);
      const scrub = (text: string): string => scrubSecrets(text, secrets);
      try {
        const api = entry.open({
          credentials,
          environment: context.deps.dnsApi.environment,
          fetcher: context.deps.dnsApi.fetcher ?? fetch,
          clock: { now: () => context.deps.now(), sleep: (ms) => context.deps.sleep(ms) },
          secret: (value) => {
            if (value !== "") secrets.push(value);
          },
        });
        const { zone, actions } = await ensureZoneRecords(api, context.options.zone, context.addresses, context.options.dnsReplace);
        const changes = describePlan(actions);
        return changes.length === 0 ? `already in the ${entry.title} zone ${zone}` : `${changes.join("; ")}, in the ${entry.title} zone ${zone}`;
      } catch (error) {
        if (error instanceof DnsError) throw new StepFailure(scrub(error.message), error.details.map(scrub));
        if (error instanceof ProviderError) throw new StepFailure(scrub(error.failure.message), (error.failure.details ?? []).map(scrub));
        if (error instanceof Error) throw new StepFailure(scrub(error.message), []);
        throw error;
      }
    },
    // Resolvers catch up later: the resolution step waits for them, after the
    // packages and Caddy, and before the first script that needs them.
    recheck: false,
    inspect: (context) => `dig +short ${context.options.zone}`,
  };
}

/** Every step, in order. */
export function setupSteps(): Step<SetupContext>[] {
  return [configurationStep(), dnsStep(), ...hardeningSteps<SetupContext>(), ...installSteps()];
}

// --- the run ------------------------------------------------------------------------

/**
 * This process's environment for a command it launches, the token left out:
 * a process's environment is readable by every other process of the account
 * on the workstation. Under --json, ssh never waits for a keyboard, as for
 * every command.
 */
export function withoutToken(environment: Record<string, string | undefined>, json: boolean): Record<string, string> {
  const child: Record<string, string> = {};
  // Every DNS provider's credentials, Cloudflare's token among them: a
  // script setup launches never needs them, and reaches them through nothing.
  const kept = new Set(["CLOUDFLARE_API_TOKEN", ...dnsVariables()]);
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !kept.has(key)) child[key] = value;
  }
  if (json) Object.assign(child, { SSH_ASKPASS_REQUIRE: "force", SSH_ASKPASS: Bun.which("false") ?? "/usr/bin/false" });
  return child;
}

/** The settings every script and `sitesolide deploy` receive, over whatever the configuration says. */
export function childEnvironment(
  environment: Record<string, string | undefined>,
  settings: { server: string; zone: string; email: string; contact: string | null; folder: string; acme?: string | null },
  json: boolean,
): Record<string, string> {
  const child = withoutToken(environment, json);
  Object.assign(child, kitEnv(), {
    SITESOLIDE_SERVER: settings.server,
    SITESOLIDE_ZONE: settings.zone,
    SITESOLIDE_EMAIL: settings.email,
    SITESOLIDE_CONTACT: settings.contact ?? "",
    SITESOLIDE_ACME: settings.acme === ACME_STAGING ? ACME_STAGING : "",
    [CONFIG_DIR_VARIABLE]: settings.folder,
  });
  return child;
}

/**
 * The workstation's address withdrawn from what fail2ban spares, at the end of
 * a run that spared it, success or failure: null when done or nothing to do,
 * the line to show otherwise.
 */
async function releaseFail2ban(context: SetupContext): Promise<string | null> {
  const address = context.ignoredAddress;
  if (address === null) return null;
  context.ignoredAddress = null;
  const execution = await asRoot(context.machine, context.operator, "setup:fail2ban:release", fail2banRelease(address));
  if (execution.code === 0) return null;
  return `fail2ban still spares ${address} until its next restart: sudo fail2ban-client set sshd delignoreip ${address} ends it`;
}

/** Whether the machine refuses or drops a new connection now: asked after a step failed. */
async function connectionLost(context: SetupContext): Promise<boolean> {
  const probe = await context.machine.exec(context.operator, "true");
  return probe.code !== 0 && CONNECTION_LOST.test(probe.error);
}

function stepList(reports: readonly StepReport[]) {
  return reports.map(({ step, status, detail }) => ({ step, status, detail }));
}

/** Runs setup; the exit code. */
export async function runSetup(given: SetupOptions, deps: SetupDependencies): Promise<number> {
  const out = deps.output;
  const refuse = (refusal: Refusal): number => {
    out.error(refusal.message, refusal.details);
    return 1;
  };

  // 1. The configuration in place, before anything leaves the workstation.
  const folder = privateFolder(deps.home, deps.environment);
  const configPath = join(folder, "config.json");
  const file = adoptLegacyKeys(readJson(configPath) as never).config;
  // The DNS: what --dns says, else what the configuration recorded, else
  // Cloudflare. Manual means records by hand: listed, then waited for.
  const dnsName = given.dns ?? (typeof file.dns === "string" && file.dns !== "" ? file.dns : "cloudflare");
  if (dnsEntry(dnsName) === undefined) return refuse(REFUSALS.invalid("dns in the configuration", dnsName, `one of ${[...DNS_PROVIDERS.map((entry) => entry.name), MANUAL].join(", ")}`));
  // The certificate authority likewise: --acme, else the configuration's, else production.
  const acmeName = given.acme ?? (file.acme === ACME_STAGING ? ACME_STAGING : "production");
  const options: SetupOptions = { ...given, dns: dnsName, acme: acmeName, skipDns: given.skipDns || dnsName === MANUAL };
  const configured = {
    server: deps.environment.SITESOLIDE_SERVER ?? file.server,
    zone: deps.environment.SITESOLIDE_ZONE ?? file.zone,
  };
  const guard = await configGuard(configPath, configured, readMarker(folder), { host: options.host, user: options.user, zone: options.zone }, deps.sameMachine);
  if (guard.kind === "refuse") return refuse(guard);
  const server = guard.kind === "fresh" ? `${options.user}@${options.host}` : guard.server;
  const contact = options.contact ?? (typeof file.contact === "string" && file.contact !== "" ? file.contact : null);

  out.say(`-> setup of ${options.host}, zone ${options.zone}, deploying as ${options.user}${options.dryRun ? ", dry run: nothing is changed" : ""}`);
  if (guard.kind === "installed") out.say(`   ${configPath} names this machine, which setup did not install: it is only read`);
  if (guard.kind === "ours") out.say(`   resuming the install ${configPath} records`);

  // 2. The preflight, read only, as the account given; as the deploy account
  // when setup's own install has closed root. Never as an account that may not
  // exist: a refused login is a line fail2ban counts. See preflightAccounts.
  const marker = readMarker(folder);
  const accounts = preflightAccounts(options.login, options.user, guard, marker);
  const read = async (account: string): Promise<{ facts: Facts } | { refusal: Refusal; refused: boolean }> => {
    const execution = await deps.machine.exec(account, "sh -s setup:preflight:read", { input: preflightScript() });
    const said = execution.error.trim().split("\n").filter((line) => line !== "").at(-1) ?? `exit code ${execution.code}`;
    if (execution.code !== 0) return { refusal: REFUSALS.unreachable(`${account}@${options.host}`, said), refused: /Permission denied/.test(execution.error) };
    const facts = readFacts(execution.output);
    return facts === null ? { refusal: REFUSALS.unreadable(`${account}@${options.host}`, said), refused: false } : { facts };
  };
  let operator = accounts.first;
  let preflight = await read(operator);
  if ("refusal" in preflight && preflight.refused && accounts.then !== null) {
    const second = await read(accounts.then);
    if ("facts" in second) {
      operator = accounts.then;
      preflight = second;
    }
  }
  if ("refusal" in preflight) return refuse(preflight.refusal);
  const { facts } = preflight;
  if (operator !== options.login) out.say(`   ${options.login} may no longer log in: going on as ${operator}`);
  const judged = judgeFacts(facts, options, operator);
  if (judged !== null) return refuse(judged);
  const addresses = chooseAddresses(options.host, facts);
  if ("message" in addresses) return refuse(addresses);
  out.check({
    step: "preflight",
    title: "preflight",
    status: "ok",
    detail: `${facts.system}, ${facts.architecture}, ${(facts.freeKb / 1024 / 1024).toFixed(0)} GB free, ${[addresses.ipv4, addresses.ipv6].filter(Boolean).join(" and ")}, as ${operator}`,
  });

  const context: SetupContext = {
    machine: deps.machine,
    host: options.host,
    operator,
    deployUser: options.user,
    sshPort: facts.sshPort,
    accountReady: false,
    clientAddress: facts.clientAddress,
    ignoredAddress: null,
    options,
    deps,
    folder,
    server,
    contact,
    addresses,
    dns: dnsEntry(dnsName) ?? null,
    dnsCredentials: undefined,
    dashboardDrawn: false,
    childEnvironment: childEnvironment(deps.environment, { server, zone: options.zone, email: options.email, contact, folder, acme: acmeName }, options.json),
  };
  const steps = setupSteps();

  // 3. Read only: a dry run, or a machine setup did not install, which it
  // leaves alone unless every step is already done there.
  if (guard.kind === "installed" || options.dryRun) {
    const outcome = await runSteps(steps, context, { checkOnly: true, report: (report) => out.check(report) });
    const todo = outcome.reports.filter((report) => report.status === "todo");
    if (guard.kind === "installed" && todo.length > 0) return refuse(REFUSALS.installed(options.host, todo));
    out.say(todo.length === 0 ? "-> every step is done: nothing to do" : `-> dry run: ${todo.length} step(s) to do, nothing was changed`);
    out.result({ dryRun: options.dryRun, server, zone: options.zone, steps: stepList(outcome.reports) });
    return 0;
  }

  if (options.skipDns) {
    out.say(`-> ${options.dns === MANUAL ? "--dns manual" : "--skip-dns"}: create these records at your DNS provider; setup waits for them before Caddy's configuration`);
    for (const line of manualRecords(options.zone, addresses.ipv4, addresses.ipv6)) out.say(`   ${line}`);
  }

  // 4. The steps.
  const outcome = await runSteps(steps, context, {
    checkOnly: false,
    report: (report) => {
      out.check(report);
      if (report.step === "ssh" && (report.status === "done" || report.status === "ok")) noteRootClosed(folder);
    },
    starting: (step) => out.say(`-> ${step.title}`),
  });
  const portalDrawn = deps.secrets.portal !== null;
  const released = await releaseFail2ban(context);

  if (outcome.failure !== null) {
    const { step, message, details, inspect } = outcome.failure;
    // A machine that stopped answering ssh in the middle of a run has most
    // likely banned the workstation: asked once more, it says so, and the
    // report says what to do about it rather than only what failed.
    const lost = CONNECTION_LOST.test([message, ...details].join("\n")) || (await connectionLost(context));
    out.error(lost ? `setup stopped at ${step}: the connection to the machine was refused or dropped` : `setup stopped at ${step}: ${message}`, [
      ...(lost ? [message] : []),
      ...details,
      ...(lost ? BAN_ADVICE : [`inspect: ${inspect}`, "run the same command again to resume: the steps already done are skipped"]),
      ...(released === null ? [] : [released]),
    ]);
    // Its hash is on the machine already: lost now, it could only be replaced.
    showSecrets(deps);
    return 1;
  }
  if (released !== null) out.say(`!! ${released}`);

  const ran = outcome.reports.filter((report) => report.status === "ok").map((report) => report.step);
  const already = outcome.reports.filter((report) => report.status === "done").map((report) => report.step);
  const skipped = outcome.reports.filter((report) => report.status === "skip").map((report) => report.step);
  const dashboard = `https://dashboard.${options.zone}`;
  const portal = `https://portal.${options.zone}`;
  const environmentPrefix = privateFolder(deps.home, {}) === folder ? "" : `${CONFIG_DIR_VARIABLE}=${folder} `;
  const next = [
    `cd <your project> && ${environmentPrefix}sitesolide deploy`,
    "the monitor's heartbeat, five minutes: monitor/README.md, \"Alerting: healthchecks.io in five minutes\"",
    ...(options.minimal ? ["backups, the installer and the egress proxy were left out: run setup again without --minimal"] : []),
  ];
  out.say("");
  out.say(ran.length === 0 ? `-> ${server} was already installed: nothing was changed` : `-> sitesolide is installed on ${server}`);
  out.say(`   dashboard  ${dashboard}${context.dashboardDrawn ? "   its password was shown once, above" : ""}`);
  out.say(`   portal     ${portal}${portalDrawn ? "   its password is shown below, once" : ""}`);
  out.say(`   run now: ${ran.length === 0 ? "nothing" : ran.join(", ")}`);
  out.say(`   already there: ${already.length === 0 ? "nothing" : already.join(", ")}`);
  if (skipped.length > 0) out.say(`   left out: ${skipped.join(", ")}`);
  if (environmentPrefix !== "") out.say(`   this installation's configuration is ${folder}: every command needs ${CONFIG_DIR_VARIABLE}=${folder}`);
  out.say("next:");
  for (const line of next) out.say(`   ${line}`);
  showSecrets(deps);
  out.result({
    dryRun: false,
    server,
    zone: options.zone,
    dashboard,
    portal,
    configuration: configPath,
    ran,
    already,
    skipped,
    steps: stepList(outcome.reports),
    passwords: portalDrawn || context.dashboardDrawn ? "shown once on standard error, never in an event" : null,
    next,
  });
  return 0;
}

/** The portal's password, shown once and forgotten: at the end of a run, failed or not, or on an interruption. */
export function showSecrets(deps: Pick<SetupDependencies, "secrets" | "output">): void {
  const password = deps.secrets.portal;
  if (password === null) return;
  deps.secrets.portal = null;
  deps.output.secret([
    "",
    `  portal password   ${password}`,
    "                    the owner's password at the sign-in of restricted sites",
    "                    store it now: it is shown this once, and changed from the dashboard",
    "",
  ]);
}

// --- the real dependencies ------------------------------------------------------

/** ssh as setup speaks it: no prompt, a bounded wait, and a host key accepted on first contact only. */
export const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=8",
];

async function collect(stream: ReadableStream<Uint8Array>, onLine: ((line: string) => void) | null): Promise<string> {
  const lines: string[] = [];
  await forEachLine(stream, (line) => {
    lines.push(line);
    onLine?.(line);
  });
  return lines.join("\n");
}

export function sshMachine(host: string, environment: Record<string, string>, output: SetupOutput): Machine {
  return {
    async exec(account, command, options = {}) {
      const proc = Bun.spawn(["ssh", ...SSH_OPTIONS, `${account}@${host}`, command], {
        env: environment,
        stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
        stdout: "pipe",
        stderr: "pipe",
      });
      const relay = (stream: "stdout" | "stderr") => (options.stream === true ? (line: string) => output.relay(stream, line) : null);
      const [stdout, stderr] = await Promise.all([collect(proc.stdout, relay("stdout")), collect(proc.stderr, relay("stderr"))]);
      return { code: await proc.exited, output: stdout, error: stderr } satisfies Execution;
    },
  };
}

/**
 * The folder `sitesolide deploy` runs in for one of the platform's own
 * components, the one place setup names it: the kit's own folder. A deploy
 * writes into the folder it runs in, a manifest the machine corrects, and a
 * compiled binary's kit is read only; the child's `workingFolder` (kit.ts)
 * moves it onto a writable copy, so nothing here has to.
 */
export function componentFolder(name: "dashboard" | "portal"): string {
  return join(kitRoot(), name);
}

/**
 * This CLI, run again as a child: `sitesolide deploy` for a component. A
 * compiled binary runs itself, its kit holding no bin/sitesolide.ts: naming
 * that file stopped the first install from the binary at the dashboard. A
 * checkout runs its entry point with the Bun running this one.
 */
export function selfCommand(...arguments_: string[]): string[] {
  if (isCompiled()) return [process.execPath, ...arguments_];
  return [process.execPath, join(kitRoot(), "bin", "sitesolide.ts"), ...arguments_];
}

/**
 * The scripts of bin/ and `sitesolide deploy`, found through the kit. In human
 * mode they write to the terminal as they always do; under --json their lines
 * become `output` events. The dashboard's password goes to standard error in
 * both, never through an event.
 *
 * `capture`, for `sitesolide upgrade`: every line is relayed rather than
 * handed the terminal, in human mode too, and kept, so that a failure can
 * quote the end of what the script said. Nothing it runs reads the keyboard.
 */
export function kitRunner(output: SetupOutput, options: { capture?: boolean } = {}): KitRunner {
  return async (task, environment) => {
    const root = kitRoot();
    const command = task.kind === "script" ? ["bash", join(root, "bin", task.name), ...task.args] : selfCommand("deploy", ...(task.args ?? []));
    const quiet = task.quiet === true;
    const toTerminal = !output.json && !quiet && options.capture !== true;
    const proc = Bun.spawn(command, {
      cwd: task.kind === "deploy" ? componentFolder(task.folder) : root,
      env: environment,
      stdin: output.json || options.capture === true ? "ignore" : "inherit",
      stdout: toTerminal ? "inherit" : "pipe",
      stderr: toTerminal || (task.kind === "script" && task.passwordOnStderr === true) ? "inherit" : "pipe",
    });
    const relay = (stream: "stdout" | "stderr") => (quiet ? null : (line: string) => output.relay(stream, line));
    const [stdout, stderr] = await Promise.all([
      proc.stdout instanceof ReadableStream ? collect(proc.stdout, relay("stdout")) : Promise.resolve(""),
      proc.stderr instanceof ReadableStream ? collect(proc.stderr, relay("stderr")) : Promise.resolve(""),
    ]);
    return { code: await proc.exited, output: [stdout, stderr].filter((text) => text !== "").join("\n") };
  };
}

async function resolveFromWorkstation(name: string): Promise<Observed> {
  const ipv4 = await lookup(name, { all: true, family: 4 })
    .then((found) => found.map((entry) => entry.address))
    .catch(() => []);
  const ipv6 = await resolve6(name).catch(() => [] as string[]);
  return { ipv4, ipv6 };
}

async function addressesOf(host: string): Promise<string[]> {
  if (isIP(host) !== 0) return [host];
  return lookup(host, { all: true })
    .then((found) => found.map((entry) => entry.address))
    .catch(() => []);
}

async function sameMachine(a: string, b: string): Promise<boolean> {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const [first, second] = await Promise.all([addressesOf(a), addressesOf(b)]);
  return first.some((address) => second.includes(address));
}

/** Typed without echo, on the terminal, as dashboard/scripts/fingerprint.ts reads a password. */
async function readHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const input = process.stdin;
  input.setRawMode(true);
  input.resume();
  let value = "";
  try {
    for await (const chunk of input) {
      for (const character of (chunk as Uint8Array).toString()) {
        if (character === "\u0003" || character === "\u0004") {
          process.stderr.write("\n");
          process.exit(130);
        }
        if (character === "\r" || character === "\n") return value;
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }
    return value;
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
}

function humanCheck(report: StepReport): string {
  // A title longer than its column still keeps a space before the detail.
  return `${`[${report.status}]`.padEnd(7)}${report.title.padEnd(35)} ${report.detail ?? ""}`.trimEnd();
}

export function setupOutput(json: boolean, write: (line: string) => void = (line) => console.log(line), command = "setup"): SetupOutput {
  const emit = (event: OutputEvent): void => write(formatEvent(event));
  return {
    json,
    say: (line) => {
      if (!json) return write(line);
      const event = eventFor(line);
      if (event !== null) emit(event);
    },
    check: (report) => (json ? emit({ type: "check", ...report }) : write(humanCheck(report))),
    relay: (stream, line) => (json ? emit({ type: "output", stream, line }) : stream === "stdout" ? write(`   ${line}`) : console.error(`   ${line}`)),
    secret: (lines) => {
      process.stderr.write(`${lines.join("\n")}\n`);
    },
    error: (message, details) => {
      if (json) return emit({ type: "error", message, details, hint: hintFor(message) });
      console.error(`!! ${message}`);
      for (const line of details) console.error(`   ${line}`);
    },
    result: (fields) => {
      if (json) emit({ type: "result", ok: true, command, ...fields });
    },
  };
}

/** `sitesolide setup ...`, from the command line: the exit code. */
export async function setupCommand(arguments_: readonly string[]): Promise<number> {
  const parsed = parseSetupArguments(arguments_);
  const json = arguments_.includes("--json");
  if ("message" in parsed) {
    setupOutput(json).error(parsed.message, parsed.details);
    return 1;
  }
  return setupFromWorkstation(parsed);
}

/**
 * What the setup wizard (bin/cli/wizard.ts) hands setup besides its options:
 * the DNS credentials typed at its prompts, which never reach the
 * environment the scripts inherit, and the output it draws with.
 */
export type SetupExtras = { dnsCredentials?: Credentials; output?: SetupOutput };

/** Setup with this workstation's ssh, kit, resolver and Cloudflare: the exit code. */
export async function setupFromWorkstation(options: SetupOptions, extras: SetupExtras = {}): Promise<number> {
  const json = options.json;
  const output = extras.output ?? setupOutput(json);
  if (options.configDir !== null) process.env[CONFIG_DIR_VARIABLE] = resolve(options.configDir.replace(/^~(?=\/|$)/, homedir()));

  // Read at once when it is piped: the scripts launched later inherit this
  // standard input, and must find it empty rather than holding the token.
  const piped = options.tokenStdin ? (await Bun.stdin.text()).trim() : null;
  const environment = { ...process.env };
  const secrets: Secrets = { portal: null };
  const sshEnvironment = withoutToken(environment, json);

  const deps: SetupDependencies = {
    machine: sshMachine(options.host, sshEnvironment, output),
    kit: kitRunner(output),
    resolve: resolveFromWorkstation,
    sameMachine,
    dnsApi: { environment },
    dnsCredentials: async (entry, ask) => {
      // Typed at the wizard, after it checked them against the zone: they
      // win over the environment's, which the wizard may have found refused.
      if (extras.dnsCredentials !== undefined) return extras.dnsCredentials;
      // Piped on purpose, they win over whatever the environment holds,
      // an account-wide CLOUDFLARE_API_TOKEN that wrangler reads above all.
      if (piped !== null && piped !== "") {
        const parsed = parseStdinCredentials(entry, piped);
        return isFailure(parsed) ? null : parsed;
      }
      const given = fromEnvironment(entry, environment);
      if (missingFields(entry, given).length === 0) return given;
      if (!ask || json || process.stdin.isTTY !== true) return null;
      const typed: Record<string, string> = { ...given };
      for (const field of missingFields(entry, given)) {
        const value = (await readHidden(`${entry.title} ${field.label} for ${options.zone}, ${field.variable}${field.secret ? ", not echoed" : ""}: `)).trim();
        if (value === "") return null;
        typed[field.variable] = value;
      }
      return typed;
    },
    drawPassword: async () => {
      const password = generatePassword();
      const hash = await Bun.password.hash(password, "argon2id");
      if (!(await Bun.password.verify(password, hash))) throw new StepFailure("the portal's hash does not verify its own password: nothing was written", []);
      return { password, hash };
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    random: () => Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString("hex"),
    home: homedir(),
    environment,
    output,
    secrets,
  };

  // An interruption still shows the password whose hash is already on the machine.
  process.on("SIGINT", () => {
    showSecrets(deps);
    process.exit(130);
  });
  return runSetup(options, deps);
}
