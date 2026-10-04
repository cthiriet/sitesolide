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
 */
import { forbiddenReason } from "./addresses";

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

export type Resolution =
  | { ok: true; addresses: string[] }
  | { ok: false; status: 403 | 502 | 504; reason: string; message: string };

/** Resolves and judges, within a delay. Never throws. */
export async function resolveChecked(host: string, lookup: Lookup, timeoutMs: number): Promise<Resolution> {
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
  }
  return { ok: true, addresses };
}
