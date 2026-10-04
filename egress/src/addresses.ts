/**
 * What an address is, and whether the proxy may connect to it.
 *
 * A host on a project's list can still resolve to an address inside the
 * machine or its network: a DNS record anyone controls can point
 * `api.example.com` at 127.0.0.1, at the cloud's metadata service, which hands
 * out the machine's credentials, or at a neighbour on the private network.
 * That is server-side request forgery, and the allowlist of names does nothing
 * against it. Only the address the name resolves to can be judged, and the
 * proxy judges every one of them before connecting, then connects to the one it
 * judged.
 *
 * The rule is an allowlist too: an IPv4 address outside the special-purpose
 * blocks, an IPv6 address inside global unicast (2000::/3) and outside its
 * special blocks. An address that embeds an IPv4 one, mapped, NAT64 or 6to4,
 * is judged by what it embeds: `::ffff:127.0.0.1` is the loopback.
 *
 * Pure: parses text, returns a verdict.
 */

/** Four bytes, or eight 16-bit groups. */
export type ParsedAddress = { family: 4; bytes: number[] } | { family: 6; groups: number[] };

/** A dotted IPv4 address with exactly four decimal parts, no leading zero. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * An IPv6 address in any of its textual forms: compressed, full, with an IPv4
 * tail. A zone (`fe80::1%eth0`) is refused: nothing the proxy connects to has
 * one.
 */
export function parseIPv6(text: string): number[] | null {
  if (text.length === 0 || text.length > 45 || text.includes("%")) return null;
  let head = text;
  const tail: number[] = [];
  // An IPv4 tail fills the last two groups.
  const lastColon = head.lastIndexOf(":");
  if (lastColon !== -1 && head.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(head.slice(lastColon + 1));
    if (v4 === null) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    head = head.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`, `::ffff:1.2.3.4` leaves `::ffff:`: the colon
    // kept is the one before the tail, dropped unless it belongs to a `::`.
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const left = read(halves[0]!);
  const right = halves.length === 2 ? read(halves[1]!) : [];
  if (left === null || right === null) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 1) return known === 8 ? [...left, ...tail] : null;
  if (known > 7) return null;
  return [...left, ...Array<number>(8 - known).fill(0), ...right, ...tail];
}

export function parseAddress(text: string): ParsedAddress | null {
  const v4 = parseIPv4(text);
  if (v4 !== null) return { family: 4, bytes: v4 };
  const v6 = parseIPv6(text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text);
  return v6 === null ? null : { family: 6, groups: v6 };
}

/**
 * One spelling per address, so that two readings of the same socket compare
 * equal: dotted for IPv4 and for an IPv4-mapped IPv6 address, which is how a
 * dual-stack listener sees an IPv4 client, and eight lowercase groups without
 * compression otherwise.
 */
export function canonicalAddress(text: string): string | null {
  const parsed = parseAddress(text);
  if (parsed === null) return null;
  if (parsed.family === 4) return parsed.bytes.join(".");
  const g = parsed.groups;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff].join(".");
  }
  return g.map((x) => x.toString(16)).join(":");
}

/** An IPv4 block: its first address as a number, and its prefix length. */
type Block = { start: number; prefix: number; reason: string };

function v4Number(bytes: number[]): number {
  return ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
}

function block(cidr: string, reason: string): Block {
  const [address = "", prefix = "32"] = cidr.split("/");
  return { start: v4Number(parseIPv4(address)!), prefix: Number(prefix), reason };
}

/**
 * Cloud metadata services, named apart from their block so that a refusal
 * says what was really aimed at: AWS, GCP, Azure, Hetzner, DigitalOcean and
 * OpenStack at 169.254.169.254, Alibaba at 100.100.100.200, AWS over IPv6 at
 * fd00:ec2::254. Their blocks are refused anyway.
 */
const METADATA_V4 = ["169.254.169.254", "100.100.100.200"];
const METADATA_V6 = ["fd00:ec2:0:0:0:0:0:254"];

/**
 * The IPv4 special-purpose blocks of the IANA registry that are not globally
 * reachable, plus multicast and the reserved space. Order matters only for the
 * reason given: the most specific first.
 */
const V4_BLOCKS: readonly Block[] = [
  block("0.0.0.0/8", "unspecified"),
  block("10.0.0.0/8", "private"),
  block("100.64.0.0/10", "shared address space (CGNAT)"),
  block("127.0.0.0/8", "loopback"),
  block("169.254.0.0/16", "link-local"),
  block("172.16.0.0/12", "private"),
  block("192.0.0.0/24", "reserved for protocol assignments"),
  block("192.0.2.0/24", "documentation"),
  block("192.88.99.0/24", "reserved (6to4 relay)"),
  block("192.168.0.0/16", "private"),
  block("198.18.0.0/15", "benchmarking"),
  block("198.51.100.0/24", "documentation"),
  block("203.0.113.0/24", "documentation"),
  block("224.0.0.0/4", "multicast"),
  block("240.0.0.0/4", "reserved"),
];

function classifyV4(bytes: number[]): string | null {
  const text = bytes.join(".");
  if (METADATA_V4.includes(text)) return "cloud metadata";
  const value = v4Number(bytes);
  for (const { start, prefix, reason } of V4_BLOCKS) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if (((value & mask) >>> 0) === start) return reason;
  }
  return null;
}

/** Does the IPv6 address start with these bits? `bits` counts from the left. */
function startsWith(groups: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((groups[i]! & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function embeddedV4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function classifyV6(g: number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (METADATA_V6.includes(g.map((x) => x.toString(16)).join(":"))) return "cloud metadata";
  // ::ffff:a.b.c.d, what a dual-stack socket makes of an IPv4 address.
  if (startsWith(g, [0, 0, 0, 0, 0, 0xffff], 96)) {
    const reason = classifyV4(embeddedV4(g[6]!, g[7]!));
    return reason === null ? null : `${reason} (IPv4-mapped)`;
  }
  // 64:ff9b::/96, NAT64: a gateway would carry it to the IPv4 it embeds.
  if (startsWith(g, [0x64, 0xff9b, 0, 0, 0, 0], 96)) {
    const reason = classifyV4(embeddedV4(g[6]!, g[7]!));
    return reason === null ? null : `${reason} (NAT64)`;
  }
  if (startsWith(g, [0xfc00], 7)) return "unique local";
  if (startsWith(g, [0xfe80], 10)) return "link-local";
  if (startsWith(g, [0xfec0], 10)) return "site-local";
  if (startsWith(g, [0xff00], 8)) return "multicast";
  // Outside global unicast, everything is reserved or local: the IPv4
  // compatible ::/96, discard-only 100::/64, local NAT64 64:ff9b:1::/48...
  if (!startsWith(g, [0x2000], 3)) return "not a global address";
  // Inside it, the blocks that are not globally reachable.
  if (startsWith(g, [0x2001, 0x0db8], 32)) return "documentation";
  if (startsWith(g, [0x3fff], 20)) return "documentation";
  // Teredo, ORCHID and the other protocol assignments of 2001::/23.
  if (startsWith(g, [0x2001], 23)) return "reserved for protocol assignments";
  // 6to4 carries an IPv4 address in its second and third groups.
  if (startsWith(g, [0x2002], 16)) {
    const reason = classifyV4(embeddedV4(g[1]!, g[2]!));
    return reason === null ? null : `${reason} (6to4)`;
  }
  return null;
}

/**
 * Why the proxy must not connect to this address, or null when it may. A text
 * that is not an address is refused too: nothing should reach here that a
 * resolver did not return.
 */
export function forbiddenReason(address: string): string | null {
  const parsed = parseAddress(address);
  if (parsed === null) return "not an address";
  return parsed.family === 4 ? classifyV4(parsed.bytes) : classifyV6(parsed.groups);
}

/** The address as a URL writes it: brackets around IPv6. */
export function urlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}
