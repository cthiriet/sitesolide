/**
 * What each project's store lacks of what its manifest declares, read from
 * the steward's listing for the snapshot's discrepancies (src/routes.ts,
 * `withMissingSecrets` in src/state.ts), so that the Sites row, the sidebar's
 * badge and the verdict count what the Secrets section draws.
 *
 * Names only. They come from the steward's listing, `GET /projects`, which
 * the dashboard already reads with the session alone for the Secrets page
 * (src/secrets/store.ts `storeView`, "The listing" in dashboard/README.md),
 * and are read by the rule every side shares, `storeMissing` in
 * bin/cli/store-protocol.ts. That listing never carries a value, and nothing
 * here reads one.
 */
import { storeMissing, type StoreMissing, type StoreView } from "../../borrowed/store-protocol";
import type { ProjectView } from "./protocol";
import type { Steward } from "./client";

/** Each project's missing names, by slug, from the steward's listing; projects that lack none are left out. */
export function missingByProject(projects: readonly Pick<ProjectView, "slug" | "store">[]): Map<string, StoreMissing> {
  const found = new Map<string, StoreMissing>();
  for (const project of projects) {
    if (project.store === null || project.store === undefined) continue;
    const missing = storeMissing(project.store);
    if (missing.runtime.length + missing.files.length > 0) found.set(project.slug, missing);
  }
  return found;
}

/**
 * Reads the listing and keeps the missing names, or null when the steward
 * does not answer, or answers what this page cannot read: the snapshot then
 * goes out without them rather than late or not at all, and the Secrets page
 * says the steward is unreachable on its own.
 */
export async function readMissingSecrets(steward: Pick<Steward, "readProjects">): Promise<Map<string, StoreMissing> | null> {
  try {
    const response = await steward.readProjects();
    if (!response.ok) return null;
    const body = (await response.json()) as { projects?: unknown };
    if (!Array.isArray(body?.projects)) return null;
    const projects = body.projects.filter(
      (project): project is Pick<ProjectView, "slug" | "store"> =>
        typeof project === "object" &&
        project !== null &&
        typeof (project as ProjectView).slug === "string" &&
        isListedStore((project as ProjectView).store),
    );
    return missingByProject(projects);
  } catch {
    return null;
  }
}

/** A store as a listing carries it, or none: a steward older than the store sends no `store`. */
function isListedStore(store: unknown): boolean {
  if (store === null || store === undefined) return true;
  const view = store as Partial<StoreView>;
  return Array.isArray(view.missing) && view.missing.every((name) => typeof name === "string") && Array.isArray(view.files);
}
