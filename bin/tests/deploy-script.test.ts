import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { projectEntries, readRemoteProject } from "../cli/remote";
import { createTarReader } from "../../dashboard/src/installer/tar";

/**
 * deploy.sh, the script that deploys with a token and no CLI, held to the CLI
 * it stands in for: on the same folder, its archive must carry exactly what
 * `projectEntries` puts in the CLI's, read back by the installer's own
 * reader, the one the machine runs. Then its calls, against a control API
 * served locally by Bun.serve.
 *
 * It runs under a PATH that holds the tools its header names and nothing
 * else, once for each JSON reader this machine has: a reader it would need
 * and does not say shows up here, not on a colleague's laptop.
 */

const SCRIPT = resolve(import.meta.dir, "..", "..", "deploy.sh");
const WORK = mkdtempSync(join(tmpdir(), "deploy-script-"));
const TOKEN = `sst_${"A".repeat(43)}`;
/** The installer's limits, MAX_* in dashboard/src/control/protocol.ts. */
const LIMITS = { maxBytes: 512 * 1024 * 1024, maxEntries: 20_000, maxPathBytes: 1024 };
const DATE = new Date("2026-09-01T12:00:00Z");

/** The tools of the script's header, and those every system carries, found on this machine. */
const TOOLS = ["bash", "sh", "env", "curl", "tar", "gzip", "find", "mktemp", "ls", "cp", "mv", "rm", "mkdir", "dirname", "cat", "wc", "tr", "sed", "head", "xargs", "grep", "sleep"];
const READERS = ["jq", "node", "bun", "python3"].filter((reader) => (reader === "bun" ? true : Bun.which(reader) !== null));

/** A folder on a PATH of its own: the base tools, plus `reader`. */
function toolbox(reader: string): string {
  const folder = join(WORK, `path-${reader}`);
  mkdirSync(folder, { recursive: true });
  for (const tool of [...TOOLS, reader]) {
    const found = tool === "bun" ? process.execPath : Bun.which(tool);
    if (found === null) throw new Error(`${tool} is not on this machine`);
    symlinkSync(found, join(folder, tool));
  }
  return folder;
}

type Tree = Record<string, string | { content: string; executable: true } | null>;

/** Writes a tree: a string is a file, null an empty folder. Every date is DATE. */
function write(root: string, tree: Tree): void {
  for (const [path, value] of Object.entries(tree)) {
    const target = join(root, path);
    if (value === null) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : value.content);
    if (typeof value !== "string") chmodSync(target, 0o755);
    utimesSync(target, DATE, DATE);
  }
}

let counter = 0;
/** A project in a repository of its own: a `.git` marks it, as a clone. */
function project(manifest: Record<string, unknown>, tree: Tree): string {
  const folder = join(WORK, `project-${counter++}`);
  write(folder, { ".git/HEAD": "ref: refs/heads/main\n", ...tree });
  writeFileSync(join(folder, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return folder;
}

type Seen = { directories: string[]; files: Record<string, { executable: boolean; mtime: number; content: string }> };

/** The archive as the machine reads it: the installer's reader, every rule it enforces. */
function read(gzipped: Uint8Array<ArrayBuffer>): Seen {
  const seen: Seen = { directories: [], files: {} };
  let current = "";
  const chunks: Uint8Array[] = [];
  const reader = createTarReader(
    {
      directory: (path) => seen.directories.push(path),
      file: (path, executable, mtime) => {
        current = path;
        chunks.length = 0;
        seen.files[path] = { executable, mtime, content: "" };
      },
      data: (bytes) => chunks.push(bytes.slice()),
      end: () => {
        seen.files[current]!.content = Buffer.concat(chunks).toString("utf8");
      },
    },
    LIMITS,
  );
  reader.push(Bun.gunzipSync(gzipped));
  reader.end();
  seen.directories.sort();
  return seen;
}

/** What the CLI's archive carries for the same folder. */
function cli(folder: string): Seen {
  const project = readRemoteProject(folder);
  if ("errors" in project) throw new Error(project.errors.join("; "));
  const { entries, refused } = projectEntries(project);
  expect(refused).toEqual([]);
  const seen: Seen = { directories: [], files: {} };
  for (const entry of entries) {
    if (entry.kind === "directory") seen.directories.push(entry.path);
    else seen.files[entry.path] = { executable: entry.executable, mtime: entry.mtime, content: new TextDecoder().decode(entry.content) };
  }
  seen.directories.sort();
  return seen;
}

type Run = { code: number; stdout: string; stderr: string };

async function run(folder: string, args: string[], options: { reader?: string; env?: Record<string, string>; shell?: string } = {}): Promise<Run> {
  const reader = options.reader ?? READERS[0]!;
  const proc = Bun.spawn([options.shell ?? "bash", SCRIPT, ...args, folder], {
    cwd: WORK,
    env: { PATH: toolboxes.get(reader)!, HOME: WORK, TMPDIR: WORK, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function archive(folder: string, reader?: string): Promise<{ run: Run; seen: Seen | null }> {
  const out = join(WORK, `archive-${counter++}.tar.gz`);
  const result = await run(folder, ["--archive", out], { reader });
  return { run: result, seen: result.code === 0 ? read(new Uint8Array(readFileSync(out))) : null };
}

const toolboxes = new Map<string, string>();

beforeAll(() => {
  for (const reader of READERS) toolboxes.set(reader, toolbox(reader));
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

/** An app with a publicDir, and every kind of pattern rsync reads. */
function parityProject(): string {
  const folder = project(
    {
      slug: "parity",
      start: "/usr/local/bin/bun run server.ts",
      port: 3050,
      publicDir: "web",
      exclude: ["node_modules", "/data", "cache/tmp", "logs/**", "build/", "*.bak", "tmp?", "[ab].txt", "[!c].md"],
    },
    {
      "server.ts": "Bun.serve({})",
      "run.sh": { content: "#!/bin/sh\n", executable: true },
      "README.md": "kept: not one character",
      "a.md": "excluded by [!c].md",
      "c.md": "kept: [!c] refuses c",
      "a.txt": "excluded by [ab].txt",
      "c.txt": "kept",
      "node_modules/x/index.js": "excluded",
      "src/node_modules/y.js": "excluded: a name matches at any depth",
      "data/db.sqlite": "excluded: anchored",
      "src/data/keep.ts": "kept: /data is the root's alone",
      "cache/tmp/x": "excluded: the end of the path",
      "src/cache/tmp/y": "excluded: the end of the path, deeper",
      "cache/keep": "kept",
      "logs/2026/a.log": "excluded by logs/**",
      "build/out.js": "excluded: a directory",
      "src/build": "kept: build/ wants a directory",
      "notes.bak": "excluded",
      "src/old.bak": "excluded",
      "tmp1/x": "excluded by tmp?",
      "tmp12": "kept: tmp? is one character",
      ".env": "SECRET=1",
      ".env.local": "SECRET=2",
      "config/.env.production": "SECRET=3",
      "config/app.json": "{}",
      "vendor/lib/.git/HEAD": "never sent",
      "vendor/lib/index.js": "kept",
      "nested/sitesolide.json": "{}",
      "src/web/component.ts": "excluded: publicDir is a pattern of the app's tree",
      "web/index.html": "<h1>hi</h1>",
      "web/.env": "SECRET=4",
      "web/.git/config": "never sent",
      "web/sub/page.html": "page",
      "web/run.cgi": { content: "#!/bin/sh\n", executable: true },
      "with space é.txt": "kept",
      "-dash.txt": "kept: never read as an option",
      "weird[1].txt": "kept",
      ".hidden": "kept",
      "empty": null,
      [`deep/${"segment/".repeat(12)}file.txt`]: "a path over 100 bytes",
      [`long/${"segment-name/".repeat(25)}file.txt`]: "a path over 255 bytes, which ustar cannot hold",
      [`${"n".repeat(120)}.txt`]: "a name over 100 bytes",
      "linked-a.txt": "one file, two names",
    },
  );
  linkSync(join(folder, "linked-a.txt"), join(folder, "linked-b.txt"));
  // Links the patterns exclude are never read, so never refused.
  symlinkSync("../x/index.js", join(folder, "node_modules", "x", "alias.js"));
  symlinkSync("/etc/hosts", join(folder, "data", "hosts"));
  return folder;
}

describe("the archive, beside the CLI's", () => {
  for (const reader of READERS) {
    test(`an app with a publicDir and every kind of pattern, read with ${reader}`, async () => {
      const folder = parityProject();
      const { run: result, seen } = await archive(folder, reader);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(seen).toEqual(cli(folder));
      expect(Object.keys(seen!.files)).toContain(`app/long/${"segment-name/".repeat(25)}file.txt`);
      expect(Object.keys(seen!.files)).toContain(`app/${"n".repeat(120)}.txt`);
      expect(Object.keys(seen!.files)).toContain("app/with space é.txt");
      expect(seen!.files["app/linked-b.txt"]?.content).toBe("one file, two names");
      expect(seen!.files["app/run.sh"]?.executable).toBe(true);
      expect(seen!.files["app/server.ts"]?.mtime).toBe(DATE.getTime() / 1000);
    }, 30_000);
  }

  test("a static site sends public/ alone", async () => {
    const folder = project({ slug: "static", publicDir: "public" }, { "public/index.html": "<h1>static</h1>", "public/.env": "SECRET=1", "notes.txt": "not sent" });
    const { seen } = await archive(folder);
    expect(seen).toEqual(cli(folder));
    expect(Object.keys(seen!.files)).toEqual(["public/index.html"]);
  }, 30_000);

  test("a `start` that is not a string makes no app: public/ alone, as the CLI sends it", async () => {
    const folder = project({ slug: "odd", start: true, publicDir: "pub" }, { "pub/index.html": "<h1>odd</h1>", "notes.txt": "not sent" });
    const { seen } = await archive(folder);
    expect(seen).toEqual(cli(folder));
    expect(Object.keys(seen!.files)).toEqual(["public/index.html"]);
  }, 30_000);

  test("started by sh, it runs itself again with bash", async () => {
    const folder = project({ slug: "by-sh", publicDir: "public" }, { "public/index.html": "<h1>sh</h1>" });
    const out = join(WORK, "by-sh.tar.gz");
    const result = await run(folder, ["--archive", out], { shell: "sh" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(Object.keys(read(new Uint8Array(readFileSync(out))).files)).toEqual(["public/index.html"]);
  }, 30_000);

  test("services read from `source`, a folder of the same repository", async () => {
    const folder = project(
      {
        slug: "workers",
        source: "code",
        services: { worker: { start: "/usr/local/bin/bun run worker.ts", internal: true }, web: { start: "/usr/local/bin/bun run web.ts", port: 3051 } },
      },
      { "code/worker.ts": "for (;;) {}", "code/web.ts": "Bun.serve({})", "elsewhere.txt": "not sent" },
    );
    const { seen } = await archive(folder);
    expect(seen).toEqual(cli(folder));
    expect(Object.keys(seen!.files).sort()).toEqual(["app/web.ts", "app/worker.ts"]);
  }, 30_000);

  test("the build runs in the code's folder, without the token in its environment", async () => {
    const folder = project(
      { slug: "built", publicDir: "dist", build: 'mkdir -p dist && printf "%s" "${SITESOLIDE_TOKEN:-absent}" > dist/token.txt' },
      {},
    );
    const out = join(WORK, "built.tar.gz");
    const result = await run(folder, ["--archive", out], { env: { SITESOLIDE_TOKEN: TOKEN } });
    expect(result.code).toBe(0);
    expect(read(new Uint8Array(readFileSync(out))).files["public/token.txt"]?.content).toBe("absent");
  }, 30_000);
});

describe("what it refuses before anything leaves", () => {
  test("a folder of dependencies present and not excluded, as the CLI does", async () => {
    const folder = project({ slug: "deps", start: "/usr/local/bin/bun run server.ts", port: 3052 }, { "server.ts": "", "node_modules/x/index.js": "" });
    const result = await run(folder, ["--archive", join(WORK, "never.tar.gz")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('add "exclude": ["node_modules"] to the manifest');
    expect(readRemoteProject(folder)).toEqual({ errors: expect.arrayContaining([expect.stringContaining("node_modules present on disk and not excluded")]) });
  }, 30_000);

  test("a symbolic link it would send, named", async () => {
    const folder = project({ slug: "linked", publicDir: "public" }, { "public/index.html": "" });
    symlinkSync("/etc/hosts", join(folder, "public", "hosts"));
    const result = await run(folder, ["--archive", join(WORK, "never.tar.gz")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("public/hosts is a symbolic link");
  }, 30_000);

  test("a publicDir that leads out of the repository", async () => {
    const outside = join(WORK, `outside-${counter++}`);
    write(outside, { "id_ed25519": "a key" });
    const folder = project({ slug: "escape", publicDir: "public" }, {});
    symlinkSync(outside, join(folder, "public"));
    const result = await run(folder, ["--archive", join(WORK, "never.tar.gz")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("publicDir leads outside the repository holding sitesolide.json");
  }, 30_000);

  test("an empty publicDir", async () => {
    const folder = project({ slug: "empty", publicDir: "public" }, { public: null });
    const result = await run(folder, ["--archive", join(WORK, "never.tar.gz")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("publicDir is empty");
  }, 30_000);
});

describe("against the control API", () => {
  type Seen = { method: string; path: string; authorization: string | null; type: string | null; body: Uint8Array<ArrayBuffer> };
  let requests: Seen[] = [];
  /** What the next requests get, set by each test. */
  let answer: (request: Seen) => Response = () => new Response("unset", { status: 500 });
  let server: ReturnType<typeof Bun.serve>;
  let api = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const url = new URL(request.url);
        const seen = {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get("authorization"),
          type: request.headers.get("content-type"),
          body: new Uint8Array(await request.arrayBuffer()),
        };
        requests.push(seen);
        return answer(seen);
      },
    });
    api = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  const deployment = (state: string, log: string[], next: number, extra: Record<string, unknown> = {}) =>
    Response.json({ deployment: { id: "d1", slug: "app", state, log, next, error: null, url: "https://app.test-zone.invalid/", allocated: [], ...extra } });

  function app(): string {
    return project({ slug: "app", start: "/usr/local/bin/bun run server.ts", exclude: ["node_modules"] }, { "server.ts": "Bun.serve({})" });
  }

  test("a deployment: the manifest as written, the archive, the log to the end", async () => {
    requests = [];
    let polls = 0;
    answer = (request) => {
      if (request.method === "POST") return Response.json({ deployment: { id: "d1", state: "awaiting-bundle", creating: true } }, { status: 201 });
      if (request.method === "PUT") return deployment("running", [], 0);
      polls++;
      return polls === 1
        ? deployment("running", ["-> the machine", "   extracted"], 2)
        : deployment("succeeded", ["-> deployed: https://app.test-zone.invalid/"], 3, { allocated: [{ service: null, port: 3007 }] });
    };
    const folder = app();
    const result = await run(folder, [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("deployment d1, a new project");
    expect(result.stdout).toContain("   extracted\n-> deployed: https://app.test-zone.invalid/");
    expect(result.stdout).toContain("the machine chose port 3007");
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/v1/deployments",
      "PUT /api/v1/deployments/d1/bundle",
      "GET /api/v1/deployments/d1?after=0",
      "GET /api/v1/deployments/d1?after=2",
    ]);
    expect(requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const [created, uploaded] = requests;
    expect(created!.type).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(created!.body))).toEqual({ manifest: readFileSync(join(folder, "sitesolide.json"), "utf8") });
    expect(uploaded!.type).toBe("application/gzip");
    expect(read(uploaded!.body)).toEqual(cli(folder));
  }, 30_000);

  for (const reader of READERS) {
    test(`a deployment where the machine chose no port, its log read with ${reader}`, async () => {
      let polls = 0;
      answer = (request) => {
        if (request.method === "POST") return Response.json({ deployment: { id: "d1", state: "awaiting-bundle", creating: false } }, { status: 201 });
        if (request.method === "PUT") return deployment("running", [], 0);
        polls++;
        return polls === 1 ? deployment("running", [], 0) : deployment("succeeded", ["-> deployed: https://app.test-zone.invalid/"], 1);
      };
      const result = await run(app(), [], { reader, env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toEndWith("-> upload\n-> deployed: https://app.test-zone.invalid/\n");
    }, 30_000);
  }

  test("an empty answer, or an id that is not one, ends the run", async () => {
    requests = [];
    answer = () => new Response("", { status: 201 });
    const empty = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain(`${api} answered 201 with something that is not the control API`);
    // curl would read brackets as a range, and send three requests.
    answer = () => Response.json({ deployment: { id: "d[1-3]", state: "awaiting-bundle" } }, { status: 201 });
    const globbed = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(globbed.code).toBe(1);
    expect(globbed.stderr).toContain("without a deployment");
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST"]);
  }, 30_000);

  test("a refused manifest: every reason, and nothing built or sent", async () => {
    requests = [];
    answer = () => Response.json({ error: "invalid-manifest", message: "your token may not deploy this manifest", details: ["domain: your token may not declare a domain"] }, { status: 422 });
    const result = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("your token may not deploy this manifest (invalid-manifest, 422)");
    expect(result.stderr).toContain("   domain: your token may not declare a domain");
    expect(requests).toHaveLength(1);
  }, 30_000);

  test("a deployment that fails on the machine names its step", async () => {
    answer = (request) =>
      request.method === "POST"
        ? Response.json({ deployment: { id: "d1", state: "awaiting-bundle", creating: false } }, { status: 201 })
        : request.method === "PUT"
          ? deployment("running", [], 0)
          : deployment("failed", ["-> service, 10 s after the restart"], 1, { error: { code: "service-failed", message: "the service fell after its restart: read its logs" } });
    const result = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("-> service, 10 s after the restart");
    expect(result.stderr).toContain("the service fell after its restart: read its logs (service-failed)");
  }, 30_000);

  test("an answer that is not the control API's", async () => {
    answer = () => new Response("<html>Bad gateway</html>", { status: 502 });
    const result = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${api} answered 502 with something that is not the control API`);
  }, 30_000);

  test("no request without a token of the right shape, or to an address in clear", async () => {
    requests = [];
    const malformed = await run(app(), [], { env: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: "sst_short" } });
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toContain("SITESOLIDE_TOKEN is not a sitesolide token");
    const missing = await run(app(), [], { env: { SITESOLIDE_TOKEN: TOKEN } });
    expect(missing.stderr).toContain("SITESOLIDE_API is not set");
    const clear = await run(app(), [], { env: { SITESOLIDE_API: "http://dashboard.test-zone.invalid", SITESOLIDE_TOKEN: TOKEN } });
    expect(clear.code).toBe(1);
    expect(clear.stderr).toContain("SITESOLIDE_API must be the dashboard's address alone");
    expect(requests).toEqual([]);
  }, 30_000);
});
