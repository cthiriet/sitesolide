import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../../cli/fragment";
import type { Manifest } from "../../cli/manifest";
import { FIRST_CERTIFICATE_MS, TLS_ZONE_FILE, TLS_ZONE_STATES, ZONE_NAMES_COMMAND, ZONE_NAMES_FILE } from "../../cli/tls";
import { CLI, REPO, run, TEST_EMAIL, TEST_ZONE } from "./run";
import { createFakeVm, type FakeVm } from "./fake-vm";

/**
 * bin/deploy-caddy.sh and the zone's TLS policy, /etc/caddy/tls-zone.caddy,
 * which the Caddyfile imports by name: really run in front of a simulated VM
 * whose fake ssh answers the reading of that policy from what the test lays.
 *
 * A machine from before the file, holding a Cloudflare token, gets
 * Cloudflare's policy laid inside the transaction, after the backup and
 * before the Caddyfile that imports it, and taken away by the restore. A
 * machine with neither stops before any write. With manual DNS, the zone's
 * sites are listed for the ask endpoint before anything is deposited. No test
 * touches a machine: the fake ssh only accepts the tests' host, and the
 * accepted writes are never executed.
 */

const TEMP_DIRS: string[] = [];
let vm: FakeVm;

afterEach(() => {
  vm?.cleanup();
  for (const folder of TEMP_DIRS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A repository holding the real scripts and the real Caddyfile, as a deployment hands them. */
function testRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "repo-tls-")));
  TEMP_DIRS.push(repo);
  mkdirSync(join(repo, "bin"));
  for (const name of ["cli", "config.sh", "deploy-caddy.sh", "generate-domains.sh", "portal-guard.ts"]) symlinkSync(join(REPO, "bin", name), join(repo, "bin", name));
  mkdirSync(join(repo, "infra", "caddy"), { recursive: true });
  writeFileSync(join(repo, "infra", "caddy", "Caddyfile"), readFileSync(join(REPO, "infra", "caddy", "Caddyfile"), "utf8"));
  return repo;
}

async function deployCaddy(arguments_: string[] = [], name = "deploy-caddy.sh"): Promise<{ code: number; output: string; error: string }> {
  const proc = Bun.spawn(["bash", join(testRepo(), "bin", name), ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
    // The zone has no default, and the test's resolves nowhere.
    env: { ...process.env, ...vm.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL },
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error };
}

/** Where the policy is written before it is renamed over the file. */
const STAGED = TLS_ZONE_FILE.replace(/[^/]+$/, ".$&.new");

/** The remote shell's answer when it lays the policy, as the script asks it to say. */
const LAID = `/dev/stdin ${STAGED} && sudo mv -f ${STAGED} ${TLS_ZONE_FILE} && echo laid`;

/**
 * A machine in service whose Caddyfile differs from the repository's, every
 * write accepted. No landing, so that the verification queries nothing: its
 * two addresses would resolve nowhere.
 */
function machineInService(state: string, validates: boolean): void {
  vm = createFakeVm();
  vm.setTlsZoneState(state);
  vm.writeFile("/etc/caddy/Caddyfile", "# the Caddyfile of 0.6\n");
  vm.acceptWrites([`ls -A /srv/sites/${TEST_ZONE}/public`]);
  if (validates) vm.answer("caddy validate", "Valid configuration\n");
}

/** The first log line that holds every one of these, by index; -1 when none does. */
function lineWith(logs: string[], ...parts: string[]): number {
  return logs.findIndex((line) => parts.every((part) => line.includes(part)));
}

describe("bin/deploy-caddy.sh lays the zone's TLS policy a machine from before it lacks", () => {
  test("Cloudflare's, inside the transaction: after the backup, before the Caddyfile that imports it", async () => {
    machineInService(TLS_ZONE_STATES.cloudflare, true);
    vm.answer(LAID, "laid\n");
    const r = await deployCaddy();
    // The only refusal: the landing's folder, so that no address is queried.
    expect(r.error).not.toContain("!!");
    expect(r.code).toBe(0);
    expect(r.output).toContain(`TO LAY     ${TLS_ZONE_FILE}, Cloudflare's policy`);
    expect(r.output).toContain("-> in service");
    const logs = vm.logs();
    const read = logs.indexOf("TLS_ZONE");
    const backup = lineWith(logs, "ACCEPTED sudo mkdir -p /var/backups/caddy/");
    const laid = lineWith(logs, "ACCEPTED", `sudo install -m 644 -o root -g root ${LAID}`);
    const deposit = lineWith(logs, "sudo install -m 644 -o root -g root", "/Caddyfile /etc/caddy/Caddyfile");
    const validation = lineWith(logs, "caddy validate");
    expect(read).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(read);
    expect(laid).toBeGreaterThan(backup);
    expect(deposit).toBeGreaterThan(laid);
    expect(validation).toBeGreaterThan(deposit);
    // Only if still missing when the write comes: a policy laid in between is kept.
    expect(logs[laid]).toContain(`if test -f ${TLS_ZONE_FILE}; then echo kept; else`);
    // A provider's zone lists no sites for the ask endpoint.
    expect(logs).not.toContain(`ACCEPTED ${ZONE_NAMES_COMMAND}`);
  });

  test("a refused validation takes the policy it laid away with the Caddyfile", async () => {
    machineInService(TLS_ZONE_STATES.cloudflare, false);
    vm.answer(LAID, "laid\n");
    const r = await deployCaddy();
    expect(r.code).toBe(1);
    expect(r.error).toContain("configuration refused by caddy validate");
    const logs = vm.logs();
    const restore = lineWith(logs, `|| sudo rm -f ${TLS_ZONE_FILE}`);
    expect(restore).toBeGreaterThan(lineWith(logs, "caddy validate"));
    // Unless the Caddyfile put back imports it too: then it stays.
    expect(logs[restore]).toContain(`sudo grep -Eq '^[[:space:]]*import ${TLS_ZONE_FILE}'`);
  });

  test("a policy laid in between is the machine's: the restore leaves it", async () => {
    machineInService(TLS_ZONE_STATES.cloudflare, false);
    vm.answer(LAID, "kept\n");
    const r = await deployCaddy();
    expect(r.code).toBe(1);
    expect(lineWith(vm.logs(), `sudo rm -f ${TLS_ZONE_FILE}`)).toBe(-1);
  });

  test("with no policy and no Cloudflare token, stops before any write", async () => {
    machineInService(TLS_ZONE_STATES.none, true);
    const r = await deployCaddy();
    expect(r.code).toBe(1);
    expect(r.error).toContain(`STOP: ${TLS_ZONE_FILE} is missing`);
    expect(r.error).toContain("sitesolide setup lays it");
    const logs = vm.logs();
    expect(logs.filter((line) => line.startsWith("ACCEPTED") || line.startsWith("REFUSED"))).toEqual([]);
    expect(logs.at(-1)).toBe("LOCK release deploy-caddy");
  });

  test("a policy file that holds no policy, empty or cut short: stops before any write, naming the file", async () => {
    machineInService(TLS_ZONE_STATES.unrecognised, true);
    const r = await deployCaddy();
    expect(r.code).toBe(1);
    expect(r.error).toContain(`STOP: ${TLS_ZONE_FILE} holds no TLS policy this release recognises`);
    expect(vm.logs().filter((line) => line.startsWith("ACCEPTED") || line.startsWith("REFUSED"))).toEqual([]);
    expect(vm.logs().at(-1)).toBe("LOCK release deploy-caddy");
  });

  test("an answer it does not recognise stops it the same way", async () => {
    machineInService("tls-zone: perhaps", true);
    const r = await deployCaddy();
    expect(r.code).toBe(1);
    expect(r.error).toContain(`the state of ${TLS_ZONE_FILE} could not be read`);
    expect(vm.logs().filter((line) => line.startsWith("ACCEPTED"))).toEqual([]);
  });

  test("in a dry run, says it would lay the policy and writes nothing", async () => {
    vm = createFakeVm();
    vm.setTlsZoneState(TLS_ZONE_STATES.cloudflare);
    vm.writeFile("/etc/caddy/Caddyfile", readFileSync(join(REPO, "infra", "caddy", "Caddyfile"), "utf8"));
    const r = await deployCaddy(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("unchanged  /etc/caddy/Caddyfile");
    expect(r.output).toContain(`TO LAY     ${TLS_ZONE_FILE}`);
    expect(r.output).toContain("dry run, nothing was touched");
    expect(vm.logs().filter((line) => line.startsWith("ACCEPTED") || line.startsWith("REFUSED"))).toEqual([]);
  });
});

describe("bin/deploy-caddy.sh and a policy already in place", () => {
  test("a provider's: neither laid nor listed, the transaction as before", async () => {
    machineInService(TLS_ZONE_STATES.dns, true);
    const r = await deployCaddy();
    expect(r.code).toBe(0);
    expect(r.output).not.toContain("TO LAY");
    const logs = vm.logs();
    expect(lineWith(logs, TLS_ZONE_FILE, "ACCEPTED")).toBe(-1);
    expect(logs).not.toContain(`ACCEPTED ${ZONE_NAMES_COMMAND}`);
  });

  test("manual DNS: the zone's sites listed for the ask endpoint after the backup, before anything is deposited", async () => {
    machineInService(TLS_ZONE_STATES.onDemand, true);
    const r = await deployCaddy();
    expect(r.code).toBe(0);
    expect(r.output).toContain("-> the zone's sites, for the ask endpoint");
    const logs = vm.logs();
    const listed = logs.indexOf(`ACCEPTED ${ZONE_NAMES_COMMAND}`);
    expect(listed).toBeGreaterThan(lineWith(logs, "ACCEPTED sudo mkdir -p /var/backups/caddy/"));
    expect(listed).toBeLessThan(lineWith(logs, "/Caddyfile /etc/caddy/Caddyfile"));
    // Nothing to lay: the machine has its policy.
    expect(lineWith(logs, `/dev/stdin ${STAGED}`)).toBe(-1);
  });

  test("manual DNS: the site whose block arrives is probed last, and waits for nothing once another failed", async () => {
    // Its certificate may not exist yet, the probe's handshake obtaining it:
    // it would get a minute, but a site already served that no longer
    // answers is a configuration to restore at once.
    machineInService(TLS_ZONE_STATES.onDemand, true);
    const tool: Manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };
    vm.writeManifest(tool.slug, `${JSON.stringify(tool, null, 2)}\n`);
    // The listing of the sites that serve something, as the verification sends it.
    vm.answer('for folder in /srv/sites/*/; do\n    [ -d "$folder" ] || continue', "tool\ncms\n");
    const blocks = realpathSync(mkdtempSync(join(tmpdir(), "blocks-tls-")));
    TEMP_DIRS.push(blocks);
    writeFileSync(join(blocks, "tool.caddy"), generateFragment(tool)!);
    const started = Date.now();
    const r = await deployCaddy([join(blocks, "tool.caddy")]);
    expect(r.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(30_000);
    const served = r.output.indexOf(`https://cms.${TEST_ZONE}/`);
    const fresh = r.output.indexOf(`https://tool.${TEST_ZONE}/`);
    expect(served).toBeGreaterThan(-1);
    expect(fresh).toBeGreaterThan(served);
    expect(r.error).toContain("2 address(es) no longer answer");
  });

  test("manual DNS in a dry run: nothing listed, nothing written", async () => {
    vm = createFakeVm();
    vm.setTlsZoneState(TLS_ZONE_STATES.onDemand);
    vm.writeFile("/etc/caddy/Caddyfile", "# another Caddyfile\n");
    const r = await deployCaddy(["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("TO DEPOSIT /etc/caddy/Caddyfile");
    expect(vm.logs().filter((line) => line.startsWith("ACCEPTED") || line.startsWith("REFUSED"))).toEqual([]);
  });
});

describe("sitesolide deploy and remove keep the zone's sites for the ask endpoint", () => {
  const SHOWCASE: Manifest = { slug: "sample-zone", publicDir: "public" };
  const INSTALL = `ACCEPTED sudo install -m 644 -o sample -g sample /dev/stdin /srv/sites/${SHOWCASE.slug}/sitesolide.json`;

  function project(): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "project-zone-")));
    TEMP_DIRS.push(folder);
    writeFileSync(join(folder, "sitesolide.json"), `${JSON.stringify(SHOWCASE, null, 2)}\n`);
    mkdirSync(join(folder, "public"));
    writeFileSync(join(folder, "public", "index.html"), "<p>test</p>\n");
    return folder;
  }

  /** A configuration aiming at a zone that does not resolve: the final check reaches nobody. */
  function home(): Record<string, string> {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "home-zone-")));
    TEMP_DIRS.push(folder);
    mkdirSync(join(folder, ".config", "sitesolide"), { recursive: true });
    writeFileSync(join(folder, ".config", "sitesolide", "config.json"), JSON.stringify({ zone: TEST_ZONE, email: TEST_EMAIL }));
    return { HOME: folder, SITESOLIDE_CONFIG_DIR: join(folder, ".config", "sitesolide") };
  }

  test("a provider's zone: written again once the files are in place, nothing said, and the check fails at once as before", async () => {
    vm = createFakeVm();
    vm.writeManifest(SHOWCASE.slug, `${JSON.stringify(SHOWCASE, null, 2)}\n`);
    vm.acceptWrites();
    const started = Date.now();
    const r = await run(project(), ["deploy"], { vm, env: home() });
    expect(r.error).toContain(`https://${SHOWCASE.slug}.${TEST_ZONE}/ unreachable`);
    expect(Date.now() - started).toBeLessThan(FIRST_CERTIFICATE_MS / 3);
    const logs = vm.logs();
    expect(logs.indexOf(`ACCEPTED ${ZONE_NAMES_COMMAND}`)).toBeGreaterThan(logs.indexOf(INSTALL));
    expect(r.all).not.toContain(ZONE_NAMES_FILE);
    expect(r.all).not.toContain("no answer yet");
  });

  test("manual DNS: written again, said, and the check waits for the site's first certificate", async () => {
    vm = createFakeVm();
    vm.setTlsZoneState(TLS_ZONE_STATES.onDemand);
    vm.writeManifest(SHOWCASE.slug, `${JSON.stringify(SHOWCASE, null, 2)}\n`);
    vm.acceptWrites();
    const proc = Bun.spawn(["bun", CLI, "deploy"], {
      cwd: project(),
      stdout: "pipe",
      stderr: "pipe",
      env: { SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...process.env, ...vm.env, ...home() },
    });
    // Read until the wait is announced, then stopped: the zone resolves
    // nowhere, and the wait would last its whole bound.
    let output = "";
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 30_000;
    while (!output.includes("no answer yet") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    proc.kill();
    await proc.exited;
    expect(output).toContain(`${ZONE_NAMES_FILE}: 1 site(s) under the zone, which the ask endpoint allows`);
    expect(output).toContain(`no answer yet: the zone is certified on demand, and the site's first certificate is obtained by this handshake; asking again for up to ${FIRST_CERTIFICATE_MS / 1000} s`);
    expect(output.indexOf(ZONE_NAMES_FILE)).toBeLessThan(output.indexOf("no answer yet"));
  });

  test("remove: written again once the folder is gone, so that its name stops being certifiable", async () => {
    vm = createFakeVm();
    vm.setTlsZoneState(TLS_ZONE_STATES.onDemand);
    vm.writeManifest(SHOWCASE.slug, `${JSON.stringify(SHOWCASE, null, 2)}\n`);
    vm.acceptWrites();
    const r = await run(project(), ["remove", "--confirm", SHOWCASE.slug], { vm, env: home() });
    const logs = vm.logs();
    const gone = logs.indexOf(`ACCEPTED sudo rm -rf /srv/sites/${SHOWCASE.slug}`);
    expect(gone).toBeGreaterThan(-1);
    expect(logs.indexOf(`ACCEPTED ${ZONE_NAMES_COMMAND}`)).toBeGreaterThan(gone);
    expect(r.output).toContain(`${ZONE_NAMES_FILE}:`);
  });

  test("in a dry run, says it would write them, and writes nothing", async () => {
    const r = await run(project(), ["deploy", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain(`[dry-run] ${ZONE_NAMES_FILE}, the zone's sites for the ask endpoint, written again if the zone is certified on demand`);
  });
});

describe("bin/generate-domains.sh and the zone's sites", () => {
  test("a list that cannot be written again is said, and the table, already in service, stands", async () => {
    vm = createFakeVm();
    vm.setTlsZoneState(TLS_ZONE_STATES.onDemand);
    vm.acceptWrites([ZONE_NAMES_COMMAND]);
    const r = await deployCaddy([], "generate-domains.sh");
    expect(r.code).toBe(0);
    expect(r.error).toContain("/etc/caddy/zone-names could not be written again");
    const logs = vm.logs();
    const reload = lineWith(logs, "sudo systemctl reload caddy");
    expect(reload).toBeGreaterThan(-1);
    expect(lineWith(logs, "REFUSED", "zone-names")).toBeGreaterThan(reload);
    expect(logs).toContain("ACCEPTED sudo curl -fsS http://127.0.0.1:3001/health && echo");
  });
});
