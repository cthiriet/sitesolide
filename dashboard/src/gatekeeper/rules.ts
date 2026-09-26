/**
 * What the gatekeeper agrees to change, said only once.
 *
 * The steward reads it to fill `PortalView.modifiable` before calling the
 * gatekeeper, and the gatekeeper re-reads it at the moment of the transaction:
 * the page shows the answer, it does not copy the rule.
 *
 * Pure: a slug and an already-read manifest, no disk reading at all.
 */
import { PORTAL_SLUG, isProtected, validate, type Manifest } from "../../borrowed/manifest";

/**
 * The dashboard does not close itself behind the portal: if the portal falls,
 * it keeps a closed door that nobody can reopen from the dashboard any more,
 * and it is precisely the dashboard that serves to notice it.
 */
export const DASHBOARD_SLUG = "dashboard";

export type Modifiable = { modifiable: boolean; reason: string | null };

/**
 * The refusals that do not depend on the action: the portal itself, the
 * dashboard, a site with no readable manifest (the landing), an already
 * invalid manifest. null if nothing stands in the way.
 */
export function fixedRefusal(slug: string, manifest: Manifest | null): string | null {
  if (slug === PORTAL_SLUG) return "the portal cannot sit behind itself";
  if (slug === DASHBOARD_SLUG) return "the dashboard must stay reachable if the portal fails";
  // The landing has no manifest: the CLI does not deploy it, and an
  // unreadable manifest is not rewritten.
  if (manifest === null) return "no readable sitesolide.json on the server";
  if (manifest.slug !== slug) return "sitesolide.json names another slug";
  const errors = validate(manifest);
  if (errors.length > 0) return `sitesolide.json is invalid: ${errors[0]}`;
  return null;
}

/**
 * The refusals from `validate()` that putting the door up can trigger, said as
 * the page must say them: what would have to be changed, not the rule broken.
 */
const REASONS: [prefix: string, reason: string][] = [
  ["portal: only a project with `start`", "a static site cannot sit behind the portal yet"],
  ["portal: a site behind the portal needs no preview lock", "remove the preview lock first: bin/lock.sh disable"],
  ["portal: not yet on a customer domain", "not on a customer domain, only under the served zone"],
];

/**
 * Does the manifest the action would produce pass `validate()`? null if it
 * passes. Judged on the object, with the same key that `setPortal` writes or
 * removes: the transaction then re-reads the rewritten text, and the two must
 * say the same thing.
 */
export function actionRefusal(manifest: Manifest, active: boolean): string | null {
  const { portal: _previous, ...remaining } = manifest;
  const next: Manifest = active ? { ...remaining, portal: true } : remaining;
  const errors = validate(next);
  if (errors.length === 0) return null;
  const first = errors[0]!;
  const known = REASONS.find(([prefix]) => first.startsWith(prefix));
  return known?.[1] ?? `sitesolide.json would be invalid: ${first}`;
}

/**
 * Is the possible action permitted? Putting the door up if it is missing,
 * taking it away if it is there: that is the only one the page offers.
 */
export function portalModifiable(slug: string, manifest: Manifest | null): Modifiable {
  const reason = fixedRefusal(slug, manifest) ?? actionRefusal(manifest!, !isProtected(manifest!));
  return reason === null ? { modifiable: true, reason: null } : { modifiable: false, reason };
}
