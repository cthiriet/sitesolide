/**
 * Who is calling: the project that owns the other end of a loopback
 * connection, read from the kernel rather than from anything the caller sends.
 *
 * A token would have to be handed to every project, kept out of the unit,
 * which is world-readable, and rotated when it leaks. The kernel already knows
 * the answer: every TCP socket carries the uid of the account that created it,
 * and `/proc/net/tcp` and `/proc/net/tcp6` list them, local address, remote
 * address, state and uid. The proxy accepts a connection from
 * 127.0.0.1:<port>, finds the ESTABLISHED socket whose local end is that
 * address and whose remote end is the proxy itself, and reads its uid; the
 * account database turns the uid into `site-<slug>`, and the slug into a
 * project.
 *
 * **Nothing here can be forged by the caller.** The uid is the creator's,
 * set by the kernel; a project cannot open a socket in another account's
 * name, and the 4-tuple of a live connection cannot be taken by anyone else
 * while the proxy holds its end. **It fails closed**: no matching line, two
 * lines that disagree, a uid with no account, an account that is not a
 * project's, and the caller is nobody.
 *
 * It holds on this machine because every project runs in the host's network
 * namespace (the generated units set no PrivateNetwork), and because the
 * proxy's own unit does not hide /proc/net. Both are written down in
 * infra/egress/sitesolide-egress.service, which must not gain PrivateNetwork
 * or ProcSubset=pid.
 *
 * Pure apart from `readProcNet`: parses text, matches, decides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidSlug } from "../../bin/cli/manifest";
import { canonicalAddress } from "./addresses";

/** One line of /proc/net/tcp or tcp6. */
export type SocketLine = {
  local: string;
  localPort: number;
  remote: string;
  remotePort: number;
  /** The kernel's TCP state: 1 is ESTABLISHED. */
  state: number;
  uid: number;
};

export const TCP_ESTABLISHED = 1;

/**
 * Four bytes from the hexadecimal word the kernel prints. It prints the
 * address as the 32-bit integer the processor reads from memory, `%08X`: on a
 * little-endian machine, x86_64 and arm64, 127.0.0.1 comes out as 0100007F.
 */
function wordBytes(word: string, littleEndian: boolean): number[] | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(word)) return null;
  const n = parseInt(word, 16);
  const big = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return littleEndian ? big.reverse() : big;
}

/** The address of a line, `0100007F` or 32 hexadecimal digits, in canonical form. */
export function decodeAddress(hex: string, littleEndian = true): string | null {
  if (hex.length === 8) {
    const bytes = wordBytes(hex, littleEndian);
    return bytes === null ? null : bytes.join(".");
  }
  if (hex.length !== 32) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 32; i += 8) {
    const word = wordBytes(hex.slice(i, i + 8), littleEndian);
    if (word === null) return null;
    bytes.push(...word);
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return canonicalAddress(groups.join(":"));
}

function endpoint(field: string | undefined, littleEndian: boolean): { address: string; port: number } | null {
  if (field === undefined) return null;
  const [hex = "", portHex = ""] = field.split(":");
  if (!/^[0-9A-Fa-f]{4}$/.test(portHex)) return null;
  const address = decodeAddress(hex, littleEndian);
  return address === null ? null : { address, port: parseInt(portHex, 16) };
}

/**
 * The lines of /proc/net/tcp or tcp6. The header and any line that does not
 * read are skipped: a line the kernel adds a column to still reads, its first
 * columns do not move.
 *
 *   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
 *    0: 0100007F:0C38 00000000:0000 0A 00000000:00000000 00:00000000 00000000   998        0 41231 ...
 */
export function parseProcNet(text: string, littleEndian = true): SocketLine[] {
  const lines: SocketLine[] = [];
  for (const raw of text.split("\n")) {
    const fields = raw.trim().split(/\s+/);
    if (!/^[0-9]+:$/.test(fields[0] ?? "")) continue;
    const local = endpoint(fields[1], littleEndian);
    const remote = endpoint(fields[2], littleEndian);
    const state = /^[0-9A-Fa-f]{2}$/.test(fields[3] ?? "") ? parseInt(fields[3]!, 16) : NaN;
    const uid = /^[0-9]+$/.test(fields[7] ?? "") ? Number(fields[7]) : NaN;
    if (local === null || remote === null || Number.isNaN(state) || Number.isNaN(uid)) continue;
    lines.push({ local: local.address, localPort: local.port, remote: remote.address, remotePort: remote.port, state, uid });
  }
  return lines;
}

/** A connection seen from the proxy: the caller's end, and the proxy's. */
export type Peer = { remoteAddress: string; remotePort: number; localAddress: string; localPort: number };

/**
 * The uid of the account that owns the caller's socket, or null.
 *
 * The caller's socket is the one whose local end is the peer's address and
 * whose remote end is the proxy's: the proxy's own accepted socket is the
 * mirror line, local and remote swapped, and carries the proxy's uid. Several
 * matching lines that disagree mean the reading cannot be trusted.
 */
export function socketOwner(lines: readonly SocketLine[], peer: Peer): number | null {
  const client = canonicalAddress(peer.remoteAddress);
  const server = canonicalAddress(peer.localAddress);
  if (client === null || server === null) return null;
  const owners = new Set<number>();
  for (const line of lines) {
    if (line.state !== TCP_ESTABLISHED) continue;
    if (line.local !== client || line.localPort !== peer.remotePort) continue;
    if (line.remote !== server || line.remotePort !== peer.localPort) continue;
    owners.add(line.uid);
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

/** The account name of a uid, in /etc/passwd format; null if absent or ambiguous. */
export function accountOf(passwd: string, uid: number): string | null {
  const names = new Set<string>();
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 4 || fields[2] !== String(uid)) continue;
    names.add(fields[0]!);
  }
  return names.size === 1 ? [...names][0]! : null;
}

/** The uid of an account, null if absent. */
export function uidOf(passwd: string, name: string): number | null {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name || fields.length < 4 || !/^[0-9]+$/.test(fields[2] ?? "")) continue;
    return Number(fields[2]);
  }
  return null;
}

/** The project of a system account: `site-<slug>`, the account deploy creates. */
export function slugOfAccount(name: string): string | null {
  if (!name.startsWith("site-")) return null;
  const slug = name.slice("site-".length);
  return isValidSlug(slug) ? slug : null;
}

/** Who is at the other end: a project, another account, or nobody that can be named. */
export type Caller =
  | { kind: "project"; slug: string; account: string }
  | { kind: "account"; account: string }
  | { kind: "unknown"; reason: string };

/** The account database and the socket tables, read from the machine. */
export type Readings = { passwd: () => string; procNet: () => string[] };

/**
 * The files themselves. readFileSync and not Bun.file: procfs announces a size
 * of zero bytes, and a reading that trusts it returns an empty string, the
 * trap dashboard/collector.ts measured on /proc/loadavg. A table that cannot
 * be read gives nothing, never a guess.
 */
export function machineReadings(procNet = "/proc/net", passwdFile = "/etc/passwd"): Readings {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    passwd: () => read(passwdFile),
    procNet: () => [read(join(procNet, "tcp")), read(join(procNet, "tcp6"))],
  };
}

/** Puts the readings together: the caller of a connection, failing closed at every step. */
export function identify(readings: Readings, peer: Peer, littleEndian = true): Caller {
  const lines = readings.procNet().flatMap((text) => parseProcNet(text, littleEndian));
  if (lines.length === 0) return { kind: "unknown", reason: "the socket tables could not be read" };
  const uid = socketOwner(lines, peer);
  if (uid === null) return { kind: "unknown", reason: "no single socket matches the connection" };
  const account = accountOf(readings.passwd(), uid);
  if (account === null) return { kind: "unknown", reason: `uid ${uid} has no account` };
  const slug = slugOfAccount(account);
  return slug === null ? { kind: "account", account } : { kind: "project", slug, account };
}

/** Is this machine little-endian? It decides how /proc/net prints addresses. */
export function hostIsLittleEndian(): boolean {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
}
