import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiOrigin, checkManifest, describeIdentity, projectEntries, readRemote, readRemoteProject, remoteMode, TOKEN_FILE } from "../cli/remote";
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

/** Every line of standard output, each of which must be an event, the last one ending the run. */
function events(output: string): Record<string, unknown>[] {
  const list = output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(list.filter((event) => event.type === "result" || event.type === "error")).toHaveLength(1);
  expect(["result", "error"]).toContain(list.at(-1)!.type as string);
  return list;
}

describe("what a token's run refuses, and --json", () => {
  test("deploy --dry-run is refused before anything is sent: it used to deploy for real", async () => {
    scenario = "succeeds";
    received.length = 0;
    const root = project({ ...APP, build: "touch build-ran" }, APP_FILES);
    const env = { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN };
    const human = await cli(root, ["deploy", "--dry-run"], env);
    expect(human.code).toBe(1);
    expect(human.error).toContain("!! deploy --dry-run is not available with a team token: nothing was sent");
    const json = await cli(root, ["deploy", "--dry-run", "--json"], env);
    expect(json.code).toBe(1);
    const error = events(json.output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: "deploy --dry-run is not available with a team token: nothing was sent" });
    expect(error.hint).toContain("without --dry-run once they agree");
    expect(received).toEqual([]);
    expect(() => statSync(join(root, "build-ran"))).toThrow();
  });

  test("an option the token's path does not carry is refused, never passed over", async () => {
    received.length = 0;
    const root = project(APP, APP_FILES);
    const env = { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN };
    for (const arguments_ of [["deploy", "--yes"], ["deploy", "--force"], ["status", "--follow"], ["logs", "--lines", "9000"]]) {
      const result = await cli(root, [...arguments_, "--json"], env);
      expect({ arguments_, code: result.code }).toEqual({ arguments_, code: 1 });
      expect(events(result.output).at(-1)!.type).toBe("error");
    }
    expect(received).toEqual([]);
  });

  test("deploy --json: the steps and the machine's log as events, and a result carrying the address", async () => {
    scenario = "succeeds";
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["deploy", "--json"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(0);
    const list = events(result.output);
    expect(list).toContainEqual({ type: "step", message: "manifest, validated on the machine" });
    expect(list.at(-1)).toMatchObject({ type: "result", command: "deploy", slug: "shop", kind: "service", dryRun: false, port: 3002, portChosen: "free", url: "https://shop.test-zone.invalid/" });
  });

  test("a deployment that fails ends with one error, whose hint follows its code", async () => {
    scenario = "fails";
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["deploy", "--json"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    const error = events(result.output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: "bun install --production failed (exit 1): nothing served was changed" });
    expect(error.hint).toContain("run the install command");
  });

  test("status and logs hand over data; a wrong token is an error with what to do", async () => {
    const root = project(APP, APP_FILES);
    const env = { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN };
    const status = events((await cli(root, ["status", "--json"], env)).output).at(-1)!;
    expect(status).toMatchObject({ type: "result", command: "status", projects: [{ slug: "shop", access: "owned" }] });
    const logs = events((await cli(root, ["logs", "--json", "--lines", "20"], env)).output);
    expect(logs).toContainEqual({ type: "log", at: null, unit: null, priority: null, message: "2026-10-04T10:00:00+0000 vm shop[1]: listening on 3002" });
    expect(logs.at(-1)).toMatchObject({ type: "result", command: "logs", slug: "shop", entries: 1 });
    expect(received.at(-1)!.path).toBe("/api/v1/projects/shop/logs?lines=20");
    const wrong = events((await cli(root, ["status", "--json"], { ...env, SITESOLIDE_TOKEN: `sst_${"W".repeat(43)}` })).output).at(-1)!;
    expect(wrong).toMatchObject({ type: "error", message: "missing or unknown token" });
    expect(wrong.hint).toContain("ask the owner of the machine");
  });

  test("login --json never prompts: without the token on its standard input, an error, and nothing written", async () => {
    const home = folder("remote-home-");
    const refused = await cli(home, ["login", "--url", api, "--json"], { HOME: home });
    expect(refused.code).toBe(1);
    expect(events(refused.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("not a sitesolide token") });
    const signed = await cli(home, ["login", "--url", api, "--token-stdin", "--json"], { HOME: home }, `${TOKEN}\n`);
    expect(signed.code).toBe(0);
    const result = events(signed.output).at(-1)!;
    expect(result).toMatchObject({ type: "result", command: "login", api, identity: { email: "ada@test-zone.invalid" } });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("the MCP server, with a team token", () => {
  /** `sitesolide mcp`, its tools running the CLI through the fake API. */
  async function callTool(cwd: string, name: string, args: object): Promise<Record<string, any>> {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
    const proc = Bun.spawn(["bun", CLI, "mcp"], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
    proc.stdin.flush();
    const reader = proc.stdout.getReader();
    let text = "";
    for (;;) {
      const answer = text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, any>)
        .find((message) => message.id === 2);
      if (answer !== undefined) {
        proc.stdin.end();
        await proc.exited;
        return answer;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`the server ended without answering: ${text}`);
      text += new TextDecoder().decode(value);
    }
  }

  test("deploy with dry_run is a tool error carrying the refusal and its hint, and the live site is not touched", async () => {
    scenario = "succeeds";
    received.length = 0;
    const root = project(APP, APP_FILES);
    const answer = await callTool(root, "deploy", { folder: root, dry_run: true });
    expect(answer.result.isError).toBe(true);
    expect(answer.result.structuredContent.error.message).toBe("deploy --dry-run is not available with a team token: nothing was sent");
    expect(answer.result.structuredContent.error.hint).toContain("without --dry-run");
    expect(received).toEqual([]);
  });

  test("a real deploy returns the result and the address, as over SSH", async () => {
    scenario = "succeeds";
    const root = project(APP, APP_FILES);
    const answer = await callTool(root, "deploy", { folder: root });
    expect(answer.result.isError).toBe(false);
    expect(answer.result.structuredContent.result).toMatchObject({ command: "deploy", slug: "shop", url: "https://shop.test-zone.invalid/" });
    const logs = await callTool(root, "logs", { folder: root, lines: 20 });
    expect(logs.result.structuredContent.result).toMatchObject({ command: "logs", entries: 1 });
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

  test("neither tree carries .git nor a .env, at any depth, whatever the manifest says", () => {
    const root = project(APP, {
      ...APP_FILES,
      ".env": "SECRET=1",
      "config/.env.production": "SECRET=2",
      "config/settings.json": "{}",
      "public/.git/config": "[remote]",
      "public/.env": "SECRET=3",
      "public/docs/.env.local": "SECRET=4",
      "public/.well-known/security.txt": "Contact: mailto:ops@test-zone.invalid",
    });
    const read = readRemoteProject(root);
    if ("errors" in read) throw new Error(read.errors.join(", "));
    const paths = projectEntries(read).entries.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      "app",
      "app/config",
      "app/config/settings.json",
      "app/server.ts",
      "public",
      "public/.well-known",
      "public/.well-known/security.txt",
      "public/docs",
      "public/index.html",
    ]);
  });
});

describe("the token held, in words", () => {
  const identity = { id: "aaaaaaaaaaaa", label: "laptop", email: "ada@acme.test", expiresAt: null, scope: { slugs: ["alpha"], create: false, outbound: false, domain: false, public: false }, owned: [] };

  test("a member's own says whose roles bound it; an owner's, and one from an older dashboard, say nothing of it", () => {
    expect(describeIdentity({ ...identity, member: "ada@acme.test" }).at(-1)).toBe("   a member's own token: never more than ada@acme.test's roles on the dashboard, read at every request");
    expect(describeIdentity({ ...identity, member: "ada@acme.test" })[1]).toBe("   may open no site to the public");
    expect(describeIdentity({ ...identity, member: null })[1]).toBe("   may deploy private sites only");
    expect(describeIdentity({ ...identity, member: null }).join("\n")).not.toContain("member");
    expect(describeIdentity(identity).join("\n")).not.toContain("member");
  });
});
