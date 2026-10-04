/**
 * The projects the machine serves, as the backup component sees them: a
 * folder of /srv/sites, its account, its data folder, and whether it asks to be
 * left out. Read by root, which never opens a file inside a data folder, nor
 * walks one: that is the copy's business, under the project's own account,
 * measuring included (copy.ts, measureData).
 *
 * **Root lists no data folder.** A project can put millions of names in its
 * folder; root listing them would build them all in memory, under a unit
 * whose MemoryMax keeps every project's snapshot, and would be killed before
 * writing its status, every hour. The projects are read one at a time, as the
 * run reaches them, never all up front, and whether a data folder is empty is
 * asked of `find`, which stops at the first name (isEmptyFolder).
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
      if (isEmptyFolder(dataDir)) excluded ??= "empty data folder";
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

/** Where `find` is, on Debian as on the workstation: an absolute path, nothing looked up. */
export const FIND = "/usr/bin/find";

/**
 * True if the folder holds nothing. Asked of `find`, which stops at the first
 * name it meets (`-quit`), follows no link (its default, `-P`), and does not
 * descend (`-maxdepth 1`).
 *
 * Not `opendirSync` and its entries one at a time: measured on 4 October 2026
 * with Bun 1.3.11, on a folder of 100,000 names of 240 bytes, `opendirSync`
 * then one `readSync` raised the peak memory by 52 MB, more than
 * `readdirSync` itself (37 MB): Bun's `Dir` lists the whole folder on its
 * first read. `Bun.Glob` did the same (67 MB). Through `find`, the reading
 * cost this process under 2 MB. `find` itself, GNU's on the machine, reads a
 * folder by batches of 100,000 names at most (gnulib's fts) and stops at the
 * first: some tens of megabytes at worst, for an instant, in the unit's
 * cgroup. Its output is one path at most, and only its presence counts.
 */
export function isEmptyFolder(path: string): boolean {
  const found = Bun.spawnSync([FIND, path, "-mindepth", "1", "-maxdepth", "1", "-print", "-quit"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 60_000,
  });
  if (found.exitCode !== 0) throw new Error(`find could not read the folder (exit code ${found.exitCode})`);
  return found.stdout.byteLength === 0;
}

/**
 * The project folders of the machine, in order, by name alone: /srv/sites
 * belongs to the deployment account, its entries are the projects, not
 * anything a project writes. Each is read with readProject when its turn
 * comes. A folder that is not a project is not listed.
 */
export function projectFolders(sitesDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(sitesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSiteFolder(entry.name) && isBackupFolder(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** The bytes an unprivileged writer could still put on this folder's disk. */
export function freeBytes(folder: string): number {
  const stat = statfsSync(folder);
  return Number(stat.bavail) * Number(stat.bsize);
}
