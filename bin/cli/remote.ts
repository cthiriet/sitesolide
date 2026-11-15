/**
 * The CLI through the dashboard's control API, with a token over HTTPS: how
 * every deployment goes, the owner's included, and how an agent in a sandbox
 * or a CI runs the rest of what a token carries.
 *
 *   sitesolide login --url https://dashboard.example.com
 *   sitesolide deploy      plan, build here, upload, follow the machine's log
 *   sitesolide status      the projects this token may deploy
 *   sitesolide logs [--follow]
 *   sitesolide secrets [set|generate|remove|set-file|remove-file]
 *                                   the project's store of secrets, see store-cli.ts
 *   sitesolide restart              the project's service, and whether it holds
 *
 * **Which mode a command runs in.** `deploy` runs here whatever the
 * configuration holds, but in the folder of a platform component, the
 * dashboard or the portal, which setup and upgrade deploy over SSH
 * (deploysOverSsh). For the other commands, a configuration with a `server`
 * is the owner's, and runs over SSH; one without, but with the dashboard's
 * address and a token, runs here. `--api` makes the owner use the API for
 * every command, to see what a token sees.
 *
 * **The token is never in the configuration.** It lives in the workstation's
 * vault, `~/.config/sitesolide/secrets/team-token`, 0600, beside the other
 * credentials the workstation presents; `SITESOLIDE_TOKEN` in the environment
 * wins over it, for a sandbox that has no files to keep. The dashboard's
 * address is in config.json, under `api`, or in `SITESOLIDE_API`; the one the
 * vault's token was checked against is beside it, `team-token-api`, and the
 * vault's token goes nowhere else (boundAddress).
 *
 * **The token only ever goes to that address.** The archive is sent to
 * `<api>/api/v1/deployments/<id>/bundle`, built here, and never to an address
 * an answer names: a compromised or mistaken answer would otherwise receive
 * the bearer.
 *
 * The build stays on the workstation, as over SSH: the archive carries its
 * result, the code minus its exclusions in `app/`, and the public files in
 * `public/`. The machine installs dependencies itself, as the project's account.
 * The build's secrets are resolved here first, a missing one stopping the run
 * before anything is sent; the runtime secrets the store lacks are read before
 * the deployment, asked for at a terminal and warned of otherwise, never a
 * stop (see store-cli.ts).
 *
 * **An option this path does not carry is refused, never passed over.**
 * `deploy --dry-run` once deployed for real here, and `--json` printed plain
 * text, so that an agent's dry run replaced the live site and then reported
 * a failure inviting a retry. `--json` prints the same events as over SSH and
 * one final `result` or `error`; a dry run is the machine's plan,
 * `POST /api/v1/deployments/plan`, which judges and writes nothing.
 *
 * **What the SSH deploy did, this does too**: a manifest inferred with
 * `--yes`, refused over a project the server carries; `--force` and
 * `--adopt`, the owner's token for every project alone, the machine judging
 * both; the ports the machine chose, the door set from the dashboard and the
 * former names a rename left, written back into sitesolide.json; and the
 * status the address answers, in the result.
 */
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { bundle, excludedBy, type BundleEntry } from "./bundle";
import { configPath, dashboardAddress, defaultPaths, expandHome, projectsRepo, readConfigFile } from "./config";
import { generateFragment } from "./fragment";
import { inferManifest, renderManifest, slugFromFolder, type Inference } from "./infer";
import { setPort } from "./ports";
import { generateUnits, unitFileName } from "./unit";
import { hintForFailure } from "./hints";
import { gatherBuildSecrets, missingBuildSecrets, sourceLine, unreadableWorkstation } from "./build-secrets";
import {
  hasServices,
  hasStore,
  isApp,
  isSystemName,
  isValidSlug,
  mainPort,
  missingExclusions,
  NEVER_SENT,
  parserComplaint,
  readManifest,
  secretsOf,
  servicesOf,
  setFormerSlugs,
  setLock,
  setPortal,
  type Manifest,
  type SecretsDeclaration,
} from "./manifest";
import { eventFor, formatEvent, runsOf, type OutputEvent } from "./output";
import { sourceRefusal } from "./source";
import { workstationSecretsPath } from "./store";
import type { MissingIo, StoreTransport } from "./store-cli";
import type { StoreMissing } from "./store-protocol";

/** Where the token is kept in the vault. */
export const TOKEN_FILE = "team-token";

/**
 * Beside it, the dashboard `login` checked it against, the only address it
 * goes to: see boundAddress.
 */
export const TOKEN_ADDRESS_FILE = "team-token-api";

/** The limits the dashboard applies, checked here first so that a refusal comes before the upload. */
export const LIMITS = { bundleBytes: 100 * 1024 * 1024, extractedBytes: 512 * 1024 * 1024, entries: 20_000 };

export type Remote = { api: string; token: string };

export type Environment = Record<string, string | undefined>;

/** The raw configuration file, the `api` key included, which `Config` does not carry. */
function rawConfig(home: string, environment: Environment): Record<string, unknown> {
  const path = configPath(home, environment);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The vault's folder, as the SSH path computes it: environment, file, default. */
export function vaultFolder(environment: Environment, home: string): string {
  const file = readConfigFile(home, environment);
  return expandHome(environment.SITESOLIDE_VAULT ?? file.vault ?? defaultPaths(home, environment).vault, home);
}

/**
 * The dashboard's address, as an origin: https, or http on the loopback for a
 * local bench. null when it is not one.
 */
export function apiOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

/**
 * Does this command run through the API? `--api` says so; otherwise a
 * configuration with a server is the owner's, and one with an API address and
 * no server is a token's: an agent's or a CI's.
 */
export function remoteMode(arguments_: string[], environment: Environment, home = homedir()): boolean {
  if (arguments_.includes("--api")) return true;
  const file = rawConfig(home, environment);
  const server = environment.SITESOLIDE_SERVER ?? (typeof file.server === "string" ? file.server : "");
  if (server !== "") return false;
  const api = environment.SITESOLIDE_API ?? (typeof file.api === "string" ? file.api : "");
  return api !== "";
}

/** The address and the token, or what is missing, said with the command that fixes it. */
export function readRemote(environment: Environment, home = homedir()): Remote | { missing: string } {
  const file = rawConfig(home, environment);
  const raw = environment.SITESOLIDE_API ?? (typeof file.api === "string" ? file.api : "");
  const api = raw === "" ? null : apiOrigin(raw);
  if (api === null) {
    return { missing: raw === "" ? "no dashboard address: run sitesolide login --url https://dashboard.<zone>" : `not an https address: ${raw}` };
  }
  let token = environment.SITESOLIDE_TOKEN ?? "";
  if (token === "") {
    const vault = vaultFolder(environment, home);
    const path = join(vault, TOKEN_FILE);
    const kept = readVaultFile(path);
    if (kept.kind === "absent") return { missing: `no token in ${path}: run sitesolide login, or set SITESOLIDE_TOKEN` };
    if (kept.kind === "refused") return { missing: `${path} is a link or has another name: run sitesolide login, which writes the token there itself` };
    // The vault's token goes to the dashboard `login` checked it against,
    // and to no other: `SITESOLIDE_API=https://elsewhere sitesolide status`,
    // typed by an agent that read it somewhere, sent the bearer there, out of
    // a vault the agent itself may not read. A sandbox aims elsewhere with a
    // token of its own, SITESOLIDE_TOKEN beside it.
    const bound = boundAddress(vault);
    if (bound !== api) {
      const named = environment.SITESOLIDE_API !== undefined ? "SITESOLIDE_API" : "config.json";
      return { missing: `${named} names ${api}, not ${bound ?? "the address login wrote"}, the dashboard the token in the vault was checked against: run sitesolide login --url ${api}, or set SITESOLIDE_TOKEN beside it` };
    }
    token = kept.text.trim();
  }
  if (!/^sst_[A-Za-z0-9_-]{43}$/.test(token)) return { missing: "the token does not have the shape sst_...: ask the owner of the machine for a new one" };
  return { api, token };
}

/**
 * The one address the vault's token may go to, or null when none can be
 * trusted. Never the configuration the environment chooses: config.json is
 * no secret, an agent that may not read the vault may still write it or run
 * `sitesolide init --api`, and the environment picks which config.json is
 * read at all. `SITESOLIDE_CONFIG_DIR=/tmp/x`, or another `HOME`, with a
 * config.json there naming an attacker's `api` and the real vault, by its
 * `vault` key or SITESOLIDE_VAULT, made that `api` the one the real token
 * was compared with, and sent it there.
 *
 * The address `login` wrote in the vault beside the token, first: the vault
 * is the one folder the agent can neither read nor write.
 *
 * A vault `login` filled before it wrote the address holds none. Its token
 * goes where it always did, the `api` of the config.json `login` wrote then,
 * beside the vault's real folder, `secrets/`, whatever the environment
 * names: a vault elsewhere, with no configuration beside it, holds nothing
 * that says where its token was checked, and the answer is `sitesolide
 * login` again, which writes the address.
 */
function boundAddress(vault: string): string | null {
  const recorded = readVaultFile(join(vault, TOKEN_ADDRESS_FILE));
  if (recorded.kind === "present") return apiOrigin(recorded.text);
  if (recorded.kind === "refused") return null;
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(realpathSync(vault)), "config.json"), "utf8")) as { api?: unknown } | null;
    return typeof parsed?.api === "string" ? apiOrigin(parsed.api) : null;
  } catch {
    return null;
  }
}

type VaultRead = { kind: "absent" } | { kind: "refused" } | { kind: "present"; text: string };

/**
 * A file the vault's token depends on, read only when it is a plain file with
 * a single name, judged on the descriptor that reads it. A vault folder the
 * environment names is anyone's to fill: a link there, or a second name
 * given to the real token, put that token in a vault whose address someone
 * else wrote.
 */
function readVaultFile(path: string): VaultRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "refused" };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024) return { kind: "refused" };
    return { kind: "present", text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

// --- talking to the API ------------------------------------------------------------

export type { Failure } from "../../clouds/src/provider";
import type { Failure } from "../../clouds/src/provider";
export type Answer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; failure: Failure };

export type Fetch = (input: string, init?: BunFetchRequestInit) => Promise<Response>;

/** One call: the bearer, JSON back, every failure said in the API's own words. */
export async function call<T>(remote: Remote, path: string, init: RequestInit = {}, fetcher: Fetch = fetch): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetcher(`${remote.api}${path}`, {
      ...init,
      redirect: "error",
      headers: { Authorization: `Bearer ${remote.token}`, ...(init.headers ?? {}) },
      // The certificate is checked whatever the environment says: Bun's
      // fetch obeys NODE_TLS_REJECT_UNAUTHORIZED=0, and HTTPS_PROXY beside it
      // let the proxy answer the handshake itself and read the bearer.
      tls: { rejectUnauthorized: true },
    });
  } catch (error) {
    return { ok: false, status: 0, failure: { error: "unreachable", message: `${remote.api} unreachable: ${(error as Error).message}` } };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, failure: { error: "unreadable", message: `${remote.api} answered ${response.status} with something that is not the control API` } };
  }
  if (response.ok) return { ok: true, status: response.status, body: body as T };
  const failure = body as Partial<Failure>;
  return {
    ok: false,
    status: response.status,
    failure: {
      error: typeof failure.error === "string" ? failure.error : "failure",
      message: typeof failure.message === "string" ? failure.message : `${remote.api} answered ${response.status}`,
      ...(Array.isArray(failure.details) ? { details: failure.details.map(String) } : {}),
      ...(typeof failure.wait === "number" ? { wait: failure.wait } : {}),
    },
  };
}

/**
 * What the commands print, for a person or, under `--json`, for a program, as
 * bin/sitesolide.ts does over SSH: see bin/cli/output.ts.
 *
 * `say` is a line of the run, `journal` a line of a service's journal.
 * `failed` and `succeeded` end the run, and are what `--json` is for: exactly
 * one `error`, with its hint, or one `result`, with what the run concluded,
 * always the last line. Without them an agent read the plain console text,
 * and a deploy that went wrong looked like one that said nothing.
 */
export type Output = {
  say: (line: string) => void;
  journal: (line: string) => void;
  /** Something wrong that stops nothing, with its details: a `warning` event under --json. */
  warn?: (message: string, details: string[]) => void;
  /** `said`: a person already read the message, in the machine's log. */
  failed: (failure: Failure, said?: boolean) => void;
  succeeded: (command: string, fields: Record<string, unknown>) => void;
  /** An event that is no line of text, a file generated or a manifest inferred, as it stands: under --json alone. */
  emit?: (event: OutputEvent) => void;
};

export const humanOutput: Output = {
  say: (line) => console.log(line),
  journal: (line) => console.log(line),
  warn: (message, details) => {
    console.error(`!! ${message}`);
    for (const detail of details) console.error(`   ${detail}`);
  },
  failed: (failure, said = false) => {
    if (said) return;
    console.error(`!! ${failure.message}`);
    for (const detail of failure.details ?? []) console.error(`   ${detail}`);
    if (failure.wait !== undefined) console.error(`   wait ${failure.wait} s`);
  },
  succeeded: () => {},
};

/** The events of `--json`, one per line on standard output, and nothing else. */
export function eventOutput(write: (line: string) => void = (line) => console.log(line)): Output {
  const emit = (event: OutputEvent): void => write(formatEvent(event));
  return {
    say: (line) => {
      const event = eventFor(line);
      if (event !== null) emit(event);
    },
    journal: (line) => emit({ type: "log", at: null, unit: null, priority: null, message: line }),
    warn: (message, details) => emit({ type: "warning", message, details }),
    failed: (failure) =>
      emit({
        type: "error",
        message: failure.message,
        details: [...(failure.details ?? []), ...(failure.wait === undefined ? [] : [`wait ${failure.wait} s`])],
        hint: hintForFailure(failure.error, failure.message),
      }),
    succeeded: (command, fields) => emit({ type: "result", ok: true, command, ...fields }),
    emit,
  };
}

/** A failure said, and the exit code it ends the command with. */
export function report(output: Output, failure: Failure): number {
  output.failed(failure);
  return 1;
}

// --- the project, read for the API ------------------------------------------------

export type RemoteProject = { folder: string; code: string; manifest: Manifest; raw: string };

/**
 * The manifest as the API will judge it: `validate()` of the CLI, except that
 * a missing port is not an error, the machine choosing one. Missing ports are
 * filled with stand-ins for the check alone; the text sent is the file's.
 *
 * Only a public service gets one. An internal service without a port is a
 * worker, which listens on nothing, and a scheduled one may not have a port
 * at all: a stand-in would make the first a server and the second refused.
 */
export function checkManifest(raw: string): { manifest?: Manifest; errors: string[] } {
  let object: unknown;
  try {
    object = JSON.parse(raw);
  } catch (error) {
    return { errors: [`sitesolide.json is unreadable: ${parserComplaint(error)}`] };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return { errors: ["sitesolide.json must contain an object"] };
  const filled: Record<string, unknown> = { ...(object as Record<string, unknown>) };
  if (typeof filled.services === "object" && filled.services !== null && !Array.isArray(filled.services)) {
    const services: Record<string, unknown> = {};
    let next = 3000;
    for (const [name, service] of Object.entries(filled.services as Record<string, unknown>)) {
      const standIn =
        typeof service === "object" && service !== null && !Array.isArray(service) && !("port" in service) && !("schedule" in service) && (service as { internal?: unknown }).internal !== true;
      services[name] = standIn ? { ...service, port: next++ } : service;
    }
    filled.services = services;
  } else if (typeof filled.start === "string" && !("port" in filled)) {
    filled.port = 3000;
  }
  const { errors } = readManifest(JSON.stringify(filled));
  return errors.length > 0 ? { errors } : { manifest: object as Manifest, errors: [] };
}

/** `inferred`: the manifest inferred from a folder that has none, which `deploy --yes` writes beside it. */
export function readRemoteProject(folder: string, inferred?: string): RemoteProject | { errors: string[] } {
  const path = join(folder, "sitesolide.json");
  if (inferred === undefined && !existsSync(path)) return { errors: [`sitesolide.json not found in ${folder}`] };
  const raw = inferred ?? readFileSync(path, "utf8");
  const { manifest, errors } = checkManifest(raw);
  if (manifest === undefined || errors.length > 0) return { errors: ["sitesolide.json rejected", ...errors] };
  const code = manifest.source === undefined ? folder : resolve(folder, manifest.source);
  if (!existsSync(code) || !lstatSync(code).isDirectory()) return { errors: [`source not found: ${manifest.source} (${code})`] };
  // As over SSH: outside the sites repository, source stays inside its own, see source.ts.
  let sitesRepo: string | null = null;
  try {
    sitesRepo = projectsRepo();
  } catch {
    sitesRepo = null;
  }
  const escape = manifest.source === undefined ? null : sourceRefusal(folder, code, sitesRepo);
  if (escape !== null) return { errors: [escape, "a manifest outside your sites repository may only point inside its own repository: nothing was built nor sent"] };
  const missing = isApp(manifest) ? missingExclusions(manifest, readdirSync(code)) : [];
  if (missing.length > 0) {
    return { errors: [`exclude: ${missing.join(", ")} present on disk and not excluded`, `add "exclude": [${missing.map((name) => `"${name}"`).join(", ")}] to the manifest`] };
  }
  return { folder, code, manifest, raw };
}

/**
 * The entries of one tree, `prefix/...`, without what the patterns exclude.
 * A link or a special file is refused: the machine refuses them, and saying so
 * here names the file.
 */
export function collect(root: string, prefix: string, patterns: readonly string[]): { entries: BundleEntry[]; refused: string[] } {
  const entries: BundleEntry[] = [];
  const refused: string[] = [];
  const visit = (folder: string, relative: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      const inner = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(path);
      if (excludedBy(inner, stat.isDirectory(), patterns)) continue;
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (stat.isSymbolicLink()) refused.push(`${prefix}/${inner} is a symbolic link`);
      else if (stat.isDirectory()) {
        entries.push({ kind: "directory", path: `${prefix}/${inner}`, mtime });
        visit(path, inner);
      } else if (stat.isFile()) {
        entries.push({ kind: "file", path: `${prefix}/${inner}`, mtime, executable: (stat.mode & 0o111) !== 0, content: readFileSync(path) });
      } else refused.push(`${prefix}/${inner} is not a regular file`);
    }
  };
  entries.push({ kind: "directory", path: prefix, mtime: Math.floor(lstatSync(root).mtimeMs / 1000) });
  visit(root, "");
  return { entries, refused };
}

/**
 * What leaves, as rsync would have sent it: the code into `app/`, minus its
 * exclusions, the manifest and the public files; the public files into
 * `public/`. Neither tree carries `.git` nor a `.env`, at any depth: see
 * NEVER_SENT.
 */
export function projectEntries(project: RemoteProject): { entries: BundleEntry[]; refused: string[] } {
  const { manifest } = project;
  const entries: BundleEntry[] = [];
  const refused: string[] = [];
  if (isApp(manifest)) {
    const patterns = [...(manifest.exclude ?? []), ...NEVER_SENT, "sitesolide.json", ...(manifest.publicDir === undefined ? [] : [manifest.publicDir])];
    const app = collect(project.code, "app", patterns);
    entries.push(...app.entries);
    refused.push(...app.refused);
  }
  if (manifest.publicDir !== undefined) {
    const files = collect(join(project.code, manifest.publicDir), "public", NEVER_SENT);
    entries.push(...files.entries);
    refused.push(...files.refused);
  }
  return { entries, refused };
}

// --- the commands -------------------------------------------------------------------

export type RemoteDependencies = {
  folder: string;
  environment: Environment;
  home?: string;
  fetcher?: Fetch;
  output?: Output;
  /**
   * The build of bin/sitesolide.ts, which runs the manifest's `build` here,
   * in the clean environment of buildEnv: the build secrets resolved, and
   * what `{zone}` and `{contact}` become in the manifest's `env`.
   */
  build: (project: RemoteProject, context: BuildContext) => Promise<void>;
  /** Its check that the public folder exists and is not empty. */
  checkPublic: (project: RemoteProject) => void;
  /** Between two reads of a deployment's progress. */
  pause?: () => Promise<void>;
  prompt?: (question: string) => string | null;
  stdin?: () => Promise<string>;
  /** A secret's value typed without echo, null when the typing was abandoned, a refusal for a key it does not take: `promptWithoutEcho` by default. */
  secretPrompt?: (question: string) => Promise<Typed>;
  /** Whether standard input is a terminal, where a person types and `--stdin` would echo: its `isTTY` by default. */
  terminal?: () => boolean;
  /** Whether standard output is one too: deploy asks for a missing secret only when both are. Its `isTTY` by default. */
  outputTerminal?: () => boolean;
  /** All of standard input, as bytes: `secrets set --stdin` and `secrets set-file`. */
  stdinBytes?: () => Promise<Uint8Array>;
  /** The status a deployed project's address answers here, null when it does not: a GET without credential by default. */
  probe?: (url: string | null) => Promise<number | null>;
};

/** What a project's build receives besides the workstation's allow list: see buildEnv in ./kit. */
export type BuildContext = { secrets: Record<string, string>; placeholders: { slug: string; zone: string; contact: string } };

type DeploymentView = {
  id: string;
  slug: string;
  state: string;
  creating: boolean;
  log: string[];
  next: number;
  error: { code: string; message: string } | null;
  url: string | null;
  allocated: { service: string | null; port: number }[];
  /** What {zone} and {contact} become for the build here; absent from a dashboard before the store. */
  placeholders?: { zone: string; contact: string };
  /** Declared runtime names and files the store lacked once the installer was done; absent before the store. */
  missingSecrets?: StoreMissing | null;
};

type Identity = {
  id: string;
  label: string;
  email: string;
  expiresAt: number | null;
  /** `secrets`: absent from a dashboard before the permission, which reads as without it. */
  scope: { slugs: string[]; create: boolean; outbound: boolean; domain: boolean; public: boolean; secrets?: boolean; all?: boolean };
  owned: string[];
};

/** The owner's own token for every project, `scope.all`: the one the owner deploys with. */
export type { Identity as RemoteIdentity };

/** The token held, said in one line: who, and what it may do. */
export function describeIdentity(identity: Identity): string[] {
  const may = [
    identity.scope.create ? "create projects" : null,
    identity.scope.public ? "deploy public sites" : "deploy private sites only",
    identity.scope.outbound ? "use network: outbound" : null,
    identity.scope.domain ? "declare a domain" : null,
    identity.scope.secrets === true ? "manage secrets" : null,
  ].filter((part): part is string => part !== null);
  const projects = [...new Set([...identity.owned, ...identity.scope.slugs])].sort();
  return [
    `   ${identity.email} (${identity.label}), token ${identity.id}`,
    `   may ${may.join(", ")}${identity.scope.all === true ? ", take a name back (--adopt), replace a file edited by hand (--force)" : ""}`,
    identity.scope.all === true
      ? `   projects: every one the server carries, as the owner${projects.length === 0 ? "" : ` (now ${projects.join(", ")})`}`
      : `   projects: ${projects.length === 0 ? "none yet" : projects.join(", ")}`,
    ...(identity.expiresAt === null ? [] : [`   expires ${new Date(identity.expiresAt).toISOString().slice(0, 10)}`]),
  ];
}

export async function login(arguments_: string[], dependencies: Omit<RemoteDependencies, "build" | "checkPublic" | "folder">): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const home = dependencies.home ?? homedir();
  const environment = dependencies.environment;
  const refused = unknownOptions("login", arguments_);
  if (refused !== null) return report(output, refused);
  // Under --json nothing prompts: the question would land on standard output
  // among the events, and the answer never come from an agent's empty stdin.
  const interactive = !arguments_.includes("--json");
  const ask = (question: string): string => (interactive ? ((dependencies.prompt ?? prompt)(question) ?? "") : "");
  const value = (name: string) => {
    const marker = arguments_.indexOf(`--${name}`);
    return marker === -1 ? undefined : arguments_[marker + 1];
  };
  const raw = value("url") ?? environment.SITESOLIDE_API ?? ask("Dashboard address, https://dashboard.<zone>:");
  const api = apiOrigin(raw);
  if (api === null) return report(output, { error: "invalid", message: `not an https address: ${raw || "nothing given"}` });

  let token = environment.SITESOLIDE_TOKEN ?? "";
  if (arguments_.includes("--token-stdin")) token = (await (dependencies.stdin ?? (() => Bun.stdin.text()))()).trim();
  if (token === "" && interactive && (dependencies.terminal ?? (() => process.stdin.isTTY === true))()) {
    // At a terminal, without echo, as `secrets set` reads a value: the
    // token typed at `prompt` stayed on the screen and in the scrollback,
    // a credential that deploys and sets secrets, shown to whoever looks.
    const typed = await (dependencies.secretPrompt ?? promptWithoutEcho)("Token, sst_..., as the owner of the machine gave it (no echo): ");
    if (typed === null) return report(output, { error: "cancelled", message: "nothing typed: nothing was written" });
    if (typeof typed !== "string") return report(output, { error: "invalid", message: `${typed.refused}: nothing was written` });
    token = typed.trim();
  }
  if (token === "") token = ask("Token, sst_..., as the owner of the machine gave it:").trim();
  if (!/^sst_[A-Za-z0-9_-]{43}$/.test(token)) return report(output, { error: "invalid", message: "this is not a sitesolide token: it starts with sst_ and is 47 characters long" });

  const remote = { api, token };
  const answer = await call<{ identity: Identity }>(remote, "/api/v1/whoami", {}, dependencies.fetcher);
  if (!answer.ok) return report(output, answer.failure);

  const { path, file } = keepToken(environment, home, api, token);

  output.say(`-> signed in to ${api}`);
  for (const line of describeIdentity(answer.body.identity)) output.say(line);
  output.say(`   token kept in ${path}, address in ${configPath(home, environment)}`);
  if (typeof file.server === "string" && file.server !== "") output.say("   this workstation also has a server: deploy goes through the API, the owner's other commands over SSH unless given --api");
  output.succeeded("login", { api, identity: answer.body.identity, tokenFile: path });
  return 0;
}

/**
 * The token written into the workstation's vault, 0600, the address it was
 * checked against beside it, and that address into config.json as `api`:
 * what `login` and `login --owner` keep. Never printed.
 */
export function keepToken(environment: Environment, home: string, api: string, token: string): { path: string; file: Record<string, unknown> } {
  const vault = vaultFolder(environment, home);
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  const path = join(vault, TOKEN_FILE);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  // The address the token was just checked against, beside it in the vault,
  // and the only one readRemote sends it to: see boundAddress.
  const address = join(vault, TOKEN_ADDRESS_FILE);
  writeFileSync(address, `${api}\n`, { mode: 0o600 });
  chmodSync(address, 0o600);
  const file = rawConfig(home, environment);
  mkdirSync(dirname(configPath(home, environment)), { recursive: true });
  writeFileSync(configPath(home, environment), `${JSON.stringify({ ...file, api }, null, 2)}\n`);
  return { path, file };
}

/**
 * What `{zone}` and `{contact}` become for the build: the deployment's own
 * answer, or, from a dashboard before it sends them, the zone the dashboard's
 * address names, `dashboard.<zone>`, and no contact. A placeholder that
 * cannot be filled stays in place, visible, as the unit generator leaves it.
 */
export function buildPlaceholders(slug: string, api: string, given: { zone?: unknown; contact?: unknown } | undefined): BuildContext["placeholders"] {
  if (given !== undefined && typeof given.zone === "string" && typeof given.contact === "string") return { slug, zone: given.zone, contact: given.contact };
  const host = new URL(api).hostname;
  return { slug, zone: host.startsWith("dashboard.") ? host.slice("dashboard.".length) : "", contact: "" };
}

/** Says a warning, with its details: the output's own way when it has one, its lines otherwise. */
function warnOn(output: Output, message: string, details: string[]): void {
  if (output.warn !== undefined) return output.warn(message, details);
  output.say(`!! ${message}`);
  for (const detail of details) output.say(`   ${detail}`);
}

/** What `sitesolide deploy` was asked, besides the folder: the options it takes with a token. */
export type DeployOptions = {
  json: boolean;
  /** `--dry-run`: the machine judges and plans, nothing is written there nor here. */
  dryRun: boolean;
  /** `--build`, in a dry run: the build runs all the same, here. */
  build: boolean;
  /** `--yes`: a folder without sitesolide.json deploys the manifest inferred from it, written beside it. */
  accept: boolean;
  /** `--slug`: the inferred manifest's name, instead of the folder's. */
  slug: string | undefined;
  /** `--force`: replace a unit or a block edited by hand on the machine. The owner's token for every project alone. */
  force: boolean;
  /** `--adopt`: take the name back from the token that holds it first. The owner's token for every project alone. */
  adopt: boolean;
};

/** Reads the options of `deploy` from its arguments, already judged by unknownOptions. */
export function deployOptions(arguments_: string[]): DeployOptions {
  const marker = arguments_.indexOf("--slug");
  return {
    json: arguments_.includes("--json"),
    dryRun: arguments_.includes("--dry-run"),
    build: arguments_.includes("--build"),
    accept: arguments_.includes("--yes"),
    slug: marker === -1 ? undefined : arguments_[marker + 1],
    force: arguments_.includes("--force"),
    adopt: arguments_.includes("--adopt"),
  };
}

/** The machine's plan of a deployment, `POST /api/v1/deployments/plan`: see PlanResponse in dashboard/src/control/protocol.ts. */
type PlanView = {
  slug: string;
  creating: boolean;
  existing: boolean;
  portal: boolean;
  allocated: { service: string | null; port: number }[];
  /** The manifest the installer would lay, its ports chosen and the machine's door applied. */
  manifest: string;
  placeholders: { zone: string; contact: string };
};

/** Shows an event: as it stands under --json, as text otherwise. */
function show(output: Output, event: OutputEvent): void {
  if (output.emit !== undefined) return output.emit(event);
  if (event.type === "file") {
    output.say("");
    output.say(`--- ${event.name} ---`);
    output.say(event.content);
  } else if (event.type === "inferred") {
    output.say(`   from: ${event.reasons.join("; ")}`);
    output.say(JSON.stringify(event.manifest, null, 2));
    for (const line of event.notes) output.say(`   note: ${line}`);
  }
}

/**
 * The manifest a folder without sitesolide.json implies, as `detect` infers
 * it: `--slug` names it, or the folder's name. The refusal otherwise.
 */
function inferredManifest(folder: string, chosen: string | undefined): { raw: string; inference: Exclude<Inference, { kind: "none" }> } | Failure {
  if (chosen !== undefined && (!isValidSlug(chosen) || chosen === "landing" || isSystemName(chosen))) {
    return { error: "invalid", message: `--slug: ${chosen} is not a usable slug`, details: ["lowercase letters, digits and dashes, no dot, not landing, nor the name of a service the machine runs"] };
  }
  const slug = chosen ?? slugFromFolder(basename(folder));
  if (slug === null) return { error: "invalid", message: `no usable slug in the folder name: ${basename(folder)}`, details: ["pass one with --slug <name>"] };
  const inference = inferManifest(folder, slug);
  if (inference.kind === "none") return { error: "invalid", message: `sitesolide.json not found in ${folder}, and none can be inferred`, details: inference.reasons };
  return { raw: renderManifest(inference.manifest), inference };
}

/**
 * The local manifest once it follows what the machine keeps of it: the door
 * set from the dashboard (`portal`, `lock`) and the former names a rename
 * left, read from the plan's final manifest. The SSH path wrote them back the
 * same way, so that the next deployment from any checkout keeps them. null
 * when nothing differs.
 */
export function followedManifest(raw: string, final: string): { raw: string; changed: string[] } | null {
  let local: Record<string, unknown>;
  let machine: Record<string, unknown>;
  try {
    local = JSON.parse(raw) as Record<string, unknown>;
    machine = JSON.parse(final) as Record<string, unknown>;
  } catch {
    return null;
  }
  let next = raw;
  const changed: string[] = [];
  if ((local.portal === true) !== (machine.portal === true) || (local.lock === true) !== (machine.lock === true)) {
    next = setLock(setPortal(next, machine.portal === true), machine.lock === true);
    changed.push("the general access set from the dashboard");
  }
  const former = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  if (former(local.formerSlugs).join(",") !== former(machine.formerSlugs).join(",")) {
    next = setFormerSlugs(next, Array.isArray(machine.formerSlugs) ? former(machine.formerSlugs) : undefined);
    changed.push("the former names a rename left");
  }
  return changed.length === 0 ? null : { raw: next, changed };
}

/**
 * The manifest with the ports the machine chose written in, each where a
 * person would write it: `port` after `start`, a service's own in its entry.
 * A port the manifest already declares is left as it is. null when none was
 * missing.
 */
export function withAllocatedPorts(raw: string, allocated: readonly { service: string | null; port: number }[]): string | null {
  let next = raw;
  let changed = false;
  for (const { service, port } of allocated) {
    const parsed = JSON.parse(next) as Record<string, unknown>;
    if (service === null) {
      if (typeof parsed.port === "number") continue;
      next = setPort(next, port);
      changed = true;
      continue;
    }
    const services = parsed.services;
    if (typeof services !== "object" || services === null || Array.isArray(services)) continue;
    const entry = (services as Record<string, unknown>)[service];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || typeof (entry as { port?: unknown }).port === "number") continue;
    (services as Record<string, unknown>)[service] = { ...(entry as Record<string, unknown>), port };
    next = `${JSON.stringify(parsed, null, 2)}\n`;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * The status the project's address answers once deployed, as the SSH path
 * reported it: a GET without credential, redirects not followed, 15 seconds
 * at most. The installer already verified the address from the machine and
 * judged the answer; this is what the workstation sees, null when it sees
 * nothing (a name not resolving here yet), never a failure of the deployment.
 */
async function probe(url: string | null, fetcher: Fetch): Promise<number | null> {
  if (url === null) return null;
  try {
    const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

async function deploy(remote: Remote, dependencies: RemoteDependencies, options: DeployOptions): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const { dryRun, json } = options;
  const folder = dependencies.folder;
  const manifestPath = join(folder, "sitesolide.json");

  // A folder without sitesolide.json: the manifest it implies, shown, and
  // deployed only with --yes, as over SSH.
  let inferred: string | null = null;
  let inferredKind: string | null = null;
  /** What --adopt took back, as the SSH path reported it. */
  let takenBack: { from: string | null; variables: string[]; files: string[] } | null = null;
  if (!existsSync(manifestPath)) {
    const found = inferredManifest(folder, options.slug);
    if ("error" in found) return report(output, found);
    output.say(`-> no sitesolide.json: this folder reads as ${found.inference.kind}`);
    show(output, { type: "inferred", kind: found.inference.kind, manifest: JSON.parse(found.raw), reasons: found.inference.reasons, notes: found.inference.notes });
    if (!options.accept) {
      return report(output, {
        error: "invalid",
        message: `no sitesolide.json in ${folder}: inferred one shown above, not written, nothing was sent`,
        details: ["to write it and deploy:            sitesolide deploy --yes", "to write it and review it first:   sitesolide detect --write"],
      });
    }
    inferred = found.raw;
    inferredKind = found.inference.kind;
  } else if (options.slug !== undefined) {
    warnOn(output, `--slug ${options.slug} ignored: sitesolide.json names the project`, []);
  }

  const read = readRemoteProject(folder, inferred ?? undefined);
  if ("errors" in read) {
    const [first, ...rest] = read.errors;
    return report(output, { error: "invalid", message: first ?? "sitesolide.json rejected", details: rest });
  }
  let project = read;
  const { manifest } = project;
  const slug = manifest.slug;
  output.say(`-> project ${slug}, through ${remote.api}${dryRun ? ": a dry run, nothing is changed on the machine nor here" : ""}`);

  // The build's secrets first, from whoever deploys: a missing one stops
  // here, before anything is sent, the manifest included. A dry run that does
  // not build only says which are missing.
  const declaration = secretsOf(manifest);
  const workstation = workstationSecretsPath(vaultFolder(dependencies.environment, dependencies.home ?? homedir()), slug);
  const resolved = await gatherBuildSecrets(declaration.build, dependencies.environment, workstation);
  const builds = !dryRun || options.build;
  if (resolved.refusal !== null && builds) return report(output, { error: "build-secrets-unreadable", ...unreadableWorkstation(workstation, resolved.refusal) });
  if (resolved.missing.length > 0) {
    const said = missingBuildSecrets(resolved.missing, workstation);
    if (builds) return report(output, { error: "build-secret-missing", ...said });
    warnOn(output, said.message, said.details ?? []);
  }
  for (const { name, source } of resolved.sources) output.say(`   ${sourceLine(name, source, workstation)}`);

  // --adopt: the name taken back from the token that holds it, before the
  // plan, which judges the deployment as the owner's token then stands.
  if (options.adopt) {
    if (dryRun) {
      output.say(`[dry-run] take ${slug} back from the token that holds it, its store moved aside as previous versions`);
    } else {
      output.say(`-> ${slug} taken back from the token that holds it`);
      const taken = await call<{ claim: { slug: string; released: string | null; dropped: { variables: string[]; files: string[] } } }>(
        remote,
        `/api/v1/projects/${encodeURIComponent(slug)}/claim`,
        { method: "DELETE" },
        dependencies.fetcher,
      );
      if (!taken.ok) return report(output, taken.failure);
      const { released, dropped } = taken.body.claim;
      takenBack = { from: released, variables: dropped.variables, files: dropped.files };
      output.say(released === null ? "   no token held it" : `   released from token ${released}`);
      const moved = [...dropped.variables, ...dropped.files];
      if (moved.length > 0) output.say(`   moved aside, kept as previous versions: ${moved.join(", ")}`);
    }
  }

  // The plan: the machine judges the manifest as the deployment would, and
  // says what it would lay, writing nothing. A dashboard or a steward from
  // before it plans nothing: a deployment goes on without it, a dry run says so.
  const asked = (raw: string) => JSON.stringify({ manifest: raw, ...(options.force ? { force: true } : {}) });
  const planned = await call<{ plan: PlanView }>(
    remote,
    "/api/v1/deployments/plan",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: asked(project.raw) },
    dependencies.fetcher,
  );
  let plan: PlanView | null = null;
  if (planned.ok) plan = planned.body.plan;
  else if (dryRun && options.adopt && planned.failure.error === "out-of-scope") {
    output.say("[dry-run] the rest is judged once the name is taken back, which a dry run does not do");
    output.succeeded("deploy", { slug, dryRun: true, adopt: true, manifestWritten: false, url: null, status: null });
    return 0;
  } else if (planned.failure.error !== "not-available" && !predatesRoute(planned)) return report(output, planned.failure);
  else if (dryRun) {
    return report(output, { error: "not-available", message: "this machine does not plan a deployment yet: the owner must run sitesolide upgrade", details: ["nothing was sent but the manifest, and nothing was changed"] });
  }

  // An inferred manifest names the project after its folder: a project of
  // that name the machine already carries would be replaced. Refused before
  // anything is written, as over SSH.
  if (inferred !== null && plan !== null && plan.existing) {
    return report(output, {
      error: "invalid",
      message: `${slug} already exists on the server, and this folder has no sitesolide.json`,
      details: ["deploying the inferred manifest under that name would replace the project the server carries", "pick another name:  sitesolide deploy --yes --slug <name>"],
    });
  }
  let manifestWritten = false;
  const write = (raw: string, why: string): void => {
    if (dryRun) return output.say(`[dry-run] write ${manifestPath}, ${why}`);
    writeFileSync(manifestPath, raw);
    manifestWritten = true;
    output.say(`   written: ${manifestPath}, ${why}: commit it`);
  };
  if (inferred !== null) write(inferred, "the inferred manifest");

  // The door and the former names, as the machine keeps them.
  const followed = plan === null ? null : followedManifest(project.raw, plan.manifest);
  if (followed !== null) {
    output.say(`-> ${followed.changed.join(", and ")}, as the server keeps them`);
    const checked = checkManifest(followed.raw);
    if (checked.manifest === undefined) return report(output, { error: "invalid", message: "sitesolide.json rejected once the server's values are applied", details: checked.errors });
    write(followed.raw, followed.changed.join(", "));
    project = { ...project, manifest: checked.manifest, raw: followed.raw };
  }

  if (dryRun && plan !== null) return dryRunReport(remote, dependencies, project, plan, resolved, { json, build: options.build, inferred: inferredKind });

  // The runtime secrets the store lacks, before anything is sent: asked for
  // at a terminal, warned of otherwise. Never a stop.
  const store = await import("./store-cli");
  const transport = store.apiStore(remote, dependencies.fetcher);
  const io: MissingIo = {
    terminal: (dependencies.terminal ?? (() => process.stdin.isTTY === true))() && (dependencies.outputTerminal ?? (() => process.stdout.isTTY === true))(),
    json,
    ask: async (question) => (dependencies.prompt ?? prompt)(question),
    secret: dependencies.secretPrompt ?? promptWithoutEcho,
    say: (line) => output.say(line),
    warn: (message, details) => warnOn(output, message, details),
  };
  const declares = hasStore(manifest) && (declaration.runtime.length > 0 || declaration.files.length > 0);
  let missing: StoreMissing | null = declares ? null : { runtime: [], files: [] };
  let deferred = false;
  // What the store lacks of the declared names. A listing this token may
  // not make, or may not make again this hour, leaves it to the machine's
  // log, which names what is missing; one that fails otherwise is said, and
  // the deployment goes on, as a missing secret never stops one.
  if (declares) {
    output.say("-> runtime secrets");
    const listed = await transport.list(slug, true);
    if (listed.ok) {
      missing = await store.handleMissing(store.withDeclared(listed.value, declaration), transport, io);
      if (missing.runtime.length === 0 && missing.files.length === 0) output.say("   every declared runtime secret is set");
    } else if (listed.failure.error === "out-of-scope") {
      output.say("   this token may not list the store: the machine's log names what is missing");
    } else if (listed.failure.error === "too-many-attempts") {
      output.say("   the store cannot be listed again this hour: the machine's log names what is missing");
    } else if (listed.failure.error === "not-found") {
      // A project not deployed yet whose store this token may not hold
      // ahead: what the store lacks is asked for once the deployment made it.
      deferred = true;
      output.say("   not deployed yet: what its store lacks is said once the deployment is done");
    } else if (["unauthenticated", "unreachable"].includes(listed.failure.error)) {
      // What would refuse the deployment itself, said as it stands.
      return report(output, listed.failure);
    } else {
      warnOn(output, `cannot tell which declared runtime secrets the store lacks: ${listed.failure.message}`, ["sitesolide secrets lists them once the store answers"]);
    }
  }

  // The manifest first: the dashboard and the steward judge it, so that a
  // refusal comes back before the build and the upload.
  const created = await call<{ deployment: DeploymentView }>(
    remote,
    "/api/v1/deployments",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: asked(project.raw) },
    dependencies.fetcher,
  );
  if (!created.ok) return report(output, created.failure);
  const deployment = created.body.deployment;
  output.say(`   deployment ${deployment.id}${deployment.creating ? ", a new project" : ""}${options.force ? ", --force: a unit or a block edited by hand is replaced" : ""}`);

  await dependencies.build(project, { secrets: resolved.values, placeholders: buildPlaceholders(slug, remote.api, deployment.placeholders) });
  dependencies.checkPublic(project);

  output.say("-> archive");
  const archived = archiveOf(project);
  if ("error" in archived) return report(output, archived);
  const { archive } = archived;

  output.say("-> upload");
  const uploaded = await call<{ deployment: DeploymentView }>(
    remote,
    `/api/v1/deployments/${deployment.id}/bundle`,
    { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: archive },
    dependencies.fetcher,
  );
  if (!uploaded.ok) return report(output, uploaded.failure);

  // The machine's log, as it is written, until the end.
  let next = 0;
  const pause = dependencies.pause ?? (() => Bun.sleep(1000));
  for (;;) {
    const read = await call<{ deployment: DeploymentView }>(remote, `/api/v1/deployments/${deployment.id}?after=${next}`, {}, dependencies.fetcher);
    if (!read.ok) {
      if (read.failure.error === "unreachable") {
        await pause();
        continue;
      }
      return report(output, read.failure);
    }
    const view = read.body.deployment;
    for (const line of view.log) output.say(line);
    next = view.next;
    if (view.state === "succeeded") {
      // The ports the machine chose, written into sitesolide.json, as over
      // SSH: the next deployment, from here or elsewhere, keeps them.
      const ported = withAllocatedPorts(project.raw, view.allocated);
      if (ported !== null) {
        for (const { service, port } of view.allocated) output.say(`   the machine chose port ${port}${service === null ? "" : ` for ${service}`}`);
        write(ported, "with the ports the machine chose");
      }
      // What the installer found missing once done is the word that counts;
      // one that could not say, or a dashboard before it, leaves the reading
      // made before the deployment.
      let missingSecrets: StoreMissing | null = view.missingSecrets ?? missing;
      if (deferred && io.terminal && !json) missingSecrets = await askAfterCreation(slug, declaration, transport, io, store, output);
      const main = view.allocated.find((entry) => entry.service === null) ?? view.allocated[0];
      const status = await (dependencies.probe ?? ((url: string | null) => probe(url, dependencies.fetcher ?? fetch)))(view.url);
      if (status !== null) output.say(`   ${view.url} ${status}, as this workstation sees it`);
      output.succeeded("deploy", {
        slug,
        kind: isApp(manifest) ? (hasServices(manifest) ? "services" : "service") : "static",
        ...(isApp(manifest) ? { runs: runsOf(servicesOf(manifest)) } : {}),
        dryRun: false,
        port: main?.port ?? mainPort(manifest),
        ...(view.allocated.length > 0 ? { portChosen: "free" } : {}),
        manifestWritten,
        portal: project.manifest.portal === true,
        ...(inferredKind === null ? {} : { inferred: inferredKind }),
        ...(takenBack === null ? {} : { takenBack }),
        url: view.url,
        status,
        deployment: deployment.id,
        creating: deployment.creating,
        missingSecrets,
        buildSecrets: resolved.sources,
      });
      return 0;
    }
    if (view.state === "failed" || view.state === "expired") {
      const error = view.error ?? { code: view.state === "expired" ? "expired" : "failure", message: `the deployment ended ${view.state}` };
      // A person already read the message in the machine's log; an agent
      // still gets it as the final event, with its hint.
      output.failed({ error: error.code, message: error.message }, view.log.some((line) => line.includes(error.message)));
      return 1;
    }
    await pause();
  }
}

/** The archive a deployment uploads, or why the machine would refuse it. */
function archiveOf(project: RemoteProject): { archive: Uint8Array; files: number; bytes: number } | Failure {
  const { entries, refused } = projectEntries(project);
  if (refused.length > 0) {
    return { error: "invalid", message: "the machine refuses links and special files in the archive", details: [...refused.slice(0, 10), "replace them with the files they point to, or exclude them in sitesolide.json"] };
  }
  const files = entries.filter((entry) => entry.kind === "file");
  const bytes = files.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.content.length : 0), 0);
  if (entries.length > LIMITS.entries || bytes > LIMITS.extractedBytes) {
    return { error: "too-large", message: `${entries.length} entries, ${bytes} bytes: over what the machine accepts (${LIMITS.entries} entries, 512 MiB)`, details: ["exclude dependencies and caches in sitesolide.json: the machine installs dependencies itself"] };
  }
  const archive = bundle(entries);
  if (archive.length > LIMITS.bundleBytes) return { error: "too-large", message: `the archive is ${archive.length} bytes compressed, over 100 MiB` };
  return { archive, files: files.length, bytes };
}

/**
 * The end of a dry run: what the machine would lay, the units and the block
 * generated from the plan's final manifest as the installer generates them,
 * what the store lacks, and the archive measured. The build runs with
 * --build alone; nothing is uploaded, nothing written.
 */
async function dryRunReport(
  remote: Remote,
  dependencies: RemoteDependencies,
  project: RemoteProject,
  plan: PlanView,
  resolved: { values: Record<string, string>; sources: unknown[] },
  options: { json: boolean; build: boolean; inferred: string | null },
): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const slug = project.manifest.slug;
  const checked = checkManifest(plan.manifest);
  if (checked.manifest === undefined) return report(output, { error: "failure", message: "the machine's plan carries a manifest this CLI cannot read", details: checked.errors });
  const final = checked.manifest;
  output.say(`-> plan: ${plan.creating ? "a new project" : plan.existing ? "the project the server carries, replaced" : "a project the server does not carry yet"}${plan.portal ? ", Restricted" : ""}`);
  for (const { service, port } of plan.allocated) output.say(`   port ${port}${service === null ? "" : ` for ${service}`}, chosen by the machine`);
  const placeholders = { slug, zone: plan.placeholders.zone, contact: plan.placeholders.contact };
  for (const { unit, text } of generateUnits(final, placeholders)) show(output, { type: "file", name: unitFileName(unit), content: text });
  const fragment = generateFragment(final);
  if (fragment !== null) show(output, { type: "file", name: `${slug}.caddy`, content: fragment });

  // What the store lacks, said and never asked for: a dry run sets nothing.
  let missingSecrets: StoreMissing | null = null;
  const declaration = secretsOf(project.manifest);
  if (hasStore(project.manifest) && (declaration.runtime.length > 0 || declaration.files.length > 0)) {
    const store = await import("./store-cli");
    const listed = await store.apiStore(remote, dependencies.fetcher).list(slug, true);
    if (listed.ok) {
      missingSecrets = store.missingOf(store.withDeclared(listed.value, declaration));
      const names = [...missingSecrets.runtime, ...missingSecrets.files.map((name) => `${name} (file)`)];
      if (names.length > 0) warnOn(output, `the store lacks ${names.join(", ")}`, [`sitesolide secrets set <NAME> sets one; the deployment asks for each at a terminal`]);
      else output.say("   every declared runtime secret is set");
    } else output.say(`   the store was not listed: ${listed.failure.message}`);
  }

  if (options.build) {
    await dependencies.build(project, { secrets: resolved.values, placeholders: buildPlaceholders(slug, remote.api, plan.placeholders) });
    dependencies.checkPublic(project);
  } else if (project.manifest.build !== undefined) {
    output.say(`[dry-run] build (${project.manifest.build}), not run: it is this folder's code, run here only for real or with --dry-run --build`);
  }
  const archived = archiveOf(project);
  if ("error" in archived) return report(output, archived);
  output.say(`[dry-run] upload ${archived.files} file(s), ${archived.bytes} bytes, ${archived.archive.length} compressed${options.build ? "" : ", unbuilt: --build builds first"}`);
  output.say(`[dry-run] the installer lays it, restarts the services and verifies https://${slug}.${plan.placeholders.zone}/`);
  const main = plan.allocated.find((entry) => entry.service === null) ?? plan.allocated[0];
  output.succeeded("deploy", {
    slug,
    kind: isApp(final) ? (hasServices(final) ? "services" : "service") : "static",
    ...(isApp(final) ? { runs: runsOf(servicesOf(final)) } : {}),
    dryRun: true,
    port: main?.port ?? mainPort(final),
    manifestWritten: false,
    portal: plan.portal,
    ...(options.inferred === null ? {} : { inferred: options.inferred }),
    url: `https://${slug}.${plan.placeholders.zone}/`,
    status: null,
    creating: plan.creating,
    missingSecrets,
    buildSecrets: resolved.sources,
  });
  return 0;
}

/**
 * The prompts of a first deployment whose store the token could not hold
 * ahead, now that the deployment made the project: then one restart offered,
 * so that the service reads what was set. What is left missing is returned.
 */
async function askAfterCreation(
  slug: string,
  declaration: SecretsDeclaration,
  transport: StoreTransport,
  io: MissingIo,
  store: typeof import("./store-cli"),
  output: Output,
): Promise<StoreMissing | null> {
  output.say("-> runtime secrets, now that the project exists");
  const listed = await transport.list(slug, true);
  if (!listed.ok) {
    warnOn(output, `cannot tell which runtime secrets are set: ${listed.failure.message}`, []);
    return null;
  }
  const view = store.withDeclared(listed.value, declaration);
  const before = store.missingOf(view);
  const left = await store.handleMissing(view, transport, io);
  if (left.runtime.length === before.runtime.length) return left;
  const answer = await io.ask("Restart the service now, so that it reads them? [y/N] ");
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
    output.say("   not restarted: sitesolide restart applies them");
    return left;
  }
  const restarted = await transport.restart(slug);
  if (!restarted.ok) warnOn(output, `the restart was not made: ${restarted.failure.message}`, ["sitesolide restart, once its cause is fixed"]);
  else output.say(`   ${store.verdictWords(restarted.value.verdict)}`);
  return left;
}

/** One service of a project, as the control API reports it. */
type ServiceState = {
  name: string | null;
  state: string;
  subState: string;
  port: number | null;
  /** Absent from a dashboard from before workers and scheduled services: every service was a server then. */
  kind?: "server" | "worker" | "scheduled";
};

type ProjectStatus = {
  slug: string;
  access: string;
  deployed: boolean;
  type: string | null;
  url: string | null;
  /** Absent from a dashboard from before it: read from `portal` then. */
  general?: "public" | "restricted" | "code" | null;
  portal: { wanted: boolean; installed: boolean } | null;
  services: ServiceState[];
};

/**
 * The SERVICE column of a project: `active` when everything that should run
 * does, the states that differ otherwise. A scheduled service is inactive
 * between two runs and active during one, neither of which says anything is
 * wrong: only a failed run counts. A project whose every service is
 * scheduled, none failed, reads `scheduled`.
 */
export function serviceWord(services: readonly ServiceState[]): string {
  if (services.length === 0) return "-";
  const counted = services.filter((service) => service.kind !== "scheduled" || service.state === "failed");
  if (counted.length === 0) return "scheduled";
  return counted.every((service) => service.state === "active") ? "active" : counted.map((service) => service.state).join(",");
}

/** Who may open the site, in the words of the dashboard's Access section. */
export function generalWord(project: Pick<ProjectStatus, "general" | "portal" | "deployed">): string {
  const general = project.general !== undefined ? project.general : project.portal === null ? null : project.portal.installed ? "restricted" : "public";
  if (!project.deployed || general === null) return "-";
  return { public: "Public", restricted: "Restricted", code: "Anyone with the code" }[general];
}

async function status(remote: Remote, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const who = await call<{ identity: Identity }>(remote, "/api/v1/whoami", {}, dependencies.fetcher);
  if (!who.ok) return report(output, who.failure);
  output.say(`=== ${remote.api}`);
  for (const line of describeIdentity(who.body.identity)) output.say(line);
  const answer = await call<{ projects: ProjectStatus[] }>(remote, "/api/v1/projects", {}, dependencies.fetcher);
  if (!answer.ok) return report(output, answer.failure);
  output.say("");
  output.say(`${"PROJECT".padEnd(22)} ${"TYPE".padEnd(7)} ${"SERVICE".padEnd(10)} ${"GENERAL ACCESS".padEnd(21)} ADDRESS`);
  for (const project of answer.body.projects) {
    const service = serviceWord(project.services);
    output.say(`${project.slug.padEnd(22)} ${(project.type ?? (project.deployed ? "?" : "-")).padEnd(7)} ${service.padEnd(10)} ${generalWord(project).padEnd(21)} ${project.url ?? "not deployed"}`);
  }
  output.succeeded("status", { api: remote.api, identity: who.body.identity, projects: answer.body.projects });
  return 0;
}

async function logs(remote: Remote, dependencies: RemoteDependencies, follow: boolean, lines: number): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const manifest = folderManifest(dependencies.folder);
  if ("error" in manifest) return report(output, manifest);
  let cursor: string | null = null;
  let entries = 0;
  const pause = dependencies.pause ?? (() => Bun.sleep(2000));
  for (;;) {
    const parameters: Record<string, string> = cursor === null ? { lines: String(lines) } : { lines: "500", cursor };
    const query = new URLSearchParams(parameters);
    const answer: Answer<{ lines: string[]; cursor: string | null }> = await call(remote, `/api/v1/projects/${encodeURIComponent(manifest.slug)}/logs?${query}`, {}, dependencies.fetcher);
    if (!answer.ok) return report(output, answer.failure);
    for (const line of answer.body.lines) output.journal(line);
    entries += answer.body.lines.length;
    cursor = answer.body.cursor;
    if (!follow) {
      output.succeeded("logs", { slug: manifest.slug, entries, cursor });
      return 0;
    }
    await pause();
  }
}

/**
 * A dashboard from before a route answers it from its catch-all, `not-found`
 * "no such route": said as what it is, a machine that does not carry it yet,
 * rather than a project the token cannot see.
 */
export function predatesRoute(answer: Answer<unknown>): boolean {
  return !answer.ok && answer.failure.error === "not-found" && answer.failure.message.startsWith("no such route");
}

// --- secrets and restarts --------------------------------------------------------
//
// `sitesolide secrets` and `sitesolide restart` live in ./store-cli, one parser
// and one renderer for SSH and the API: runRemote hands them this folder's
// slug and the API's transport. What stays here is the prompt that does not
// echo, which `login` reads a token with too.

/**
 * How the no-echo prompt ends: the value entered, null when it was abandoned,
 * or a refusal saying why, nothing sent.
 */
export type Typed = string | null | { refused: string };

/** Where a line typed without echo stands: the value so far, and `typed` once it ended. */
export type Keying = { value: string; typed?: Typed };

const SEVERAL_LINES = "more than one line arrived at the prompt, a paste of several lines";

/** A control key in words: it is a key pressed, not a part of a value. */
function keyName(character: string): string {
  const code = character.codePointAt(0)!;
  if (character === "\t") return "Tab";
  if (code < 0x20) return `Ctrl-${String.fromCharCode(code + 0x40)}`;
  return `a control character, U+${code.toString(16).toUpperCase().padStart(4, "0")},`;
}

/**
 * One more piece of what was typed, read the way a shell's prompt edits a
 * line. In raw mode the terminal edits nothing: taken as they come, Ctrl-U,
 * Ctrl-W, Ctrl-Z and an arrow's escape sequence would go into the value as
 * characters, which the steward accepts, and the service would read a secret
 * nobody had meant. So Backspace, Ctrl-U and Ctrl-W edit, Enter ends, Ctrl-C and Ctrl-D
 * abandon, and any other control key is refused rather than guessed at.
 *
 * Anything after the line's end is refused too: a paste of several lines
 * would otherwise keep its first line silently.
 */
export function keyIn(value: string, text: string): Keying {
  const characters = Array.from(text);
  let line = Array.from(value);
  for (let i = 0; i < characters.length; i++) {
    const character = characters[i]!;
    if (character === "\u0003" || character === "\u0004") return { value: "", typed: null };
    if (character === "\r" || character === "\n") {
      // A pasted Windows line ends in both: one line still.
      const rest = characters.slice(character === "\r" && characters[i + 1] === "\n" ? i + 2 : i + 1);
      if (rest.length > 0) return { value: "", typed: { refused: SEVERAL_LINES } };
      return { value: line.join(""), typed: line.join("") };
    }
    if (character === "\u007f" || character === "\b") line = line.slice(0, -1);
    else if (character === "\u0015") line = [];
    else if (character === "\u0017") {
      // As readline's unix-word-rubout: the blanks before the cursor, then the word.
      while (line.length > 0 && /\s/u.test(line.at(-1)!)) line.pop();
      while (line.length > 0 && !/\s/u.test(line.at(-1)!)) line.pop();
    } else if (character === "\u001b") return { value: "", typed: { refused: "an arrow key or another escape sequence was typed at the prompt, which takes none" } };
    else if (/\p{Cc}/u.test(character)) return { value: "", typed: { refused: `${keyName(character)} was typed at the prompt, which takes no control key` } };
    else line.push(character);
  }
  return { value: line.join("") };
}

/** The terminal the prompt reads, injectable so that its tests drive every way it ends. */
export type HiddenTerminal = {
  /** Raw mode: no echo, no line editing, Ctrl-C a character rather than a signal. */
  setRawMode: (raw: boolean) => void;
  /** Hands over what arrives, and `end` when the input closes, until the function returned is called. */
  listen: (data: (chunk: Uint8Array) => void, end: () => void) => () => void;
  /** Standard error: standard output carries the events of --json. */
  write: (text: string) => void;
  /** Runs `restore` on SIGINT, SIGTERM and SIGHUP, until the function returned is called. */
  onSignals: (restore: () => void) => () => void;
};

const PROMPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The process's own: standard input in raw mode, the question on standard error. */
export function processTerminal(): HiddenTerminal {
  const input = process.stdin;
  return {
    setRawMode: (raw) => {
      input.setRawMode(raw);
    },
    listen(data, end) {
      const onData = (chunk: Uint8Array | string) => data(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      input.on("data", onData);
      input.on("end", end);
      input.resume();
      return () => {
        input.off("data", onData);
        input.off("end", end);
        input.pause();
      };
    },
    write: (text) => {
      process.stderr.write(text);
    },
    onSignals(restore) {
      const handlers = PROMPT_SIGNALS.map((signal) => {
        const handler = () => {
          restore();
          off();
          // Raised again with no handler left, so the run ends as the signal
          // meant, its exit status included, once the terminal echoes again:
          // a run killed in raw mode left the shell typing blind.
          process.kill(process.pid, signal);
        };
        process.on(signal, handler);
        return [signal, handler] as const;
      });
      const off = () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
      };
      return off;
    },
  };
}

/**
 * How long the prompt keeps reading once the line has ended. A paste arrives
 * in one burst, a few chunks apart by well under this; a person's next key,
 * after Enter, comes far later. What arrives meanwhile is read and dropped
 * here, rather than left for the shell to echo, run and keep in its history.
 */
export const PROMPT_QUIET_MS = 100;

/** However long a paste keeps arriving, the terminal is given back after this. */
const PROMPT_DRAIN_MAX_MS = 2_000;

/**
 * A value typed at the terminal, never echoed, in raw mode as
 * dashboard/scripts/fingerprint.ts reads a password, edited as `keyIn` says.
 *
 * The terminal is given back its echo however the prompt ends: Enter, Ctrl-C,
 * a refusal, the input closing, an exception (the `finally`), or a signal,
 * which raw mode no longer sends for Ctrl-C but `kill` and a closed window
 * still do.
 */
export async function promptWithoutEcho(question: string, terminal: HiddenTerminal = processTerminal(), quietMs = PROMPT_QUIET_MS): Promise<Typed> {
  let raw = false;
  let stopListening = (): void => {};
  let stopSignals = (): void => {};
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let longest: ReturnType<typeof setTimeout> | undefined;
  let finish: (typed: Typed) => void = () => {};
  const restore = (): void => {
    clearTimeout(quiet);
    clearTimeout(longest);
    stopListening();
    stopListening = () => {};
    stopSignals();
    stopSignals = () => {};
    if (!raw) return;
    raw = false;
    terminal.setRawMode(false);
    terminal.write("\n");
  };
  try {
    const typed = new Promise<Typed>((resolve) => {
      finish = resolve;
    });
    terminal.write(question);
    stopSignals = terminal.onSignals(() => {
      restore();
      finish(null);
    });
    terminal.setRawMode(true);
    raw = true;

    const decoder = new TextDecoder("utf-8", { fatal: true });
    let value = "";
    /** Decided, and still reading what follows: `undefined` while typing. */
    let outcome: Typed | undefined;
    /** The line ended on a carriage return whose line feed may come in the next read. */
    let feedDue = false;
    const done = () => finish(outcome === undefined ? null : outcome);
    const drain = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    };
    const decide = (decided: Typed) => {
      outcome = decided;
      longest = setTimeout(done, PROMPT_DRAIN_MAX_MS);
      drain();
    };
    stopListening = terminal.listen(
      (chunk) => {
        try {
          if (outcome !== undefined) {
            const feed = feedDue && chunk.length === 1 && chunk[0] === 0x0a;
            feedDue = false;
            // The rest of a paste: the line it follows was not the whole value.
            if (typeof outcome === "string" && !feed) outcome = { refused: SEVERAL_LINES };
            drain();
            return;
          }
          let text: string;
          try {
            text = decoder.decode(chunk, { stream: true });
          } catch {
            decide({ refused: "what arrived at the prompt is not valid UTF-8" });
            return;
          }
          const step = keyIn(value, text);
          value = step.value;
          if (step.typed === undefined) return;
          feedDue = typeof step.typed === "string" && text.endsWith("\r");
          decide(step.typed);
        } catch {
          // Thrown here, nothing would reach the `finally`: the run would end in raw mode.
          outcome = null;
          done();
        }
      },
      () => {
        if (outcome === undefined) outcome = null;
        done();
      },
    );
    return await typed;
  } finally {
    restore();
  }
}

/**
 * This folder's project, from its manifest, as `share`, `secrets` and `logs`
 * read it: its slug, and whether it may have a store.
 */
function folderManifest(folder: string): Manifest | Failure {
  const path = join(folder, "sitesolide.json");
  if (!existsSync(path)) return { error: "invalid", message: `sitesolide.json not found in ${folder}: run this from the project's folder` };
  const { manifest } = checkManifest(readFileSync(path, "utf8"));
  if (manifest === undefined) return { error: "invalid", message: "sitesolide.json rejected" };
  return manifest;
}

/** All of standard input, as bytes. */
async function standardInput(): Promise<Uint8Array> {
  return Bun.stdin.bytes();
}

/** What a command that needs the machine's root says through the API. */
export function needsSsh(command: string): Failure {
  return {
    error: "needs-ssh",
    message: `sitesolide ${command} needs the owner's SSH access to the machine`,
    details: [
      "with a token, this workstation runs: deploy, status, logs, secrets, restart, login",
      "ask the owner of the machine, who runs it from a workstation configured with sitesolide init",
    ],
  };
}

/**
 * The options each command takes through the API, and whether one carries a
 * value. Anything else is refused before a request leaves, rather than passed
 * over: `--dry-run` passed over once deployed for real, the live site
 * replaced by a run its author believed changed nothing. It is the machine's
 * plan now, `POST /api/v1/deployments/plan`, which writes nothing.
 */
const REMOTE_OPTIONS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  deploy: { "--dry-run": false, "--build": false, "--yes": false, "--slug": true, "--force": false, "--adopt": false },
  status: {},
  logs: { "--follow": false, "--lines": true },
  login: { "--url": true, "--token-stdin": false },
  // Read by readStoreArguments in ./store-cli, which never quotes what it refuses.
  secrets: { "--stdin": false, "--restart": false, "--format": true, "--bytes": true, "--replace": false },
  restart: {},
};

/** Every command takes these two: they choose the output and the mode, read before here. */
const GLOBAL_OPTIONS = ["--json", "--api"];

/** The refusal of an option the command does not take through the API, or null. */
export function unknownOptions(command: string, arguments_: string[]): Failure | null {
  const known = REMOTE_OPTIONS[command] ?? {};
  const rest = arguments_[0] === command ? arguments_.slice(1) : arguments_;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i]!;
    if (GLOBAL_OPTIONS.includes(option)) continue;
    if (Object.hasOwn(known, option)) {
      if (known[option]) i++;
      continue;
    }
    if (!option.startsWith("-")) continue;
    const takes = Object.keys(known);
    return {
      error: "unknown-option",
      message: `${option}: not an option of sitesolide ${command} with a token: nothing was sent`,
      details: [
        takes.length === 0 ? `with a token, sitesolide ${command} takes no option` : `with a token, sitesolide ${command} takes ${takes.join(", ")}`,
        ...(command === "deploy" && option === "--compare" ? ["--compare measures a component setup and upgrade deploy over SSH; a dry run with a token shows the units and the block the machine would lay"] : []),
      ],
    };
  }
  return null;
}

/**
 * The platform's own components, which `sitesolide setup` and `upgrade`
 * deploy over the owner's SSH access, from the kit: the dashboard, which
 * serves the API every other deployment goes through, cannot be deployed
 * through itself, nor can the portal, which no token may touch (RESERVED_SLUGS
 * in dashboard/src/control/policy.ts). Every other project deploys through
 * the API, the owner's included.
 */
export const PLATFORM_COMPONENTS: readonly string[] = ["dashboard", "portal"];

/**
 * Whether `sitesolide deploy` in this folder runs over SSH: a platform
 * component's folder alone, its slug read from its manifest. Every other
 * folder, one without a manifest included, deploys through the API.
 */
export function deploysOverSsh(folder: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(folder, "sitesolide.json"), "utf8")) as { slug?: unknown } | null;
    return typeof parsed?.slug === "string" && PLATFORM_COMPONENTS.includes(parsed.slug);
  } catch {
    return false;
  }
}

/** The commands only the owner's SSH access carries. */
export const SSH_COMMANDS = ["lock", "unlock", "domain", "remove", "run", "share", "passkey", "refresh", "backups"];

export const REMOTE_USAGE = [
  "usage, with a token:",
  "  sitesolide login --url <https://dashboard.zone>   keep the token, check it",
  "     --token-stdin                                  read it from standard input",
  "  sitesolide deploy                                 build here, upload, follow the machine's log",
  "     --dry-run                                      the machine judges and plans it: units, block, ports; nothing changed",
  "     --build                                        in a dry run, build all the same",
  "     --yes [--slug <name>]                          a folder without sitesolide.json: deploy the inferred one, written here",
  "     --force                                        replace a unit or a block edited by hand (the owner's token for every project)",
  "     --adopt                                        take the name back from the token that holds it first (same)",
  "  sitesolide status                                 the projects this token may deploy",
  "  sitesolide logs [--follow]                        the journal of this folder's project",
  "     --lines <n>                                    how many lines back, 50 by default, 500 at most",
  "  sitesolide secrets                                this folder's project's secrets: names, sources, states, never a value",
  "  sitesolide secrets set <NAME>                     set a variable in the project's store, typed at a prompt that does not echo it",
  "     --stdin                                        the value from standard input, one trailing line break dropped",
  "  sitesolide secrets generate <NAME>                a random value drawn on the server, never shown",
  "     --format hex|base64url --bytes <16-64>         hex and 32 bytes by default",
  "     --replace                                      draw a new one over a value already set",
  "  sitesolide secrets remove <NAME>...               take variables out of the store",
  "  sitesolide secrets set-file <NAME> < path         a file read whole, 64 KiB at most, read at $CREDENTIALS_DIRECTORY/files_<NAME>",
  "  sitesolide secrets remove-file <NAME>             take a file out of the store",
  "     --restart                                      with any change: then restart the service, and say whether it holds",
  "  sitesolide restart                                restart this folder's project's service, and say whether it holds",
  "",
  "--json, on every one of them: one JSON event per line, see docs/agents.md",
  "a secret's value never goes on the command line: with --json, secrets set needs --stdin",
  "SITESOLIDE_API and SITESOLIDE_TOKEN, both in the environment, win over the files.",
];

/**
 * What a workstation without a token runs to deploy: every deployment goes
 * through the dashboard's API, the owner's included, and none over SSH. The
 * dashboard's address from the configuration's zone when it has one.
 */
export function tokenAdvice(environment: Environment, home: string): string[] {
  const zone = environment.SITESOLIDE_ZONE ?? rawConfig(home, environment).zone;
  const dashboard = typeof zone === "string" && zone !== "" ? dashboardAddress(zone) : "https://dashboard.<zone>";
  const server = environment.SITESOLIDE_SERVER ?? rawConfig(home, environment).server;
  return [
    "every deployment goes through the dashboard's API with a token, the owner's too: none goes over SSH any more",
    ...(typeof server === "string" && server !== ""
      ? ["the owner mints theirs over SSH, straight into this workstation's vault, never shown:  sitesolide login --owner"]
      : []),
    `or mint one on ${dashboard}, Tokens, New token (the owner: Every project, as you), then:  sitesolide login --url ${dashboard}`,
    "an agent or a CI sets SITESOLIDE_API and SITESOLIDE_TOKEN in its environment instead",
  ];
}

/** Runs a command through the API; the exit code is returned, never thrown. */
export async function runRemote(command: string, arguments_: string[], dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const remote = readRemote(dependencies.environment, dependencies.home ?? homedir());
  if (SSH_COMMANDS.includes(command)) return report(output, needsSsh(command));
  if (!["deploy", "status", "logs", "secrets", "restart"].includes(command)) {
    const [title, ...usage] = REMOTE_USAGE;
    return report(output, { error: "usage", message: command === "" ? (title ?? "usage") : `unknown command with a token: ${command}`, details: command === "" ? usage : REMOTE_USAGE });
  }
  // `secrets` reads its own arguments: unknownOptions quotes the option it
  // refuses, and an argument of `secrets set` may be a value. Loaded here,
  // not at the top: ./store-cli reads this module's `call`.
  const store = command === "secrets" || command === "restart" || command === "deploy" ? await import("./store-cli") : null;
  const asked = command === "secrets" ? store!.readStoreArguments(arguments_, arguments_.includes("--json")) : null;
  if (asked !== null && "error" in asked) return report(output, asked);
  const refused = command === "secrets" ? null : unknownOptions(command, arguments_);
  if (refused !== null) return report(output, refused);
  const marker = arguments_.indexOf("--lines");
  const lines = marker === -1 ? "50" : (arguments_[marker + 1] ?? "");
  if (command === "logs" && (!/^[0-9]+$/.test(lines) || Number(lines) < 1 || Number(lines) > 500)) {
    return report(output, { error: "invalid", message: `--lines: ${lines || "nothing given"} is not a number of lines between 1 and 500, what the API returns at most` });
  }
  if ("missing" in remote) {
    if (command !== "deploy") return report(output, { error: "unauthenticated", message: remote.missing });
    return report(output, { error: "unauthenticated", message: `sitesolide deploy needs a token: ${remote.missing}`, details: tokenAdvice(dependencies.environment, dependencies.home ?? homedir()) });
  }
  switch (command) {
    case "deploy":
      return deploy(remote, dependencies, deployOptions(arguments_));
    case "status":
      return status(remote, dependencies);
    case "secrets":
    case "restart": {
      const manifest = folderManifest(dependencies.folder);
      if ("error" in manifest) return report(output, manifest);
      const slug = manifest.slug;
      const transport = store!.apiStore(remote, dependencies.fetcher);
      if (command === "restart") return store!.restartCommand(slug, transport, output);
      if (!hasStore(manifest)) return report(output, store!.storelessRefusal(manifest));
      return store!.runStore(asked!, slug, transport, {
        output,
        json: arguments_.includes("--json"),
        terminal: dependencies.terminal ?? (() => process.stdin.isTTY === true),
        stdin: dependencies.stdinBytes ?? standardInput,
        secretPrompt: dependencies.secretPrompt ?? promptWithoutEcho,
      });
    }
    default:
      return logs(remote, dependencies, arguments_.includes("--follow"), Number(lines));
  }
}
