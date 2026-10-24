import { DOMAIN_TABLE_TTL_MS } from "./config";
import { cachedFile, createZone, type Zone } from "./zone";

/**
 * Reduces what Caddy passes along to a comparable host name: lowercase, no
 * port, no trailing dot. Returns `null` for anything that does not look like a
 * domain name, IP addresses included.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes(".")) return null;
  // A literal IPv4 cannot be certified by Let's Encrypt.
  if (/^\d+(\.\d+)*$/.test(host)) return null;

  return host;
}

/**
 * A line reads `domain folder`, possibly preceded by spaces. Keys starting
 * with `~` are regular expressions on the Caddy side: this service cannot
 * evaluate them, so it ignores them rather than risk authorizing more broadly
 * than intended.
 */
export function parseDomainTable(content: string): Set<string> {
  const table = new Set<string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const key = line.split(/\s+/)[0]!.replace(/^"|"$/g, "");
    if (key === "" || key === "default" || key.startsWith("~")) continue;

    table.add(key.toLowerCase());
  }
  return table;
}

export type Decision = { allowed: boolean; reason: string };

export type Table = {
  decide: (raw: string | null | undefined, now: number) => Decision;
  count: (now: number) => number;
};

/**
 * Opens the table of authorized domains. The file is re-read at most once per
 * window: the endpoint is called during a TLS handshake, it must not depend on
 * a disk access on every request.
 *
 * Time is received as a parameter rather than read here, so that the tests can
 * cross the cache window without waiting. So is the zone, whose own names are
 * decided before the table is read: see src/zone.ts.
 */
export function createTable(path: string, ttlMs: number = DOMAIN_TABLE_TTL_MS, zone: Zone = createZone({ ttlMs })): Table {
  // A missing file is an empty table, normal as long as no client has moved
  // to its own domain. A failed read keeps the previous table: the file may be
  // in the middle of being rewritten, and temporarily losing the list would
  // make legitimate renewals fail. This fallback never authorizes more than
  // the last known table.
  const table = cachedFile(path, ttlMs, parseDomainTable, new Set<string>());

  return {
    /**
     * Decides whether Caddy may obtain a certificate for this domain. Any path
     * that does not explicitly land on an entry of the table is a refusal:
     * without that, anyone pointing their DNS at the machine would have
     * certificates issued in our name and would exhaust the ACME quotas.
     */
    decide(raw, now) {
      const host = normalizeHost(raw);
      if (!host) return { allowed: false, reason: "invalid host name" };

      // The main zone's names never reach the table. With a DNS provider they
      // are served by the wildcard and by the apex certificate, both obtained
      // through DNS-01, and authorizing one on demand would issue a second
      // certificate for a name already covered. With manual DNS, the zone
      // itself, its www and the sites deployed under it are allowed, and
      // nothing else.
      const zoned = zone.decide(host, now);
      if (zoned !== null) return zoned;

      if (!table.get(now).has(host)) return { allowed: false, reason: "unknown domain" };

      return { allowed: true, reason: "active client domain" };
    },

    /** Number of currently authorized domains, for diagnostics. */
    count(now) {
      return table.get(now).size;
    },
  };
}
