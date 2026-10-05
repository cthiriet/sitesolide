import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { TEST_HOST } from "./fake-ssh";
import { CLI, TEST_EMAIL, TEST_ZONE } from "./run";

/**
 * `sitesolide setup`, the real CLI, in front of the fake machine of
 * fake-vm.ts: what the in-process tests of bin/tests/cli-setup.test.ts cannot
 * see, the wiring of the command, its events under --json, and what reaches
 * ssh's command line.
 *
 * The machine is `sample@invalid.local`, the only host the fake ssh answers;
 * the zone resolves nowhere; Cloudflare's API is pointed at a closed port of
 * the loopback, so that a forgotten call fails at once rather than reaching
 * anything. HOME and the configuration folder are temporary: nothing here
 * reads the workstation's own configuration.
 *
 * A full install cannot run here: the fake ssh answers a check the same way
 * every time, so a step would never see its own run take effect. That whole
 * sequence is cli-setup.test.ts's, against a model of the machine.
 */

const TOKEN = "cf-e2e-token-0123456789abcdefABCDEF";
const FOLDERS: string[] = [];
let vm: FakeVm | null = null;

afterEach(() => {
  vm?.cleanup();
  vm = null;
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const created = mkdtempSync(join(tmpdir(), "setup-e2e-"));
  FOLDERS.push(created);
  return created;
}

/** What the preflight reads on a Debian 13 machine, the fake's account a sudoer. */
function facts(overrides: Record<string, string> = {}): string {
  const values = {
    os: "debian",
    version: "13",
    system: "Debian GNU/Linux 13 (trixie)",
    architecture: "amd64",
    uid: "1000",
    free: String(40 * 1024 * 1024),
    ssh: "198.51.100.2 50000 203.0.113.10 22",
    sudo: "yes",
    zone: "",
    route4: JSON.stringify([{ dst: "default", dev: "eth0" }]),
    route6: "",
    addresses: JSON.stringify([{ ifname: "eth0", addr_info: [{ family: "inet", local: "203.0.113.10", scope: "global" }] }]),
    ...overrides,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\nend=preflight\n`;
}

type Run = { code: number; output: string; error: string };

async function setup(machine: FakeVm, home: string, arguments_: string[], extra: Record<string, string> = {}, stdin?: string): Promise<Run> {
  // The test runner's own SITESOLIDE_* and token are left out: setup reads
  // the server from the environment as every command does.
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("SITESOLIDE_") && key !== "CLOUDFLARE_API_TOKEN") environment[key] = value;
  }
  const proc = Bun.spawn(["bun", CLI, "setup", TEST_HOST, "--zone", TEST_ZONE, "--email", TEST_EMAIL, ...arguments_], {
    cwd: home,
    env: {
      ...environment,
      PATH: machine.env.PATH!,
      FAKE_VM: machine.root,
      HOME: home,
      SITESOLIDE_CONFIG_DIR: join(home, "config"),
      SITESOLIDE_CLOUDFLARE_API: "http://127.0.0.1:9/client/v4",
      ...extra,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error };
}

function events(run: Run): Record<string, unknown>[] {
  return run.output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("sitesolide setup, in front of the fake machine", () => {
  test("a configuration naming another zone: refused before any connection, with a hint", async () => {
    vm = createFakeVm();
    const home = folder();
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "config.json"), JSON.stringify({ server: TEST_HOST, zone: "production.invalid", email: TEST_EMAIL }));
    const run = await setup(vm, home, ["--json"]);
    expect(run.code).toBe(1);
    const last = events(run).at(-1)!;
    expect(last.type).toBe("error");
    expect(last.message).toBe("the configuration names another zone: production.invalid");
    expect(last.hint).toContain("do not edit, move or delete that configuration");
    expect(vm.logs()).toEqual([]);
  });

  test("a system other than Debian 13: one read of the machine, then a refusal", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    vm.answer("sh -s setup:preflight:read", facts({ os: "ubuntu", version: "24.04", system: "Ubuntu 24.04.1 LTS" }));
    const run = await setup(vm, folder(), []);
    expect(run.code).toBe(1);
    expect(run.error).toContain("!! invalid.local runs Ubuntu 24.04.1 LTS, not Debian 13");
    expect(vm.logs()).toEqual(["ACCEPTED sh -s setup:preflight:read"]);
  });

  test("--dry-run --json: every step checked through sudo -n, nothing run, every line an event", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    vm.answer("sh -s setup:preflight:read", facts());
    vm.answer(":check", "check: done\n");
    const run = await setup(vm, folder(), ["--dry-run", "--json"], { CLOUDFLARE_API_TOKEN: TOKEN });
    expect(run.error).toBe("");
    expect(run.code).toBe(0);
    const list = events(run);
    expect(list.at(-1)).toMatchObject({ type: "result", ok: true, command: "setup", dryRun: true, server: TEST_HOST });
    const checks = list.filter((event) => event.type === "check");
    expect(checks[0]).toMatchObject({ step: "preflight", status: "ok" });
    // Nothing is written on the workstation in a dry run, and the zone
    // resolves nowhere: those three are to do, everything else answered done.
    const todo = checks.filter((event) => event.status === "todo").map((event) => event.step);
    expect(todo).toEqual(["configuration", "dns", "resolution"]);
    expect(checks.filter((event) => event.status === "done")).toHaveLength(26);

    const logs = vm.logs();
    expect(logs[0]).toBe("ACCEPTED sh -s setup:preflight:read");
    expect(logs.slice(1).filter((line) => !/^ACCEPTED sudo -n sh -s setup:[a-z0-9-]+:check$/.test(line))).toEqual([]);
    expect(logs.join("\n")).not.toContain(":run");
    expect(`${run.output}${run.error}${logs.join("\n")}`).not.toContain(TOKEN);
  });

  test("--cloudflare-token-stdin: read from standard input, and nowhere in what comes out", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    vm.answer("sh -s setup:preflight:read", facts());
    vm.answer(":check", "check: done\n");
    const run = await setup(vm, folder(), ["--dry-run", "--cloudflare-token-stdin"], {}, `${TOKEN}\n`);
    expect(run.code).toBe(0);
    expect(run.output).toContain("[done] Caddy's Cloudflare token");
    expect(`${run.output}${run.error}${vm.logs().join("\n")}`).not.toContain(TOKEN);
  });

  test("a machine whose checks cannot be read: the dry run says so, step by step, and runs nothing", async () => {
    vm = createFakeVm();
    vm.acceptWrites(["setup:caddy:check"]);
    vm.answer("sh -s setup:preflight:read", facts());
    vm.answer(":check", "check: done\n");
    const run = await setup(vm, folder(), ["--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/\[todo\] Caddy, with the Cloudflare module\s+unreadable: fake ssh: command refused by the simulated server/);
    expect(vm.logs().filter((line) => line.startsWith("REFUSED"))).toEqual(["REFUSED sudo -n sh -s setup:caddy:check"]);
  });
});
