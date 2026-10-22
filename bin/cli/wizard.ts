/**
 * `sitesolide setup`, typed alone at a terminal: the whole install as a
 * conversation, for someone who has a domain, at any registrar, and nothing else.
 *
 *   where       a new machine from a cloud provider, or one already running
 *   cloud       the providers of bin/cli/machine.ts, each said with whether
 *               this workstation already holds credentials for it
 *   region      what the provider says it has, read live
 *   size        what it sells there, with the price where it gives one
 *   domain      the zone, who serves its DNS, read from its name servers, its
 *               credentials or records made by hand, the records already there
 *   the plan    everything above, with the price, confirmed once
 *   machine     `sitesolide machine create`
 *   install     `sitesolide setup`
 *
 * NOTHING IS ORDERED BEFORE EVERYTHING IS CHECKED. The cloud's credentials
 * are tried with a read, the DNS provider's against the zone, the records
 * in the zone against what setup will write, the configuration in place
 * against what is asked, and the plan, its price included, is confirmed:
 * only then is the machine ordered, and the bill starts. A refusal setup
 * would only have met after the order is met here, before it.
 *
 * THE SAME COMMANDS UNDERNEATH. The machine is ordered by machine() itself,
 * with the options `machine create` takes, and installed by
 * setupFromWorkstation with the options `setup` takes: the wizard only asks
 * the questions, and ends by printing the two commands it ran, so that a
 * person or an agent can do it again without it. Both are idempotent: the
 * wizard run again after an interruption finds the machine and the steps
 * already done.
 *
 * CREDENTIALS STAY IN MEMORY. A cloud's token typed here goes to that cloud
 * alone, and the DNS credentials to the DNS provider, then to the machine for
 * Caddy, as setup always lays them: never into a file of the workstation,
 * never into the environment the scripts inherit, and every line shown is
 * scrubbed of them as machine.ts scrubs. The variable that holds a provider's
 * token next time is said at the end, never its value.
 *
 * A MACHINE IN SERVICE IS NEVER CHANGED UNASKED. A workstation whose
 * configuration names a machine is asked first, the cursor on Quit; a
 * separate installation gets its own folder, another machine and a domain
 * outside the one in service; finishing the one in place is a dry run, the
 * list of what it would change, then a yes.
 *
 * The prompts go through a Prompter, so that the tests answer them from a
 * script; bin/cli/wizard-clack.ts draws them with Clack.
 */
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { canonicalAddress } from "./cloudflare";
import { DnsError, detectDns, recordLine, zoneRecords, type DnsEntry } from "./dns/dns";
import { DNS_PROVIDERS, MANUAL } from "./dns/registry";
import { adoptLegacyKeys, CONFIG_DIR_VARIABLE, expandHome, privateFolder } from "./config";
import {
  agentKeyName,
  agentKeys,
  choosePublicKey,
  chosenFromAgent,
  credentialStatus,
  fieldsToAsk,
  isFailure,
  isValidMachineName,
  keyUsable,
  loadPublicKey,
  machine,
  openProvider,
  PROVIDER_LIST,
  resolveCredentials,
  scrubSecrets,
  secretValues,
  sha256Fingerprint,
  fromEnvironment as fromEnvironmentOf,
  missingFields,
  type ChosenKey,
  type CredentialSource,
  type Found,
  type MachineDependencies,
} from "./machine";
import { formatPrice, ProviderError, type Fetch, type Choice, type Credentials, type Machine, type Provider, type ProviderEntry, type PublicKey, type Workstation } from "./providers/provider";
import type { Failure, Output } from "./remote";
import { ACCOUNT, EMAIL, HOST, hostOf, parseSetupArguments, ZONE, type SetupExtras, type SetupOptions, type SetupOutput } from "./setup";

// --- the prompts ------------------------------------------------------------------------------

/** Thrown by a prompt the person cancelled, Ctrl+C or Escape. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** A check of what was typed: the reason it is refused, or undefined. */
export type Validate = (value: string) => string | undefined;

/**
 * What the wizard asks and shows, whatever draws it. Every prompt throws
 * Cancelled when the person cancels it.
 */
export type Prompter = {
  intro(title: string): void;
  outro(text: string): void;
  note(lines: string[], title?: string): void;
  step(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  success(text: string): void;
  error(text: string, details?: string[]): void;
  select(message: string, options: Choice[], initial?: string): Promise<string>;
  text(message: string, options?: { placeholder?: string; initial?: string; validate?: Validate }): Promise<string>;
  /** Typed without echo: a token, a key. */
  secret(message: string, validate?: Validate): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /** A spinner while `work` runs: `message` meanwhile, `done(result)` after; a failure is rethrown. */
  wait<T>(message: string, work: () => Promise<T>, done: (result: T) => string): Promise<T>;
  /** A log that fills while a long command runs, folded once it succeeds, kept when it fails. */
  task(title: string): { line(text: string): void; succeed(text: string): void; fail(text: string): void };
  /** setup's output, drawn in the wizard's style; passwords still go to standard error. */
  setupOutput(): SetupOutput;
};

// --- what the wizard depends on -----------------------------------------------------------------

export type WizardDependencies = {
  prompter: Prompter;
  environment: Record<string, string | undefined>;
  home: string;
  workstation: Workstation;
  providers?: readonly ProviderEntry[];
  /** What `machine create` runs with besides its output and credentials: the fetcher, the clock, the probes. */
  machine?: Partial<MachineDependencies>;
  /** Where a DNS provider's API is reached: the environment its address variable is read from, and the fetch. */
  dnsApi: { environment: Record<string, string | undefined>; fetcher?: Fetch };
  /** The DNS providers offered; every one of bin/cli/dns/registry.ts unless a test says otherwise. */
  dnsProviders?: readonly DnsEntry[];
  /** A name's NS records, for telling who serves the zone; node's resolver unless a test says otherwise. */
  nameServers?: (name: string) => Promise<string[]>;
  /** Runs setup: setupFromWorkstation, or a fake. */
  setup: (options: SetupOptions, extras: SetupExtras) => Promise<number>;
  /** Makes an SSH key at the terminal, ssh-keygen's own prompts included; whether it did. */
  keygen?: () => Promise<boolean>;
  /** Loads a private key in the SSH agent at the terminal, its passphrase typed there; whether it did. */
  sshAdd?: (path: string) => Promise<boolean>;
};

/** The default name of the machine: what a person sees in the provider's console. */
export const DEFAULT_NAME = "sitesolide";

/** What a provider says of a machine that is gone or going, or was never made whole: never picked up as it is. */
const GONE = new Set(["terminated", "shutting-down", "incomplete", "deleting", "deleted", "destroying", "archived"]);

/** How many times a refused credential or token is asked again before the wizard stops. */
const TRIES = 3;


type Target =
  | {
      kind: "cloud";
      entry: ProviderEntry;
      provider: Provider;
      found: Found;
      location: Choice;
      type: Choice;
      name: string;
      backups: boolean;
      sshKey: ChosenKey;
      reused: Machine | null;
    }
  | { kind: "own"; login: string; host: string };

/** The domain, and who serves its DNS: a provider with the credentials typed (null when they come from the environment), or null for records made by hand. */
type Site = { zone: string; email: string; dns: DnsEntry | null; credentials: Credentials | null; replace: boolean };

/**
 * What the configuration in place leaves open: the only zone a folder that
 * names one accepts, and, for a separate installation, the machine and the
 * zone in service, which the new one must never share.
 */
type Limits = { zone: string | null; inService: { host: string; zone: string } | null };

// --- the questions -------------------------------------------------------------------------------

function shownPath(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/**
 * What the configuration of that folder names, read as setup's guard reads
 * it: the file with its outdated keys adopted, the environment's server and
 * zone over the file's. Null only when it names neither a server nor a zone,
 * the one case where setup writes it without refusing.
 */
export function configured(environment: Record<string, string | undefined>, folder: string): { server: string; zone: string; email: string } | null {
  const path = join(folder, "config.json");
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) file = adoptLegacyKeys(raw as never).config as Record<string, unknown>;
    } catch {
      // Unreadable: setup refuses it on its own, with the reason.
    }
  }
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const server = environment.SITESOLIDE_SERVER || text(file.server);
  const zone = environment.SITESOLIDE_ZONE || text(file.zone);
  if (server === "" && zone === "") return null;
  return { server, zone, email: text(file.email) };
}

/** Whether two zones overlap: the same, or one inside the other, which would share records. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** A folder for a second installation: absolute or under ~, so that the printed commands mean the same from any project. */
function folderProblem(environment: Record<string, string | undefined>, home: string, value: string): string | undefined {
  const typed = value.trim();
  if (!typed.startsWith("/") && !typed.startsWith("~/")) return "an absolute path, or one under ~/";
  if (configured({}, expandHome(typed, home)) !== null) return "that folder names a machine too: pick another";
  return undefined;
}

/** The credentials, found or typed, and the provider opened with them and proven by a read. */
async function connect(deps: WizardDependencies, entry: ProviderEntry, secrets: string[]): Promise<{ provider: Provider; found: Found; locations: Choice[] }> {
  const ui = deps.prompter;
  let typed: Credentials | undefined;
  const status = await credentialStatus(entry, deps);
  if (!status.found) {
    ui.note([...entry.credentialHelp, `more: ${entry.docs}`], `${entry.title} credentials`);
  }
  for (let attempt = 1; ; attempt++) {
    if (typed === undefined && !status.found) typed = await askCredentials(ui, entry, secrets);
    const found = await resolveCredentials(entry, { stdin: false, ...(typed === undefined ? {} : { given: typed }) }, deps);
    if (isFailure(found)) {
      ui.error(scrubSecrets(found.message, secrets), (found.details ?? []).map((line) => scrubSecrets(line, secrets)));
      if (attempt >= TRIES) throw new Stop(1);
      typed = await askCredentials(ui, entry, secrets);
      continue;
    }
    secrets.push(...found.secrets);
    const opened = await openProvider(entry, { stdin: false, given: found.credentials }, { ...deps.machine, environment: deps.environment, workstation: deps.workstation }, secrets).catch(
      (error: unknown): Failure => {
        if (error instanceof ProviderError) return error.failure;
        throw error;
      },
    );
    if (isFailure(opened)) {
      ui.error(scrubSecrets(opened.message, secrets), (opened.details ?? []).map((line) => scrubSecrets(line, secrets)));
      throw new Stop(1);
    }
    try {
      const locations = await ui.wait(`Connecting to ${entry.title} (${found.source})`, () => opened.locations(), (list) => `connected to ${entry.title}, ${list.length} locations`);
      return { provider: opened, found, locations };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      ui.error(scrubSecrets(error.failure.message, secrets), (error.failure.details ?? []).map((line) => scrubSecrets(line, secrets)));
      const refused = error.failure.error === "provider-unauthenticated" || error.failure.error === "provider-forbidden";
      if (!refused || attempt >= TRIES) throw new Stop(1);
      if (!(await ui.confirm(`Type other ${entry.title} credentials?`, true))) throw new Stop(1);
      typed = await askCredentials(ui, entry, secrets);
    }
  }
}

async function askCredentials(ui: Prompter, entry: CredentialSource, secrets: string[]): Promise<Credentials> {
  const values: Record<string, string> = {};
  for (const field of fieldsToAsk(entry)) {
    const validate: Validate = (value) => (field.shape.test(value.trim()) ? undefined : `that is not a ${entry.title} ${field.label}`);
    const message = `${entry.title} ${field.label} (${field.variable})`;
    const value = (field.secret ? await ui.secret(message, validate) : await ui.text(message, { validate })).trim();
    values[field.variable] = value;
    if (field.secret) secrets.push(value);
  }
  return values;
}

async function chooseCloud(deps: WizardDependencies, secrets: string[]): Promise<Target> {
  const ui = deps.prompter;
  const entries = deps.providers ?? PROVIDER_LIST;
  const statuses = await ui.wait(
    "Looking for cloud credentials on this workstation",
    () => Promise.all(entries.map((entry) => credentialStatus(entry, deps))),
    (found) => `credentials found for ${found.filter((status) => status.found).length} of ${entries.length} providers`,
  );
  const options = entries.map((entry, index): Choice => {
    const status = statuses[index]!;
    const needs = fieldsToAsk(entry).map((field) => field.variable);
    return { value: entry.name, label: entry.title, hint: status.found ? `ready, ${status.source}` : `needs ${needs.join(", ")}` };
  });
  const ready = entries.find((_, index) => statuses[index]!.found);
  const name = await ui.select("Which cloud?", options, (ready ?? entries[0]!).name);
  const entry = entries.find((candidate) => candidate.name === name)!;
  const { provider, found, locations } = await connect(deps, entry, secrets);
  const defaults = entry.defaults(deps.environment);

  for (;;) {
    const location = await pick(ui, "Where?", locations, defaults.location);
    const types = await ui.wait(`Reading what ${entry.title} sells in ${location.label}`, () => provider.types(location.value), (list) => `${list.length} sizes in ${location.label}`).catch((error: unknown) => {
      if (!(error instanceof ProviderError)) throw error;
      ui.error(scrubSecrets(error.failure.message, secrets), (error.failure.details ?? []).map((line) => scrubSecrets(line, secrets)));
      return [] as Choice[];
    });
    if (types.length === 0) {
      ui.warn(`${entry.title} offers nothing to order in ${location.label}: pick another location`);
      continue;
    }
    const type = await pick(ui, "Which size?", types, defaults.type);

    let reused: Machine | null = null;
    let machineName: string;
    for (;;) {
      machineName = (
        await ui.text("Name of the machine", {
          initial: DEFAULT_NAME,
          validate: (value) => (isValidMachineName(value.trim()) ? (entry.nameProblem?.(value.trim()) ?? undefined) : "lowercase letters, digits and dashes, starting with a letter"),
        })
      ).trim();
      const name = machineName;
      let existing: Machine | null;
      try {
        existing = await ui.wait(`Looking for a machine named ${name}`, () => provider.find(name), (found) => (found === null ? `${name} is free` : `${name} exists`));
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        ui.error(scrubSecrets(error.failure.message, secrets), (error.failure.details ?? []).map((line) => scrubSecrets(line, secrets)));
        throw new Stop(1);
      }
      if (existing === null) break;
      if (existing.managed && GONE.has(existing.status)) {
        // AWS lists a terminated instance for an hour; Azure, a group whose
        // machine was never made: `create` orders a new one, which is billed.
        ui.info(`${machineName} was created by sitesolide earlier and is ${existing.status}: a new one is ordered`);
        break;
      }
      if (existing.managed) {
        ui.info(`${machineName} was created by sitesolide earlier, ${existing.type} at ${existing.location}: it is picked up as it is`);
        reused = existing;
        break;
      }
      ui.warn(`${machineName} exists at ${entry.title} and sitesolide did not create it: it is never touched, pick another name`);
    }

    const backups = entry.backups && !reused ? await ui.confirm(`Also turn on ${entry.title}'s daily backups of the whole machine, at extra cost?`, false) : false;
    const sshKey = await chooseKey(deps, entry);
    return { kind: "cloud", entry, provider, found, location, type, name: machineName, backups, sshKey, reused };
  }
}

/** A choice from a list: a plain list when it is short, a search when it is long. */
async function pick(ui: Prompter, message: string, choices: Choice[], initial: string): Promise<Choice> {
  const value = await ui.select(message, choices, choices.some((choice) => choice.value === initial) ? initial : choices[0]?.value);
  return choices.find((choice) => choice.value === value)!;
}

async function chooseKey(deps: WizardDependencies, entry: ProviderEntry | null): Promise<ChosenKey> {
  const ui = deps.prompter;
  for (let attempt = 0; ; attempt++) {
    const path = choosePublicKey(undefined, deps.home);
    if (typeof path === "string") {
      const key = loadPublicKey(path);
      if (isFailure(key)) {
        ui.error(key.message, key.details);
        throw new Stop(1);
      }
      const problem = entry?.keyProblem?.(key) ?? null;
      if (problem !== null) {
        ui.error(`${entry!.title} would not take ${shownPath(path, deps.home)}: ${problem}`, ["create one it takes: ssh-keygen -t ed25519, then run sitesolide setup again"]);
        throw new Stop(1);
      }
      if (!(await keyUsable(deps.workstation, path, key))) {
        ui.warn(`${shownPath(path, deps.home)} needs its passphrase, which setup cannot type: it has to be loaded in the SSH agent`);
        const added = deps.sshAdd !== undefined && (await ui.confirm("Load it now with ssh-add?", true)) && (await deps.sshAdd(path.replace(/\.pub$/, "")));
        if (!added || !(await keyUsable(deps.workstation, path, key))) {
          ui.error("the key is not loaded: nothing was ordered", [`load it with: ssh-add ${shownPath(path.replace(/\.pub$/, ""), deps.home)}, then run sitesolide setup again`]);
          throw new Stop(1);
        }
      }
      return { key, path, argument: path, shown: `${shownPath(path, deps.home)}, ${key.fingerprint}` };
    }
    // No file: a password manager's agent, 1Password's or Secretive's, keeps its keys out of ~/.ssh.
    const held = (await agentKeys(deps.workstation)).filter((key) => (entry?.keyProblem?.(key) ?? null) === null);
    if (held.length === 1) {
      const chosen = chosenFromAgent(held[0]!);
      ui.info(`SSH key: ${chosen.shown}`);
      return chosen;
    }
    if (held.length > 1) {
      const choices = held.map((key) => ({ value: sha256Fingerprint(key), label: agentKeyName(key), hint: sha256Fingerprint(key) }));
      const picked = await pick(ui, "SSH key the machine trusts, from the SSH agent", choices, choices[0]!.value);
      return chosenFromAgent(held.find((key) => sha256Fingerprint(key) === picked.value)!);
    }
    if (attempt > 0 || deps.keygen === undefined) {
      ui.error(path.message, path.details);
      throw new Stop(1);
    }
    ui.warn("this workstation has no SSH key yet: the machine lets you in with one, and only with one");
    if (!(await ui.confirm("Create one now with ssh-keygen?", true))) throw new Stop(1);
    if (!(await deps.keygen())) {
      ui.error("ssh-keygen did not create a key", ["create one yourself: ssh-keygen -t ed25519, then run sitesolide setup again"]);
      throw new Stop(1);
    }
  }
}

async function chooseOwn(ui: Prompter, limits: Limits): Promise<Target> {
  ui.note(["a fresh Debian 13 machine, reachable over SSH with your key", "as root, or as an account with sudo that asks no password"], "Your own machine");
  const target = (
    await ui.text("SSH address of the machine", {
      placeholder: "root@203.0.113.10",
      validate: (value) => {
        const [login = "", host = ""] = value.trim().split("@");
        if (!(value.includes("@") && ACCOUNT.test(login) && HOST.test(host))) return "user@host, root@203.0.113.10 for instance";
        if (limits.inService !== null && host.toLowerCase() === limits.inService.host.toLowerCase()) return "that is the machine in service: a separate installation needs another one";
        return undefined;
      },
    })
  ).trim();
  const at = target.indexOf("@");
  return { kind: "own", login: target.slice(0, at), host: target.slice(at + 1) };
}

async function gitEmail(workstation: Workstation): Promise<string | undefined> {
  const answer = await workstation.run(["git", "config", "--get", "user.email"]).catch(() => null);
  const email = answer?.code === 0 ? answer.stdout.trim() : "";
  return EMAIL.test(email) ? email : undefined;
}

/**
 * Who serves the zone's DNS, asked once the zone is known: the provider its
 * name servers say, first, every other provider sitesolide has a module for,
 * and records made by hand, which any registrar allows.
 */
async function chooseDns(deps: WizardDependencies, zone: string): Promise<DnsEntry | null> {
  const ui = deps.prompter;
  const providers = deps.dnsProviders ?? DNS_PROVIDERS;
  const detected = await ui.wait(
    `Looking up who serves ${zone}'s DNS`,
    () => detectDns(zone, providers, deps.nameServers),
    (found) => (found.entry !== null ? `${zone}'s DNS is at ${found.entry.title}` : found.nameServers.length === 0 ? `${zone} has no name server yet` : `${zone}'s DNS is at ${found.nameServers[0]}, which sitesolide has no module for`),
  );
  const manual: Choice = { value: MANUAL, label: "I create two records by hand", hint: "any registrar; each project's name then shows in public certificate logs" };
  const options: Choice[] = [
    ...(detected.entry === null ? [] : [{ value: detected.entry.name, label: `Through ${detected.entry.title}'s API`, hint: "records made for you, one wildcard certificate" }]),
    ...providers.filter((entry) => entry !== detected.entry).map((entry) => ({ value: entry.name, label: entry.title, hint: "its API: records made for you, one wildcard certificate" })),
    manual,
  ];
  const chosen = await ui.select(`How should ${zone}'s records and certificates be made?`, options, detected.entry?.name ?? MANUAL);
  return providers.find((entry) => entry.name === chosen) ?? null;
}

/** The machine's addresses when they are known: a machine already there, or one picked up; null for one not ordered yet. */
type Addresses = { ipv4: string[]; ipv6: string[] } | null;

/** The zone, the email, its DNS with credentials proven against the zone, and what to do with the records already there. */
async function chooseSite(deps: WizardDependencies, secrets: string[], machine: Addresses, limits: Limits): Promise<Site> {
  const ui = deps.prompter;
  const zone = (
    await ui.text("Domain your sites live under", {
      ...(limits.zone === null ? { placeholder: "example.com" } : { initial: limits.zone }),
      validate: (value) => {
        const typed = value.trim();
        if (!ZONE.test(typed)) return "a lowercase domain, example.com or apps.example.com";
        if (limits.zone !== null && typed !== limits.zone) return `the configuration in place is for ${limits.zone}: a separate installation needs its own folder`;
        if (limits.inService !== null && limits.inService.zone !== "" && overlaps(typed, limits.inService.zone)) return `${limits.inService.zone} is served by the installation in service: pick a domain outside it`;
        return undefined;
      },
    })
  ).trim();
  const suggested = await gitEmail(deps.workstation);
  const email = (
    await ui.text("Email the certificate authority writes to", {
      ...(suggested === undefined ? { placeholder: "you@example.com" } : { initial: suggested }),
      validate: (value) => (EMAIL.test(value.trim()) ? undefined : "an email address"),
    })
  ).trim();

  const dns = await chooseDns(deps, zone);
  if (dns === null) {
    ui.note(
      [
        `${zone}  A  the machine's IPv4, and AAAA its IPv6 when it has one`,
        `*.${zone}  the same`,
        "",
        "setup lists them with the machine's address, then waits for them, half an hour at most",
        "every project gets its own certificate at its first visit, through HTTP-01 or TLS-ALPN-01",
        "a certificate authority logs every name it certifies in public: each project's name shows there",
      ],
      "Records made by hand",
    );
    return { zone, email, dns: null, credentials: null, replace: false };
  }

  // Credentials scoped to the zone: they go onto the machine, where Caddy
  // renews the wildcard with them. Never a broad cloud token.
  const fromEnvironment = fromEnvironmentOf(dns, deps.environment);
  let typed: Credentials | null = null;
  if (missingFields(dns, fromEnvironment).length > 0) {
    ui.note([...dns.credentialHelp, "they stay on the machine for Caddy's renewals: scoped to this zone, never a broad token", `more: ${dns.docs}`], `${dns.title} credentials`);
  } else {
    // Found without a word otherwise: CLOUDFLARE_API_TOKEN is wrangler's
    // variable too, and often holds a token for the whole account.
    ui.warn(`${Object.keys(fromEnvironment).join(", ")} from this workstation's environment will be laid on the machine for Caddy's renewals: it must reach ${zone} alone, see ${dns.docs}`);
  }
  for (let attempt = 1; ; attempt++) {
    if (typed === null && missingFields(dns, fromEnvironment).length > 0) typed = await askCredentials(ui, dns, secrets);
    const credentials = typed ?? fromEnvironment;
    secrets.push(...secretValues(dns, credentials));
    try {
      const api = dns.open({
        credentials,
        environment: deps.dnsApi.environment,
        fetcher: deps.dnsApi.fetcher ?? fetch,
        clock: { now: () => Date.now(), sleep: (milliseconds) => Bun.sleep(milliseconds) },
        secret: (value) => secrets.push(value),
      });
      const found = await ui.wait(`Looking for ${zone} at ${dns.title}`, () => zoneRecords(api, zone), (result) => `zone ${result.zone.name} found, ${result.records.length === 0 ? `no record yet for ${zone} and *.${zone}` : `${result.records.length} record(s) for ${zone} and *.${zone}`}`);
      // Only what setup's DNS step would change: a CNAME, a proxied record,
      // an address that is not one of the machine's, every one when the
      // machine is not ordered yet. Mail and text records are never touched.
      const ours = (record: { type: string; content: string }): boolean =>
        machine !== null && (record.type === "A" ? machine.ipv4 : machine.ipv6).some((address) => canonicalAddress(address) === canonicalAddress(record.content));
      const elsewhere = found.records.filter((record) => record.type === "CNAME" || ((record.type === "A" || record.type === "AAAA") && (record.proxied || !ours(record))));
      let replace = false;
      if (elsewhere.length > 0) {
        ui.note([...elsewhere.map((record) => recordLine(record)), "", "setup points these names at the machine: an address that is not the machine's is replaced, and what it serves today stops"], `Records already in ${found.zone.name}`);
        replace = await ui.confirm("Replace them?", false);
        if (!replace) {
          ui.info(`nothing was ordered: pick another domain, apps.${zone} for instance, or remove these records first`);
          throw new Stop(0);
        }
      }
      return { zone, email, dns, credentials: typed, replace };
    } catch (error) {
      if (!(error instanceof DnsError) && !(error instanceof ProviderError)) throw error;
      const failure = error instanceof DnsError ? { message: error.message, details: error.details } : { message: error.failure.message, details: error.failure.details ?? [] };
      ui.error(scrubSecrets(failure.message, secrets), failure.details.map((line) => scrubSecrets(line, secrets)));
      if (attempt >= TRIES || !(await ui.confirm(`Type other ${dns.title} credentials?`, true))) throw new Stop(1);
      typed = await askCredentials(ui, dns, secrets);
    }
  }
}

/** A host's addresses as this workstation resolves it: itself when it is one. */
async function addressesOf(host: string): Promise<Addresses> {
  if (isIP(host) === 4) return { ipv4: [host], ipv6: [] };
  if (isIP(host) === 6) return { ipv4: [], ipv6: [host] };
  const found = await lookup(host, { all: true }).catch(() => [] as { address: string; family: number }[]);
  return { ipv4: found.filter((entry) => entry.family === 4).map((entry) => entry.address), ipv6: found.filter((entry) => entry.family === 6).map((entry) => entry.address) };
}

/** Ends the wizard with this exit code, whatever it was asking. */
class Stop extends Error {
  constructor(readonly code: number) {
    super(`stop ${code}`);
  }
}

// --- the plan, then the work ---------------------------------------------------------------------

function planLines(target: Target, site: Site, home: string): string[] {
  const reused = target.kind === "cloud" ? target.reused : null;
  // A price is said only where the provider gave one: a hint may carry
  // the size alone, and "price" next to it would read as one.
  const price = target.kind === "cloud" && target.type.hint !== undefined && / a month/.test(target.type.hint) ? target.type.hint : null;
  const machineLines =
    target.kind === "cloud"
      ? reused !== null
        ? [
            `cloud      ${target.entry.title}, ${reused.location}`,
            `machine    ${reused.name}, ${reused.type}, ${reused.status}, already created by sitesolide: reused as it is`,
            ...(reused.monthlyPrice === null ? [] : [`price      ${formatPrice(reused.monthlyPrice.net, reused.monthlyPrice.currency)}`]),
          ]
        : [
            `cloud      ${target.entry.title}, ${target.location.label} (${target.location.value})`,
            `size       ${target.type.label}`,
            price === null ? `price      not given by ${target.entry.title}'s API: see ${target.entry.docs}` : `price      ${price}${target.backups ? ", plus the backups" : ""}`,
            `machine    ${target.name}, Debian 13`,
            `ssh key    ${target.sshKey.shown}`,
          ]
      : [`machine    ${target.login}@${target.host}`];
  return [
    ...machineLines,
    `sites      https://<project>.${site.zone}`,
    `dashboard  https://dashboard.${site.zone}`,
    `email      ${site.email}`,
    site.dns === null
      ? "dns        two records by hand; a certificate per project, names in public logs"
      : `dns        ${site.dns.title}: the records and one wildcard certificate${site.replace ? ", the records listed above replaced" : ""}`,
  ];
}

/** `machine create`, its lines drawn in a task log; the machine, or null after saying why. */
async function order(deps: WizardDependencies, target: Extract<Target, { kind: "cloud" }>, secrets: string[]): Promise<{ machine: Machine; command: string } | null> {
  const ui = deps.prompter;
  const options = ["--provider", target.entry.name, "--name", target.name, "--type", target.type.value, "--location", target.location.value, ...(target.backups ? ["--backups"] : [])];
  const task = ui.task(`Ordering ${target.name} from ${target.entry.title}`);
  let failure: Failure | null = null;
  let result: Record<string, unknown> | null = null;
  const output: Output = {
    say: (line) => {
      const text = scrubSecrets(line, secrets).replace(/^(-> |   )/, "");
      if (text.trim() !== "" && !text.startsWith("next: ")) task.line(text);
    },
    journal: (line) => task.line(scrubSecrets(line, secrets)),
    failed: (said) => {
      failure = said;
    },
    succeeded: (_, fields) => {
      result = fields;
    },
  };
  const code = await machine(["machine", "create", ...options, "--ssh-key", target.sshKey.argument], {
    ...deps.machine,
    environment: deps.environment,
    home: deps.home,
    workstation: deps.workstation,
    output,
    credentials: target.found.credentials,
    credentialSource: target.found.source,
    interactive: false,
  });
  const created = (result as { machine?: Machine } | null)?.machine;
  if (code !== 0 || created === undefined) {
    const said = failure as Failure | null;
    task.fail(said === null ? "the machine could not be ordered" : scrubSecrets(said.message, secrets));
    ui.error("nothing more was done", [
      ...(said?.details ?? []).map((line) => scrubSecrets(line, secrets)),
      "run sitesolide setup again with the same name: it finds what this run made and goes on from there",
      `whatever was made is billed until removed: sitesolide machine list --provider ${target.entry.name} shows it, sitesolide machine destroy ${target.name} --provider ${target.entry.name} removes it`,
    ]);
    return null;
  }
  task.succeed(`${created.name} is up at ${created.ipv4 ?? created.ipv6}, ${created.type} at ${created.location}`);
  return { machine: created, command: `sitesolide machine create ${options.join(" ")} --ssh-key ${target.sshKey.path === null ? target.sshKey.argument : shownPath(target.sshKey.argument, deps.home)}` };
}

/** The wizard, from the first question to the last line; the exit code. */
export async function runWizard(deps: WizardDependencies): Promise<number> {
  const ui = deps.prompter;
  const secrets: string[] = [];
  ui.intro("sitesolide setup");
  try {
    // 1. A workstation that already names a machine: setup refuses another
    // one in the same folder, which may be production. Asked first, before
    // anything is ordered.
    let configDir: string | null = null;
    const limits: Limits = { zone: null, inService: null };
    const folder = privateFolder(deps.home, deps.environment);
    const shownConfig = shownPath(join(folder, "config.json"), deps.home);
    const existing = configured(deps.environment, folder);
    if (existing !== null && existing.server !== "") {
      ui.note([`${shownConfig} names ${existing.server}`, `zone ${existing.zone || "not set"}`, "it may be a machine in service: nothing changes there without a dry run and a yes"], "This workstation already has an installation");
      const choice = await ui.select(
        "What now?",
        [
          { value: "new", label: "Set up a separate installation", hint: "a new machine, with its own configuration folder" },
          { value: "resume", label: `Check ${existing.server} and finish its install`, hint: "a dry run first, then a yes" },
          { value: "quit", label: "Quit" },
        ],
        "quit",
      );
      if (choice === "quit") {
        ui.outro("Nothing was changed.");
        return 0;
      }
      if (choice === "resume") return await resume(deps, existing, secrets);
      // Setup reads these over any folder's configuration: a separate
      // installation would be refused by it after the machine was ordered.
      const exported = ["SITESOLIDE_SERVER", "SITESOLIDE_ZONE"].filter((name) => (deps.environment[name] ?? "") !== "");
      if (exported.length > 0) {
        ui.error(`${exported.join(" and ")} ${exported.length > 1 ? "are" : "is"} set in this environment, and setup would read ${exported.length > 1 ? "them" : "it"} over the new installation's folder`, [
          `unset ${exported.join(" ")}, then run sitesolide setup again`,
        ]);
        throw new Stop(1);
      }
      configDir = (await ui.text("Configuration folder of the new installation", { initial: "~/.config/sitesolide-2", validate: (value) => folderProblem(deps.environment, deps.home, value) })).trim();
      limits.inService = { host: hostOf(existing.server), zone: existing.zone };
    } else if (existing !== null) {
      // A zone and no machine: setup accepts that zone alone in this folder.
      ui.note([`${shownConfig} names the zone ${existing.zone} and no machine yet`, "this install is for that zone"], "The configuration in place");
      limits.zone = existing.zone;
    }

    // 2. The machine, then the domain: every answer checked as it comes.
    const where = await ui.select("Where should sitesolide run?", [
      { value: "cloud", label: "On a new machine from a cloud provider", hint: "ordered and installed for you" },
      { value: "own", label: "On a Debian 13 machine I already have", hint: "over SSH" },
    ]);
    const target = where === "cloud" ? await chooseCloud(deps, secrets) : await chooseOwn(ui, limits);
    const addresses: Addresses =
      target.kind === "own"
        ? await addressesOf(target.host)
        : target.reused === null
          ? null
          : { ipv4: target.reused.ipv4 === null ? [] : [target.reused.ipv4], ipv6: target.reused.ipv6 === null ? [] : [target.reused.ipv6] };
    const site = await chooseSite(deps, secrets, addresses, limits);

    // 3. The plan, once, with the price: nothing is ordered before this yes.
    ui.note(planLines(target, site, deps.home), "The plan");
    const go = await ui.confirm(
      target.kind === "cloud" && (target.reused === null || target.reused.status !== "running")
        ? `${target.reused === null ? "Order the machine" : `Start ${target.reused.name}`} from ${target.entry.title} and install sitesolide? ${target.entry.title} bills it from now on`
        : "Install sitesolide?",
      true,
    );
    if (!go) {
      ui.outro("Nothing was ordered, nothing was changed.");
      return 0;
    }

    // 4. The machine.
    let login: string;
    let host: string;
    let ordered: string | null = null;
    if (target.kind === "cloud") {
      // Interrupted while the provider works, the order cannot be taken back:
      // what is said is how to find it again.
      const interrupted = (): void => {
        ui.error("interrupted while ordering", [
          "run sitesolide setup again with the same name: it finds what was made and goes on",
          `or remove it: sitesolide machine destroy ${target.name} --provider ${target.entry.name}`,
        ]);
        process.exit(130);
      };
      process.once("SIGINT", interrupted);
      const done = await order(deps, target, secrets).finally(() => process.off("SIGINT", interrupted));
      if (done === null) return 1;
      login = done.machine.login;
      host = done.machine.ipv4 ?? done.machine.ipv6 ?? "";
      ordered = done.command;
    } else {
      login = target.login;
      host = target.host;
    }

    // 5. The install.
    const options: SetupOptions = {
      login,
      host,
      zone: site.zone,
      email: site.email,
      contact: null,
      user: "deploy",
      skipDns: site.dns === null,
      dnsReplace: site.replace,
      minimal: false,
      anyOs: false,
      dryRun: false,
      tokenStdin: false,
      dns: site.dns?.name ?? MANUAL,
      // The wizard installs for real: the configuration's, else production.
      acme: null,
      configDir,
      json: false,
    };
    const dnsOption = site.dns === null ? ` --dns ${MANUAL}` : site.dns.name === "cloudflare" ? "" : ` --dns ${site.dns.name}`;
    const setupCommand = `sitesolide setup ${login}@${host} --zone ${site.zone} --email ${site.email} --user deploy${dnsOption}${site.replace ? " --dns-replace" : ""}${configDir === null ? "" : ` --config-dir ${configDir}`}`;
    ui.step(`Installing sitesolide on ${login}@${host}: about ten minutes, every step checked`);
    const code = await deps.setup(options, { ...(site.credentials === null ? {} : { dnsCredentials: site.credentials }), output: ui.setupOutput() });
    if (code !== 0) {
      const again = configDir === null ? "sitesolide setup" : `${CONFIG_DIR_VARIABLE}=${configDir} sitesolide setup`;
      ui.error("the install stopped", [
        `what stopped it is said above; fix that, then run ${again} again: it resumes where it stopped`,
        `or, without questions: ${setupCommand}`,
        ...(target.kind === "cloud"
          ? [`${target.name} runs and is billed meanwhile; to give up instead: sitesolide machine destroy ${target.name} --provider ${target.entry.name}`]
          : []),
      ]);
      return code;
    }

    const variables = target.kind === "cloud" && target.found.source === "the values typed" ? fieldsToAsk(target.entry).map((field) => field.variable) : [];
    ui.note(
      [
        `dashboard   https://dashboard.${site.zone}`,
        `a project   cd <your project> && ${configDir === null ? "" : `${CONFIG_DIR_VARIABLE}=${configDir} `}sitesolide deploy`,
        "",
        "the same, without questions:",
        ...(ordered === null ? [] : [`  ${ordered}`]),
        `  ${setupCommand}`,
        ...(variables.length === 0 ? [] : ["", `the machine commands read ${variables.join(", ")} from the environment next time`]),
      ],
      "sitesolide is live",
    );
    ui.outro(`Next: cd into a project and run sitesolide deploy`);
    return 0;
  } catch (error) {
    if (error instanceof Cancelled) {
      ui.outro("Cancelled. Nothing more was done.");
      return 130;
    }
    if (error instanceof Stop) {
      if (error.code !== 0) ui.outro("Stopped. Nothing was ordered.");
      else ui.outro("Nothing was ordered.");
      return error.code;
    }
    // Anything else is said scrubbed, never handed to the runtime, which
    // would print it whole, a provider's own words and a stack included.
    const failure = error instanceof ProviderError ? error.failure : { message: error instanceof Error ? error.message : String(error), details: [] };
    ui.error(scrubSecrets(failure.message, secrets), (failure.details ?? []).map((line) => scrubSecrets(line, secrets)));
    ui.outro("Stopped on an unexpected failure: run sitesolide setup again, it picks up what was made.");
    return 1;
  }
}

/**
 * The installation this workstation names, checked and finished with setup's
 * own options, read through setup's own parser. It may be production: setup
 * runs a dry run first, every step only read, and changes something only
 * after the person saw the list of what it would do and said yes.
 */
async function resume(deps: WizardDependencies, existing: { server: string; zone: string; email: string }, secrets: string[]): Promise<number> {
  const ui = deps.prompter;
  const host = hostOf(existing.server);
  const at = existing.server.lastIndexOf("@");
  const user = at > 0 ? existing.server.slice(0, at) : "deploy";
  const login = (
    await ui.text("Connect as", {
      initial: user,
      validate: (value) => (ACCOUNT.test(value.trim()) ? undefined : "an account: root, or one with sudo that asks no password"),
    })
  ).trim();
  const email = existing.email !== "" ? existing.email : (await ui.text("Email the certificate authority writes to", { validate: (value) => (EMAIL.test(value.trim()) ? undefined : "an email address") })).trim();
  const parsed = parseSetupArguments([`${login}@${host}`, "--zone", existing.zone, "--email", email, ...(user === "root" ? [] : ["--user", user])]);
  if ("message" in parsed) {
    ui.error(parsed.message, parsed.details);
    ui.outro("Stopped: the configuration in place is not one setup takes as it is.");
    return 1;
  }
  const fromEnvironment = deps.environment.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnvironment) secrets.push(fromEnvironment);

  ui.step(`Reading ${existing.server}: a dry run, nothing is changed`);
  const output = ui.setupOutput();
  const todo: string[] = [];
  const reading: SetupOutput = {
    ...output,
    check: (report) => {
      if (report.status === "todo") todo.push(`${report.title}${report.detail === null ? "" : `: ${report.detail}`}`);
      output.check(report);
    },
  };
  const read = await deps.setup({ ...parsed, dryRun: true }, { output: reading });
  if (read !== 0) {
    ui.outro("Stopped: what stopped the dry run is said above.");
    return read;
  }
  if (todo.length === 0) {
    ui.outro(`Every step is done on ${existing.server}: nothing to change. https://dashboard.${existing.zone}`);
    return 0;
  }
  ui.note(todo, `What setup would change on ${existing.server}`);
  if (!(await ui.confirm(`Run these ${todo.length} step(s) on ${existing.server}?`, false))) {
    ui.outro("Nothing was changed.");
    return 0;
  }
  const code = await deps.setup(parsed, { output });
  ui.outro(code === 0 ? `Done: https://dashboard.${existing.zone}` : "Stopped: what stopped it is said above.");
  return code;
}
