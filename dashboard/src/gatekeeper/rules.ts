/**
 * What the gatekeeper agrees to change, said only once.
 *
 * The steward reads it to say, before calling the gatekeeper, which of the
 * three general accesses a site may take, and the gatekeeper re-reads it at
 * the moment of the transaction: the page shows the answer, it does not copy
 * the rule.
 *
 * Pure: a slug and an already-read manifest, no disk reading at all.
 */
import { PORTAL_SLUG, isProtected, validate, type Manifest } from "../../borrowed/manifest";
import type { GeneralAccess } from "./instance";

/**
 * The dashboard does not close itself behind the portal, nor behind a code:
 * if the portal falls, it keeps a closed door that nobody can reopen from the
 * dashboard any more, and it is precisely the dashboard that serves to notice
 * it.
 */
export const DASHBOARD_SLUG = "dashboard";

export type Modifiable = { modifiable: boolean; reason: string | null };

/** For each general access, null when the site may take it, otherwise why not. */
export type Choices = Record<GeneralAccess, string | null>;

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
 * The refusals from `validate()` that a general access can trigger, said as
 * the page must say them: what would have to be changed, not the rule broken.
 */
const REASONS: [prefix: string, reason: string][] = [["portal: only a project with `start`", "a static site cannot be restricted yet"]];

/** How the manifest says the site opens: the portal, the code, or neither. */
export function manifestAccess(manifest: Manifest): GeneralAccess {
  if (isProtected(manifest)) return "restricted";
  return manifest.lock === true ? "code" : "public";
}

/**
 * The manifest a general access leaves, judged on the object: `portal` and
 * `lock` as the target wants them, the same keys `setPortal` and `setLock`
 * write or remove. The manifest refuses the two together, so a switch between
 * Restricted and the code changes both at once.
 */
export function targetManifest(manifest: Manifest, target: GeneralAccess): Manifest {
  const { portal: _portal, lock: _lock, ...remaining } = manifest;
  if (target === "restricted") return { ...remaining, portal: true };
  if (target === "code") return { ...remaining, lock: true };
  return remaining;
}

/**
 * Does the manifest the target would produce pass `validate()`? null if it
 * passes.
 *
 * A site's own domain is no reason to refuse: it closes with the preview, the
 * code and the portal alike, and the gatekeeper checks both addresses before
 * it says so (see bin/cli/fragment.ts and api/src/locks.ts).
 */
export function targetRefusal(manifest: Manifest, target: GeneralAccess): string | null {
  const errors = validate(targetManifest(manifest, target));
  if (errors.length === 0) return null;
  const first = errors[0]!;
  const known = REASONS.find(([prefix]) => first.startsWith(prefix));
  return known?.[1] ?? `sitesolide.json would be invalid: ${first}`;
}

/** The three general accesses, each with why the site may not take it, null when it may. */
export function generalChoices(slug: string, manifest: Manifest | null): Choices {
  const fixed = fixedRefusal(slug, manifest);
  const judge = (target: GeneralAccess) => fixed ?? targetRefusal(manifest!, target);
  return { public: judge("public"), restricted: judge("restricted"), code: judge("code") };
}

/**
 * Between Public and Restricted, the change the secrets page offers: putting
 * the portal up where it is missing, taking it away where it is there. A site
 * that opens with a code is restricted from here, its code taken away in the
 * same transaction.
 */
export function portalModifiable(slug: string, manifest: Manifest | null): Modifiable {
  const reason = fixedRefusal(slug, manifest) ?? targetRefusal(manifest!, isProtected(manifest!) ? "public" : "restricted");
  return reason === null ? { modifiable: true, reason: null } : { modifiable: false, reason };
}
