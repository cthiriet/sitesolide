/**
 * What the machine serves, from what it declares.
 *
 * Two sources, both readable by any account and neither private to a project:
 *
 *   - the names of the directories under /srv/sites, each served at
 *     `<slug>.<zone>` by Caddy's wildcard block, the landing's directory
 *     bearing the zone's own name and served at the bare domain and its www;
 *   - /etc/caddy/domaines.map, 0644 root, the customer domains Caddy routes
 *     and certifies on demand, `<domain> <folder>` per line.
 *
 * Nothing inside a project's directory is opened, not even its manifest: the
 * names are enough to know what to ask Caddy, and what systemd runs says the
 * rest. The rules are the platform's own, `isValidSlug` from the CLI that
 * writes those directories, and the same three sources as the dashboard's host
 * table (dashboard/src/audience.ts) and the gatekeeper's probes.
 *
 * Pure.
 */
import { isValidDomain, isValidSlug } from "../../bin/cli/manifest";

/** A host to ask Caddy for over HTTPS, and the directory that serves it. */
export type Target = { host: string; slug: string | null };

/** A certificate to read, under a name that survives its renewal. */
export type CertificateTarget = { id: string; label: string; sni: string; slug: string | null };

/** The unit of the landing, which does not bear its directory's name. */
export const LANDING_UNIT = "sitesolide-landing";

/**
 * The directories of /srv/sites that are sites: a slug, or the landing's,
 * named after the zone. Anything else, `lost+found` or a stray file, has no
 * address under the zone.
 */
export function siteFolders(names: readonly string[], zone: string): string[] {
  return [...new Set(names.filter((name) => name === zone || isValidSlug(name)))].sort();
}

/**
 * The customer domains of the table, with the directory each one serves. The
 * table is generated, but read here without assuming it was generated well: a
 * line that cannot be read is skipped, a name that is not a domain too.
 */
export function readDomainTable(text: string | null): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of (text ?? "").split("\n")) {
    const clean = line.trim();
    if (clean === "" || clean.startsWith("#")) continue;
    const [domain, folder] = clean.split(/\s+/);
    if (domain === undefined || folder === undefined) continue;
    const name = domain.toLowerCase();
    if (!isValidDomain(name)) continue;
    pairs.push([name, folder]);
  }
  return pairs;
}

/**
 * Every host to probe, the bare domain and its www first, then each preview,
 * then each customer domain. The bare domain is probed even when the landing
 * has no directory: Caddy serves it all the same, with a certificate of its
 * own that has to be renewed.
 */
export function servedTargets(zone: string, folders: readonly string[], domains: ReadonlyArray<[string, string]>): Target[] {
  const landing = folders.includes(zone) ? zone : null;
  const targets: Target[] = [
    { host: zone, slug: landing },
    { host: `www.${zone}`, slug: landing },
  ];
  for (const folder of folders) {
    if (folder === zone) continue;
    targets.push({ host: `${folder}.${zone}`, slug: folder });
  }
  for (const [domain, folder] of domains) {
    if (domain === zone || domain.endsWith(`.${zone}`)) continue;
    targets.push({ host: domain, slug: folders.includes(folder) ? folder : null });
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.host)) return false;
    seen.add(target.host);
    return true;
  });
}

/**
 * The certificates to read, one per certificate rather than one per host.
 *
 * Every preview rests on the zone's wildcard: reading it through each of them
 * would raise as many alerts as there are sites for one certificate. It is
 * read once, through the first preview, or through www when there is none, and
 * named `*.<zone>` whichever host carried the question. The bare domain has a
 * certificate of its own, the wildcard not covering it, and so does each
 * customer domain, obtained on demand.
 */
export function certificateTargets(zone: string, targets: readonly Target[]): CertificateTarget[] {
  const preview = targets.find((target) => target.host !== `www.${zone}` && target.host.endsWith(`.${zone}`));
  const landing = targets.find((target) => target.host === zone)?.slug ?? null;
  const certificates: CertificateTarget[] = [
    { id: `certificate:${zone}`, label: zone, sni: zone, slug: landing },
    { id: `certificate:*.${zone}`, label: `*.${zone}`, sni: preview?.host ?? `www.${zone}`, slug: null },
  ];
  for (const target of targets) {
    if (target.host === zone || target.host.endsWith(`.${zone}`)) continue;
    certificates.push({ id: `certificate:${target.host}`, label: target.host, sni: target.host, slug: target.slug });
  }
  return certificates;
}

/**
 * Each project's main unit, without `.service`, to its directory. The landing's
 * is `sitesolide-landing`; every other one bears its slug, and its other
 * services `<slug>.<name>`, which src/checks.ts finds by that prefix.
 */
export function projectUnits(folders: readonly string[], zone: string): Map<string, string> {
  const units = new Map<string, string>();
  for (const folder of folders) units.set(folder === zone ? LANDING_UNIT : folder, folder);
  return units;
}
