/**
 * The projects the machine serves, as the backup component sees them: a
 * folder of /srv/sites, its account, its data folder, and whether it asks to be
 * left out. Read by root, which lists folders and their sizes, and never opens
 * a file inside a data folder: that is the copy's business, under the
 * project's own account.
 */
import { lstatSync, readdirSync, readFileSync, statfsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isBackupFolder } from "../../borrowed/backups";
import { isBackedUp, readManifest, type Manifest } from "../../borrowed/manifest";
import { isSiteFolder, siteAccount } from "../secrets/scope";
import { readAccount } from "../secrets/system";

export type Project = {
  folder: string;
  /** `site-<slug>`, `site-landing` for the landing's folder. */
  account: string;
  /** null when owners are not checked, on the workstation. */
  owner: { uid: number; gid: number } | null;
  dataDir: string;
  manifest: Manifest | null;
};

/** Why a project has no snapshot this time, on purpose. */
export type Exclusion = "opted out by its sitesolide.json" | "no data folder" | "empty data folder";

export type Found = { project: Project; excluded: Exclusion | null } | { folder: string; error: string };

/** A manifest has no reason to be bigger. */
const MAX_MANIFEST_BYTES = 256 * 1024;

function readText(path: string, max: number): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The account's ids from /etc/passwd, or null if it is not there. */
export function accountOf(accountsFile: string, account: string): { uid: number; gid: number } | null {
  const text = readText(accountsFile, 4 * 1024 * 1024);
  return text === null ? null : readAccount(text, account);
}

/** One project, read: its manifest, account and data folder. */
export function readProject(sitesDir: string, folder: string, accountsFile: string, checkOwners: boolean): Found {
  if (!isSiteFolder(folder) || !isBackupFolder(folder)) return { folder, error: "not a project folder" };
  const text = readText(join(sitesDir, folder, "sitesolide.json"), MAX_MANIFEST_BYTES);
  // Readable is enough, like the steward: a rule added to validate() since must
  // not take a deployed project out of its backups.
  const manifest = text === null ? null : (readManifest(text).manifest ?? null);
  const account = siteAccount(folder);
  const dataDir = join(sitesDir, folder, "data");

  // What leaves a project out on purpose, before its account: a static site
  // has neither a data folder nor an account, and is not an error.
  let excluded: Exclusion | null = null;
  if (manifest !== null && !isBackedUp(manifest)) excluded = "opted out by its sitesolide.json";
  let stat;
  try {
    stat = lstatSync(dataDir);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") return { folder, error: "the data folder cannot be read" };
    stat = null;
  }
  if (stat === null) excluded ??= "no data folder";
  // A link in the place of the data folder would have the copy read elsewhere.
  else if (stat.isSymbolicLink() || !stat.isDirectory()) return { folder, error: "the data folder is not a plain folder" };
  else {
    try {
      if (readdirSync(dataDir).length === 0) excluded ??= "empty data folder";
    } catch {
      return { folder, error: "the data folder cannot be read" };
    }
  }

  let owner: Project["owner"] = null;
  if (checkOwners) {
    owner = accountOf(accountsFile, account);
    // Only a project that has data to save, or to get back, needs its account.
    if (owner === null && stat !== null) return { folder, error: `account ${account} does not exist` };
  }
  return { project: { folder, account, owner, dataDir, manifest }, excluded };
}

/** Every project of the machine, in folder order. A folder that is not a project is not listed. */
export function listProjects(sitesDir: string, accountsFile: string, checkOwners: boolean): Found[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(sitesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSiteFolder(entry.name) && isBackupFolder(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((folder) => readProject(sitesDir, folder, accountsFile, checkOwners));
}

/**
 * What a folder weighs, from `lstat` alone: no file is opened. Links are not
 * followed and count for nothing, as the copy leaves them out.
 */
export function measure(folder: string, maxEntries = 2_000_000): number {
  let total = 0;
  let seen = 0;
  const stack = [folder];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > maxEntries) return total;
      const path = join(current, name);
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) stack.push(path);
        else if (stat.isFile()) total += stat.size;
      } catch {
        // gone in the meantime
      }
    }
  }
  return total;
}

/** The bytes an unprivileged writer could still put on this folder's disk. */
export function freeBytes(folder: string): number {
  const stat = statfsSync(folder);
  return Number(stat.bavail) * Number(stat.bsize);
}
