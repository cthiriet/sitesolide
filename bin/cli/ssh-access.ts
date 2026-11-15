/**
 * Who may open an ssh connection to the machine: everyone, by default, or only
 * the networks of `--ssh-from` and the interfaces of `--ssh-interface`
 * (`tailscale0` for a tailnet). The same restriction is written into ufw by
 * setup and upgrade, and into the provider's firewall by `sitesolide machine`.
 *
 * Since deployments go through a token, ssh only serves the machine's own
 * administration: setup, upgrade, refresh, the owner's commands and the
 * passkey link. Nothing of a visitor's or a deployment's path needs port 22
 * open to the world, and every daemon reachable from the Internet is one more
 * that an unpatched flaw opens (see docs/ssh.md).
 *
 * NEVER WIDER BY ITSELF. The choice is recorded in the workstation's
 * configuration, `sshFrom` and `sshInterface`, and a later run without the
 * options reads it back. A run that has no restriction to apply still never
 * reopens what a restriction closed: the firewall step is done as soon as any
 * rule lets ssh in, and only `--ssh-public` asks for the port open to all.
 *
 * NO LOCKOUT. Public ssh is closed only once the connection the run itself
 * holds is proven to arrive by the path that stays open: its client address
 * inside one of the networks, or its local address on one of the interfaces,
 * read from $SSH_CONNECTION on the machine. A run connected over the public
 * address with `--ssh-interface tailscale0` is refused before anything
 * changes: connect through the tailnet first, then run it again. ufw keeps
 * established connections, so the session that closes the port survives it.
 *
 * Every value here ends up in a shell script: only what these parsers accept,
 * normalised, is ever written into one.
 */
import { isIP } from "node:net";
import type { Condition } from "./steps";

/** The networks and interfaces ssh is open on; both empty means everywhere. */
export type SshAccess = { from: readonly string[]; interfaces: readonly string[] };

export const PUBLIC_SSH: SshAccess = { from: [], interfaces: [] };

/** The configuration's keys, as `sitesolide setup` writes them. */
export const ACCESS_KEYS = { from: "sshFrom", interfaces: "sshInterface" } as const;

export function isPublic(access: SshAccess): boolean {
  return access.from.length === 0 && access.interfaces.length === 0;
}

/** `ssh from 203.0.113.0/24 and on tailscale0`, or `ssh from everywhere`. */
export function describeAccess(access: SshAccess): string {
  if (isPublic(access)) return "ssh from everywhere";
  const parts = [...(access.from.length === 0 ? [] : [`from ${access.from.join(", ")}`]), ...(access.interfaces.length === 0 ? [] : [`on ${access.interfaces.join(", ")}`])];
  return `ssh ${parts.join(" and ")} only`;
}

// --- addresses and networks ----------------------------------------------------------

/** An address as a number, with its width in bits; null when it is none. */
function addressBits(address: string): { value: bigint; bits: 32 | 128 } | null {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    return { value: parts.reduce((total, part) => (total << 8n) | BigInt(part), 0n), bits: 32 };
  }
  if (family !== 6 || address.includes(".")) return null;
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  return { value: groups.reduce((total, group) => (total << 16n) | BigInt(Number.parseInt(group, 16)), 0n), bits: 128 };
}

/** An IPv6 address as RFC 5952 writes it, the form ufw shows: lowercase, the longest run of zeros compressed. */
function ipv6Text(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(16 * (7 - index))) & 0xffffn));
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; start++) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0) length++;
    if (length > best.length && length >= 2) best = { start, length };
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.start === -1) return hex.join(":");
  return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.length).join(":")}`;
}

function ipv4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/**
 * A network, `203.0.113.0/24`, `2001:db8::/32`, or one address standing for
 * its /32 or /128, normalised; a problem when it is not one. A network with
 * host bits set is refused rather than silently widened or narrowed: what is
 * typed is what the firewall opens.
 */
export function parseNetwork(text: string): { network: string } | { problem: string } {
  const [address = "", prefixText, extra] = text.trim().split("/");
  if (extra !== undefined) return { problem: "one slash at most" };
  const parsed = addressBits(address);
  if (parsed === null) return { problem: "not an IPv4 or IPv6 address" };
  const prefix = prefixText === undefined ? parsed.bits : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) return { problem: `the prefix must be 0 to ${parsed.bits}` };
  if (prefix === 0) return { problem: "a /0 is everywhere: --ssh-public says that" };
  const hostBits = BigInt(parsed.bits - prefix);
  const mask = (1n << hostBits) - 1n;
  const network = parsed.value & ~mask;
  const shown = parsed.bits === 32 ? ipv4Text(network) : ipv6Text(network);
  if ((parsed.value & mask) !== 0n) return { problem: `host bits set: the network is ${shown}/${prefix}` };
  return { network: `${shown}/${prefix}` };
}

/** Whether an address lies inside a network parseNetwork accepted. */
export function inNetwork(address: string, network: string): boolean {
  const [base = "", prefixText = ""] = network.split("/");
  const a = addressBits(address);
  const n = addressBits(base);
  if (a === null || n === null || a.bits !== n.bits) return false;
  const hostBits = BigInt(a.bits - Number(prefixText));
  return a.value >> hostBits === n.value >> hostBits;
}

/** The networks of `--ssh-from`, comma separated, each normalised. */
export function parseNetworks(text: string): { networks: string[] } | { problem: string } {
  const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) return { problem: "no network given" };
  if (items.length > 20) return { problem: "twenty networks at most" };
  const networks: string[] = [];
  for (const item of items) {
    const parsed = parseNetwork(item);
    if ("problem" in parsed) return { problem: `${/^[0-9a-fA-F.:/]{1,60}$/.test(item) ? item : "(not shown)"}: ${parsed.problem}` };
    if (!networks.includes(parsed.network)) networks.push(parsed.network);
  }
  return { networks };
}

/** An interface name as Linux takes them: fifteen characters, no slash, no space. */
export const INTERFACE = /^[A-Za-z][A-Za-z0-9_.-]{0,14}$/;

export function parseInterfaces(text: string): { interfaces: string[] } | { problem: string } {
  const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) return { problem: "no interface given" };
  const wrong = items.find((item) => !INTERFACE.test(item));
  if (wrong !== undefined) return { problem: `not an interface name: ${/^[A-Za-z0-9_.-]{1,30}$/.test(wrong) ? wrong : "(not shown)"}` };
  return { interfaces: [...new Set(items)] };
}

/**
 * What the configuration records, read back. A value the parsers refuse is a
 * problem, never a reason to fall back to public ssh: the configuration was
 * edited by hand, and its owner meant something.
 */
export function accessFromConfig(file: Record<string, unknown>): SshAccess | { problem: string } {
  const from = file[ACCESS_KEYS.from];
  const interfaces = file[ACCESS_KEYS.interfaces];
  let networks: string[] = [];
  let names: string[] = [];
  if (from !== undefined) {
    const parsed = typeof from === "string" ? parseNetworks(from) : { problem: "not a string" };
    if ("problem" in parsed) return { problem: `${ACCESS_KEYS.from} in the configuration: ${parsed.problem}` };
    networks = parsed.networks;
  }
  if (interfaces !== undefined) {
    const parsed = typeof interfaces === "string" ? parseInterfaces(interfaces) : { problem: "not a string" };
    if ("problem" in parsed) return { problem: `${ACCESS_KEYS.interfaces} in the configuration: ${parsed.problem}` };
    names = parsed.interfaces;
  }
  return { from: networks, interfaces: names };
}

/** The configuration's keys for an access, absent for public ssh. */
export function accessToConfig(access: SshAccess): Partial<Record<"sshFrom" | "sshInterface", string>> {
  return {
    ...(access.from.length === 0 ? {} : { sshFrom: access.from.join(",") }),
    ...(access.interfaces.length === 0 ? {} : { sshInterface: access.interfaces.join(",") }),
  };
}

export function sameAccess(a: SshAccess, b: SshAccess): boolean {
  const key = (access: SshAccess) => `${[...access.from].sort().join(",")} ${[...access.interfaces].sort().join(",")}`;
  return key(a) === key(b);
}

// --- the connection the run holds ------------------------------------------------------

/**
 * The connection a command arrived by, as the machine sees it: the client's
 * address, the machine's own address and port it reached, and the interface
 * that address is on. Read from $SSH_CONNECTION, which sshd sets.
 */
export type SshConnection = { client: string | null; local: string | null; port: number | null; device: string | null };

/** Read only: what the machine says of the connection running it. */
export function connectionScript(tag = "ssh:connection:read"): string {
  return [
    `# sitesolide ${tag}`,
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    'echo "ssh=${SSH_CONNECTION:-}"',
    "local_address=$(printf '%s\\n' \"${SSH_CONNECTION:-}\" | cut -d' ' -f3)",
    // `ip -o addr` writes one address a line: index, interface, family, address/prefix.
    "echo \"sshdev=$(ip -o addr show 2>/dev/null | awk -v a=\"$local_address\" '{ split($4, p, \"/\"); if (p[1] == a) { print $2; exit } }')\"",
    'echo "end=connection"',
    "",
  ].join("\n");
}

/** What connectionScript printed, or the same two lines inside the preflight's output. */
export function readConnection(output: string): SshConnection {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const equal = line.indexOf("=");
    if (equal > 0) values.set(line.slice(0, equal), line.slice(equal + 1).trim());
  }
  const [client = "", , local = "", portText = ""] = (values.get("ssh") ?? "").split(" ");
  const port = Number(portText);
  const device = values.get("sshdev") ?? "";
  return {
    client: isIP(client) === 0 ? null : client,
    local: isIP(local) === 0 ? null : local,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    device: INTERFACE.test(device) ? device : null,
  };
}

/**
 * Why this connection does not prove that ssh stays reachable once only the
 * access is open, or null when it does: its client inside one of the
 * networks, or its local address on one of the interfaces.
 */
export function accessProblem(access: SshAccess, connection: SshConnection): string | null {
  if (isPublic(access)) return null;
  if (connection.client !== null && access.from.some((network) => inNetwork(connection.client!, network))) return null;
  if (connection.device !== null && access.interfaces.includes(connection.device)) return null;
  const seen = `this connection comes from ${connection.client ?? "an address the machine did not say"}${connection.device === null ? "" : ` on ${connection.device}`}`;
  return `${seen}, which ${describeAccess(access)} would refuse`;
}

/** What to tell whoever is refused by accessProblem. */
export function accessAdvice(access: SshAccess): string[] {
  return [
    "nothing was changed: public ssh is closed only by a run that already arrives by the path that stays open",
    ...(access.interfaces.length === 0
      ? ["run it from an address inside the networks given, or widen them"]
      : [`connect through ${access.interfaces.join(" or ")} first: the server in the configuration set to the machine's tailnet name or address, then run it again`]),
    "see docs/ssh.md",
  ];
}

// --- ufw ---------------------------------------------------------------------------------

/** A network as `ufw status` shows it: a /32 or /128 as its bare address. */
export function ufwShown(network: string): string {
  const host = network.includes(":") ? "/128" : "/32";
  return network.endsWith(host) ? network.slice(0, -host.length) : network;
}

/** A network or an interface as a check label may spell it: lowercase, its slash a dash. */
const labelOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9:.-]/g, "-");

const escape = (text: string) => text.replace(/[.[\]()*+?^$|\\]/g, "\\$&");

/** A rule of ufw letting anyone in on that port: `22/tcp ALLOW Anywhere`, its IPv6 twin, or Debian's OpenSSH profile. */
export function publicRuleTest(port: number): string {
  const what = port === 22 ? `(${port}(/tcp)?|OpenSSH)` : `${port}(/tcp)?`;
  return `ufw status | grep -Eq '^${what}( \\(v6\\))? +ALLOW( IN)? +Anywhere( \\(v6\\))? *$'`;
}

/** Any rule of ufw letting ssh in at all, restricted or not. */
export function anyRuleTest(port: number): string {
  const what = port === 22 ? `(${port}(/tcp)?|OpenSSH)` : `${port}(/tcp)?`;
  return `ufw status | grep -Eq '^${what}( \\(v6\\))?( on [A-Za-z0-9_.-]+)? +ALLOW'`;
}

function networkTest(port: number, network: string): string {
  return `ufw status | grep -Eq '^${port}/tcp( \\(v6\\))? +ALLOW( IN)? +${escape(ufwShown(network))}( |$)'`;
}

function interfaceTest(port: number, name: string): string {
  return `ufw status | grep -Eq '^${port}/tcp( \\(v6\\))? on ${escape(name)} +ALLOW'`;
}

/**
 * What the firewall must hold for ssh. Public: a rule letting ssh in, any,
 * so that a run without a restriction never reopens what one closed. Restricted:
 * each rule of the access, and no rule open to all.
 */
export function sshRuleConditions(port: number, access: SshAccess, reopen = false): Condition[] {
  if (reopen) return [{ label: `ufw-${port}-public`, test: publicRuleTest(port) }];
  if (isPublic(access)) return [{ label: `ufw-${port}`, test: anyRuleTest(port) }];
  return [
    ...access.from.map((network) => ({ label: `ufw-${port}-from-${labelOf(network)}`, test: networkTest(port, network) })),
    ...access.interfaces.map((name) => ({ label: `ufw-${port}-on-${labelOf(name)}`, test: interfaceTest(port, name) })),
    { label: `ufw-${port}-public-closed`, test: `! ${publicRuleTest(port)}` },
  ];
}

/**
 * The rules, in the order that cannot cut the run: the restricted ones first,
 * then the public ones deleted, IPv4 and IPv6 at once, under each spelling a
 * machine may carry. Public: the port opened to all only when no rule lets ssh
 * in, a fresh machine's case.
 */
export function sshRulesRun(port: number, access: SshAccess, reopen = false): string {
  if (reopen) return `ufw allow ${port}/tcp >/dev/null </dev/null`;
  if (isPublic(access)) return `${anyRuleTest(port)} || ufw allow ${port}/tcp >/dev/null </dev/null`;
  const spellings = [`${port}/tcp`, String(port), ...(port === 22 ? ["OpenSSH"] : [])];
  return [
    ...access.from.map((network) => `ufw allow from ${network} to any port ${port} proto tcp >/dev/null </dev/null`),
    ...access.interfaces.map((name) => `ufw allow in on ${name} to any port ${port} proto tcp >/dev/null </dev/null`),
    ...spellings.map((rule) => `ufw delete allow ${rule} >/dev/null 2>&1 </dev/null || true`),
  ].join("\n");
}

/** The provider firewall's sources for ssh: the networks, or everywhere. */
export function providerSources(access: SshAccess): string[] {
  return access.from.length === 0 ? ["0.0.0.0/0", "::/0"] : [...access.from];
}
