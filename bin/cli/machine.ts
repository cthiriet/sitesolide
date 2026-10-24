/**
 * `sitesolide machine`: the VM itself, ordered from a cloud provider's API,
 * before `sitesolide setup` installs anything on it.
 *
 *   sitesolide machine create --provider hetzner --name web
 *   sitesolide machine list --provider aws
 *   sitesolide machine destroy web --provider gcp
 *   sitesolide machine providers
 *
 * It replaces what infra/main.tf did with Terraform: a server, its firewall,
 * and the workstation's SSH key, with no state file to keep. What exists is
 * read from the provider each time, and found again by the labels every
 * resource carries (bin/cli/providers/provider.ts), so a run interrupted
 * anywhere is finished by running the same command again. Each provider is a
 * file of bin/cli/providers/, registered in PROVIDERS below; the setup wizard
 * (bin/cli/wizard.ts) drives the same functions.
 *
 * `create` stops once the machine accepts connections on port 22, and prints
 * the `setup` command that comes next. It hardens nothing: cloud-init, which
 * did it up to 0.2, ran once and could not be checked; `setup` runs over SSH
 * and can be run again.
 *
 * **The credentials.** They come from the provider's usual environment
 * variables, HCLOUD_TOKEN for Hetzner, AWS_ACCESS_KEY_ID and its secret for
 * AWS, from standard input with `--token-stdin`, or, when the environment
 * holds none, from the provider's own CLI already signed in (`discover`), and
 * from nowhere else: an option would put them in `ps` and in the shell's
 * history. They go into the provider's API, in a header or a signature, and
 * nowhere else: every line this command prints, every refusal and every
 * result passes through `redacting`, which replaces each secret, should it
 * ever turn up, with `[token]`.
 *
 * **Destroying.** Only a machine carrying `managed-by=sitesolide`, and only
 * once its name is typed back, at the terminal or with `--confirm <name>`
 * where there is none. The SSH key stays unless `--delete-key`, and DNS
 * records are never touched: the zone is not the provider's.
 *
 * A refusal carries a code of REMOTE_HINTS in bin/cli/hints.ts, as `share`
 * and the team commands do: bin/tests/cli-machine.test.ts fails on a code this
 * file or a provider uses and the table lacks.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./config";
import { HOST_KEY_CHANGED, hostKeyAdvice } from "./harden";
import { AWS } from "./providers/aws";
import { AZURE } from "./providers/azure";
import { DIGITALOCEAN } from "./providers/digitalocean";
import { GCP } from "./providers/gcp";
import { dnsVariables } from "./dns/registry";
import { HETZNER } from "./providers/hetzner";
import { LINODE } from "./providers/linode";
import { SCALEWAY } from "./providers/scaleway";
import { VULTR } from "./providers/vultr";
import {
  formatPrice,
  ProviderError,
  realClock,
  type Clock,
  type CredentialField,
  type Credentials,
  type Fetch,
  type Machine,
  type Provider,
  type ProviderEntry,
  type PublicKey,
  type Workstation,
} from "./providers/provider";
import { humanOutput, report, type Failure, type Output } from "./remote";

/** The providers `--provider` accepts, in the order the wizard offers them. */
export const PROVIDER_LIST: readonly ProviderEntry[] = [HETZNER, DIGITALOCEAN, AWS, GCP, AZURE, SCALEWAY, VULTR, LINODE];

/** The same, by the name `--provider` takes. */
export const PROVIDERS: Readonly<Record<string, ProviderEntry>> = Object.fromEntries(PROVIDER_LIST.map((entry) => [entry.name, entry]));

/** Hetzner's defaults, which the first version of this command had for everyone. */
export const DEFAULTS = HETZNER.defaults({});

/** The public keys tried, in this order, under ~/.ssh, when --ssh-key is not given. */
export const DEFAULT_KEYS = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

/** How long `create` waits for port 22, how often it tries, and how long one try lasts. */
export const SSH_WAIT = { totalMs: 5 * 60_000, pollMs: 3_000, attemptMs: 5_000 };

/** How long `create` waits, after port 22 answers, for the image to let the account in with the key. */
export const LOGIN_WAIT = { totalMs: 4 * 60_000, pollMs: 5_000 };

export const MACHINE_USAGE = [
  "usage of sitesolide machine:",
  "  sitesolide machine create --provider <provider> --name <name>",
  "                                  order a VM, its firewall and your SSH key, ready for setup",
  "     --type <type>                the provider's smallest sound type by default; a refusal lists others",
  "     --location <location>        a location in Europe by default, see docs/providers/",
  "     --image <image>              debian-13 by default",
  "     --backups                    the provider's daily backups, where it has them, at a price",
  "     --ssh-key <path.pub>         ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub by default,",
  "                                  else the SSH agent's key; or SHA256:... for one the agent holds",
  "  sitesolide machine list --provider <provider>",
  "                                  the machines sitesolide created, their addresses and price",
  "  sitesolide machine destroy <name> --provider <provider>",
  "                                  delete the machine and its firewall, for good",
  "     --confirm <name>             the name typed back, where no terminal can ask for it",
  "     --delete-key                 delete the SSH key uploaded for it too",
  "  sitesolide machine providers",
  "                                  the providers, and whether this workstation holds credentials for each",
  "  create, list or destroy --token-stdin",
  "                                  read the credentials from standard input rather than the environment",
  "",
  `providers: ${PROVIDER_LIST.map((entry) => entry.name).join(", ")}`,
  "--json, on every one of them: one JSON event per line, see docs/agents.md",
  "credentials are never an option, where ps would show them: see docs/machine.md",
];

type Action = "create" | "list" | "destroy" | "providers";

/** The options of each command, and whether one takes a value. `--json` is everyone's. */
const OPTIONS: Readonly<Record<Action, Readonly<Record<string, boolean>>>> = {
  create: { "--provider": true, "--name": true, "--type": true, "--location": true, "--image": true, "--backups": false, "--ssh-key": true, "--token-stdin": false },
  list: { "--provider": true, "--token-stdin": false },
  destroy: { "--provider": true, "--confirm": true, "--delete-key": false, "--token-stdin": false },
  providers: {},
};

export type MachineArguments = { action: Action; values: Record<string, string>; flags: Set<string>; positionals: string[] };

export type MachineDependencies = {
  environment: Record<string, string | undefined>;
  home?: string;
  output?: Output;
  fetcher?: Fetch;
  stdin?: () => Promise<string>;
  prompt?: (question: string) => string | null;
  /** Whether a person can be asked something: standard input is a terminal. */
  interactive?: boolean;
  clock?: Clock;
  /** Whether a TCP connection to that address opens; tests point it at a local listener. */
  probe?: (hostname: string, port: number) => Promise<boolean>;
  /** Where port 22 of a new machine is tried; tests point it at a local port. */
  sshTarget?: (address: string) => { hostname: string; port: number };
  /**
   * Whether the machine lets that account in with the workstation's key.
   * Without it, `create` stops once port 22 answers; the entry point and the
   * wizard give the real one, sshLogin.
   */
  login?: (account: string, address: string, identity: string | null) => Promise<LoginAttempt>;
  /** What `discover` may read: the provider CLIs, a key file. Tests give a fake one. */
  workstation?: Workstation;
  /** Credentials typed at the wizard, by variable: they win over the environment and are scrubbed like it. */
  credentials?: Credentials;
  /** Where those came from, said for a person: the wizard may hand on what the environment or a CLI held. */
  credentialSource?: string;
};

export function isFailure(value: object): value is Failure {
  return "error" in value && "message" in value;
}

/**
 * A value typed on the command line, repeated in a message only when it has
 * the shape of a name: anything else, a token pasted in the wrong place first
 * of all, is not printed back.
 */
export function shown(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value) && !/^[A-Za-z0-9]{32,}$/.test(value) ? value : "(not shown)";
}

/** A name a machine, its firewall and its labels can all carry: an RFC 1123 label, lowercase. */
export function isValidMachineName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}

/**
 * A value of 32 characters or more without a dot or a separator a name
 * would have: what a token pasted in the wrong place looks like. No type,
 * location or image any provider names is that long in one piece.
 */
export function looksLikeCredential(value: string): boolean {
  // A UUID, Scaleway's image ids among them, has its own shape: not a token.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return false;
  return /^[A-Za-z0-9_-]{32,}$/.test(value);
}

/**
 * A server type, a location or an image, as providers name them: `cx23`,
 * `eu-west-3`, `Standard_B2ats_v2`, `DEV1-S`, `ami-0123456789abcdef0`.
 */
export function isValidChoice(value: string, option = "type"): boolean {
  // An image may also be named with colons, Azure's URN, or a slash, Akamai's `linode/debian13`.
  return option === "image" ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) : /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
}

export function parseMachineArguments(arguments_: string[]): MachineArguments | Failure {
  const rest = arguments_[0] === "machine" ? arguments_.slice(1) : arguments_;
  const action = rest.find((word) => word !== "--json");
  const usage = MACHINE_USAGE.slice(1).filter((line) => line !== "");
  if (action === undefined || !Object.hasOwn(OPTIONS, action)) {
    return {
      error: "machine-usage",
      message: action === undefined || action.startsWith("-") ? "sitesolide machine needs a command: create, list, destroy or providers" : `unknown machine command: ${shown(action)}`,
      details: usage,
    };
  }
  const known = OPTIONS[action as Action];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  const takes = Object.keys(known).length === 0 ? `sitesolide machine ${action} takes only --json` : `sitesolide machine ${action} takes ${Object.keys(known).join(", ")}, and --json`;
  for (let i = rest.indexOf(action) + 1; i < rest.length; i++) {
    const word = rest[i]!;
    if (word === "--json") continue;
    if (Object.hasOwn(known, word)) {
      if (known[word]) {
        const value = rest[i + 1];
        if (value === undefined || value.startsWith("--")) return { error: "machine-option", message: `${word} needs a value`, details: [takes] };
        values[word] = value;
        i++;
      } else flags.add(word);
      continue;
    }
    if (word.startsWith("-")) {
      // Only the option's name: whatever follows an `=` may be a secret.
      const option = word.split("=")[0]!;
      return {
        error: "machine-option",
        message: `${/^--?[a-z][a-z0-9-]{0,40}$/.test(option) ? option : "an option"}: not an option of sitesolide machine ${action}`,
        details: [
          takes,
          ...(/^--(token|secret|key|api-key|access-key|password)$/.test(option)
            ? ["credentials are read from the provider's environment variables, or from standard input with --token-stdin, never from the command line, where ps shows them"]
            : []),
        ],
      };
    }
    positionals.push(word);
  }
  const allowed = action === "destroy" ? 1 : 0;
  if (positionals.length > allowed) {
    return { error: "machine-option", message: `unexpected argument: ${shown(positionals[allowed]!)}`, details: [takes, ...(action === "destroy" ? ["the machine to destroy is named once: sitesolide machine destroy <name>"] : [])] };
  }
  return { action: action as Action, values, flags, positionals };
}

function chooseProvider(name: string | undefined): ProviderEntry | Failure {
  const known = `the providers sitesolide knows: ${Object.keys(PROVIDERS).join(", ")}`;
  if (name === undefined) return { error: "unknown-provider", message: "--provider is required: a machine is ordered from the provider named, never from a default", details: [known] };
  if (!Object.hasOwn(PROVIDERS, name)) return { error: "unknown-provider", message: `unknown provider: ${shown(name)}`, details: [known] };
  return PROVIDERS[name]!;
}

function nameFailure(given: string | undefined, how: string): Failure {
  return {
    error: "machine-name",
    message: given === undefined ? `the machine's name is required: ${how}` : `not a machine name: ${shown(given)}`,
    details: ["lowercase letters, digits and dashes, 63 characters at most, starting and ending with a letter or a digit"],
  };
}

// --- the SSH key --------------------------------------------------------------------------

const KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-rsa",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

/** A `.pub` file's key, or null when the text is not one. The MD5 fingerprint is what Hetzner shows. */
export function readPublicKey(text: string): PublicKey | null {
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "" && !candidate.startsWith("#"));
  if (line === undefined) return null;
  const [algorithm = "", blob = "", ...comment] = line.split(/\s+/);
  if (!KEY_ALGORITHMS.includes(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
  const bytes = Buffer.from(blob, "base64");
  // The key's own first field repeats its algorithm: a blob that does not is not this key.
  if (bytes.length < 4 || bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString("latin1") !== algorithm) return null;
  const digest = new Bun.CryptoHasher("md5").update(bytes).digest("hex");
  return { algorithm, blob, comment: comment.join(" "), fingerprint: digest.match(/../g)!.join(":") };
}

/** The public key to install: the one given, or the first of DEFAULT_KEYS this workstation has. */
export function choosePublicKey(given: string | undefined, home: string, exists: (path: string) => boolean = existsSync): string | Failure {
  const create = "create one with: ssh-keygen -t ed25519";
  if (given !== undefined) {
    const path = expandHome(given, home);
    if (!path.endsWith(".pub")) {
      return {
        error: "no-ssh-key",
        message: `--ssh-key takes a public key, the .pub file: ${shown(given.split("/").pop() ?? "")}`,
        details: ["the private key never leaves this workstation", "or the SHA256 fingerprint of a key the SSH agent holds, as ssh-add -l prints it"],
      };
    }
    if (!exists(path)) return { error: "no-ssh-key", message: `no such public key: ${path}`, details: [create] };
    return path;
  }
  for (const name of DEFAULT_KEYS) {
    const path = join(home, ".ssh", name);
    if (exists(path)) return path;
  }
  return {
    error: "no-ssh-key",
    message: "no public key in ~/.ssh to install on the machine",
    details: [`looked for ${DEFAULT_KEYS.map((name) => `~/.ssh/${name}`).join(", ")}`, create, "or pass another one: --ssh-key <path to the .pub>"],
  };
}

export function loadPublicKey(path: string): PublicKey | Failure {
  let text: string;
  try {
    // A public key fits in a few hundred bytes; anything much larger is not one, and is not read.
    if (statSync(path).size > 16_384) return { error: "no-ssh-key", message: `${path} is too large to be a public key` };
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { error: "no-ssh-key", message: `cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}` };
  }
  if (text.includes("PRIVATE KEY")) return { error: "no-ssh-key", message: `${path} holds a private key`, details: ["pass the .pub beside it: the private key never leaves this workstation"] };
  return readPublicKey(text) ?? { error: "no-ssh-key", message: `${path} is not an OpenSSH public key`, details: [`the line starts with one of ${KEY_ALGORITHMS.slice(0, 5).join(", ")}`] };
}

/** A key's SHA256 fingerprint, as `ssh-add -l` and `ssh-keygen -l` print it. */
export function sha256Fingerprint(key: PublicKey): string {
  return `SHA256:${new Bun.CryptoHasher("sha256").update(Buffer.from(key.blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/**
 * The keys the SSH agent holds, as `ssh-add -L` lists them; none when no
 * agent answers. The agent is the one ssh itself asks: ~/.ssh/config may name
 * one with IdentityAgent that SSH_AUTH_SOCK does not, as the guides of
 * 1Password and Secretive suggest.
 */
export async function agentKeys(workstation: Workstation): Promise<PublicKey[]> {
  const settings = await workstation.run(["ssh", "-G", "agent.invalid"]).catch(() => null);
  const named = settings?.code === 0 ? /^identityagent (.+)$/m.exec(settings.stdout)?.[1]?.trim() : undefined;
  if (named === "none") return [];
  const socket = named === undefined || named === "SSH_AUTH_SOCK" || named.startsWith("$") ? null : named;
  const listed = await workstation.run(socket === null ? ["ssh-add", "-L"] : ["env", `SSH_AUTH_SOCK=${socket}`, "ssh-add", "-L"]).catch(() => null);
  if (listed === null || listed.code !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((line) => readPublicKey(line))
    .filter((key): key is PublicKey => key !== null);
}

/**
 * Whether ssh can use a key file's private half without a prompt, as
 * `create`'s login wait and setup's ssh need: loaded in the agent, or without
 * a passphrase. A key nothing can unlock would order a machine nobody logs in
 * to, billed all the same.
 */
export async function keyUsable(workstation: Workstation, path: string, key: PublicKey): Promise<boolean> {
  if ((await agentKeys(workstation)).some((held) => held.blob === key.blob)) return true;
  const bare = await workstation.run(["ssh-keygen", "-y", "-P", "", "-f", path.replace(/\.pub$/, "")]).catch(() => null);
  return bare?.code === 0;
}

/** The key a machine is made with: a .pub file, or a key the SSH agent holds, which has no file. */
export type ChosenKey = {
  key: PublicKey;
  /** The .pub file, or null for a key of the agent. */
  path: string | null;
  /** What --ssh-key takes to choose it again: the file, or the agent key's fingerprint. */
  argument: string;
  /** The key said for a person, with its fingerprint. */
  shown: string;
};

/** An agent key's name, its comment: what 1Password calls the key, for instance. */
export function agentKeyName(key: PublicKey): string {
  return key.comment.replace(/[^\x20-\x7e]/g, "").trim() || "a key without a name";
}

export function chosenFromAgent(key: PublicKey): ChosenKey {
  return { key, path: null, argument: sha256Fingerprint(key), shown: `${agentKeyName(key)}, from the SSH agent, ${sha256Fingerprint(key)}` };
}

/**
 * The public key to install: what --ssh-key names, a .pub file or the SHA256
 * fingerprint of a key the SSH agent holds; else the first of DEFAULT_KEYS
 * this workstation has; else the agent's key, when it holds only one. A
 * password manager's agent, 1Password's or Secretive's, keeps its keys out of
 * ~/.ssh: with several, which one a machine trusts is not guessed.
 */
export async function resolvePublicKey(given: string | undefined, home: string, agent: () => Promise<PublicKey[]>, exists: (path: string) => boolean = existsSync): Promise<ChosenKey | Failure> {
  if (given?.startsWith("SHA256:")) {
    const held = await agent();
    const key = held.find((candidate) => sha256Fingerprint(candidate) === given);
    if (key !== undefined) return chosenFromAgent(key);
    return {
      error: "no-ssh-key",
      message: `the SSH agent holds no key ${/^SHA256:[A-Za-z0-9+/]{43}$/.test(given) ? given : "with that fingerprint"}`,
      details: held.length === 0 ? ["no SSH agent answers, or it holds no key: ssh-add -l says which"] : ["it holds:", ...held.map((candidate) => `  ${agentKeyName(candidate)}: ${sha256Fingerprint(candidate)}`)],
    };
  }
  const path = choosePublicKey(given, home, exists);
  if (typeof path === "string") {
    const key = loadPublicKey(path);
    if (isFailure(key)) return key;
    const shownPath = path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
    return { key, path, argument: path, shown: `${shownPath}, ${key.fingerprint}` };
  }
  if (given !== undefined) return path;
  const held = await agent();
  if (held.length === 1) return chosenFromAgent(held[0]!);
  if (held.length === 0) return { ...path, details: [...(path.details ?? []), "or load one in the SSH agent: ssh-add -l lists what it holds"] };
  return {
    error: "no-ssh-key",
    message: `~/.ssh holds no public key, and the SSH agent holds ${held.length}: say which one the machine trusts`,
    details: [...held.map((key) => `${agentKeyName(key)}: --ssh-key ${sha256Fingerprint(key)}`), "or a .pub file: --ssh-key <path to the .pub>"],
  };
}

// --- the credentials ----------------------------------------------------------------------

/**
 * What reading credentials needs to know of whoever takes them: a cloud
 * provider, or a DNS provider (bin/cli/dns/dns.ts), whose entries share these
 * fields.
 */
export type CredentialSource = Pick<ProviderEntry, "title" | "credentials" | "alternatives" | "credentialHelp"> & Partial<Pick<ProviderEntry, "discover">>;

/** Credentials, where they came from, said for a person, and the values to scrub. */
export type Found = { credentials: Credentials; source: string; secrets: string[] };

/** The secret values of a set of credentials: what is scrubbed from every line. */
export function secretValues(entry: CredentialSource, credentials: Credentials): string[] {
  const secret = new Set(entry.credentials.filter((field) => field.secret).map((field) => field.variable));
  return Object.entries(credentials)
    .filter(([variable, value]) => value !== "" && (secret.has(variable) || !entry.credentials.some((field) => field.variable === variable)))
    .map(([, value]) => value);
}

function required(entry: CredentialSource): CredentialField[] {
  return entry.credentials.filter((field) => field.optional !== true);
}

/** What the environment holds of a provider's credentials, the empty ones left out. */
export function fromEnvironment(entry: CredentialSource, environment: Record<string, string | undefined>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const field of entry.credentials) {
    const value = environment[field.variable]?.trim();
    if (value !== undefined && value !== "") found[field.variable] = value;
  }
  return found;
}

/**
 * The fields a set of credentials lacks: the required ones, and, for a
 * provider that takes them in several forms, the rest of the first form
 * when none is whole.
 */
export function missingFields(entry: CredentialSource, credentials: Credentials): CredentialField[] {
  const has = (variable: string): boolean => (credentials[variable] ?? "") !== "";
  const missing = required(entry).filter((field) => !has(field.variable));
  const forms = entry.alternatives ?? [];
  if (forms.length === 0 || forms.some((form) => form.every(has))) return missing;
  return [...missing, ...entry.credentials.filter((field) => forms[0]!.includes(field.variable) && !has(field.variable))];
}

/** What a prompt asks for when nothing is found: the required fields, then the first form's. */
export function fieldsToAsk(entry: CredentialSource): CredentialField[] {
  return missingFields(entry, {});
}

/**
 * Standard input, read: a single secret alone on its line for a provider
 * that needs one value, `VARIABLE=value` lines otherwise, as an environment
 * file holds them. A line naming a variable the provider does not read is
 * refused without being repeated, it may be a secret pasted in the wrong
 * place.
 */
export function parseStdinCredentials(entry: CredentialSource, text: string): Record<string, string> | Failure {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const fields = fieldsToAsk(entry);
  const assignments = lines.every((line) => /^(export\s+)?[A-Z][A-Z0-9_]*=/.test(line));
  if (!assignments) {
    if (fields.length === 1 && lines.length === 1) return { [fields[0]!.variable]: lines[0]! };
    if (lines.length === 0) return {};
    return {
      error: "no-provider-token",
      message: `what standard input holds is not ${entry.title} credentials`,
      details: [`one VARIABLE=value line each: ${entry.credentials.map((field) => field.variable).join(", ")}`, ...entry.credentialHelp],
    };
  }
  const found: Record<string, string> = {};
  for (const line of lines) {
    const bare = line.replace(/^export\s+/, "");
    const equal = bare.indexOf("=");
    const variable = bare.slice(0, equal);
    const value = bare.slice(equal + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!entry.credentials.some((field) => field.variable === variable)) {
      return {
        error: "no-provider-token",
        message: `standard input names a variable ${entry.title} does not read`,
        details: [`the variables read: ${entry.credentials.map((field) => field.variable).join(", ")}`],
      };
    }
    if (value !== "") found[variable] = value;
  }
  return found;
}

/** The first value that does not have the shape of its field, said without the value. */
function shapeFailure(entry: CredentialSource, credentials: Credentials, where: (field: CredentialField) => string): Failure | null {
  for (const field of entry.credentials) {
    const value = credentials[field.variable];
    if (value === undefined || value === "" || field.shape.test(value)) continue;
    return {
      error: "no-provider-token",
      message: `what ${where(field)} holds is not a ${entry.title} ${field.label}: it has characters or a length a ${field.label} never has`,
      details: entry.credentialHelp,
    };
  }
  return null;
}

function noCredentials(entry: CredentialSource, missing: CredentialField[]): Failure {
  const single = fieldsToAsk(entry).length === 1 && missing.length === 1;
  const what = missing.length === 1 ? missing[0]!.label : "credentials";
  return {
    error: "no-provider-token",
    message: single
      ? `no ${entry.title} ${what}: set ${missing[0]!.variable}, or pipe it to --token-stdin`
      : `no ${entry.title} ${what}: set ${missing.map((field) => field.variable).join(", ")}, or pipe every value to --token-stdin as VARIABLE=value lines`,
    details: entry.credentialHelp,
  };
}

/**
 * The credentials a command runs with. `--token-stdin` reads standard input
 * and nothing else. Otherwise: what the wizard was given, then the
 * environment; when they leave a required field empty, what the provider's
 * own CLI holds (`discover`), the environment's values that are not secret,
 * a project or a region, still winning over the CLI's. A secret is never
 * taken half from one place and half from another.
 */
export async function resolveCredentials(
  entry: CredentialSource,
  options: { stdin: boolean; given?: Credentials; source?: string },
  dependencies: Pick<MachineDependencies, "environment" | "stdin" | "workstation">,
): Promise<Found | Failure> {
  if (options.stdin) {
    const parsed = parseStdinCredentials(entry, await (dependencies.stdin ?? (() => Bun.stdin.text()))());
    if (isFailure(parsed)) return parsed;
    const missing = missingFields(entry, parsed);
    if (missing.length > 0) {
      return {
        error: "no-provider-token",
        message: fieldsToAsk(entry).length === 1 ? `no ${entry.title} ${missing[0]!.label} on standard input` : `standard input lacks ${missing.map((field) => field.variable).join(", ")}`,
        details: entry.credentialHelp,
      };
    }
    const wrong = shapeFailure(entry, parsed, () => "standard input");
    return wrong ?? { credentials: parsed, source: "standard input", secrets: secretValues(entry, parsed) };
  }

  // What was typed replaces the environment's secrets whole: a token the
  // environment holds would otherwise win over the form typed instead of it.
  const environment = fromEnvironment(entry, dependencies.environment);
  const kept = options.given === undefined ? environment : Object.fromEntries(Object.entries(environment).filter(([variable]) => entry.credentials.some((field) => field.variable === variable && !field.secret)));
  const given = { ...kept, ...(options.given ?? {}) };
  const wrong = shapeFailure(entry, given, (field) => (options.given?.[field.variable] !== undefined ? `the ${field.label} typed` : field.variable));
  if (wrong !== null) return wrong;
  const missing = missingFields(entry, given);
  if (missing.length === 0) {
    const named = entry.credentials.filter((field) => given[field.variable] !== undefined).map((field) => field.variable);
    return { credentials: given, source: options.given === undefined ? named.join(", ") : (options.source ?? "the values typed"), secrets: secretValues(entry, given) };
  }
  const discovered = entry.discover === undefined ? null : await entry.discover(dependencies.workstation ?? realWorkstation(dependencies.environment));
  if (discovered !== null) {
    const plain = Object.fromEntries(Object.entries(given).filter(([variable]) => entry.credentials.some((field) => field.variable === variable && !field.secret)));
    const merged = { ...discovered.credentials, ...plain };
    if (missingFields(entry, merged).length === 0) {
      return { credentials: merged, source: discovered.source, secrets: secretValues(entry, merged) };
    }
  }
  return noCredentials(entry, missing);
}

/** Whether credentials for a provider are at hand, and where, without asking anyone: for `providers` and the wizard. */
export async function credentialStatus(entry: CredentialSource, dependencies: Pick<MachineDependencies, "environment" | "workstation">): Promise<{ found: boolean; source: string | null }> {
  const found = await resolveCredentials(entry, { stdin: false }, dependencies).catch(() => null);
  return found === null || isFailure(found) ? { found: false, source: null } : { found: true, source: found.source };
}

/** What every child process is spared: Cloudflare's token, a sitesolide token, and every provider's secrets. */
const NEVER_INHERITED = ["CLOUDFLARE_API_TOKEN", "SITESOLIDE_TOKEN"];

/**
 * The environment a child process gets: none of the secrets above, so that
 * one cloud's CLI never receives another's credentials, and a PATH of
 * absolute folders only. A `.` or a relative folder in PATH would let a
 * repository the command runs in ship its own `aws` or `ssh`, and run it.
 */
export function withoutSecrets(environment: Record<string, string | undefined>): Record<string, string> {
  // A DNS provider's variables too, which hold credentials meant for a
  // machine's Caddy and nothing else: no cloud's CLI needs them.
  const secret = new Set([
    ...NEVER_INHERITED,
    ...dnsVariables(),
    ...PROVIDER_LIST.flatMap((entry) => entry.credentials.filter((field) => field.secret).map((field) => field.variable)),
  ]);
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || secret.has(name)) continue;
    clean[name] = value;
  }
  clean.PATH = (clean.PATH ?? "")
    .split(":")
    .filter((folder) => folder.startsWith("/"))
    .join(":");
  return clean;
}

/**
 * The workstation as `discover` sees it: commands run without a shell, their
 * standard input closed so that none waits on a prompt, twenty seconds at
 * most; small files read by path.
 */
export function realWorkstation(environment: Record<string, string | undefined>, home = homedir()): Workstation {
  const clean = withoutSecrets(environment);
  return {
    environment,
    async run(argv) {
      const found = Bun.which(argv[0]!, { PATH: clean.PATH ?? "" });
      if (found === null) return { code: 127, stdout: "", stderr: `${argv[0]}: not installed` };
      const proc = Bun.spawn([found, ...argv.slice(1)], { env: clean, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    },
    readFile(path) {
      try {
        const full = expandHome(path, home);
        if (statSync(full).size > 65_536) return null;
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * The text, with every known secret replaced before it is printed. Values
 * shorter than eight characters are not scrubbed: they are no token, and
 * replacing them would mangle every line.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  // The longest first: a secret that holds a shorter one would otherwise
  // keep its remainder once the shorter one is replaced.
  return [...secrets].sort((a, b) => b.length - a.length).reduce((done, secret) => {
    if (secret.length < 8) return done;
    // A secret with a line break or a quote, a service account's key, is
    // escaped inside a JSON event: both spellings are scrubbed.
    const escaped = JSON.stringify(secret).slice(1, -1);
    return done.split(secret).join("[token]").split(escaped).join("[token]");
  }, text);
}

/** Every string inside a value, scrubbed, the shape kept. */
function scrubValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, scrub)]));
  return value;
}

/** The output, every line of it through scrubSecrets. */
export function redacting(output: Output, secrets: string[]): Output {
  const scrub = (text: string): string => scrubSecrets(text, secrets);
  return {
    say: (line) => output.say(scrub(line)),
    journal: (line) => output.journal(scrub(line)),
    failed: (failure, said) =>
      output.failed(
        { ...failure, message: scrub(failure.message), ...(failure.details === undefined ? {} : { details: failure.details.map(scrub) }) },
        said,
      ),
    succeeded: (command, fields) => output.succeeded(command, scrubValue(fields, scrub) as Record<string, unknown>),
  };
}

// --- waiting for SSH ----------------------------------------------------------------------

/** Whether a TCP connection opens within `timeoutMs`. A connection that opens later is closed when it does. */
export async function tcpProbe(hostname: string, port: number, timeoutMs = SSH_WAIT.attemptMs): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = Bun.connect({ hostname, port, socket: { data() {} } }).then(
    (socket) => {
      socket.end();
      return true;
    },
    () => false,
  );
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const opened = await Promise.race([attempt, late]);
  clearTimeout(timer);
  return opened;
}

/** Waits, bounded, until port 22 of the new machine accepts a connection. */
export async function waitForSsh(
  address: string,
  dependencies: Pick<MachineDependencies, "probe" | "sshTarget">,
  clock: Clock,
  say: (line: string) => void,
): Promise<void> {
  const target = (dependencies.sshTarget ?? ((hostname: string) => ({ hostname, port: 22 })))(address);
  const probe = dependencies.probe ?? tcpProbe;
  const started = clock.now();
  const deadline = started + SSH_WAIT.totalMs;
  let reported = 0;
  for (;;) {
    if (await probe(target.hostname, target.port)) {
      say(`   port 22 answers, after ${Math.round((clock.now() - started) / 1000)} s`);
      return;
    }
    const elapsed = Math.floor((clock.now() - started) / 30_000);
    if (elapsed > reported) {
      say(`   still waiting, ${elapsed * 30} s`);
      reported = elapsed;
    }
    if (clock.now() >= deadline) {
      throw new ProviderError({
        error: "ssh-timeout",
        message: `port 22 of ${address} did not answer within ${SSH_WAIT.totalMs / 60_000} minutes`,
        details: ["the machine runs: the first boot may simply be slow"],
      });
    }
    await clock.sleep(SSH_WAIT.pollMs);
  }
}

/**
 * One login attempt: in or not, or "agent" when ssh waited on the SSH agent
 * for a signature it never got, which a password manager's agent does until
 * its owner approves the key's use.
 */
export type LoginAttempt = boolean | "agent";

const AGENT_APPROVAL = "a password manager's agent, 1Password's for one, asks you to approve each use of a key, and refuses when nobody does";

/**
 * Waits, bounded, until the machine lets the account in with the
 * workstation's key. Port 22 may answer before the image has installed the
 * key: Google's guest agent creates the account a few seconds after sshd
 * starts, and cloud-init on AWS and Azure writes the key while sshd already
 * listens. A setup started then would be refused, and say so as if the key
 * were wrong. No fail2ban runs yet on a machine this fresh: a refused
 * attempt costs nothing.
 */
export async function waitForLogin(
  account: string,
  address: string,
  login: (account: string, address: string, identity: string | null) => Promise<LoginAttempt>,
  clock: Clock,
  say: (line: string) => void,
  identity: string | null = null,
): Promise<void> {
  const started = clock.now();
  const deadline = started + LOGIN_WAIT.totalMs;
  let unsigned = false;
  for (;;) {
    const attempt = await login(account, address, identity);
    if (attempt === true) {
      say(`   ${account} logs in with the key, after ${Math.round((clock.now() - started) / 1000)} s`);
      return;
    }
    if (attempt === "agent" && !unsigned) {
      unsigned = true;
      say(`!! the SSH agent did not sign with the key for ${account}@${address}: ${AGENT_APPROVAL}; the login is tried again every ${LOGIN_WAIT.pollMs / 1000} s`);
    }
    if (clock.now() >= deadline) {
      throw new ProviderError({
        error: "login-timeout",
        message: unsigned
          ? `no login to ${account}@${address} within ${LOGIN_WAIT.totalMs / 60_000} minutes: the SSH agent did not sign with the key`
          : `${account}@${address} did not accept the key within ${LOGIN_WAIT.totalMs / 60_000} minutes`,
        details: unsigned
          ? [AGENT_APPROVAL, "approve it, then run the same command again: it resumes at this wait"]
          : ["port 22 answers: the image may still be installing the key, or this workstation offers another one (ssh-add -l lists them)"],
      });
    }
    await clock.sleep(LOGIN_WAIT.pollMs);
  }
}

/**
 * A login as setup makes them: no prompt, a bounded wait, the host key
 * accepted on first contact only. `true`, run there, is all it asks.
 */
export async function sshLogin(account: string, address: string, identity: string | null = null): Promise<LoginAttempt> {
  const environment = withoutSecrets(process.env);
  const ssh = Bun.which("ssh", { PATH: environment.PATH ?? "" });
  if (ssh === null) return false;
  // A key given with --ssh-key, not one ssh would offer by itself: offered alone.
  const key = identity !== null && existsSync(identity) ? ["-i", identity, "-o", "IdentitiesOnly=yes"] : [];
  const proc = Bun.spawn(
    [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR", ...key, `${account}@${address}`, "true"],
    { env: environment, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 30_000 },
  );
  const [code, said] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  // An address a previous machine had: no wait makes ssh accept it.
  if (HOST_KEY_CHANGED.test(said)) {
    throw new ProviderError({ error: "host-key-changed", message: `ssh refuses ${address}: its host key is not the one this workstation knew there`, details: hostKeyAdvice(address) });
  }
  if (code === 0) return true;
  // The agent said no, or ssh was still waiting on it when the attempt's time
  // ran out: connecting is bounded by ConnectTimeout and `true` returns at once.
  return AGENT_UNSIGNED.test(said) || proc.signalCode !== null ? "agent" : false;
}

const AGENT_UNSIGNED = /signing failed for .* from agent|agent refused operation/;

// --- what is printed -------------------------------------------------------------------------

function addresses(machine: Machine): string {
  return [machine.ipv4, machine.ipv6 ?? machine.ipv6Network].filter(Boolean).join(", ") || "no public address";
}

export function describeMachine(machine: Machine): string[] {
  const price = machine.monthlyPrice;
  return [
    `   name      ${machine.name}`,
    `   type      ${machine.type} at ${machine.location}`,
    `   ipv4      ${machine.ipv4 ?? "none"}`,
    `   ipv6      ${machine.ipv6 ?? machine.ipv6Network ?? "none"}${machine.ipv6 !== null && machine.ipv6Network !== null ? `, network ${machine.ipv6Network}` : ""}`,
    ...(price === null ? [] : [`   price     ${formatPrice(price.net, price.currency)}${machine.backups ? ", plus the backups" : ""}`]),
  ];
}

/** `list`'s table, one machine a line. */
export function machineTable(machines: Machine[]): string[] {
  const rows = [
    ["NAME", "TYPE", "LOCATION", "STATUS", "IPV4", "IPV6", "MONTHLY"],
    ...machines.map((machine) => [
      machine.name,
      machine.type,
      machine.location,
      machine.status,
      machine.ipv4 ?? "-",
      machine.ipv6 ?? machine.ipv6Network ?? "-",
      machine.monthlyPrice === null ? "-" : `${Number(machine.monthlyPrice.net).toFixed(2)}${machine.monthlyPrice.currency === null ? "" : ` ${machine.monthlyPrice.currency}`}${machine.backups ? " +backups" : ""}`,
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => `   ${row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`);
}

/**
 * The command that comes after `create`. Where the image only lets in a
 * sudoer, AWS's `admin`, setup connects as that account and is told to make
 * the usual `deploy` account all the same, so that every installation
 * deploys as the same name whatever the provider.
 */
export function nextCommand(machine: Machine): string {
  const user = machine.login === "root" ? "" : " --user deploy";
  return `sitesolide setup ${machine.login}@${machine.ipv4 ?? machine.ipv6 ?? "<address>"} --zone <your zone> --email <you>${user}`;
}

// --- the commands --------------------------------------------------------------------------

type Context = {
  entry: ProviderEntry;
  parsed: MachineArguments;
  dependencies: MachineDependencies;
  output: Output;
  secrets: string[];
  json: boolean;
};

/**
 * The provider, opened with its credentials, once they are known to be
 * scrubbed from everything printed. `say` names where they came from, never
 * what they are.
 */
export async function openProvider(
  entry: ProviderEntry,
  options: { stdin: boolean; given?: Credentials; source?: string },
  dependencies: MachineDependencies,
  secrets: string[],
  say: (line: string) => void = () => {},
): Promise<Provider | Failure> {
  const found = await resolveCredentials(entry, options, dependencies);
  if (isFailure(found)) return found;
  secrets.push(...found.secrets);
  say(`   credentials: ${found.source}`);
  return entry.open({
    credentials: found.credentials,
    environment: dependencies.environment,
    fetcher: dependencies.fetcher ?? fetch,
    clock: dependencies.clock ?? realClock,
    secret: (value) => {
      if (value !== "") secrets.push(value);
    },
  });
}

function open(context: Context, say?: (line: string) => void): Promise<Provider | Failure> {
  const { credentials, credentialSource } = context.dependencies;
  return openProvider(
    context.entry,
    { stdin: context.parsed.flags.has("--token-stdin"), ...(credentials === undefined ? {} : { given: credentials }), ...(credentialSource === undefined ? {} : { source: credentialSource }) },
    context.dependencies,
    context.secrets,
    say,
  );
}

async function create(context: Context): Promise<number> {
  const { parsed, output, dependencies, entry } = context;
  const name = parsed.values["--name"];
  if (name === undefined || !isValidMachineName(name)) return report(output, nameFailure(name, "--name <name>"));
  const problem = entry.nameProblem?.(name) ?? null;
  if (problem !== null) return report(output, { error: "machine-name", message: `${entry.title} would not take the name ${name}: ${problem}`, details: ["pick another --name"] });
  const defaults = entry.defaults(dependencies.environment);
  const choices = { type: parsed.values["--type"] ?? defaults.type, location: parsed.values["--location"] ?? defaults.location, image: parsed.values["--image"] ?? defaults.image };
  for (const [option, value] of Object.entries(choices)) {
    if (!isValidChoice(value, option) || looksLikeCredential(value)) {
      return report(output, { error: "machine-option", message: `--${option}: not ${option === "image" ? "an" : "a"} ${option} name: ${shown(value)}`, details: ["letters, digits, dots, dashes and underscores, as the provider names them"] });
    }
  }
  const backups = parsed.flags.has("--backups");
  if (backups && !entry.backups) {
    return report(output, {
      error: "machine-option",
      message: `--backups: sitesolide does not turn on ${entry.title}'s backups`,
      details: ["setup's own backups snapshot every project hourly, and copy them to a bucket once you configure one: see docs/concepts.md"],
    });
  }
  const home = dependencies.home ?? homedir();
  const workstation = dependencies.workstation ?? realWorkstation(dependencies.environment, home);
  const chosen = await resolvePublicKey(parsed.values["--ssh-key"], home, () => agentKeys(workstation));
  if (isFailure(chosen)) return report(output, chosen);
  const { key, path } = chosen;
  const keyProblem = entry.keyProblem?.(key) ?? null;
  if (keyProblem !== null) {
    return report(output, { error: "no-ssh-key", message: `${entry.title} would not take the key ${chosen.shown}: ${keyProblem}`, details: ["create one it takes: ssh-keygen -t ed25519, then pass it with --ssh-key"] });
  }
  if (path !== null && !(await keyUsable(workstation, path, key))) return report(output, unusableKey(path, home));

  output.say(`-> machine ${name} at ${entry.title}: ${choices.type} at ${choices.location}, ${choices.image}${backups ? ", with backups" : ""}`);
  const provider = await open(context, (line) => output.say(line));
  if (isFailure(provider)) return report(output, provider);
  output.say(`   SSH key ${chosen.shown}`);
  const outcome = await provider.create({ name, ...choices, backups, key }, (line) => output.say(line));

  const address = outcome.machine.ipv4 ?? outcome.machine.ipv6;
  const clock = dependencies.clock ?? realClock;
  if (address === null) {
    output.say("!! the machine has no public address: there is no port 22 to wait for");
  } else {
    output.say(`-> SSH on ${address}`);
    await waitForSsh(address, dependencies, clock, (line) => output.say(line));
    const identity = parsed.values["--ssh-key"] === undefined || path === null ? null : path.replace(/\.pub$/, "");
    if (dependencies.login !== undefined) await waitForLogin(outcome.machine.login, address, dependencies.login, clock, (line) => output.say(line), identity);
  }

  const next = nextCommand(outcome.machine);
  output.say(outcome.created ? "-> ready" : "-> ready, created by an earlier run");
  for (const line of describeMachine(outcome.machine)) output.say(line);
  output.say(`   nothing is installed nor hardened yet: setup does both, over SSH as ${outcome.machine.login}`);
  if (parsed.values["--ssh-key"] !== undefined && path !== null && !DEFAULT_KEYS.some((name) => path === join(home, ".ssh", name))) {
    output.say(`   setup connects with the keys ssh offers by itself: load this one first, ssh-add ${path.replace(/\.pub$/, "")}`);
  }
  output.say("");
  output.say(`next: ${next}`);
  output.succeeded("machine create", { provider: provider.name, created: outcome.created, machine: outcome.machine, resources: outcome.resources, next });
  return 0;
}

/** A key file whose private half ssh cannot use without a prompt: why, and what to do, before anything is ordered. */
function unusableKey(path: string, home: string): Failure {
  const name = (file: string) => (file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file);
  const secret = path.replace(/\.pub$/, "");
  if (!existsSync(secret)) {
    return {
      error: "no-ssh-key",
      message: `${name(path)}: its private half is neither beside it, ${name(secret)}, nor in the SSH agent`,
      details: ["nothing was ordered: the machine would let in a key this workstation cannot offer", "load the key in the SSH agent, or pass one this workstation holds: --ssh-key <path to the .pub>"],
    };
  }
  return {
    error: "no-ssh-key",
    message: `${name(secret)} needs its passphrase, which nothing here can type, and is not loaded in the SSH agent`,
    details: ["nothing was ordered: the login that follows the order, and setup's after it, run without a prompt", `load it first: ssh-add ${name(secret)}, then run the same command again`],
  };
}

async function list(context: Context): Promise<number> {
  const provider = await open(context);
  if (isFailure(provider)) return report(context.output, provider);
  const machines = await provider.list();
  if (!context.json) {
    if (machines.length === 0) context.output.say(`no machine created by sitesolide in this ${context.entry.title} account`);
    else for (const line of machineTable(machines)) context.output.say(line);
  }
  context.output.succeeded("machine list", { provider: provider.name, machines });
  return 0;
}

async function destroy(context: Context): Promise<number> {
  const { parsed, output, dependencies, entry } = context;
  const name = parsed.positionals[0];
  if (name === undefined || !isValidMachineName(name)) return report(output, nameFailure(name, "sitesolide machine destroy <name>"));
  const confirm = parsed.values["--confirm"];
  const mismatch = (said: string): Failure => ({
    error: "confirm-mismatch",
    message: `${said} does not match ${name}: nothing was destroyed`,
    details: ["the confirmation is the machine's exact name"],
  });
  if (confirm !== undefined && confirm !== name) return report(output, mismatch(`--confirm ${shown(confirm)}`));
  // Under --json nothing prompts: the question would land among the events, and no answer come.
  const interactive = !context.json && (dependencies.interactive ?? process.stdin.isTTY === true);
  if (confirm === undefined && !interactive) {
    return report(output, {
      error: "needs-confirm",
      message: `destroying ${name} needs its name typed back: --confirm ${name}`,
      details: ["without a terminal to type it in, the name is passed with --confirm; nothing was destroyed"],
    });
  }
  const provider = await open(context);
  if (isFailure(provider)) return report(output, provider);

  output.say(`-> machine ${name} at ${entry.title}`);
  const found = await provider.find(name);
  if (found === null) return report(output, { error: "machine-not-found", message: `no machine named ${name} in this ${entry.title} account`, details: ["nothing was destroyed"] });
  if (!found.managed) {
    return report(output, {
      error: "machine-not-managed",
      message: `${name} was not created by sitesolide: it is not destroyed from here`,
      details: [`${found.type} at ${found.location}, ${found.status}, ${addresses(found)}`, "it lacks the label managed-by=sitesolide; nothing was destroyed"],
    });
  }
  output.say(`   ${found.type} at ${found.location}, ${found.status}, ${addresses(found)}`);
  if (confirm === undefined) {
    const answer = (dependencies.prompt ?? prompt)(`Type ${name} to destroy it, with its disk and the provider's backups of it:`);
    if ((answer ?? "").trim() !== name) return report(output, mismatch("the name typed back"));
  }

  const outcome = await provider.destroy(found, { deleteKey: parsed.flags.has("--delete-key") }, (line) => output.say(line));
  output.say("-> destroyed");
  for (const line of outcome.removed) output.say(`   removed: ${line}`);
  for (const line of outcome.kept) output.say(`   kept: ${line}`);
  const dns = `DNS records are not touched: delete those that point at ${addresses(found)} from your zone yourself`;
  output.say(`   ${dns}`);
  output.succeeded("machine destroy", { provider: provider.name, name, removed: outcome.removed, kept: outcome.kept, dns });
  return 0;
}

/**
 * `machine providers`: every provider, and whether this workstation holds
 * credentials for it, read without asking anything and without calling any
 * provider's API. Where they come from is said, never what they are.
 */
async function providers(context: Context): Promise<number> {
  const statuses = await Promise.all(PROVIDER_LIST.map(async (entry) => ({ entry, status: await credentialStatus(entry, context.dependencies) })));
  if (!context.json) {
    const width = Math.max(...PROVIDER_LIST.map((entry) => entry.name.length));
    for (const { entry, status } of statuses) {
      context.output.say(`   ${entry.name.padEnd(width)}  ${entry.title.padEnd(16)} ${status.found ? `credentials: ${status.source}` : `no credentials: ${fieldsToAsk(entry).map((field) => field.variable).join(", ")}`}`);
    }
    context.output.say("");
    context.output.say("each provider's page in docs/providers/ says how to make its credentials");
  }
  context.output.succeeded("machine providers", {
    providers: statuses.map(({ entry, status }) => ({
      name: entry.name,
      title: entry.title,
      credentials: status.found,
      source: status.source,
      variables: entry.credentials.map((field) => field.variable),
      backups: entry.backups,
      defaults: entry.defaults(context.dependencies.environment),
      docs: entry.docs,
    })),
  });
  return 0;
}

/** Runs `sitesolide machine ...`; the exit code is returned, never thrown. */
export async function machine(arguments_: string[], dependencies: MachineDependencies): Promise<number> {
  const secrets: string[] = [];
  const output = redacting(dependencies.output ?? humanOutput, secrets);
  try {
    const parsed = parseMachineArguments(arguments_);
    if (isFailure(parsed)) return report(output, parsed);
    // Every provider's secrets the environment holds are scrubbed from the
    // first line on, whether or not they are the ones used.
    for (const known of PROVIDER_LIST) secrets.push(...secretValues(known, fromEnvironment(known, dependencies.environment)));
    if (parsed.action === "providers") {
      return await providers({ entry: HETZNER, parsed, dependencies, output, secrets, json: arguments_.includes("--json") });
    }
    const entry = chooseProvider(parsed.values["--provider"]);
    if (isFailure(entry)) return report(output, entry);
    const context: Context = { entry, parsed, dependencies, output, secrets, json: arguments_.includes("--json") };
    switch (parsed.action) {
      case "create":
        return await create(context);
      case "list":
        return await list(context);
      case "destroy":
        return await destroy(context);
    }
  } catch (error) {
    if (error instanceof ProviderError) return report(output, error.failure);
    return report(output, { error: "machine-unexpected", message: `unexpected failure: ${(error as Error).message}` });
  }
}
