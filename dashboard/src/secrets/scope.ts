/**
 * What the steward agrees to touch, and nothing else.
 *
 * Pure: receives the text of the manifests, the names present in the secrets
 * directory and the names asked for, returns a decision. The steward runs under root and writes
 * in /etc/sitesolide: every rule here is what separates "one of the
 * platform's own files" from "any file of the machine at all", and each one is
 * checked without a VM.
 *
 * ## The scope: the platform's own files
 *
 * A project keeps its secrets in its store, /etc/sitesolide/projects/<slug>/
 * (src/secrets/store.ts). Flat beside it, /etc/sitesolide holds the
 * platform's own files alone, each listed under the site that uses it
 * (PLATFORM_FILES): the dashboard's hash, the monitor's alerting addresses
 * and the backups' bucket under the dashboard, the portal's hash and sign-in
 * settings under the portal. Every other site lists none, and no other name
 * is ever written.
 *
 * A file is expected `site-portal` in 0600 for the portal's, root's for the
 * dashboard's three (ROOT_FILES).
 *
 * Inside, two more rules: `PASSWORD_HASH` changes only through `/password`, in
 * whatever file it may be, and `dashboard.env` and `portal.env` carry nothing
 * else (hash only), but for the portal's sign-in settings, named one by one.
 *
 * A refusal is a value, never an exception: an exception forgotten in a handler
 * would become a mute 500, a refusal is read and displayed.
 */
import { relative, resolve } from "node:path";
import { MACHINE_FOLDER } from "../../borrowed/backups";
import { isApp, readManifest, isValidSlug, type Manifest } from "../../borrowed/manifest";
import { PASSWORD_VARIABLE } from "../../borrowed/variables";
import { IDENTITY_VARIABLES } from "../../borrowed/sharing";
import { PASSWORD_MAX } from "../auth";
import { LANDING_FOLDER } from "../state";
import type { ErrorCode } from "./protocol";

/** Beyond that, it is no longer a secret's file name. */
export const MAX_FILE_NAME = 128;

/** The prefix of the landing's account, whose directory is the bare domain. */
export const LANDING_LABEL = "landing";

/** A site's account, as bin/cli/unit.ts generates it. */
export const ACCOUNT_PREFIX = "site-";

/**
 * The files allowed to belong to root, and expected so. Any other file
 * belonging to root is not a site's file.
 *
 * - `dashboard.env`, the dashboard's hash: its service receives it through
 *   `EnvironmentFile=`, which PID 1 reads as root, but must not be able to
 *   rewrite it.
 * - `dashboard-monitor.env`, the monitor's alerting addresses
 *   (monitor/README.md). Listed under the dashboard's site, where it is
 *   managed with the others, but neither the dashboard's service nor the
 *   monitor's account needs to read it: PID 1 hands it to the monitor. Owned by
 *   site-dashboard, a compromised dashboard would read the heartbeat's address
 *   without unlocking anything, and could ping it to hide that the machine is
 *   down.
 * - `dashboard-backup.env`, the backups' bucket and encryption passphrase,
 *   which the backup units read (dashboard/src/backup/README.md): listed under
 *   the dashboard's site, managed from its Secrets, and root's so that the
 *   dashboard's own account never reads them.
 */
export const ROOT_FILES = ["dashboard.env", "dashboard-monitor.env", "dashboard-backup.env"];

/**
 * The platform's own flat files, by the site that lists them. The first of
 * each is `<slug>.env`, which the site's unit reads (platformFile in
 * bin/cli/unit.ts): listed whether present or not, so that a missing one says
 * so. The others are listed once present: each is created by hand, once, on
 * the machine (monitor/README.md, dashboard/src/backup/README.md).
 */
export const PLATFORM_FILES: Readonly<Record<string, readonly string[]>> = {
  dashboard: ROOT_FILES,
  portal: ["portal.env"],
};

/**
 * The variable that changes only through `/password`, in every managed
 * environment file, the dashboard's, the portal's or a site's, and that a
 * project's store never holds.
 *
 * An argon2id hash does not give the password, but it is cracked offline, with
 * neither rate limiting nor log: showing it on the screen would amount to
 * giving it. Setting it by hand through `/variable` would write a hash that
 * nobody has checked against its password. And restoring it would make valid
 * again the password that has just been changed because it had leaked: a file
 * that carries one is never restored, and `/password` does not keep the old one
 * as a previous version.
 *
 * Defined in bin/cli/variables.ts, borrowed: the manifest's validation refuses
 * it as a declared name by the same constant.
 */
export { PASSWORD_VARIABLE };

/**
 * **Hash only**: the files that carry nothing other than `PASSWORD_HASH`, the
 * dashboard's and the portal's.
 *
 * Their services read all their configuration in the environment, and one more
 * variable there would change what they do rather than add a secret. In
 * `dashboard.env`, `STEWARD_SOCKET` would send the relay towards another
 * socket, which would receive the password of the next Unlock; `PORTAL_URL` or
 * `STATE_FILE` would break guest access or the snapshot. Another variable is
 * therefore refused when set, and a file that already carries one is out of
 * management.
 */
export const HASH_ONLY: readonly string[] = ["dashboard.env", "portal.env"];

/**
 * The one exception, by name and never by pattern: `portal.env` also carries
 * the settings of a sign-in with an identity provider, which the portal reads
 * in its environment like the rest, and of which the client secret is a real
 * secret. The list is the portal's own, borrowed: a name it does not read
 * cannot be written here, and `DATA_DIR` or `PORT` stay refused.
 */
export const HASH_FILE_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  "portal.env": IDENTITY_VARIABLES,
};

function isAllowedBesideHash(name: string, variable: string): boolean {
  return variable === PASSWORD_VARIABLE || (HASH_FILE_SETTINGS[name] ?? []).includes(variable);
}

/** Beyond that, the reason for a file out of management no longer quotes the names one by one. */
const MAX_QUOTED_NAMES = 3;

/**
 * A password chosen rather than drawn: sixteen characters at least, and no more
 * than what the sign-in of the dashboard and of the portal agree to submit,
 * failing which it would be set and could never be typed in again.
 */
export const MIN_PASSWORD = 16;

/** Any bigger, it is no longer a secret written by this dashboard. */
export const MAX_FILE_BYTES = 256 * 1024;

export type Refusal = { error: ErrorCode; message: string };

export type ProjectEntry = { folder: string; manifest: string | null };

/** Owner, group and mode a file must carry to be managed. */
export type Expected = { owner: string; group: string; mode: number };

export type Declaration = {
  /** The flat name under /etc/sitesolide, `portal.env`. */
  name: string;
  expected: Expected;
  passwords: string[];
};

export type Site = {
  /** The directory under /srv/sites. */
  folder: string;
  /** The dropped manifest, readable, even if it names another slug; null otherwise. */
  manifest: Manifest | null;
  /** A manifest that names this directory and declares no service: no unit. */
  isStatic: boolean;
  /** The platform's own files it lists, in PLATFORM_FILES's order; none for any other site. */
  files: Declaration[];
};

const outOfScope = (message: string): Refusal => ({ error: "out-of-scope", message });
const octal = (mode: number) => mode.toString(8).padStart(3, "0");

// --- The sites ---------------------------------------------------------------

/**
 * Is a directory of /srv/sites a site? A slug, or the landing's directory.
 * `landing` itself is not one: the CLI refuses that slug, and a directory of
 * that name would fight the landing over its account. Nor is
 * `machine`, the CLI refuses it too: it names the snapshots of the machine's
 * own state, its secrets among them, which no page lists or restores.
 */
export function isSiteFolder(folder: string): boolean {
  // The guard on the empty string is not decorative: with no declared zone,
  // LANDING_FOLDER is the empty string, and an empty name would pass for the
  // landing. That is exactly the name a malformed directory entry carries.
  if (folder === "") return false;
  if (folder === LANDING_FOLDER) return true;
  return isValidSlug(folder) && folder !== LANDING_LABEL && folder !== MACHINE_FOLDER;
}

/** The label that names a site's account. */
export function label(folder: string): string {
  return folder === LANDING_FOLDER ? LANDING_LABEL : folder;
}

export function siteAccount(folder: string): string {
  return `${ACCOUNT_PREFIX}${label(folder)}`;
}

// --- The names ---------------------------------------------------------------

const NAME_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * The shape of a name, before it is looked for among a site's files.
 *
 * The character set is deliberately narrow: `EnvironmentFile=` expands the
 * wildcards `*?[`, and a name that carried some would read files other than
 * itself. The checks of `/`, `..` and of the Unicode normalisation stay written
 * one by one, each with its message: they are what one looks for when re-reading
 * this file after an alert.
 */
export function nameRefusal(name: unknown): Refusal | null {
  if (typeof name !== "string") return { error: "invalid", message: "the file name must be a string" };
  if (name.length === 0 || name.length > MAX_FILE_NAME) return outOfScope("file name empty or too long");
  if (name.includes("\0")) return outOfScope("file name with a null byte");
  if (name.includes("\\")) return outOfScope("file name with a backslash");
  if (name.includes("..")) return outOfScope("file name with `..`");
  // A form that normalises differently designates, to the eye, another name.
  if (name.normalize("NFC") !== name) return outOfScope("file name not in Unicode normal form");
  if (name.includes("/")) return outOfScope("a flat file name, with no folder");
  if (name.startsWith(".")) return outOfScope("hidden file name");
  if (!NAME_SHAPE.test(name)) return outOfScope("file name with unexpected characters");
  return null;
}

/** The path of a flat name under `folder`, or null if it leaves it. */
export function pathUnder(folder: string, name: string): string | null {
  const root = resolve(folder);
  const path = resolve(root, name);
  const under = relative(root, path);
  if (under !== name || under === "" || under.startsWith("..") || under.includes("/")) return null;
  return path;
}

// --- The scope ---------------------------------------------------------------

/** The readable manifest of a directory, whatever slug it names. */
function manifestOf(text: string | null): Manifest | null {
  if (text === null) return null;
  // Readable is enough: a rule added to `validate()` since must not take an
  // already deployed site out of the scope. The fields that decide are checked
  // one by one.
  return readManifest(text).manifest ?? null;
}

/**
 * Every site, by directory, with the platform's own files it lists:
 * `<slug>.env` of the dashboard and the portal whether present or not, the
 * others of PLATFORM_FILES once present among `present`, the names in
 * /etc/sitesolide. Every other site lists none.
 */
export function readSites(entries: ProjectEntry[], present: readonly string[]): Map<string, Site> {
  const sites = new Map<string, Site>();
  for (const entry of [...entries].sort((a, b) => a.folder.localeCompare(b.folder))) {
    if (!isSiteFolder(entry.folder) || sites.has(entry.folder)) continue;
    const manifest = manifestOf(entry.manifest);
    const conforms = manifest !== null && manifest.slug === entry.folder;
    const own = PLATFORM_FILES[entry.folder] ?? [];
    const files = own.filter((name) => name === `${entry.folder}.env` || present.includes(name)).map((name) => declaration(name, entry.folder));
    sites.set(entry.folder, { folder: entry.folder, manifest, isStatic: conforms && !isApp(manifest), files });
  }
  return sites;
}

/** The mode a platform file is expected to carry: read by systemd as root, open to its owner alone. */
export const EXPECTED_MODE = 0o600;

function declaration(name: string, folder: string): Declaration {
  const account = ROOT_FILES.includes(name) ? "root" : siteAccount(folder);
  return { name, expected: { owner: account, group: account, mode: EXPECTED_MODE }, passwords: [PASSWORD_VARIABLE] };
}

/** `site-portal:site-portal 0600`, as the page displays it. */
export function expectedText(expected: Expected): string {
  return `${expected.owner}:${expected.group} ${octal(expected.mode).padStart(4, "0")}`;
}

export function checkSite(sites: Map<string, Site>, slug: unknown): { site: Site } | { refusal: Refusal } {
  if (typeof slug !== "string") return { refusal: { error: "invalid", message: "the site must be a string" } };
  const site = isSiteFolder(slug) ? sites.get(slug) : undefined;
  if (site === undefined) return { refusal: outOfScope("not a site deployed under /srv/sites") };
  return { site };
}

/**
 * The name, then the path. The path is recomputed and compared to the
 * directory, even if the shape of the name already forbids it: it is the only
 * rule that depends on no other to hold.
 */
export function checkFile(
  site: Site,
  name: unknown,
  secretsFolder: string,
): { declaration: Declaration; path: string } | { refusal: Refusal } {
  const refusal = nameRefusal(name);
  if (refusal !== null) return { refusal };
  const valid = name as string;

  const found = site.files.find((file) => file.name === valid);
  if (found === undefined) {
    return { refusal: outOfScope(`${valid} is not one of the platform's files that ${site.folder} lists`) };
  }

  const path = pathUnder(secretsFolder, valid);
  if (path === null) return { refusal: outOfScope("the path leaves the secrets folder") };
  return { declaration: found, path };
}

/** The reason for refusing a chosen password, or null. None of them quotes it. */
export function newPasswordReason(password: string): string | null {
  if (!password.isWellFormed()) return "the new password is not valid Unicode";
  if (password.length < MIN_PASSWORD) return `the new password must be at least ${MIN_PASSWORD} characters long`;
  if (password.length > PASSWORD_MAX) return `the new password must be at most ${PASSWORD_MAX} characters long`;
  return null;
}

/** The variables an ordinary route neither reads nor writes in this file. */
export function isPassword(declaration: Declaration, variable: unknown): boolean {
  return typeof variable === "string" && declaration.passwords.includes(variable);
}

/**
 * The refusal to set `variable` in a hash-only file, or null. `PASSWORD_HASH`
 * itself is not refused here: it is refused as a password.
 */
export function outsideHashRefusal(name: string, variable: unknown): Refusal | null {
  if (!HASH_ONLY.includes(name) || (typeof variable === "string" && isAllowedBesideHash(name, variable))) return null;
  const settings = HASH_FILE_SETTINGS[name] ?? [];
  const message =
    settings.length === 0
      ? `${name} holds ${PASSWORD_VARIABLE} only: any other variable would change how its service runs, not add a secret`
      : `${name} holds ${PASSWORD_VARIABLE} and ${settings.join(", ")} only: any other variable would change how its service runs, not add a secret`;
  return outOfScope(message);
}

/**
 * Why a hash-only file is not managed, or null. The names are quoted, never the
 * values, and the removal is done by hand: the steward does not touch a file
 * one of whose variables may already have diverted the service.
 */
export function outsideHashReason(name: string, names: readonly string[], path: string): string | null {
  if (!HASH_ONLY.includes(name)) return null;
  const foreign = names.filter((key) => !isAllowedBesideHash(name, key));
  if (foreign.length === 0) return null;
  const quoted = foreign.slice(0, MAX_QUOTED_NAMES).join(", ");
  const remaining = foreign.length > MAX_QUOTED_NAMES ? ` and ${foreign.length - MAX_QUOTED_NAMES} more` : "";
  return `holds variables other than ${PASSWORD_VARIABLE} (${quoted}${remaining}), which would change how its service runs: remove them by hand from ${path}`;
}

/**
 * The refusal to restore a file, or null, from the variable names of one
 * version: the current one, then the previous one. A hash-only file is refused
 * without reading anything, any other as soon as a version carries a password.
 * Restoring would swap the new hash for the one Change password had just
 * replaced, because it had leaked.
 */
export function restoreRefusal(declaration: Declaration, names: readonly string[]): Refusal | null {
  const door = HASH_ONLY.includes(declaration.name) || names.some((key) => declaration.passwords.includes(key));
  return door ? outOfScope("a password is only changed with Change password") : null;
}

// --- The state of a file that is present -------------------------------------

export type FileInfo = {
  link: boolean;
  regular: boolean;
  links: number;
  uid: number;
  gid: number;
  /** The permission bits, `& 0o7777`. */
  mode: number;
  size: number;
  modifiedAt: number;
};

export type FolderInfo = { link: boolean; folder: boolean; uid: number; mode: number };

/** The expected account of a file, as /etc/passwd gives it. */
export type Owner = { uid: number; gid: number };

/**
 * Why a file that is present is not managed, or null. Each reason says the
 * command that would make it manageable: the steward never changes the owner
 * nor the mode of an existing file, that is an act to be done by hand, knowing
 * why it differed.
 *
 * `real` null: no check of the account, for a test on the workstation where no
 * `site-<slug>` exists. The mode, for its part, is always compared, and
 * exactly: a secret more open than expected is no longer a secret, and a
 * private key more closed than expected would no longer be read by its service.
 */
export function unmanagedReason(info: FileInfo, expected: Expected, real: Owner | null, path: string): string | null {
  if (info.link) return "symbolic link";
  if (!info.regular) return "not a regular file";
  // A second link would make the rename write beside a file that somebody else
  // believes to be the same one.
  if (info.links > 1) return "several hard links";
  const account = `${expected.owner}:${expected.group}`;
  if (real !== null && info.uid !== real.uid) {
    return `owned by uid ${info.uid}, not ${expected.owner}: sudo chown ${account} ${path}`;
  }
  if (real !== null && info.gid !== real.gid) {
    return `group gid ${info.gid}, not ${expected.group}: sudo chgrp ${expected.group} ${path}`;
  }
  if (info.mode !== expected.mode) {
    return `mode ${octal(info.mode)}, expected ${octal(expected.mode)}: sudo chmod ${octal(expected.mode)} ${path}`;
  }
  if (info.size > MAX_FILE_BYTES) return "larger than 256 KiB";
  return null;
}

/**
 * Why a folder of a store is not traversed, or null. It must be a real
 * directory, root's, and closed to writing by other accounts: a project that
 * could write there would put a link in a file's place between two actions of
 * the steward. `uidRoot` null: no check of the account.
 */
export function folderReason(info: FolderInfo, uidRoot: number | null, path: string): string | null {
  if (info.link) return `${path} is a symbolic link`;
  if (!info.folder) return `${path} is not a folder`;
  if (uidRoot !== null && info.uid !== uidRoot) return `${path} is owned by uid ${info.uid}, not root: sudo chown root:root ${path}`;
  if ((info.mode & 0o022) !== 0) return `${path} is writable by other accounts: sudo chmod go-w ${path}`;
  return null;
}

/**
 * Why a previous version is not restored, or null.
 *
 * The previous version keeps the uid of the file it was replacing. A site
 * deleted then recreated under the same name receives another account, and
 * often another uid: without this check, restoring would give it its
 * predecessor's key. Not always: `useradd --system` gives the account removed
 * last its uid back, which is why the steward also drops a name's previous
 * version when it creates the file (steward.ts, `createFresh`).
 */
export function previousReason(info: FileInfo, expected: Owner | null, account: string): string | null {
  if (info.link || !info.regular || info.links > 1) return "the previous version is not a plain file";
  if (expected !== null && info.uid !== expected.uid) {
    return `the previous version belonged to uid ${info.uid}, not ${account}: an earlier site of the same name?`;
  }
  if (info.size > MAX_FILE_BYTES) return "the previous version is larger than 256 KiB";
  return null;
}
