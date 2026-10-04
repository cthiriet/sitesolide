import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, TEST_EMAIL, TEST_ZONE } from "./run";
import { createFakeVm, type FakeVm } from "./fake-vm";

/**
 * bin/deploy-monitor.sh, in front of the simulated VM.
 *
 * Every write is accepted without running anything, and every reading the
 * script makes gets the answer a machine would give, laid by the test. What is
 * checked is the order, which is the script's whole safety: nothing is sent
 * before the machine has been checked, nothing is enabled before one run has
 * passed by hand, and a refusal anywhere stops what follows. The name the
 * script is aimed at resolves nowhere, and the fake ssh answers no other.
 */

const ALERTING_STAT = "sudo stat -c '%u %a %F' /etc/sitesolide/dashboard-monitor.env";
const BUILT = mkdtempSync(join(tmpdir(), "monitor-bundle-"));
let fingerprint = "";
let vm: FakeVm;

beforeAll(() => {
  // The same build as the script's: bun build is reproducible, so the
  // fingerprint the machine reports for a faithful copy is this one.
  const build = Bun.spawnSync(["bun", "build", "monitor.ts", "--target=bun", "--outfile", join(BUILT, "monitor.js")], {
    cwd: join(REPO, "monitor"),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`bun build: ${build.stderr.toString()}`);
  fingerprint = new Bun.CryptoHasher("sha256").update(readFileSync(join(BUILT, "monitor.js"))).digest("hex");
});

afterAll(() => rmSync(BUILT, { recursive: true, force: true }));
afterEach(() => vm?.cleanup());

/** A machine where everything the script reads answers as a healthy one would. */
function healthyVm(alerting = "0 600 regular file", installed = fingerprint, refused: string[] = []): FakeVm {
  const machine = createFakeVm();
  machine.acceptWrites(refused);
  machine.answer(ALERTING_STAT, `${alerting}\n`);
  machine.answer("mktemp -d", "/tmp/tmp.sample\n");
  machine.answer("sha256sum /usr/local/lib/sitesolide/monitor.js", `${installed}  /usr/local/lib/sitesolide/monitor.js\n`);
  machine.answer("-p Result --value", "success\n");
  machine.answer("journalctl -u sitesolide-monitor.service", "16 checks, 0 down, 0 failing; heartbeat ok, webhook idle\n");
  machine.answer("is-active sitesolide-monitor.timer", "active\n");
  return machine;
}

async function deployMonitor(): Promise<{ code: number; output: string; error: string }> {
  const proc = Bun.spawn(["bash", join(REPO, "bin", "deploy-monitor.sh")], {
    stdout: "pipe",
    stderr: "pipe",
    // A zone that resolves nowhere: bin/config.sh refuses to guess a machine.
    env: { SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...process.env, ...vm.env },
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error };
}

/** The commands the machine received, in order, without the ACCEPTED prefix. */
function commands(): string[] {
  return vm.logs().map((line) => line.replace(/^ACCEPTED /, ""));
}

function position(fragment: string): number {
  return commands().findIndex((command) => command.includes(fragment));
}

describe("bin/deploy-monitor.sh", () => {
  test("checks, sends, installs, verifies, runs once by hand, then enables the timer", async () => {
    vm = healthyVm();
    const r = await deployMonitor();
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    expect(r.output).toContain("alerting set in /etc/sitesolide/dashboard-monitor.env");
    expect(r.output).toContain("16 checks, 0 down, 0 failing; heartbeat ok, webhook idle");
    expect(vm.logs().filter((line) => line.startsWith("REFUSED"))).toEqual([]);

    const order = [
      "test -x /usr/local/bin/bun",
      ALERTING_STAT,
      "rsync -a",
      "sudo install -D -m 0644 -o root -g root /tmp/tmp.sample/monitor.js /usr/local/lib/sitesolide/monitor.js",
      "/tmp/tmp.sample/sitesolide-monitor.timer /etc/systemd/system/sitesolide-monitor.timer",
      "sudo systemctl daemon-reload",
      "sha256sum /usr/local/lib/sitesolide/monitor.js",
      "systemd-analyze verify",
      "sudo systemctl start sitesolide-monitor.service",
      "-p Result --value",
      "sudo test -s /var/lib/sitesolide-monitor/status.json",
      "sudo systemctl enable --now sitesolide-monitor.timer",
      "is-active sitesolide-monitor.timer",
    ].map(position);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // What leaves is the bundle and the two unit files.
    const rsync = commands().find((command) => command.startsWith("rsync"))!;
    expect(rsync).toContain("/monitor.js");
    expect(rsync).toContain("infra/monitor/sitesolide-monitor.service");
    expect(rsync).toContain("infra/monitor/sitesolide-monitor.timer");
    expect(rsync).toContain("sample@invalid.local:/tmp/tmp.sample/");

    // Nothing else on the machine: not Caddy, not the dashboard, no other unit.
    const foreign = /systemctl \S+ caddy|caddy (stop|start|reload)|dashboard\.service|systemctl restart/;
    expect(commands().filter((command) => foreign.test(command))).toEqual([]);
  });

  test("with no alerting file it goes on, and says the journal is all there will be", async () => {
    vm = healthyVm("missing");
    const r = await deployMonitor();
    expect(r.code).toBe(0);
    expect(r.output).toContain("the monitor will write to the journal only");
  });

  test("an alerting file that is not root's 0600 stops everything before anything is sent", async () => {
    vm = healthyVm("1001 644 regular file");
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("is '1001 644 regular file', expected 0 600 regular file (root:root 0600)");
    expect(r.error).toContain("sudo chown root:root /etc/sitesolide/dashboard-monitor.env");
    expect(position("rsync")).toBe(-1);
    expect(position("sudo install")).toBe(-1);
  });

  test("a machine without the zone file stops before anything is sent", async () => {
    vm = healthyVm("0 600 regular file", fingerprint, ["test -f /etc/caddy/sitesolide.env"]);
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("/etc/caddy/sitesolide.env is placed by bin/deploy-caddy.sh");
    expect(position("rsync")).toBe(-1);
  });

  test("an installed file that is not the build stops before the first run", async () => {
    vm = healthyVm("0 600 regular file", "0".repeat(64));
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("the installed file does not match the local build");
    expect(position("systemctl start sitesolide-monitor")).toBe(-1);
    expect(position("enable --now")).toBe(-1);
  });

  test("a first run that fails leaves the timer off, and points at the journal", async () => {
    vm = healthyVm("0 600 regular file", fingerprint, ["sudo systemctl start sitesolide-monitor.service"]);
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("the first run failed");
    expect(r.error).toContain("sudo journalctl -u sitesolide-monitor -n 50");
    expect(position("enable --now")).toBe(-1);
  });
});
