import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiOrigin, checkManifest, projectEntries, readRemote, readRemoteProject, remoteMode, TOKEN_FILE } from "../cli/remote";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI } from "./e2e/run";

/**
 * The CLI's remote mode, the way a team member or an agent runs it: the real
 * bin/sitesolide.ts in a child process, a temporary HOME, and a local fake of
 * the dashboard's control API on a random port. The fake machine's `ssh` and
 * `rsync` come first on PATH, as for every CLI test: they refuse and log, and
 * the tests check that nothing reached them.
 */

const TOKEN = `sst_${"T".repeat(43)}`;
const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  toClean.push(path);
  return path;
}

// --- the fake API ---------------------------------------------------------------------

type Received = { method: string; path: string; authorization: string | null; body: string | Uint8Array | null };
const received: Received[] = [];
let scenario: "succeeds" | "fails" | "refuses" = "succeeds";
let server: ReturnType<typeof Bun.serve>;
let api: string;
let vm: FakeVm;

const identity = { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: { slugs: [], create: true, outbound: false, domain: false, public: false }, owned: ["shop"] };
const LOG = ["-> manifest, validated on the machine", "   port 3002 chosen for the service", "-> verify", "   https://shop.test-zone.invalid/ 401, behind the portal"];

beforeAll(() => {
  vm = createFakeVm();
  let reads = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PUT" ? new Uint8Array(await req.arrayBuffer()) : req.method === "POST" ? await req.text() : null;
      received.push({ method: req.method, path: `${url.pathname}${url.search}`, authorization: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 });
      if (url.pathname === "/api/v1/whoami") return Response.json({ identity });
      if (url.pathname === "/api/v1/deployments" && req.method === "POST") {
        if (scenario === "refuses") {
          return Response.json({ error: "invalid-manifest", message: "your token may not deploy this manifest: fix every point in details", details: ['network: your token may not deploy "network": "outbound"'] }, { status: 422 });
        }
        reads = 0;
        return Response.json({ deployment: { id: "0123456789abcdef01234567", slug: "shop", state: "awaiting-bundle", creating: true, log: [], next: 0, error: null, url: null, allocated: [], uploadUrl: "https://elsewhere.invalid/steal" } }, { status: 201 });
      }
      if (url.pathname.endsWith("/bundle")) return Response.json({ deployment: { state: "running" } }, { status: 202 });
      if (url.pathname.startsWith("/api/v1/deployments/")) {
        reads++;
        const after = Number(url.searchParams.get("after") ?? "0");
        const done = reads >= 2;
        const log = (done ? LOG : LOG.slice(0, 2)).slice(after);
        const failed = scenario === "fails" && done;
        return Response.json({
          deployment: {
            id: "0123456789abcdef01234567",
            slug: "shop",
            state: done ? (failed ? "failed" : "succeeded") : "running",
            log: failed ? [] : log,
            next: after + (failed ? 0 : log.length),
            error: failed ? { code: "install-failed", message: "bun install --production failed (exit 1): nothing served was changed" } : null,
            url: done && !failed ? "https://shop.test-zone.invalid/" : null,
            allocated: done && !failed ? [{ service: null, port: 3002 }] : [],
          },
        });
      }
      if (url.pathname === "/api/v1/projects") {
        return Response.json({ projects: [{ slug: "shop", access: "owned", deployed: true, type: "app", url: "https://shop.test-zone.invalid/", portal: { wanted: true, installed: true }, services: [{ name: null, state: "active", subState: "running", port: 3002 }] }] });
      }
      if (url.pathname === "/api/v1/projects/shop/logs") return Response.json({ lines: ["2026-10-04T10:00:00+0000 vm shop[1]: listening on 3002"], cursor: "s=1" });
      return Response.json({ error: "not-found", message: "no such route" }, { status: 404 });
    },
  });
  api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  vm.cleanup();
});

/** The CLI with nothing of the owner's environment: no server, no zone, a HOME of its own. */
async function cli(cwd: string, arguments_: string[], env: Record<string, string>, stdin?: string) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
  const proc = Bun.spawn(["bun", CLI, ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    env: { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, ...env },
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error, all: `${output}${error}` };
}

function project(manifest: object, files: Record<string, string> = {}): string {
  const root = folder("remote-project-");
  writeFileSync(join(root, "sitesolide.json"), JSON.stringify(manifest, null, 2));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const APP = { slug: "shop", start: "/usr/local/bin/bun run server.ts", publicDir: "public", build: "echo built > public/built.txt", exclude: ["node_modules"] };
const APP_FILES = { "server.ts": "Bun.serve({})", "public/index.html": "<h1>shop</h1>", "node_modules/left/index.js": "never sent" };

describe("deploy through the API", () => {
  test("manifest first, build here, upload, the machine's log followed to the end", async () => {
    scenario = "succeeds";
    received.length = 0;
    const root = project(APP, APP_FILES);
    const home = folder("remote-home-");
    const result = await cli(root, ["deploy"], { HOME: home, SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    for (const line of [`-> project shop, through ${api}`, "-> archive", "-> upload", ...LOG, "   the machine chose port 3002: write it in sitesolide.json to keep it explicit"]) {
      expect(result.output).toContain(line);
    }
    // Each log line once, though it was read in two goes.
    expect(result.output.split("-> manifest, validated on the machine").length).toBe(2);

    const posted = received.find((entry) => entry.method === "POST")!;
    expect(JSON.parse(posted.body as string).manifest).toBe(readFileSync(join(root, "sitesolide.json"), "utf8"));
    const put = received.find((entry) => entry.method === "PUT")!;
    // The archive went to the configured address, never to the uploadUrl the answer named.
    expect(put.path).toBe("/api/v1/deployments/0123456789abcdef01234567/bundle");
    const archive = Bun.gunzipSync(put.body as Uint8Array<ArrayBuffer>);
    const listing = new TextDecoder().decode(archive);
    expect(listing).toContain("app/server.ts");
    expect(listing).toContain("public/built.txt");
    expect(listing).not.toContain("node_modules");
    expect(listing).not.toContain("sitesolide.json");
    expect(received.every((entry) => entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(vm.logs().filter((line) => line.startsWith("CONNECT") || line.includes("rsync"))).toEqual([]);
  });

  test("a deployment that fails: its reason, and a non-zero exit", async () => {
    scenario = "fails";
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["deploy"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.error).toContain("!! bun install --production failed (exit 1): nothing served was changed");
  });

  test("a manifest refused: every reason, before the build runs", async () => {
    scenario = "refuses";
    const root = project({ ...APP, build: "touch build-ran" }, APP_FILES);
    const result = await cli(root, ["deploy"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.error).toContain("!! your token may not deploy this manifest");
    expect(result.error).toContain('   network: your token may not deploy "network": "outbound"');
    expect(() => statSync(join(root, "build-ran"))).toThrow();
  });

  test("a link in the code is named, and nothing is uploaded", async () => {
    scenario = "succeeds";
    received.length = 0;
    const root = project({ ...APP, build: undefined }, APP_FILES);
    Bun.spawnSync(["ln", "-s", "/etc/hosts", join(root, "hosts")]);
    const result = await cli(root, ["deploy"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.error).toContain("app/hosts is a symbolic link");
    expect(received.some((entry) => entry.method === "PUT")).toBe(false);
  });

  test("a wrong token: the API's message, as it stands", async () => {
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["deploy"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: `sst_${"W".repeat(43)}` });
    expect(result.code).toBe(1);
    expect(result.error).toContain("!! missing or unknown token");
  });
});

describe("login, status, logs", () => {
  test("login checks the token, keeps it 0600 in the vault, and the address beside the owner's keys", async () => {
    const home = folder("remote-home-");
    mkdirSync(join(home, ".config", "sitesolide"), { recursive: true });
    writeFileSync(join(home, ".config", "sitesolide", "config.json"), JSON.stringify({ contact: "ops@test-zone.invalid" }));
    const result = await cli(home, ["login", "--url", `${api}/anything`, "--token-stdin"], { HOME: home }, `${TOKEN}\n`);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`-> signed in to ${api}`);
    expect(result.output).toContain("ada@test-zone.invalid (Ada), token aaaaaaaaaaaa");
    const tokenFile = join(home, ".config", "sitesolide", "secrets", TOKEN_FILE);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, ".config", "sitesolide", "config.json"), "utf8"))).toEqual({ contact: "ops@test-zone.invalid", api });

    // From then on, with nothing in the environment, the commands go through the API.
    const status = await cli(home, ["status"], { HOME: home });
    expect(status.code).toBe(0);
    expect(status.output).toContain("shop");
    expect(status.output).toContain("portal");
  });

  test("login refuses a token of the wrong shape and an address that is not https", async () => {
    const home = folder("remote-home-");
    expect((await cli(home, ["login", "--url", api, "--token-stdin"], { HOME: home }, "hunter2\n")).error).toContain("not a sitesolide token");
    expect((await cli(home, ["login", "--url", "http://dashboard.test-zone.invalid", "--token-stdin"], { HOME: home }, `${TOKEN}\n`)).error).toContain("not an https address");
  });

  test("logs of this folder's project", async () => {
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["logs"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    expect(result.output).toContain("vm shop[1]: listening on 3002");
  });

  test("what needs the owner's SSH says so, and the owner's workstation keeps SSH unless --api", async () => {
    const root = project(APP, APP_FILES);
    const env = { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN };
    const removal = await cli(root, ["remove", "--confirm", "shop"], env);
    expect(removal.code).toBe(1);
    expect(removal.error).toContain("sitesolide remove needs the owner's SSH access");
    const usage = await cli(root, [], env);
    expect(usage.error).toContain("usage, with a team token:");
    // With a server, --api still goes through the API.
    const forced = await cli(root, ["status", "--api"], { ...env, SITESOLIDE_SERVER: vm.env.SITESOLIDE_SERVER!, SITESOLIDE_ZONE: "test-zone.invalid", SITESOLIDE_EMAIL: "ops@test-zone.invalid" });
    expect(forced.output).toContain("shop");
  });
});

describe("the pure parts", () => {
  test("the dashboard's address: an https origin, or http on the loopback", () => {
    expect(apiOrigin("https://dashboard.test-zone.invalid/api/v1")).toBe("https://dashboard.test-zone.invalid");
    expect(apiOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(apiOrigin("http://dashboard.test-zone.invalid")).toBeNull();
    expect(apiOrigin("https://user:pass@dashboard.test-zone.invalid")).toBeNull();
    expect(apiOrigin("dashboard")).toBeNull();
  });

  test("the mode: a server means SSH, an address without a server means the API, --api forces it", () => {
    const home = folder("remote-home-");
    expect(remoteMode([], {}, home)).toBe(false);
    expect(remoteMode([], { SITESOLIDE_API: api }, home)).toBe(true);
    expect(remoteMode([], { SITESOLIDE_API: api, SITESOLIDE_SERVER: "deploy@vm.test-zone.invalid" }, home)).toBe(false);
    expect(remoteMode(["--api"], { SITESOLIDE_SERVER: "deploy@vm.test-zone.invalid" }, home)).toBe(true);
  });

  test("what is missing is said with the command that fixes it", () => {
    const home = folder("remote-home-");
    expect(readRemote({}, home)).toEqual({ missing: "no dashboard address: run sitesolide login --url https://dashboard.<zone>" });
    expect(readRemote({ SITESOLIDE_API: api }, home)).toMatchObject({ missing: expect.stringContaining("run sitesolide login") });
    expect(readRemote({ SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN }, home)).toEqual({ api, token: TOKEN });
  });

  test("a manifest without a port passes here: the machine chooses it", () => {
    expect(checkManifest(JSON.stringify({ slug: "shop", start: "x", publicDir: "public" })).errors).toEqual([]);
    expect(checkManifest(JSON.stringify({ slug: "shop", publicDir: "p", services: { web: { start: "x" }, api: { start: "y", routes: ["/api/*"] } } })).errors).toEqual([]);
    expect(checkManifest(JSON.stringify({ slug: "Shop", start: "x" })).errors.length).toBeGreaterThan(0);
  });

  test("what leaves: the code minus its exclusions into app/, the public files into public/", () => {
    const root = project(APP, { ...APP_FILES, ".git/HEAD": "ref", "src/public/nested.txt": "rsync leaves this out too" });
    const read = readRemoteProject(root);
    if ("errors" in read) throw new Error(read.errors.join(", "));
    const paths = projectEntries(read).entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(["app", "app/server.ts", "app/src", "public", "public/index.html"]);
  });
});
