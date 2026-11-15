/**
 * What an app may reach outside the machine: the manifest's `egress` key, and
 * what it changes in the unit and in the deployment.
 *
 * `network` was binary until now: `localhost`, which cuts everything but the
 * loopback, or `outbound`, which opens everything. An app written by an agent
 * that needs one API had to be given the whole Internet. `egress` lists the
 * hosts it may reach instead: the unit keeps `IPAddressDeny=any`, so the
 * service still cannot leave on its own, and its HTTP clients are pointed at
 * the egress proxy on the loopback, which lets through the hosts of this list
 * and nothing else. See egress/README.md for the proxy and its threat model.
 *
 * Imported by bin/cli/manifest.ts and bin/cli/unit.ts, borrowed with them by
 * the dashboard, and embedded in the egress proxy's bundle: one rule for what
 * the CLI accepts and what the proxy lets through. Pure, and with no import
 * but a type, so that a flat copy in dashboard/borrowed/ still resolves.
 */
import type { Manifest } from "./manifest";

/** The proxy listens on the loopback only: the projects reach nothing else. */
export const EGRESS_ADDRESS = "127.0.0.1";

/**
 * CONNECT and plain HTTP forwarding, the port HTTPS_PROXY and HTTP_PROXY name.
 * 3128 is the port proxies have used for decades, which says what it is to
 * whoever reads `ss -ltn`.
 *
 * OUTSIDE THE SERVICES' BLOCKS ON PURPOSE, 3000 to 3099 and 21000 to 29999
 * (SERVICE_PORT_RANGES in bin/cli/manifest.ts). The loopback rule reserves
 * them to Caddy and root (bin/cli/loopback.ts): a port inside would be closed
 * to the very projects that need it. Nothing else of this repository listens
 * on 3128 or 3129; bin/deploy-egress.sh checks the machine before starting
 * anything.
 */
export const EGRESS_PROXY_PORT = 3128;

/**
 * The read-only routes the dashboard calls, GET /status and GET /audit,
 * answered to its account alone. A second port rather than origin-form
 * requests on the first: on 3128 the proxy pipes bytes it never reads, and two
 * ports keep a tunnel from ever being read as anything else. Both are raw
 * listeners counted against one admission, egress/src/admission.ts:
 * Bun.serve held whatever one project opened. Every generated unit refuses
 * both ports to its service (DENIED_BINDS in bin/cli/unit.ts).
 */
export const EGRESS_STATUS_PORT = 3129;

/** What a manifest may list. A longer list is no longer a decision anyone reads. */
export const MAX_EGRESS_ENTRIES = 64;

/** The unit `deploy` looks for before deploying a project that needs it. */
export const EGRESS_UNIT = "sitesolide-egress";

/**
 * The variables the unit sets for a project that declares `egress`, which its
 * own `env` may therefore not set. Both spellings of the proxy variables are
 * written, since clients disagree: curl reads only the lowercase
 * `http_proxy`, Go and Python read either.
 *
 * Both spellings are reserved for the same reason: systemd keeps the last
 * value of a variable set twice, and a lowercase `https_proxy` in `env` would
 * override the unit's for every client that reads that spelling. The manifest
 * refuses lowercase names in `env` anyway, for a rule of its own; this list
 * does not lean on it.
 */
export const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

/**
 * An entry of `egress`, read: an exact host or a wildcard over its
 * subdomains, and the port when the entry names one.
 */
export type HostPattern = { wildcard: boolean; host: string; port: number | null };

/**
 * Ports a pattern without one lets through: 443 for HTTPS, 80 for plain HTTP.
 * Any other port has to be written in the entry, `db.example.com:8443`.
 */
export const DEFAULT_PORTS: readonly number[] = [443, 80];

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A host name as the proxy compares it, or null if it is not a DNS name.
 *
 * Lowercase, without the final dot of a fully qualified name, and in its ASCII
 * form: `Bücher.Example.` and `xn--bcher-kva.example` are the same host, and a
 * client sends the second. The conversion is the URL parser's, the one every
 * HTTP client applies before sending.
 *
 * **Names, never addresses.** A last label made of digits, `127.0.0.1` or a
 * full-width `１２７.0.0.1` that the parser folds into it, is refused: an
 * allowlist of names is one an administrator can read, and an address there
 * would bypass the classification of resolved addresses.
 */
export function normalizeHost(raw: string): string | null {
  if (raw.length === 0 || raw.length > 253) return null;
  // What would make the URL parser read something else than a host: a path, a
  // userinfo, a port, a bracketed address, a space or an escape.
  if (/[\s/\\?#@:[\]%*]/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= 63 && LABEL.test(label))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return host;
}

/**
 * Reads an entry of `egress`: `api.example.com`, `*.slack.com`, or either with
 * a `:port`. Null when it is not one.
 *
 * A wildcard covers the subdomains, never the name itself: `*.slack.com`
 * matches `files.slack.com`, not `slack.com`, which is listed on its own when
 * it is wanted. It needs two labels after it, so that `*.com` cannot open a
 * whole top-level domain; a public suffix such as `co.uk` still passes, and
 * the README says so.
 */
export function parseEgressEntry(entry: unknown): HostPattern | null {
  if (typeof entry !== "string") return null;
  const match = /^(.+?)(?::([0-9]{1,5}))?$/.exec(entry);
  if (match === null) return null;
  const [, name = "", portText] = match;
  const port = portText === undefined ? null : Number(portText);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const wildcard = name.startsWith("*.");
  const host = normalizeHost(wildcard ? name.slice(2) : name);
  if (host === null) return null;
  if (wildcard && host.split(".").length < 2) return null;
  return { wildcard, host, port };
}

/** The entry as the proxy and the dashboard write it back. */
export function formatPattern(pattern: HostPattern): string {
  return `${pattern.wildcard ? "*." : ""}${pattern.host}${pattern.port === null ? "" : `:${pattern.port}`}`;
}

/**
 * Does this destination match one of the patterns? `host` is already
 * normalized, `port` the one the client asked for.
 */
export function matchesEgress(patterns: readonly HostPattern[], host: string, port: number): boolean {
  return patterns.some((pattern) => {
    const portAllowed = pattern.port === null ? DEFAULT_PORTS.includes(port) : pattern.port === port;
    if (!portAllowed) return false;
    return pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host;
  });
}

/** Does the project list hosts to reach through the proxy? */
export function declaresEgress(manifest: Manifest): boolean {
  return Array.isArray(manifest.egress) && manifest.egress.length > 0;
}

/** The patterns of a valid manifest, the invalid entries left out. */
export function egressPatterns(manifest: Manifest): HostPattern[] {
  if (!Array.isArray(manifest.egress)) return [];
  return manifest.egress.map(parseEgressEntry).filter((pattern): pattern is HostPattern => pattern !== null);
}

/**
 * The refusals of `egress`, for validate(). `isApplication` is passed rather
 * than recomputed: this module imports nothing from the manifest's, which
 * imports it.
 */
export function egressErrors(manifest: Manifest, isApplication: boolean): string[] {
  const errors: string[] = [];
  if (manifest.egress === undefined) return errors;

  const entries = manifest.egress as unknown;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('egress: a non-empty list of hosts, such as ["api.example.com", "*.slack.com"]');
  } else {
    if (entries.length > MAX_EGRESS_ENTRIES) errors.push(`egress: ${MAX_EGRESS_ENTRIES} hosts at most`);
    const seen = new Set<string>();
    for (const entry of entries) {
      const pattern = parseEgressEntry(entry);
      if (pattern === null) {
        errors.push(
          `egress: "${String(entry)}" must be a host name such as api.example.com or *.example.com, optionally with :port, never an address`,
        );
        continue;
      }
      const written = formatPattern(pattern);
      if (seen.has(written)) errors.push(`egress: ${written} is listed twice`);
      seen.add(written);
    }
  }
  // Both together would read as a restriction while the unit opens
  // everything: `outbound` lifts IPAddressDeny, and the proxy is then one
  // way out among all the others.
  if (manifest.network === "outbound") {
    errors.push("egress: network outbound already reaches every host; keep egress and drop network, or the reverse");
  }
  if (!isApplication) errors.push("egress: without `start`, nothing runs to reach anything");

  const declared = [
    ...Object.keys(manifest.env ?? {}),
    ...Object.values(manifest.services ?? {}).flatMap((service) =>
      typeof service === "object" && service !== null ? Object.keys(service.env ?? {}) : [],
    ),
  ];
  for (const name of new Set(declared)) {
    if (PROXY_VARIABLES.includes(name)) {
      errors.push(`env: ${name} is set by the deployment for egress, and cannot be redefined`);
    }
  }
  return errors;
}

/**
 * The lines the unit gains for a project that declares `egress`, comments
 * included. None for any other project: its unit stays byte for byte what it
 * was, and the units in service are not reported as diverging on the next
 * deployment.
 */
export function egressUnitLines(manifest: Manifest): string[] {
  const lines: string[] = [];
  if (declaresEgress(manifest)) {
    lines.push(
      "",
      "# egress: the service still reaches only the loopback (see IPAddressDeny",
      "# below); its HTTP clients go through the egress proxy, which lets through",
      "# the hosts its sitesolide.json lists and refuses the rest. curl reads the",
      "# lowercase spelling, Go and Python either, Bun's fetch both; Node's fetch",
      "# reads neither by default. See egress/README.md.",
      ...proxyVariables().map(([name, value]) => `Environment=${name}=${value}`),
    );
  }
  return lines;
}

// --- The deployment's check ------------------------------------------------

/** The last line of the read, so that an empty output is never taken for an answer. */
export const EGRESS_MARKER = "DONE";

/**
 * Where the egress proxy stands on the machine. `systemctl is-active` needs no
 * privilege, and the unit file is readable by everyone.
 */
export function egressStateCommand(): string {
  return (
    `sh -c 'if systemctl is-active --quiet ${EGRESS_UNIT}.service; then echo active; ` +
    `elif [ -f /etc/systemd/system/${EGRESS_UNIT}.service ]; then echo inactive; else echo absent; fi; ` +
    `echo ${EGRESS_MARKER}'`
  );
}

export type EgressState = "active" | "inactive" | "absent" | "unreadable";

export function readEgressState(output: string): EgressState {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 2 || lines[1] !== EGRESS_MARKER) return "unreadable";
  const state = lines[0];
  return state === "active" || state === "inactive" || state === "absent" ? state : "unreadable";
}

// --- The addresses no project reaches -----------------------------------------

/**
 * What every generated unit with the network refuses, `outbound` included,
 * and every install: the cloud's metadata service and its link-local
 * neighbours (169.254.0.0/16 and fe80::/10, systemd's `link-local`),
 * multicast, 0.0.0.0/8, which Linux delivers to the loopback, and the ranges
 * a provider's private network and the hosts around the machine live in:
 * RFC 1918, the carrier-grade NAT range and the IPv6 unique local addresses,
 * AWS's IPv6 metadata address fd00:ec2::254 among them. The egress proxy's
 * unit refuses the same ranges, for the same reason.
 *
 * The resolver is the catch: a machine whose /etc/resolv.conf names an
 * address in one of these ranges, GCP's 169.254.169.254 or an AWS VPC's
 * resolver, resolves nothing for its projects. systemd-resolved's stub,
 * 127.0.0.53, passes, since resolved is the one that talks to the
 * provider, and a provider's public resolvers pass. See unreachableResolvers.
 */
export const PRIVATE_RANGES: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
];

/** PRIVATE_RANGES with systemd's own words for link-local and multicast, as a unit writes them. */
export const PRIVATE_DENY = ["link-local", "multicast", ...PRIVATE_RANGES].join(" ");

/**
 * The ranges `privateNetworks` may open again, the owner's decision: a
 * provider's private network, a database on another of its machines. Never
 * link-local, where the metadata service answers, nor the loopback, nor
 * multicast.
 */
const OPENABLE_RANGES = ["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

/** AWS's IPv6 metadata service, inside fc00::/7, which no entry may cover. */
const IPV6_METADATA = "fd00:ec2::254";

/** What a manifest may list. A private network is a few ranges, not a routing table. */
export const MAX_PRIVATE_NETWORKS = 16;

/** An address as bits: the family's width and its value. */
type Bits = { width: 32 | 128; value: bigint };

function ipv4Bits(text: string): Bits | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return { width: 32, value };
}

function ipv6Bits(text: string): Bits | null {
  if (!/^[0-9a-f:]+$/i.test(text) || text.length > 39) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  let value = 0n;
  for (const group of [...head, ...Array<string>(missing).fill("0"), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(`0x${group}`);
  }
  return { width: 128, value };
}

function addressBits(address: string): Bits | null {
  return address.includes(":") ? ipv6Bits(address) : ipv4Bits(address);
}

/** A range read: its network's bits and its prefix length. */
export type Range = { bits: Bits; prefix: number };

/**
 * `10.1.0.0/16` or `fd12:3456::/48`, read, or null. The prefix is required
 * and the address must be the network's own, host bits clear: `10.1.2.3/16`
 * is refused rather than read as something its author may not have meant.
 */
export function parseRange(text: unknown): Range | null {
  if (typeof text !== "string") return null;
  const match = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/.exec(text);
  if (match === null) return null;
  const bits = addressBits(match[1]!);
  if (bits === null) return null;
  const prefix = Number(match[2]);
  if (prefix > bits.width) return null;
  const host = (1n << BigInt(bits.width - prefix)) - 1n;
  if ((bits.value & host) !== 0n) return null;
  return { bits, prefix };
}

/** Whether `inner` lies wholly inside `outer`. */
function within(inner: Range, outer: Range): boolean {
  if (inner.bits.width !== outer.bits.width || inner.prefix < outer.prefix) return false;
  const shift = BigInt(outer.bits.width - outer.prefix);
  return inner.bits.value >> shift === outer.bits.value >> shift;
}

/** Whether an address, IPv4 or IPv6, lies in `range`. */
function holds(range: Range, address: string): boolean {
  const bits = addressBits(address);
  return bits !== null && within({ bits, prefix: bits.width }, range);
}

/** What PRIVATE_DENY refuses, its two words spelled out, and the loopback. */
const DENIED_RANGES = [...PRIVATE_RANGES, "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "::1/128", "fe80::/10", "ff00::/8"].map(
  (range) => parseRange(range)!,
);

/** Whether an address lies in what an install with the network refuses: PRIVATE_DENY and the loopback. */
export function isDeniedAddress(address: string): boolean {
  return DENIED_RANGES.some((range) => holds(range, address));
}

/**
 * The refusals of `privateNetworks`, for validate(): ranges among
 * PRIVATE_RANGES that a project with `"network": "outbound"` reaches again,
 * which only the owner of the machine deploys (scopeRefusals in
 * dashboard/src/control/policy.ts).
 */
export function privateNetworksErrors(manifest: Manifest, isApplication: boolean): string[] {
  const errors: string[] = [];
  if (manifest.privateNetworks === undefined) return errors;
  const entries = manifest.privateNetworks as unknown;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('privateNetworks: a non-empty list of ranges, such as ["10.0.1.0/24"]');
    return errors;
  }
  if (entries.length > MAX_PRIVATE_NETWORKS) errors.push(`privateNetworks: ${MAX_PRIVATE_NETWORKS} ranges at most`);
  const openable = OPENABLE_RANGES.map((range) => parseRange(range)!);
  const metadata = parseRange(`${IPV6_METADATA}/128`)!;
  const seen = new Set<string>();
  for (const entry of entries) {
    const range = parseRange(entry);
    if (range === null) {
      errors.push(`privateNetworks: "${String(entry)}" must be a range such as 10.0.1.0/24 or fd12:3456::/48, its address the network's own`);
      continue;
    }
    if (!openable.some((outer) => within(range, outer))) {
      errors.push(`privateNetworks: ${String(entry)} must lie inside ${OPENABLE_RANGES.join(", ")}; link-local, where the cloud's metadata service answers, never opens`);
    } else if (within(metadata, range)) {
      errors.push(`privateNetworks: ${String(entry)} covers ${IPV6_METADATA}, the cloud's metadata service`);
    }
    if (seen.has(String(entry))) errors.push(`privateNetworks: ${String(entry)} is listed twice`);
    seen.add(String(entry));
  }
  if (manifest.network !== "outbound") errors.push('privateNetworks: needs "network": "outbound", which it narrows');
  if (!isApplication) errors.push("privateNetworks: without `start`, nothing runs to reach anything");
  return errors;
}

/** systemd-resolved's stub resolver, which /etc/resolv.conf names when resolved runs. */
export const RESOLVED_STUB = "127.0.0.53";

/**
 * The nameservers of an /etc/resolv.conf that an install or an `outbound`
 * unit cannot reach, systemd-resolved's stub excepted: the installs allow
 * it, and the `outbound` units keep the loopback. A machine that lists one
 * resolves nothing for its projects; docs/upgrading.md says what to do.
 */
export function unreachableResolvers(resolvConf: string): string[] {
  return resolvConf
    .split("\n")
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1])
    .filter((server): server is string => server !== undefined)
    // An IPv6 zone, fe80::1%eth0, is not part of the address.
    .map((server) => server.replace(/%.*$/, ""))
    .filter((server) => server !== RESOLVED_STUB && isDeniedAddress(server));
}

// --- What an install reaches without the outbound permission --------------------

/**
 * The package registries a manifest's `install` reaches through the egress
 * proxy when the token that deploys it may not reach outside hosts: npm's
 * (Bun, npm, pnpm and Yarn read it), Yarn's mirror of it, PyPI's (pip, uv),
 * crates.io's, Go's module proxy and RubyGems. Nothing a git dependency or a
 * downloaded tool needs, github.com first: a token with the outbound
 * permission installs those. HTTPS alone.
 */
export const INSTALL_REGISTRIES: readonly string[] = [
  "registry.npmjs.org:443",
  "registry.yarnpkg.com:443",
  "pypi.org:443",
  "files.pythonhosted.org:443",
  "index.crates.io:443",
  "static.crates.io:443",
  "proxy.golang.org:443",
  "sum.golang.org:443",
  "rubygems.org:443",
  "index.rubygems.org:443",
];

/**
 * The file the installer lays, root's and 0644, in `/srv/sites/<slug>/` for
 * as long as an install runs through the proxy: while it is there and its
 * deadline has not passed, the proxy lets the project's account reach
 * INSTALL_REGISTRIES on top of its `egress`. The project's services share
 * the account and can reach them too for those minutes; the registries are
 * what the install fetches from, and nothing else opens.
 */
export const INSTALL_MARKER = ".installing";

/** How far past now a marker may run: the install's fifteen minutes, and a margin. */
export const INSTALL_MARKER_MAX_MS = 20 * 60 * 1000;

/** The marker's text: the moment after which it means nothing, in ms since the epoch. */
export function installMarkerText(until: number): string {
  return `${JSON.stringify({ until })}\n`;
}

/**
 * Whether a marker's text, read at `now`, still opens the registries. A
 * deadline past, unreadable or further than INSTALL_MARKER_MAX_MS opens
 * nothing: a marker an installer crash left behind closes by itself.
 */
export function installMarkerOpen(text: string, now: number): boolean {
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof marker !== "object" || marker === null) return false;
  const until = (marker as Record<string, unknown>).until;
  return typeof until === "number" && Number.isFinite(until) && until > now && until - now <= INSTALL_MARKER_MAX_MS;
}

/** The variables that point HTTP clients at the proxy, both spellings, and the loopback left direct. */
export function proxyVariables(): [string, string][] {
  const proxy = `http://${EGRESS_ADDRESS}:${EGRESS_PROXY_PORT}`;
  // localhost and the loopback addresses go direct: the services of one
  // project call each other there.
  const direct = `localhost,${EGRESS_ADDRESS},::1`;
  return [
    ["HTTPS_PROXY", proxy],
    ["https_proxy", proxy],
    ["HTTP_PROXY", proxy],
    ["http_proxy", proxy],
    ["NO_PROXY", direct],
    ["no_proxy", direct],
  ];
}
