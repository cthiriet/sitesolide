/**
 * Where a manifest's `source` may lead, before anything is built or sent.
 *
 * `source` names the folder whose content leaves when the code lives in a
 * repository of its own: the manifest stays in the owner's sites repository,
 * and points at it, `../../mini-lab`. validate() keeps it relative and never
 * absolute (isSourcePath in manifest.ts); it cannot know where a climb ends.
 *
 * A manifest found anywhere else is someone else's text: a repository just
 * cloned, a folder an agent was handed. Its `source` climbing out of its own
 * repository, `../../.ssh` or `../../..`, would make deploy run its build
 * there and upload that folder, over SSH or to the dashboard, where the
 * project's service and its token's holder read it. Such a manifest may
 * therefore only point inside the repository that holds it: the git
 * repository around its folder, or the folder itself when there is none.
 * Links are resolved first, so that one inside cannot lead outside.
 *
 * Reads the disk, writes nothing.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** The root of the git repository holding `folder`, or the folder itself when none does. */
export function repositoryRoot(folder: string): string {
  let current = folder;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return folder;
    current = parent;
  }
}

/** Is `path` `root` or under it? Both absolute and resolved. */
export function isInside(path: string, root: string): boolean {
  const climb = relative(root, path);
  return climb === "" || (climb !== ".." && !climb.startsWith(`..${sep}`) && !isAbsolute(climb));
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Why `code`, the folder a manifest in `folder` names through `source`, may
 * not be followed, or null. `sitesRepo` is the owner's sites repository, from
 * the configuration: a manifest there is the owner's, and may point anywhere.
 */
export function sourceRefusal(folder: string, code: string, sitesRepo: string | null): string | null {
  const manifestFolder = resolved(folder);
  if (sitesRepo !== null && isInside(manifestFolder, resolved(sitesRepo))) return null;
  const root = resolved(repositoryRoot(manifestFolder));
  const target = resolved(code);
  if (isInside(target, root)) return null;
  return `source leads outside the repository holding sitesolide.json: ${target} is not under ${root}`;
}
