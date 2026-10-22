/**
 * The DNS providers `--dns` accepts, in the order the wizard offers them, and
 * the mode that needs none: `manual`, the records created by hand and a
 * certificate per name (bin/cli/dns/dns.ts, bin/cli/tls.ts).
 */
import { AZURE_DNS } from "./azure-dns";
import { CLOUDFLARE } from "./cloudflare";
import { DIGITALOCEAN_DNS } from "./digitalocean-dns";
import { GANDI_DNS } from "./gandi";
import { HETZNER_DNS } from "./hetzner-dns";
import { LINODE_DNS } from "./linode-dns";
import { OVH_DNS } from "./ovh";
import { PORKBUN_DNS } from "./porkbun";
import { VULTR_DNS } from "./vultr-dns";
import { ROUTE53 } from "./route53";
import { SCALEWAY_DNS } from "./scaleway-dns";
import type { DnsEntry } from "./dns";

export const DNS_PROVIDERS: readonly DnsEntry[] = [
  CLOUDFLARE,
  ROUTE53,
  AZURE_DNS,
  DIGITALOCEAN_DNS,
  HETZNER_DNS,
  SCALEWAY_DNS,
  VULTR_DNS,
  LINODE_DNS,
  OVH_DNS,
  GANDI_DNS,
  PORKBUN_DNS,
];

/** What `--dns` takes for a zone whose records are made by hand. */
export const MANUAL = "manual";

/** The provider `--dns` names, null for `manual`, undefined for a name it does not know. */
export function dnsEntry(name: string): DnsEntry | null | undefined {
  if (name === MANUAL) return null;
  return DNS_PROVIDERS.find((entry) => entry.name === name);
}

/** Every variable a DNS provider reads its credentials from: never handed to a child process. */
export function dnsVariables(): string[] {
  return DNS_PROVIDERS.flatMap((entry) => entry.credentials.map((field) => field.variable));
}
