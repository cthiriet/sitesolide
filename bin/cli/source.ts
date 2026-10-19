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
 * `publicDir` keeps to the same repository, and the links among the public
 * files to the public folder itself: see publicRefusal and linksOut.
 *
 * Reads the disk, writes nothing.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";

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
  const escape = leaves(folder, code, sitesRepo);
  return escape === null ? null : `source leads outside the repository holding sitesolide.json: ${escape.target} is not under ${escape.root}`;
}

/** Where `path`, resolved, lands outside the repository holding the manifest in `folder`, or null when it may. */
function leaves(folder: string, path: string, sitesRepo: string | null): { target: string; root: string } | null {
  const manifestFolder = resolved(folder);
  if (sitesRepo !== null && isInside(manifestFolder, resolved(sitesRepo))) return null;
  const root = resolved(repositoryRoot(manifestFolder));
  const target = resolved(path);
  return isInside(target, root) ? null : { target, root };
}

/**
 * Why the public files of the manifest in `folder`, the folder `publicFolder`
 * its `publicDir` names, may not be sent, or null. The rule of `source`:
 * validate() refuses a `..` in `publicDir` (isInternalPath in manifest.ts),
 * but a link is no `..`, and a clone whose `public` was a link to
 * `../../.ssh` had the workstation's keys sent, over SSH as through the
 * dashboard, and served to anyone at the site's address. Resolved, links and
 * all, the folder stays inside the repository holding the manifest, unless
 * that manifest is in the owner's sites repository.
 */
export function publicRefusal(folder: string, publicFolder: string, sitesRepo: string | null): string | null {
  const escape = leaves(folder, publicFolder, sitesRepo);
  return escape === null ? null : `publicDir leads outside the repository holding sitesolide.json: ${escape.target} is not under ${escape.root}`;
}

/**
 * The links among the public files that lead out of them, `path -> target`,
 * the path relative to the folder, in the order of a walk, by name.
 *
 * rsync -a carries a link as a link, and on the machine Caddy serves the
 * folder as its own account and follows every link in it: `robots.txt ->
 * /etc/caddy/cloudflare.env` served the zone's DNS token, which Caddy's group
 * reads, and a link into /var/lib/caddy its private keys, from a static
 * site's repository someone cloned. A link to an absolute path, or one whose
 * `..` climb out of the folder, names something of the machine rather than of
 * the site, whoever wrote it; one that stays inside is the site's own, and
 * travels as it did. Through the dashboard no link travels at all: the
 * installer refuses them (bundle.ts).
 *
 * Where a link lands is where the kernel lands, not where its text reads: see
 * landing. A loop lands nowhere, and is named too.
 *
 * What `skip` excludes is never sent, and is not read: `.git` and `.env*`.
 */
export function linksOut(publicFolder: string, skip: (path: string, directory: boolean) => boolean = () => false): string[] {
  const root = resolved(publicFolder);
  const out: string[] = [];
  const visit = (relativeFolder: string): void => {
    const entries = readdirSync(join(root, relativeFolder), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const inner = relativeFolder === "" ? entry.name : `${relativeFolder}/${entry.name}`;
      if (skip(inner, entry.isDirectory())) continue;
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(join(root, inner));
        if (landing(root, relativeFolder === "" ? [] : relativeFolder.split("/"), target, 0) === null) out.push(`${inner} -> ${target}`);
      } else if (entry.isDirectory()) visit(inner);
    }
  };
  visit("");
  return out;
}

/** The kernel's own bound on the links one resolution follows (MAXSYMLINKS). */
const MAX_LINKS_FOLLOWED = 40;

/**
 * Where a link's text `target`, standing in the folder `from` of the public
 * tree under `root`, lands as the machine's kernel resolves it: the folders
 * under the public folder, or null when it leaves it, is absolute, or loops.
 *
 * Segment by segment, every link met on the way followed from where it
 * stands, as the kernel does, and never `..` read off the text: `up ->
 * ../../../..` four folders down lands on the public folder itself, and
 * `robots.txt -> a/b/c/d/up/../../../../etc/caddy/cloudflare.env` stays
 * inside as text while the kernel, from `up`, climbs the same four folders
 * out of /srv/sites/<slug>/public to /. rsync sends the tree as it is and
 * deletes what it did not send, so the machine's tree is this one: a name
 * missing here is missing there, a plain name, whose `..` the kernel would
 * refuse rather than climb.
 */
function landing(root: string, from: string[], target: string, followed: number): string[] | null {
  if (posix.isAbsolute(target) || followed > MAX_LINKS_FOLLOWED) return null;
  const at = [...from];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (at.length === 0) return null;
      at.pop();
      continue;
    }
    at.push(segment);
    let next: string | null = null;
    try {
      if (lstatSync(join(root, ...at)).isSymbolicLink()) next = readlinkSync(join(root, ...at));
    } catch {
      // Not there: a plain name, here as on the machine.
    }
    if (next === null) continue;
    const landed = landing(root, at.slice(0, -1), next, followed + 1);
    if (landed === null) return null;
    at.splice(0, at.length, ...landed);
  }
  return at;
}
