/**
 * `sitesolide setup <user@host> --zone <zone> --email <email>`: the whole base
 * install of docs/install.md in one command, on a fresh Debian 13 machine.
 *
 *   configuration      ~/.config/sitesolide/config.json, as `init` writes it
 *   dns                the zone and its wildcard at the machine, through Cloudflare's API
 *   packages ... ssh   the hardening of infra/cloud-init.yaml, see bin/cli/harden.ts
 *   caddy, bun         from their own repositories, Caddy with the Cloudflare module
 *   cloudflare-token   /etc/caddy/cloudflare.env, root:caddy 0640
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
 * A component already active is never deployed again here: upgrading stays
 * docs/upgrading.md's.
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
 * THE CLOUDFLARE TOKEN comes from CLOUDFLARE_API_TOKEN, from standard input
 * with --cloudflare-token-stdin, or from a prompt that does not echo. It is
 * asked for only when a step needs it, and it is never printed, never an
 * argument of any command, never in a URL nor an error: it reaches the API in
 * a header, and the machine inside a script on ssh's standard input. The
 * scripts setup launches do not inherit it.
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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { generatePassword } from "../../dashboard/src/password";
import { canonicalAddress, CloudflareError, cloudflareBase, describePlan, ensureRecords, manualRecords, type Fetcher } from "./cloudflare";
import { adoptLegacyKeys, composeConfig, CONFIG_DIR_VARIABLE, privateFolder, writeConfig } from "./config";
import {
  APT,
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
import { kitEnv, kitRoot } from "./kit";
import { eventFor, forEachLine, formatEvent, type OutputEvent } from "./output";
import { runSteps, StepFailure, type Check, type Step, type StepReport } from "./steps";

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
  configDir: string | null;
  json: boolean;
};

const VALUED = ["--zone", "--email", "--contact", "--user", "--config-dir"] as const;
const FLAGS = ["--skip-dns", "--dns-replace", "--minimal", "--any-os", "--dry-run", "--cloudflare-token-stdin", "--json"] as const;

const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
const ZONE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    details: [said, "setup connects without a prompt: the key loaded in the agent (ssh-add), the machine up and its port 22 open"],
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

  return {
    login,
    host,
    zone,
    email,
    contact,
    user,
    skipDns: flags.has("--skip-dns"),
    dnsReplace: flags.has("--dns-replace"),
    minimal: flags.has("--minimal"),
    anyOs: flags.has("--any-os"),
    dryRun: flags.has("--dry-run"),
    tokenStdin: flags.has("--cloudflare-token-stdin"),
    configDir: values["--config-dir"] ?? null,
    json,
  };
}

// --- the configuration on the workstation --------------------------------------

/** What setup records beside the configuration when it starts installing a machine. */
export type Marker = { server: string; zone: string; startedAt: string };

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
 * - none: a fresh workstation, or one with a team token only: setup writes it.
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
  return { server: raw.server, zone: raw.zone, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "" };
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
  const port = Number((values.get("ssh") ?? "").split(" ")[3]);
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

/** A script of the kit's bin/, or `sitesolide deploy` in one of its folders. */
export type KitTask =
  | { kind: "script"; name: string; args: string[]; quiet?: boolean; passwordOnStderr?: boolean }
  | { kind: "deploy"; folder: "dashboard" | "portal" };

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
  cloudflare: { base: string; fetcher?: Fetcher };
  /** The Cloudflare token: from the environment or standard input, and from a prompt only when `ask`. */
  token(ask: boolean): Promise<string | null>;
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
  /** The token once obtained; undefined until a step asked for it. */
  token: string | null | undefined;
  dashboardDrawn: boolean;
  /** What every script and every `sitesolide deploy` setup launches receives. */
  childEnvironment: Record<string, string>;
};

/** The Cloudflare token, asked for when a step needs it, once. */
async function requireToken(context: SetupContext): Promise<string> {
  if (typeof context.token === "string") return context.token;
  const token = await context.deps.token(true);
  if (token === null || token === "") {
    throw new StepFailure("no Cloudflare token", [
      "set CLOUDFLARE_API_TOKEN in the environment, or pipe it to --cloudflare-token-stdin",
      "it needs Zone / Zone / Read and Zone / DNS / Edit on the zone, from dash.cloudflare.com/profile/api-tokens",
      "with another DNS provider: --skip-dns, see docs/setup.md",
    ]);
  }
  if (!TOKEN.test(token)) throw new StepFailure("the Cloudflare token given is not one: letters, digits, dashes and underscores only", []);
  context.token = token;
  return token;
}

/** The token if it is known without asking anyone: given, or asked for earlier. */
async function knownToken(context: SetupContext): Promise<string | null> {
  if (context.token !== undefined) return context.token;
  const token = await context.deps.token(false);
  context.token = token !== null && TOKEN.test(token) ? token : undefined;
  return context.token ?? null;
}

/**
 * What a Cloudflare API token is made of. Anything else, a line break above
 * all, would write more than one line into the machine's environment file.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

// --- the install steps ------------------------------------------------------------

const LIB = "/usr/local/lib/sitesolide";
const UNITS = "/etc/systemd/system";

/** A check run as root through the deploy account, every step after the hardening. */
function deployCheck(tag: string, conditions: Parameters<typeof machineCheck>[1], prelude = "") {
  return (context: SetupContext): Promise<Check> => rootCheck(context.machine, context.deployUser, tag, machineCheck(tag, conditions, prelude));
}

function active(label: string, unit: string) {
  return { label, test: `systemctl is-active --quiet ${unit}` };
}

function enabled(label: string, unit: string) {
  return { label, test: `systemctl is-enabled --quiet ${unit}` };
}

function present(label: string, path: string) {
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
function stewardAfter(label: string, path: string) {
  return {
    label,
    test: `started=$(systemctl show -p ActiveEnterTimestamp --value sitesolide-steward) && [ -n "$started" ] && [ "$(date -d "$started" +%s)" -ge "$(stat -c %Y ${path})" ]`,
  };
}

const CADDY_DROP_IN = "/etc/systemd/system/caddy.service.d/override.conf";

function caddyRun(): string {
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
# The standard build lacks the DNS module the wildcard certificate needs.
caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare' || caddy add-package github.com/caddy-dns/cloudflare </dev/null
`,
  );
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

const TOKEN_FILE = "/etc/caddy/cloudflare.env";

/** The token's fingerprint, compared on the machine with the one of the file's value: neither travels in the clear. */
function tokenFingerprint(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function tokenCheck(fingerprint: string | null): string {
  return machineCheck("setup:cloudflare-token:check", [
    present("token-file", TOKEN_FILE),
    { label: "token-permissions", test: `[ "$(stat -c '%U:%G %a' ${TOKEN_FILE})" = 'root:caddy 640' ]` },
    ...(fingerprint === null
      ? []
      : [
          {
            label: "token-same",
            test: `[ "$(sed -n 's/^CLOUDFLARE_API_TOKEN=//p' ${TOKEN_FILE} | head -n 1 | tr -d '\\r\\n' | sha256sum | cut -d' ' -f1)" = '${fingerprint}' ]`,
          },
        ]),
  ]);
}

export function tokenRun(token: string): string {
  return runScript("setup:cloudflare-token:run", `install -m 0640 -o root -g caddy /dev/stdin ${TOKEN_FILE} <<'TOKEN'\nCLOUDFLARE_API_TOKEN=${token}\nTOKEN`);
}

function tokenPermissionsRun(): string {
  return runScript("setup:cloudflare-token:run", `chown root:caddy ${TOKEN_FILE}\nchmod 640 ${TOKEN_FILE}`);
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
      title: "Caddy, with the Cloudflare module",
      check: deployCheck("setup:caddy:check", [
        { label: "caddy-package", test: "dpkg-query -W -f='${Status}' caddy | grep -q 'ok installed'" },
        { label: "cloudflare-module", test: "caddy list-modules | grep -q '^dns.providers.cloudflare'" },
      ]),
      run: (context) => rootRun(context.machine, context.deployUser, "setup:caddy:run", caddyRun(), "Caddy could not be installed"),
      inspect: (context) => `ssh ${context.server} 'caddy list-modules | grep dns.providers'`,
    },
    {
      id: "bun",
      title: "Bun, at /usr/local/bin/bun",
      check: deployCheck("setup:bun:check", [{ label: "bun", test: "test -x /usr/local/bin/bun" }]),
      run: (context) => rootRun(context.machine, context.deployUser, "setup:bun:run", bunRun(), "Bun could not be installed"),
      inspect: (context) => `ssh ${context.server} '/usr/local/bin/bun --version'`,
    },
    {
      id: "cloudflare-token",
      title: "Caddy's Cloudflare token",
      check: async (context) => {
        const token = await knownToken(context);
        return rootCheck(context.machine, context.deployUser, "setup:cloudflare-token:check", tokenCheck(token === null ? null : tokenFingerprint(token)));
      },
      run: async (context, missing) => {
        if (missing.every((label) => label === "token-permissions")) {
          await rootRun(context.machine, context.deployUser, "setup:cloudflare-token:run", tokenPermissionsRun(), `${TOKEN_FILE} could not be given to root:caddy 0640`);
          return "root:caddy 0640 again";
        }
        const token = await requireToken(context);
        const execution = await asRoot(context.machine, context.deployUser, "setup:cloudflare-token:run", tokenRun(token));
        if (execution.code !== 0) throw new StepFailure(`${TOKEN_FILE} could not be written (exit code ${execution.code})`, []);
        return missing.includes("token-file")
          ? `${TOKEN_FILE} in place, root:caddy 0640`
          : `${TOKEN_FILE} held another token, replaced: Caddy reads it at its next start`;
      },
      inspect: (context) => `ssh ${context.server} 'sudo stat -c "%U:%G %a" ${TOKEN_FILE}'`,
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
      check: deployCheck("setup:caddy-zone:check", [present("zone-file", "/etc/caddy/sitesolide.env"), present("domain-table", "/etc/caddy/domaines.map")]),
      // On a first install bin/deploy-caddy.sh lays the two files, then stops:
      // Caddy's unit does not load the zone variables yet. That stop is
      // expected, and printed only if the files are not there afterwards.
      run: async (context) => {
        const { output } = await context.deps.kit({ kind: "script", name: "deploy-caddy.sh", args: [], quiet: true }, context.childEnvironment);
        const after = await deployCheck("setup:caddy-zone:check", [present("zone-file", "/etc/caddy/sitesolide.env"), present("domain-table", "/etc/caddy/domaines.map")])(context);
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
      check: deployCheck("setup:caddy-unit:check", [
        present("drop-in", CADDY_DROP_IN),
        { label: "restart-always", test: `[ "$(systemctl show caddy -p Restart --value)" = always ]` },
        { label: "zone-variables", test: "systemctl show caddy -p EnvironmentFiles --value | grep -q /etc/caddy/sitesolide.env" },
        active("caddy-active", "caddy"),
      ]),
      run: async (context) => {
        const dropIn = readFileSync(join(kitRoot(), "infra", "caddy", "caddy.service.d", "override.conf"), "utf8");
        await rootRun(context.machine, context.deployUser, "setup:caddy-unit:run", caddyUnitRun(dropIn), "Caddy did not restart with its drop-in");
        return "the zone variables loaded, Restart=always, Caddy restarted";
      },
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "caddy-config",
      title: "the Caddyfile",
      check: deployCheck("setup:caddy-config:check", [{ label: "caddyfile", test: "grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile" }, active("caddy-active", "caddy")]),
      run: (context) => script(context, "deploy-caddy.sh"),
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "api",
      title: "shared service",
      check: deployCheck("setup:api:check", [active("api-active", "sitesolide-api"), enabled("api-enabled", "sitesolide-api")]),
      run: (context) => script(context, "deploy-api.sh"),
      inspect: (context) => journal(context, "sitesolide-api"),
    },
    {
      id: "gatekeeper",
      title: "gatekeeper",
      check: deployCheck("setup:gatekeeper:check", [
        present("gatekeeper-code", `${LIB}/gatekeeper.js`),
        present("gatekeeper-on", `${UNITS}/sitesolide-gatekeeper-on@.service`),
        present("gatekeeper-off", `${UNITS}/sitesolide-gatekeeper-off@.service`),
      ]),
      run: (context) => script(context, "deploy-gatekeeper.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB} ${UNITS}/sitesolide-gatekeeper-*'`,
    },
    {
      id: "dashboard-password",
      title: "dashboard password",
      check: deployCheck("setup:dashboard-password:check", [present("dashboard-password", "/etc/sitesolide/dashboard.env")]),
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
      check: deployCheck("setup:dashboard:check", [active("dashboard-active", "dashboard")]),
      run: (context) => deployFolder(context, "dashboard"),
      inspect: (context) => journal(context, "dashboard"),
    },
    {
      id: "steward",
      title: "steward",
      check: deployCheck("setup:steward:check", [active("steward-active", "sitesolide-steward"), present("steward-code", `${LIB}/steward.js`)]),
      run: (context) => script(context, "deploy-steward.sh"),
      inspect: (context) => journal(context, "sitesolide-steward"),
    },
    {
      id: "collector",
      title: "collector",
      check: deployCheck("setup:collector:check", [enabled("collector-enabled", "sitesolide-collector.timer"), active("collector-active", "sitesolide-collector.timer")]),
      run: (context) => script(context, "deploy-collector.sh"),
      inspect: (context) => journal(context, "sitesolide-collector"),
    },
    {
      id: "portal-password",
      title: "portal password",
      check: deployCheck("setup:portal-password:check", [present("portal-password", PORTAL_ENV)]),
      run: async (context) => {
        const { password, hash } = await context.deps.drawPassword();
        const execution = await asRoot(context.machine, context.deployUser, "setup:portal-password:run", portalPasswordRun(hash));
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
      check: deployCheck("setup:portal:check", [active("portal-active", "portal")]),
      run: (context) => deployFolder(context, "portal"),
      inspect: (context) => journal(context, "portal"),
    },
    {
      id: "loopback",
      title: "loopback rule",
      check: deployCheck("setup:loopback:check", [
        { label: "loopback-table", test: "nft list table inet sitesolide_boucle" },
        enabled("loopback-unit", "sitesolide-loopback"),
      ]),
      run: (context) => script(context, "deploy-loopback.sh", ["close"]),
      inspect: (context) => `ssh ${context.server} 'sudo nft list table inet sitesolide_boucle'`,
    },
    {
      id: "monitor",
      title: "monitor",
      check: deployCheck("setup:monitor:check", [enabled("monitor-enabled", "sitesolide-monitor.timer"), active("monitor-active", "sitesolide-monitor.timer")]),
      run: (context) => script(context, "deploy-monitor.sh"),
      inspect: (context) => journal(context, "sitesolide-monitor"),
    },
    {
      id: "backups",
      title: "backups",
      skip: optional,
      check: deployCheck("setup:backups:check", [enabled("backup-enabled", "sitesolide-backup.timer"), active("backup-active", "sitesolide-backup.timer")]),
      // install, then the steward, whose unit opens /var/lib/sitesolide-backup
      // only if it exists when it starts, then the first run and the timer.
      run: async (context) => {
        const installed = await deployCheck("setup:backups:installed", [present("backup-code", `${LIB}/backup.js`), present("backup-timer", `${UNITS}/sitesolide-backup.timer`)])(context);
        if (installed.state !== "done") await script(context, "deploy-backup.sh", ["install"]);
        await script(context, "deploy-steward.sh");
        await script(context, "deploy-backup.sh", ["enable"]);
        return "installed, the steward told, a first run, the hourly timer";
      },
      inspect: (context) => journal(context, "sitesolide-backup"),
    },
    {
      id: "installer",
      title: "team installer",
      skip: optional,
      check: deployCheck("setup:installer:check", [present("installer-code", `${LIB}/installer.js`), present("installer-unit", `${UNITS}/sitesolide-installer@.service`)]),
      run: (context) => script(context, "deploy-installer.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB}/installer.js'`,
    },
    {
      id: "egress",
      title: "egress proxy",
      skip: optional,
      check: deployCheck("setup:egress:check", [active("egress-active", "sitesolide-egress"), stewardAfter("steward-after-egress", `${UNITS}/sitesolide-egress.service`)]),
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
      const same = file.server === context.server && file.zone === context.options.zone && file.email === context.options.email && (file.contact ?? null) === context.contact;
      return same ? { state: "done" } : { state: "missing", missing: [path(context)] };
    },
    run: async (context) => {
      const previous = adoptLegacyKeys(readJson(path(context)) as never).config as Record<string, unknown>;
      const config = composeConfig({ server: context.server, zone: context.options.zone, email: context.options.email }, context.contact === null ? {} : { contact: context.contact }, previous);
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

/** The records, through Cloudflare's API, at the start: they propagate while the machine installs. */
function dnsStep(): Step<SetupContext> {
  return {
    id: "dns",
    title: "DNS records",
    skip: (context) => (context.options.skipDns ? "--skip-dns: by hand, as listed above" : null),
    check: async (context) => (await resolution(context)).check,
    run: async (context) => {
      const token = await requireToken(context);
      try {
        const { zone, actions } = await ensureRecords(
          { base: context.deps.cloudflare.base, token, ...(context.deps.cloudflare.fetcher === undefined ? {} : { fetcher: context.deps.cloudflare.fetcher }) },
          context.options.zone,
          context.addresses,
          context.options.dnsReplace,
        );
        const changes = describePlan(actions);
        return changes.length === 0 ? `already in the Cloudflare zone ${zone}` : `${changes.join("; ")}, in the Cloudflare zone ${zone}`;
      } catch (error) {
        if (error instanceof CloudflareError) throw new StepFailure(error.message, error.details);
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
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && key !== "CLOUDFLARE_API_TOKEN") child[key] = value;
  }
  if (json) Object.assign(child, { SSH_ASKPASS_REQUIRE: "force", SSH_ASKPASS: Bun.which("false") ?? "/usr/bin/false" });
  return child;
}

/** The settings every script and `sitesolide deploy` receive, over whatever the configuration says. */
export function childEnvironment(
  environment: Record<string, string | undefined>,
  settings: { server: string; zone: string; email: string; contact: string | null; folder: string },
  json: boolean,
): Record<string, string> {
  const child = withoutToken(environment, json);
  Object.assign(child, kitEnv(), {
    SITESOLIDE_SERVER: settings.server,
    SITESOLIDE_ZONE: settings.zone,
    SITESOLIDE_EMAIL: settings.email,
    SITESOLIDE_CONTACT: settings.contact ?? "",
    [CONFIG_DIR_VARIABLE]: settings.folder,
  });
  return child;
}

function stepList(reports: readonly StepReport[]) {
  return reports.map(({ step, status, detail }) => ({ step, status, detail }));
}

/** Runs setup; the exit code. */
export async function runSetup(options: SetupOptions, deps: SetupDependencies): Promise<number> {
  const out = deps.output;
  const refuse = (refusal: Refusal): number => {
    out.error(refusal.message, refusal.details);
    return 1;
  };

  // 1. The configuration in place, before anything leaves the workstation.
  const folder = privateFolder(deps.home, deps.environment);
  const configPath = join(folder, "config.json");
  const file = adoptLegacyKeys(readJson(configPath) as never).config;
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

  // 2. The preflight, read only: as the account given, or as the deploy
  // account when root may no longer log in, an earlier run having closed it.
  const accounts = [options.login, ...(options.login === options.user ? [] : [options.user])];
  let facts: Facts | null = null;
  let operator = options.login;
  let refusal: Refusal | null = null;
  for (const account of accounts) {
    const execution = await deps.machine.exec(account, "sh -s setup:preflight:read", { input: preflightScript() });
    const said = execution.error.trim().split("\n").filter((line) => line !== "").at(-1) ?? `exit code ${execution.code}`;
    if (execution.code !== 0) {
      refusal ??= REFUSALS.unreachable(`${account}@${options.host}`, said);
      continue;
    }
    facts = readFacts(execution.output);
    if (facts === null) {
      refusal = REFUSALS.unreadable(`${account}@${options.host}`, said);
      break;
    }
    operator = account;
    break;
  }
  if (facts === null) return refuse(refusal ?? REFUSALS.unreachable(`${options.login}@${options.host}`, "no answer"));
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
    options,
    deps,
    folder,
    server,
    contact,
    addresses,
    token: undefined,
    dashboardDrawn: false,
    childEnvironment: childEnvironment(deps.environment, { server, zone: options.zone, email: options.email, contact, folder }, options.json),
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
    out.say("-> --skip-dns: create these records at your DNS provider; setup waits for them before Caddy's configuration");
    for (const line of manualRecords(options.zone, addresses.ipv4, addresses.ipv6)) out.say(`   ${line}`);
  }

  // 4. The steps.
  const outcome = await runSteps(steps, context, {
    checkOnly: false,
    report: (report) => out.check(report),
    starting: (step) => out.say(`-> ${step.title}`),
  });
  const portalDrawn = deps.secrets.portal !== null;

  if (outcome.failure !== null) {
    const { step, message, details, inspect } = outcome.failure;
    out.error(`setup stopped at ${step}: ${message}`, [
      ...details,
      `inspect: ${inspect}`,
      "run the same command again to resume: the steps already done are skipped",
    ]);
    // Its hash is on the machine already: lost now, it could only be replaced.
    showSecrets(deps);
    return 1;
  }

  const ran = outcome.reports.filter((report) => report.status === "ok").map((report) => report.step);
  const already = outcome.reports.filter((report) => report.status === "done").map((report) => report.step);
  const skipped = outcome.reports.filter((report) => report.status === "skip").map((report) => report.step);
  const dashboard = `https://dashboard.${options.zone}`;
  const portal = `https://portal.${options.zone}`;
  const environmentPrefix = privateFolder(deps.home, {}) === folder ? "" : `${CONFIG_DIR_VARIABLE}=${folder} `;
  const next = [
    `cd <your project> && ${environmentPrefix}sitesolide deploy`,
    "the monitor's heartbeat, five minutes: monitor/README.md, \"Alerting: healthchecks.io in five minutes\"",
    ...(options.minimal ? ["backups, the team installer and the egress proxy were left out: run setup again without --minimal"] : []),
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
    "                    the shared password of the sites behind the portal",
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

function sshMachine(host: string, environment: Record<string, string>, output: SetupOutput): Machine {
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
 * components, the one place setup names it. Today the kit's own folder. A
 * deploy writes into the folder it runs in, the build's output and a manifest
 * the machine corrects, and a compiled binary's kit is read only: integrated
 * there, this points at a writable copy, and nothing else in setup changes.
 */
export function componentFolder(name: "dashboard" | "portal"): string {
  return join(kitRoot(), name);
}

/**
 * This CLI, run again as a child: `sitesolide deploy` for a component. Bun on
 * the kit's own entry point today; a compiled binary runs itself.
 */
export function selfCommand(...arguments_: string[]): string[] {
  return ["bun", join(kitRoot(), "bin", "sitesolide.ts"), ...arguments_];
}

/**
 * The scripts of bin/ and `sitesolide deploy`, found through the kit. In human
 * mode they write to the terminal as they always do; under --json their lines
 * become `output` events. The dashboard's password goes to standard error in
 * both, never through an event.
 */
function kitRunner(output: SetupOutput): KitRunner {
  return async (task, environment) => {
    const root = kitRoot();
    const command = task.kind === "script" ? ["bash", join(root, "bin", task.name), ...task.args] : selfCommand("deploy");
    const quiet = task.kind === "script" && task.quiet === true;
    const toTerminal = !output.json && !quiet;
    const proc = Bun.spawn(command, {
      cwd: task.kind === "deploy" ? componentFolder(task.folder) : root,
      env: environment,
      stdin: output.json ? "ignore" : "inherit",
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
  return `${`[${report.status}]`.padEnd(7)}${report.title.padEnd(36)}${report.detail ?? ""}`.trimEnd();
}

export function setupOutput(json: boolean, write: (line: string) => void = (line) => console.log(line)): SetupOutput {
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
      if (json) emit({ type: "result", ok: true, command: "setup", ...fields });
    },
  };
}

/** `sitesolide setup ...`, from the command line: the exit code. */
export async function setupCommand(arguments_: readonly string[]): Promise<number> {
  const parsed = parseSetupArguments(arguments_);
  const json = arguments_.includes("--json");
  const output = setupOutput(json);
  if ("message" in parsed) {
    output.error(parsed.message, parsed.details);
    return 1;
  }
  const options = parsed;
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
    cloudflare: { base: cloudflareBase(environment) },
    token: async (ask) => {
      const fromEnvironment = environment.CLOUDFLARE_API_TOKEN?.trim();
      if (fromEnvironment !== undefined && fromEnvironment !== "") return fromEnvironment;
      if (piped !== null && piped !== "") return piped;
      if (!ask || json || process.stdin.isTTY !== true) return null;
      return (await readHidden(`Cloudflare API token for ${options.zone} (Zone / DNS / Edit), not echoed: `)).trim() || null;
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
