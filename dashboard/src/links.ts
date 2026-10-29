/**
 * Who talks to whom on the loopback: the connections the collector saw open,
 * each counted under the unit of the process that opened it and the port it
 * reaches, then remembered across readings for a while.
 *
 * Pure, as src/state.ts is: the collector hands in what `ss` printed and the
 * cgroup of each process, and this module decides what they say. A rule that
 * changes here is fixed by an ordinary deployment, without touching what runs
 * as root.
 *
 * Why the loopback alone: every service of a project listens on 127.0.0.1,
 * Caddy reaches it there, its siblings call it there, and the egress proxy
 * waits there on 3128 and 3129. What leaves the machine goes through the
 * proxy, or, for a project with `"network": "outbound"`, to addresses that
 * name no host; neither says more than the proxy's own port does.
 */

/** A connection seen open, as the page will read it, before it is put under a site. */
export type RawLink = {
  /**
   * The unit of the process that opened it, `playground.api.service`,
   * `caddy.service`; null when the process belongs to no service, a login
   * session's shell, or could not be named.
   */
  from: string | null;
  /** The loopback port it reaches, one that listens there. */
  port: number;
  /** How many were open at the last reading; 0 for one remembered from an earlier one. */
  open: number;
  /** When it was last seen open, in epoch milliseconds. */
  seen: number;
};

/** How long a link is remembered after it was last seen open: a weekly job's call still shows. */
export const LINK_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many links are kept: a reading with more is not a project's map any more. */
export const MAX_LINKS = 2000;

/** A unit's name as systemd writes one, bounded: what a link's `from` may hold. */
const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]{1,256}$/;

/** The hosts of the loopback, as `ss -n` prints them. */
function isLoopback(host: string): boolean {
  // A socket bound to a device carries it after a percent sign: 127.0.0.1%lo.
  const bare = host.replace(/%[^\]]*/, "");
  return bare === "127.0.0.1" || bare === "[::1]" || bare === "[::ffff:127.0.0.1]";
}

/** `127.0.0.1:3048` or `[::1]:3048`, cut at the last colon. */
function splitAddress(address: string): { host: string; port: number } | null {
  const colon = address.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = Number(address.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: address.slice(0, colon), port };
}

/**
 * The client ends of the established connections that reach a port listening
 * on the loopback, with the process that holds each: what
 * `ss -tnpH state established` printed.
 *
 * Each connection on the loopback shows twice, once from each end. The
 * client's end is the one whose peer is a listening port; the server's has an
 * ephemeral port for its peer, which listens on nothing.
 *
 * The process is the last `pid=` of the line. The name before it in quotes is
 * the program's own, which it chooses: one named `x",pid=1,fd=3),("y` would
 * put a `pid=1` ahead of its own, never after it, since ss writes the real
 * pid after the name it prints. Several processes sharing a socket, a forked
 * server's, are one service's, and the last stands for them.
 */
export function readEstablished(output: string, listening: ReadonlySet<number>): { pid: number | null; port: number }[] {
  const found: { pid: number | null; port: number }[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    // A filter on one state leaves the State column out; without one, it comes first.
    const offset = /^\d+$/.test(columns[0]!) ? 0 : 1;
    const local = splitAddress(columns[offset + 2] ?? "");
    const peer = splitAddress(columns[offset + 3] ?? "");
    if (local === null || peer === null) continue;
    if (!isLoopback(local.host) || !isLoopback(peer.host) || !listening.has(peer.port)) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)];
    const last = pids.length === 0 ? null : Number(pids[pids.length - 1]![1]);
    found.push({ pid: last !== null && Number.isSafeInteger(last) ? last : null, port: peer.port });
  }
  return found;
}

/**
 * The service a process runs under, from its `/proc/<pid>/cgroup`:
 * `0::/system.slice/playground.api.service` gives `playground.api.service`.
 * The innermost `.service` of the path, a service's sub-group included; null
 * for a process in a scope, a login session's, or in no service at all.
 */
export function unitOfCgroup(content: string): string | null {
  for (const line of content.split("\n")) {
    // The unified hierarchy's line, `0::<path>`; a legacy one carries a controller between the colons.
    const match = /^0::(.*)$/.exec(line.trim());
    if (match === null) continue;
    const segments = match[1]!.split("/").filter((segment) => segment !== "");
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index]!;
      if (segment.endsWith(".service") && UNIT_NAME.test(segment)) return segment;
    }
    return null;
  }
  return null;
}

/**
 * The connections seen at this reading, counted by the unit that opened them
 * and the port they reach. `unitOf` names a process's unit, null when it has
 * none or is gone; it is asked once per process.
 */
export function countLinks(
  ends: readonly { pid: number | null; port: number }[],
  unitOf: (pid: number) => string | null,
  now: number,
): RawLink[] {
  const units = new Map<number, string | null>();
  const counts = new Map<string, RawLink>();
  for (const end of ends) {
    let from: string | null = null;
    if (end.pid !== null) {
      if (!units.has(end.pid)) units.set(end.pid, unitOf(end.pid));
      from = units.get(end.pid) ?? null;
    }
    const key = `${from ?? ""}>${end.port}`;
    const link = counts.get(key);
    if (link === undefined) counts.set(key, { from, port: end.port, open: 1, seen: now });
    else link.open += 1;
  }
  return [...counts.values()];
}

/** A link read back from the previous reading, which another account's directory holds: its shape checked, its values bounded. */
function isRawLink(value: unknown): value is RawLink {
  if (typeof value !== "object" || value === null) return false;
  const link = value as Record<string, unknown>;
  return (
    (link.from === null || (typeof link.from === "string" && UNIT_NAME.test(link.from))) &&
    typeof link.port === "number" &&
    Number.isInteger(link.port) &&
    link.port > 0 &&
    link.port <= 65535 &&
    typeof link.open === "number" &&
    Number.isInteger(link.open) &&
    link.open >= 0 &&
    typeof link.seen === "number" &&
    Number.isFinite(link.seen)
  );
}

/**
 * The links to keep: those seen now, then those of the previous reading not
 * seen now, closed, for as long as `LINK_MEMORY_MS` after they were last
 * seen. A connection kept open, a database's pool, is seen at every reading;
 * a short call, between two of them, is seen when a reading falls on it, and
 * remembered from then on. A previous link from the future, or malformed, is
 * dropped: that file sits in the dashboard's own directory.
 */
export function rememberLinks(current: readonly RawLink[], previous: unknown, now: number): RawLink[] {
  const kept = new Map<string, RawLink>();
  for (const link of current) kept.set(`${link.from ?? ""}>${link.port}`, link);
  if (Array.isArray(previous)) {
    for (const link of previous) {
      if (!isRawLink(link)) continue;
      if (link.seen > now || now - link.seen > LINK_MEMORY_MS) continue;
      const key = `${link.from ?? ""}>${link.port}`;
      if (!kept.has(key)) kept.set(key, { from: link.from, port: link.port, open: 0, seen: link.seen });
    }
  }
  return [...kept.values()].sort((a, b) => b.seen - a.seen).slice(0, MAX_LINKS);
}
