import { readFileSync } from "node:fs";
import { DOMAIN_TABLE_TTL_MS, MAIN_ZONE, NEW_ZONE_NAMES_CAP, NEW_ZONE_NAMES_WINDOW_MS, TLS_ZONE_FILE, ZONE_NAMES_FILE, ZONE_NAMES_MISS_MS } from "./config";
import type { Decision } from "./domains";
import { onDemandPolicy, parseZoneNames, ZONE_LABEL } from "./zone-names";

/**
 * The served zone's own names, `<zone>`, `www.<zone>` and `<label>.<zone>`,
 * before the table of customer domains is even read.
 *
 * Two ways of certifying them, and the zone's TLS policy says which
 * (/etc/caddy/tls-zone.caddy, see bin/cli/tls.ts):
 *
 *   a DNS provider   one wildcard certificate and the apex's, through a DNS-01
 *                    challenge. Caddy never asks for a name the zone's blocks
 *                    serve, and a name of the zone that reaches the ask
 *                    endpoint is refused, as it always was: a second
 *                    certificate for a name already covered would count
 *                    against the authority's limits.
 *   on demand        manual DNS, no API: one certificate per name, at its
 *                    first handshake, and Caddy asks first. Allowed: the zone
 *                    itself and `www.<zone>`, which the landing's block serves,
 *                    and `<label>.<zone>` for a label that is a site deployed
 *                    on the machine, which the wildcard block or the site's own
 *                    block serves. Nothing else: the zone's wildcard record
 *                    points every name at the machine, and a random name
 *                    allowed would let anyone spend the authority's fifty
 *                    certificates a week on the zone.
 *
 * A name allowed is therefore always a name Caddy routes. A name of two labels
 * or more under the zone is never one: the wildcard matches one label only,
 * and such a name falls to the customer domains' block, which serves nothing
 * for it.
 */

export { onDemandPolicy, parseZoneNames } from "./zone-names";

/**
 * A file read through a cache: at most once per window, `ttlMs` unless the
 * caller asks for a shorter one. The zone's two files and the domain table
 * (src/domains.ts) are all read through it: a missing file is its empty
 * value, and any other failure keeps the last value read, which never allows
 * more than it did. `read` says whether a reading ever succeeded, a missing
 * file counting as one.
 */
export function cachedFile<T>(path: string, ttlMs: number, parse: (content: string) => T, absent: T): { get: (now: number, windowMs?: number) => T; read: () => boolean } {
  let value = absent;
  let lastRead = 0;
  let neverRead = true;
  return {
    get(now, windowMs = ttlMs) {
      if (!neverRead && now - lastRead < windowMs) return value;
      try {
        value = parse(readFileSync(path, "utf8"));
        neverRead = false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          value = absent;
          neverRead = false;
        } else {
          console.error(`could not read ${path}:`, err);
        }
      }
      lastRead = now;
      return value;
    },
    read: () => !neverRead,
  };
}

export type ZoneOptions = {
  /** The zone served; empty, no name is the zone's, and the domain table alone decides. */
  zone?: string;
  policyFile?: string;
  namesFile?: string;
  ttlMs?: number;
  missMs?: number;
  /** Names new to the zone allowed per window, and the window: see NEW_ZONE_NAMES_CAP. */
  newNamesCap?: number;
  newNamesWindowMs?: number;
  /** Where the cap says, once, that it is reached. */
  log?: (line: string) => void;
};

export type Zone = {
  /** The decision for a name of the zone, null for a name that is not one. */
  decide: (host: string, now: number) => Decision | null;
};

/**
 * Opens the zone's two files, read only when a name of the zone is asked
 * about. The host is already normalized, see normalizeHost.
 *
 * With manual DNS, a listed name this service has never allowed is new, and
 * at most `newNamesCap` new names are allowed per window: see
 * NEW_ZONE_NAMES_CAP for what that bounds. Known names: those listed at the
 * first reading of the list, and every name allowed since. They stay
 * allowed for as long as they are listed, renewals included.
 */
export function createZone(options: ZoneOptions = {}): Zone {
  const zone = options.zone ?? MAIN_ZONE;
  const ttlMs = options.ttlMs ?? DOMAIN_TABLE_TTL_MS;
  const missMs = options.missMs ?? ZONE_NAMES_MISS_MS;
  const cap = options.newNamesCap ?? NEW_ZONE_NAMES_CAP;
  const windowMs = options.newNamesWindowMs ?? NEW_ZONE_NAMES_WINDOW_MS;
  const log = options.log ?? ((line: string) => console.warn(line));
  // Absent, the policy is a DNS provider's: the machines from before the file
  // all were, and refusing is what fails closed.
  const onDemand = cachedFile(options.policyFile ?? TLS_ZONE_FILE, ttlMs, onDemandPolicy, false);
  const names = cachedFile(options.namesFile ?? ZONE_NAMES_FILE, ttlMs, parseZoneNames, new Set<string>());

  /** The names known to be certified, or about to be; null until the list is first read. */
  let known: Set<string> | null = null;
  /** When each name new to the zone was allowed, within the window. */
  let allowedNew: number[] = [];
  let capSaid = false;

  /** The list, the first one read becoming what is known. */
  function listed(now: number, windowMs?: number): Set<string> {
    const current = names.get(now, windowMs);
    if (known === null && names.read()) known = new Set(current);
    return current;
  }

  return {
    decide(host, now) {
      if (zone === "" || (host !== zone && !host.endsWith(`.${zone}`))) return null;

      if (!onDemand.get(now)) return { allowed: false, reason: "covered by the wildcard" };

      if (host === zone) return { allowed: true, reason: "the zone itself" };
      if (host === `www.${zone}`) return { allowed: true, reason: "the zone's www" };

      const label = host.slice(0, -(zone.length + 1));
      if (!ZONE_LABEL.test(label)) return { allowed: false, reason: "not a single label under the zone" };

      if (!listed(now).has(label) && !listed(now, missMs).has(label)) {
        return { allowed: false, reason: "no site deployed under that name" };
      }
      // A list never read from an existing file: the one that holds this
      // label becomes what is known, as a first read does, so that a
      // restart never makes a renewal count against the cap.
      if (known === null) known = new Set(listed(now));
      if (!known.has(label)) {
        allowedNew = allowedNew.filter((at) => now - at < windowMs);
        if (allowedNew.length >= cap) {
          if (!capSaid) {
            log(
              `on demand tls: ${cap} names new to the zone allowed within ${windowMs / 3_600_000} h, the cap: further new names are refused until the oldest of them is that old; names already allowed, renewals included, are not affected`,
            );
            capSaid = true;
          }
          return { allowed: false, reason: `the cap of ${cap} names new to the zone per ${windowMs / 3_600_000} h is reached` };
        }
        allowedNew.push(now);
        known.add(label);
        capSaid = false;
      }
      return { allowed: true, reason: "a site deployed under the zone" };
    },
  };
}
