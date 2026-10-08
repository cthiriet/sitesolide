/**
 * What a member sees of the machine: the projects they hold a role on, and
 * nothing of the others, not even their names. Pure.
 *
 * The dashboard already holds the snapshot, and filters it here rather than
 * asking the steward: a compromised dashboard reads it whole anyway, as it
 * always could. What this protects is a member's view, not the machine; what
 * protects the machine is the steward, which judges every write.
 */
import type { Reading } from "../read";
import type { Roles } from "./protocol";

/**
 * The reading as a member may see it: their sites, the discrepancies of their
 * sites, their sites' audience. The machine's own figures, its memory, disk
 * and load, and its discrepancies that name no site, are the owner's.
 *
 * A site's preview code opens it to whoever holds it: an Admin of the site
 * reads it, to send it; a Viewer or a Developer reads that the site opens
 * with one, `withheld`, and asks an Admin.
 */
export function memberReading(reading: Reading, roles: Roles): Reading {
  if (!reading.present) return reading;
  const slugs = new Set(Object.keys(roles));
  const { snapshot, audience } = reading;
  const sites: Record<string, (typeof audience.sites)[string]> = {};
  for (const [slug, measure] of Object.entries(audience.sites)) if (slugs.has(slug)) sites[slug] = measure;
  return {
    ...reading,
    snapshot: {
      ...snapshot,
      sites: snapshot.sites
        .filter((site) => slugs.has(site.slug))
        .map((site) => (roles[site.slug] === "admin" || (site.lock?.code ?? null) === null ? site : { ...site, lock: { ...site.lock, code: null, url: null, withheld: true } })),
      discrepancies: snapshot.discrepancies.filter((discrepancy) => discrepancy.slug !== null && slugs.has(discrepancy.slug)),
      machine: null,
    },
    audience: { ...audience, sites },
  };
}
