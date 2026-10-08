/**
 * The contract between the steward and the gatekeeper: the unit to launch,
 * what systemd passes to the gatekeeper, and the paths the steward can re-read.
 *
 * **Four unit templates, one per action**, and the slug alone as the instance:
 *
 *   systemctl start sitesolide-gatekeeper-on@cms.service      Restricted
 *   systemctl start sitesolide-gatekeeper-off@cms.service     Public
 *   systemctl start sitesolide-gatekeeper-code@cms.service    Anyone with the code
 *   systemctl start sitesolide-gatekeeper-renew@cms.service   a new code
 *
 * Each action names the general access it leaves the site with, from
 * whichever it had: `on` from the code takes the code away and puts the
 * portal up in one transaction, `code` from Restricted the reverse. The
 * action is in the template's name, never in the instance, so that a request
 * can name nothing but a slug; the code is drawn by the gatekeeper itself.
 *
 * The slug is `%i` and not `%I`: the unescaped form would turn every dash into
 * a slash, and `attempt-api` would become `attempt/api` there. Each unit writes
 * only in `/srv/sites/%i` (infra/gatekeeper/), so that a compromised gatekeeper
 * holds no more than the site it was named.
 *
 * **The entry point receives `%n`**, the full name systemd resolved, and
 * `GATEKEEPER_ACTION`, set by `Environment=` in each file. The two must say the
 * same action: an `-off@` file copied from `-on@` without changing its
 * `Environment=` line is refused before any reading at all, instead of
 * restricting a site one wanted to make public.
 *
 * Anything that does not have exactly the expected form is refused, without
 * reading or writing anything: the slug ends up in paths written under root.
 *
 * Pure.
 */
import { isValidSlug } from "../../borrowed/manifest";

/** The general access each action leaves a site with. */
export type GeneralAccess = "public" | "restricted" | "code";

export type Action = "on" | "off" | "code" | "renew";

export const ACTIONS: readonly Action[] = ["on", "off", "code", "renew"];

export type Instance = { slug: string; action: Action };

/** What a site serves once the action succeeded: `renew` keeps the code, with another one. */
export function targetOf(action: Action): GeneralAccess {
  if (action === "on") return "restricted";
  if (action === "off") return "public";
  return "code";
}

/** The action that leaves a site with this general access, a new code when `renew`. */
export function actionFor(access: GeneralAccess, renew = false): Action {
  if (access === "restricted") return "on";
  if (access === "public") return "off";
  return renew ? "renew" : "code";
}

/** The common prefix of the templates, before `-<action>@`. */
export const UNIT_PREFIX = "sitesolide-gatekeeper";

/** Where the gatekeeper leaves results, backups and Caddy's lock. */
export const RUN_FOLDER = "/run/sitesolide-gatekeeper";

/**
 * Caddy's lock, common to the gatekeeper and to the workstation's tools
 * (`bin/deploy-caddy.sh`, `bin/generate-domains.sh`, `sitesolide deploy`). A directory,
 * created by `mkdir`, which is atomic; it carries a `holder` file.
 */
export const LOCK_NAME = "caddy.lock";
export const HOLDER_NAME = "holder";

/** The backups directory, one subdirectory per site. */
export const BACKUPS_NAME = "sauvegardes";

/** The unit to launch for this action, or null if the slug cannot go into it. */
export function gatekeeperUnit(slug: string, action: Action): string | null {
  if (!isValidSlug(slug) || !ACTIONS.includes(action)) return null;
  return `${UNIT_PREFIX}-${action}@${slug}.service`;
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
  if (!ACTIONS.includes(action as Action)) return { ok: false, reason: "GATEKEEPER_ACTION must be on, off, code or renew" };

  const name = argv[0]!;
  const found = /^sitesolide-gatekeeper-(on|off|code|renew)@([^@/]+)\.service$/.exec(name);
  if (found === null) {
    return { ok: false, reason: "unexpected unit name, expected sitesolide-gatekeeper-<on|off|code|renew>@<slug>.service" };
  }
  if (found[1] !== action) {
    return { ok: false, reason: `GATEKEEPER_ACTION=${action} does not match the ${found[1]} unit` };
  }
  const slug = found[2]!;
  if (!isValidSlug(slug)) return { ok: false, reason: "invalid slug in the unit name" };
  return { ok: true, instance: { slug, action: action as Action } };
}
