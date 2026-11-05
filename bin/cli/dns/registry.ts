/**
 * What `--dns` accepts: `cloudflare`, the one DNS provider setup speaks to,
 * and the default, or `manual`, the records created by hand and a
 * certificate per name (bin/cli/dns/dns.ts, bin/cli/tls.ts).
 *
 * Ten other providers were offered for a while and never served a real
 * zone; they were removed. A machine set up with one of them still names it
 * in its configuration, and goes on serving: Caddy keeps the module it was
 * built with and the credentials it reads, which neither `upgrade` nor
 * `deploy` touches. Only setup reads the name again, and refuses it with
 * DNS_CHOICES, the way out included.
 */
import { CLOUDFLARE } from "./cloudflare";
import type { DnsEntry } from "./dns";

/** What `--dns` takes for a zone whose records are made by hand. */
export const MANUAL = "manual";

/** The provider `--dns` names, null for `manual`, undefined for a name it does not take. */
export function dnsEntry(name: string): DnsEntry | null | undefined {
  if (name === MANUAL) return null;
  return name === CLOUDFLARE.name ? CLOUDFLARE : undefined;
}

/** A name as a refusal shows it: a short one of the characters names are made of, else nothing of it, which may be a token pasted in the wrong place. */
export function shownDns(name: string): string {
  return /^[a-z0-9-]{1,40}$/.test(name) ? name : "(not shown)";
}

/**
 * What a refusal of any other name says after its message, whether the name
 * was typed or read from a configuration: what `--dns` takes, and what a
 * machine set up with a provider since removed does.
 */
export const DNS_CHOICES: readonly string[] = [
  `${CLOUDFLARE.name}, the default, or ${MANUAL}: the records created by hand, and a certificate per name`,
  "the other DNS providers were removed: a machine set up with one goes on serving as it is",
  `it moves with setup --dns ${CLOUDFLARE.name}, once the zone's DNS is at Cloudflare, or --dns ${MANUAL}; see docs/upgrading.md`,
];

/** Every variable the DNS credentials are read from: never handed to a child process. */
export function dnsVariables(): string[] {
  return CLOUDFLARE.credentials.map((field) => field.variable);
}
