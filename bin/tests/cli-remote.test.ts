import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hintForFailure } from "../cli/hints";
import {
  apiAccess,
  apiOrigin,
  checkManifest,
  describeIdentity,
  buildPlaceholders,
  keyIn,
  projectEntries,
  promptWithoutEcho,
  readRemote,
  readRemoteProject,
  remoteMode,
  runRemote,
  serviceWord,
  SSH_COMMANDS,
  TOKEN_FILE,
  type Failure,
  type Fetch,
  type HiddenTerminal,
  type Output,
} from "../cli/remote";
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
/** The store routes: as this release answers them, from a dashboard before them, a refusal quoting what was sent, or a token that may not list. */
let storeScenario: "answers" | "old" | "quotes" | "out-of-scope" | "not-found" = "answers";
/** What a restart's observation concludes. */
let restartVerdict: "active" | "failure" = "active";
/** What the finished deployment says the store lacked, and the placeholders it hands the build; undefined for a dashboard before them. */
let deploymentExtras: { placeholders?: { zone: string; contact: string }; missingSecrets?: { runtime: string[]; files: string[] } | null } = {};

/** The store of `shop`, as the control API lists it to a token: names, never a value. */
const STORE = {
  slug: "shop",
  exists: true,
  state: "managed",
  reason: null,
  variables: [
    { name: "API_KEY", source: "store", file: null, shadows: [], declared: true },
    { name: "SMTP_URL", source: "legacy", file: "shop.env", shadows: [], declared: false },
    { name: "WEBHOOK_SECRET", source: "none", file: null, shadows: [], declared: true },
  ],
  missing: ["WEBHOOK_SECRET"],
  files: [],
  legacy: [{ name: "shop.env", state: "managed", reason: null, variables: ["SMTP_URL"], read: true, leftover: false, covered: null }],
  build: [],
  public: [],
  unitReadsStore: true,
  modifiedAt: 1_760_000_000_000,
  restartPending: true,
  previous: false,
  may: { write: true, reveal: false, restore: false, migrate: false },
};
const VERDICTS = {
  active: { kind: "active", state: "active", subState: "running", restarts: 0 },
  failure: { kind: "failure", state: "failed", subState: "failed", restarts: 3 },
};
let server: ReturnType<typeof Bun.serve>;
let api: string;
let vm: FakeVm;

const identity = { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: { slugs: [], create: true, outbound: false, domain: false, public: false }, owned: ["shop"] };
const LOG = ["-> manifest, validated on the machine", "   port 3002 chosen for the service", "-> verify", "   https://shop.test-zone.invalid/ 401, restricted: visitors are asked to sign in"];

beforeAll(() => {
  vm = createFakeVm();
  let reads = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = url.pathname.endsWith("/bundle") ? new Uint8Array(await req.arrayBuffer()) : req.method === "GET" ? null : await req.text();
      received.push({ method: req.method, path: `${url.pathname}${url.search}`, authorization: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 });
      if (url.pathname === "/api/v1/whoami") return Response.json({ identity });
      if (url.pathname === "/api/v1/deployments" && req.method === "POST") {
        if (scenario === "refuses") {
          return Response.json({ error: "invalid-manifest", message: "your token may not deploy this manifest: fix every point in details", details: ['network: your token may not deploy "network": "outbound"'] }, { status: 422 });
        }
        reads = 0;
        return Response.json({ deployment: { id: "0123456789abcdef01234567", slug: "shop", state: "awaiting-bundle", creating: true, log: [], next: 0, error: null, url: null, allocated: [], uploadUrl: "https://elsewhere.invalid/steal", ...(deploymentExtras.placeholders === undefined ? {} : { placeholders: deploymentExtras.placeholders }) } }, { status: 201 });
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
            ...(done ? deploymentExtras : {}),
          },
        });
      }
      if (url.pathname === "/api/v1/projects") {
        return Response.json({ projects: [{ slug: "shop", access: "owned", deployed: true, type: "app", url: "https://shop.test-zone.invalid/", portal: { wanted: true, installed: true }, services: [{ name: null, state: "active", subState: "running", port: 3002 }] }] });
      }
      if (url.pathname === "/api/v1/projects/shop/logs") return Response.json({ lines: ["2026-10-04T10:00:00+0000 vm shop[1]: listening on 3002"], cursor: "s=1" });
      const storeRoute = url.pathname.startsWith("/api/v1/projects/shop/store") || url.pathname === "/api/v1/projects/shop/restart";
      if (storeRoute && storeScenario === "old") return Response.json({ error: "not-found", message: "no such route: see docs/access.md" }, { status: 404 });
      if (url.pathname === "/api/v1/projects/shop/store" && req.method === "GET") {
        if (storeScenario === "out-of-scope") return Response.json({ error: "out-of-scope", message: "this token may not manage secrets" }, { status: 403 });
        if (storeScenario === "not-found") return Response.json({ error: "not-found", message: "shop is not deployed" }, { status: 404 });
        return Response.json({ store: STORE });
      }
      const changed = (over: object) => Response.json({ store: STORE, created: false, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, restart: null, ...over });
      if (url.pathname === "/api/v1/projects/shop/store" && req.method === "PATCH") {
        const change = JSON.parse(body as string) as { set?: Record<string, string>; remove?: string[] };
        // A refusal that would quote a value: what the CLI must never print.
        if (storeScenario === "quotes") return Response.json({ error: "invalid", message: `set: API_KEY: ${Object.values(change.set ?? {}).join("")} is refused` }, { status: 400 });
        const held = STORE.variables.filter((variable) => variable.source === "store").map((variable) => variable.name);
        const removed = (change.remove ?? []).filter((name) => held.includes(name));
        return changed({ set: Object.keys(change.set ?? {}), removed, absent: (change.remove ?? []).filter((name) => !removed.includes(name)) });
      }
      if (url.pathname === "/api/v1/projects/shop/store/generate" && req.method === "POST") return changed({ generated: [(JSON.parse(body as string) as { name: string }).name] });
      if (url.pathname.startsWith("/api/v1/projects/shop/store/files/")) {
        const name = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return changed({ files: req.method === "PUT" ? { set: [name], removed: [] } : { set: [], removed: [name] } });
      }
      if (url.pathname === "/api/v1/projects/shop/restart" && req.method === "POST") return Response.json({ verdict: VERDICTS[restartVerdict] });
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
async function cli(cwd: string, arguments_: string[], env: Record<string, string>, stdin?: string | Uint8Array) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
  const proc = Bun.spawn(["bun", CLI, ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
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

/** What an in-process run printed: its lines, and each refusal whole, details included. */
function recording() {
  const lines: string[] = [];
  const failures: Failure[] = [];
  const output: Output = {
    say: (line) => lines.push(line),
    journal: (line) => lines.push(line),
    failed: (failure) => {
      failures.push(failure);
      lines.push(`!! ${failure.error}: ${failure.message}`, ...(failure.details ?? []));
    },
    succeeded: () => {},
  };
  return { lines, failures, output };
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

  test("the build gets no SITESOLIDE_ variable, the token above all, and of the rest only what every build inherits", async () => {
    scenario = "succeeds";
    const probe = join(folder("remote-probe-"), "build-env.txt");
    // ENV_PROBE reaches the build only because the manifest names it.
    const root = project({ ...APP, build: 'env > "$ENV_PROBE"', secrets: { build: ["ENV_PROBE"] } }, APP_FILES);
    const home = folder("remote-home-");
    const result = await cli(root, ["deploy"], {
      HOME: home,
      SITESOLIDE_API: api,
      SITESOLIDE_TOKEN: TOKEN,
      SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY: "a DNS provider's secret",
      SITESOLIDE_ANYTHING_ELSE: "sitesolide's own",
      ENV_PROBE: probe,
      BUILD_PROBE: "kept",
    });
    expect(result.code).toBe(0);
    const lines = readFileSync(probe, "utf8").split("\n");
    expect(lines.filter((line) => line.startsWith("SITESOLIDE_"))).toEqual([]);
    expect(lines.some((line) => line.includes(TOKEN) || line.includes("a DNS provider's secret"))).toBe(false);
    for (const line of [`HOME=${home}`, `PATH=${vm.env.PATH}`]) expect(lines).toContain(line);
    expect(lines).toContain(`ENV_PROBE=${probe}`);
    // BUILD_PROBE is no name every build inherits, nor one the manifest declares.
    expect(lines.filter((line) => line.startsWith("BUILD_PROBE="))).toEqual([]);
  });

  test("a deployment that fails: its reason, and a non-zero exit", async () => {
    scenario = "fails";
    const root = project(APP, APP_FILES);
    const result = await cli(root, ["deploy"], { HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.error).toContain("!! bun install --production failed (exit 1): nothing served was changed");
  });

  test("a cloned repository whose publicDir is a link to ~/.ssh sends nothing", async () => {
    scenario = "succeeds";
    received.length = 0;
    const home = folder("remote-home-");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n");
    const root = join(home, "Code", "clone");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "sitesolide.json"), JSON.stringify({ slug: "shop", publicDir: "public" }));
    symlinkSync("../../.ssh", join(root, "public"));
    const result = await cli(root, ["deploy"], { HOME: home, SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(result.code).toBe(1);
    expect(result.error).toContain("publicDir leads outside the repository holding sitesolide.json");
    expect(received.filter((entry) => entry.method === "PUT")).toEqual([]);
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
    expect(human.error).toContain("!! deploy --dry-run is not available with a token: nothing was sent");
    const json = await cli(root, ["deploy", "--dry-run", "--json"], env);
    expect(json.code).toBe(1);
    const error = events(json.output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: "deploy --dry-run is not available with a token: nothing was sent" });
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

describe("the MCP server, with a token", () => {
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
    expect(answer.result.structuredContent.error.message).toBe("deploy --dry-run is not available with a token: nothing was sent");
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
    expect(status.output).toContain("GENERAL ACCESS");
    expect(status.output).toContain("Restricted");
    expect(status.output).not.toContain("DOOR");
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
    // The snapshots are read on the machine, over SSH: a token is told so,
    // rather than told the command does not exist.
    const backups = await cli(root, ["backups"], env);
    expect(backups.code).toBe(1);
    expect(backups.error).toContain("sitesolide backups needs the owner's SSH access");
    const usage = await cli(root, [], env);
    expect(usage.error).toContain("usage, with a token:");
    // With a server, --api still goes through the API.
    const forced = await cli(root, ["status", "--api"], { ...env, SITESOLIDE_SERVER: vm.env.SITESOLIDE_SERVER!, SITESOLIDE_ZONE: "test-zone.invalid", SITESOLIDE_EMAIL: "ops@test-zone.invalid" });
    expect(forced.output).toContain("shop");
  });
});

describe("secrets and restart, with a token: the project's store", () => {
  const VALUE = "s3cret-value-never-printed";
  const env = () => ({ HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
  const sent = () => received.filter((entry) => entry.method !== "GET");
  const STORE_APP = { ...APP, secrets: ["API_KEY", "WEBHOOK_SECRET"] };

  test("secrets lists the store's names, where each comes from, what is missing: never a value", async () => {
    storeScenario = "answers";
    received.length = 0;
    expect(SSH_COMMANDS).not.toContain("secrets");
    const root = project(STORE_APP, APP_FILES);
    const human = await cli(root, ["secrets"], env());
    expect(human.code).toBe(0);
    for (const line of [`-> secrets of shop, through ${api}`, "   API_KEY", "set", "   SMTP_URL", "from shop.env", "missing: sitesolide secrets set WEBHOOK_SECRET", "legacy: shop.env, read by the service", "a value is never shown here"]) {
      expect(human.output).toContain(line);
    }
    expect(received.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /api/v1/projects/shop/store"]);
    const json = events((await cli(root, ["secrets", "--json"], env())).output).at(-1)!;
    expect(json).toMatchObject({ type: "result", command: "secrets", slug: "shop", store: { missing: ["WEBHOOK_SECRET"] } });
  });

  test("secrets set reads the value from standard input, one trailing line break dropped, sends it in the body alone, and never prints it", async () => {
    storeScenario = "answers";
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    const human = await cli(root, ["secrets", "set", "API_KEY", "--stdin"], env(), `${VALUE}\n`);
    expect(human.code).toBe(0);
    expect(human.output).toContain(`-> shop's store, through ${api}`);
    expect(human.output).toContain("   set: API_KEY");
    expect(human.output).toContain("sitesolide restart, or --restart with the change");
    expect(human.all).not.toContain(VALUE);
    expect(sent().map((entry) => [entry.method, entry.path, JSON.parse(entry.body as string)])).toEqual([["PATCH", "/api/v1/projects/shop/store", { set: { API_KEY: VALUE }, remove: [] }]]);
    expect(vm.logs().filter((line) => line.includes(VALUE))).toEqual([]);
  });

  test("a value on the command line, or a name that looks like one, is refused before anything is sent, and never quoted back", async () => {
    storeScenario = "answers";
    const root = project(STORE_APP, APP_FILES);
    for (const asked of [["set", `API_KEY=${VALUE}`], ["set", "API_KEY", VALUE], ["set", `sk_live_${VALUE}`], ["generate", `whsec_${VALUE}`], ["remove", `ghp_${VALUE}`]]) {
      received.length = 0;
      const r = await cli(root, ["secrets", ...asked, "--json"], env());
      expect(r.code).toBe(1);
      expect(r.all).not.toContain(VALUE);
      expect(received).toEqual([]);
      expect(events(r.output).at(-1)!.hint).toContain("never");
    }
  });

  test("set prompts only at a terminal: under --json, or from a pipe without --stdin, nothing is read nor sent", async () => {
    storeScenario = "answers";
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    const json = await cli(root, ["secrets", "set", "API_KEY", "--json"], env(), VALUE);
    expect(events(json.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("never prompts") });
    const piped = await cli(root, ["secrets", "set", "API_KEY"], env(), VALUE);
    expect(piped.code).toBe(1);
    expect(piped.error).toContain("no terminal to type the value in");
    expect(received).toEqual([]);
  });

  test("generate asks the server to draw it, set-file sends a file read whole, remove-file takes one out", async () => {
    storeScenario = "answers";
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    expect((await cli(root, ["secrets", "generate", "SESSION_SECRET", "--format", "base64url"], env())).code).toBe(0);
    expect((await cli(root, ["secrets", "set-file", "gcp.json"], env(), '{"type":"service_account"}')).code).toBe(0);
    const removed = await cli(root, ["secrets", "remove-file", "gcp.json", "--json"], env());
    expect(events(removed.output).at(-1)).toMatchObject({ type: "result", command: "secrets", action: "remove-file", files: { removed: ["gcp.json"] } });
    expect(sent().map((entry) => `${entry.method} ${entry.path} ${entry.body}`)).toEqual([
      'POST /api/v1/projects/shop/store/generate {"name":"SESSION_SECRET","format":"base64url","bytes":32}',
      `PUT /api/v1/projects/shop/store/files/gcp.json {"content":"${new TextEncoder().encode('{"type":"service_account"}').toBase64()}"}`,
      "DELETE /api/v1/projects/shop/store/files/gcp.json ",
    ]);
  });

  test("set --restart writes, then restarts: a service that does not hold fails the run, the change said written", async () => {
    storeScenario = "answers";
    restartVerdict = "failure";
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    const r = await cli(root, ["secrets", "set", "API_KEY", "--stdin", "--restart"], env(), VALUE);
    restartVerdict = "active";
    expect(r.code).toBe(1);
    expect(r.error).toContain("the service of shop did not hold after its restart");
    expect(r.error).toContain("the change is written");
    expect(sent().map((entry) => `${entry.method} ${entry.path}`)).toEqual(["PATCH /api/v1/projects/shop/store", "POST /api/v1/projects/shop/restart"]);
  });

  test("restart prints the verdict, and exits 1 unless the service holds", async () => {
    storeScenario = "answers";
    const root = project(STORE_APP, APP_FILES);
    const held = await cli(root, ["restart"], env());
    expect(held.code).toBe(0);
    expect(held.output).toContain("the service holds");
    restartVerdict = "failure";
    const fell = await cli(root, ["restart", "--json"], env());
    restartVerdict = "active";
    expect(fell.code).toBe(1);
    expect(events(fell.output).at(-1)).toMatchObject({ type: "error", hint: expect.stringContaining("never restart in a loop") });
  });

  test("a dashboard from before the store: not-available, the owner to upgrade, on every route", async () => {
    storeScenario = "old";
    const root = project(STORE_APP, APP_FILES);
    for (const asked of [["secrets"], ["secrets", "generate", "A"], ["restart"]]) {
      const r = await cli(root, [...asked, "--json"], env());
      expect(events(r.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("sitesolide upgrade") });
    }
    storeScenario = "answers";
  });

  test("a refusal that would quote the value sent is withheld", async () => {
    storeScenario = "quotes";
    const root = project(STORE_APP, APP_FILES);
    const r = await cli(root, ["secrets", "set", "API_KEY", "--stdin"], env(), VALUE);
    storeScenario = "answers";
    expect(r.code).toBe(1);
    expect(r.all).not.toContain(VALUE);
    expect(r.error).toContain("withheld");
  });

  test("--stdin at a terminal is refused before standard input is read: the value would show as it is typed", async () => {
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    const record = recording();
    const code = await runRemote("secrets", ["secrets", "set", "API_KEY", "--stdin"], {
      folder: root,
      environment: { SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN },
      home: folder("remote-home-"),
      output: record.output,
      build: async () => {},
      checkPublic: () => {},
      terminal: () => true,
      stdinBytes: async () => {
        throw new Error("standard input read");
      },
    });
    expect(code).toBe(1);
    expect(record.failures[0]).toMatchObject({ error: "stdin-is-terminal" });
    expect(received).toEqual([]);
  });

  test("migrate is the owner's: with a token, needs-ssh, nothing sent; a static site has no store", async () => {
    received.length = 0;
    const root = project(STORE_APP, APP_FILES);
    for (const asked of [["migrate"], ["migrate", "--retire"]]) {
      const r = await cli(root, ["secrets", ...asked, "--json"], env());
      expect(events(r.output).at(-1)).toMatchObject({ type: "error", hint: expect.stringContaining("the owner") });
    }
    expect(received.filter((entry) => entry.path.includes("/store"))).toEqual([]);
    const site = project({ slug: "shop", publicDir: "public" }, { "public/index.html": "" });
    const r = await cli(site, ["secrets", "--json"], env());
    expect(events(r.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("a static site") });
  });

  test("what still needs the owner's SSH says so, and names what a token runs", async () => {
    const r = await cli(project(STORE_APP, APP_FILES), ["refresh", "--json"], env());
    expect(events(r.output).at(-1)).toMatchObject({ type: "error", hint: expect.stringContaining("secrets, restart and login") });
  });
});

describe("deploy through the API: the secrets", () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: folder("remote-home-"), SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN, ...extra });
  // The build writes what it received beside the manifest, which a static site never sends.
  const BLOG = { slug: "shop", build: "mkdir -p public && touch public/index.html && env > build-env.txt", publicDir: "public", env: { PUBLIC_URL: "https://{slug}.{zone}", CONTACT: "{contact}" }, secrets: { build: ["CMS_TOKEN"] } };

  test("a missing build secret stops before anything is sent, the manifest included", async () => {
    scenario = "succeeds";
    received.length = 0;
    const r = await cli(project(BLOG), ["deploy", "--json"], env());
    expect(r.code).toBe(1);
    expect(events(r.output).at(-1)).toMatchObject({ type: "error", message: "build secrets missing: CMS_TOKEN", hint: expect.stringContaining("nothing was sent") });
    expect(received).toEqual([]);
  });

  test("the build gets the allow list, the manifest's env with the deployment's placeholders, and the declared build secret: never the token, an undeclared variable, NODE_ENV", async () => {
    scenario = "succeeds";
    deploymentExtras = { placeholders: { zone: "test-zone.invalid", contact: "sample@test-zone.invalid" }, missingSecrets: null };
    const home = folder("remote-home-");
    const root = project(BLOG);
    const r = await cli(root, ["deploy", "--json"], {
      HOME: home,
      SITESOLIDE_API: api,
      SITESOLIDE_TOKEN: TOKEN,
      SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY: "a DNS provider's secret",
      BUILD_PROBE: "an undeclared variable",
      CMS_TOKEN: "the-cms-token",
      AWS_SECRET_ACCESS_KEY: "planted-cloud-key",
      NODE_ENV: "development",
      LANG: "en_GB.UTF-8",
    });
    deploymentExtras = {};
    expect(r.code).toBe(0);
    const result = events(r.output).at(-1)!;
    expect(result).toMatchObject({ type: "result", command: "deploy", buildSecrets: [{ name: "CMS_TOKEN", source: "environment" }] });
    expect(r.output).toContain("build secret CMS_TOKEN from your environment");
    expect(r.all).not.toContain("the-cms-token");
    const lines = readFileSync(join(root, "build-env.txt"), "utf8").split("\n");
    expect(lines).toContain("CMS_TOKEN=the-cms-token");
    expect(lines).toContain("PUBLIC_URL=https://shop.test-zone.invalid");
    expect(lines).toContain("CONTACT=sample@test-zone.invalid");
    expect(lines).toContain(`HOME=${home}`);
    expect(lines).toContain("LANG=en_GB.UTF-8");
    expect(lines.filter((line) => /^(SITESOLIDE_|AWS_SECRET_ACCESS_KEY|NODE_ENV|BUILD_PROBE)/.test(line))).toEqual([]);
  });

  test("a build secret from the workstation's file of the project, said by its path, never its value", async () => {
    scenario = "succeeds";
    const home = folder("remote-home-");
    mkdirSync(join(home, ".config", "sitesolide", "secrets"), { recursive: true });
    writeFileSync(join(home, ".config", "sitesolide", "secrets", "shop.env"), "CMS_TOKEN=from-the-workstation\nOTHER=never-taken\n");
    const r = await cli(project(BLOG), ["deploy", "--json"], { HOME: home, SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(events(r.output).at(-1)).toMatchObject({ buildSecrets: [{ name: "CMS_TOKEN", source: "workstation" }] });
    expect(r.all).not.toContain("from-the-workstation");
    // A file that does not parse stops, by its line, never its content.
    writeFileSync(join(home, ".config", "sitesolide", "secrets", "shop.env"), "CMS_TOKEN = from-the-workstation\n");
    received.length = 0;
    const bad = await cli(project(BLOG), ["deploy", "--json"], { HOME: home, SITESOLIDE_API: api, SITESOLIDE_TOKEN: TOKEN });
    expect(events(bad.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("line 1: whitespace before `=`") });
    expect(bad.all).not.toContain("from-the-workstation");
    expect(received).toEqual([]);
  });

  test("runtime secrets the store lacks: read before the deployment, a warning under --json, and the deployment goes on with missingSecrets in its result", async () => {
    scenario = "succeeds";
    storeScenario = "answers";
    received.length = 0;
    deploymentExtras = { missingSecrets: { runtime: ["WEBHOOK_SECRET"], files: [] } };
    const r = await cli(project({ ...APP, secrets: ["API_KEY", "WEBHOOK_SECRET"] }, APP_FILES), ["deploy", "--json"], env());
    deploymentExtras = {};
    expect(r.code).toBe(0);
    const list = events(r.output);
    expect(list.find((event) => event.type === "warning")).toMatchObject({
      message: "runtime secrets not set on the server: WEBHOOK_SECRET",
      details: expect.arrayContaining(["sitesolide secrets set WEBHOOK_SECRET, or sitesolide secrets generate WEBHOOK_SECRET (a random key, drawn on the server)"]),
    });
    expect(list.at(-1)).toMatchObject({ type: "result", missingSecrets: { runtime: ["WEBHOOK_SECRET"], files: [] } });
    const order = received.map((entry) => `${entry.method} ${entry.path}`);
    expect(order.indexOf("GET /api/v1/projects/shop/store")).toBeLessThan(order.indexOf("POST /api/v1/deployments"));
    expect(received.filter((entry) => entry.method === "PATCH")).toEqual([]);
  });

  test("a token that may not list secrets, a project not deployed yet, a dashboard before the store: said, and the deployment goes on", async () => {
    scenario = "succeeds";
    for (const [state, said] of [
      ["out-of-scope", "this token may not list secrets"],
      ["not-found", "not deployed yet"],
      ["old", "cannot tell which runtime secrets are set"],
    ] as const) {
      storeScenario = state;
      const r = await cli(project({ ...APP, secrets: ["API_KEY"] }, APP_FILES), ["deploy"], env());
      expect({ state, code: r.code }).toEqual({ state, code: 0 });
      expect(r.all).toContain(said);
    }
    storeScenario = "answers";
  });

  test("the placeholders a dashboard before them does not send: the zone its address names, no contact", () => {
    expect(buildPlaceholders("shop", "https://dashboard.example.com", undefined)).toEqual({ slug: "shop", zone: "example.com", contact: "" });
    expect(buildPlaceholders("shop", "http://127.0.0.1:4000", undefined)).toEqual({ slug: "shop", zone: "", contact: "" });
    expect(buildPlaceholders("shop", "https://dashboard.example.com", { zone: "z.test", contact: "c@z.test" })).toEqual({ slug: "shop", zone: "z.test", contact: "c@z.test" });
  });
});

/**
 * A terminal of the test's making: chunks delivered as a person or a paste
 * would type them, every call to the terminal recorded in order.
 */
function fakeTerminal(chunks: readonly (string | Uint8Array)[], options: { gapMs?: number; close?: boolean; listenThrows?: boolean } = {}) {
  const events: string[] = [];
  let signalled: (() => void) | null = null;
  let listening = false;
  let delivered = 0;
  const terminal: HiddenTerminal = {
    setRawMode: (raw) => {
      events.push(`raw ${raw}`);
    },
    write: (text) => {
      events.push(`write ${JSON.stringify(text)}`);
    },
    onSignals: (restore) => {
      events.push("signals on");
      signalled = restore;
      return () => {
        events.push("signals off");
        signalled = null;
      };
    },
    listen: (data, end) => {
      if (options.listenThrows === true) throw new Error("standard input is gone");
      listening = true;
      events.push("listen");
      void (async () => {
        for (const chunk of chunks) {
          await Bun.sleep(options.gapMs ?? 1);
          if (!listening) return;
          delivered++;
          events.push("data");
          data(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
        await Bun.sleep(options.gapMs ?? 1);
        if (options.close === true && listening) end();
      })();
      return () => {
        events.push("unlisten");
        listening = false;
      };
    },
  };
  return { terminal, events, delivered: () => delivered, signal: () => signalled?.(), signalsOn: () => signalled !== null };
}

/** The calls of a prompt that ended cleanly, around what was read in between. */
const around = (reads: number) => ["write \"Q: \"", "signals on", "raw true", "listen", ...Array<string>(reads).fill("data"), "unlisten", "signals off", "raw false", 'write "\\n"'];


describe("the prompt that does not echo", () => {
  test("Backspace, Ctrl-U and Ctrl-W edit the line; Enter ends it; Ctrl-C and Ctrl-D abandon it", () => {
    expect(keyIn("", "abc")).toEqual({ value: "abc" });
    expect(keyIn("abc", "\u007f")).toEqual({ value: "ab" });
    expect(keyIn("abc", "\b\b")).toEqual({ value: "a" });
    // One character is one code point, an emoji's two halves included.
    expect(keyIn("a😀", "\u007f")).toEqual({ value: "a" });
    expect(keyIn("", "\u007f")).toEqual({ value: "" });
    expect(keyIn("", "wrong\u0015right\r")).toEqual({ value: "right", typed: "right" });
    expect(keyIn("", "one two\u0017three\r")).toEqual({ value: "one three", typed: "one three" });
    expect(keyIn("", "one two  \u0017")).toEqual({ value: "one " });
    expect(keyIn("", "\u0017\u0015")).toEqual({ value: "" });
    expect(keyIn("ab", "c\r")).toEqual({ value: "abc", typed: "abc" });
    expect(keyIn("ab", "c\n")).toEqual({ value: "abc", typed: "abc" });
    // A pasted Windows line ends in both: still one line.
    expect(keyIn("", "abc\r\n")).toEqual({ value: "abc", typed: "abc" });
    expect(keyIn("", "\r")).toEqual({ value: "", typed: "" });
    expect(keyIn("secret", "\u0003")).toEqual({ value: "", typed: null });
    expect(keyIn("secret", "\u0004")).toEqual({ value: "", typed: null });
  });

  test("an escape sequence, Tab and any other control key are refused, never taken into the value", () => {
    const escape = { value: "", typed: { refused: "an arrow key or another escape sequence was typed at the prompt, which takes none" } };
    expect(keyIn("abc", "\u001b[D")).toEqual(escape);
    expect(keyIn("abc", "\u001b")).toEqual(escape);
    for (const [key, name] of [
      ["\t", "Tab"],
      ["\u001a", "Ctrl-Z"],
      ["\u001c", "Ctrl-\\"],
      ["\u0016", "Ctrl-V"],
      ["\u0000", "Ctrl-@"],
      ["\u0085", "a control character, U+0085,"],
    ] as const) {
      expect({ name, step: keyIn("abc", `x${key}y`) }).toEqual({ name, step: { value: "", typed: { refused: `${name} was typed at the prompt, which takes no control key` } } });
    }
  });

  test("anything after the line's end is refused: a paste of several lines", () => {
    const several = { value: "", typed: { refused: "more than one line arrived at the prompt, a paste of several lines" } };
    expect(keyIn("", "first\nsecond")).toEqual(several);
    expect(keyIn("", "first\n\n")).toEqual(several);
    expect(keyIn("", "first\r\n\r\n")).toEqual(several);
    expect(keyIn("", "first\r\r")).toEqual(several);
  });

  test("the value typed reaches the run; the question and the line break go to standard error; the terminal is given back", async () => {
    const fake = fakeTerminal(["s3", "cr\u007fret\r"]);
    expect(await promptWithoutEcho("Q: ", fake.terminal, 10)).toBe("s3cret");
    expect(fake.events).toEqual(around(2));
    // A Windows line end split between two reads is still one line.
    const split = fakeTerminal(["s3cret\r", "\n"]);
    expect(await promptWithoutEcho("Q: ", split.terminal, 10)).toBe("s3cret");
  });

  test("a paste of several lines is refused, and the rest of it is read and dropped before the terminal is given back", async () => {
    const several = { refused: "more than one line arrived at the prompt, a paste of several lines" };
    const paste = fakeTerminal(["first line\nsec", "ond line\nthird", " line\n"]);
    expect(await promptWithoutEcho("Q: ", paste.terminal, 20)).toEqual(several);
    // Every chunk was read here, none left for the shell to echo and run.
    expect(paste.delivered()).toBe(3);
    expect(paste.events).toEqual(around(3));
    // The line ended exactly at the end of a read, the next line in the following one.
    const late = fakeTerminal(["first line\r", "second line\r"]);
    expect(await promptWithoutEcho("Q: ", late.terminal, 20)).toEqual(several);
    expect(late.delivered()).toBe(2);
  });

  test("an escape sequence split across reads is refused, and its rest dropped; bytes that are not UTF-8 are refused", async () => {
    const arrow = fakeTerminal(["ab\u001b", "[D", "cd\r"]);
    expect(await promptWithoutEcho("Q: ", arrow.terminal, 20)).toEqual({ refused: "an arrow key or another escape sequence was typed at the prompt, which takes none" });
    expect(arrow.events).toEqual(around(3));
    const bytes = fakeTerminal([new Uint8Array([0x61, 0xff, 0x0d])]);
    expect(await promptWithoutEcho("Q: ", bytes.terminal, 10)).toEqual({ refused: "what arrived at the prompt is not valid UTF-8" });
  });

  test("the terminal is given back however the prompt ends: Ctrl-C, the input closing, a signal, an exception", async () => {
    const interrupted = fakeTerminal(["ab\u0003"]);
    expect(await promptWithoutEcho("Q: ", interrupted.terminal, 10)).toBeNull();
    expect(interrupted.events).toEqual(around(1));

    const closed = fakeTerminal(["ab"], { close: true });
    expect(await promptWithoutEcho("Q: ", closed.terminal, 10)).toBeNull();
    expect(closed.events).toEqual(around(1));

    const signalled = fakeTerminal(["ab"]);
    const pending = promptWithoutEcho("Q: ", signalled.terminal, 10);
    await Bun.sleep(20);
    signalled.signal();
    expect(await pending).toBeNull();
    expect(signalled.events).toEqual(around(1));
    expect(signalled.signalsOn()).toBe(false);

    const broken = fakeTerminal([], { listenThrows: true });
    await expect(promptWithoutEcho("Q: ", broken.terminal, 10)).rejects.toThrow("standard input is gone");
    expect(broken.events).toEqual(['write "Q: "', "signals on", "raw true", "signals off", "raw false", 'write "\\n"']);
  });

  test("on SIGINT, SIGTERM and SIGHUP, the process's own handlers give the terminal back, then let the signal end the run", async () => {
    // A pipe is no terminal: raw mode is recorded on standard error rather
    // than set, and the rest is the process's own, signals included.
    const script = join(folder("prompt-signal-"), "prompt.ts");
    writeFileSync(
      script,
      [
        `import { processTerminal, promptWithoutEcho } from ${JSON.stringify(join(import.meta.dir, "..", "cli", "remote.ts"))};`,
        "const terminal = { ...processTerminal(), setRawMode: (raw: boolean) => { process.stderr.write(`raw ${raw}\\n`); } };",
        'await promptWithoutEcho("Q: ", terminal);',
        'process.stderr.write("returned\\n");',
      ].join("\n"),
    );
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const proc = Bun.spawn(["bun", script], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
      const reader = proc.stderr.getReader();
      let said = "";
      while (!said.includes("raw true")) {
        const { value, done } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
      }
      proc.kill(signal);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
      }
      await proc.exited;
      expect({ signal, said, ended: proc.signalCode }).toEqual({ signal, said: "Q: raw true\nraw false\n\n", ended: signal });
    }
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

  test("only a public service gets a stand-in port: a worker and a scheduled service listen on nothing", () => {
    const background = { slug: "relay", services: { queue: { start: "x", internal: true }, sync: { start: "y", schedule: "hourly" } } };
    expect(checkManifest(JSON.stringify(background)).errors).toEqual([]);
    expect(checkManifest(JSON.stringify({ ...background, services: { ...background.services, web: { start: "z" } } })).errors).toEqual([]);
    // A port beside a schedule is still the manifest's own mistake, and said.
    expect(checkManifest(JSON.stringify({ slug: "relay", services: { sync: { start: "y", schedule: "hourly", port: 3001 } } })).errors).toContainEqual(
      expect.stringContaining("services.sync.port: a scheduled service listens on nothing"),
    );
  });

  test("a scheduled service idle between two runs is not down; a failed run is", () => {
    const server = { name: null, state: "active", subState: "running", port: 3002 };
    expect(serviceWord([])).toBe("-");
    expect(serviceWord([server])).toBe("active");
    expect(serviceWord([server, { name: "sync", state: "inactive", subState: "dead", port: null, kind: "scheduled" }])).toBe("active");
    expect(serviceWord([server, { name: "sync", state: "failed", subState: "failed", port: null, kind: "scheduled" }])).toBe("active,failed");
    expect(serviceWord([{ name: "sync", state: "inactive", subState: "dead", port: null, kind: "scheduled" }])).toBe("scheduled");
    expect(serviceWord([{ ...server, kind: "worker" }, { name: "queue", state: "activating", subState: "auto-restart", port: null, kind: "worker" }])).toBe("active,activating");
    // A dashboard from before the kinds: every service counts, as before.
    expect(serviceWord([server, { name: "sync", state: "inactive", subState: "dead", port: null }])).toBe("active,inactive");
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
    expect(describeIdentity({ ...identity, member: "ada@acme.test" }).at(-1)).toBe("   a personal token: never more than ada@acme.test's roles on the dashboard, read at every request");
    expect(describeIdentity({ ...identity, member: "ada@acme.test" })[1]).toBe("   may open no site to the public");
    expect(describeIdentity({ ...identity, member: null })[1]).toBe("   may deploy private sites only");
    expect(describeIdentity({ ...identity, member: null }).join("\n")).not.toContain("member");
    expect(describeIdentity(identity).join("\n")).not.toContain("member");
  });

  test("a token that may manage secrets says so; one without, or from a dashboard before the permission, says nothing of it", () => {
    expect(describeIdentity({ ...identity, scope: { ...identity.scope, secrets: true } })[1]).toBe("   may deploy private sites only, manage secrets");
    expect(describeIdentity({ ...identity, scope: { ...identity.scope, secrets: false } })[1]).toBe("   may deploy private sites only");
    expect(describeIdentity(identity).join("\n")).not.toContain("secrets");
  });
});

describe("access through the API, over a fake fetch", () => {
  const remote = { api: "https://dashboard.test-zone.invalid", token: TOKEN };
  const entry = { who: "alice@acme.test", kind: "person", role: "visitor", by: "token:aaaaaaaaaaaa", createdAt: 1, updatedAt: 1, password: null };
  const access = {
    slug: "shop",
    host: "shop.test-zone.invalid",
    url: "https://shop.test-zone.invalid/",
    general: { access: "restricted", modifiable: true, reason: null },
    entries: [entry],
    signIn: { configured: true, allowedDomains: ["acme.test"], providerName: null },
    portal: { reading: "steward", writtenAt: 1 },
  };

  /** A fetch that records each request and answers what `respond` returns. */
  function fakeFetch(respond: (method: string, path: string) => Response) {
    const asked: { method: string; url: string; authorization: string | null; body: unknown }[] = [];
    const fetcher: Fetch = async (input, init = {}) => {
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      asked.push({ method, url: input, authorization: headers.get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return respond(method, new URL(input).pathname);
    };
    return { asked, fetcher };
  }

  test("GET, PUT and DELETE on the project's access, the bearer on each, the slug encoded", async () => {
    const { asked, fetcher } = fakeFetch((method) =>
      method === "GET" ? Response.json({ access }) : Response.json({ entry, change: method === "PUT" ? "add" : "remove", access }, { status: method === "PUT" ? 201 : 200 }),
    );
    const transport = apiAccess(remote, fetcher);
    expect(transport.via).toBe(`through ${remote.api}`);
    expect(await transport.list("shop")).toEqual({ ok: true, value: access as never });
    expect(await transport.give("shop", "alice@acme.test", "visitor", undefined)).toEqual({ ok: true, value: { entry, change: "add", access } as never });
    // A token never draws a password: the expiry is not sent.
    await transport.give("shop", "bob@acme.test", "viewer", 86_400);
    expect(await transport.remove("shop", "alice@acme.test")).toMatchObject({ ok: true, value: { change: "remove" } });
    await transport.list("a b");
    expect(asked).toEqual([
      { method: "GET", url: `${remote.api}/api/v1/projects/shop/access`, authorization: `Bearer ${TOKEN}`, body: null },
      { method: "PUT", url: `${remote.api}/api/v1/projects/shop/access`, authorization: `Bearer ${TOKEN}`, body: { who: "alice@acme.test", role: "visitor" } },
      { method: "PUT", url: `${remote.api}/api/v1/projects/shop/access`, authorization: `Bearer ${TOKEN}`, body: { who: "bob@acme.test", role: "viewer" } },
      { method: "DELETE", url: `${remote.api}/api/v1/projects/shop/access`, authorization: `Bearer ${TOKEN}`, body: { who: "alice@acme.test" } },
      { method: "GET", url: `${remote.api}/api/v1/projects/a%20b/access`, authorization: `Bearer ${TOKEN}`, body: null },
    ]);
  });

  test("an old dashboard's catch-all is not-available, on every route; a project the token cannot see stays not-found", async () => {
    const old = apiAccess(remote, fakeFetch(() => Response.json({ error: "not-found", message: "no such route: see docs/team.md" }, { status: 404 })).fetcher);
    const notAvailable = {
      ok: false,
      failure: { error: "not-available", message: `the dashboard at ${remote.api} does not carry access yet: the owner of the machine runs sitesolide upgrade` },
    };
    expect(await old.list("shop")).toEqual(notAvailable as never);
    expect(await old.give("shop", "a@acme.test", "visitor", undefined)).toEqual(notAvailable as never);
    expect(await old.remove("shop", "a@acme.test")).toEqual(notAvailable as never);
    const unseen = apiAccess(remote, fakeFetch(() => Response.json({ error: "not-found", message: "no project shop for this token" }, { status: 404 })).fetcher);
    expect(await unseen.list("shop")).toEqual({ ok: false, failure: { error: "not-found", message: "no project shop for this token" } });
  });

  test("the dashboard's refusals come back as they stand, its details and wait included", async () => {
    const refusing = apiAccess(
      remote,
      fakeFetch(() => Response.json({ error: "out-of-scope", message: "a token gives people Can open alone", details: ["viewer: from the dashboard"], wait: 3 }, { status: 403 })).fetcher,
    );
    expect(await refusing.give("shop", "a@acme.test", "viewer", undefined)).toEqual({
      ok: false,
      failure: { error: "out-of-scope", message: "a token gives people Can open alone", details: ["viewer: from the dashboard"], wait: 3 },
    });
  });

  test("an answer that is not the control API's access is unreadable, and a dashboard that does not answer unreachable", async () => {
    const wrong = apiAccess(remote, fakeFetch(() => Response.json({ sharing: { url: "x", policy: {} }, entry: null })).fetcher);
    expect(await wrong.list("shop")).toEqual({ ok: false, failure: { error: "unreadable", message: `${remote.api} answered with something that is not the control API's access` } });
    expect(await wrong.give("shop", "a@acme.test", "visitor", undefined)).toEqual({ ok: false, failure: { error: "unreadable", message: `${remote.api} answered with something that is not the control API's access` } });
    const html = apiAccess(remote, fakeFetch(() => new Response("<html>", { status: 200 })).fetcher);
    expect(await html.list("shop")).toMatchObject({ ok: false, failure: { error: "unreadable" } });
    const down = apiAccess(remote, async () => {
      throw new Error("connection refused");
    });
    expect(await down.remove("shop", "a@acme.test")).toEqual({ ok: false, failure: { error: "unreachable", message: `${remote.api} unreachable: connection refused` } });
  });
});
