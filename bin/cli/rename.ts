/**
 * Renaming a project: what a new name must be, and how a checkout that still
 * carries the old one finds the project again.
 *
 * A project's slug is its only name, and the machine spells it everywhere: its
 * folder, its account, its units, its block, its store, its address. A rename
 * moves all of it on the machine, in one run of `sitesolide-rename@<slug>`
 * (dashboard/src/installer/rename.ts), asked for from the dashboard or by
 * `sitesolide rename`. The deposited manifest then carries the new slug and,
 * in `formerSlugs`, the old one: the machine is the source of truth, as for
 * `lock` and `portal`, and `deploy` from a checkout that still says the old
 * name rewrites its sitesolide.json rather than create the project again
 * under it.
 *
 * Pure, and borrowed by the dashboard: the steward, the rename run, the
 * installer and the CLI judge a name with this one copy.
 */
import { readManifest, setFormerSlugs, setSlug, slugRefusal } from "./manifest";

/**
 * The platform's own projects, which the platform's scripts find by name:
 * never renamed, and never a new name. `landing` and `www` already fail
 * slugRefusal.
 */
export const UNRENAMABLE = ["dashboard", "portal", "api"] as const;

/** The deposited manifests, by folder, as every reader of /srv/sites lists them. */
export type Deposited = ReadonlyMap<string, string>;

/** The folder whose deposited manifest lists `slug` among its former names, null when none does. */
export function renamedTo(deposited: Deposited, slug: string): string | null {
  for (const [folder, raw] of deposited) {
    if (folder === slug) continue;
    const { manifest } = readManifest(raw);
    if (manifest?.slug === folder && manifest.formerSlugs?.includes(slug) === true) return folder;
  }
  return null;
}

/**
 * Why `from` cannot be renamed `to` on a machine carrying `deposited`, null
 * when it can. `zone`: the served zone, whose bare name is the landing's
 * folder on an installation from before 0.14. The run checks the rest on the
 * machine itself, under the Caddy lock: the account, the units, the store
 * and the block of the new name must not exist either.
 */
export function renameRefusal(from: string, to: string, deposited: Deposited, zone: string): string | null {
  if ((UNRENAMABLE as readonly string[]).includes(from)) return `${from} is the platform's own and keeps its name`;
  const raw = deposited.get(from);
  if (raw === undefined) return `the machine carries no project named ${from}`;
  const { manifest, errors } = readManifest(raw);
  if (manifest === undefined || manifest.slug !== from) {
    return `/srv/sites/${from}/sitesolide.json does not read as ${from}'s (${errors.join("; ") || "another slug"}): the owner must look at it`;
  }
  if (to === from) return `${from} already has that name`;
  const refused = slugRefusal(to);
  if (refused !== null) return `the new name: ${refused}`;
  if ((UNRENAMABLE as readonly string[]).includes(to) || (zone !== "" && to === zone)) return `${to} is reserved for the platform: pick another name`;
  if (deposited.has(to)) return `${to} is already the name of a project on this machine`;
  const holder = renamedTo(deposited, to);
  if (holder !== null && holder !== from) {
    return `${to} is a former name of ${holder}, which a deployment from a checkout that still says ${to} reaches: pick another name`;
  }
  // The code's stanza, its cookie and its door page are all named after the
  // slug: the gatekeeper writes them, and the rename does not.
  if (manifest.lock === true) {
    return `${from} opens with a code: choose Public or Restricted in its Access section, rename it, then choose Anyone with the code again, which draws a new code`;
  }
  return null;
}

export type Followed = { kind: "same" } | { kind: "renamed"; to: string; text: string } | { kind: "former"; text: string };

/**
 * What a checkout's sitesolide.json becomes against the machine before a
 * deployment: `renamed` when the machine carries the project under another
 * slug that lists this one among its former names, the text then under that
 * slug; `former` when the project is there under this slug but its former
 * names differ, the machine's written in; `same` otherwise, a new project
 * included.
 */
export function followMachine(raw: string, slug: string, deposited: Deposited): Followed {
  const own = deposited.get(slug);
  if (own === undefined) {
    const to = renamedTo(deposited, slug);
    if (to === null) return { kind: "same" };
    const machine = readManifest(deposited.get(to)!).manifest!;
    return { kind: "renamed", to, text: setFormerSlugs(setSlug(raw, to), machine.formerSlugs) };
  }
  const machine = readManifest(own).manifest;
  const local = readManifest(raw).manifest;
  if (machine === undefined || local === undefined) return { kind: "same" };
  const wanted = machine.formerSlugs ?? [];
  const have = local.formerSlugs ?? [];
  if (wanted.length === have.length && wanted.every((name, i) => have[i] === name)) return { kind: "same" };
  return { kind: "former", text: setFormerSlugs(raw, machine.formerSlugs) };
}
