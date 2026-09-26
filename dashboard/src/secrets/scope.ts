/**
 * What the steward agrees to touch, and nothing else.
 *
 * Pure: receives the text of the manifests, the names present in the secrets
 * directory and the names asked for, returns a decision. The steward runs under root and writes
 * in /etc/sitesolide: every rule here is what separates "a site's file" from
 * "any file of the machine at all", and each one is checked without a VM.
 *
 * ## The scope: every deployed site
 *
 * A site is a directory of /srv/sites, static or app, the landing included.
 * Its files come from two sources brought together:
 *
 * - `secrets` from its manifest, environment files that the generated unit
 *   reads through `EnvironmentFile=`;
 * - the files present in /etc/sitesolide that carry its name, which is how a
 *   site no manifest describes, the landing or a hand-made service, keeps its
 *   files in the dashboard.
 *
 * Either way a file is expected `site-<slug>` in 0600, and root's for the
 * dashboard's hash alone. A registry embedded at build time used to say so
 * line by line; every line but that one repeated the rule, and it was dropped.
 *
 * A file is attached to a site by its name alone: `<slug>.env`,
 * `<slug>-<something>`, or `<slug>-secrets/<name>` for a subdirectory of a
 * single level. The landing is served from the zone's directory but its files
 * and its account carry the label `landing`, the only exception, already
 * written in src/state.ts.
 *
 * What is not a site stays outside: a name that no directory of /srv/sites
 * carries (`cloudflare.env`), a path outside /etc/sitesolide, and an owner
 * outside `site-*`, except `dashboard.env`, root's.
 *
 * Inside, two more rules: `PASSWORD_HASH` changes only through `/password`, in
 * whatever file it may be, and `dashboard.env` and `portal.env` carry nothing
 * else (hash only).
 *
 * A refusal is a value, never an exception: an exception forgotten in a handler
 * would become a mute 500, a refusal is read and displayed.
 */
import { relative, resolve } from "node:path";
import { isApp, readManifest, isValidSlug, type Manifest } from "../../borrowed/manifest";
import { PASSWORD_MAX } from "../auth";
import { LANDING_FOLDER } from "../state";
import type { ErrorCode, FileKind } from "./protocol";

/** Beyond that, it is no longer a secret's file name. */
export const MAX_FILE_NAME = 128;

/** The prefix of the landing's files and account, whose directory is the bare domain. */
export const LANDING_LABEL = "landing";

/** The only subdirectory allowed: `<slug>-secrets`, one level, never more. */
export const SUBFOLDER_SUFFIX = "-secrets";

/** A site's account, as bin/cli/unit.ts generates it. */
export const ACCOUNT_PREFIX = "site-";

/**
 * The files allowed to belong to root. The dashboard's hash alone: the
 * dashboard's service receives it through `EnvironmentFile=`, which PID 1 reads
 * as root, but must not be able to rewrite it. Any other file belonging to root
 * is not a site's file.
 */
export const ROOT_FILES = ["dashboard.env"];

/**
 * The variable that changes only through `/password`, in every managed
 * environment file, the dashboard's, the portal's or a site's.
 *
 * An argon2id hash does not give the password, but it is cracked offline, with
 * neither rate limiting nor log: showing it on the screen would amount to
 * giving it. Setting it by hand through `/variable` would write a hash that
 * nobody has checked against its password. And restoring it would make valid
 * again the password that has just been changed because it had leaked: a file
 * that carries one is never restored, and `/password` does not keep the old one
 * as a previous version.
 */
export const PASSWORD_VARIABLE = "PASSWORD_HASH";

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

/** What a replacement of content can write: an ssh key, a service account's JSON. */
export const MAX_CONTENT_BYTES = 64 * 1024;

export type Refusal = { error: ErrorCode; message: string };

export type ProjectEntry = { folder: string; manifest: string | null };

/** Owner, group and mode a file must carry to be managed. */
export type Expected = { owner: string; group: string; mode: number };

export type Declaration = {
  /** The path under /etc/sitesolide, `cms.env` or `<slug>-secrets/<name>`. */
  name: string;
  kind: FileKind;
  expected: Expected;
  /** False: write-only, never read back. */
  readable: boolean;
  passwords: string[];
};

export type Site = {
  /** The directory under /srv/sites. */
  folder: string;
  /** The dropped manifest, readable, even if it names another slug; null otherwise. */
  manifest: Manifest | null;
  /** A manifest that names this directory and declares no service: no unit. */
  isStatic: boolean;
  /** In the manifest's order, then the secrets directory's. */
  files: Declaration[];
};

const outOfScope = (message: string): Refusal => ({ error: "out-of-scope", message });
const octal = (mode: number) => mode.toString(8).padStart(3, "0");

// --- The sites ---------------------------------------------------------------

/**
 * Is a directory of /srv/sites a site? A slug, or the landing's directory.
 * `landing` itself is not one: the CLI refuses that slug, and a directory of
 * that name would fight the landing over the `landing-*` files.
 */
export function isSiteFolder(folder: string): boolean {
  // The guard on the empty string is not decorative: with no declared zone,
  // LANDING_FOLDER is the empty string, and an empty name would pass for the
  // landing. That is exactly the name a malformed directory entry carries.
  if (folder === "") return false;
  if (folder === LANDING_FOLDER) return true;
  return isValidSlug(folder) && folder !== LANDING_LABEL;
}

/** The label that prefixes a site's files and account. */
export function label(folder: string): string {
  return folder === LANDING_FOLDER ? LANDING_LABEL : folder;
}

export function siteAccount(folder: string): string {
  return `${ACCOUNT_PREFIX}${label(folder)}`;
}

// --- The names ---------------------------------------------------------------

const COMPONENT_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * The shape of a name, without looking at which site it belongs to.
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

  const components = name.split("/");
  if (components.length > 2) return outOfScope("more than one folder level");
  for (const component of components) {
    if (component === "") return outOfScope("file name with an empty path component");
    if (component.startsWith(".")) return outOfScope("hidden file name");
    if (!COMPONENT_SHAPE.test(component)) return outOfScope("file name with unexpected characters");
  }
  if (components.length === 2) {
    const folder = components[0]!;
    const prefix = folder.slice(0, -SUBFOLDER_SUFFIX.length);
    if (!folder.endsWith(SUBFOLDER_SUFFIX) || !isValidSlug(prefix)) {
      return outOfScope(`a subfolder must be named <site>${SUBFOLDER_SUFFIX}`);
    }
  }
  return null;
}

/** A name's subdirectory, `<slug>-secrets`, or null for a flat file. */
export function subFolderOf(name: string): string | null {
  const slash = name.indexOf("/");
  return slash === -1 ? null : name.slice(0, slash);
}

/** `.env`: a file systemd reads variable by variable. The rest is managed as one block. */
export function kindOf(name: string): FileKind {
  return name.endsWith(".env") ? "variables" : "content";
}

/**
 * The sites whose name the prefix carries, among the given directories. One
 * name can designate several of them: `cms-tool.env` is both a `cms-*` and the
 * `.env` of `cms-tool`. It is for the caller to decide.
 */
export function candidates(name: string, folders: Iterable<string>): string[] {
  const subFolder = subFolderOf(name);
  const found: string[] = [];
  for (const folder of folders) {
    if (!isSiteFolder(folder)) continue;
    const e = label(folder);
    const suits =
      subFolder !== null ? subFolder === `${e}${SUBFOLDER_SUFFIX}` : name === `${e}.env` || name.startsWith(`${e}-`);
    if (suits) found.push(folder);
  }
  return found.sort();
}

/** The path of a name under `folder`, at exactly one or two levels, or null if it leaves it. */
export function pathUnder(folder: string, name: string): string | null {
  const root = resolve(folder);
  const path = resolve(root, name);
  const under = relative(root, path);
  if (under !== name || under === "" || under.startsWith("..")) return null;
  const depth = under.split("/").length;
  if (depth < 1 || depth > 2) return null;
  return path;
}

// --- Modes ---------------------------------------------------------------------

/**
 * The mode allowed for a secret: readable by its owner, with no special bit, no
 * execution, never writable by the group nor by the others. An environment file
 * moreover opens to nobody else: systemd reads it under root, the service does
 * not need it. A public key in 0444 gets through, a private key in 0644 does
 * not.
 */
export function isAllowedMode(mode: number, kind: FileKind): boolean {
  if ((mode & 0o400) === 0) return false;
  if ((mode & 0o7133) !== 0) return false;
  return kind === "content" || (mode & 0o077) === 0;
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
 * A name a manifest can declare: a flat environment file, since the generated
 * unit reads it through `EnvironmentFile=/etc/sitesolide/<name>`.
 */
export function manifestName(name: unknown): name is string {
  return nameRefusal(name) === null && subFolderOf(name as string) === null && kindOf(name as string) === "variables";
}

/**
 * Every site, by directory, with its files.
 *
 * The attachment of a name to a site:
 *
 * - declared by the manifest of a single one of the sites whose prefix it
 *   carries: that one. Declared by several, it belongs to none, the steward not
 *   knowing which one must own it;
 * - declared by no manifest but present in the secrets directory: the most
 *   specific site whose name it carries, `cms-tool.env` going to `cms-tool`
 *   when that site exists and to `cms` otherwise;
 * - neither: out of the scope, like any name no site carries.
 */
export function readSites(entries: ProjectEntry[], present: readonly string[]): Map<string, Site> {
  const sites = new Map<string, Site>();
  const declaring = new Map<string, string[]>();
  const order: string[] = [];
  const note = (name: string) => {
    if (!order.includes(name)) order.push(name);
  };

  for (const entry of [...entries].sort((a, b) => a.folder.localeCompare(b.folder))) {
    if (!isSiteFolder(entry.folder) || sites.has(entry.folder)) continue;
    const manifest = manifestOf(entry.manifest);
    const conforms = manifest !== null && manifest.slug === entry.folder;
    sites.set(entry.folder, {
      folder: entry.folder,
      manifest,
      isStatic: conforms && !isApp(manifest),
      files: [],
    });

    // Only an app site has a unit that reads its `secrets`.
    if (!conforms || !isApp(manifest) || !Array.isArray(manifest.secrets)) continue;
    for (const name of manifest.secrets as unknown[]) {
      if (!manifestName(name)) continue;
      const enumerate = declaring.get(name) ?? [];
      if (!enumerate.includes(entry.folder)) enumerate.push(entry.folder);
      declaring.set(name, enumerate);
      note(name);
    }
  }

  const onDisk = new Set<string>();
  for (const name of present) {
    if (nameRefusal(name) !== null) continue;
    onDisk.add(name);
    note(name);
  }

  const folders = [...sites.keys()];
  for (const name of order) {
    const possible = candidates(name, folders);
    const fromManifest = (declaring.get(name) ?? []).filter((folder) => possible.includes(folder));

    let folder: string | undefined;
    if (fromManifest.length > 0) {
      if (fromManifest.length > 1) continue;
      folder = fromManifest[0];
    } else if (onDisk.has(name)) {
      folder = mostSpecific(possible);
    }
    const site = folder === undefined ? undefined : sites.get(folder);
    if (site === undefined) continue;
    site.files.push(declaration(name, site.folder));
  }

  return sites;
}

/** The site with the longest label, the most specific of those a name could belong to. */
function mostSpecific(folders: readonly string[]): string | undefined {
  return [...folders].sort((a, b) => label(b).length - label(a).length || a.localeCompare(b))[0];
}

/**
 * The mode a file is expected to carry, from its name. An environment file is
 * read by systemd as root and opens to its owner alone. A secret's content is
 * never rewritten in place, so it is read-only, and a public key, the only
 * content meant to be shown, is readable by everyone.
 */
export function expectedMode(name: string): number {
  if (kindOf(name) === "variables") return 0o600;
  return name.endsWith(".pub") ? 0o444 : 0o400;
}

function declaration(name: string, folder: string): Declaration {
  const kind = kindOf(name);
  const account = ROOT_FILES.includes(name) ? "root" : siteAccount(folder);
  const expected: Expected = { owner: account, group: account, mode: expectedMode(name) };
  return {
    name,
    kind,
    expected,
    readable: kind === "variables" || (expected.mode & 0o004) !== 0,
    passwords: kind === "variables" ? [PASSWORD_VARIABLE] : [],
  };
}

/** `site-cms:site-cms 0600`, as the page displays it. */
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
    return { refusal: outOfScope(`${valid} is declared neither in the sitesolide.json of ${site.folder} nor in secrets/destinations.conf`) };
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
  if (!HASH_ONLY.includes(name) || variable === PASSWORD_VARIABLE) return null;
  const message = `${name} holds ${PASSWORD_VARIABLE} only: any other variable would change how its service runs, not add a secret`;
  return outOfScope(message);
}

/**
 * Why a hash-only file is not managed, or null. The names are quoted, never the
 * values, and the removal is done by hand: the steward does not touch a file
 * one of whose variables may already have diverted the service.
 */
export function outsideHashReason(name: string, names: readonly string[], path: string): string | null {
  if (!HASH_ONLY.includes(name)) return null;
  const foreign = names.filter((key) => key !== PASSWORD_VARIABLE);
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
 * Why a file's subdirectory is not traversed, or null. It must be a real
 * directory, root's, and closed to writing by other accounts: a site that could
 * write there would put a link in the file's place between two actions of the
 * steward. `uidRoot` null: no check of the account.
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
 * therefore another uid: without this check, restoring would give it its
 * predecessor's key.
 */
export function previousReason(info: FileInfo, expected: Owner | null, account: string): string | null {
  if (info.link || !info.regular || info.links > 1) return "the previous version is not a plain file";
  if (expected !== null && info.uid !== expected.uid) {
    return `the previous version belonged to uid ${info.uid}, not ${account}: an earlier site of the same name?`;
  }
  if (info.size > MAX_FILE_BYTES) return "the previous version is larger than 256 KiB";
  return null;
}

// --- The content of a file managed as one block ------------------------------

/**
 * The text of a `content` file, or the reason to leave it out of management.
 * Strict UTF-8 and with no null byte: what cannot be read back as text would
 * not be rewritten identically from the page. The byte order mark is kept, so
 * that text and bytes correspond one for one.
 */
export function readContent(bytes: Uint8Array): { text: string } | { reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { reason: "not valid UTF-8 text" };
  }
  if (text.includes("\0")) return { reason: "contains a null byte" };
  return { text };
}

/** The reason for refusing a submitted content, or null. None of them quotes the content. */
export function checkContent(content: string): string | null {
  if (!content.isWellFormed()) return "the content is not valid Unicode";
  if (content.includes("\0")) return "the content contains a null byte";
  if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) return "the content is larger than 64 KiB";
  return null;
}
