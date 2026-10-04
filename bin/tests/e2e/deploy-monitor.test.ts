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
 * checked is the order, which is the script's whole safety: nothing is made or
 * sent before the machine has been checked, the account exists and holds its
 * state before the unit that names it is installed, nothing is enabled before
 * one run has passed by hand, and a refusal anywhere stops what follows. The
 * name the script is aimed at resolves nowhere, and the fake ssh answers no
 * other.
 */

const ALERTING_STAT = "sudo stat -c '%u %a %F' /etc/sitesolide/dashboard-monitor.env";
const ACCOUNT = "sitesolide-monitor";
const USERADD = `sudo env SYSTEMD_NSS_DYNAMIC_BYPASS=1 useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${ACCOUNT}`;
/** Who owns the state directory before anything is installed, through the DynamicUser unit's link if there is one. */
const STATE_STAT = "sudo stat -L -c '%U:%G' /var/lib/sitesolide-monitor";
const STATE_CHOWN = `sudo chown -R ${ACCOUNT}:${ACCOUNT} /var/lib/sitesolide-monitor/`;
/** What the state directory is after the first run. */
const LAYOUT_STAT = "sudo stat -c '%F %U:%G' /var/lib/sitesolide-monitor";
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

type Machine = {
  /** The alerting file's `stat`, or `missing`. */
  alerting?: string;
  /** The fingerprint of the installed bundle. */
  installed?: string;
  /** The writes that fail. */
  refused?: string[];
  /** The account already made, as on a machine that ran this script before. */
  account?: boolean;
  /** Who owns the state directory before the installation, or `missing`. */
  state?: string;
  /** What the state directory is after the first run. */
  layout?: string;
};

/**
 * A machine where everything the script reads answers as a healthy one would:
 * by default one where the monitor never ran, with no account and no state.
 */
function healthyVm(machine: Machine = {}): FakeVm {
  const {
    alerting = "0 600 regular file",
    installed = fingerprint,
    refused = [],
    account = false,
    state = "missing",
    layout = `directory ${ACCOUNT}:${ACCOUNT}`,
  } = machine;
  const fake = createFakeVm();
  fake.acceptWrites(refused);
  if (account) fake.addAccount(ACCOUNT, 996);
  fake.answer(ALERTING_STAT, `${alerting}\n`);
  fake.answer(STATE_STAT, `${state}\n`);
  fake.answer("mktemp -d", "/tmp/tmp.sample\n");
  fake.answer("sha256sum /usr/local/lib/sitesolide/monitor.js", `${installed}  /usr/local/lib/sitesolide/monitor.js\n`);
  fake.answer("-p Result --value", "success\n");
  fake.answer(LAYOUT_STAT, `${layout}\n`);
  fake.answer("journalctl -u sitesolide-monitor.service", "16 checks, 0 down, 0 failing; heartbeat ok, webhook idle\n");
  fake.answer("is-active sitesolide-monitor.timer", "active\n");
  return fake;
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

function count(fragment: string): number {
  return commands().filter((command) => command.includes(fragment)).length;
}

/** Every fragment received, each after the one before it. */
function inOrder(fragments: string[]): void {
  const order = fragments.map(position);
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
}

describe("bin/deploy-monitor.sh", () => {
  test("checks, makes the account, sends, installs, verifies, runs once by hand, then enables the timer", async () => {
    vm = healthyVm();
    const r = await deployMonitor();
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    expect(r.output).toContain("alerting set in /etc/sitesolide/dashboard-monitor.env");
    expect(r.output).toContain(`${ACCOUNT} created`);
    expect(r.output).toContain("no state yet: the first run makes /var/lib/sitesolide-monitor, the account's");
    expect(r.output).toContain("16 checks, 0 down, 0 failing; heartbeat ok, webhook idle");
    expect(vm.logs().filter((line) => line.startsWith("REFUSED"))).toEqual([]);

    inOrder([
      "test -x /usr/local/bin/bun",
      ALERTING_STAT,
      `ACCOUNT ${ACCOUNT}`,
      USERADD,
      STATE_STAT,
      "rsync -a",
      "sudo install -D -m 0644 -o root -g root /tmp/tmp.sample/monitor.js /usr/local/lib/sitesolide/monitor.js",
      "/tmp/tmp.sample/sitesolide-monitor.service /etc/systemd/system/sitesolide-monitor.service",
      "/tmp/tmp.sample/sitesolide-monitor.timer /etc/systemd/system/sitesolide-monitor.timer",
      "sudo systemctl daemon-reload",
      "sha256sum /usr/local/lib/sitesolide/monitor.js",
      "systemd-analyze verify",
      "sudo systemctl start sitesolide-monitor.service",
      "-p Result --value",
      "sudo test -s /var/lib/sitesolide-monitor/status.json",
      LAYOUT_STAT,
      "sudo systemctl enable --now sitesolide-monitor.timer",
      "is-active sitesolide-monitor.timer",
    ]);

    // What leaves is the bundle and the two unit files.
    const rsync = commands().find((command) => command.startsWith("rsync"))!;
    expect(rsync).toContain("/monitor.js");
    expect(rsync).toContain("infra/monitor/sitesolide-monitor.service");
    expect(rsync).toContain("infra/monitor/sitesolide-monitor.timer");
    expect(rsync).toContain("sample@invalid.local:/tmp/tmp.sample/");

    // Nothing else on the machine: not Caddy, not the dashboard, no other unit.
    const foreign = /systemctl \S+ caddy|caddy (stop|start|reload)|dashboard\.service|systemctl restart/;
    expect(commands().filter((command) => foreign.test(command))).toEqual([]);
    // No state to hand over on a machine where the monitor never ran, and the
    // account is there for the unit that names it.
    expect(position("chown")).toBe(-1);
    expect(vm.accounts()).toEqual([`${ACCOUNT}:x:999:999::/nonexistent:/usr/sbin/nologin`]);
  });

  test("the account is made once: a second run finds it and makes nothing", async () => {
    vm = healthyVm();
    expect((await deployMonitor()).code).toBe(0);
    const second = await deployMonitor();
    expect(second.code).toBe(0);
    expect(second.output).toContain(`${ACCOUNT} exists, uid 999`);
    expect(count("useradd")).toBe(1);
    expect(count(`ACCOUNT ${ACCOUNT}`)).toBe(2);
  });

  test("on a machine that already has the account and its state, nothing is made and nothing handed over", async () => {
    vm = healthyVm({ account: true, state: `${ACCOUNT}:${ACCOUNT}` });
    const r = await deployMonitor();
    expect(r.code).toBe(0);
    expect(r.output).toContain(`${ACCOUNT} exists, uid 996`);
    expect(r.output).toContain("/var/lib/sitesolide-monitor is the account's");
    expect(position("useradd")).toBe(-1);
    expect(position("chown")).toBe(-1);
  });

  test("the state the DynamicUser unit left is handed to the account, through its link, before the new unit is installed", async () => {
    // What systemd 257 left in /var/lib/private: the nobody user's, which it
    // would ID-map again rather than chown once the unit names the account.
    vm = healthyVm({ state: "nobody:nogroup" });
    const r = await deployMonitor();
    expect(r.code).toBe(0);
    expect(r.output).toContain(`/var/lib/sitesolide-monitor was nobody:nogroup, handed to ${ACCOUNT} with the state it holds`);
    inOrder([
      USERADD,
      STATE_STAT,
      STATE_CHOWN,
      "rsync -a",
      "/etc/systemd/system/sitesolide-monitor.service",
      "sudo systemctl daemon-reload",
      "sudo systemctl start sitesolide-monitor.service",
    ]);
    expect(count("chown")).toBe(1);
  });

  test("an older systemd's dynamic uid, which stat cannot name, is handed over the same way", async () => {
    vm = healthyVm({ account: true, state: "UNKNOWN:UNKNOWN" });
    const r = await deployMonitor();
    expect(r.code).toBe(0);
    inOrder([STATE_STAT, STATE_CHOWN, "sudo systemctl daemon-reload"]);
  });

  test("a state directory that is not a plain directory of the account's after the first run leaves the timer off", async () => {
    vm = healthyVm({ layout: "symbolic link root:root" });
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain(`/var/lib/sitesolide-monitor is 'symbolic link root:root', expected a directory of ${ACCOUNT}:${ACCOUNT}`);
    expect(position("enable --now")).toBe(-1);
  });

  test("an account that cannot be made stops before anything is sent", async () => {
    vm = healthyVm({ refused: ["useradd"] });
    const r = await deployMonitor();
    expect(r.code).not.toBe(0);
    expect(position("rsync")).toBe(-1);
    expect(position("sudo install")).toBe(-1);
  });

  test("with no alerting file it goes on, and says the journal is all there will be", async () => {
    vm = healthyVm({ alerting: "missing" });
    const r = await deployMonitor();
    expect(r.code).toBe(0);
    expect(r.output).toContain("the monitor will write to the journal only");
  });

  test("an alerting file that is not root's 0600 stops everything before anything is made or sent", async () => {
    vm = healthyVm({ alerting: "1001 644 regular file" });
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("is '1001 644 regular file', expected 0 600 regular file (root:root 0600)");
    expect(r.error).toContain("sudo chown root:root /etc/sitesolide/dashboard-monitor.env");
    expect(position("useradd")).toBe(-1);
    expect(position("rsync")).toBe(-1);
    expect(position("sudo install")).toBe(-1);
  });

  test("a machine without the zone file stops before anything is made or sent", async () => {
    vm = healthyVm({ refused: ["test -f /etc/caddy/sitesolide.env"] });
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("/etc/caddy/sitesolide.env is placed by bin/deploy-caddy.sh");
    expect(position("useradd")).toBe(-1);
    expect(position("rsync")).toBe(-1);
  });

  test("an installed file that is not the build stops before the first run", async () => {
    vm = healthyVm({ installed: "0".repeat(64) });
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("the installed file does not match the local build");
    expect(position("systemctl start sitesolide-monitor")).toBe(-1);
    expect(position("enable --now")).toBe(-1);
  });

  test("a first run that fails leaves the timer off, and points at the journal", async () => {
    vm = healthyVm({ refused: ["sudo systemctl start sitesolide-monitor.service"] });
    const r = await deployMonitor();
    expect(r.code).toBe(1);
    expect(r.error).toContain("the first run failed");
    expect(r.error).toContain("sudo journalctl -u sitesolide-monitor -n 50");
    expect(position("enable --now")).toBe(-1);
  });
});
