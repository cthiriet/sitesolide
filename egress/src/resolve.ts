/**
 * Resolving a host the proxy has agreed to, and judging where it really
 * points.
 *
 * **Every address is checked, and one bad address refuses the host.** A
 * resolver answer that mixes a public address with 127.0.0.1 is how a DNS
 * rebinding attack hides its second target; keeping the good one and dropping
 * the bad would still connect wherever the attacker's next answer points.
 * **The proxy then connects to an address it checked**, never to the name
 * again: a second resolution could answer something else.
 *
 * **The machine's own addresses are refused too**, read from its interfaces
 * (addresses.ts says why). A machine whose public address is translated by
 * its provider, rather than set on an interface, does not list it; a
 * connection to it then leaves the machine and comes back through the
 * provider's firewall, like anyone else's.
 */
import { networkInterfaces } from "node:os";
import { canonicalAddress, forbiddenReason, interfaceAddresses, type InterfaceAddress } from "./addresses";

/** Every address of a name, both families. Injected so that the tests answer what they want. */
export type Lookup = (host: string) => Promise<string[]>;

/**
 * The machine's resolver. On Linux Bun defaults to c-ares, which reads
 * /etc/resolv.conf like everything else on the machine.
 */
export const systemLookup: Lookup = async (host) => {
  const answers = await Bun.dns.lookup(host, { family: 0, socketType: "tcp" });
  return [...new Set(answers.map((answer) => answer.address))];
};

/** The machine's own addresses, canonical; null while they could not be read. */
export type OwnAddresses = () => ReadonlySet<string> | null;

/**
 * How long a reading of the interfaces is kept. An address added to the
 * machine is refused at most this long after: interfaces change when an
 * administrator changes them, not under a project's feet.
 */
export const OWN_ADDRESSES_REFRESH_MS = 30_000;

/**
 * The machine's addresses, read again on the first call past the delay rather
 * than on a timer. A reading that fails keeps the last good one; with none
 * yet, the answer is null and resolveChecked refuses everything: the check
 * cannot be skipped by making the reading fail. Under the unit the interfaces
 * are read through netlink, which RestrictAddressFamilies keeps open for this.
 */
export function machineAddresses(
  read: () => Record<string, readonly InterfaceAddress[] | undefined> = networkInterfaces,
  refreshMs = OWN_ADDRESSES_REFRESH_MS,
  now: () => number = Date.now,
): OwnAddresses {
  let known: ReadonlySet<string> | null = null;
  let readAt = -Infinity;
  return () => {
    const at = now();
    if (at - readAt < refreshMs) return known;
    readAt = at;
    try {
      known = interfaceAddresses(read());
    } catch {
      // The last good reading stands.
    }
    return known;
  };
}

export type Resolution =
  | { ok: true; addresses: string[] }
  | { ok: false; status: 403 | 502 | 503 | 504; reason: string; message: string };

/** Resolves and judges, within a delay. Never throws. */
export async function resolveChecked(host: string, lookup: Lookup, timeoutMs: number, ownAddresses: OwnAddresses): Promise<Resolution> {
  const own = ownAddresses();
  if (own === null) {
    return {
      ok: false,
      status: 503,
      reason: "own addresses unknown",
      message: "egress: this machine's own addresses could not be read, and nothing goes out until they are",
    };
  }
  let addresses: string[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), timeoutMs);
    });
    const answer = await Promise.race([lookup(host), expired]);
    if (answer === "expired") {
      return { ok: false, status: 504, reason: "resolution timed out", message: `egress: ${host} did not resolve in time` };
    }
    addresses = answer;
  } catch {
    return { ok: false, status: 502, reason: "does not resolve", message: `egress: ${host} does not resolve` };
  } finally {
    clearTimeout(timer);
  }
  if (addresses.length === 0) {
    return { ok: false, status: 502, reason: "does not resolve", message: `egress: ${host} does not resolve` };
  }
  for (const address of addresses) {
    const reason = forbiddenReason(address);
    if (reason !== null) {
      return {
        ok: false,
        status: 403,
        reason: `resolves to a ${reason} address`,
        message: `egress: refused, ${host} resolves to ${address}, a ${reason} address`,
      };
    }
    // Canonical on both sides: `::ffff:a.b.c.d` is the IPv4 address a.b.c.d.
    if (own.has(canonicalAddress(address) ?? address)) {
      return {
        ok: false,
        status: 403,
        reason: "resolves to this machine's own address",
        message: `egress: refused, ${host} resolves to ${address}, this machine's own address`,
      };
    }
  }
  return { ok: true, addresses };
}
