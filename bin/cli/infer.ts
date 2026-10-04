/**
 * The manifest a folder implies, for a project that has no sitesolide.json
 * yet: `sitesolide detect`, and `deploy` in such a folder.
 *
 * Writing a manifest is the one step between a folder and a deployed site, and
 * the one an agent that just wrote the code gets wrong most easily: a `start`
 * that is not absolute, a `node_modules` not excluded, a port already taken.
 * The folder says most of it. This module reads what it says, and nothing it
 * does not:
 *
 * - **a secret is never guessed.** Code that reads `STRIPE_SECRET_KEY` gets a
 *   note saying where secrets go, the dashboard, and the line to add to
 *   declare one; no value, no file name chosen on its behalf;
 * - **the network is never opened silently.** `network: outbound` gives a
 *   service the internet; the code that obviously calls out gets a note
 *   naming the line, and the decision stays with whoever reads it;
 * - **the port is left out.** Only the machine knows which one is free, and
 *   `deploy` picks it there, see bin/cli/ports.ts;
 * - **a `.env` never leaves.** Excluded from the upload, with a note.
 *
 * What it recognises, first match wins: a Go module, a FastAPI or Flask app,
 * a package.json (an app run by Bun, the runtime the machine carries, or a
 * site a generator builds), then a folder of files under public/, dist/,
 * build/, _site/ or out/. An index.html at the root of the folder is
 * recognised and refused: serving the root would serve .git with it.
 *
 * Every manifest returned passes validate(), an app's once deploy has given it
 * its port: bin/tests/cli-infer.test.ts holds it to that on every fixture.
 *
 * Reads the folder, writes nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSystemName, isValidSlug, KNOWN_KEYS, RESERVED_ENV, SERVICE_PORTS, SUSPICIOUS_ENV, validate, type Manifest } from "./manifest";
import { needsPort } from "./ports";
import { projectPaths } from "./unit";

/** Where the machine carries its runtimes: Bun for JavaScript, uv for Python's virtualenvs. */
export const BUN = "/usr/local/bin/bun";
export const UV = "/usr/local/bin/uv";

/** The folders a static site's files are found in, in the order they are looked for. */
export const STATIC_FOLDERS = ["public", "dist", "build", "_site", "out"];

export type ProjectKind = "static" | "static-build" | "bun" | "node" | "python" | "go";

export type Inference =
  | { kind: ProjectKind; manifest: Manifest; reasons: string[]; notes: string[] }
  /** Nothing to deploy recognised, or something recognised that cannot be concluded. */
  | { kind: "none"; reasons: string[]; notes: string[] };

/**
 * The slug a folder's name gives: lowercase, accents dropped, every other run
 * of characters a dash, 63 characters at most. Null when nothing usable is
 * left, or a name validate() reserves: `landing`, and the names of the
 * machine's own services, a folder called `caddy` included.
 */
export function slugFromFolder(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return isValidSlug(slug) && slug !== "landing" && !isSystemName(slug) ? slug : null;
}

/**
 * The manifest as text, its keys in the order KNOWN_KEYS lists them, the order
 * the documentation follows: the file is meant to be read, then committed.
 */
export function renderManifest(manifest: Manifest): string {
  const fields = manifest as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    if (fields[key] !== undefined) ordered[key] = fields[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// --- the folder --------------------------------------------------------------

/** Folders never read when looking through the code: dependencies, builds, caches. */
const SKIPPED = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "_site",
  "vendor",
  "coverage",
  "target",
  "tests",
  "test",
]);

/**
 * Enough to read a real project's own code, not enough to wander a monorepo,
 * nor a home directory `detect` was run in by mistake.
 */
const SCAN_LIMITS = { files: 400, folders: 2000, depth: 5, bytes: 512 * 1024 };

/** What the detectors share: the folder, read lazily, once. */
class Folder {
  readonly entries: Set<string>;
  private readonly sources = new Map<string, string[]>();

  constructor(readonly path: string, readonly slug: string) {
    this.entries = new Set(readdirSync(path));
  }

  /** A file's text, or null when it is missing, a folder, or too big to be source. */
  text(name: string): string | null {
    const full = join(this.path, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > SCAN_LIMITS.bytes) return null;
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }

  isFolder(name: string): boolean {
    try {
      return statSync(join(this.path, name)).isDirectory();
    } catch {
      return false;
    }
  }

  /** The source files with one of these extensions, relative paths, shallowest first. */
  code(extensions: string[]): string[] {
    const key = extensions.join(",");
    const cached = this.sources.get(key);
    if (cached !== undefined) return cached;
    const found: string[] = [];
    let level = [this.path];
    let visited = 0;
    for (let depth = 0; depth < SCAN_LIMITS.depth && level.length > 0 && found.length < SCAN_LIMITS.files; depth++) {
      const next: string[] = [];
      for (const folder of level) {
        if (++visited > SCAN_LIMITS.folders) break;
        let names: string[];
        try {
          names = readdirSync(folder).sort();
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.startsWith(".") || SKIPPED.has(name)) continue;
          const full = join(folder, name);
          let stat;
          try {
            stat = statSync(full);
          } catch {
            continue;
          }
          if (stat.isDirectory()) next.push(full);
          else if (extensions.some((extension) => name.endsWith(extension)) && found.length < SCAN_LIMITS.files) {
            found.push(relative(this.path, full));
          }
        }
      }
      level = next;
    }
    this.sources.set(key, found);
    return found;
  }

  /** The `.env` files at the root, which hold secrets by convention. */
  envFiles(): string[] {
    return [...this.entries].filter((name) => /^\.env($|\.)/.test(name)).sort();
  }
}

// --- reading the code --------------------------------------------------------

/** What the code says about itself: the variables it reads and the calls it makes out. */
type CodeReading = { variables: Set<string>; outbound: string[] };

const ENV_READS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Z_][A-Z0-9_]*)["'`]\s*\]/g,
  /Bun\.env\.([A-Z_][A-Z0-9_]*)/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
];

/** Libraries whose only use is to talk to another machine. */
const CALLING_LIBRARIES =
  "axios|node-fetch|got|undici|openai|@anthropic-ai/sdk|stripe|resend|nodemailer|@sendgrid/mail|twilio|postmark|googleapis|@google/genai|@supabase/supabase-js|@aws-sdk/[\\w-]+";

/** A line that obviously reaches the network: a URL fetched, a calling library imported. */
const OUTBOUND: RegExp[] = [
  /\bfetch\(\s*["'`]https?:\/\//,
  new RegExp(`\\bfrom\\s+["'](?:${CALLING_LIBRARIES})["']`),
  new RegExp(`\\brequire\\(\\s*["'](?:${CALLING_LIBRARIES})["']\\s*\\)`),
  /^\s*(?:import|from)\s+(?:requests|httpx|aiohttp|openai|anthropic|stripe|boto3|smtplib|resend|sendgrid|twilio|urllib\.request)\b/,
  /\bhttp\.(?:Get|Post|PostForm|NewRequest|NewRequestWithContext)\(|"net\/smtp"/,
];

function readCode(folder: Folder, files: string[]): CodeReading {
  const variables = new Set<string>();
  const outbound: string[] = [];
  for (const file of files) {
    const text = folder.text(file);
    if (text === null) continue;
    for (const pattern of ENV_READS) {
      for (const match of text.matchAll(pattern)) variables.add(match[1]!);
    }
    if (outbound.length >= 3) continue;
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (OUTBOUND.some((pattern) => pattern.test(line))) {
        outbound.push(`${file}:${index + 1}`);
        if (outbound.length >= 3) break;
      }
    }
  }
  return { variables, outbound };
}

/** Variables that tend to carry a password even without a telling suffix. */
const CREDENTIAL_URLS = /^(DATABASE_URL|REDIS_URL|MONGODB_URI|MONGO_URL|AMQP_URL|[A-Z0-9_]*_DSN)$/;

/** Read by every app, set by the platform or by the runtime: nothing to say about them. */
const ORDINARY_VARIABLES = new Set([...RESERVED_ENV, "NODE_ENV", "HOME", "PATH", "TZ", "LANG", "DEBUG"]);

/**
 * The notes every app gets: what the code reads, what it calls, the port. The
 * wording names the exact line to add, never a value.
 */
function appNotes(reading: CodeReading, slug: string, expectsPort: boolean): string[] {
  const notes: string[] = [];
  if (reading.outbound.length > 0) {
    notes.push(
      `the code seems to reach the network (${reading.outbound.join(", ")}): a service only reaches the loopback by default, DNS included; add "network": "outbound" if it does`,
    );
  }
  const names = [...reading.variables].filter((name) => !ORDINARY_VARIABLES.has(name)).sort();
  const secrets = names.filter((name) => SUSPICIOUS_ENV.test(name) || CREDENTIAL_URLS.test(name));
  const others = names.filter((name) => !secrets.includes(name));
  if (secrets.length > 0) {
    notes.push(
      `the code reads ${secrets.join(", ")}: secrets live on the server, never in the repository; declare "secrets": ["${slug}.env"] and set their values in the dashboard's Secrets section`,
    );
  }
  if (others.length > 0) {
    notes.push(`the code also reads ${others.join(", ")}: set the ones that are not secret under "env"`);
  }
  if (expectsPort && !reading.variables.has("PORT")) {
    notes.push("the code does not seem to read PORT: the service must listen on 127.0.0.1, on the port the PORT variable carries");
  }
  notes.push('no "port": deploy picks a free one on the server and writes it into sitesolide.json');
  return notes;
}

// --- package.json ------------------------------------------------------------

type PackageJson = {
  description?: unknown;
  main?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The package manager the lockfile names, for the build that runs on the workstation. */
function packageManager(folder: Folder): "bun" | "npm" | "yarn" | "pnpm" {
  if (folder.entries.has("bun.lock") || folder.entries.has("bun.lockb")) return "bun";
  if (folder.entries.has("pnpm-lock.yaml")) return "pnpm";
  if (folder.entries.has("yarn.lock")) return "yarn";
  if (folder.entries.has("package-lock.json")) return "npm";
  return "bun";
}

function runScript(manager: string, script: string): string {
  return manager === "bun" || manager === "npm" ? `${manager} run ${script}` : `${manager} ${script}`;
}

/** The build of a package.json, when it has one: the workstation runs it before each deploy. */
function packageBuild(folder: Folder): string | null {
  const raw = folder.text("package.json");
  if (raw === null) return null;
  try {
    const scripts = record((JSON.parse(raw) as PackageJson).scripts);
    return typeof scripts.build === "string" ? runScript(packageManager(folder), "build") : null;
  } catch {
    return null;
  }
}

/**
 * The generators whose output is a folder of files, by the dependency that
 * names them, the narrower first: SvelteKit's static adapter before Vite,
 * which it runs on.
 */
const GENERATORS: ReadonlyArray<{ dependency: string; name: string; output: string }> = [
  { dependency: "@sveltejs/adapter-static", name: "SvelteKit, static adapter", output: "build" },
  { dependency: "astro", name: "Astro", output: "dist" },
  { dependency: "@11ty/eleventy", name: "Eleventy", output: "_site" },
  { dependency: "gatsby", name: "Gatsby", output: "public" },
  { dependency: "@docusaurus/core", name: "Docusaurus", output: "build" },
  { dependency: "react-scripts", name: "Create React App", output: "build" },
  { dependency: "vite", name: "Vite", output: "dist" },
  { dependency: "parcel", name: "Parcel", output: "dist" },
];

/** The dependencies that make a generator a server: their output runs, it is not served. */
const SERVER_ADAPTERS = ["@astrojs/node", "@sveltejs/adapter-node", "@sveltejs/kit", "@remix-run/node", "@react-router/node"];

/** A start script that runs a development server, or a static one, rather than the app. */
const DEVELOPMENT_SERVER =
  /^\s*(?:astro\s+(?:dev|preview)|vite(?:\s+(?:dev|serve|preview))?(?:\s|$)|next\s+dev|nuxt\s+dev|gatsby\s+(?:develop|serve)|react-scripts\s+start|docusaurus\s+(?:start|serve)|(?:npx\s+)?(?:@11ty\/)?eleventy\s+--serve|webpack(?:-dev-server|\s+serve)|parcel(?!\s+build)|serve(?:\s|$)|http-server(?:\s|$))/;

/** A file that starts a server: Bun's, Node's, or a framework's `listen`. */
const LISTENS = /\bBun\.serve\s*\(|\.listen\s*\(|\bcreateServer\s*\(|\bserve\s*\(\s*\{|export\s+default\s*\{[\s\S]{0,2000}?\bfetch\s*[(:]/;

/** Where a server's entry usually lives, looked for when no start script names it. */
const ENTRY_FILES = [
  "server.ts",
  "server.js",
  "server.mjs",
  "src/server.ts",
  "src/server.js",
  "index.ts",
  "index.js",
  "index.mjs",
  "src/index.ts",
  "src/index.js",
  "app.ts",
  "app.js",
  "main.ts",
  "main.js",
  "src/main.ts",
];

/** `node server.js`, `bun run src/index.ts`, `tsx watch server.ts`: the file a start script runs. */
const RUNS_A_FILE = /^\s*(?:node|bun(?:\s+run)?|tsx(?:\s+watch)?|ts-node|nodemon)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./@-]+\.(?:[cm]?[jt]s|[jt]sx))\s*$/;

/** The server's entry file, and how it was found; null for none. */
function serverEntry(folder: Folder, start: string | null, main: unknown, hasBuild: boolean): { path: string; reason: string } | null {
  const named = start === null ? null : RUNS_A_FILE.exec(start)?.[1];
  // A start script that runs a file names the server, even one the build has
  // not produced yet: `node dist/server.js` after a TypeScript build.
  if (named !== undefined && named !== null && (existsSync(join(folder.path, named)) || hasBuild)) {
    return { path: named.replace(/^\.\//, ""), reason: `the start script runs ${named}` };
  }
  const candidates = [...(typeof main === "string" ? [main.replace(/^\.\//, "")] : []), ...ENTRY_FILES];
  for (const candidate of candidates) {
    const text = folder.text(candidate);
    if (text !== null && LISTENS.test(text)) return { path: candidate, reason: `${candidate} starts a server` };
  }
  return null;
}

/** The first static folder that holds an index.html, or null. */
function builtFolder(folder: Folder): string | null {
  return STATIC_FOLDERS.find((name) => existsSync(join(folder.path, name, "index.html"))) ?? null;
}

// --- the detectors -----------------------------------------------------------

/**
 * A detector's answer: a manifest, a refusal that names what it saw, or null
 * for a folder that is none of its business.
 */
type Detection = Inference | null;

function declined(...reasons: string[]): Inference {
  return { kind: "none", reasons, notes: [] };
}

/** Files and secrets that stay on the workstation, added to an app's exclusions. */
function exclusions(folder: Folder, always: string[]): { exclude: string[]; notes: string[] } {
  const exclude = [...always];
  const notes: string[] = [];
  const env = folder.envFiles();
  if (env.length > 0) {
    exclude.push(".env*");
    notes.push(
      `${env.join(", ")} ${env.length === 1 ? "stays" : "stay"} on this workstation: on the server, secrets are set in the dashboard's Secrets section`,
    );
  }
  return { exclude, notes };
}

function detectGo(folder: Folder): Detection {
  if (!folder.entries.has("go.mod")) return null;
  const isMain = (text: string | null): boolean => text !== null && /^package main\b/m.test(text);
  let target: string | null = null;
  if ([...folder.entries].some((name) => name.endsWith(".go") && isMain(folder.text(name)))) {
    target = ".";
  } else if (folder.isFolder("cmd")) {
    const commands = readdirSync(join(folder.path, "cmd"))
      .filter((name) => folder.isFolder(join("cmd", name)))
      .filter((name) => readdirSync(join(folder.path, "cmd", name)).some((file) => file.endsWith(".go") && isMain(folder.text(join("cmd", name, file)))));
    const chosen = commands.length === 1 ? commands[0] : commands.find((name) => name === folder.slug);
    if (chosen !== undefined) target = `./cmd/${chosen}`;
  }
  if (target === null) {
    return declined("go.mod, but no package main at the root nor a single one under cmd/: write build and start by hand (docs/manifest.md)");
  }

  const slug = folder.slug;
  const compile = `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ${slug} ${target}`;
  const assets = packageBuild(folder);
  const { exclude, notes } = exclusions(folder, folder.entries.has("package.json") ? ["node_modules"] : []);
  return {
    kind: "go",
    manifest: {
      slug,
      ...(folder.isFolder("public") ? { publicDir: "public" } : {}),
      build: assets === null ? compile : `${assets} && ${compile}`,
      start: `${projectPaths(slug).app}/${slug}`,
      ...(exclude.length > 0 ? { exclude } : {}),
    },
    reasons: ["go.mod", target === "." ? "package main at the root" : `package main in ${target}`],
    notes: [
      ...notes,
      "the binary is built on this workstation for linux/amd64: set GOARCH=arm64 in build for an ARM server",
      `the build writes the binary ${slug} into the folder: add it to .gitignore`,
      ...appNotes(readCode(folder, folder.code([".go"])), slug, true),
    ],
  };
}

function detectPython(folder: Folder): Detection {
  const pyproject = folder.text("pyproject.toml");
  const requirements = folder.text("requirements.txt");
  if (pyproject === null && requirements === null) return null;
  const declared = `${pyproject ?? ""}\n${requirements ?? ""}`;
  const depends = (name: string): boolean => new RegExp(`(^|[\\s"'\\[,])${name}($|[\\s"'\\]<>=~!;,\\[])`, "im").test(declared);
  const source = pyproject !== null ? "pyproject.toml" : "requirements.txt";

  const framework = depends("fastapi") ? "FastAPI" : depends("flask") ? "Flask" : null;
  if (framework === null) {
    return declined(`${source} without FastAPI or Flask, the two Python frameworks inferred: write start by hand (docs/manifest.md)`);
  }

  // The object the server imports: `app = FastAPI(...)`, typed or not.
  const assignment = new RegExp(`^(\\w+)\\s*(?::[^=\\n]+)?=\\s*${framework}\\(`, "m");
  let found: { file: string; variable: string } | null = null;
  for (const file of folder.code([".py"])) {
    const variable = assignment.exec(folder.text(file) ?? "")?.[1];
    if (variable !== undefined) {
      found = { file, variable };
      break;
    }
  }
  if (found === null) {
    return declined(`${framework} in ${source}, but no \`app = ${framework}(...)\` in the code: write start by hand (docs/manifest.md)`);
  }

  const slug = folder.slug;
  const python = `${projectPaths(slug).app}/.venv/bin/python`;
  // A src/ layout imports from src/, which the server is told rather than
  // the module renamed.
  const underSrc = found.file.startsWith("src/");
  const module = (underSrc ? found.file.slice("src/".length) : found.file).replace(/\.py$/, "").split("/").join(".");
  const target = `${module}:${found.variable}`;
  const notes: string[] = [];

  // `${PORT}` is systemd's: ExecStart expands it from the unit's own
  // Environment=PORT, which deploy writes, so the start line never carries a
  // number that could drift from the port chosen.
  let start: string;
  if (framework === "FastAPI") {
    start = `${python} -m uvicorn ${target} --host 127.0.0.1 --port \${PORT}${underSrc ? " --app-dir src" : ""}`;
    if (!depends("uvicorn")) notes.push(`uvicorn is not in ${source}: add it, start runs it`);
  } else if (depends("gunicorn")) {
    start = `${python} -m gunicorn --bind 127.0.0.1:\${PORT}${underSrc ? " --chdir src" : ""} ${target}`;
  } else {
    start = `${python} -m flask --app ${target} run --host 127.0.0.1 --port \${PORT}`;
    notes.push("start runs Flask's development server: add gunicorn to the dependencies and run detect again for a production one");
  }

  const uv = `${UV} sync${folder.entries.has("uv.lock") ? " --frozen" : ""} --no-dev --compile-bytecode --python-preference only-system`;
  const install =
    pyproject !== null
      ? uv
      : `${UV} venv --allow-existing --python-preference only-system .venv && ${UV} pip install --python .venv/bin/python -r requirements.txt`;
  const caches = ["venv", ".pytest_cache", ".mypy_cache", ".ruff_cache"].filter((name) => folder.entries.has(name));
  const { exclude, notes: kept } = exclusions(folder, [".venv", "__pycache__", ...caches, ...(folder.entries.has("package.json") ? ["node_modules"] : [])]);
  const build = packageBuild(folder);
  return {
    kind: "python",
    manifest: {
      slug,
      ...(folder.isFolder("public") ? { publicDir: "public" } : {}),
      ...(build === null ? {} : { build }),
      install,
      start,
      exclude,
    },
    reasons: [`${framework} in ${source}`, `${target} in ${found.file}`],
    notes: [
      ...kept,
      ...notes,
      `install builds the virtualenv on the server with ${UV} and the server's own Python`,
      ...appNotes(readCode(folder, folder.code([".py"])), slug, false),
    ],
  };
}

/**
 * An app run by the machine's Bun: from the file that starts the server when
 * one is known, through the start script otherwise.
 */
function javascriptApp(
  folder: Folder,
  found: {
    entry: { path: string; reason: string } | null;
    start: string | null;
    manager: string;
    build: string | null;
    install: boolean;
    servesPublic: boolean;
  },
): Inference {
  const { entry, start } = found;
  const code = entry === null ? "" : (folder.text(entry.path) ?? "");
  const runtime = found.manager === "bun" || /^\s*bun\b/.test(start ?? "") || /\bBun\./.test(code) ? "bun" : "node";
  const { exclude, notes } = exclusions(folder, ["node_modules"]);
  return {
    kind: runtime,
    manifest: {
      slug: folder.slug,
      ...(found.servesPublic && folder.isFolder("public") ? { publicDir: "public" } : {}),
      ...(found.build === null ? {} : { build: found.build }),
      ...(found.install ? { install: `${BUN} install --production` } : {}),
      start: entry !== null ? `${BUN} run ${entry.path}` : `${BUN} --bun run start`,
      env: { NODE_ENV: "production" },
      exclude,
    },
    reasons: [...(folder.entries.has("package.json") ? ["package.json"] : []), entry !== null ? entry.reason : `the start script: ${start}`],
    notes: [
      ...notes,
      ...(runtime === "node" ? ["it runs under Bun, the runtime the server carries, which runs most Node servers as they are"] : []),
      ...(found.install ? ["the dependencies are installed on the server, by bun install --production"] : []),
      ...appNotes(readCode(folder, folder.code([".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"])), folder.slug, true),
    ],
  };
}

function detectJavaScript(folder: Folder): Detection {
  const raw = folder.text("package.json");
  if (raw === null) {
    // A server file alone, the shape an agent writes first: Bun runs it as it
    // is, with nothing to install.
    const entry = serverEntry(folder, null, undefined, false);
    if (entry === null) return null;
    return javascriptApp(folder, { entry, start: null, manager: "bun", build: null, install: false, servesPublic: true });
  }
  let pkg: PackageJson;
  try {
    pkg = record(JSON.parse(raw)) as PackageJson;
  } catch (error) {
    return declined(`package.json does not parse: ${(error as Error).message}`);
  }
  const scripts = record(pkg.scripts);
  const dependencies = record(pkg.dependencies);
  const all = { ...record(pkg.devDependencies), ...dependencies };
  const manager = packageManager(folder);
  const start = typeof scripts.start === "string" ? scripts.start : null;
  const hasBuild = typeof scripts.build === "string";
  const slug = folder.slug;

  // Next.js serves itself, unless it exports a folder of files.
  const nextConfig = ["next.config.js", "next.config.mjs", "next.config.ts"].map((name) => folder.text(name)).find((text) => text !== null);
  const exported = "next" in all && nextConfig !== undefined && /output\s*:\s*["']export["']/.test(nextConfig ?? "");
  const generator = exported
    ? { name: "Next.js, static export", output: "out" }
    : SERVER_ADAPTERS.some((adapter) => adapter in all)
      ? undefined
      : GENERATORS.find(({ dependency }) => dependency in all);

  const entry = serverEntry(folder, start, pkg.main, hasBuild);
  const startsApp = start !== null && !DEVELOPMENT_SERVER.test(start) && !(generator !== undefined && entry === null);

  if (entry !== null || startsApp) {
    return javascriptApp(folder, {
      entry,
      start,
      manager,
      build: hasBuild ? runScript(manager, "build") : null,
      install: Object.keys(dependencies).length > 0,
      servesPublic: generator === undefined,
    });
  }

  if (hasBuild) {
    const existing = builtFolder(folder);
    const output = generator?.output ?? existing ?? "dist";
    return {
      kind: "static-build",
      manifest: { slug, publicDir: output, build: runScript(manager, "build") },
      reasons: [
        "package.json with a build script",
        generator === undefined ? "no server, the site is a folder of files" : `${generator.name} builds into ${output}/`,
      ],
      notes: [
        "the build runs on this workstation before every deploy, with its node_modules",
        ...(generator === undefined && existing === null ? [`publicDir is a guess: check that the build writes the site into ${output}/`] : []),
      ],
    };
  }

  if (builtFolder(folder) !== null) return null;
  return declined("package.json with neither a start script, a server file nor a build script: nothing to run nor to build");
}

function detectStatic(folder: Folder): Detection {
  const found = builtFolder(folder);
  if (found !== null) {
    return {
      kind: "static",
      manifest: { slug: folder.slug, publicDir: found },
      reasons: [`index.html in ${found}/`],
      notes: [`only ${found}/ is sent, and served as it is: nothing runs on the server`],
    };
  }
  if (folder.entries.has("index.html")) {
    return declined(
      "index.html sits at the root of the folder: serving the root would serve .git, sitesolide.json and every other file with it",
      "move the site into public/ (index.html and its assets), then run detect again",
    );
  }
  return null;
}

/** The project's description, from package.json or pyproject.toml, when it holds on one short line. */
function description(folder: Folder): string | undefined {
  let found: unknown;
  try {
    found = (JSON.parse(folder.text("package.json") ?? "{}") as PackageJson).description;
  } catch {
    found = undefined;
  }
  if (typeof found !== "string" || found === "") {
    found = /^description\s*=\s*"([^"\n]*)"/m.exec(folder.text("pyproject.toml") ?? "")?.[1];
  }
  return typeof found === "string" && found.length > 0 && found.length <= 200 && !/[\r\n]/.test(found) ? found : undefined;
}

/**
 * The manifest `folder` implies, under `slug`. A refusal, `kind: "none"`, says
 * what was seen and what to do about it.
 */
export function inferManifest(folder: string, slug: string): Inference {
  const view = new Folder(folder, slug);
  const refusals: string[] = [];
  for (const detector of [detectGo, detectPython, detectJavaScript, detectStatic]) {
    const detection = detector(view);
    if (detection === null) continue;
    if (detection.kind === "none") {
      refusals.push(...detection.reasons);
      continue;
    }
    const about = description(view);
    const manifest: Manifest = about === undefined ? detection.manifest : { ...detection.manifest, description: about };
    // Never hand back a manifest deploy would refuse. An app is checked with
    // the port deploy will give it, the one key left to the machine.
    const errors = validate(needsPort(manifest) ? { ...manifest, port: SERVICE_PORTS.last } : manifest, "");
    if (errors.length > 0) return { kind: "none", reasons: [`the manifest inferred does not validate: ${errors.join("; ")}`], notes: [] };
    return { ...detection, manifest };
  }
  if (refusals.length > 0) return { kind: "none", reasons: refusals, notes: [] };
  return {
    kind: "none",
    reasons: ["no go.mod, pyproject.toml, requirements.txt, package.json, nor an index.html under public/, dist/, build/, _site/ or out/"],
    notes: [],
  };
}
