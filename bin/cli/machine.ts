/**
 * `sitesolide machine`: the VM itself, ordered from a cloud provider's API,
 * before `sitesolide setup` installs anything on it.
 *
 *   sitesolide machine create --provider hetzner --name web
 *   sitesolide machine list --provider hetzner
 *   sitesolide machine destroy web --provider hetzner
 *
 * It replaces what infra/main.tf did with Terraform: a server, its firewall,
 * and the workstation's SSH key, with no state file to keep. What exists is
 * read from the provider each time, and found again by the labels every
 * resource carries (bin/cli/providers/provider.ts), so a run interrupted
 * anywhere is finished by running the same command again.
 *
 * `create` stops once the machine accepts connections on port 22, and prints
 * the `setup` command that comes next. It hardens nothing: cloud-init ran once
 * and could not be checked, `setup` runs over SSH and can be run again.
 *
 * **The token.** It comes from the provider's usual environment variable,
 * HCLOUD_TOKEN for Hetzner, or from standard input with `--token-stdin`, and
 * from nowhere else: an option would put it in `ps` and in the shell's
 * history. It goes into the Authorization header of the provider's API and
 * nowhere else: every line this command prints, every refusal and every
 * result passes through `redacting`, which replaces it, should it ever turn
 * up, with `[token]`.
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
import { HETZNER } from "./providers/hetzner";
import {
  formatPrice,
  ProviderError,
  realClock,
  type Clock,
  type Fetch,
  type Machine,
  type Provider,
  type ProviderEntry,
  type PublicKey,
} from "./providers/provider";
import { humanOutput, type Failure, type Output } from "./remote";

/** The providers `--provider` accepts, by the name it takes. */
export const PROVIDERS: Readonly<Record<string, ProviderEntry>> = { hetzner: HETZNER };

/** What `create` orders when nothing else is said: the smallest current x86 type, in Germany, Debian. */
export const DEFAULTS = { type: "cx23", location: "fsn1", image: "debian-13" };

/** The public keys tried, in this order, under ~/.ssh, when --ssh-key is not given. */
export const DEFAULT_KEYS = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

/** How long `create` waits for port 22, how often it tries, and how long one try lasts. */
export const SSH_WAIT = { totalMs: 5 * 60_000, pollMs: 3_000, attemptMs: 5_000 };

export const MACHINE_USAGE = [
  "usage of sitesolide machine:",
  "  sitesolide machine create --provider hetzner --name <name>",
  "                                  order a VM, its firewall and your SSH key, ready for setup",
  "     --type <type>                cx23 by default; a refusal lists what the location sells",
  "     --location <location>        fsn1 by default",
  "     --image <image>              debian-13 by default",
  "     --backups                    the provider's daily backups, about 20 % on the price",
  "     --ssh-key <path.pub>         ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub by default",
  "  sitesolide machine list --provider hetzner",
  "                                  the machines sitesolide created, their addresses and price",
  "  sitesolide machine destroy <name> --provider hetzner",
  "                                  delete the machine and its firewall, for good",
  "     --confirm <name>             the name typed back, where no terminal can ask for it",
  "     --delete-key                 delete the SSH key uploaded for it too",
  "  any machine command --token-stdin",
  "                                  read the token from standard input rather than HCLOUD_TOKEN",
  "",
  "--json, on every one of them: one JSON event per line, see docs/agents.md",
  "the token is never an option, where ps would show it: see docs/machine.md",
];

type Action = "create" | "list" | "destroy";

/** The options of each command, and whether one takes a value. `--json` is everyone's. */
const OPTIONS: Readonly<Record<Action, Readonly<Record<string, boolean>>>> = {
  create: { "--provider": true, "--name": true, "--type": true, "--location": true, "--image": true, "--backups": false, "--ssh-key": true, "--token-stdin": false },
  list: { "--provider": true, "--token-stdin": false },
  destroy: { "--provider": true, "--confirm": true, "--delete-key": false, "--token-stdin": false },
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
};

function isFailure(value: object): value is Failure {
  return "error" in value && "message" in value;
}

function refuse(output: Output, failure: Failure): number {
  output.failed(failure);
  return 1;
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

/** A server type, a location or an image, as providers name them. */
function isValidChoice(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}$/.test(value);
}

export function parseMachineArguments(arguments_: string[]): MachineArguments | Failure {
  const rest = arguments_[0] === "machine" ? arguments_.slice(1) : arguments_;
  const action = rest.find((word) => word !== "--json");
  const usage = MACHINE_USAGE.slice(1).filter((line) => line !== "");
  if (action === undefined || !Object.hasOwn(OPTIONS, action)) {
    return {
      error: "machine-usage",
      message: action === undefined || action.startsWith("-") ? "sitesolide machine needs a command: create, list or destroy" : `unknown machine command: ${shown(action)}`,
      details: usage,
    };
  }
  const known = OPTIONS[action as Action];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  const takes = `sitesolide machine ${action} takes ${Object.keys(known).join(", ")}, and --json`;
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
        details: [takes, ...(option === "--token" ? ["the token is read from the provider's environment variable, or from standard input with --token-stdin, never from the command line, where ps shows it"] : [])],
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
      return { error: "no-ssh-key", message: `--ssh-key takes a public key, the .pub file: ${shown(given.split("/").pop() ?? "")}`, details: ["the private key never leaves this workstation"] };
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

function loadPublicKey(path: string): PublicKey | Failure {
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

// --- the token ----------------------------------------------------------------------------

/** What a token is made of: enough to refuse a stray line or a quote, which could not travel in a header. */
const TOKEN_SHAPE = /^[A-Za-z0-9_\-.:+/=]{16,512}$/;

async function readToken(entry: ProviderEntry, flags: Set<string>, dependencies: MachineDependencies): Promise<string | Failure> {
  const fromStdin = flags.has("--token-stdin");
  const token = (fromStdin ? await (dependencies.stdin ?? (() => Bun.stdin.text()))() : (dependencies.environment[entry.tokenVariable] ?? "")).trim();
  const where = fromStdin ? "standard input" : entry.tokenVariable;
  if (token === "") {
    return {
      error: "no-provider-token",
      message: fromStdin ? `no ${entry.title} token on standard input` : `no ${entry.title} token: set ${entry.tokenVariable}, or pipe it to --token-stdin`,
      details: entry.tokenHelp,
    };
  }
  if (!TOKEN_SHAPE.test(token)) {
    return { error: "no-provider-token", message: `what ${where} holds is not a ${entry.title} token: it has characters or a length a token never has`, details: entry.tokenHelp };
  }
  return token;
}

/**
 * The output, with every known secret replaced before it is printed. Values
 * shorter than eight characters are not scrubbed: they are no token, and
 * replacing them would mangle every line.
 */
function redacting(output: Output, secrets: string[]): Output {
  const scrub = (text: string): string => secrets.reduce((done, secret) => (secret.length < 8 ? done : done.split(secret).join("[token]")), text);
  return {
    say: (line) => output.say(scrub(line)),
    journal: (line) => output.journal(scrub(line)),
    failed: (failure, said) =>
      output.failed(
        { ...failure, message: scrub(failure.message), ...(failure.details === undefined ? {} : { details: failure.details.map(scrub) }) },
        said,
      ),
    succeeded: (command, fields) => {
      let clean = fields;
      try {
        clean = JSON.parse(scrub(JSON.stringify(fields))) as Record<string, unknown>;
      } catch {
        // A token is made of characters JSON never escapes: scrubbing cannot break the text.
      }
      output.succeeded(command, clean);
    },
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

/** The command that comes after `create`. */
export function nextCommand(machine: Machine): string {
  return `sitesolide setup root@${machine.ipv4 ?? machine.ipv6 ?? "<address>"} --zone <your zone> --email <you>`;
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

async function openProvider(context: Context): Promise<Provider | Failure> {
  const token = await readToken(context.entry, context.parsed.flags, context.dependencies);
  if (typeof token !== "string") return token;
  context.secrets.push(token);
  return context.entry.open({
    token,
    environment: context.dependencies.environment,
    fetcher: context.dependencies.fetcher ?? fetch,
    clock: context.dependencies.clock ?? realClock,
  });
}

async function create(context: Context): Promise<number> {
  const { parsed, output, dependencies, entry } = context;
  const name = parsed.values["--name"];
  if (name === undefined || !isValidMachineName(name)) return refuse(output, nameFailure(name, "--name <name>"));
  const choices = { type: parsed.values["--type"] ?? DEFAULTS.type, location: parsed.values["--location"] ?? DEFAULTS.location, image: parsed.values["--image"] ?? DEFAULTS.image };
  for (const [option, value] of Object.entries(choices)) {
    if (!isValidChoice(value)) return refuse(output, { error: "machine-option", message: `--${option}: not a ${option} name: ${shown(value)}`, details: ["lowercase letters, digits, dots and dashes"] });
  }
  const home = dependencies.home ?? homedir();
  const path = choosePublicKey(parsed.values["--ssh-key"], home);
  if (typeof path !== "string") return refuse(output, path);
  const key = loadPublicKey(path);
  if (isFailure(key)) return refuse(output, key);
  const provider = await openProvider(context);
  if (isFailure(provider)) return refuse(output, provider);

  const backups = parsed.flags.has("--backups");
  output.say(`-> machine ${name} at ${entry.title}: ${choices.type} at ${choices.location}, ${choices.image}${backups ? ", with backups" : ""}`);
  output.say(`   SSH key ${path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path}, ${key.fingerprint}`);
  const outcome = await provider.create({ name, ...choices, backups, key }, (line) => output.say(line));

  const address = outcome.machine.ipv4 ?? outcome.machine.ipv6;
  if (address === null) {
    output.say("!! the machine has no public address: there is no port 22 to wait for");
  } else {
    output.say(`-> SSH on ${address}`);
    await waitForSsh(address, dependencies, dependencies.clock ?? realClock, (line) => output.say(line));
  }

  const next = nextCommand(outcome.machine);
  output.say(outcome.created ? "-> ready" : "-> ready, created by an earlier run");
  for (const line of describeMachine(outcome.machine)) output.say(line);
  output.say("   nothing is installed nor hardened yet: setup does both, over SSH as root");
  output.say("");
  output.say(`next: ${next}`);
  output.succeeded("machine create", { provider: provider.name, created: outcome.created, machine: outcome.machine, resources: outcome.resources, next });
  return 0;
}

async function list(context: Context): Promise<number> {
  const provider = await openProvider(context);
  if (isFailure(provider)) return refuse(context.output, provider);
  const machines = await provider.list();
  if (!context.json) {
    if (machines.length === 0) context.output.say(`no machine created by sitesolide in this ${context.entry.title} project`);
    else for (const line of machineTable(machines)) context.output.say(line);
  }
  context.output.succeeded("machine list", { provider: provider.name, machines });
  return 0;
}

async function destroy(context: Context): Promise<number> {
  const { parsed, output, dependencies, entry } = context;
  const name = parsed.positionals[0];
  if (name === undefined || !isValidMachineName(name)) return refuse(output, nameFailure(name, "sitesolide machine destroy <name>"));
  const confirm = parsed.values["--confirm"];
  const mismatch = (said: string): Failure => ({
    error: "confirm-mismatch",
    message: `${said} does not match ${name}: nothing was destroyed`,
    details: ["the confirmation is the machine's exact name"],
  });
  if (confirm !== undefined && confirm !== name) return refuse(output, mismatch(`--confirm ${shown(confirm)}`));
  // Under --json nothing prompts: the question would land among the events, and no answer come.
  const interactive = !context.json && (dependencies.interactive ?? process.stdin.isTTY === true);
  if (confirm === undefined && !interactive) {
    return refuse(output, {
      error: "needs-confirm",
      message: `destroying ${name} needs its name typed back: --confirm ${name}`,
      details: ["without a terminal to type it in, the name is passed with --confirm; nothing was destroyed"],
    });
  }
  const provider = await openProvider(context);
  if (isFailure(provider)) return refuse(output, provider);

  output.say(`-> machine ${name} at ${entry.title}`);
  const found = await provider.find(name);
  if (found === null) return refuse(output, { error: "machine-not-found", message: `no machine named ${name} in this ${entry.title} project`, details: ["nothing was destroyed"] });
  if (!found.managed) {
    return refuse(output, {
      error: "machine-not-managed",
      message: `${name} was not created by sitesolide: it is not destroyed from here`,
      details: [`${found.type} at ${found.location}, ${found.status}, ${addresses(found)}`, "it lacks the label managed-by=sitesolide; nothing was destroyed"],
    });
  }
  output.say(`   ${found.type} at ${found.location}, ${found.status}, ${addresses(found)}`);
  if (confirm === undefined) {
    const answer = (dependencies.prompt ?? prompt)(`Type ${name} to destroy it, with its disk and the provider's backups of it:`);
    if ((answer ?? "").trim() !== name) return refuse(output, mismatch("the name typed back"));
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

/** Runs `sitesolide machine ...`; the exit code is returned, never thrown. */
export async function machine(arguments_: string[], dependencies: MachineDependencies): Promise<number> {
  const secrets: string[] = [];
  const output = redacting(dependencies.output ?? humanOutput, secrets);
  try {
    const parsed = parseMachineArguments(arguments_);
    if (isFailure(parsed)) return refuse(output, parsed);
    const entry = chooseProvider(parsed.values["--provider"]);
    if (isFailure(entry)) return refuse(output, entry);
    // Scrubbed from the first line on, whether or not it is the one used.
    const fromEnvironment = dependencies.environment[entry.tokenVariable]?.trim();
    if (fromEnvironment !== undefined && fromEnvironment !== "") secrets.push(fromEnvironment);
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
    if (error instanceof ProviderError) return refuse(output, error.failure);
    return refuse(output, { error: "machine-unexpected", message: `unexpected failure: ${(error as Error).message}` });
  }
}
