/**
 * The zone's DNS, whoever holds it: the records setup points at the machine,
 * and what Caddy needs to obtain the zone's wildcard certificate.
 *
 * A zone is served one of two ways, chosen at setup with `--dns`:
 *
 *   a provider of DNS_PROVIDERS   setup creates the records through its API,
 *                                 and Caddy obtains the wildcard through a
 *                                 DNS-01 challenge with the provider's Caddy
 *                                 module; Cloudflare is the first of them, and
 *                                 the default
 *   manual                        the person creates the records by hand at
 *                                 whatever registrar, and Caddy obtains one
 *                                 certificate per name through HTTP-01 or
 *                                 TLS-ALPN-01, on demand, for the names of the
 *                                 sites deployed and those alone (bin/cli/tls.ts)
 *
 * THE DNS CREDENTIALS GO ON THE MACHINE. Caddy renews the wildcard every two
 * months and needs them for it: setup lays them in /etc/caddy/cloudflare.env,
 * root:caddy 0640, whatever the provider (the name is the first provider's,
 * and the file is in service on machines that predate the others). They must
 * reach the zone and nothing else. That is why a provider here never reads
 * the variables its cloud's own tools read, and never asks a CLI for
 * credentials: a broad token in the workstation's environment, one that orders
 * machines, must never be laid on a machine by accident. Every provider but
 * Cloudflare, whose CLOUDFLARE_API_TOKEN setup has always read, takes its
 * credentials from variables of sitesolide's own, `SITESOLIDE_DNS_<...>`.
 *
 * A provider fails with a DnsError whose kind says what to do: `token`, the
 * credentials are refused; `zone`, none it can read holds the name; `refused`,
 * the API said no to a request; `unreachable`, no answer, or not the API's;
 * `conflict`, records that point elsewhere. A credential is never in a URL, a
 * message or an error: providers scrub what comes back from outside.
 */
import { resolveNs } from "node:dns/promises";
import { describePlan, desiredRecords, planRecords, planTunnelRecords, recordLine, zoneCandidates, type DnsRecord, type RecordAction } from "../cloudflare";
import type { Clock, CredentialField, Credentials, Fetch } from "../providers/provider";

export type { DnsRecord, RecordAction };
export { describePlan, desiredRecords, planRecords, recordLine, zoneCandidates };

export type DnsFailure = "token" | "zone" | "refused" | "unreachable" | "conflict";

export class DnsError extends Error {
  constructor(
    message: string,
    readonly kind: DnsFailure,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "DnsError";
  }
}

/** A zone as the provider holds it: its id there, and its name, the one asked or a parent. */
export type ZoneRef = { id: string; name: string };

/** One record a plan creates; `proxied` and a CNAME are a tunnel's, at Cloudflare alone. */
export type NewRecord = { name: string; type: "A" | "AAAA" | "CNAME"; content: string; proxied?: boolean };

/**
 * What setup asks of a provider's DNS API. Names are absolute, without a
 * trailing dot, lowercase: `example.com`, `*.example.com`. A record's `id` is
 * whatever lets the provider find it again; `proxied` is false where the
 * provider has no proxy.
 */
export interface ZoneApi {
  /** Refused credentials fail here with kind `token`, before anything else is asked. */
  verify(): Promise<void>;
  /** The zone that holds `zone`, itself or a parent; kind `zone` when none the credentials read does. */
  findZone(zone: string): Promise<ZoneRef>;
  /** Every record of exactly that name, of every type. */
  listRecords(zone: ZoneRef, name: string): Promise<DnsRecord[]>;
  createRecord(zone: ZoneRef, record: NewRecord): Promise<void>;
  /** `proxied`, a tunnel's CNAME at Cloudflare alone; every other provider has no proxy and ignores it. */
  updateRecord(zone: ZoneRef, record: DnsRecord, content: string, proxied?: boolean): Promise<void>;
  deleteRecord(zone: ZoneRef, record: DnsRecord): Promise<void>;
}

export type DnsContext = {
  credentials: Credentials;
  environment: Record<string, string | undefined>;
  fetcher: Fetch;
  clock: Clock;
  /** A secret obtained along the way, an exchanged token: scrubbed from every line from then on. */
  secret: (value: string) => void;
};

/** What Caddy needs on the machine to answer the provider's DNS-01 challenge. */
export type CaddyDns = {
  /** The module's package, which `caddy add-package` adds to the build: `github.com/caddy-dns/cloudflare`. */
  package: string;
  /** Its id, as `caddy list-modules` prints it: `dns.providers.cloudflare`. */
  module: string;
  /**
   * The lines of the zone's `tls { }` block, every credential read from
   * Caddy's environment with `{env.NAME}`, never written in: `dns cloudflare
   * {env.CLOUDFLARE_API_TOKEN}`. The file that holds them is readable by all.
   */
  directive: string[];
  /** The variables /etc/caddy/cloudflare.env holds for the module, from the credentials. */
  environment: (credentials: Credentials) => Record<string, string>;
};

export type DnsEntry = {
  /** What `--dns` takes: `cloudflare`, `route53`. */
  name: string;
  /** As a person writes it: `Cloudflare`, `Amazon Route 53`. */
  title: string;
  /** What it needs, scoped to the zone; read from the environment, standard input, or typed at the wizard. */
  credentials: readonly CredentialField[];
  /** The forms credentials come in, as for a cloud provider (bin/cli/providers/provider.ts). */
  alternatives?: readonly (readonly string[])[];
  /** Where those credentials are made, with the least permission that works, one line each. */
  credentialHelp: string[];
  /** The page of docs/dns/ that says it all. */
  docs: string;
  /**
   * Matches a name server of a zone the provider serves, `ada.ns.cloudflare.com`:
   * how the wizard tells, from the zone's NS records, who holds it.
   */
  nameServers: RegExp;
  caddy: CaddyDns;
  /** The variable that points the provider at another API address, for a local fake: `SITESOLIDE_CLOUDFLARE_API`. */
  apiVariable: string;
  open: (context: DnsContext) => ZoneApi;
};

// --- what every provider shares --------------------------------------------------------------------

/**
 * The records of the zone and its wildcard pointed at the machine, whoever
 * holds the zone: the whole plan drawn before the first write (planRecords in
 * ../cloudflare), nothing written while a record points elsewhere unless
 * `replace`, the owner's decision, says so. Deletions first, since a CNAME
 * has to go before an address record can take its name.
 */
export async function ensureZoneRecords(
  api: ZoneApi,
  zone: string,
  addresses: { ipv4: string; ipv6: string | null },
  replace: boolean,
): Promise<{ zone: string; actions: RecordAction[] }> {
  await api.verify();
  const found = await api.findZone(zone);
  const existing = [...(await api.listRecords(found, zone)), ...(await api.listRecords(found, `*.${zone}`))];
  const actions = planRecords(existing, desiredRecords(zone, addresses.ipv4, addresses.ipv6), replace);
  const conflicts = actions.filter((action): action is Extract<RecordAction, { kind: "conflict" }> => action.kind === "conflict");
  if (conflicts.length > 0) {
    throw new DnsError("records that point elsewhere", "conflict", [
      ...conflicts.map((conflict) => `${recordLine(conflict.record)}: ${conflict.reason}`),
      "nothing was written: the zone may be serving something with them",
    ]);
  }
  for (const action of actions) if (action.kind === "delete") await api.deleteRecord(found, action.record);
  for (const action of actions) if (action.kind === "update") await api.updateRecord(found, action.record, action.content);
  for (const action of actions) if (action.kind === "create") await api.createRecord(found, { name: action.name, type: action.type, content: action.content });
  return { zone: found.name, actions };
}

/**
 * The zone and its wildcard pointed at a Cloudflare Tunnel, `target` being
 * `<id>.cfargotunnel.com`: planned whole first, as ensureZoneRecords plans,
 * nothing written while a record stands in the way unless `replace`.
 * `dryRun` only reads, and returns the plan.
 */
export async function ensureTunnelRecords(api: ZoneApi, zone: string, target: string, replace: boolean, dryRun = false): Promise<{ zone: string; actions: RecordAction[] }> {
  await api.verify();
  const found = await api.findZone(zone);
  const existing = [...(await api.listRecords(found, zone)), ...(await api.listRecords(found, `*.${zone}`))];
  const actions = planTunnelRecords(existing, zone, target, replace);
  if (dryRun) return { zone: found.name, actions };
  const conflicts = actions.filter((action): action is Extract<RecordAction, { kind: "conflict" }> => action.kind === "conflict");
  if (conflicts.length > 0) {
    throw new DnsError("records that point elsewhere", "conflict", [
      ...conflicts.map((conflict) => `${recordLine(conflict.record)}: ${conflict.reason}`),
      "nothing was written: the zone may be serving something with them",
    ]);
  }
  for (const action of actions) if (action.kind === "delete") await api.deleteRecord(found, action.record);
  for (const action of actions) if (action.kind === "update") await api.updateRecord(found, action.record, action.content, action.proxied === true);
  for (const action of actions) if (action.kind === "create") await api.createRecord(found, { name: action.name, type: action.type, content: action.content, proxied: action.proxied === true });
  return { zone: found.name, actions };
}

/** The zone and its wildcard's records as they stand, for the wizard: read only. */
export async function zoneRecords(api: ZoneApi, zone: string): Promise<{ zone: ZoneRef; records: DnsRecord[] }> {
  await api.verify();
  const found = await api.findZone(zone);
  return { zone: found, records: [...(await api.listRecords(found, zone)), ...(await api.listRecords(found, `*.${zone}`))] };
}

/**
 * Who serves a zone's DNS, read from its NS records, the zone's or its
 * nearest parent's: the provider whose name servers they are, or null with
 * the names, for a registrar sitesolide has no module for. Never throws: a
 * zone that does not resolve says so with no name server.
 */
export async function detectDns(
  zone: string,
  providers: readonly DnsEntry[],
  lookup: (name: string) => Promise<string[]> = (name) => resolveNs(name),
): Promise<{ entry: DnsEntry | null; nameServers: string[] }> {
  for (const name of zoneCandidates(zone)) {
    const servers = await lookup(name).catch(() => [] as string[]);
    if (servers.length === 0) continue;
    const lowered = servers.map((server) => server.toLowerCase().replace(/\.$/, ""));
    return { entry: providers.find((entry) => lowered.some((server) => entry.nameServers.test(server))) ?? null, nameServers: lowered };
  }
  return { entry: null, nameServers: [] };
}
