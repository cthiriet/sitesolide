/**
 * Writes the Caddy fragment for preview locks to standard output, from the
 * `sitesolide.json` files of /srv/sites and the codes file. Run by
 * `bin/lock.sh`, which installs it into /etc/caddy/locks/ and reloads Caddy.
 *
 * Two sources, and that separation is deliberate:
 *
 *   - the manifest carries the intent, `"lock": true`. It is versioned in the
 *     repository and deployed as is with the site: the wanted state is read
 *     back from git;
 *   - the codes file carries the code, and nothing else. It lives on the VM,
 *     outside the repository, and changes at every regeneration without
 *     asking for a commit.
 *
 * The logic lives in src/locks.ts, this file only reads bytes and calls it:
 * any error there becomes a non-zero exit code, which interrupts the install
 * script before it touches the configuration in service. A lock asked for
 * without a valid code goes through that path.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, isValidSlug } from "../src/table";
import { buildFragment, previewHost, type LockSite } from "../src/locks";

/** No path is hardcoded: that way the generator runs outside the VM too. */
const SITES_DIR = process.env.SITES_DIR ?? "/srv/sites";
const CODES_FILE = process.env.CODES_FILE ?? "/etc/caddy/locks-codes.json";
const DOOR_PAGES_DIR = process.env.DOOR_PAGES_DIR ?? "/srv/garde";
const ZONE = requiredZone();

/**
 * The zone the preview subdomains are built on.
 *
 * NO DEFAULT NAMES A MACHINE. A ready made zone here would be the one of this
 * file's author, and a fragment generated without configuration would close
 * sites under names that belong to nobody on this machine. The generator
 * therefore stops, and its non-zero exit interrupts `bin/lock.sh` before it
 * touches the configuration in service.
 *
 * The value comes from the workstation's configuration, written by `sitesolide
 * init`, which `bin/lock.sh` passes on.
 */
function requiredZone(): string {
  const zone = process.env.SITESOLIDE_ZONE ?? "";
  if (zone === "") {
    throw new Error(
      'SITESOLIDE_ZONE is missing: declare the zone with "sitesolide init", no zone is assumed here',
    );
  }
  return zone;
}

/**
 * Codes in force, `{ "<slug>": "<CODE>" }`. Absent as long as no site has ever
 * been locked: that case is normal and yields an empty table. Unreadable, on
 * the other hand, is an error: carrying on would amount to opening sites their
 * owner believes closed.
 */
function readCodes(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }

  let codes: unknown;
  try {
    codes = JSON.parse(raw);
  } catch {
    throw new Error(`${path}: codes file unreadable`);
  }
  if (typeof codes !== "object" || codes === null || Array.isArray(codes)) {
    throw new Error(`${path}: an object slug -> code was expected`);
  }
  return codes as Record<string, unknown>;
}

/**
 * The manifest's `lock` field, as is. A site without a manifest is not locked,
 * unless it still carries the old `site.json`: that one could ask for a lock
 * nobody reads any more, and the site would reopen silently. Regeneration then
 * stops, as it does for the domain table.
 */
function readLock(sitesDir: string, slug: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(sitesDir, slug, MANIFEST_NAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (existsSync(join(sitesDir, slug, "site.json"))) {
        throw new Error(
          `${slug}: site.json is still there and ${MANIFEST_NAME} is missing. ` +
            `Redeploy this site with "sitesolide deploy" before regenerating the locks.`,
        );
      }
      return undefined;
    }
    throw err;
  }

  try {
    return (JSON.parse(raw) as { lock?: unknown }).lock;
  } catch {
    throw new Error(`${slug}: ${MANIFEST_NAME} unreadable`);
  }
}

const codes = readCodes(CODES_FILE);
const sites: LockSite[] = [];

for (const entry of readdirSync(SITES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (!isValidSlug(entry.name)) {
    throw new Error(`unexpected folder slug: ${entry.name}`);
  }

  sites.push({
    slug: entry.name,
    host: previewHost(entry.name, ZONE),
    lock: readLock(SITES_DIR, entry.name),
    code: codes[entry.name],
  });
}

process.stdout.write(buildFragment(sites, { doorPagesDir: DOOR_PAGES_DIR }));
