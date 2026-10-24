/**
 * A project's store of secrets on the machine: where it lives, what bounds
 * it, the lines a unit reads it with, and the command that lays its folders.
 *
 *   /etc/sitesolide/projects/<slug>/          root:root 0700
 *   /etc/sitesolide/projects/<slug>/env       root:root 0600, the runtime variables
 *   /etc/sitesolide/projects/<slug>/files/    root:root 0700
 *   /etc/sitesolide/projects/<slug>/files/<n> root:root 0600, a file read whole
 *
 * No account but root reads it: PID 1 hands a service its variables through
 * `EnvironmentFile=` and its files through `LoadCredential=`, which gives the
 * service a private copy, `$CREDENTIALS_DIRECTORY/files_<name>`, owned by
 * `site-<slug>`, mode 0400 (measured on Debian 13 and systemd 257.13, the
 * bench's Q1 to Q8).
 *
 * Pure: the CLI, the steward and the installer read it, the dashboard through
 * its borrowed copy. Nothing here touches the disk or the network.
 */
import { isValidFileName, isValidSlug, STORELESS_SLUGS } from "./manifest";

/** The machine's folder of secrets, root's, 0755: the stores' root, and the platform's own flat files beside it. */
export const SECRETS_FOLDER = "/etc/sitesolide";
export const STORE_ROOT = "/etc/sitesolide/projects";
/** One previous version of the store's env and of each file, kept by the steward before each write. */
export const STORE_PREVIOUS_ROOT = "/var/lib/sitesolide-steward/precedents/projects";
export const STORE_FOLDER_MODE = 0o700;
export const STORE_FILE_MODE = 0o600;

/** The env file, the steward's `MAX_FILE_BYTES`: a value is 8 KiB at most, see MAX_VALUE_BYTES in ./variables. */
export const MAX_STORE_ENV_BYTES = 256 * 1024;
export const MAX_STORE_FILE_BYTES = 64 * 1024;
export const MAX_STORE_FILES_BYTES = 512 * 1024;
export const MAX_STORE_FILES = 32;

export type StorePaths = { folder: string; env: string; files: string };

/** Throws on a slug that is not valid: no path is ever built from one. */
export function storePaths(slug: string, root: string = STORE_ROOT): StorePaths {
  if (typeof slug !== "string" || !isValidSlug(slug)) throw new Error("not a project's slug: no store path is built from it");
  const folder = `${root}/${slug}`;
  return { folder, env: `${folder}/env`, files: `${folder}/files` };
}

/** Throws on a slug or a file name that is not valid. */
export function storeFilePath(slug: string, name: string, root: string = STORE_ROOT): string {
  const { files } = storePaths(slug, root);
  if (!isValidFileName(name)) throw new Error("not a store file's name: no path is built from it");
  return `${files}/${name}`;
}

/** A slug that may have a store: valid and not storeless. Does not say it is an app. */
export function slugHasStore(slug: string): boolean {
  return typeof slug === "string" && isValidSlug(slug) && !STORELESS_SLUGS.includes(slug);
}

// --- What a unit reads --------------------------------------------------------

/**
 * The value of the `EnvironmentFile=` line every service unit of an app with
 * a store carries. Optional: a store with no `env` yet starts the service
 * with none of its variables, and no error (bench Q3).
 */
export function storeEnvironmentFile(slug: string): string {
  return `-${storePaths(slug).env}`;
}

/** systemd's credential id for a store file: the folder form prefixes it (bench Q1). */
export const CREDENTIAL_ID = "files";

/**
 * The value of the `LoadCredential=` line of every service unit of an app
 * with a store, and of its backup commands' transient units: the folder
 * form, which loads each regular file of the folder as `files_<name>`. It has
 * no optional form outside /etc/credstore, so the folder always exists
 * (bench Q2): see storePrepareCommand.
 */
export function storeCredentials(slug: string): string {
  return `${CREDENTIAL_ID}:${storePaths(slug).files}`;
}

/**
 * The lines that follow, in every service unit of an app with a store: the
 * secrets folder hidden from the service, which receives its variables and
 * files from PID 1 (bench Q3), and the processes of other accounts hidden too
 * (bench Q4; those of the project's other services stay visible).
 */
export const STORE_UNIT_LINES_AFTER: readonly string[] = [`InaccessiblePaths=-${SECRETS_FOLDER}`, "ProtectProc=invisible"];

/** `files_<name>`: what the service finds under $CREDENTIALS_DIRECTORY. */
export function credentialName(file: string): string {
  return `${CREDENTIAL_ID}_${file}`;
}

/** The credentials tmpfs of a unit: sizes and ids together at most this many bytes (bench Q7). */
export const CREDENTIALS_TMPFS_BYTES = 1_048_576;
/** And at most this many pages, each file taking one at least (bench Q7). */
export const CREDENTIALS_TMPFS_PAGES = 256;
export const CREDENTIALS_PAGE_BYTES = 4096;

/**
 * systemd's budget for a unit's credentials (bench Q7): null when these
 * files fit, the refusal otherwise. Past either limit, every start of every
 * service of the project fails with 243. Says no size: a file's size is the
 * owner's alone to see.
 */
export function credentialBudgetRefusal(files: readonly { name: string; size: number }[]): string | null {
  const encoder = new TextEncoder();
  let bytes = 0;
  let pages = 0;
  for (const { name, size } of files) {
    bytes += size + encoder.encode(credentialName(name)).length;
    pages += Math.max(1, Math.ceil(size / CREDENTIALS_PAGE_BYTES));
  }
  if (bytes <= CREDENTIALS_TMPFS_BYTES && pages <= CREDENTIALS_TMPFS_PAGES) return null;
  return `the project's files would not fit in what systemd loads for a unit, 1 MiB with their names and ${CREDENTIALS_TMPFS_PAGES} pages of 4 KiB, one at least per file: every start of the project would fail with 243/CREDENTIALS`;
}

/**
 * The longest line of the env file a start takes: one byte more and the start
 * fails with 203/EXEC, "Argument list too long" (bench Q7: 131,072 bytes
 * fail, 131,000 start). The 8 KiB a value may hold keep every line far below.
 */
export const MAX_ENV_LINE_BYTES = 131_071;

/** The exit status of a unit whose credentials could not be set up (bench Q2). */
export const CREDENTIALS_EXIT_STATUS = 243;

/**
 * How every reader of a unit's exit status words 243: systemd logs it as
 * "Failed to set up credentials: Protocol error", which sends one looking
 * elsewhere.
 */
export function credentialsFailure(unit: string, slug: string): string {
  return `${unit} could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh ${slug} lays the folder again`;
}

// --- Generate ----------------------------------------------------------------

export type GenerateFormat = "hex" | "base64url";
export const GENERATE_FORMATS: readonly GenerateFormat[] = ["hex", "base64url"];
export const GENERATE_DEFAULT_BYTES = 32;
export const GENERATE_MIN_BYTES = 16;
export const GENERATE_MAX_BYTES = 64;

/**
 * Random bytes as a value: lowercase hex, or base64url without padding. Both
 * alphabets are written bare in an env file, and read back identically.
 */
export function encodeGenerated(bytes: Uint8Array, format: GenerateFormat): string {
  if (format === "hex") return bytes.toHex();
  if (format === "base64url") return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  throw new Error("unknown format");
}

// --- Laying the folders ------------------------------------------------------

export const STORE_READY = "STORE-READY";
export const STORE_REFUSED = "STORE-REFUSED";

/** The exit status of the prepare command when a folder is a link or no folder. */
const REFUSED_EXIT = 3;

/**
 * The root shell deploy and refresh run to lay the store's folders, before
 * the units are laid and before any restart: without `files/`, every start of
 * every service of the project fails with 243 (bench Q2). Throws on an
 * invalid slug.
 *
 * For `projects`, `projects/<slug>` and `projects/<slug>/files`, in that
 * order: a link, or something there that is no folder, prints
 * `STORE-REFUSED <path>` and exits 3, since PID 1 would read through it; a
 * missing folder is made 0700; each is then root's, 0700. When this run makes
 * the project's folder, it first drops the previous versions a removed project
 * of the same name may have left, which the dashboard would otherwise offer
 * to restore. It ends with `STORE-READY created` when it made the project's
 * folder, `STORE-READY present` otherwise.
 *
 * Every path is built from the validated slug alone. It never touches the env
 * file nor a file of the store.
 */
export function storePrepareCommand(slug: string): string {
  const { folder, files } = storePaths(slug);
  const previous = `${STORE_PREVIOUS_ROOT}/${slug}`;
  // One line, `: store-prepare <slug>` first: it reads by itself in sudo's
  // log, and a simulated machine recognises it, as caddy-lock.ts does.
  const script = [
    `: store-prepare ${slug}`,
    "set -eu",
    "umask 077",
    "made=present",
    `for p in ${STORE_ROOT} ${folder} ${files}; do ` +
      `if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then echo "${STORE_REFUSED} $p"; exit ${REFUSED_EXIT}; fi; ` +
      `if [ ! -e "$p" ]; then if [ "$p" = ${folder} ]; then rm -rf ${previous}; made=created; fi; mkdir -m 700 "$p"; fi; ` +
      `chown root:root "$p"; chmod 700 "$p"; done`,
    `echo "${STORE_READY} $made"`,
  ].join("; ");
  return `sudo sh -c '${script}'`;
}

export type StorePrepareRead = { kind: "ready"; created: boolean } | { kind: "refused"; path: string } | { kind: "unreadable" };

/** A path the prepare command may name in a refusal: one of its three folders, for some slug. */
const REFUSED_PATH = /^\/etc\/sitesolide\/projects(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/files)?)?$/;

/**
 * The answer of storePrepareCommand, read from its last line. An answer that
 * is neither marker reads as unreadable, never as ready: a refused sudo or an
 * ssh that did not get through prints nothing, and nothing laid no folder
 * (the rule of the markers in unit.ts).
 */
export function readStorePrepareAnswer(output: string): StorePrepareRead {
  const last = output.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1);
  if (last === `${STORE_READY} created`) return { kind: "ready", created: true };
  if (last === `${STORE_READY} present`) return { kind: "ready", created: false };
  const refused = last?.startsWith(`${STORE_REFUSED} `) ? last.slice(STORE_REFUSED.length + 1) : null;
  if (refused !== null && REFUSED_PATH.test(refused)) return { kind: "refused", path: refused };
  return { kind: "unreadable" };
}

/**
 * What `remove` runs for the store, after the served folder and before
 * userdel, for every slug whatever its manifest says: a store may exist for a
 * slug never deployed. The units are stopped first, so none starts without its
 * `files/` folder. Throws on an invalid slug.
 */
export function storeRemovalActions(slug: string): { title: string; command: string }[] {
  const { folder } = storePaths(slug);
  return [
    { title: "remove the project's store of secrets", command: `sudo rm -rf ${folder}` },
    { title: "remove the previous versions of its store kept by the dashboard", command: `sudo rm -rf ${STORE_PREVIOUS_ROOT}/${slug}` },
  ];
}

// --- The workstation ----------------------------------------------------------

/**
 * The workstation's file of a project's build secrets, and of the variables
 * `sitesolide run` lends a command: `<vault>/<slug>.env`, the vault being
 * `~/.config/sitesolide/secrets/`. Throws on an invalid slug.
 */
export function workstationSecretsPath(vault: string, slug: string): string {
  if (typeof slug !== "string" || !isValidSlug(slug)) throw new Error("not a project's slug: no path is built from it");
  return `${vault.replace(/\/+$/, "")}/${slug}.env`;
}
