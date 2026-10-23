/**
 * A project's store of secrets: what the steward decides about it, and
 * nothing else. Pure: the steward reads the folders, the env file, the files
 * and the legacy files, and hands their state here; a value or a refusal
 * comes back, each checked without a VM.
 *
 *   /etc/sitesolide/projects/<slug>/          root:root 0700
 *   /etc/sitesolide/projects/<slug>/env       root:root 0600, the runtime variables
 *   /etc/sitesolide/projects/<slug>/files/    root:root 0700
 *   /etc/sitesolide/projects/<slug>/files/<n> root:root 0600, a file read whole
 *
 * PID 1 reads them for the project's units (bin/cli/store.ts); nobody else
 * does. **No answer built here carries a store value**: the listing gives
 * names, sources and states, and a legacy file's coverage and a file's size
 * to the owner alone, since anyone who may write the store could otherwise
 * test a guess against a value (set, look, repeat). The one read is the
 * owner's `/store/value`, which never comes through this module.
 *
 * A refusal is a value, never an exception, as in scope.ts. A refusal quotes
 * a name only when it has a variable name's shape, and never a value.
 */
import { MACHINE_FOLDER } from "../../borrowed/backups";
import { isSystemName, isValidFileName, isValidSlug, secretsOf, STORELESS_SLUGS, type Manifest } from "../../borrowed/manifest";
import {
  credentialBudgetRefusal,
  encodeGenerated,
  GENERATE_DEFAULT_BYTES,
  GENERATE_FORMATS,
  GENERATE_MAX_BYTES,
  GENERATE_MIN_BYTES,
  MAX_ENV_LINE_BYTES,
  MAX_STORE_ENV_BYTES,
  MAX_STORE_FILE_BYTES,
  MAX_STORE_FILES,
  MAX_STORE_FILES_BYTES,
  SECRETS_FOLDER,
  STORE_PREVIOUS_ROOT,
  type GenerateFormat,
} from "../../borrowed/store";
import type { LegacyFileView, StoreFileView, StoreMay, StoreVariableView, StoreView } from "../../borrowed/store-protocol";
import { checkKey, checkValue, isVariableName, MAX_KEY, PASSWORD_VARIABLE, VALUE_LIKE_PREFIXES } from "../../borrowed/variables";
import { machineRefusal } from "../people/powers";
import { restartPending } from "./restart";
import { LANDING_LABEL, type Expected, type Refusal, type Site } from "./scope";

const outOfScope = (message: string): Refusal => ({ error: "out-of-scope", message });
const invalid = (message: string): Refusal => ({ error: "invalid", message });

/** Who asks: the owner (dashboard unlocked, or root over SSH), a person signed in, or a token the control routes judged. */
export type StoreRequester = "owner" | "person" | "token";

/** What a store's env file and its files are expected to be: root's, 0600. */
export const STORE_EXPECTED: Expected = { owner: "root", group: "root", mode: 0o600 };

/** How a variable name is described in a refusal that may not quote it. */
export const NAME_SHAPE = `letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most`;

/** How a file name is described in a refusal that may not quote it. */
export const FILE_NAME_RULE = "letters, digits, `.`, `_` and `-`, starting with a letter or a digit, 64 characters at most, no `..`";

// --- The slug --------------------------------------------------------------

export type StoreSlugContext = {
  requester: StoreRequester;
  /** A token the control routes let create this slug: its store may be written ahead of its first deployment. */
  creating: boolean;
  /** The served zone, which names the landing's folder. */
  zone: string;
  /** The deployed site, null when `/srv/sites/<slug>` does not exist. */
  site: Pick<Site, "folder" | "manifest" | "isStatic"> | null;
};

/**
 * Rule 1: may this requester hold a store for this slug? A string, a valid
 * slug, none of the names that are not a project's (the landing's label, the
 * machine's snapshots, the zone, a unit of the machine), not storeless, and,
 * for anyone but the owner, not one of the platform's own projects.
 *
 * Deployed, it must be an app: a static site has no service to read a store.
 * Not deployed: the owner may lay a store ahead of the first deployment, a
 * token only for a slug the control routes let it create, a person never.
 * The slug is never quoted when it is not one.
 */
export function storeSlugRefusal(slug: unknown, context: StoreSlugContext): Refusal | null {
  if (typeof slug !== "string" || !isValidSlug(slug)) return invalid("slug: a project's slug, lowercase letters, digits and dashes");
  if (slug === LANDING_LABEL) return outOfScope("landing names the landing's files, never a project's store");
  if (slug === MACHINE_FOLDER) return outOfScope("machine names the machine's own snapshots, never a project");
  if (context.zone !== "" && slug === context.zone) return outOfScope(`${slug} is the landing's folder, which has no store`);
  if (STORELESS_SLUGS.includes(slug)) {
    return outOfScope(`${slug} keeps its hash in ${slug}.env, read by its own unit: it has no store`);
  }
  if (isSystemName(slug)) return outOfScope(`${slug} names a unit of the machine, never a project`);
  if (context.requester !== "owner") {
    const machine = machineRefusal(slug, null, context.zone);
    if (machine !== null) return outOfScope(machine);
  }

  const { site } = context;
  if (site !== null) {
    const conforms = site.manifest !== null && site.manifest.slug === site.folder;
    if (conforms && site.isStatic) {
      return outOfScope("a static site has no service to read a store; its build secrets stay with whoever deploys");
    }
    // A folder whose manifest is missing or names another slug: whatever its
    // unit is, the platform did not generate it, and only the owner may lay
    // a store there, ahead of a deployment that will.
    if (!conforms && context.requester !== "owner") {
      return outOfScope(`the sitesolide.json deployed for ${slug} does not describe it: deploy it again first`);
    }
    return null;
  }
  if (context.requester === "owner") return null;
  if (context.requester === "token" && context.creating) return null;
  return { error: "not-found", message: `${slug} is not a project deployed on this machine` };
}

// --- Names and values --------------------------------------------------------

export type NameList = "set" | "remove" | "generate" | "name";

/**
 * Rule 3: a name the store may hold. Its shape first, never quoted when it
 * lacks it, nor when it starts like a provider's key; `PASSWORD_HASH`, which only Change password writes, in the
 * dashboard's and the portal's files; then, for a name being set,
 * `checkKey`: not reserved, and not set by the project's manifest, the tree
 * variables or any installed unit's `Environment=`, which a store value
 * would silently override. `setKeys` null: a removal, which repairs and
 * needs none of that.
 */
export function storeNameRefusal(list: NameList, name: unknown, setKeys: Iterable<string> | null): Refusal | null {
  if (!isVariableName(name)) return invalid(`${list}: not a variable name: ${NAME_SHAPE}`);
  // A key pasted where a name goes would become a name, journaled for good
  // and listed to every Developer of the project; never quoted. The rule of
  // the manifest's runtime names (bin/cli/manifest.ts), so that no name a
  // manifest could declare is refused here.
  if (VALUE_LIKE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return invalid(`${list}: this starts like a secret key, not a variable name: a value never goes where a name does`);
  }
  if (name === PASSWORD_VARIABLE) {
    return outOfScope(`${PASSWORD_VARIABLE} is changed with Change password, in the dashboard's and the portal's files alone`);
  }
  if (setKeys === null) return null;
  const reason = checkKey(name, setKeys);
  if (reason === null) return null;
  return invalid(reason.startsWith(`${name} `) ? `${list}: ${reason}` : `${list}: ${name}: ${reason}`);
}

/** Rule 4: a value the env file holds and systemd reads back. Never quoted. */
export function storeValueRefusal(name: string, value: unknown): Refusal | null {
  if (typeof value !== "string") return invalid(`set: ${name}: the value must be a string`);
  const reason = checkValue(value);
  return reason === null ? null : invalid(`set: ${name}: ${reason}`);
}

// --- Removing never brings a legacy value back (S1, S1') ---------------------

/**
 * A legacy file attached to the project, as the rules of removal read it:
 * `known` when its assignments could be read, whatever its owner or mode,
 * since systemd reads it as root all the same.
 */
export type LegacyHolder =
  | { file: string; read: boolean; known: true; values: ReadonlyMap<string, string> }
  | { file: string; read: boolean; known: false };

/**
 * S1 and S1': may these names leave the store? A unit reads its legacy files
 * first and the store last, the later winning: a name removed from the store
 * would hand the service the legacy file's value again, a value nobody chose
 * any more. Refused while a legacy file attached to the project, read,
 * declared, or kept as a leftover that a redeploy of an older commit would
 * read again, holds the name, or cannot be read to tell.
 *
 * The owner alone, who reads every value anyway, may remove a name every
 * holder carries with the store's very value: nothing in force changes, which
 * is what going back after a migration does. For anyone else the answer
 * never depends on a value: it would tell whoever may write the store
 * whether a guess equals a legacy value.
 *
 * A name the store does not hold leaves nothing: no refusal.
 */
export function removalRefusal(names: readonly string[], store: ReadonlyMap<string, string>, legacy: readonly LegacyHolder[], owner: boolean): Refusal | null {
  for (const name of names) {
    if (!store.has(name)) continue;
    const unknown = legacy.find((holder) => !holder.known);
    if (unknown !== undefined) {
      return invalid(
        `${unknown.file} cannot be read here, and may hold ${name}: removing it from the store could bring that file's value back. Fix ${unknown.file} first, or retire it`,
      );
    }
    const holders = legacy.filter((holder): holder is Extract<LegacyHolder, { known: true }> => holder.known && holder.values.has(name));
    if (holders.length === 0) continue;
    if (owner && holders.every((holder) => holder.values.get(name) === store.get(name))) continue;
    const read = holders.filter((holder) => holder.read);
    const named = read.at(-1) ?? holders[0]!;
    const why = named.read ? "which the service reads before the store: removing it here would bring that file's value back" : "which the project declares or kept: removing it here could bring that file's value back at a later deploy";
    return invalid(`${name} is also in ${named.file}, ${why}. Retire the file first (sitesolide secrets migrate --retire), or remove ${name} from it`);
  }
  return null;
}

/**
 * S1' for a restore: the names the current version holds and the previous
 * one lacks disappear from the store, judged as a removal of each, against
 * the values in force now.
 */
export function restoreRemovalRefusal(current: ReadonlyMap<string, string>, previous: ReadonlyMap<string, string>, legacy: readonly LegacyHolder[], owner: boolean): Refusal | null {
  const disappearing = [...current.keys()].filter((name) => !previous.has(name));
  return removalRefusal(disappearing, current, legacy, owner);
}

/**
 * S2: a name set in a legacy file while the store holds it would have no
 * effect, the store being read last. `storeNames` null: the store cannot be
 * read, and nobody can tell; refused rather than written blind.
 */
export function legacyWriteRefusal(name: string, storeNames: ReadonlySet<string> | null, file: string): Refusal | null {
  if (storeNames === null) {
    return invalid(`the project's store cannot be read here, and a variable it holds would override ${file}: fix the store first`);
  }
  if (!storeNames.has(name)) return null;
  return invalid(`${name} is set in the project's store, which overrides ${file}: change it there`);
}

// --- Sizes -------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Rule 9: the env file after a write, 256 KiB at most, every line under what
 * systemd starts with (bench Q7: a line of 131,072 bytes fails with 203/EXEC).
 * The 8 KiB a value holds keeps every line far below: a second lock.
 */
export function envBytesRefusal(bytes: Uint8Array): Refusal | null {
  if (bytes.length > MAX_STORE_ENV_BYTES) return invalid("the store's env would grow beyond 256 KiB");
  let start = 0;
  for (let end = bytes.indexOf(10); ; end = bytes.indexOf(10, start)) {
    const stop = end === -1 ? bytes.length : end;
    if (stop - start > MAX_ENV_LINE_BYTES) return invalid("a line of the store's env would be longer than systemd reads");
    if (end === -1) break;
    start = end + 1;
  }
  return null;
}

// --- Files -------------------------------------------------------------------

/** Rule 8: a file name the store writes, never quoted when it is not one. */
export function fileNameRefusal(name: unknown): Refusal | null {
  return isValidFileName(name) ? null : invalid(`name: not a file name the store takes: ${FILE_NAME_RULE}`);
}

/** The longest base64 text of a file of MAX_STORE_FILE_BYTES. */
const MAX_BASE64 = Math.ceil(MAX_STORE_FILE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A file's content as a request carries it, in base64, decoded strictly: no
 * whitespace, no other alphabet, a complete last chunk. Never quoted. Empty
 * is refused, as an empty value is: a file is removed instead.
 */
export function decodeFileContent(content: unknown): { bytes: Uint8Array } | { refusal: Refusal } {
  if (typeof content !== "string") return { refusal: invalid("content: the file's bytes in base64") };
  if (content.length > MAX_BASE64) return { refusal: invalid("content: a file is 64 KiB at most") };
  if (content.length % 4 !== 0 || !BASE64.test(content)) return { refusal: invalid("content: not base64") };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(content, { alphabet: "base64", lastChunkHandling: "strict" });
  } catch {
    return { refusal: invalid("content: not base64") };
  }
  if (bytes.length === 0) return { refusal: invalid("content: the file is empty: remove it instead") };
  if (bytes.length > MAX_STORE_FILE_BYTES) return { refusal: invalid("content: a file is 64 KiB at most") };
  return { bytes };
}

/**
 * Rule 8, after the write: 32 files and 512 KiB of content at most, then, as
 * a second lock, systemd's own budget for a unit's credentials, past which
 * every start of the project fails with 243 (bench Q7). `after` is every
 * regular file systemd would load, written or present. The refusal says no
 * size: a file's size is the owner's alone to see.
 */
export function filesRefusal(after: readonly { name: string; size: number }[]): Refusal | null {
  if (after.length > MAX_STORE_FILES) return invalid(`the store would hold more than ${MAX_STORE_FILES} files: remove one first`);
  if (after.reduce((total, file) => total + file.size, 0) > MAX_STORE_FILES_BYTES) {
    return invalid("the store's files would weigh more than 512 KiB in all: remove one first");
  }
  const budget = credentialBudgetRefusal(after);
  return budget === null ? null : invalid(budget);
}

// --- Generate ----------------------------------------------------------------

export type GenerateAsk = { format: GenerateFormat; bytes: number };

/** `format` hex by default or base64url, `bytes` 32 by default, 16 to 64. */
export function readGenerateAsk(format: unknown, bytes: unknown): GenerateAsk | { refusal: Refusal } {
  if (format !== undefined && !GENERATE_FORMATS.includes(format as GenerateFormat)) {
    return { refusal: invalid(`format: ${GENERATE_FORMATS.join(" or ")}`) };
  }
  if (bytes !== undefined && (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < GENERATE_MIN_BYTES || bytes > GENERATE_MAX_BYTES)) {
    return { refusal: invalid(`bytes: a whole number from ${GENERATE_MIN_BYTES} to ${GENERATE_MAX_BYTES}`) };
  }
  return { format: (format as GenerateFormat | undefined) ?? "hex", bytes: (bytes as number | undefined) ?? GENERATE_DEFAULT_BYTES };
}

/**
 * A value drawn from `random`, encoded. Throws when the source gives fewer
 * bytes than asked: a short draw would be a weak key nobody notices.
 */
export function drawValue(random: (bytes: number) => Uint8Array, ask: GenerateAsk): string {
  const drawn = random(ask.bytes);
  if (drawn.length < ask.bytes) throw new Error("random source too short");
  return encodeGenerated(drawn.slice(0, ask.bytes), ask.format);
}

/**
 * Without `replace`, a name the store holds, or that a legacy file the
 * service reads sets, is not drawn again: rotating a live secret is a choice,
 * never a side effect.
 */
export function generateRefusal(name: string, storeNames: ReadonlySet<string>, readLegacy: readonly LegacyHolder[], replace: boolean): Refusal | null {
  if (replace) return null;
  const set = storeNames.has(name) || readLegacy.some((holder) => holder.read && holder.known && holder.values.has(name));
  return set ? { error: "already-present", message: `${name} is already set; --replace draws a new value in the store, which overrides it` } : null;
}

// --- The listing -------------------------------------------------------------

export type StoreEnvState =
  | { kind: "absent" }
  | { kind: "managed"; values: ReadonlyMap<string, string>; modifiedAt: number }
  | { kind: "unmanaged"; reason: string; modifiedAt: number | null };

export type StoreFileState =
  | { name: string; kind: "managed"; size: number; modifiedAt: number }
  | { name: string; kind: "unmanaged"; reason: string; modifiedAt: number | null };

export type StoreState = {
  /** `/etc/sitesolide/projects/<slug>/` exists. */
  exists: boolean;
  /** One of the three folders is a link, no folder, or not root's: why. */
  refusal: string | null;
  env: StoreEnvState;
  /** Every present entry of `files/` but dot files, which systemd skips. */
  files: StoreFileState[];
  /** A previous version of `env` is kept. */
  previous: boolean;
};

/**
 * A legacy file as the listing shows it. `values` only for a managed one,
 * read for the coverage, which only the owner is told.
 */
export type LegacyState = {
  file: string;
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  values: ReadonlyMap<string, string> | null;
  read: boolean;
  leftover: boolean;
};

export type StoreViewInput = {
  slug: string;
  /** The deployed manifest naming this slug, null ahead of a deployment or when it does not conform. */
  manifest: Manifest | null;
  store: StoreState;
  /** Read files first, in the units' order, then the others. */
  legacy: readonly LegacyState[];
  unitReadsStore: boolean | null;
  /** The main service's start, to the microsecond; null for an anchor or when unknown. */
  startedUs: number | null;
  may: StoreMay;
  /** The owner: coverage and sizes are told. */
  owner: boolean;
};

/** A name systemd loads from `files/` that the store would not write, shown so it can be dealt with by hand. */
const SHOWN_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,248}$/;

/**
 * The store as the requester may see it (spec §6.11): names, sources,
 * states, and what may be done. Never a store value, never a legacy value;
 * the public `env` of the manifest is in git already.
 */
export function storeView(input: StoreViewInput): StoreView {
  const { store, manifest, owner, may } = input;
  const declared = manifest === null ? { form: "none" as const, legacy: [], runtime: [], files: [], build: [] } : secretsOf(manifest);
  const runtime = declared.form === "names" ? unique(declared.runtime.filter((name) => isVariableName(name))) : [];
  const declaredFiles = declared.form === "names" ? unique(declared.files.filter((name) => isValidFileName(name))) : [];
  const storeValues = store.env.kind === "managed" ? store.env.values : new Map<string, string>();
  const read = input.legacy.filter((file) => file.read && file.state === "managed" && file.values !== null);

  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  runtime.forEach(add);
  [...storeValues.keys()].forEach(add);
  for (const file of read) [...file.values!.keys()].forEach(add);

  const variables: StoreVariableView[] = names.map((name) => {
    const holders = read.filter((file) => file.values!.has(name)).map((file) => file.file);
    const isDeclared = runtime.includes(name);
    if (storeValues.has(name)) return { name, source: "store", file: null, shadows: holders, declared: isDeclared };
    if (holders.length > 0) return { name, source: "legacy", file: holders.at(-1)!, shadows: holders.slice(0, -1), declared: isDeclared };
    return { name, source: "none", file: null, shadows: [], declared: isDeclared };
  });

  const present = new Map(store.files.map((file) => [file.name, file]));
  const fileNames = [...declaredFiles, ...[...present.keys()].filter((name) => !declaredFiles.includes(name) && SHOWN_FILE.test(name)).sort()];
  const files: StoreFileView[] = fileNames.map((name) => {
    const found = present.get(name);
    const isDeclared = declaredFiles.includes(name);
    if (found === undefined) return { name, state: "missing", declared: isDeclared, reason: null, bytes: null, modifiedAt: null, restartPending: false };
    const pending = found.modifiedAt !== null && restartPending(found.modifiedAt, input.startedUs);
    const modifiedAt = found.modifiedAt === null ? null : Math.floor(found.modifiedAt);
    if (found.kind === "unmanaged" || !isValidFileName(name)) {
      const reason = found.kind === "unmanaged" ? found.reason : "not a name the store writes: rename or remove it by hand";
      return { name, state: "unmanaged", declared: isDeclared, reason, bytes: null, modifiedAt, restartPending: pending };
    }
    const empty = found.size === 0;
    return {
      name,
      state: empty ? "missing" : "set",
      declared: isDeclared,
      reason: empty ? "empty" : null,
      bytes: owner ? found.size : null,
      modifiedAt,
      restartPending: pending,
    };
  });

  const legacy: LegacyFileView[] = input.legacy.map((file) => ({
    name: file.file,
    state: file.state,
    reason: file.reason,
    variables: file.state === "managed" && file.values !== null ? [...file.values.keys()] : [],
    read: file.read,
    leftover: file.leftover,
    covered: owner && file.state === "managed" && file.values !== null ? isCovered(file.values, store.env) : null,
  }));

  const envModified = store.env.kind === "absent" ? null : store.env.modifiedAt;
  const newest = [envModified, ...store.files.map((file) => file.modifiedAt)].reduce<number | null>(
    (latest, date) => (date === null ? latest : latest === null ? date : Math.max(latest, date)),
    null,
  );

  const state = store.refusal !== null ? "unmanaged" : !store.exists ? "absent" : store.env.kind === "unmanaged" ? "unmanaged" : "managed";
  const reason = store.refusal ?? (store.env.kind === "unmanaged" ? `env: ${store.env.reason}` : null);
  const env = manifest?.env as unknown;
  const publicEnv = typeof env === "object" && env !== null && !Array.isArray(env)
    ? Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, value]) => ({ name, value }))
    : [];

  return {
    slug: input.slug,
    exists: store.exists,
    state,
    reason,
    variables,
    missing: variables.filter((variable) => variable.declared && variable.source === "none").map((variable) => variable.name),
    files,
    legacy,
    build: declared.form === "names" ? unique(declared.build.filter((name) => isVariableName(name))) : [],
    public: publicEnv,
    unitReadsStore: input.unitReadsStore,
    modifiedAt: envModified === null ? null : Math.floor(envModified),
    restartPending: restartPending(newest, input.startedUs),
    previous: store.previous && may.restore,
    may,
  };
}

/**
 * Where retire keeps a legacy file it deletes, on the machine: under the
 * project's own folder of previous versions, which `sitesolide remove`
 * deletes whole with the store (storeRemovalActions in bin/cli/store.ts), its
 * owner and mode kept. Throws on a slug or a name no path is built from.
 */
export function retiredCopyPath(slug: string, name: string): string {
  if (typeof slug !== "string" || !isValidSlug(slug)) throw new Error("not a project's slug");
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("..")) throw new Error("not a legacy file's name");
  return `${STORE_PREVIOUS_ROOT}/${slug}/legacy/${name}`;
}

/**
 * What the listing says of a legacy file retire deleted: where its copy is,
 * and how the owner puts it back by hand. Names and paths, never a value.
 */
export function retiredReason(slug: string, name: string): string {
  const copy = retiredCopyPath(slug, name);
  return `retired: a copy is kept at ${copy}; to put it back, sudo cp -p ${copy} ${SECRETS_FOLDER}/${name}, then sitesolide refresh ${slug}`;
}

/** Every assignment of a legacy file is in the store with the very same value. An empty file is covered. */
export function isCovered(values: ReadonlyMap<string, string>, env: StoreEnvState): boolean {
  if (values.size === 0) return true;
  if (env.kind !== "managed") return false;
  for (const [name, value] of values) if (env.values.get(name) !== value) return false;
  return true;
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

// --- What may be done --------------------------------------------------------

/**
 * What a requester may do on a store, as the listing says and the routes
 * enforce: the owner everything, but reading a value back over SSH; an
 * Admin writes and restores; a Developer and a token with Manage secrets
 * write. Migrate and retire are the owner's.
 */
export function storeMay(requester: { kind: "owner" | "ssh" | "person" | "token"; restore: boolean }): StoreMay {
  if (requester.kind === "owner") return { write: true, reveal: true, restore: true, migrate: true };
  if (requester.kind === "ssh") return { write: true, reveal: false, restore: true, migrate: true };
  return { write: true, reveal: false, restore: requester.kind === "person" && requester.restore, migrate: false };
}
