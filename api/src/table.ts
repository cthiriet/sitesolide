import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds the client domain table from the `sitesolide.json` files. The
 * produced file is read by two consumers:
 *
 *   - Caddy, in the `map` directive of the client domains block, to route a
 *     domain to the site's folder;
 *   - the `sitesolide-api` service, as the whitelist of the `ask` endpoint.
 *
 * A single file therefore governs authorization and routing: a domain cannot
 * obtain a certificate without being served, nor be served without having been
 * authorized.
 *
 * The source is the site's manifest, dropped as is at the root of the project
 * by `sitesolide deploy`. It is the only configuration file of a site, here as
 * in the repository: the `site.json` with French keys that held this role is
 * gone, two files for a single state having ended up diverging.
 *
 * Format of `/srv/sites/<slug>/sitesolide.json`, as far as we are concerned:
 *
 *   { "domain": { "name": "sample-agency.example", "active": true,
 *                 "aliases": ["old-name.test"] } }
 *
 * A site without `domain`, or whose `active` is not true, stays reachable on
 * its preview subdomain but does not appear here. The keys are in English
 * because the manifest is written by hand in arbitrary repositories: see
 * bin/cli/manifest.ts of the platform.
 */

type Manifest = { domain?: unknown };
type DomainBlock = { name?: unknown; active?: unknown; aliases?: unknown };

/** The manifest's name, the only configuration file dropped alongside a site. */
export const MANIFEST_NAME = "sitesolide.json";

/** A slug serves as a folder name in a path built by Caddy. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) && !slug.includes("..");
}

export function isValidDomain(domain: string): boolean {
  return (
    domain.length > 0 &&
    domain.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  );
}

/**
 * Visitors type `www` without thinking about it, and a certificate missing on
 * that form shows up immediately. It is only added for a second level domain:
 * on `shop.example.test`, a `www` would make no sense.
 */
export function domainForms(domain: string): string[] {
  const labels = domain.split(".");
  return labels.length === 2 ? [domain, `www.${domain}`] : [domain];
}

/**
 * A `site.json` left on the VM alongside a site never redeployed since the
 * switch. Its presence without a manifest is a stop, never an ignored site:
 * the client's domain would drop out of the table silently, and Caddy would
 * stop routing it as well as renewing its certificate.
 */
function requireMigration(sitesDir: string, slug: string): void {
  if (!existsSync(join(sitesDir, slug, "site.json"))) return;
  throw new Error(
    `${slug}: site.json is still there and ${MANIFEST_NAME} is missing. ` +
      `Redeploy this site with "sitesolide deploy", which drops the manifest and removes the old descriptor.`,
  );
}

function readSite(sitesDir: string, slug: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(sitesDir, slug, MANIFEST_NAME), "utf8");
  } catch (err) {
    // A site without a manifest is a showcase in preview: that is not an
    // error, unless it still carries the old descriptor.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      requireMigration(sitesDir, slug);
      return [];
    }
    throw err;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    throw new Error(`${slug}: ${MANIFEST_NAME} unreadable`);
  }

  const block = manifest.domain;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
  const fields = block as DomainBlock;

  if (fields.active !== true) return [];

  const declaredNames = [fields.name, ...(Array.isArray(fields.aliases) ? fields.aliases : [])];
  const kept: string[] = [];

  for (const declaredName of declaredNames) {
    if (typeof declaredName !== "string") continue;

    const domain = declaredName.trim().toLowerCase().replace(/\.$/, "");
    if (domain === "") continue;
    if (!isValidDomain(domain)) {
      throw new Error(`${slug}: invalid domain "${declaredName}"`);
    }
    kept.push(...domainForms(domain));
  }

  return kept;
}

/** Maps each domain to the slug of the site that serves it. */
export function buildTable(sitesDir: string): Map<string, string> {
  const lines = new Map<string, string>();

  for (const entry of readdirSync(sitesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidSlug(entry.name)) {
      throw new Error(`unexpected folder slug: ${entry.name}`);
    }

    for (const domain of readSite(sitesDir, entry.name)) {
      const occupant = lines.get(domain);
      if (occupant !== undefined && occupant !== entry.name) {
        throw new Error(`${domain} is claimed by ${occupant} and by ${entry.name}`);
      }
      lines.set(domain, entry.name);
    }
  }

  return lines;
}

/** Renders the table in the format expected by Caddy's `map` directive. */
export function render(lines: Map<string, string>): string {
  const body = [...lines.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, slug]) => `\t${domain} ${slug}`);

  return ["# Generated by api/scripts/generate-domains.ts, do not edit by hand.", ...body].join("\n");
}
