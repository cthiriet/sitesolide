/**
 * `sitesolide secrets`: a project's store of secrets, from its folder, the
 * same commands whichever way the workstation reaches the machine.
 *
 *   sitesolide secrets                                   names, sources, states; never a value
 *   sitesolide secrets set NAME [--stdin] [--restart]    typed without echo, or read from a pipe
 *   sitesolide secrets generate NAME [--format hex|base64url] [--bytes N] [--replace] [--restart]
 *   sitesolide secrets remove NAME... [--restart]
 *   sitesolide secrets set-file NAME [--restart] < path  a file read whole, 64 KiB at most
 *   sitesolide secrets remove-file NAME [--restart]
 *   sitesolide secrets migrate [--dry-run] [--restart]   owner, over SSH: merge the legacy files into the store
 *   sitesolide secrets migrate --retire [--force]        owner, over SSH: delete the legacy files the store covers,
 *                                                        or with --force those whose values it overrides
 *
 * The store is `/etc/sitesolide/projects/<slug>/` on the machine (./store),
 * which PID 1 alone reads: a service receives its variables at start, its
 * files at `$CREDENTIALS_DIRECTORY/files_<name>`. Two transports reach the
 * steward that writes it, one parser and one renderer for both:
 *
 * - the owner, over SSH, as root, on the steward's owner socket, with `curl`,
 *   every body on standard input: no value ever travels in an argument, which
 *   `ps` shows to every account of the machine (`sshStore`);
 * - a token that may manage secrets, through the dashboard's control API
 *   (`apiStore`). Migrate and retire are the owner's.
 *
 * **A value never comes from the command line.** `set` reads it at a prompt
 * that does not echo, or from a pipe with `--stdin`; `NAME=value`, or
 * anything after the name, is refused before a request leaves, and no refusal
 * quotes an argument that could be a value. **A value never comes back**: no
 * route returns one, a generated value included, and a refusal that would
 * quote the value sent is withheld here as a third lock.
 *
 * Also here: what `deploy` does with a runtime secret the store lacks
 * (`handleMissing`): at a terminal, it asks; otherwise it warns, and the
 * deployment goes on.
 */
import { askSteward, ownerReadCommand, ownerWriteCommand, type RunOnMachine } from "./access";
import { isApp, isLegacySecretName, isValidFileName, isValidSlug, STORELESS_SLUGS, type Manifest, type SecretsDeclaration } from "./manifest";
import { call, type Answer as ApiAnswer, type Failure, type Fetch, type Output, type Remote, type Typed } from "./remote";
import { credentialName, GENERATE_DEFAULT_BYTES, GENERATE_FORMATS, GENERATE_MAX_BYTES, GENERATE_MIN_BYTES, MAX_STORE_FILE_BYTES, type GenerateFormat } from "./store";
import type {
  LegacyFileView,
  RestartVerdict,
  StoreChangeResponse,
  StoreFileView,
  StoreGenerateRequest,
  StoreMigrateResponse,
  StoreMissing,
  StoreRetireResponse,
  StoreView,
} from "./store-protocol";
import { checkValue, isVariableName, VALUE_LIKE_PREFIXES } from "./variables";

// --- what was asked ----------------------------------------------------------------

export type StoreAsk =
  | { action: "list" }
  | { action: "set"; name: string; stdin: boolean; restart: boolean }
  | { action: "generate"; name: string; format: GenerateFormat; bytes: number; replace: boolean; restart: boolean }
  | { action: "remove"; names: string[]; restart: boolean }
  | { action: "set-file"; name: string; restart: boolean }
  | { action: "remove-file"; name: string; restart: boolean }
  | { action: "migrate"; dryRun: boolean; restart: boolean }
  | { action: "retire"; force: boolean };

/** The usage of `secrets`, as the refusals list it. */
export const STORE_USAGE = [
  "sitesolide secrets                                   this folder's project's secrets: names, sources, states, never a value",
  "sitesolide secrets set <NAME> [--restart]            its value typed at a prompt that does not echo it",
  "sitesolide secrets set <NAME> --stdin                its value from standard input, one trailing line break dropped",
  "sitesolide secrets generate <NAME> [--restart]       a random value drawn on the server, never shown",
  "   --format hex|base64url --bytes <16-64> --replace",
  "sitesolide secrets remove <NAME>... [--restart]      take variables out of the store",
  "sitesolide secrets set-file <NAME> [--restart] < path   a file read whole, 64 KiB at most",
  "sitesolide secrets remove-file <NAME> [--restart]",
  "sitesolide secrets migrate [--dry-run] [--restart]   the owner's: merge the legacy files into the store",
  "sitesolide secrets migrate --retire [--force]        the owner's: delete the legacy files the store covers; --force those it overrides",
];

/**
 * The longest name taken here. The steward takes 128 characters, but a name
 * that long is far likelier a key pasted in the wrong place than a variable;
 * a longer one is set from the dashboard's Secrets section.
 */
export const NAME_MAX_HERE = 64;

/**
 * Whether an argument where a name goes is more likely a secret's value: too
 * long, or starting as a provider's key does (VALUE_LIKE_PREFIXES in
 * ./variables). `sitesolide secrets set sk_live_...` has the shape of a
 * variable name: sent, the key would become a name, journaled for good and
 * listed to every Developer of the project.
 */
export function looksLikeValue(argument: string): boolean {
  return argument.length > NAME_MAX_HERE || VALUE_LIKE_PREFIXES.some((prefix) => argument.startsWith(prefix));
}

/** A value typed where a name goes: refused, never quoted, and its owner told the shell kept it. */
export function valueAsName(where: string): Failure {
  return {
    error: "looks-like-value",
    message: `${where} looks like a secret's value, not a name: nothing was sent`,
    details: [
      `refused here: a name over ${NAME_MAX_HERE} characters, or starting as service keys do, ${VALUE_LIKE_PREFIXES.join(", ")}`,
      "if it was a value, it may now be in the shell's history: change it at its source",
      "the value goes at the prompt of sitesolide secrets set NAME, or through a pipe to sitesolide secrets set NAME --stdin",
      "a variable really named so is set from the dashboard's Secrets section",
    ],
  };
}

/** A value on the command line: refused, the argument never quoted. */
export const VALUE_IN_ARGUMENTS: Failure = {
  error: "value-in-arguments",
  message: "a secret's value never goes on the command line, sitesolide secrets set takes a name alone: nothing was sent",
  details: [
    "an argument stays in the shell's history and shows in the process list",
    "type the value at the prompt of sitesolide secrets set NAME, or pipe it to sitesolide secrets set NAME --stdin",
    "if a real value was on that line, change it at its source: the shell's history keeps it",
  ],
};

function usage(message: string): Failure {
  return { error: "usage", message: `${message}: nothing was sent`, details: STORE_USAGE };
}

/** The options each action takes, and whether one carries a value. */
const ACTION_OPTIONS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  list: {},
  set: { "--stdin": false, "--restart": false },
  generate: { "--format": true, "--bytes": true, "--replace": false, "--restart": false },
  remove: { "--restart": false },
  "set-file": { "--restart": false },
  "remove-file": { "--restart": false },
  migrate: { "--dry-run": false, "--restart": false, "--retire": false, "--force": false },
};

/** Every command takes these: they choose the output and the transport, read before here. */
const GLOBAL_OPTIONS = ["--json", "--api"];

/**
 * The arguments of `secrets`, read whole before anything is asked or sent.
 * Only the options it takes and a name of a variable's or a file's shape are
 * ever named in a refusal: anything else may be a value typed in the wrong
 * place. `--dry-run` goes with migrate alone: over SSH it would otherwise be
 * taken for a deploy's, and a `set` run anyway.
 */
export function readStoreArguments(arguments_: string[], json: boolean): StoreAsk | Failure {
  const rest = arguments_[0] === "secrets" ? arguments_.slice(1) : arguments_;
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  const malformedValue = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]!;
    if (GLOBAL_OPTIONS.includes(argument)) continue;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    // Not quoted: `--value=...` is the first thing a hand tries.
    if (argument.includes("=")) return VALUE_IN_ARGUMENTS;
    const known = Object.values(ACTION_OPTIONS).find((taken) => Object.hasOwn(taken, argument));
    if (known === undefined) return usage("an option sitesolide secrets does not take");
    if (known[argument]) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) malformedValue.add(argument);
      else {
        options.set(argument, value);
        i++;
      }
    } else options.set(argument, true);
  }
  // `NAME=value` wherever it stands, `secrets API_KEY=...` as much as `secrets set API_KEY=...`.
  if (positional.some((argument) => argument.includes("="))) return VALUE_IN_ARGUMENTS;
  const [action = "list", ...names] = positional;
  if (positional.length === 0 && options.size === 0 && malformedValue.size === 0) return { action: "list" };
  if (!Object.hasOwn(ACTION_OPTIONS, action) || action === "list") {
    // `sitesolide secrets sk_live_...`: the same slip, one word shorter.
    if (positional.length > 0 && looksLikeValue(action)) return valueAsName("secrets: what follows");
    if (positional.length === 0) return usage("sitesolide secrets alone lists, and takes no option");
    return usage("sitesolide secrets takes set, generate, remove, set-file, remove-file or migrate, or nothing to list");
  }
  const taken = ACTION_OPTIONS[action]!;
  for (const option of [...options.keys(), ...malformedValue]) {
    if (!Object.hasOwn(taken, option)) return usage(`secrets ${action} does not take ${option}`);
  }
  const [valueless] = malformedValue;
  if (valueless !== undefined) return usage(`secrets ${action}: ${valueless} takes a value`);
  const restart = options.has("--restart");

  switch (action) {
    case "set": {
      const [name, ...extra] = names;
      if (name === undefined) return usage("secrets set: name the variable, sitesolide secrets set NAME");
      // Anything after the name is a value typed on the line, `secrets set API_KEY s3cret`.
      if (extra.length > 0) return VALUE_IN_ARGUMENTS;
      const refused = nameRefusal("secrets set: the name", name);
      if (refused !== null) return refused;
      const stdin = options.has("--stdin");
      // Asked now, before a prompt or a read of standard input: under --json
      // nobody answers one, and an agent's empty input would set an empty value.
      if (json && !stdin) {
        return { error: "needs-stdin", message: "secrets set under --json never prompts: pipe the value to --stdin; nothing was sent", details: ["sitesolide secrets set NAME --stdin --json"] };
      }
      return { action: "set", name, stdin, restart };
    }
    case "generate": {
      const [name, ...extra] = names;
      if (name === undefined) return usage("secrets generate: name the variable, sitesolide secrets generate NAME");
      if (extra.length > 0) {
        if (extra.some(looksLikeValue)) return VALUE_IN_ARGUMENTS;
        return usage("secrets generate takes one name: the value is drawn on the server");
      }
      const refused = nameRefusal("secrets generate: the name", name);
      if (refused !== null) return refused;
      const format = options.get("--format") ?? "hex";
      if (!GENERATE_FORMATS.includes(format as GenerateFormat)) return { error: "invalid", message: `--format: ${GENERATE_FORMATS.join(" or ")}: nothing was sent` };
      const given = options.get("--bytes");
      const bytes = given === undefined ? GENERATE_DEFAULT_BYTES : Number(given);
      if (typeof given === "string" && (!/^[0-9]{1,3}$/.test(given) || bytes < GENERATE_MIN_BYTES || bytes > GENERATE_MAX_BYTES)) {
        return { error: "invalid", message: `--bytes: a whole number from ${GENERATE_MIN_BYTES} to ${GENERATE_MAX_BYTES}: nothing was sent` };
      }
      return { action: "generate", name, format: format as GenerateFormat, bytes, replace: options.has("--replace"), restart };
    }
    case "remove": {
      if (names.length === 0) return usage("secrets remove: name the variables, sitesolide secrets remove NAME...");
      for (const [index, name] of names.entries()) {
        const refused = nameRefusal(`secrets remove: name ${index + 1}`, name);
        if (refused !== null) return refused;
      }
      return { action: "remove", names, restart };
    }
    case "set-file":
    case "remove-file": {
      const [name, ...extra] = names;
      if (name === undefined) return usage(`secrets ${action}: name the file, sitesolide secrets ${action} NAME`);
      if (extra.length > 0) return usage(`secrets ${action} takes one file name${action === "set-file" ? ", its content on standard input: < path" : ""}`);
      if (looksLikeValue(name)) return valueAsName(`secrets ${action}: the file name`);
      if (!isValidFileName(name)) {
        return { error: "invalid", message: `secrets ${action}: the file name is not one the store takes, letters, digits, dots, dashes and underscores, not starting with a dot, 64 characters at most: nothing was sent` };
      }
      return { action, name, restart };
    }
    default: {
      if (names.length > 0) return usage("secrets migrate takes no name: it reads the project's legacy files");
      if (options.has("--retire")) {
        if (options.has("--dry-run") || restart) return usage("secrets migrate --retire stands alone: it deletes only what the store already covers, after a restart");
        return { action: "retire", force: options.has("--force") };
      }
      if (options.has("--force")) return usage("--force goes with migrate --retire alone: it lets the store's values stand over a legacy file's");
      return { action: "migrate", dryRun: options.has("--dry-run"), restart };
    }
  }
}

/** Why a name is refused here, or null. Quoted only when it has a variable name's shape. */
function nameRefusal(where: string, name: string): Failure | null {
  // Before the shape: `glpat-...` is no variable name either, and its owner needs the history warning more than the rule.
  if (looksLikeValue(name)) return valueAsName(where);
  if (!isVariableName(name)) {
    return { error: "invalid", message: `${where} is not a variable name, letters, digits and underscores, not starting with a digit: nothing was sent` };
  }
  return null;
}

/**
 * Why a project has no store to list or change: a static site, whose build
 * secrets stay with whoever deploys, or the dashboard and the portal, whose
 * one file holds the owner's password hash.
 */
export function storelessRefusal(manifest: Manifest): Failure {
  if (STORELESS_SLUGS.includes(manifest.slug)) {
    return {
      error: "out-of-scope",
      message: `${manifest.slug} keeps its password hash in ${manifest.slug}.env, read by its own unit: it has no store of secrets`,
      details: ["its password is changed with Change password, in the dashboard"],
    };
  }
  if (!isApp(manifest)) {
    return {
      error: "out-of-scope",
      message: `${manifest.slug} is a static site: no service reads a store, and its build secrets stay with whoever deploys`,
      details: ['a value its build needs is named under "secrets": { "build": [...] }, and exported, or kept in ~/.config/sitesolide/secrets/<slug>.env'],
    };
  }
  return { error: "out-of-scope", message: `${manifest.slug} has no store of secrets` };
}

// --- the transports ------------------------------------------------------------------

export type Answer<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export type StoreTransport = {
  /** For the first line: "over SSH, as the owner", "through https://dashboard.example.com". */
  via: string;
  /** The owner over SSH: migrate and retire are theirs. */
  owner: boolean;
  list: (slug: string) => Promise<Answer<StoreView>>;
  change: (slug: string, change: { set: [string, string][]; remove: string[] }) => Promise<Answer<StoreChangeResponse>>;
  generate: (slug: string, request: Omit<StoreGenerateRequest, "slug">) => Promise<Answer<StoreChangeResponse>>;
  setFile: (slug: string, name: string, content: Uint8Array) => Promise<Answer<StoreChangeResponse>>;
  removeFile: (slug: string, name: string) => Promise<Answer<StoreChangeResponse>>;
  restart: (slug: string) => Promise<Answer<{ verdict: RestartVerdict }>>;
  migrate: ((slug: string, dryRun: boolean) => Promise<Answer<StoreMigrateResponse>>) | null;
  /** `force`: the owner's explicit choice to retire a file whose values differ, the store's standing alone. */
  retire: ((slug: string, files: string[], force: boolean) => Promise<Answer<StoreRetireResponse>>) | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");

/** A StoreView as far as this CLI reads one: anything else is not the steward's answer. */
export function isStoreView(value: unknown): value is StoreView {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    Array.isArray(value.variables) &&
    value.variables.every((one) => isRecord(one) && typeof one.name === "string" && typeof one.source === "string") &&
    isStrings(value.missing) &&
    Array.isArray(value.files) &&
    value.files.every((one) => isRecord(one) && typeof one.name === "string" && typeof one.state === "string") &&
    Array.isArray(value.legacy) &&
    value.legacy.every((one) => isRecord(one) && typeof one.name === "string") &&
    isStrings(value.build)
  );
}

/** A change's answer, its lists defaulting to none when a steward leaves one out; null when it is not one. */
export function readChange(value: unknown): StoreChangeResponse | null {
  if (!isRecord(value) || !isStoreView(value.store)) return null;
  const list = (key: string): string[] | null => (value[key] === undefined ? [] : isStrings(value[key]) ? value[key] : null);
  const files = value.files === undefined ? { set: [], removed: [] } : value.files;
  if (!isRecord(files)) return null;
  const set = list("set");
  const generated = list("generated");
  const removed = list("removed");
  const absent = list("absent");
  const filesSet = files.set === undefined ? [] : isStrings(files.set) ? files.set : null;
  const filesRemoved = files.removed === undefined ? [] : isStrings(files.removed) ? files.removed : null;
  if (set === null || generated === null || removed === null || absent === null || filesSet === null || filesRemoved === null) return null;
  return { store: value.store, created: value.created === true, set, generated, removed, absent, files: { set: filesSet, removed: filesRemoved } };
}

const isVerdict = (value: unknown): value is RestartVerdict =>
  isRecord(value) && typeof value.kind === "string" && typeof value.state === "string" && typeof value.subState === "string" && typeof value.restarts === "number";

function readMigrate(value: unknown): StoreMigrateResponse | null {
  if (!isRecord(value) || !isStoreView(value.store)) return null;
  for (const key of ["sources", "merged", "already", "overridden"]) if (!isStrings(value[key])) return null;
  if (!Array.isArray(value.conflicts) || !value.conflicts.every((one) => isRecord(one) && typeof one.name === "string" && isStrings(one.files))) return null;
  if (!Array.isArray(value.skipped) || !value.skipped.every((one) => isRecord(one) && typeof one.file === "string" && typeof one.reason === "string")) return null;
  // A steward from before them answers no `shadowed`: none.
  const shadowed = value.shadowed ?? [];
  if (!Array.isArray(shadowed) || !shadowed.every((one) => isRecord(one) && typeof one.name === "string" && typeof one.kept === "string" && isStrings(one.others))) return null;
  return { ...(value as unknown as StoreMigrateResponse), shadowed, written: value.written === true };
}

function readRetire(value: unknown): StoreRetireResponse | null {
  if (!isRecord(value) || !isStoreView(value.store) || !isStrings(value.retired)) return null;
  if (!Array.isArray(value.kept) || !value.kept.every((one) => isRecord(one) && typeof one.file === "string" && typeof one.reason === "string")) return null;
  const forced = value.forced ?? [];
  if (!isStrings(forced)) return null;
  return { ...(value as unknown as StoreRetireResponse), forced };
}

const unreadable = (who: string, what: string): Answer<never> => ({ ok: false, failure: { error: "unreadable", message: `${who} answered with something that is not ${what}` } });

/** What a steward from before the store says, over SSH: a route it does not carry. */
const STEWARD_OUTDATED = "the steward on the server does not keep a store of secrets yet: run sitesolide upgrade first, which brings the steward up to date";

/** The owner's transport: root on the machine asks the steward's owner socket, each body on standard input. */
export function sshStore(run: RunOnMachine): StoreTransport {
  const refusedSlug = (slug: string): Answer<never> => ({ ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } });
  const words = (unchanged: boolean) => ({ outdated: STEWARD_OUTDATED, unchanged });
  const steward = "the steward";
  const write = async (method: "PUT" | "DELETE" | "POST" | "PATCH", path: Parameters<typeof ownerWriteCommand>[1], body: object): Promise<Answer<StoreChangeResponse>> => {
    const read = await askSteward(run, ownerWriteCommand(method, path), JSON.stringify(body), words(true));
    if (!read.ok) return read;
    const change = readChange(read.value);
    return change === null ? unreadable(steward, "a change of the store") : { ok: true, value: change };
  };
  return {
    via: "over SSH, as the owner",
    owner: true,
    async list(slug) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      const read = await askSteward(run, ownerReadCommand(`/store?slug=${slug}`), undefined, words(false));
      if (!read.ok) return read;
      return isStoreView(read.value.store) ? { ok: true, value: read.value.store } : unreadable(steward, "a listing of the store");
    },
    async change(slug, change) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      const [first] = change.set;
      // One name set: the route the dashboard's Set takes; names removed alone: its Remove.
      if (change.set.length === 1 && change.remove.length === 0) return write("PUT", "/store/variable", { slug, name: first![0], value: first![1] });
      if (change.set.length === 0) return write("DELETE", "/store/variable", { slug, names: change.remove });
      return write("PATCH", "/store", { slug, set: Object.fromEntries(change.set), remove: change.remove });
    },
    async generate(slug, request) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      return write("POST", "/store/generate", { slug, ...request });
    },
    async setFile(slug, name, content) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      return write("PUT", "/store/file", { slug, name, content: content.toBase64() });
    },
    async removeFile(slug, name) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      return write("DELETE", "/store/file", { slug, name });
    },
    async restart(slug) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      const read = await askSteward(run, ownerWriteCommand("POST", "/restart"), JSON.stringify({ slug }), {
        outdated: "the steward on the server cannot restart a service over SSH yet: run sitesolide upgrade first, or restart it from the dashboard",
        unchanged: false,
      });
      if (!read.ok) return read;
      return isVerdict(read.value.verdict) ? { ok: true, value: { verdict: read.value.verdict } } : unreadable(steward, "a restart's verdict");
    },
    async migrate(slug, dryRun) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      // Conflicts refuse the migration with a 409 whose body is the migration's answer: read as one, so that they are said by name.
      const read = await askSteward(run, ownerWriteCommand("POST", "/store/migrate"), JSON.stringify({ slug, dryRun }), {
        ...words(true),
        answers: (status, body) => status === 409 && Array.isArray(body.conflicts) && body.conflicts.length > 0,
      });
      if (!read.ok) return read;
      const answer = readMigrate(read.value);
      return answer === null ? unreadable(steward, "a migration") : { ok: true, value: answer };
    },
    async retire(slug, files, force) {
      if (!isValidSlug(slug)) return refusedSlug(slug);
      const read = await askSteward(run, ownerWriteCommand("POST", "/store/retire"), JSON.stringify({ slug, files, ...(force ? { force: true } : {}) }), words(false));
      if (!read.ok) return read;
      const answer = readRetire(read.value);
      return answer === null ? unreadable(steward, "a retirement of legacy files") : { ok: true, value: answer };
    },
  };
}

/**
 * A project's leftover flat files, as the steward attaches them to it: those
 * no manifest declares and whose most specific owner by prefix is this
 * project, which names its secrets in its store. Root's alone, on the owner's
 * socket: `sitesolide remove` reads them before it deletes the served folder,
 * after which nobody can tell whose they are, and judges each again before
 * deleting it. A flat file's name each, or the failure.
 */
export async function ownerLeftovers(run: RunOnMachine, slug: string): Promise<Answer<string[]>> {
  if (!isValidSlug(slug)) return { ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } };
  const read = await askSteward(run, ownerReadCommand(`/store/leftovers?slug=${slug}`), undefined, {
    outdated: "the steward on the server cannot say which leftover secret files are this project's: run sitesolide upgrade first",
    unchanged: false,
  });
  if (!read.ok) return read;
  const leftovers = read.value.leftovers;
  if (read.value.slug !== slug || !isStrings(leftovers) || !leftovers.every(isLegacySecretName)) return unreadable("the steward", "a list of leftover files");
  return { ok: true, value: leftovers };
}

/**
 * A dashboard from before a route answers it from its catch-all, `not-found`
 * "no such route": said as what it is, a machine that does not carry it yet.
 */
function predatesRoute(answer: ApiAnswer<unknown>): boolean {
  return !answer.ok && answer.failure.error === "not-found" && answer.failure.message.startsWith("no such route");
}

/**
 * Whether a change may have reached the machine though no answer came back.
 * A connection refused sent nothing. A connection dropped once the request
 * had left, or an answer cut or replaced by a proxy's page, may follow a
 * write already made.
 */
function unanswered(answer: ApiAnswer<unknown>, thrown: unknown): boolean {
  if (answer.ok) return false;
  if (answer.failure.error === "unreachable") return (thrown as { code?: unknown } | null)?.code !== "ConnectionRefused";
  return answer.failure.error === "unreadable" && (answer.status < 400 || answer.status >= 500);
}

/** A change sent whose answer never came: said as what it is, and how to check, rather than "unreachable". */
function unconfirmed(slug: string, failure: Failure): Failure {
  return {
    error: "unconfirmed",
    message: `the change of ${slug}'s store was sent and its answer never came: it may have been written`,
    details: [
      failure.message,
      "sitesolide secrets lists the names the store holds: a name removed is gone once the change is written, a name set is there",
      "no value is read back, so a set over a value already there cannot be checked: running the same command again writes the change once more, harmlessly",
    ],
  };
}

/** A token's transport: the control API's store routes, the steward judging the token on the machine. */
export function apiStore(remote: Remote, fetcher: Fetch = fetch): StoreTransport {
  const base = (slug: string) => `/api/v1/projects/${encodeURIComponent(slug)}`;
  const outdated: Failure = {
    error: "not-available",
    message: `the dashboard at ${remote.api} does not carry the store of secrets by token yet: the owner of the machine runs sitesolide upgrade`,
  };
  const json = (method: string, body: object): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const change = async (slug: string, path: string, init: RequestInit): Promise<Answer<StoreChangeResponse>> => {
    // What fetch threw, kept to tell a connection refused, which sent nothing, from one dropped.
    let thrown: unknown = null;
    const answer: ApiAnswer<unknown> = await call(remote, path, init, async (input, given) => {
      try {
        return await fetcher(input, given);
      } catch (error) {
        thrown = error;
        throw error;
      }
    });
    if (predatesRoute(answer)) return { ok: false, failure: outdated };
    if (!answer.ok) return { ok: false, failure: unanswered(answer, thrown) ? unconfirmed(slug, answer.failure) : answer.failure };
    const read = readChange(answer.body);
    return read === null ? unreadable(remote.api, "the control API's change of a store") : { ok: true, value: read };
  };
  return {
    via: `through ${remote.api}`,
    owner: false,
    async list(slug) {
      const answer: ApiAnswer<{ store?: unknown }> = await call(remote, `${base(slug)}/store`, {}, fetcher);
      if (predatesRoute(answer)) return { ok: false, failure: outdated };
      if (!answer.ok) return { ok: false, failure: answer.failure };
      return isRecord(answer.body) && isStoreView(answer.body.store) ? { ok: true, value: answer.body.store } : unreadable(remote.api, "the control API's store");
    },
    change: (slug, asked) => change(slug, `${base(slug)}/store`, json("PATCH", { set: Object.fromEntries(asked.set), remove: asked.remove })),
    generate: (slug, request) => change(slug, `${base(slug)}/store/generate`, json("POST", request)),
    setFile: (slug, name, content) => change(slug, `${base(slug)}/store/files/${encodeURIComponent(name)}`, json("PUT", { content: content.toBase64() })),
    // No body: the route takes nothing, or `{ "restart": true }`, which this CLI asks for apart.
    removeFile: (slug, name) => change(slug, `${base(slug)}/store/files/${encodeURIComponent(name)}`, { method: "DELETE" }),
    async restart(slug) {
      const answer: ApiAnswer<{ verdict?: unknown }> = await call(remote, `${base(slug)}/restart`, { method: "POST" }, fetcher);
      if (predatesRoute(answer)) return { ok: false, failure: { ...outdated, message: `the dashboard at ${remote.api} does not carry restarts by token yet: the owner of the machine runs sitesolide upgrade` } };
      if (!answer.ok) return { ok: false, failure: answer.failure };
      return isRecord(answer.body) && isVerdict(answer.body.verdict) ? { ok: true, value: { verdict: answer.body.verdict } } : unreadable(remote.api, "a restart's verdict");
    },
    migrate: null,
    retire: null,
  };
}

// --- what it says ---------------------------------------------------------------------

/** A verdict in words: what systemd says, and whether the service holds. */
export function verdictWords(verdict: RestartVerdict): string {
  const said = { active: "holds", looping: "restarts in a loop", failure: "did not come back", scheduled: "restarts once this answer has left" }[verdict.kind] ?? verdict.kind;
  // Why, when the steward can say better than systemd: a service that could not load its secret files.
  const why = typeof verdict.reason === "string" && verdict.reason !== "" ? `; ${verdict.reason}` : "";
  return `${verdict.state}, ${verdict.subState}, ${verdict.restarts} restart(s) by systemd: the service ${said}${why}`;
}

/** A restart that did not leave the service running: the run fails, saying what was already done. */
export function restartFailed(slug: string, verdict: RestartVerdict, done: string[] = []): Failure {
  return {
    error: "restart-failed",
    message: `the service of ${slug} did not hold after its restart: ${verdictWords(verdict)}`,
    details: [...done, "sitesolide logs says why"],
  };
}

/** How the service finds a file: under $CREDENTIALS_DIRECTORY, with systemd's prefix. */
function filePath(name: string): string {
  return `$CREDENTIALS_DIRECTORY/${credentialName(name)}`;
}

function fileWords(file: StoreFileView): string {
  const own = file.bytes === null ? "" : ` (${file.bytes} bytes)`;
  const declared = file.declared ? "" : ", not declared in sitesolide.json";
  if (file.state === "set") return `${file.name} set${own}${declared}`;
  if (file.state === "missing") return `${file.name} missing (sitesolide secrets set-file ${file.name} < ${file.name})`;
  return `${file.name} not managed${file.reason === null ? "" : `, ${file.reason}`}${declared}`;
}

/**
 * What to do with a legacy file the store does not cover, told by the cause.
 * A name it holds that the store lacks is a value the store does not have:
 * migrate carries it over when a unit reads the file; a leftover no unit
 * reads is not migrated, and its value is set in the store by hand first if
 * the service needs it. Never --force then: retiring would delete the only
 * copy. Only when the store holds every name, its values overriding the
 * file's, does `--retire --force` let the store's stand alone.
 */
function uncovered(legacy: LegacyFileView, inStore: ReadonlySet<string>): string {
  const lacking = legacy.variables.filter((name) => !inStore.has(name));
  if (lacking.length === 0) return "its values differ from the store's, which overrides them: sitesolide secrets migrate --retire --force lets the store's stand alone";
  const names = `${lacking.join(", ")}, which the store lacks`;
  if (legacy.read) return `holds ${names}: sitesolide secrets migrate first, never --retire --force, which would drop ${lacking.length === 1 ? "it" : "them"}`;
  return `holds ${names} and no unit reads: set ${lacking.length === 1 ? "it" : "them"} in the store first if the service needs ${lacking.length === 1 ? "it" : "them"}, the owner reads this file in the dashboard; --retire --force would delete the only copy`;
}

/**
 * The listing, the lines under its title: each variable and where its value
 * comes from, the files and the path the service reads them at, the legacy
 * files and what retiring them takes, the build's names, and whether a
 * restart is pending. Names alone: a value is never shown, nor its length.
 */
export function storeLines(view: StoreView): string[] {
  const lines: string[] = [];
  if (view.state === "unmanaged") lines.push(`   !! the store is not managed by the dashboard${view.reason === null ? "" : `: ${view.reason}`}; the owner of the machine must look at it`);
  if (view.unitReadsStore === false) lines.push(`   !! the service does not read the store yet: deploy the project, or sitesolide refresh ${view.slug}, so that it does`);
  const width = Math.max(0, ...view.variables.map((variable) => variable.name.length)) + 3;
  for (const variable of view.variables) {
    const overrides = variable.shadows.length === 0 ? "" : `, overrides ${variable.shadows.join(", ")}`;
    const undeclared = variable.declared ? "" : ", not declared in sitesolide.json";
    const state =
      variable.source === "store"
        ? `set${overrides}${undeclared}`
        : variable.source === "legacy"
          ? `from ${variable.file ?? "a legacy file"}${overrides}${undeclared}`
          : `missing: sitesolide secrets set ${variable.name}`;
    lines.push(`   ${variable.name.padEnd(width)}${state}`);
  }
  if (view.variables.length === 0) lines.push("   no variable yet: sitesolide secrets set NAME, or sitesolide secrets generate NAME");
  if (view.files.length > 0) lines.push(`   files, read at ${filePath("<name>")}: ${view.files.map(fileWords).join(", ")}`);
  const inStore = new Set(view.variables.filter((variable) => variable.source === "store").map((variable) => variable.name));
  for (const legacy of view.legacy) {
    const parts = [
      legacy.state === "absent" ? "missing" : legacy.state === "unmanaged" ? `not managed${legacy.reason === null ? "" : `, ${legacy.reason}`}` : null,
      legacy.read ? "read by the service" : null,
      legacy.leftover ? "no longer declared" : null,
      legacy.covered === true ? "covered by the store: sitesolide secrets migrate --retire" : legacy.covered === false ? uncovered(legacy, inStore) : null,
    ].filter((part): part is string => part !== null);
    lines.push(`   legacy: ${legacy.name}${parts.length === 0 ? "" : `, ${parts.join(", ")}`}`);
  }
  if (view.build.length > 0) lines.push(`   build, kept by whoever deploys: ${view.build.join(", ")}`);
  if (view.public.length > 0) lines.push(`   public, from sitesolide.json's env: ${view.public.map((entry) => entry.name).join(", ")}`);
  if (view.restartPending) lines.push("   restart pending: sitesolide secrets ... --restart, or the dashboard's Restart service");
  lines.push("   a value is never shown here");
  return lines;
}

/**
 * The listing with this folder's manifest in place of the deployed one:
 * deploy reads the store before it deposits the manifest, and a name the
 * new manifest declares is missing too. A name only the store supplies is
 * not, and a file present is not. A name a legacy file supplies is missing:
 * a manifest that names its variables makes units that read no legacy file,
 * so that value would be gone at the next start (legacyLoss stops the
 * deployment before that happens).
 */
export function withDeclared(view: StoreView, declaration: SecretsDeclaration): StoreView {
  const supplied = new Set(view.variables.filter((variable) => (declaration.form === "legacy" ? variable.source !== "none" : variable.source === "store")).map((variable) => variable.name));
  const missing = declaration.runtime.filter((name) => !supplied.has(name));
  const files: StoreFileView[] = view.files.map((file) => ({ ...file, declared: declaration.files.includes(file.name) }));
  for (const name of declaration.files) {
    if (!files.some((file) => file.name === name)) files.push({ name, state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false });
  }
  return { ...view, missing, files: files.filter((file) => file.declared || file.state !== "missing") };
}

/**
 * What a deployment would drop of the values the service runs with today:
 * the names a legacy file the installed units read holds, and that neither
 * the store nor a legacy file the new manifest still declares (`kept`)
 * supplies, each with the files that hold it; and the legacy files the
 * units read that the manifest no longer declares and that are not managed,
 * whose names cannot be told. A manifest that names its variables, or none,
 * keeps no legacy file: its units read the store alone. One in the old form
 * keeps the files it declares, and drops the others. Either way each of
 * these values would be gone at the next start: the service runs on without
 * it, often without a word. Names only.
 */
export function legacyLoss(view: StoreView, kept: readonly string[] = []): { names: { name: string; files: string[] }[]; unmanaged: string[] } {
  const inStore = new Set(view.variables.filter((variable) => variable.source === "store").map((variable) => variable.name));
  const stays = new Set(kept);
  const supplied = new Set(view.legacy.filter((file) => stays.has(file.name) && file.state === "managed").flatMap((file) => file.variables));
  const names = new Map<string, string[]>();
  const unmanaged: string[] = [];
  for (const file of view.legacy) {
    if (!file.read || file.state === "absent" || stays.has(file.name)) continue;
    if (file.state === "unmanaged") {
      unmanaged.push(file.name);
      continue;
    }
    for (const name of file.variables) {
      if (inStore.has(name) || supplied.has(name)) continue;
      names.set(name, [...(names.get(name) ?? []), file.name]);
    }
  }
  return { names: [...names].map(([name, files]) => ({ name, files })), unmanaged };
}

/**
 * The stop of a deployment or a refresh that would drop values the service
 * reads today: before anything is sent or written, with the command that
 * carries them into the store first. A data-loss guard, not a missing
 * secret: a name set nowhere never stops anything. `declaration` is the
 * manifest about to be deployed: in the old form, the legacy files it
 * declares are still read.
 */
export function legacyLossRefusal(view: StoreView, nothing: string, declaration?: SecretsDeclaration): { message: string; details: string[] } | null {
  const legacyForm = declaration?.form === "legacy";
  const { names, unmanaged } = legacyLoss(view, legacyForm ? declaration!.legacy : []);
  if (names.length === 0 && unmanaged.length === 0) return null;
  const listed = names.map(({ name }) => name);
  const message =
    names.length > 0
      ? `migrate first: sitesolide secrets migrate --restart; the service reads ${listed.join(", ")} from legacy files this manifest no longer reads, and the store lacks ${names.length === 1 ? "it" : "them"}`
      : `migrate first: sitesolide secrets migrate --restart; the service reads ${unmanaged.join(", ")}, which the dashboard does not manage, and this manifest no longer reads ${unmanaged.length === 1 ? "it" : "them"}`;
  const dropped = [...new Set([...names.flatMap(({ files }) => files), ...unmanaged])];
  return {
    message,
    details: [
      ...names.map(({ name, files }) => `${name}: in ${files.join(", ")}`),
      ...unmanaged.map((file) => `${file}: read by the service, not managed by the dashboard, its variables cannot be told: fix it in the Secrets section first`),
      legacyForm
        ? `deployed as it is, the service would start without them: this manifest's units no longer read ${dropped.join(", ")}`
        : "deployed as it is, the service would start without them: the units of a manifest that names its variables read the store alone",
      "sitesolide secrets migrate --restart copies them into the store and restarts the service, the owner's, over SSH; then deploy again",
      ...(legacyForm ? [`or keep ${dropped.join(", ")} under secrets in sitesolide.json`] : []),
      nothing,
    ],
  };
}

/** The names a listing says are missing: declared runtime names with no value, declared files not present. */
export function missingOf(view: StoreView): StoreMissing {
  return { runtime: [...view.missing], files: view.files.filter((file) => file.declared && file.state === "missing").map((file) => file.name) };
}

/** The warning of names missing, for whoever deploys without a terminal: the commands that set each, never a value. */
export function missingWarning(missing: StoreMissing): { message: string; details: string[] } {
  const parts = [
    ...(missing.runtime.length > 0 ? [`runtime secrets not set on the server: ${missing.runtime.join(", ")}`] : []),
    ...(missing.files.length > 0 ? [`files not set on the server: ${missing.files.join(", ")}`] : []),
  ];
  return {
    message: parts.join("; "),
    details: [
      ...missing.runtime.map((name) => `sitesolide secrets set ${name}, or sitesolide secrets generate ${name} (a random key, drawn on the server)`),
      ...missing.files.map((name) => `sitesolide secrets set-file ${name} < path`),
      "the deployment goes on: a service that cannot live without one stops at start, and says so in its log",
    ],
  };
}

/**
 * A refusal with no value of the request in it: the steward quotes none, the
 * dashboard withholds a message that would, and this is the third lock.
 */
export function withheld(failure: Failure, values: readonly string[]): Failure {
  const quotes = (text: string) => values.some((value) => value.length >= 4 && text.includes(value));
  if (!quotes(failure.message) && !(failure.details ?? []).some(quotes)) return failure;
  return { error: failure.error, message: "the steward refused the change; its message is withheld: see the project's Activity", ...(failure.wait === undefined ? {} : { wait: failure.wait }) };
}

/** What deploy's missing-names step needs of its terminal and its output. */
export type MissingIo = {
  /** Standard input and output are terminals, where a person answers. */
  terminal: boolean;
  json: boolean;
  /** A line typed in answer, null at the end of input. */
  ask: (question: string) => Promise<string | null>;
  /** A value typed without echo. */
  secret: (question: string) => Promise<Typed>;
  say: (line: string) => void;
  warn: (message: string, details: string[]) => void;
};

/** The answer to the question, read loosely: s, g or l, or the word. */
function choice(answer: string | null): "set" | "generate" | "leave" | null {
  if (answer === null) return "leave";
  const word = answer.trim().toLowerCase();
  if (word === "s" || word === "set") return "set";
  if (word === "g" || word === "generate") return "generate";
  if (word === "l" || word === "leave" || word === "") return "leave";
  return null;
}

/**
 * The missing-names step of deploy, before the build and before the Caddy
 * lock: a person thinking at a prompt never holds the lock every other
 * deployment waits for. A missing name never stops a deployment.
 *
 * At a terminal, each missing runtime name is asked for: set now, typed
 * without echo; generated on the server, never shown; or left unset. No
 * restart is asked, the deployment restarts. A file is never prompted for:
 * one line says how to set it. Otherwise, one warning names them all, with
 * the commands. Returns what is still missing.
 */
export async function handleMissing(view: StoreView, transport: StoreTransport, io: MissingIo): Promise<StoreMissing> {
  const missing = missingOf(view);
  if (missing.runtime.length === 0 && missing.files.length === 0) return missing;
  if (!io.terminal || io.json) {
    const warning = missingWarning(missing);
    io.warn(warning.message, warning.details);
    return missing;
  }
  const left: string[] = [];
  for (const name of missing.runtime) {
    let decided: ReturnType<typeof choice> = null;
    for (let tries = 0; tries < 3 && decided === null; tries++) {
      decided = choice(await io.ask(`${name} is not set on the server. [s]et it now (typed, not shown), [g]enerate a random value on the server, or [l]eave it unset? `));
    }
    if (decided === null || decided === "leave") {
      io.say(`   ${name} left unset`);
      left.push(name);
      continue;
    }
    if (decided === "generate") {
      const generated = await transport.generate(view.slug, { name, format: "hex", bytes: GENERATE_DEFAULT_BYTES });
      if (!generated.ok) {
        io.say(`   !! ${name} not generated: ${generated.failure.message}`);
        left.push(name);
      } else io.say(`   ${name} generated on the server, never shown`);
      continue;
    }
    const typed = await io.secret(`${name} (no echo): `);
    if (typed === null || typed === "") {
      io.say(`   ${name} left unset: nothing typed`);
      left.push(name);
      continue;
    }
    if (typeof typed !== "string") {
      io.say(`   !! ${name} left unset: ${typed.refused}`);
      left.push(name);
      continue;
    }
    const refusal = checkValue(typed);
    if (refusal !== null) {
      io.say(`   !! ${name} left unset: ${refusal}`);
      left.push(name);
      continue;
    }
    const set = await transport.change(view.slug, { set: [[name, typed]], remove: [] });
    if (!set.ok) {
      io.say(`   !! ${name} not set: ${withheld(set.failure, [typed]).message}`);
      left.push(name);
    } else io.say(`   ${name} set`);
  }
  for (const name of missing.files) io.say(`   the file ${name} is not set on the server: sitesolide secrets set-file ${name} < path`);
  return { runtime: left, files: missing.files };
}

// --- the commands ------------------------------------------------------------------------

/** What the commands read and print through: injectable, so that the tests drive every path. */
export type StoreDependencies = {
  output: Output;
  json: boolean;
  /** Whether standard input is a terminal, where a person types and `--stdin` would echo. */
  terminal: () => boolean;
  /** All of standard input, as bytes. */
  stdin: () => Promise<Uint8Array>;
  /** A value typed without echo: promptWithoutEcho in ./remote. */
  secretPrompt: (question: string) => Promise<Typed>;
};

function report(output: Output, failure: Failure): number {
  output.failed(failure);
  return 1;
}

/** A value refused here, before it travels: never quoted. */
function refusedValue(reason: string): Failure {
  return {
    error: "invalid",
    message: `${reason}: nothing was sent`,
    details: [
      "the machine takes a value on one line, without a null byte, in valid Unicode with no noncharacter, 8 KiB at most",
      "a key or a certificate of several lines goes in a file read whole: sitesolide secrets set-file NAME < path",
    ],
  };
}

/** A key the prompt does not take, or several lines pasted into it. */
function refusedTyping(reason: string): Failure {
  return {
    error: "invalid",
    message: `${reason}: nothing was sent`,
    details: [
      "at the prompt, Backspace, Ctrl-U and Ctrl-W edit the value, Enter ends it, Ctrl-C abandons it",
      "what followed was read and dropped here, not passed to the shell",
      "a value of several lines goes in a file read whole: sitesolide secrets set-file NAME < path",
    ],
  };
}

/**
 * `--stdin` reads a pipe. At a terminal, reading standard input would show
 * the value as it is typed, on screen and in the scrollback, until Ctrl-D.
 */
const STDIN_IS_TERMINAL: Failure = {
  error: "stdin-is-terminal",
  message: "--stdin reads a pipe, and standard input is this terminal, where the value would show as it is typed: nothing was sent",
  details: ["pipe the value: <command> | sitesolide secrets set NAME --stdin", "or drop --stdin to be prompted without echo: sitesolide secrets set NAME"],
};

const FILE_FROM_TERMINAL: Failure = {
  error: "stdin-is-terminal",
  message: "secrets set-file reads the file from standard input, and standard input is this terminal: nothing was sent",
  details: ["redirect the file: sitesolide secrets set-file NAME < path"],
};

/** The value of `set`: piped, or typed without echo; a refusal otherwise, nothing sent. */
async function valueToSet(ask: Extract<StoreAsk, { action: "set" }>, slug: string, deps: StoreDependencies): Promise<string | Failure> {
  const atTerminal = deps.terminal();
  let value: string;
  if (ask.stdin) {
    // Asked before anything is read: reading is what would echo.
    if (atTerminal) return STDIN_IS_TERMINAL;
    let piped: string;
    try {
      piped = new TextDecoder("utf-8", { fatal: true }).decode(await deps.stdin());
    } catch {
      return refusedValue("the value piped is not valid UTF-8");
    }
    // One trailing line break is the pipe's, `echo` adds one: never the value's.
    value = piped.replace(/\r?\n$/, "");
  } else if (atTerminal) {
    const typed = await deps.secretPrompt(`${ask.name} for ${slug}'s store (no echo): `);
    if (typed === null) return { error: "cancelled", message: "nothing typed: nothing was sent" };
    if (typeof typed !== "string") return refusedTyping(typed.refused);
    value = typed;
  } else {
    return { error: "needs-stdin", message: "no terminal to type the value in: pipe it to --stdin; nothing was sent", details: ["sitesolide secrets set NAME --stdin"] };
  }
  // An unset variable piped by mistake reads as nothing: it would empty the secret without a word.
  if (value === "") return { error: "invalid", message: "the value is empty: nothing was sent", details: ["to take a variable out: sitesolide secrets remove NAME"] };
  const refusal = checkValue(value);
  return refusal === null ? value : refusedValue(refusal);
}

/** A file's bytes from standard input: never a terminal, never empty, 64 KiB at most. */
async function fileToSet(deps: StoreDependencies): Promise<Uint8Array | Failure> {
  if (deps.terminal()) return FILE_FROM_TERMINAL;
  const bytes = await deps.stdin();
  if (bytes.length === 0) return { error: "invalid", message: "the file is empty: nothing was sent", details: ["redirect the file: sitesolide secrets set-file NAME < path"] };
  if (bytes.length > MAX_STORE_FILE_BYTES) return { error: "invalid", message: "the file is larger than 64 KiB, what the store takes for one file: nothing was sent" };
  return bytes;
}

/** How to apply a change once written, said by who asks. */
function restartAdvice(transport: StoreTransport): string {
  return transport.owner
    ? "the service reads it once restarted: --restart with the change, or the dashboard's Restart service"
    : "the service reads it once restarted: sitesolide restart, or --restart with the change";
}

/** A change written, said, then the restart when asked. */
async function concludeChange(
  action: string,
  slug: string,
  change: StoreChangeResponse,
  restart: boolean,
  transport: StoreTransport,
  output: Output,
): Promise<number> {
  if (change.created) output.say(`   the store of ${slug} was created`);
  if (change.set.length > 0) output.say(`   set: ${change.set.join(", ")}`);
  if (change.generated.length > 0) output.say(`   generated on the server, never shown: ${change.generated.join(", ")}`);
  if (change.removed.length > 0) output.say(`   removed: ${change.removed.join(", ")}`);
  if (change.absent.length > 0) output.say(`   not in the store, nothing to remove: ${change.absent.join(", ")}`);
  for (const name of change.files.set) output.say(`   file set: ${name}, read at ${filePath(name)}`);
  if (change.files.removed.length > 0) output.say(`   file removed: ${change.files.removed.join(", ")}`);
  if (change.store.unitReadsStore === false) output.say(`   !! the service does not read the store yet: deploy the project, or sitesolide refresh ${slug}, so that it does`);
  const done = [
    ...(change.set.length > 0 ? [`set in the store: ${change.set.join(", ")}`] : []),
    ...(change.generated.length > 0 ? [`generated in the store: ${change.generated.join(", ")}`] : []),
    ...(change.removed.length > 0 ? [`removed from the store: ${change.removed.join(", ")}`] : []),
    ...(change.files.set.length > 0 ? [`file set: ${change.files.set.join(", ")}`] : []),
    ...(change.files.removed.length > 0 ? [`file removed: ${change.files.removed.join(", ")}`] : []),
  ];
  const result = {
    action,
    slug,
    created: change.created,
    set: change.set,
    generated: change.generated,
    removed: change.removed,
    absent: change.absent,
    files: change.files,
  };
  if (!restart) {
    if (change.store.restartPending) output.say(`   ${restartAdvice(transport)}`);
    output.succeeded("secrets", { ...result, restart: null });
    return 0;
  }
  output.say("-> restart");
  const restarted = await transport.restart(slug);
  if (!restarted.ok) {
    return report(output, { ...restarted.failure, message: `the change is written, the restart was not made: ${restarted.failure.message}`, details: [...(restarted.failure.details ?? []), ...done] });
  }
  output.say(`   ${verdictWords(restarted.value.verdict)}`);
  if (restarted.value.verdict.kind !== "active") return report(output, restartFailed(slug, restarted.value.verdict, [...done, "the change is written"]));
  output.succeeded("secrets", { ...result, restart: restarted.value.verdict });
  return 0;
}

/** The project's service restarted and watched for a few seconds: the exit code says whether it holds. */
export async function restartCommand(slug: string, transport: StoreTransport, output: Output): Promise<number> {
  output.say(`-> restart ${slug}, ${transport.via}`);
  const answer = await transport.restart(slug);
  if (!answer.ok) return report(output, answer.failure);
  output.say(`   ${verdictWords(answer.value.verdict)}`);
  if (answer.value.verdict.kind !== "active") return report(output, restartFailed(slug, answer.value.verdict));
  output.succeeded("restart", { slug, verdict: answer.value.verdict });
  return 0;
}

const OWNER_ONLY = (action: string): Failure => ({
  error: "needs-ssh",
  message: `sitesolide secrets ${action} is the owner's, over SSH: it reads the project's legacy files, which no token may`,
  details: ["ask the owner of the machine, who runs it from a workstation configured with sitesolide init", "or the dashboard's Merge into the store, unlocked by the owner"],
});

/** Runs one `secrets` command on `slug`'s store; the exit code is returned, never thrown. */
export async function runStore(ask: StoreAsk, slug: string, transport: StoreTransport, deps: StoreDependencies): Promise<number> {
  const { output } = deps;
  switch (ask.action) {
    case "list": {
      const listed = await transport.list(slug);
      if (!listed.ok) return report(output, listed.failure);
      output.say(`-> secrets of ${slug}, ${transport.via}`);
      for (const line of storeLines(listed.value)) output.say(line);
      output.succeeded("secrets", { slug, store: listed.value });
      return 0;
    }
    case "set": {
      const value = await valueToSet(ask, slug, deps);
      if (typeof value !== "string") return report(output, value);
      output.say(`-> ${slug}'s store, ${transport.via}`);
      const changed = await transport.change(slug, { set: [[ask.name, value]], remove: [] });
      if (!changed.ok) return report(output, withheld(changed.failure, [value]));
      return concludeChange("set", slug, changed.value, ask.restart, transport, output);
    }
    case "generate": {
      output.say(`-> ${slug}'s store, ${transport.via}: ${ask.name}, ${ask.bytes} random bytes in ${ask.format}, drawn on the server`);
      const generated = await transport.generate(slug, { name: ask.name, format: ask.format, bytes: ask.bytes, ...(ask.replace ? { replace: true } : {}) });
      if (!generated.ok) return report(output, generated.failure);
      return concludeChange("generate", slug, generated.value, ask.restart, transport, output);
    }
    case "remove": {
      output.say(`-> ${slug}'s store, ${transport.via}`);
      const removed = await transport.change(slug, { set: [], remove: ask.names });
      if (!removed.ok) return report(output, removed.failure);
      return concludeChange("remove", slug, removed.value, ask.restart, transport, output);
    }
    case "set-file": {
      const bytes = await fileToSet(deps);
      if (!(bytes instanceof Uint8Array)) return report(output, bytes);
      output.say(`-> ${slug}'s store, ${transport.via}: the file ${ask.name}, ${bytes.length} bytes`);
      const set = await transport.setFile(slug, ask.name, bytes);
      if (!set.ok) return report(output, set.failure);
      return concludeChange("set-file", slug, set.value, ask.restart, transport, output);
    }
    case "remove-file": {
      output.say(`-> ${slug}'s store, ${transport.via}`);
      const removed = await transport.removeFile(slug, ask.name);
      if (!removed.ok) return report(output, removed.failure);
      return concludeChange("remove-file", slug, removed.value, ask.restart, transport, output);
    }
    case "migrate": {
      if (transport.migrate === null) return report(output, OWNER_ONLY("migrate"));
      output.say(`-> ${slug}: the legacy files merged into the store, ${transport.via}${ask.dryRun ? ", dry run, nothing written" : ""}`);
      const migrated = await transport.migrate(slug, ask.dryRun);
      if (!migrated.ok) return report(output, migrated.failure);
      const answer = migrated.value;
      const fields = { action: "migrate", slug, dryRun: ask.dryRun, sources: answer.sources, skipped: answer.skipped, merged: answer.merged, already: answer.already, overridden: answer.overridden, shadowed: answer.shadowed, conflicts: answer.conflicts, written: answer.written };
      if (answer.conflicts.length > 0) {
        // The units read the files in different orders: which value is in effect cannot be told.
        return report(output, {
          error: "migrate-conflict",
          message: `the units of ${slug} read its legacy files in different orders, so which value of ${answer.conflicts.map((conflict) => conflict.name).join(", ")} is in effect cannot be told: nothing was written`,
          details: [...answer.conflicts.map((conflict) => `${conflict.name}: in ${conflict.files.join(" and ")}`), `sitesolide refresh ${slug}, so that every unit reads them in one order, then migrate again`],
        });
      }
      output.say(`   read: ${answer.sources.length === 0 ? "no legacy file" : answer.sources.join(", ")}`);
      for (const skipped of answer.skipped) output.say(`   skipped: ${skipped.file}, ${skipped.reason}`);
      if (answer.merged.length > 0) output.say(`   ${ask.dryRun ? "would be merged" : "merged"}: ${answer.merged.join(", ")}`);
      if (answer.already.length > 0) output.say(`   already in the store, the same: ${answer.already.join(", ")}`);
      // Two legacy files set it differently: the value in effect, the last the units read, is the one merged.
      for (const shadowed of answer.shadowed) {
        const others = shadowed.others.map((file) => `${file}'s`).join(" and ");
        output.say(`   ${shadowed.name}: kept ${shadowed.kept}'s value, in effect; ${others} ${shadowed.others.length === 1 ? "differs" : "differ"}`);
      }
      if (answer.overridden.length > 0) output.say(`   in the store with another value, which it keeps and the service already reads: ${answer.overridden.join(", ")}`);
      if (!ask.dryRun) output.say(answer.written ? "   the store was written; the legacy files are untouched" : "   nothing to write: the store already holds every name");
      if (ask.dryRun || !ask.restart) {
        if (!ask.dryRun && answer.written) output.say("   then: sitesolide secrets migrate --restart, or a deploy, and once the service holds, sitesolide secrets migrate --retire");
        output.succeeded("secrets", { ...fields, restart: null });
        return 0;
      }
      output.say("-> restart");
      const restarted = await transport.restart(slug);
      if (!restarted.ok) return report(output, { ...restarted.failure, message: `the migration is written, the restart was not made: ${restarted.failure.message}` });
      output.say(`   ${verdictWords(restarted.value.verdict)}`);
      if (restarted.value.verdict.kind !== "active") return report(output, restartFailed(slug, restarted.value.verdict, ["the migration is written"]));
      output.succeeded("secrets", { ...fields, restart: restarted.value.verdict });
      return 0;
    }
    case "retire": {
      if (transport.retire === null) return report(output, OWNER_ONLY("migrate --retire"));
      const listed = await transport.list(slug);
      if (!listed.ok) return report(output, listed.failure);
      const files = listed.value.legacy.filter((legacy) => legacy.state !== "absent").map((legacy) => legacy.name);
      output.say(`-> ${slug}: the legacy files the store covers deleted, ${transport.via}`);
      if (files.length === 0) {
        output.say("   no legacy file to retire");
        output.succeeded("secrets", { action: "retire", slug, force: ask.force, retired: [], forced: [], kept: [] });
        return 0;
      }
      const retired = await transport.retire(slug, files, ask.force);
      if (!retired.ok) return report(output, retired.failure);
      const plain = retired.value.retired.filter((file) => !retired.value.forced.includes(file));
      if (plain.length > 0) output.say(`   retired, each kept as a copy with the project: ${plain.join(", ")}`);
      if (retired.value.forced.length > 0) output.say(`   retired with --force, the store's values standing over theirs, each kept as a copy: ${retired.value.forced.join(", ")}`);
      for (const kept of retired.value.kept) output.say(`   kept: ${kept.file}, ${kept.reason}`);
      output.succeeded("secrets", { action: "retire", slug, force: ask.force, retired: retired.value.retired, forced: retired.value.forced, kept: retired.value.kept });
      return 0;
    }
  }
}
