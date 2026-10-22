/**
 * What `sitesolide machine` and the setup wizard ask of a cloud provider:
 * create a machine ready for `sitesolide setup`, list the ones sitesolide
 * created, destroy one, and say where and what it sells.
 *
 * Each provider is a file of this folder, registered in bin/cli/machine.ts.
 * The interface says what a machine is in the words every provider has (a
 * name, a size, a place, two addresses, the account that logs in) and leaves
 * the rest, the firewall, the key and the address included, to each
 * implementation.
 *
 * Every resource a provider creates carries two labels, or two tags where the
 * provider has no labels: `managed-by=sitesolide`, which is what lets `list`
 * find them and `destroy` refuse anything else, and `sitesolide-machine=<name>`,
 * which says what they were created for. A resource without the first is
 * somebody else's, and is never adopted, changed or deleted.
 *
 * The provider never reads the workstation and never prints: it reports its
 * steps through `report`, in the shape of the CLI's lines (`-> ` opens a step,
 * an indented line says something about it, `!! ` warns), and fails by
 * throwing a ProviderError whose `failure` carries a code bin/cli/hints.ts
 * knows. What it needs from the workstation, credentials a provider's own CLI
 * holds above all, it asks through `discover`, which receives a Workstation.
 *
 * A credential is never part of a message, an URL or an argument. Each
 * secret the command reads is scrubbed from every line it prints; a secret
 * the provider obtains along the way, an access token exchanged for a key,
 * is handed to `context.secret` before it is used, so that it is scrubbed too.
 */
import type { Failure } from "../remote";

/** The two labels every created resource carries. */
export const MANAGED_LABEL = "managed-by";
export const MANAGED_VALUE = "sitesolide";
export const MACHINE_LABEL = "sitesolide-machine";

export function labelsFor(name: string): Record<string, string> {
  return { [MANAGED_LABEL]: MANAGED_VALUE, [MACHINE_LABEL]: name };
}

export function isManaged(labels: Record<string, string> | undefined | null): boolean {
  return labels?.[MANAGED_LABEL] === MANAGED_VALUE;
}

/** The same two labels, for a provider whose tags are plain strings: `managed-by:sitesolide`. */
export function tagsFor(name: string): string[] {
  return [`${MANAGED_LABEL}:${MANAGED_VALUE}`, `${MACHINE_LABEL}:${name}`];
}

export function isManagedTags(tags: readonly string[] | undefined | null): boolean {
  return (tags ?? []).includes(`${MANAGED_LABEL}:${MANAGED_VALUE}`);
}

/** The machine a tag list names, or null. */
export function machineOfTags(tags: readonly string[] | undefined | null): string | null {
  const prefix = `${MACHINE_LABEL}:`;
  return (tags ?? []).find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** An OpenSSH public key, as the `.pub` file holds it. */
export type PublicKey = {
  /** `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`... */
  algorithm: string;
  /** The base64 of the key itself, which is what two copies of a key share. */
  blob: string;
  /** The free text after the key, often `user@host`; may be empty. */
  comment: string;
  /** MD5 of the key, colon separated hex: what Hetzner and DigitalOcean show, and what `ssh-keygen -E md5 -l` prints. */
  fingerprint: string;
};

export type CreateRequest = {
  name: string;
  type: string;
  location: string;
  /** `debian-13`, which each provider maps onto its own image, or a provider's own image name. */
  image: string;
  backups: boolean;
  key: PublicKey;
};

/** A machine, as `list` shows it and `create` and `destroy` report it. */
export type Machine = {
  provider: string;
  id: string;
  name: string;
  type: string;
  location: string;
  /** The provider's own word: `running`, `initializing`, `off`... */
  status: string;
  ipv4: string | null;
  /** The address a DNS AAAA record points at, when the provider routes one. */
  ipv6: string | null;
  /** The network the provider routes to the machine, `2001:db8::/64`; null without one. */
  ipv6Network: string | null;
  /** What it costs a month at its location, as the provider says it; null when it does not. */
  monthlyPrice: { net: string; gross: string; currency: string | null } | null;
  backups: boolean;
  /** Carries `managed-by=sitesolide`: created by this command, and the only kind it destroys. */
  managed: boolean;
  labels: Record<string, string>;
  /**
   * The account the provider's image lets in with the key: `root` where the
   * image allows it, or the passwordless sudoer it creates instead, `admin`
   * on AWS. It is the account `sitesolide setup` first connects as.
   */
  login: string;
};

/** A price as providers write it, `4.9900000000`, said for a person. */
export function formatPrice(net: string | number, currency: string | null): string {
  return `${Number(net).toFixed(2)}${currency === null ? "" : ` ${currency}`} a month before VAT`;
}

/** One resource a step created or found, by its name at the provider. */
export type Resource = { kind: string; name: string; id: string; reused: boolean };

export type CreateOutcome = {
  machine: Machine;
  /** False when a machine of that name, created by sitesolide, was already there. */
  created: boolean;
  resources: Resource[];
};

export type DestroyOutcome = {
  /** What was deleted, said for a person: `server web (203.0.113.10)`. */
  removed: string[];
  /** What was left on purpose, with the reason. */
  kept: string[];
};

/** A line of progress, in the CLI's shape: `-> step`, `   detail`, `!! warning`. */
export type Report = (line: string) => void;

/** Time, injected so that tests neither wait nor depend on the wall clock. */
export type Clock = { now: () => number; sleep: (milliseconds: number) => Promise<void> };

export const realClock: Clock = { now: () => Date.now(), sleep: (milliseconds) => Bun.sleep(milliseconds) };

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One entry of the setup wizard's lists: a location or a type. `value` is
 * what `--location` or `--type` takes; `label` says it for a person,
 * `Falkenstein, DE`; `hint`, shown beside it, carries the size and the price.
 */
export type Choice = { value: string; label: string; hint?: string };

export interface Provider {
  readonly name: string;
  /** The machine of that name, ours or not, or null when the account has none. */
  find(name: string): Promise<Machine | null>;
  /**
   * Creates the machine, or finds it already created by sitesolide, and
   * returns once the provider says it runs. Each step is idempotent: a run
   * interrupted anywhere is finished by running it again.
   */
  create(request: CreateRequest, report: Report): Promise<CreateOutcome>;
  /** The machines carrying `managed-by=sitesolide`. */
  list(): Promise<Machine[]>;
  /** Deletes a machine `find` returned as managed, then what was created for it alone. */
  destroy(machine: Machine, options: { deleteKey: boolean }, report: Report): Promise<DestroyOutcome>;
  /** Where machines can be ordered, for the wizard; the default location first. Read only. */
  locations(): Promise<Choice[]>;
  /**
   * The types worth offering at a location, for the wizard: current
   * generations, the cheapest first where the provider gives prices, the
   * default first when it is sold there. Read only.
   */
  types(location: string): Promise<Choice[]>;
}

// --- credentials -------------------------------------------------------------------------

/** One value a provider needs to be reached: a token, a key and its secret, a project. */
export type CredentialField = {
  /** The environment variable the provider's own tools read it from: `HCLOUD_TOKEN`. */
  variable: string;
  /** As a person says it, for a prompt: `API token`. */
  label: string;
  /**
   * Never printed, never an option, typed at a prompt that does not echo,
   * and scrubbed from every line the command prints.
   */
  secret: boolean;
  /** What it is made of: a value that does not match is refused before anything leaves, and is not repeated. */
  shape: RegExp;
  /** Absent, it is not asked for: a session token, a value with a default. */
  optional?: boolean;
};

/** The values a provider is opened with, by variable. */
export type Credentials = Readonly<Record<string, string>>;

/**
 * What `discover` may read on the workstation, through the command: nothing
 * else of it reaches a provider.
 */
export type Workstation = {
  environment: Record<string, string | undefined>;
  /**
   * Runs a command, without a shell, standard input closed, bounded in time.
   * Never throws: a command that is not installed answers code 127.
   */
  run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** A small file's text, a path `~` may start; null when absent, unreadable or too large. */
  readFile(path: string): string | null;
};

/** Credentials found without the environment holding them, and where. */
export type Discovery = {
  /** Said for a person: `the gcloud CLI, signed in`. Never a credential. */
  source: string;
  credentials: Credentials;
};

export type ProviderContext = {
  credentials: Credentials;
  environment: Record<string, string | undefined>;
  fetcher: Fetch;
  clock: Clock;
  /** A secret obtained along the way, an access token exchanged for a key: scrubbed from every line from then on. */
  secret: (value: string) => void;
};

/** What the command knows of a provider before it has credentials. */
export type ProviderEntry = {
  /** What `--provider` takes: `hetzner`. */
  name: string;
  /** As a person writes it: `Hetzner`. */
  title: string;
  /** What it needs, read from the environment, from standard input, or typed at the wizard. */
  credentials: readonly CredentialField[];
  /**
   * When the provider takes its credentials in more than one form, a token
   * or a service account's email and key: the variables of each form, the
   * first being the one asked at a prompt. Their fields are `optional`, and
   * the credentials are complete once the required fields are there and one
   * form is whole.
   */
  alternatives?: readonly (readonly string[])[];
  /**
   * Credentials found on the workstation when the environment holds none:
   * the provider's own CLI, already signed in, or a key file a variable
   * names. Null when there are none; never a prompt.
   */
  discover?: (workstation: Workstation) => Promise<Discovery | null>;
  /** Where credentials are made, and with which permissions, one line each. */
  credentialHelp: string[];
  /** The page of docs/providers/ that says it all. */
  docs: string;
  /** What `create` orders when nothing else is said. */
  defaults: (environment: Record<string, string | undefined>) => { type: string; location: string; image: string };
  /**
   * Why the provider would refuse a machine's name the CLI accepts, an RFC
   * 1123 label of 63 characters at most, or null. Asked before anything
   * leaves, by `create` and by the wizard as the name is typed.
   */
  nameProblem?: (name: string) => string | null;
  /**
   * Why the provider would refuse the workstation's public key, an ECDSA key
   * where it takes only Ed25519 and RSA, or null. Asked before anything
   * leaves, by `create` and by the wizard once the key is chosen.
   */
  keyProblem?: (key: PublicKey) => string | null;
  /** Whether `--backups` means something here: the provider's own backups of the whole machine. */
  backups: boolean;
  /** The variable that points the provider at another API address, for a local fake: `SITESOLIDE_HETZNER_API`. */
  apiVariable: string;
  open: (context: ProviderContext) => Provider;
};

/** Thrown by a provider: `failure.error` is a code of REMOTE_HINTS in bin/cli/hints.ts. */
export class ProviderError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}

// --- what every provider shares ------------------------------------------------------------

/**
 * The API's address: the default, or the variable's for a local fake. The
 * credentials only leave over https, or over http to the loopback, and the
 * address carries nothing but an origin and a path.
 */
export function apiAddress(environment: Record<string, string | undefined>, variable: string, fallback: string): string {
  const raw = environment[variable]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError({ error: "provider-endpoint", message: `${variable} is not an address` });
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ProviderError({ error: "provider-endpoint", message: `${variable}: credentials only leave over https, or over http to the loopback` });
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ProviderError({ error: "provider-endpoint", message: `${variable} carries more than an address` });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The seconds a 429 asks to wait: Retry-After, else a minute. */
export function retryAfter(headers: Headers, fallback = 60): number {
  const value = Number(headers.get("Retry-After"));
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : fallback;
}

/**
 * An error answer as a failure the CLI reports, by its HTTP status alone,
 * for the providers whose error codes add nothing a hint could use. `title`
 * names the provider, `what` what was being done, in the infinitive: `create
 * the server web`; `said` is the API's own message.
 */
export function statusFailure(title: string, status: number, said: string, headers: Headers, what: string, details: string[] = []): Failure {
  const answer = `${status}`;
  if (status === 401) return { error: "provider-unauthenticated", message: `${title} refused the credentials (${answer}): they are unknown, revoked, expired, or were copied wrong`, details };
  if (status === 403) return { error: "provider-forbidden", message: `the credentials may not ${what} (${answer}): ${said}`, details };
  if (status === 404) return { error: "provider-not-found", message: `${title} could not ${what} (${answer}): ${said}`, details };
  if (status === 409 || status === 423) return { error: "provider-busy", message: `${title} could not ${what} right now (${answer}): ${said}`, details };
  if (status === 429) {
    return { error: "provider-rate-limited", message: `${title}'s rate limit is reached, nothing more can be asked of it for now (${answer})`, details, wait: retryAfter(headers) };
  }
  if (status >= 500) return { error: "provider-failure", message: `${title} failed to ${what} (${answer}): ${said}`, details: [...details, `the failure is on ${title}'s side`] };
  return { error: "provider-invalid", message: `${title} refused to ${what} (${answer}): ${said}`, details };
}

/** The codes a wait shrugs off until its deadline: they say "later", not "no". */
export const TRANSIENT = new Set(["provider-rate-limited", "provider-failure", "provider-unreachable", "provider-busy"]);

/**
 * What `create` asks of the image when nothing else is said: Debian 13, the
 * only system `sitesolide setup` is verified on. Each provider maps it onto
 * its own image.
 */
export const DEBIAN = "debian-13";
