/**
 * What a program asks of a cloud provider: create a machine, find it again,
 * list the ones it created, destroy one, and say where and what it sells.
 * sitesolide's CLI (bin/cli/machine.ts) is one such program; a program that
 * copies this folder at a pinned commit is another (see clouds/README.md).
 *
 * The interface says what a machine is in the words every provider has (a
 * name, a size, a place, two addresses, the account that logs in) and leaves
 * the rest, the firewall, the key and the address included, to each
 * implementation. What the machine is FOR stays with the program: who owns
 * what is created, which ports open, whether a key or a user-data reaches the
 * machine. A provider never decides any of it by default.
 *
 * Every resource a provider creates carries two labels, or two tags where the
 * provider has no labels: `managed-by=<owner>`, which is what lets `list`
 * find them and `destroy` refuse anything else, and `<owner>-machine=<name>`,
 * which says what they were created for. A resource without the first is
 * somebody else's, and is never adopted, changed or deleted. Two programs
 * sharing one cloud account therefore never touch each other's machines.
 *
 * The provider never reads the workstation and never prints: it reports its
 * steps through `report`, in the shape of a CLI's lines (`-> ` opens a step,
 * an indented line says something about it, `!! ` warns), and fails by
 * throwing a ProviderError whose `failure` carries one of FAILURE_CODES.
 * What it needs from the workstation, credentials a provider's own CLI holds
 * above all, it asks through `discover`, which receives a Workstation.
 *
 * A credential is never part of a message, an URL or an argument. Each
 * secret the program reads is scrubbed from every line it prints; a secret
 * the provider obtains along the way, an access token exchanged for a key,
 * is handed to `context.secret` before it is used, so that it is scrubbed too.
 */

/**
 * Why a call failed, in a shape a program can show: `error` is one of
 * FAILURE_CODES, `message` a sentence, `details` the lines under it, `wait`
 * the seconds a rate limit asks for.
 */
export type Failure = { error: string; message: string; details?: string[]; wait?: number };

/**
 * Every code a provider may throw. A program that explains them, sitesolide's
 * bin/cli/hints.ts, is checked against this list, so a code added here
 * without its explanation fails that program's tests rather than its user.
 */
export const FAILURE_CODES: ReadonlySet<string> = new Set([
  "action-failed",
  "firewall-taken",
  "invalid-image",
  "invalid-location",
  "invalid-server-type",
  "machine-ambiguous",
  "machine-exists",
  "machine-name",
  "machine-not-managed",
  "machine-off",
  "machine-timeout",
  "no-default-network",
  "no-default-vpc",
  "no-provider-token",
  "no-ssh-key",
  "provider-api-disabled",
  "provider-busy",
  "provider-endpoint",
  "provider-failure",
  "provider-forbidden",
  "provider-invalid",
  "provider-limit",
  "provider-name-taken",
  "provider-not-found",
  "provider-rate-limited",
  "provider-unauthenticated",
  "provider-unavailable",
  "provider-unreachable",
  "provider-unreadable",
  "provider-unsupported",
  "type-unavailable",
]);

/** The label every created resource carries, `managed-by=<owner>`. */
export const MANAGED_LABEL = "managed-by";

/**
 * Who creates: the program whose name the labels carry. Built once by the
 * program, `ownerNamed("devbox")`, and handed to every provider it opens.
 */
export type Owner = {
  /** `sitesolide`, `devbox`: the value of `managed-by`, and the prefix of the names a provider gives. */
  readonly name: string;
  /** `<owner>-machine`, the label that names the machine a resource was created for. */
  readonly machineLabel: string;
  /** `managed-by=<owner>`, as a message says it. */
  readonly mark: string;
  /** `managed-by:<owner>`, the same for a provider whose tags are plain strings. */
  readonly tagMark: string;
  labels(machine: string): Record<string, string>;
  manages(labels: Record<string, string> | undefined | null): boolean;
  /** The same two labels, for a provider whose tags are plain strings: `managed-by:<owner>`. */
  tags(machine: string): string[];
  managesTags(tags: readonly string[] | undefined | null): boolean;
  /** The machine a tag list names, or null. */
  machineOfTags(tags: readonly string[] | undefined | null): string | null;
};

/**
 * A lower-case word of 2 to 20 characters: it becomes a label value, a tag
 * and the prefix of resource names on every provider, and GCP's labels and
 * names, the strictest, take nothing else.
 */
export const OWNER_NAME = /^[a-z][a-z0-9-]{0,18}[a-z0-9]$/;

export function ownerNamed(name: string): Owner {
  if (!OWNER_NAME.test(name)) throw new Error(`an owner is a lower-case word of 2 to 20 characters: ${JSON.stringify(name)}`);
  const machineLabel = `${name}-machine`;
  const tagMark = `${MANAGED_LABEL}:${name}`;
  return {
    name,
    machineLabel,
    mark: `${MANAGED_LABEL}=${name}`,
    tagMark,
    labels: (machine) => ({ [MANAGED_LABEL]: name, [machineLabel]: machine }),
    manages: (labels) => labels?.[MANAGED_LABEL] === name,
    tags: (machine) => [tagMark, `${machineLabel}:${machine}`],
    managesTags: (tags) => (tags ?? []).includes(tagMark),
    machineOfTags: (tags) => {
      const prefix = `${machineLabel}:`;
      return (tags ?? []).find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
    },
  };
}

/** Tags as labels: `managed-by:sitesolide` becomes `managed-by=sitesolide`; a tag without a colon, a label without a value. */
export function labelsOfTags(tags: readonly string[] | undefined | null): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const tag of tags ?? []) {
    const colon = tag.indexOf(":");
    if (colon === -1) labels[tag] = "";
    else labels[tag.slice(0, colon)] = tag.slice(colon + 1);
  }
  return labels;
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

/** The key itself, without its comment: two copies of a key compare equal through it. */
export function keyMaterial(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

/**
 * One inbound rule of the machine's firewall: a protocol, a port for TCP and
 * UDP, and the networks it opens to, IPv4 and IPv6 CIDRs alike. Everything
 * inbound that no rule names is dropped; outbound is left open.
 */
export type Inbound = {
  protocol: "tcp" | "udp" | "icmp";
  /** Absent for ICMP, required for TCP and UDP. */
  port?: number;
  sources: readonly string[];
  /** A word for the rule where the provider shows one: `ssh`. */
  description?: string;
};

const EVERYWHERE = ["0.0.0.0/0", "::/0"] as const;

/** SSH, HTTP, HTTPS and ping from everywhere: what a web server answers on. */
export const WEB_SERVER: readonly Inbound[] = [
  { protocol: "tcp", port: 22, sources: EVERYWHERE, description: "ssh" },
  { protocol: "tcp", port: 80, sources: EVERYWHERE, description: "http" },
  { protocol: "tcp", port: 443, sources: EVERYWHERE, description: "https" },
  // Ping serves diagnosis and external monitoring; ICMP also carries path
  // MTU discovery, which a machine that cannot hear it fails at silently.
  { protocol: "icmp", sources: EVERYWHERE, description: "ping" },
];

/** The rules said for a person: `inbound tcp 22, 80 and icmp, from 0.0.0.0/0 and ::/0`. */
export function describeInbound(rules: readonly Inbound[]): string {
  const what = rules.map((rule) => (rule.protocol === "icmp" ? "icmp" : `${rule.protocol} ${rule.port}`));
  const from = [...new Set(rules.flatMap((rule) => rule.sources))];
  const everywhere = from.length === 2 && from.includes("0.0.0.0/0") && from.includes("::/0");
  return `inbound ${what.join(", ")}, from ${everywhere ? "everywhere" : from.join(" and ")}`;
}

export type CreateRequest = {
  name: string;
  type: string;
  location: string;
  /** `debian-13`, which each provider maps onto its own image, or a provider's own image name. */
  image: string;
  backups: boolean;
  /**
   * The key the provider registers for the image's login, or null to register
   * none, the user-data then carrying the only key the machine will hold. A
   * provider that cannot boot a reachable machine without one refuses null.
   */
  key: PublicKey | null;
  /** The firewall, rule by rule: nothing is opened that is not here. */
  inbound: readonly Inbound[];
  /**
   * The user-data writes `inbound` on the host itself. A type with no
   * firewall of the provider's in front of it, a Scaleway Elastic Metal, is
   * ordered only then: anything else would be a machine open on every port
   * while the request believed it closed.
   */
  hostFirewall?: boolean;
  /**
   * Handed to cloud-init on the first boot, as is. It is readable from inside
   * the machine and kept by cloud-init on its disk: no secret belongs in it.
   */
  userData?: string;
  /** The system disk, where the type does not fix it. */
  disk?: { gb: number; type?: string };
  /** `/dev/kvm` inside the machine, where the provider can nest virtualization. */
  nestedVirtualization?: boolean;
  /** The account the key logs into, where the provider lets the request name it. */
  login?: string;
  /**
   * The public address the provider hands out at boot, gone with the machine,
   * where it would otherwise reserve one the machine keeps across a stop: one
   * permission and one billed resource fewer, for a machine whose address may
   * change.
   */
  ephemeralAddress?: boolean;
};

/** What a provider accepts beyond the fields every one of them takes. */
export type Supports = {
  /** Takes `key: null`. */
  keyless?: boolean;
  /** Any inbound rules, where without it only WEB_SERVER is taken, the rules it was written for. */
  inbound?: boolean;
  userData?: boolean;
  disk?: boolean;
  nestedVirtualization?: boolean;
  login?: boolean;
  ephemeralAddress?: boolean;
};

function sameRules(a: readonly Inbound[], b: readonly Inbound[]): boolean {
  const key = (rule: Inbound) => `${rule.protocol} ${rule.port ?? ""} ${[...rule.sources].sort().join(",")}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((rule, index) => rule === right[index]);
}

/**
 * Refuses, before anything leaves, what a request asks that the provider
 * cannot do. A field a provider would ignore instead is a machine that does
 * not match what was asked: a port left open, a user-data never run.
 */
export function checkRequest(title: string, request: CreateRequest, supports: Supports): void {
  const refuse = (what: string): never => {
    throw new ProviderError({ error: "provider-unsupported", message: `${title} cannot be asked ${what} here`, details: ["nothing was created"] });
  };
  if (request.key === null && supports.keyless !== true) {
    throw new ProviderError({ error: "no-ssh-key", message: `${title} needs a key to register for the machine's login`, details: ["nothing was created"] });
  }
  for (const rule of request.inbound) {
    if ((rule.protocol === "icmp") !== (rule.port === undefined)) refuse(`a ${rule.protocol} rule ${rule.port === undefined ? "without" : "with"} a port`);
    if (rule.port !== undefined && (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535)) refuse(`the port ${rule.port}`);
    if (rule.sources.length === 0) refuse(`a ${rule.protocol} rule open to no network`);
  }
  if (supports.inbound !== true && !sameRules(request.inbound, WEB_SERVER)) refuse(`firewall rules other than ${describeInbound(WEB_SERVER)}`);
  if (request.userData !== undefined && supports.userData !== true) refuse("a user-data");
  if (request.disk !== undefined && supports.disk !== true) refuse("the size or type of the disk");
  if (request.nestedVirtualization === true && supports.nestedVirtualization !== true) refuse("nested virtualization");
  if (request.login !== undefined && supports.login !== true) refuse("the account the key logs into");
  if (request.ephemeralAddress === true && supports.ephemeralAddress !== true) refuse("an address it does not reserve");
}

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
  /** Carries `managed-by=<owner>`: created by this owner, and the only kind its provider destroys. */
  managed: boolean;
  labels: Record<string, string>;
  /**
   * The account the provider's image lets in with the key: `root` where the
   * image allows it, or the passwordless sudoer it creates instead, `admin`
   * on AWS. It is the account a program first connects as.
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
  /** False when a machine of that name, created by this owner, was already there. */
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
   * Creates the machine, or finds it already created by this owner, and
   * returns once the provider says it runs. Each step is idempotent: a run
   * interrupted anywhere is finished by running it again.
   */
  create(request: CreateRequest, report: Report): Promise<CreateOutcome>;
  /** The machines carrying `managed-by=<owner>`. */
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
  /** Whose name the labels of what this provider creates carry, and the only resources it changes or deletes. */
  owner: Owner;
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
  nameProblem?: (name: string, owner: Owner) => string | null;
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

/** Thrown by a provider: `failure.error` is one of FAILURE_CODES. */
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
 * A call made while waiting: a failure that says "later" is tolerated until
 * the deadline, once warned; any other ends the wait.
 */
export async function patiently<T>(clock: Clock, attempt: () => Promise<T>, deadline: number, report: Report, warned: { done: boolean }): Promise<T | null> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ProviderError) || !TRANSIENT.has(error.failure.error) || clock.now() >= deadline) throw error;
    if (!warned.done) report(`!! ${error.failure.message}: still waiting`);
    warned.done = true;
    return null;
  }
}

/**
 * Deletes, the last made first, what a run created before an order the
 * provider refused: each resource said deleted, or `left` for the next run
 * to find and reuse when its deletion fails. What happened, one line each,
 * for the refusal's details.
 */
export async function undoMade<R extends { kind: string; name: string }>(
  made: readonly R[],
  remove: (resource: R) => Promise<unknown>,
  report: Report,
  left: (resource: R) => string = (resource) => `left the ${resource.kind} ${resource.name}: the next run finds it and reuses it`,
): Promise<string[]> {
  report("-> undo what this run created");
  const said: string[] = [];
  for (const resource of [...made].reverse()) {
    try {
      await remove(resource);
      said.push(`deleted the ${resource.kind} ${resource.name} this run had created`);
    } catch {
      said.push(left(resource));
    }
    report(`   ${said.at(-1)}`);
  }
  return said;
}

/**
 * Debian 13, an image every provider maps onto its own: what sitesolide's
 * `create` asks when nothing else is said, the only system its setup is
 * verified on. Any provider also takes its own image names.
 */
export const DEBIAN = "debian-13";
