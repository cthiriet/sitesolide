import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryName, build, type Target } from "../../build";
import { KIT_MARKER, removeTree, SHIM_FOLDER } from "../../cli/kit";
import { forEachLine } from "../../cli/output";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { REPO, TEST_EMAIL, TEST_ZONE, TESTS_ROOT } from "./run";

/**
 * The compiled binary, as a workstation without Bun meets it.
 *
 * bin/build.ts builds the one this machine runs, with its kit, into a
 * temporary folder; every run below gets a fresh HOME, a cache of its own, and
 * a PATH with the system's tools and nothing else: no Bun, and no repository
 * but the binary's own copy of what it needs. The fake VM stands in for the
 * machine, as everywhere in these tests, and its ssh is the only one on the
 * PATH.
 */

const VERSION = "v0.0.0-test.1";
const HOST_TARGET = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}` as Target;
const WORK = mkdtempSync(join(tmpdir(), "binary-test-"));
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
let binary = "";
let vm: FakeVm | null = null;

beforeAll(async () => {
  const built = await build({ version: VERSION, targets: [HOST_TARGET], out: join(WORK, "dist") });
  binary = built.binaries[0]!.path;
}, 180_000);

afterEach(() => {
  vm?.cleanup();
  vm = null;
});

// The kits unpacked here are read-only, as on a workstation.
afterAll(() => removeTree(WORK));

let counter = 0;
/** A HOME, a cache and a project folder of its own, outside the repository. */
function workstation(project?: string): { home: string; cache: string; folder: string } {
  const root = join(WORK, `station-${counter++}`);
  const home = join(root, "home");
  const cache = join(root, "cache");
  mkdirSync(home, { recursive: true });
  const folder = join(root, "project");
  if (project === undefined) mkdirSync(folder, { recursive: true });
  else cpSync(project, folder, { recursive: true });
  return { home, cache, folder };
}

function runBinary(arguments_: string[], options: { cwd: string; env: Record<string, string> }) {
  const run = Bun.spawnSync([binary, ...arguments_], { cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, output: run.stdout.toString(), error: run.stderr.toString() };
}

describe("a binary on a workstation that has never run it", () => {
  test("it names no path of the repository: nothing it does can read one", () => {
    expect(readFileSync(binary).includes(Buffer.from(REPO))).toBe(false);
    // The binary and its sum, and no source map left beside them.
    expect(readdirSync(join(WORK, "dist")).sort()).toEqual(["SHA256SUMS", binaryName(HOST_TARGET)]);
  });

  test("the same tree builds the same bytes, so that anyone can check a release against its source", async () => {
    const again = await build({ version: VERSION, targets: [HOST_TARGET], out: join(WORK, "again") });
    expect(readFileSync(join(WORK, "again", "SHA256SUMS"), "utf8")).toBe(readFileSync(join(WORK, "dist", "SHA256SUMS"), "utf8"));
    expect(again.binaries[0]!.path).not.toBe(binary);
  }, 180_000);

  test("--version says the release, and unpacks nothing", () => {
    const station = workstation();
    const env = { HOME: station.home, XDG_CACHE_HOME: station.cache, PATH: SYSTEM_PATH };
    const run = runBinary(["--version"], { cwd: station.folder, env });
    expect(run).toEqual({ code: 0, output: `sitesolide ${VERSION}\n`, error: "" });
    expect(existsSync(station.cache)).toBe(false);
  });

  test("--help and help answer with no configuration at all; deploy --help deploys nothing", () => {
    const station = workstation();
    const env = { HOME: station.home, XDG_CACHE_HOME: station.cache, PATH: SYSTEM_PATH };
    for (const arguments_ of [["--help"], ["help"], ["deploy", "--help"]]) {
      const run = runBinary(arguments_, { cwd: station.folder, env });
      expect({ arguments_, code: run.code, error: run.error }).toEqual({ arguments_, code: 0, error: "" });
      expect(run.output).toStartWith("usage:\n");
      expect(run.output).toContain("sitesolide --version");
    }
  });

  test("a command that runs a script unpacks the kit once, and the script finds bun in it", () => {
    vm = createFakeVm();
    vm.acceptWrites();
    const station = workstation(join(TESTS_ROOT, "projects", "simple-site"));
    const env = {
      HOME: station.home,
      XDG_CACHE_HOME: station.cache,
      // The fake ssh first, then the system: bin/lock.sh and bin/config.sh
      // call bun, and only the kit's shim can answer.
      PATH: `${vm.env.PATH!.split(":")[0]}:${SYSTEM_PATH}`,
      SITESOLIDE_SERVER: vm.env.SITESOLIDE_SERVER!,
      FAKE_VM: vm.env.FAKE_VM!,
      SITESOLIDE_ZONE: TEST_ZONE,
      SITESOLIDE_EMAIL: TEST_EMAIL,
    };
    const first = runBinary(["lock", "--status", "--json"], { cwd: station.folder, env });
    expect(first.error).toBe("");
    expect(first.code).toBe(0);
    const result = JSON.parse(first.output.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(result).toMatchObject({ type: "result", ok: true, command: "lock", slug: "sample-static" });
    expect(result.lock).toEqual({ wanted: false, installed: false, withoutCode: 0, withCode: null, domain: null });
    // The read bin/lock.sh makes, from the kit, reached the fake machine.
    expect(vm.logs().some((line) => line.includes("/etc/caddy/locks/verrous.caddy"))).toBe(true);

    const kits = readdirSync(join(station.cache, "sitesolide"));
    expect(kits).toEqual([expect.stringMatching(new RegExp(`^${VERSION.replaceAll(".", "\\.")}-[0-9a-f]{16}$`))]);
    const kit = join(station.cache, "sitesolide", kits[0]!);
    expect(JSON.parse(readFileSync(join(kit, KIT_MARKER), "utf8")).version).toBe(VERSION);
    // Executable, and read-only, as every file of the kit.
    expect(statSync(join(kit, "bin", "lock.sh")).mode & 0o777).toBe(0o555);
    expect(statSync(join(kit, "bin")).mode & 0o777).toBe(0o555);
    const marker = statSync(join(kit, KIT_MARKER)).mtimeMs;

    // Run again: the same kit, not unpacked a second time.
    const second = runBinary(["lock", "--status", "--json"], { cwd: station.folder, env });
    expect(second.code).toBe(0);
    expect(readdirSync(join(station.cache, "sitesolide"))).toEqual(kits);
    expect(statSync(join(kit, KIT_MARKER)).mtimeMs).toBe(marker);

    // The shim, as the scripts call it: the binary itself, answering as Bun.
    const shim = Bun.spawnSync([join(kit, SHIM_FOLDER, "bun"), "--version"], { env: { PATH: SYSTEM_PATH, SITESOLIDE_BINARY: binary }, stdout: "pipe" });
    expect(shim.stdout.toString().trim()).toBe(Bun.version);
  });

  test("the dashboard deploys from the kit as it was built at release time, from a copy, leaving the kit as it was", () => {
    vm = createFakeVm();
    vm.acceptWrites();
    const station = workstation(join(TESTS_ROOT, "projects", "simple-site"));
    const env = {
      HOME: station.home,
      XDG_CACHE_HOME: station.cache,
      PATH: `${vm.env.PATH!.split(":")[0]}:${SYSTEM_PATH}`,
      SITESOLIDE_SERVER: vm.env.SITESOLIDE_SERVER!,
      FAKE_VM: vm.env.FAKE_VM!,
      SITESOLIDE_ZONE: TEST_ZONE,
      SITESOLIDE_EMAIL: TEST_EMAIL,
    };
    // A command that runs a script unpacks the kit.
    expect(runBinary(["lock", "--status", "--json"], { cwd: station.folder, env }).code).toBe(0);
    const kit = join(station.cache, "sitesolide", readdirSync(join(station.cache, "sitesolide"))[0]!);
    const snapshot = (): string[] =>
      [...new Bun.Glob("**").scanSync({ cwd: kit, dot: true, onlyFiles: false })].sort().map((path) => {
        const stat = statSync(join(kit, path));
        return `${path} ${(stat.mode & 0o777).toString(8)} ${stat.size} ${stat.mtimeMs}`;
      });
    const before = snapshot();
    const temporaries = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith("sitesolide-dashboard-"));
    const copiesBefore = temporaries();

    const run = runBinary(["deploy", "--dry-run", "--json"], { cwd: join(kit, "dashboard"), env });
    const events = run.output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    const last = events.at(-1)!;
    expect({ type: last.type, message: last.message, error: run.error }).toMatchObject({ type: "result", error: "" });
    const said = events.map((event) => `${event.message ?? ""} ${event.command ?? ""} ${(event.details ?? []).join(" ")}`).join("\n");
    // Built at release time: no build to run, and the files built leave from a copy.
    expect(said).not.toContain("build (");
    expect(said).toContain("the kit is read-only: working on a copy of this folder");
    expect(said).toMatch(/rsync .*sitesolide-dashboard-[^/ ]+\/public\//);
    expect(said).not.toContain(`${kit}/dashboard/`);
    // The kit is as it was, and the copy went with the process.
    expect(snapshot()).toEqual(before);
    expect(temporaries()).toEqual(copiesBefore);
  });

  test("mcp runs its tools with the binary itself, and says the release", async () => {
    const station = workstation(join(TESTS_ROOT, "..", "infer", "bun-app"));
    const server = Bun.spawn([binary, "mcp"], {
      cwd: station.folder,
      env: { HOME: station.home, XDG_CACHE_HOME: station.cache, PATH: SYSTEM_PATH },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const received: Record<string, any>[] = [];
    const reading = forEachLine(server.stdout, (line) => {
      received.push(JSON.parse(line) as Record<string, any>);
    });
    const send = (message: object): void => {
      server.stdin.write(`${JSON.stringify(message)}\n`);
      server.stdin.flush();
    };
    const answer = async (id: number): Promise<Record<string, any>> => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const found = received.find((message) => message.id === id);
        if (found !== undefined) return found;
        await Bun.sleep(20);
      }
      throw new Error(`no answer to ${id}: ${JSON.stringify(received)}`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "binary", version: "1" } } });
    expect((await answer(1)).result.serverInfo).toMatchObject({ name: "sitesolide", version: VERSION });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "detect", arguments: { folder: station.folder } } });
    const detected = await answer(2);
    expect(detected.result.isError).toBe(false);
    expect(detected.result.structuredContent.result).toMatchObject({ command: "detect", kind: "bun" });
    server.stdin.end();
    await reading;
    expect(await server.exited).toBe(0);
  }, 60_000);
});
