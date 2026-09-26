/**
 * The contract between the steward and the gatekeeper: the unit to launch,
 * what systemd passes to the gatekeeper, and the paths the steward can re-read.
 *
 * **Two unit templates, one per action**, and the slug alone as the instance:
 *
 *   systemctl start sitesolide-gatekeeper-on@cms.service
 *   systemctl start sitesolide-gatekeeper-off@cms.service
 *
 * The slug is `%i` and not `%I`: the unescaped form would turn every dash into
 * a slash, and `attempt-api` would become `attempt/api` there. Each unit writes
 * only in `/srv/sites/%i` (infra/gatekeeper/), so that a compromised gatekeeper
 * holds no more than the site it was named.
 *
 * **The entry point receives `%n`**, the full name systemd resolved, and
 * `GATEKEEPER_ACTION`, set by `Environment=` in each file. The two must say the
 * same action: an `-off@` file copied from `-on@` without changing its
 * `Environment=` line is refused before any reading at all, instead of putting
 * the door up when one wanted to take it away.
 *
 * Anything that does not have exactly the expected form is refused, without
 * reading or writing anything: the slug ends up in paths written under root.
 *
 * Pure.
 */
import { isValidSlug } from "../../borrowed/manifest";

export type Instance = { slug: string; active: boolean };

export type Action = "on" | "off";

/** The common prefix of the two templates, before `-on@` or `-off@`. */
export const UNIT_PREFIX = "sitesolide-gatekeeper";

/** Where the gatekeeper leaves results, backups and Caddy's lock. */
export const RUN_FOLDER = "/run/sitesolide-gatekeeper";

/**
 * Caddy's lock, common to the gatekeeper and to the workstation's tools
 * (`bin/deploy-caddy.sh`, `bin/lock.sh`, `sitesolide deploy`). A directory,
 * created by `mkdir`, which is atomic; it carries a `holder` file.
 */
export const LOCK_NAME = "caddy.lock";
export const HOLDER_NAME = "holder";

/** The backups directory, one subdirectory per site. */
export const BACKUPS_NAME = "sauvegardes";

/** The unit to launch for this action, or null if the slug cannot go into it. */
export function gatekeeperUnit(slug: string, active: boolean): string | null {
  if (!isValidSlug(slug)) return null;
  return `${UNIT_PREFIX}-${active ? "on" : "off"}@${slug}.service`;
}

/**
 * The backup of an action in progress, or interrupted if it remains after the
 * end of the unit: `/run/sitesolide-gatekeeper/sauvegardes/<slug>`. The steward
 * uses it to say that the site's state is unknown. Throws on a slug outside the
 * rule.
 */
export function backupFolder(slug: string, runFolder: string = RUN_FOLDER): string {
  if (!isValidSlug(slug)) throw new Error("invalid slug");
  return `${runFolder}/${BACKUPS_NAME}/${slug}`;
}

export type Launch = { ok: true; instance: Instance } | { ok: false; reason: string };

/**
 * `argv` as the unit passes it (`gatekeeper.js %n`) and the value of
 * `GATEKEEPER_ACTION`. The reason for a refusal never quotes the input as it
 * stands.
 */
export function readLaunch(argv: readonly string[], action: string | undefined): Launch {
  if (argv.length !== 1) return { ok: false, reason: "expected exactly one argument, the unit name (%n)" };
  if (action !== "on" && action !== "off") return { ok: false, reason: "GATEKEEPER_ACTION must be on or off" };

  const name = argv[0]!;
  const found = /^sitesolide-gatekeeper-(on|off)@([^@/]+)\.service$/.exec(name);
  if (found === null) {
    return { ok: false, reason: "unexpected unit name, expected sitesolide-gatekeeper-<on|off>@<slug>.service" };
  }
  if (found[1] !== action) {
    return { ok: false, reason: `GATEKEEPER_ACTION=${action} does not match the ${found[1]} unit` };
  }
  const slug = found[2]!;
  if (!isValidSlug(slug)) return { ok: false, reason: "invalid slug in the unit name" };
  return { ok: true, instance: { slug, active: action === "on" } };
}
