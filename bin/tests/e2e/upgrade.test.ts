import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeComponents } from "../../cli/upgrade";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { TEST_HOST } from "./fake-ssh";
import { CLI, run, TESTS_ROOT, TEST_EMAIL, TEST_ZONE } from "./run";

/**
 * `sitesolide upgrade`, the real CLI, in front of the fake machine of
 * fake-vm.ts, as setup.test.ts runs setup: the wiring of the command, its
 * events under --json, and what reaches ssh. Every check is `sudo -n sh -s
 * upgrade:<component>:check`, its script on standard input; the fake answers
 * each from what the test lays, and refuses anything else. A run cannot
 * happen here, the fake answering the same way before and after it: the
 * whole sequence is cli-upgrade.test.ts's, against the model machine.
 *
 * Also here, `deploy --dry-run --compare`, which upgrade asks of the
 * dashboard and the portal: the deployment's very rsync, in a dry run, and the
 * deposited manifest read, nothing written.
 */

const FOLDERS: string[] = [];
let vm: FakeVm | null = null;
const IDS = upgradeComponents().map((component) => component.id);

afterEach(() => {
  vm?.cleanup();
  vm = null;
  for (const folder of FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-e2e-")));
  FOLDERS.push(made);
  return made;
}

/** A workstation whose configuration names the fake machine, or nothing. */
function workstation(config: Record<string, string> | null = { server: TEST_HOST, zone: TEST_ZONE, email: TEST_EMAIL }): string {
  const home = folder();
  mkdirSync(join(home, "config"), { recursive: true });
  if (config !== null) writeFileSync(join(home, "config", "config.json"), JSON.stringify(config));
  return home;
}

type Run = { code: number; output: string; error: string };

async function upgrade(machine: FakeVm, home: string, arguments_: string[]): Promise<Run> {
  // The test runner's own SITESOLIDE_* are left out: upgrade reads the
  // server from the environment as every command does.
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("SITESOLIDE_")) environment[key] = value;
  }
  const proc = Bun.spawn(["bun", CLI, "upgrade", ...arguments_], {
    cwd: home,
    env: { ...environment, PATH: machine.env.PATH!, FAKE_VM: machine.root, HOME: home, SITESOLIDE_CONFIG_DIR: join(home, "config") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error };
}

function events(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A machine whose survey finds these components, and whose checks all answer done unless `answers` says otherwise. */
function machine(installed: string[], answers: Record<string, string> = {}): FakeVm {
  const made = createFakeVm();
  made.acceptWrites();
  // The answers are printed in the order laid, and only the last `check:` line counts.
  made.answer(":check", "check: done\n");
  const missing = IDS.filter((id) => !installed.includes(id));
  made.answer("upgrade:survey:check", missing.length === 0 ? "check: done\n" : `check: missing ${missing.join(" ")}\n`);
  for (const [tag, output] of Object.entries(answers)) made.answer(tag, output);
  return made;
}

describe("sitesolide upgrade, in front of the fake machine", () => {
  test("no configuration: refused before any connection, with a hint", async () => {
    vm = createFakeVm();
    const r = await upgrade(vm, workstation(null), ["--json"]);
    expect(r.code).toBe(1);
    const last = events(r.output).at(-1)!;
    expect(last).toMatchObject({ type: "error", message: "missing settings: server, zone, email" });
    expect(String(last.hint)).toContain("sitesolide init");
    expect(vm.logs()).toEqual([]);
  });

  test("an option it does not take: refused, nothing read", async () => {
    vm = createFakeVm();
    const r = await upgrade(vm, workstation(), ["--force", "--json"]);
    expect(r.code).toBe(1);
    expect(events(r.output).at(-1)).toMatchObject({ type: "error", message: "usage: sitesolide upgrade [--dry-run] [--json]" });
    expect(vm.logs()).toEqual([]);
  });

  test("a machine without sitesolide: one read, then a refusal naming setup", async () => {
    vm = machine([]);
    const r = await upgrade(vm, workstation(), ["--json"]);
    expect(r.code).toBe(1);
    const last = events(r.output).at(-1)!;
    expect(last).toMatchObject({ type: "error", message: `nothing of sitesolide is installed on ${TEST_HOST}` });
    expect((last.details as string[]).join("\n")).toContain(`sitesolide setup ${TEST_HOST} --zone ${TEST_ZONE} --email ${TEST_EMAIL}`);
    expect(vm.logs()).toEqual(["ACCEPTED sudo -n sh -s upgrade:survey:check"]);
  });

  test("--dry-run --json: what the machine carries read, every line an event, only checks sent", async () => {
    vm = machine(["caddy-config", "api"], { "upgrade:api:check": "check: missing api-release\n" });
    const r = await upgrade(vm, workstation(), ["--dry-run", "--json"]);
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    const list = events(r.output);
    const result = list.at(-1)!;
    expect(result).toMatchObject({ type: "result", ok: true, command: "upgrade", dryRun: true, server: TEST_HOST, upToDate: ["caddy-config"], outOfDate: ["api"], upgraded: [] });
    expect(result.missing).toEqual(IDS.filter((id) => id !== "caddy-config" && id !== "api"));
    expect(result.next).toEqual([expect.stringContaining(`sitesolide setup ${TEST_HOST} --zone ${TEST_ZONE} --email ${TEST_EMAIL}`)]);
    const checks = list.filter((event) => event.type === "check");
    expect(checks.map((event) => event.step)).toEqual(IDS);
    expect(checks.find((event) => event.step === "api")).toMatchObject({ status: "todo", detail: "differs: api-release; would run bin/deploy-api.sh" });
    // Read only: the survey and the two components' checks, as root through sudo -n, nothing run.
    expect(vm.logs()).toEqual(["ACCEPTED sudo -n sh -s upgrade:survey:check", "ACCEPTED sudo -n sh -s upgrade:caddy-config:check", "ACCEPTED sudo -n sh -s upgrade:api:check"]);
  });

  test("the human checklist: each component's state in words, and the command for what is missing", async () => {
    vm = machine(["caddy-config"]);
    const home = workstation();
    const r = await upgrade(vm, home, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`-> upgrade of ${TEST_HOST}, zone ${TEST_ZONE}, to the code of this checkout, dry run: nothing is changed on the machine`);
    expect(r.output).toMatch(/up to date\s+the Caddyfile/);
    expect(r.output).toMatch(/missing\s+steward\s+not installed: sitesolide setup installs it/);
    expect(r.output).toContain("-> every installed component is up to date: nothing to do");
    expect(r.output).toContain(`SITESOLIDE_CONFIG_DIR=${join(home, "config")} sitesolide setup ${TEST_HOST} --zone ${TEST_ZONE} --email ${TEST_EMAIL} installs them`);
  });
});

describe("sitesolide deploy --dry-run --compare", () => {
  const PROJECT = "projects/simple-site";
  const manifest = readFileSync(join(TESTS_ROOT, PROJECT, "sitesolide.json"), "utf8");
  const env = { SITESOLIDE_SERVER: TEST_HOST, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL };

  test("the deployment's rsync in a dry run that compares contents, the manifest read, nothing written", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    vm.writeManifest("sample-static", manifest);
    const r = await run(PROJECT, ["deploy", "--dry-run", "--compare", "--json"], { vm, env });
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    expect(events(r.output).at(-1)).toMatchObject({ type: "result", command: "deploy", dryRun: true, compared: true, changes: [], kept: [] });
    const accepted = vm.logs().filter((line) => line.startsWith("ACCEPTED"));
    // The only command that is not a recognised read: rsync, in a dry run.
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toStartWith("ACCEPTED rsync -a --dry-run --itemize-changes --checksum --delete --delete-excluded");
    expect(accepted[0]).toContain(`${TEST_HOST}:/srv/sites/sample-static/public/`);
    expect(vm.logs()).toContain("FILE /srv/sites/sample-static/sitesolide.json");
  });

  test("a deposited manifest that differs, or none, is a change", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    vm.writeManifest("sample-static", manifest.replace('"public"', '"public", "description": "older"'));
    const differs = await run(PROJECT, ["deploy", "--dry-run", "--compare", "--json"], { vm, env });
    expect(events(differs.output).at(-1)).toMatchObject({ compared: true, changes: ["/srv/sites/sample-static/sitesolide.json"] });
    expect(differs.output).toContain("differs    /srv/sites/sample-static/sitesolide.json");
  });

  test("a project the server does not carry yet: everything would be sent, and rsync is not asked", async () => {
    vm = createFakeVm();
    vm.acceptWrites();
    const r = await run(PROJECT, ["deploy", "--dry-run", "--compare", "--json"], { vm, env });
    expect(r.code).toBe(0);
    expect(events(r.output).at(-1)).toMatchObject({ compared: true, changes: ["/srv/sites/sample-static: not on the server yet, everything would be sent"] });
    expect(vm.logs().filter((line) => line.startsWith("ACCEPTED"))).toEqual([]);
  });

  test("an rsync that fails is a refusal, never a guess", async () => {
    vm = createFakeVm();
    vm.writeManifest("sample-static", manifest);
    const r = await run(PROJECT, ["deploy", "--dry-run", "--compare", "--json"], { vm, env });
    expect(r.code).toBe(1);
    const last = events(r.output).at(-1)!;
    expect(last).toMatchObject({ type: "error", message: "cannot compare /srv/sites/sample-static/public with the server: rsync failed (1)" });
    expect(String(last.hint)).toContain("nothing was changed");
  });

  test("without --dry-run: refused before anything is read", async () => {
    vm = createFakeVm();
    const r = await run(PROJECT, ["deploy", "--compare", "--json"], { vm, env });
    expect(r.code).toBe(1);
    expect(events(r.output).at(-1)).toMatchObject({ type: "error", message: "--compare needs --dry-run" });
    expect(vm.logs()).toEqual([]);
  });
});
