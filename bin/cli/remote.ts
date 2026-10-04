/**
 * The CLI without root SSH: a team member, or an agent in a sandbox, deploys
 * with a personal token over HTTPS, through the dashboard's control API.
 *
 *   sitesolide login --url https://dashboard.example.com
 *   sitesolide deploy      build here, upload, follow the machine's log
 *   sitesolide status      the projects this token may deploy
 *   sitesolide logs [--follow]
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
 * address is in config.json, under `api`, or in `SITESOLIDE_API`.
 *
 * **The token only ever goes to that address.** The archive is sent to
 * `<api>/api/v1/deployments/<id>/bundle`, built here, and never to an address
 * an answer names: a compromised or mistaken answer would otherwise receive
 * the bearer.
 *
 * The build stays on the workstation, as over SSH: the archive carries its
 * result, the code minus its exclusions in `app/`, and the public files in
 * `public/`. The machine installs dependencies itself, as the project's account.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bundle, excludedBy, type BundleEntry } from "./bundle";
import { configPath, defaultPaths, expandHome, readConfigFile } from "./config";
import { isApp, missingExclusions, readManifest, type Manifest } from "./manifest";

/** Where the token is kept in the vault. */
export const TOKEN_FILE = "team-token";

/** The limits the dashboard applies, checked here first so that a refusal comes before the upload. */
export const LIMITS = { bundleBytes: 100 * 1024 * 1024, extractedBytes: 512 * 1024 * 1024, entries: 20_000 };

export type Remote = { api: string; token: string };

type Environment = Record<string, string | undefined>;

/** The raw configuration file, the `api` key included, which `Config` does not carry. */
function rawConfig(home: string): Record<string, unknown> {
  const path = configPath(home);
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
  const file = readConfigFile(home);
  return expandHome(environment.SITESOLIDE_VAULT ?? file.vault ?? defaultPaths(home).vault, home);
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
  const file = rawConfig(home);
  const server = environment.SITESOLIDE_SERVER ?? (typeof file.server === "string" ? file.server : "");
  if (server !== "") return false;
  const api = environment.SITESOLIDE_API ?? (typeof file.api === "string" ? file.api : "");
  return api !== "";
}

/** The address and the token, or what is missing, said with the command that fixes it. */
export function readRemote(environment: Environment, home = homedir()): Remote | { missing: string } {
  const file = rawConfig(home);
  const raw = environment.SITESOLIDE_API ?? (typeof file.api === "string" ? file.api : "");
  const api = raw === "" ? null : apiOrigin(raw);
  if (api === null) {
    return { missing: raw === "" ? "no dashboard address: run sitesolide login --url https://dashboard.<zone>" : `not an https address: ${raw}` };
  }
  let token = environment.SITESOLIDE_TOKEN ?? "";
  if (token === "") {
    const path = tokenPath(environment, home);
    if (!existsSync(path)) return { missing: `no token in ${path}: run sitesolide login, or set SITESOLIDE_TOKEN` };
    token = readFileSync(path, "utf8").trim();
  }
  if (!/^sst_[A-Za-z0-9_-]{43}$/.test(token)) return { missing: "the token does not have the shape sst_...: ask the owner of the machine for a new one" };
  return { api, token };
}

// --- talking to the API ------------------------------------------------------------

export type Failure = { error: string; message: string; details?: string[]; wait?: number };
export type Answer<T> = { ok: true; status: number; body: T } | { ok: false; status: number; failure: Failure };

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One call: the bearer, JSON back, every failure said in the API's own words. */
export async function call<T>(remote: Remote, path: string, init: RequestInit = {}, fetcher: Fetch = fetch): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetcher(`${remote.api}${path}`, {
      ...init,
      redirect: "error",
      headers: { Authorization: `Bearer ${remote.token}`, ...(init.headers ?? {}) },
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

export type Output = { say: (line: string) => void; fail: (line: string) => void };

const console_: Output = { say: (line) => console.log(line), fail: (line) => console.error(line) };

function report(output: Output, failure: Failure): number {
  output.fail(`!! ${failure.message}`);
  for (const detail of failure.details ?? []) output.fail(`   ${detail}`);
  if (failure.wait !== undefined) output.fail(`   wait ${failure.wait} s`);
  return 1;
}

// --- the project, read for the API ------------------------------------------------

export type RemoteProject = { folder: string; code: string; manifest: Manifest; raw: string };

/**
 * The manifest as the API will judge it: `validate()` of the CLI, except that
 * a missing port is not an error, the machine choosing one. Missing ports are
 * filled with stand-ins for the check alone; the text sent is the file's.
 */
export function checkManifest(raw: string): { manifest?: Manifest; errors: string[] } {
  let object: unknown;
  try {
    object = JSON.parse(raw);
  } catch (error) {
    return { errors: [`sitesolide.json is unreadable: ${(error as Error).message}`] };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return { errors: ["sitesolide.json must contain an object"] };
  const filled: Record<string, unknown> = { ...(object as Record<string, unknown>) };
  if (typeof filled.services === "object" && filled.services !== null && !Array.isArray(filled.services)) {
    const services: Record<string, unknown> = {};
    let next = 3000;
    for (const [name, service] of Object.entries(filled.services as Record<string, unknown>)) {
      const standIn = typeof service === "object" && service !== null && !Array.isArray(service) && !("port" in service);
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
 * exclusions, `.git`, the manifest and the public files; the public files into
 * `public/`.
 */
export function projectEntries(project: RemoteProject): { entries: BundleEntry[]; refused: string[] } {
  const { manifest } = project;
  const entries: BundleEntry[] = [];
  const refused: string[] = [];
  if (isApp(manifest)) {
    const patterns = [...(manifest.exclude ?? []), ".git", "sitesolide.json", ...(manifest.publicDir === undefined ? [] : [manifest.publicDir])];
    const app = collect(project.code, "app", patterns);
    entries.push(...app.entries);
    refused.push(...app.refused);
  }
  if (manifest.publicDir !== undefined) {
    const files = collect(join(project.code, manifest.publicDir), "public", []);
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

type Identity = { id: string; label: string; email: string; expiresAt: number | null; scope: { slugs: string[]; create: boolean; outbound: boolean; domain: boolean; public: boolean }; owned: string[] };

/** The token held, said in one line: who, and what it may do. */
export function describeIdentity(identity: Identity): string[] {
  const may = [
    identity.scope.create ? "create projects" : null,
    identity.scope.public ? "deploy public sites" : "deploy private sites only",
    identity.scope.outbound ? "use network: outbound" : null,
    identity.scope.domain ? "declare a domain" : null,
  ].filter((part): part is string => part !== null);
  const projects = [...new Set([...identity.owned, ...identity.scope.slugs])].sort();
  return [
    `   ${identity.email} (${identity.label}), token ${identity.id}`,
    `   may ${may.join(", ")}`,
    `   projects: ${projects.length === 0 ? "none yet" : projects.join(", ")}`,
    ...(identity.expiresAt === null ? [] : [`   expires ${new Date(identity.expiresAt).toISOString().slice(0, 10)}`]),
  ];
}

export async function login(arguments_: string[], dependencies: Omit<RemoteDependencies, "build" | "checkPublic" | "folder">): Promise<number> {
  const output = dependencies.output ?? console_;
  const home = dependencies.home ?? homedir();
  const environment = dependencies.environment;
  const value = (name: string) => {
    const marker = arguments_.indexOf(`--${name}`);
    return marker === -1 ? undefined : arguments_[marker + 1];
  };
  const raw = value("url") ?? environment.SITESOLIDE_API ?? (dependencies.prompt ?? prompt)("Dashboard address, https://dashboard.<zone>:") ?? "";
  const api = apiOrigin(raw);
  if (api === null) return report(output, { error: "invalid", message: `not an https address: ${raw || "nothing given"}` });

  let token = environment.SITESOLIDE_TOKEN ?? "";
  if (arguments_.includes("--token-stdin")) token = (await (dependencies.stdin ?? (() => Bun.stdin.text()))()).trim();
  if (token === "") token = ((dependencies.prompt ?? prompt)("Token, sst_..., as the owner of the machine gave it:") ?? "").trim();
  if (!/^sst_[A-Za-z0-9_-]{43}$/.test(token)) return report(output, { error: "invalid", message: "this is not a sitesolide token: it starts with sst_ and is 47 characters long" });

  const remote = { api, token };
  const answer = await call<{ identity: Identity }>(remote, "/api/v1/whoami", {}, dependencies.fetcher);
  if (!answer.ok) return report(output, answer.failure);

  const vault = vaultFolder(environment, home);
  mkdirSync(vault, { recursive: true, mode: 0o700 });
  const path = join(vault, TOKEN_FILE);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const file = rawConfig(home);
  mkdirSync(join(home, ".config", "sitesolide"), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify({ ...file, api }, null, 2)}\n`);

  output.say(`-> signed in to ${api}`);
  for (const line of describeIdentity(answer.body.identity)) output.say(line);
  output.say(`   token kept in ${path}, address in ${configPath(home)}`);
  if (typeof file.server === "string" && file.server !== "") output.say("   this workstation also has a server: commands use SSH unless given --api");
  return 0;
}

async function deploy(remote: Remote, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? console_;
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
      return 0;
    }
    if (view.state === "failed" || view.state === "expired") {
      if (view.error !== null && !view.log.some((line) => line.includes(view.error!.message))) output.fail(`!! ${view.error.message}`);
      return 1;
    }
    await pause();
  }
}

type ProjectStatus = {
  slug: string;
  access: string;
  deployed: boolean;
  type: string | null;
  url: string | null;
  portal: { wanted: boolean; installed: boolean } | null;
  services: { name: string | null; state: string; subState: string; port: number | null }[];
};

async function status(remote: Remote, dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? console_;
  const who = await call<{ identity: Identity }>(remote, "/api/v1/whoami", {}, dependencies.fetcher);
  if (!who.ok) return report(output, who.failure);
  output.say(`=== ${remote.api}`);
  for (const line of describeIdentity(who.body.identity)) output.say(line);
  const answer = await call<{ projects: ProjectStatus[] }>(remote, "/api/v1/projects", {}, dependencies.fetcher);
  if (!answer.ok) return report(output, answer.failure);
  output.say("");
  output.say(`${"PROJECT".padEnd(22)} ${"ACCESS".padEnd(8)} ${"TYPE".padEnd(7)} ${"SERVICE".padEnd(10)} ${"DOOR".padEnd(8)} ADDRESS`);
  for (const project of answer.body.projects) {
    const service = project.services.length === 0 ? "-" : project.services.every((entry) => entry.state === "active") ? "active" : project.services.map((entry) => entry.state).join(",");
    const door = project.portal === null ? "-" : project.portal.installed ? "portal" : "public";
    output.say(`${project.slug.padEnd(22)} ${project.access.padEnd(8)} ${(project.type ?? (project.deployed ? "?" : "-")).padEnd(7)} ${service.padEnd(10)} ${door.padEnd(8)} ${project.url ?? "not deployed"}`);
  }
  return 0;
}

async function logs(remote: Remote, dependencies: RemoteDependencies, follow: boolean): Promise<number> {
  const output = dependencies.output ?? console_;
  const path = join(dependencies.folder, "sitesolide.json");
  if (!existsSync(path)) return report(output, { error: "invalid", message: `sitesolide.json not found in ${dependencies.folder}: run this from the project's folder` });
  const { manifest } = checkManifest(readFileSync(path, "utf8"));
  if (manifest === undefined) return report(output, { error: "invalid", message: "sitesolide.json rejected" });
  let cursor: string | null = null;
  const pause = dependencies.pause ?? (() => Bun.sleep(2000));
  for (;;) {
    const parameters: Record<string, string> = cursor === null ? { lines: "50" } : { lines: "500", cursor };
    const query = new URLSearchParams(parameters);
    const answer: Answer<{ lines: string[]; cursor: string | null }> = await call(remote, `/api/v1/projects/${encodeURIComponent(manifest.slug)}/logs?${query}`, {}, dependencies.fetcher);
    if (!answer.ok) return report(output, answer.failure);
    for (const line of answer.body.lines) output.say(line);
    cursor = answer.body.cursor;
    if (!follow) return 0;
    await pause();
  }
}

/** What a command that needs the machine's root says through the API. */
export function needsSsh(command: string): string[] {
  return [
    `!! sitesolide ${command} needs the owner's SSH access to the machine`,
    "   with a team token, this workstation runs: deploy, status, logs, login",
    "   ask the owner of the machine, who runs it from a workstation configured with sitesolide init",
  ];
}

/** The commands only the owner's SSH access carries. */
export const SSH_COMMANDS = ["lock", "unlock", "domain", "remove", "run", "secrets"];

export const REMOTE_USAGE = [
  "usage, with a team token:",
  "  sitesolide login --url <https://dashboard.zone>   keep the token, check it",
  "     --token-stdin                                  read it from standard input",
  "  sitesolide deploy                                 build here, upload, follow the machine's log",
  "  sitesolide status                                 the projects this token may deploy",
  "  sitesolide logs [--follow]                        the journal of this folder's project",
  "",
  "SITESOLIDE_API and SITESOLIDE_TOKEN in the environment win over the files.",
];

/** Runs a command through the API; the exit code is returned, never thrown. */
export async function runRemote(command: string, arguments_: string[], dependencies: RemoteDependencies): Promise<number> {
  const output = dependencies.output ?? console_;
  const remote = readRemote(dependencies.environment, dependencies.home ?? homedir());
  if (SSH_COMMANDS.includes(command)) {
    for (const line of needsSsh(command)) output.fail(line);
    return 1;
  }
  if (!["deploy", "status", "logs"].includes(command)) {
    for (const line of REMOTE_USAGE) output.fail(line);
    return 1;
  }
  if ("missing" in remote) return report(output, { error: "unauthenticated", message: remote.missing });
  switch (command) {
    case "deploy":
      return deploy(remote, dependencies);
    case "status":
      return status(remote, dependencies);
    default:
      return logs(remote, dependencies, arguments_.includes("--follow"));
  }
}
