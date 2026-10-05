import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HINT, hintFor } from "../cli/hints";
import {
  accountRun,
  closeSsh,
  directoriesRun,
  fail2banRelease,
  fail2banRun,
  firewallRun,
  packagesRun,
  sshDisarm,
  sshRun,
  updatesRun,
  type HardenContext,
} from "../cli/harden";
import {
  caddyUnitRun,
  chooseAddresses,
  configGuard,
  judgeFacts,
  machineAddresses,
  MARKER_NAME,
  parseSetupArguments,
  portalPasswordRun,
  preflightAccounts,
  preflightScript,
  readFacts,
  REFUSALS,
  runSetup,
  setupOutput,
  tokenCheck,
  tokenRun,
  type Facts,
  type SetupOptions,
} from "../cli/setup";
import { startCloudflareMock, type CloudflareMock } from "./cloudflare-mock";
import { bench, EMAIL, HOST, IPV6, PORTAL_HASH, PORTAL_PASSWORD, printed, TOKEN, ZONE, type Bench } from "./setup-fakes";

/**
 * `sitesolide setup`, the whole sequence, against a model of the machine: see
 * setup-fakes.ts. Nothing here opens a connection. The machine is a set of
 * labels its checks report, the kit's scripts are recorded, Cloudflare is a
 * mock on the loopback and the resolver reads that mock's records.
 *
 * What has to hold: the order docs/install.md verified; a second run that
 * changes nothing; a failure that names its step and a run that resumes there;
 * ssh closed to root only once a login as the deploy account is proven; a
 * configuration that names another machine stopping everything before the
 * first connection; and the token and the passwords out of every output.
 */

const HOMES: string[] = [];
let mock: CloudflareMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const folder = mkdtempSync(join(tmpdir(), "setup-home-"));
  HOMES.push(folder);
  return folder;
}

function options(...extra: string[]): SetupOptions {
  const parsed = parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, ...extra]);
  if ("message" in parsed) throw new Error(parsed.message);
  return parsed;
}

function world(machine: Parameters<typeof bench>[2] = {}, mockOptions: Partial<Parameters<typeof startCloudflareMock>[0]> = {}): { b: Bench; home: string; mock: CloudflareMock } {
  mock = startCloudflareMock({ token: TOKEN, zones: [{ id: "zone-1", name: ZONE }], ...mockOptions });
  const folder = home();
  return { b: bench(mock, folder, machine), home: folder, mock };
}

async function setup(b: Bench, given: SetupOptions = options(), print = printed()) {
  const code = await runSetup(given, b.deps(print));
  return { code, print, statuses: print.checks.map((report) => `${report.step}:${report.status}`) };
}

const ORDER = [
  "preflight",
  "configuration",
  "dns",
  "packages",
  "account",
  "firewall",
  "updates",
  "directories",
  "ssh",
  "fail2ban",
  "caddy",
  "bun",
  "cloudflare-token",
  "resolution",
  "caddy-zone",
  "caddy-unit",
  "caddy-config",
  "api",
  "gatekeeper",
  "dashboard-password",
  "dashboard",
  "steward",
  "collector",
  "portal-password",
  "portal",
  "loopback",
  "monitor",
  "backups",
  "installer",
  "egress",
];

describe("a blank machine", () => {
  test("every step, in the order docs/install.md verified, then the summary", async () => {
    const { b, home: folder, mock: m } = world();
    const r = await setup(b);
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    // The records made at the start had the whole install to propagate: by
    // the time Caddy needs them, the resolver already sees them.
    expect(r.statuses).toEqual(ORDER.map((step) => `${step}:${step === "resolution" ? "done" : "ok"}`));

    // The kit's scripts, in the brief's order, Caddy's drop-in between the two
    // runs of deploy-caddy.sh.
    const kit = b.timeline.filter((line) => line.startsWith("kit ") || line.endsWith("setup:caddy-unit:run"));
    expect(kit).toEqual([
      "kit deploy-caddy.sh",
      "deploy setup:caddy-unit:run",
      "kit deploy-caddy.sh",
      "kit deploy-api.sh",
      "kit deploy-gatekeeper.sh",
      "kit dashboard-password.sh",
      "kit deploy dashboard",
      "kit deploy-steward.sh",
      "kit deploy-collector.sh",
      "kit deploy portal",
      "kit deploy-loopback.sh close",
      "kit deploy-monitor.sh",
      "kit deploy-backup.sh install",
      "kit deploy-steward.sh",
      "kit deploy-backup.sh enable",
      "kit deploy-installer.sh",
      "kit deploy-egress.sh",
      "kit deploy-steward.sh",
    ]);

    // The portal's hash went before the portal's deploy, its account first.
    const portalRun = b.machine.calls.find((call) => call.tag === "setup:portal-password:run")!;
    expect(portalRun.input).toContain(`PASSWORD_HASH=${PORTAL_HASH}`);
    expect(portalRun.input.indexOf("useradd --system --no-create-home --shell /usr/sbin/nologin site-portal")).toBeLessThan(portalRun.input.indexOf("PASSWORD_HASH"));
    expect(portalRun.input).toContain("install -m 600 -o site-portal -g site-portal /dev/stdin /etc/sitesolide/portal.env");

    // The records, at the start, and the configuration as init writes it.
    expect(m.records.map((record) => `${record.name} ${record.type} ${record.content}`).sort()).toEqual([
      `*.${ZONE} A ${HOST}`,
      `*.${ZONE} AAAA ${IPV6}`,
      `${ZONE} A ${HOST}`,
      `${ZONE} AAAA ${IPV6}`,
    ]);
    const config = JSON.parse(readFileSync(join(folder, ".config", "sitesolide", "config.json"), "utf8"));
    expect(config).toEqual({ server: `deploy@${HOST}`, zone: ZONE, email: EMAIL });
    const marker = JSON.parse(readFileSync(join(folder, ".config", "sitesolide", MARKER_NAME), "utf8"));
    expect(marker.server).toBe(`deploy@${HOST}`);

    // Every script ran with the settings of the machine being installed.
    for (const task of b.kit.tasks) {
      expect(task.environment.SITESOLIDE_SERVER).toBe(`deploy@${HOST}`);
      expect(task.environment.SITESOLIDE_ZONE).toBe(ZONE);
      expect(task.environment.SITESOLIDE_EMAIL).toBe(EMAIL);
    }

    const result = r.print.results[0]!;
    expect(result.dashboard).toBe(`https://dashboard.${ZONE}`);
    expect(result.portal).toBe(`https://portal.${ZONE}`);
    expect(result.already).toEqual(["resolution"]);
    expect(r.print.lines).toContain(`-> sitesolide is installed on deploy@${HOST}`);
    expect(r.print.lines.join("\n")).toContain("sitesolide deploy");
    expect(r.print.lines.join("\n")).toContain("monitor/README.md");
  });

  test("the same command again reads everything and changes nothing", async () => {
    const { b, mock: m } = world();
    expect((await setup(b)).code).toBe(0);
    const runs = b.machine.runs().length;
    const tasks = b.kit.tasks.length;
    const writes = m.writes().length;
    const drawn = b.drawn.count;

    const again = await setup(b);
    expect(again.code).toBe(0);
    // root may no longer log in: setup's marker says so, and the second run
    // goes through the deploy account without knocking as root first.
    expect(again.print.lines).toContain("   root may no longer log in: going on as deploy");
    expect(again.print.errors).toEqual([]);
    expect(b.machine.refusedLogins).toEqual([]);
    expect(again.statuses).toEqual(["preflight:ok", ...ORDER.slice(1).map((step) => `${step}:done`)]);
    expect(b.machine.runs().length).toBe(runs);
    expect(b.kit.tasks.length).toBe(tasks);
    expect(m.writes().length).toBe(writes);
    expect(b.drawn.count).toBe(drawn);
    expect(again.print.secrets).toEqual([]);
    expect(again.print.lines).toContain(`-> deploy@${HOST} was already installed: nothing was changed`);
    expect(again.print.results[0]!.ran).toEqual([]);
  });
});

describe("a failure, then the same command again", () => {
  test("stops at the step, says what to inspect and how to resume; the next run starts there", async () => {
    const { b } = world();
    b.kit.failing.add("deploy-api.sh");
    const first = await setup(b);
    expect(first.code).toBe(1);
    expect(first.statuses.at(-1)).toBe("api:fail");
    expect(first.statuses).not.toContain("gatekeeper:ok");
    const error = first.print.errors[0]!;
    expect(error.message).toBe("setup stopped at api: bin/deploy-api.sh failed (exit code 1)");
    expect(error.details).toContain(`inspect: ssh deploy@${HOST} 'sudo journalctl -u sitesolide-api -n 50'`);
    expect(error.details).toContain("run the same command again to resume: the steps already done are skipped");
    expect(hintFor(error.message)).toContain("resumes at that step");

    const before = b.machine.runs().length;
    const second = await setup(b);
    expect(second.code).toBe(0);
    const index = ORDER.indexOf("api");
    expect(second.statuses.slice(1, index)).toEqual(ORDER.slice(1, index).map((step) => `${step}:done`));
    expect(second.statuses[index]).toBe("api:ok");
    // Nothing done before the failure ran again: no run on the machine for
    // the hardening or Caddy, and no second dashboard password.
    const rerun = b.machine.runs().slice(before);
    expect(rerun).toEqual(["setup:portal-password:run"]);
    expect(b.kit.tasks.filter((task) => task.name === "dashboard-password.sh")).toHaveLength(1);
  });

  test("a run on the machine that fails stops there too, with the end of what it said", async () => {
    const { b } = world();
    b.machine.failing.add("setup:caddy:run");
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("setup stopped at caddy: Caddy could not be installed (exit code 1)");
    expect(r.print.errors[0]!.details).toContain("E: the run of caddy broke");
  });

  test("the portal's password drawn before a failure is still shown, once", async () => {
    const { b } = world();
    b.kit.failing.add("deploy portal");
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.secrets).toHaveLength(1);
    expect(r.print.secrets[0]!.join("\n")).toContain(PORTAL_PASSWORD);
  });
});

describe("closing ssh to root", () => {
  test("the proof comes first, and every command after the change goes through the deploy account", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    const tags = b.machine.calls.map((call) => `${call.account} ${call.tag}`);
    const proof = tags.indexOf("deploy sudo -n true");
    const change = tags.indexOf("root setup:ssh:run");
    expect(proof).toBeGreaterThan(tags.indexOf("root setup:account:run"));
    expect(proof).toBeLessThan(change);
    // After the change: a second login reads the settings in effect, then disarms.
    expect(tags.slice(change + 1, change + 3)).toEqual(["deploy setup:ssh:check", "deploy setup:ssh:disarm"]);
    expect(b.machine.calls.slice(change + 1).every((call) => call.account === "deploy")).toBe(true);
    expect(b.machine.logins.has("root")).toBe(false);
  });

  test("a login as the deploy account that cannot be proven leaves sshd exactly as it was", async () => {
    const { b } = world();
    b.machine.breakProof = true;
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.statuses.at(-1)).toBe("ssh:fail");
    expect(r.print.errors[0]!.message).toBe(`setup stopped at ssh: no login as deploy@${HOST} could be proven: sshd was left exactly as it was`);
    expect(b.machine.runs()).not.toContain("setup:ssh:run");
    expect(b.machine.logins.has("root")).toBe(true);
    expect(hintFor(r.print.errors[0]!.message)).toContain("never edit sshd's configuration by hand");
  });

  test("the change: sshd -t before the reload, a safety net armed before it, the drop-in read first", () => {
    const script = sshRun();
    const lines = script.split("\n");
    const check = lines.findIndex((line) => line.includes("sshd -t"));
    const arm = lines.findIndex((line) => line.startsWith("systemd-run") && line.includes("sitesolide-ssh-rollback"));
    const reload = lines.findIndex((line) => line.startsWith("systemctl reload ssh"));
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(arm);
    expect(arm).toBeLessThan(reload);
    expect(script).toContain("--on-active=120");
    expect(script).toContain("/etc/ssh/sshd_config.d/00-sitesolide.conf");
    // A refused drop-in is withdrawn, and the previous one put back.
    expect(script).toContain('if [ -f "$drop_in.before" ]; then mv "$drop_in.before" "$drop_in"; else rm -f "$drop_in"; fi');
    for (const setting of ["PermitRootLogin no", "PasswordAuthentication no", "KbdInteractiveAuthentication no"]) expect(script).toContain(setting);
    expect(sshDisarm()).toContain("systemctl stop sitesolide-ssh-rollback.timer");
  });

  test("a change sshd refuses stops the step, and nothing runs as the deploy account after it", async () => {
    const calls: string[] = [];
    const context: HardenContext = {
      host: HOST,
      operator: "root",
      deployUser: "deploy",
      sshPort: 22,
      accountReady: true,
      clientAddress: null,
      ignoredAddress: null,
      machine: {
        exec: async (account, command, given = {}) => {
          calls.push(`${account} ${command}`);
          if (command.includes("setup:ssh:run")) return { code: 1, output: "", error: "sshd -t refused the configuration: the drop-in was withdrawn, nothing was reloaded" };
          return { code: 0, output: given.input?.includes("check") ? "check: done\n" : "", error: "" };
        },
      },
    };
    await expect(closeSsh(context)).rejects.toThrow("sshd refused the change");
    expect(calls).toEqual(["deploy sudo -n true", "root sh -s setup:ssh:run"]);
    expect(context.operator).toBe("root");
  });

  test("connected as a sudoer, the hardening goes through sudo -n, and that account deploys", async () => {
    const { b } = world({ sudoer: { name: "admin", sudo: true }, deployUser: "admin" });
    const given = parseSetupArguments([`admin@${HOST}`, "--zone", ZONE, "--email", EMAIL]);
    if ("message" in given) throw new Error(given.message);
    expect(given.user).toBe("admin");
    const r = await setup(b, given);
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    const scripts = b.machine.calls.filter((call) => call.tag.startsWith("setup:") && call.tag !== "setup:preflight:read");
    expect(scripts.every((call) => call.account === "admin" && call.command.startsWith("sudo -n sh -s "))).toBe(true);
    // No keys to copy from oneself.
    expect(b.machine.calls.find((call) => call.tag === "setup:account:check")!.input).not.toContain("ssh-keys");
  });

  test("the firewall keeps the port ssh answered on, opened before the default turns to deny", () => {
    const script = firewallRun(2222);
    expect(script).toContain("for port in 80 443 2222; do");
    expect(script.indexOf("ufw allow")).toBeLessThan(script.indexOf("ufw default deny incoming"));
    expect(script.indexOf("ufw default deny incoming")).toBeLessThan(script.indexOf("ufw --force enable"));
  });
});

describe("the configuration already on the workstation", () => {
  function configure(folder: string, config: Record<string, string>, marker?: Record<string, string>): void {
    const dir = join(folder, ".config", "sitesolide");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    if (marker !== undefined) writeFileSync(join(dir, MARKER_NAME), JSON.stringify(marker));
  }

  test("another server: refused before the first connection, and the file left as it was", async () => {
    const { b, home: folder } = world();
    const config = { server: "deploy@198.51.100.7", zone: ZONE, email: EMAIL };
    configure(folder, config);
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("the configuration names another server: deploy@198.51.100.7");
    expect(r.print.errors[0]!.details.join("\n")).toContain("--config-dir <dir>");
    expect(hintFor(r.print.errors[0]!.message)).toContain("do not edit, move or delete that configuration");
    expect(b.machine.calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(folder, ".config", "sitesolide", "config.json"), "utf8"))).toEqual(config);
    expect(existsSync(join(folder, ".config", "sitesolide", MARKER_NAME))).toBe(false);
  });

  test("another zone, or another account: refused the same way", async () => {
    const zone = world();
    configure(zone.home, { server: `deploy@${HOST}`, zone: "other-zone.invalid", email: EMAIL });
    const r = await setup(zone.b);
    expect(r.print.errors[0]!.message).toBe("the configuration names another zone: other-zone.invalid");
    expect(zone.b.machine.calls).toEqual([]);
    await mock?.stop();

    const account = world();
    configure(account.home, { server: `clement@${HOST}`, zone: ZONE, email: EMAIL });
    const s = await setup(account.b);
    expect(s.print.errors[0]!.message).toBe(`the configuration names another account on this server: clement@${HOST}`);
    expect(s.print.errors[0]!.details).toContain("pass --user clement to keep it");
    expect(account.b.machine.calls).toEqual([]);
  });

  test("SITESOLIDE_SERVER in the environment counts as the configuration does", async () => {
    const { b } = world();
    const print = printed();
    const code = await runSetup(options(), b.deps(print, { environment: { SITESOLIDE_SERVER: "deploy@198.51.100.7" } }));
    expect(code).toBe(1);
    expect(print.errors[0]!.message).toBe("the configuration names another server: deploy@198.51.100.7");
  });

  test("this very machine, installed without setup: only read, and refused while a step is not done", async () => {
    const { b, home: folder, mock: m } = world();
    configure(folder, { server: `deploy@${HOST}`, zone: ZONE, email: EMAIL });
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`${HOST} is the configured server, installed without setup, and setup would change it`);
    expect(r.print.errors[0]!.details[0]).toStartWith("not done: dns");
    expect(b.machine.runs()).toEqual([]);
    expect(b.kit.tasks).toEqual([]);
    expect(m.requests).toEqual([]);
  });

  test("this very machine, installed without setup, every step done: a report, and nothing changed", async () => {
    const { b, home: folder, mock: m } = world();
    expect((await setup(b)).code).toBe(0);
    rmSync(join(folder, ".config", "sitesolide", MARKER_NAME));
    const runs = b.machine.runs().length;
    const writes = m.writes().length;
    const r = await setup(b);
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.print.lines).toContain("-> every step is done: nothing to do");
    expect(r.statuses.slice(1).every((status) => status.endsWith(":done"))).toBe(true);
    expect(b.machine.runs().length).toBe(runs);
    expect(m.writes().length).toBe(writes);
  });

  test("setup's own install, stopped half way: resumed, and said so", async () => {
    const { b, home: folder } = world();
    b.kit.failing.add("deploy-api.sh");
    expect((await setup(b)).code).toBe(1);
    const r = await setup(b);
    expect(r.code).toBe(0);
    expect(r.print.lines).toContain(`   resuming the install ${join(folder, ".config", "sitesolide", "config.json")} records`);
  });

  test("a marker left by an install whose configuration is gone is replaced, not trusted", async () => {
    const { b, home: folder } = world();
    const dir = join(folder, ".config", "sitesolide");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER_NAME), JSON.stringify({ server: "deploy@198.51.100.7", zone: "old.invalid", startedAt: "" }));
    expect((await setup(b)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, MARKER_NAME), "utf8"))).toMatchObject({ server: `deploy@${HOST}`, zone: ZONE });
  });

  test("a team member's configuration, with an address and no server, is completed and kept", async () => {
    const { b, home: folder } = world();
    configure(folder, { api: `https://dashboard.${ZONE}`, vault: "~/vault" });
    expect((await setup(b)).code).toBe(0);
    const config = JSON.parse(readFileSync(join(folder, ".config", "sitesolide", "config.json"), "utf8"));
    expect(config).toEqual({ server: `deploy@${HOST}`, zone: ZONE, email: EMAIL, vault: "~/vault", api: `https://dashboard.${ZONE}` });
  });

  test("the guard compares machines, not spellings", async () => {
    const machines = { "web.example.invalid": [HOST], [HOST]: [HOST] } as Record<string, string[]>;
    const same = async (a: string, b: string) => (machines[a] ?? [a]).some((address) => (machines[b] ?? [b]).includes(address));
    const wanted = { host: HOST, user: "deploy", zone: ZONE };
    expect((await configGuard("c", { server: "deploy@web.example.invalid", zone: ZONE }, null, wanted, same)).kind).toBe("installed");
    expect((await configGuard("c", { server: "deploy@web.example.invalid", zone: ZONE }, { server: `deploy@${HOST}`, zone: ZONE, startedAt: "" }, wanted, same)).kind).toBe("ours");
    expect((await configGuard("c", {}, null, wanted, same)).kind).toBe("fresh");
    expect((await configGuard("c", { zone: ZONE }, null, wanted, same)).kind).toBe("fresh");
    // A marker for another zone is not this install's.
    expect((await configGuard("c", { server: `deploy@${HOST}`, zone: ZONE }, { server: `deploy@${HOST}`, zone: "x.invalid", startedAt: "" }, wanted, same)).kind).toBe("installed");
  });

  test("SITESOLIDE_CONFIG_DIR: a second installation's folder, which every script receives", async () => {
    const { b, home: folder } = world();
    configure(folder, { server: "deploy@198.51.100.7", zone: "production.invalid", email: EMAIL });
    const second = join(folder, "second");
    const print = printed();
    const code = await runSetup(options(), b.deps(print, { environment: { SITESOLIDE_CONFIG_DIR: second } }));
    expect(print.errors).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(second, "config.json"), "utf8")).server).toBe(`deploy@${HOST}`);
    expect(JSON.parse(readFileSync(join(folder, ".config", "sitesolide", "config.json"), "utf8")).server).toBe("deploy@198.51.100.7");
    for (const task of b.kit.tasks) expect(task.environment.SITESOLIDE_CONFIG_DIR).toBe(second);
    expect(print.lines.join("\n")).toContain(`SITESOLIDE_CONFIG_DIR=${second} sitesolide deploy`);
  });
});

describe("the preflight", () => {
  test("a system other than Debian 13 is refused after one read, unless --any-os", async () => {
    const { b } = world({ facts: { os: "ubuntu", version: "24.04", system: "Ubuntu 24.04.1 LTS" } });
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`${HOST} runs Ubuntu 24.04.1 LTS, not Debian 13`);
    expect(hintFor(r.print.errors[0]!.message)).toContain("--any-os is the owner's decision alone");
    expect(b.machine.calls.map((call) => call.tag)).toEqual(["setup:preflight:read"]);

    const anyway = await setup(b, options("--any-os"));
    expect(anyway.code).toBe(0);
  });

  test("an account without passwordless sudo, too little disk, another zone: refused before any step", () => {
    const facts: Facts = { os: "debian", version: "13", system: "Debian", architecture: "amd64", uid: 1000, freeKb: 40 * 1024 * 1024, sshPort: 22, clientAddress: null, sudo: "yes", zone: null, ipv4: HOST, ipv6: null };
    const given = { host: HOST, zone: ZONE, anyOs: false };
    expect(judgeFacts(facts, given, "admin")).toBeNull();
    expect(judgeFacts({ ...facts, sudo: "no" }, given, "admin")?.message).toBe(`admin@${HOST} has no sudo without a password`);
    expect(judgeFacts({ ...facts, freeKb: 1024 * 1024 }, given, "admin")?.message).toBe(`only 1.0 GB free on / of ${HOST}, setup needs 2 GB`);
    expect(judgeFacts({ ...facts, zone: "production.invalid" }, given, "admin")?.message).toBe(`${HOST} already serves the zone production.invalid`);
    expect(judgeFacts({ ...facts, architecture: "riscv64" }, given, "admin")?.message).toBe(`unsupported architecture on ${HOST}: riscv64`);
  });

  test("a machine nobody can log into: unreachable, nothing else tried", async () => {
    const { b } = world();
    b.machine.logins.clear();
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`cannot reach root@${HOST} over SSH`);
    expect(r.print.errors[0]!.details[0]).toContain("Permission denied (publickey)");
    // A fresh install knows no other account: it never tries one that may not exist.
    expect(b.machine.calls.map((call) => `${call.account} ${call.tag}`)).toEqual(["root setup:preflight:read"]);
  });

  test("the machine's addresses: the default route's interface, public, stable", () => {
    const route4 = JSON.stringify([{ dst: "default", dev: "eth0" }]);
    const route6 = JSON.stringify([{ dst: "default", dev: "eth0" }]);
    const addresses = JSON.stringify([
      { ifname: "docker0", addr_info: [{ family: "inet", local: "172.17.0.1", scope: "global" }] },
      {
        ifname: "eth0",
        addr_info: [
          { family: "inet", local: HOST, scope: "global" },
          { family: "inet6", local: "2001:db8::99", scope: "global", temporary: true },
          { family: "inet6", local: "fd00::1", scope: "global" },
          { family: "inet6", local: IPV6, scope: "global" },
        ],
      },
    ]);
    expect(machineAddresses(route4, route6, addresses)).toEqual({ ipv4: HOST, ipv6: IPV6 });
    expect(machineAddresses(route4, "", addresses)).toEqual({ ipv4: HOST, ipv6: null });
  });

  test("the address the records point at: the host given, else the machine's own, never a private one", () => {
    expect(chooseAddresses(HOST, { ipv4: "10.0.0.5", ipv6: null })).toEqual({ ipv4: HOST, ipv6: null });
    expect(chooseAddresses("web.example.invalid", { ipv4: HOST, ipv6: IPV6 })).toEqual({ ipv4: HOST, ipv6: IPV6 });
    const refused = chooseAddresses("web.example.invalid", { ipv4: "10.0.0.5", ipv6: null });
    expect("message" in refused && refused.message).toBe("the machine's IPv4 is private, 10.0.0.5: it is behind a NAT");
  });

  test("an answer that is not the preflight's is not read as one", () => {
    expect(readFacts('Please login as the user "debian" rather than the user "root".\n')).toBeNull();
    const facts = readFacts(`os=debian\nversion=13\nssh=198.51.100.2 50000 ${HOST} 2222\nsudo=root\nfree=100\nend=preflight\n`);
    expect(facts?.sshPort).toBe(2222);
    expect(facts?.zone).toBeNull();
  });
});

describe("the Cloudflare token", () => {
  test("never printed, never in a command line nor a script's environment: only in the script that writes it", async () => {
    const { b, mock: m } = world();
    const r = await setup(b);
    expect(r.code).toBe(0);
    expect(r.print.everything()).not.toContain(TOKEN);
    expect(r.print.secrets.join("\n")).not.toContain(TOKEN);
    for (const call of b.machine.calls) expect(call.command).not.toContain(TOKEN);
    for (const task of b.kit.tasks) expect(JSON.stringify(task.environment)).not.toContain(TOKEN);
    const carrying = b.machine.calls.filter((call) => call.input.includes(TOKEN)).map((call) => call.tag);
    expect(carrying).toEqual(["setup:cloudflare-token:run"]);
    // The check compares fingerprints: the machine computes the file's.
    const fingerprint = new Bun.CryptoHasher("sha256").update(TOKEN).digest("hex");
    expect(b.machine.calls.filter((call) => call.tag === "setup:cloudflare-token:check").at(-1)!.input).toContain(fingerprint);
    for (const request of m.requests) {
      expect(request.url).not.toContain(TOKEN);
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("the file is written root:caddy 0640 from standard input", () => {
    const script = tokenRun(TOKEN);
    expect(script).toContain("install -m 0640 -o root -g caddy /dev/stdin /etc/caddy/cloudflare.env <<'TOKEN'");
    expect(script).toContain(`CLOUDFLARE_API_TOKEN=${TOKEN}\nTOKEN`);
    expect(tokenCheck(null)).not.toContain("token-same");
  });

  test("no token anywhere: the DNS step stops and says where to put one", async () => {
    mock = startCloudflareMock({ token: TOKEN, zones: [{ id: "zone-1", name: ZONE }] });
    const b = bench(mock, home(), { token: null });
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("setup stopped at dns: no Cloudflare token");
    expect(hintFor(r.print.errors[0]!.message)).toContain("never pass it as an argument");
    expect(mock.requests).toEqual([]);
  });

  test("with the records resolving and the file on the machine, no token is needed", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    const print = printed();
    const code = await runSetup(options(), b.deps(print, { token: async () => null }));
    expect(code).toBe(0);
    expect(print.checks.find((report) => report.step === "cloudflare-token")!.status).toBe("done");
  });

  test("a machine holding another token gets the one given, and says Caddy reads it at its next start", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    b.machine.labels.delete("token-same");
    const r = await setup(b);
    expect(r.code).toBe(0);
    expect(r.print.checks.find((report) => report.step === "cloudflare-token")!.detail).toBe("/etc/caddy/cloudflare.env held another token, replaced: Caddy reads it at its next start");
    expect(b.machine.runs().filter((tag) => tag === "setup:cloudflare-token:run")).toHaveLength(2);
  });
});

describe("DNS", () => {
  test("records that point elsewhere: refused before the machine is touched, --dns-replace left to the owner", async () => {
    const { b, mock: m } = world({}, { records: [{ name: `*.${ZONE}`, type: "A", content: "198.51.100.7", proxied: false, ttl: 1 }] });
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("setup stopped at dns: records that point elsewhere");
    expect(r.print.errors[0]!.details[0]).toBe(`*.${ZONE} A 198.51.100.7: points at 198.51.100.7, not at the machine`);
    expect(hintFor(r.print.errors[0]!.message)).toContain("do not re-run with --dns-replace on your own");
    expect(b.machine.runs()).toEqual([]);
    expect(m.writes()).toEqual([]);

    const replaced = await setup(b, options("--dns-replace"));
    expect(replaced.code).toBe(0);
    expect(m.records.filter((record) => record.name === `*.${ZONE}` && record.type === "A").map((record) => record.content)).toEqual([HOST]);
  });

  test("records that take a while: the wait before Caddy, bounded, saying where it stands", async () => {
    const { b } = world({ lag: 25 });
    const r = await setup(b);
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.statuses).toContain("resolution:ok");
    expect(r.print.lines.some((line) => line.startsWith("   waiting until this workstation resolves"))).toBe(true);
    expect(r.print.lines.some((line) => line.startsWith("   still waiting: "))).toBe(true);
  });

  test("records that never come: the wait ends, and the run says it resumes there", async () => {
    const { b } = world({ lag: 1_000_000 });
    const start = b.clock.now;
    const r = await setup(b);
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`setup stopped at resolution: ${ZONE} does not resolve to ${HOST} from this workstation yet`);
    expect(b.clock.now - start).toBeGreaterThanOrEqual(10 * 60_000);
    expect(b.kit.tasks).toEqual([]);
    expect(hintFor(r.print.errors[0]!.message)).toContain("it resumes there");
  });

  test("--skip-dns: the records listed, Cloudflare never called, the run waits for them", async () => {
    const { b, mock: m } = world();
    const start = b.clock.now;
    // The records someone creates by hand, at the provider, while setup waits.
    const resolve = async (name: string) => {
      if (b.clock.now > start + 5 * 60_000 && m.records.length === 0) {
        m.records.push({ id: "hand-1", name: ZONE, type: "A", content: HOST, proxied: false, ttl: 1 }, { id: "hand-2", name: `*.${ZONE}`, type: "A", content: HOST, proxied: false, ttl: 1 });
      }
      return b.resolver.resolve(name);
    };
    const print = printed();
    const code = await runSetup(options("--skip-dns"), b.deps(print, { resolve }));
    expect(print.errors).toEqual([]);
    expect(code).toBe(0);
    expect(m.requests).toEqual([]);
    expect(print.lines).toContain(`   ${ZONE}    A     ${HOST}   DNS only, TTL auto`);
    expect(print.lines).toContain(`   *.${ZONE}  AAAA  ${IPV6}   DNS only, TTL auto`);
    expect(print.checks.find((report) => report.step === "dns")!.status).toBe("skip");
    expect(print.checks.find((report) => report.step === "resolution")!.status).toBe("ok");
  });

  test("the bare zone is only asked once the wildcard answers: its absence would be cached for half an hour", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    // The first question of the run, before any record existed.
    expect(b.resolver.asked[0]).toMatch(/^xr1\./);
    expect(b.resolver.asked.indexOf(ZONE)).toBeGreaterThan(0);
    expect(b.resolver.asked.slice(0, 1)).not.toContain(ZONE);
  });
});

describe("the passwords", () => {
  test("the portal's: drawn once, shown once at the end on the secret channel, never in an event", async () => {
    const { b } = world();
    const r = await setup(b);
    expect(b.drawn.count).toBe(1);
    expect(r.print.secrets).toHaveLength(1);
    expect(r.print.secrets[0]!.join("\n")).toContain(PORTAL_PASSWORD);
    expect(r.print.everything()).not.toContain(PORTAL_PASSWORD);
    expect(r.print.results[0]!.passwords).toBe("shown once on standard error, never in an event");
    for (const call of b.machine.calls) expect(call.input).not.toContain(PORTAL_PASSWORD);
  });

  test("the dashboard's: drawn by its script alone, its standard error kept for the terminal", async () => {
    const { b } = world();
    let task: unknown = null;
    const kit = b.kit.run;
    const print = printed();
    await runSetup(
      options(),
      b.deps(print, {
        kit: async (given, environment) => {
          if (given.kind === "script" && given.name === "dashboard-password.sh") task = given;
          return kit(given, environment);
        },
      }),
    );
    expect(task).toEqual({ kind: "script", name: "dashboard-password.sh", args: [], passwordOnStderr: true });
    expect(print.lines).toContain("-> the dashboard's password is drawn now and shown ONCE, on standard error: store it in a password manager");
  });
});

describe("what setup runs", () => {
  test("--minimal leaves out backups, the team installer and the egress proxy", async () => {
    const { b } = world();
    const r = await setup(b, options("--minimal"));
    expect(r.code).toBe(0);
    expect(r.statuses.slice(-3)).toEqual(["backups:skip", "installer:skip", "egress:skip"]);
    expect(b.kit.tasks.map((task) => task.name)).not.toContain("deploy-egress.sh");
    expect(r.print.lines.join("\n")).toContain("run setup again without --minimal");
  });

  test("--dry-run reads every step and changes nothing", async () => {
    const { b, home: folder, mock: m } = world();
    const r = await setup(b, options("--dry-run"));
    expect(r.code).toBe(0);
    expect(b.machine.runs()).toEqual([]);
    expect(b.kit.tasks).toEqual([]);
    expect(m.requests).toEqual([]);
    expect(existsSync(join(folder, ".config", "sitesolide", "config.json"))).toBe(false);
    expect(r.statuses.slice(1).every((status) => status.endsWith(":todo"))).toBe(true);
    expect(r.print.lines.at(-1)).toBe(`-> dry run: ${ORDER.length - 1} step(s) to do, nothing was changed`);
  });

  test("no script ever runs caddy stop, caddy start, or touches Caddy but through systemctl", async () => {
    const { b } = world();
    await setup(b);
    const scripts = [
      ...b.machine.calls.map((call) => call.input),
      packagesRun(),
      accountRun("deploy", "root"),
      firewallRun(22),
      fail2banRun("198.51.100.2"),
      fail2banRun(null),
      fail2banRelease("198.51.100.2"),
      updatesRun(),
      directoriesRun(),
      sshRun(),
      sshDisarm(),
      caddyUnitRun(readFileSync(join(import.meta.dir, "..", "..", "infra", "caddy", "caddy.service.d", "override.conf"), "utf8")),
      portalPasswordRun(PORTAL_HASH),
      preflightScript(),
    ];
    const caddy = /^\s*(sudo\s+)?caddy\s+(stop|start|run|reload)\b/m;
    for (const script of scripts) expect(caddy.test(script)).toBe(false);
  });

  test("every script parses as a POSIX shell script", () => {
    const scripts = [
      packagesRun(),
      accountRun("deploy", "root"),
      accountRun("admin", "admin"),
      firewallRun(22),
      fail2banRun("198.51.100.2"),
      fail2banRun(null),
      fail2banRelease("198.51.100.2"),
      updatesRun(),
      directoriesRun(),
      sshRun(),
      sshDisarm(),
      portalPasswordRun(PORTAL_HASH),
      preflightScript(),
      tokenRun(TOKEN),
      tokenCheck("0".repeat(64)),
    ];
    for (const script of scripts) {
      const parsed = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script), stderr: "pipe" });
      expect({ script: script.split("\n")[0], error: parsed.stderr.toString() }).toEqual({ script: script.split("\n")[0], error: "" });
    }
  });
});

describe("the command line", () => {
  test("--json: the checklist as check events, an error with its hint, and never a password", () => {
    const lines: string[] = [];
    const output = setupOutput(true, (line) => lines.push(line));
    output.say("-> caddy");
    output.check({ step: "caddy", title: "Caddy", status: "ok", detail: null });
    output.relay("stderr", "apt says something");
    output.error("setup stopped at caddy: Caddy could not be installed (exit code 1)", ["E: broke"]);
    const written = process.stderr.write;
    let stderr = "";
    process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
    try {
      output.secret(["  portal password   secret-value"]);
    } finally {
      process.stderr.write = written;
    }
    expect(lines.map((line) => JSON.parse(line).type)).toEqual(["step", "check", "output", "error"]);
    expect(JSON.parse(lines[1]!)).toEqual({ type: "check", step: "caddy", title: "Caddy", status: "ok", detail: null });
    expect(JSON.parse(lines[3]!).hint).toContain("resumes at that step");
    expect(lines.join("\n")).not.toContain("secret-value");
    expect(stderr).toContain("secret-value");
  });

  test("the deploy account is deploy as root, the login itself otherwise", () => {
    expect(options().user).toBe("deploy");
    expect(options("--user", "ops").user).toBe("ops");
    const sudoer = parseSetupArguments(["admin@web.example.invalid", "--zone", ZONE, "--email", EMAIL]);
    expect("message" in sudoer ? null : sudoer.user).toBe("admin");
  });

  test("refusals: no machine, no zone, a bad zone, root as the deploy account, an unknown option", () => {
    const refusal = (...given: string[]) => {
      const parsed = parseSetupArguments(given);
      return "message" in parsed ? `${parsed.message} | ${parsed.details[0]}` : null;
    };
    expect(refusal("--zone", ZONE, "--email", EMAIL)).toContain("the machine is missing");
    expect(refusal(HOST, "--zone", ZONE, "--email", EMAIL)).toContain("user@host");
    expect(refusal(`root@${HOST}`, "--email", EMAIL)).toContain("--zone is missing");
    expect(refusal(`root@${HOST}`, "--zone", "Example", "--email", EMAIL)).toBe("setup: --zone is not valid: Example | a lowercase DNS name with at least two labels, example.com");
    expect(refusal(`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--user", "root")).toStartWith("setup: --user is not valid");
    expect(refusal(`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--force")).toContain("unknown option: --force");
    // The token is never an argument: no option takes one.
    expect(refusal(`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--cloudflare-token", TOKEN)).toContain("unknown option: --cloudflare-token");
  });

  test("every refusal setup can print has a hint of its own", () => {
    const samples = [
      REFUSALS.usage("x"),
      REFUSALS.invalid("--zone", "X", "y"),
      REFUSALS.otherServer("p", "a@b", "c@d"),
      REFUSALS.otherZone("p", "a.invalid", "b.invalid"),
      REFUSALS.otherAccount("p", "a@b", "c@b"),
      REFUSALS.installed(HOST, []),
      REFUSALS.unreachable(`root@${HOST}`, "x"),
      REFUSALS.unreadable(`root@${HOST}`, "x"),
      REFUSALS.notDebian(HOST, "Ubuntu 24.04"),
      REFUSALS.noSudo(`admin@${HOST}`),
      REFUSALS.architecture(HOST, "riscv64"),
      REFUSALS.disk(HOST, "1.0 GB"),
      REFUSALS.servesOtherZone(HOST, "x.invalid"),
      REFUSALS.privateAddress("10.0.0.5"),
    ];
    expect(samples).toHaveLength(Object.keys(REFUSALS).length);
    const failures = [
      "setup stopped at dns: no Cloudflare token",
      "setup stopped at dns: the Cloudflare token is not valid",
      "setup stopped at dns: no Cloudflare zone the token can read holds x.invalid",
      "setup stopped at dns: records that point elsewhere",
      `setup stopped at resolution: ${ZONE} does not resolve to ${HOST} from this workstation yet`,
      "setup stopped at ssh: sshd refused the change",
      "setup stopped at caddy: Caddy could not be installed (exit code 1)",
    ];
    for (const message of [...samples.map((sample) => sample.message), ...failures]) {
      expect({ message, covered: hintFor(message) !== DEFAULT_HINT }).toEqual({ message, covered: true });
    }
    // The resolution's own hint, not the one of a project's domain.
    expect(hintFor(failures[4]!)).not.toContain("--force");
  });
});

/**
 * What a first run on a real Debian 13 machine taught: twenty logins as a
 * deploy account that did not exist yet, a fail2ban started by its package
 * that read them, and the workstation banned in the middle of the install.
 */
describe("the logins fail2ban counts", () => {
  test("no login as the deploy account before the account step made it, and not one refused in a whole run", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    const tags = b.machine.calls.map((call) => `${call.account} ${call.tag}`);
    const firstAsDeploy = b.machine.calls.findIndex((call) => call.account === "deploy");
    expect(firstAsDeploy).toBeGreaterThan(tags.indexOf("root setup:account:run"));
    expect(tags[firstAsDeploy]).toBe("deploy sudo -n true");
    expect(b.machine.refusedLogins).toEqual([]);
  });

  test("a dry run on a fresh machine reads every step through root: everything to do, nothing unreadable, no login refused", async () => {
    const { b } = world();
    const r = await setup(b, options("--dry-run"));
    expect(r.code).toBe(0);
    expect(r.print.checks.filter((report) => report.detail?.startsWith("unreadable"))).toEqual([]);
    expect(r.statuses.slice(1).every((status) => status.endsWith(":todo"))).toBe(true);
    expect(b.machine.calls.every((call) => call.account === "root")).toBe(true);
    expect(b.machine.refusedLogins).toEqual([]);
  });

  test("fail2ban is installed stopped, and started only once ssh is closed, the workstation spared until the end of the run", async () => {
    const { b } = world();
    expect((await setup(b)).code).toBe(0);
    const tags = b.machine.calls.map((call) => call.tag);
    expect(tags.indexOf("setup:fail2ban:run")).toBeGreaterThan(tags.indexOf("setup:ssh:disarm"));
    expect(tags.at(-1)).toBe("setup:fail2ban:release");

    const packages = b.machine.calls.find((call) => call.tag === "setup:packages:run")!.input;
    const policy = packages.indexOf("printf '#!/bin/sh\\nexit 101\\n' > \"$policy\"");
    expect(policy).toBeGreaterThan(0);
    expect(packages.indexOf("install -y -q fail2ban")).toBeGreaterThan(policy);
    expect(packages).toContain("systemctl disable --now fail2ban");
    // Everything else is installed before, its services free to start.
    expect(packages.indexOf("install -y -q sudo ufw unattended-upgrades rsync git curl unzip")).toBeLessThan(policy);

    const start = b.machine.calls.find((call) => call.tag === "setup:fail2ban:run")!.input;
    expect(start).toContain("ignoreip = 127.0.0.1/8 ::1 198.51.100.2");
    // The address is spared before the start, and the file gone once the jail answers.
    expect(start.indexOf("ignoreip")).toBeLessThan(start.indexOf("systemctl restart fail2ban"));
    expect(start.indexOf("rm -f /etc/fail2ban/jail.d/00-sitesolide-setup.conf")).toBeGreaterThan(start.indexOf("fail2ban-client status sshd"));
    expect(b.machine.calls.at(-1)!.input).toContain("fail2ban-client set sshd delignoreip '198.51.100.2'");
    // Never an unban.
    expect(b.machine.calls.map((call) => call.input).join("\n")).not.toContain("unbanip");
  });

  test("a run that fails after fail2ban started still withdraws the spared address", async () => {
    const { b } = world();
    b.kit.failing.add("deploy-api.sh");
    expect((await setup(b)).code).toBe(1);
    const tags = b.machine.calls.map((call) => call.tag);
    expect(tags.lastIndexOf("setup:fail2ban:release")).toBeGreaterThan(tags.lastIndexOf("setup:api:check"));
  });

  test("a machine that starts refusing connections mid-run: the report says fail2ban, how long, and how to check", async () => {
    const { b } = world();
    b.machine.banAfter = "setup:packages:run";
    const r = await setup(b);
    expect(r.code).toBe(1);
    const error = r.print.errors[0]!;
    expect(error.message).toBe("setup stopped at packages: the connection to the machine was refused or dropped");
    expect(error.details[0]).toBe(`ran, but could not be checked afterwards: ssh: connect to host ${HOST} port 22: Connection refused`);
    expect(error.details.join("\n")).toContain("10 minutes by default");
    expect(error.details.join("\n")).toContain("sudo fail2ban-client status sshd");
    expect(hintFor(error.message)).toContain("fail2ban");
    expect(hintFor(error.message)).toContain("never retry in a loop");
  });

  test("a script that fails because the machine stopped answering is recognised by asking once more", async () => {
    const { b } = world();
    b.kit.failing.add("deploy-api.sh");
    b.machine.banAfter = "setup:api:check";
    const r = await setup(b);
    expect(r.print.errors[0]!.message).toBe("setup stopped at api: the connection to the machine was refused or dropped");
    expect(r.print.errors[0]!.details[0]).toBe("bin/deploy-api.sh failed (exit code 1)");
    expect(b.machine.calls.some((call) => call.command === "true")).toBe(true);
  });

  test("a machine refusing the very first connection: the same advice", async () => {
    const refusal = REFUSALS.unreachable(`root@${HOST}`, `ssh: connect to host ${HOST} port 22: Connection refused`);
    expect(refusal.details.join("\n")).toContain("sudo fail2ban-client status sshd");
    expect(REFUSALS.unreachable(`root@${HOST}`, "root@host: Permission denied (publickey).").details.join("\n")).not.toContain("fail2ban");
  });

  test("a new machine on an address an old one had: the old host key is named, with the command that removes it", () => {
    // A destroyed VM's IPv4 often goes to the next one created: ssh then
    // refuses the new host key, and only a generic "cannot reach" said so.
    const refusal = REFUSALS.unreachable(`root@${HOST}`, "Host key verification failed.");
    expect(refusal.details.join("\n")).toContain(`ssh-keygen -R ${HOST}`);
    expect(refusal.details.join("\n")).not.toContain("fail2ban");
    expect(REFUSALS.unreachable(`root@${HOST}`, "ssh: connect to host x port 22: Connection refused").details.join("\n")).not.toContain("ssh-keygen -R");
  });

  test("the preflight tries a second account only when it exists, and only after the machine refused the first", () => {
    const marker = { server: `deploy@${HOST}`, zone: ZONE, startedAt: "" };
    expect(preflightAccounts("root", "deploy", { kind: "fresh" }, null)).toEqual({ first: "root", then: null });
    expect(preflightAccounts("root", "deploy", { kind: "ours", server: `deploy@${HOST}` }, marker)).toEqual({ first: "root", then: "deploy" });
    expect(preflightAccounts("root", "deploy", { kind: "ours", server: `deploy@${HOST}` }, { ...marker, rootClosed: true })).toEqual({ first: "deploy", then: null });
    expect(preflightAccounts("root", "deploy", { kind: "installed", server: `ops@${HOST}` }, null)).toEqual({ first: "root", then: "ops" });
  });

  test("setup's marker records that root is closed, once the ssh step is done", async () => {
    const { b, home: folder } = world();
    b.kit.failing.add("deploy-api.sh");
    await setup(b);
    expect(JSON.parse(readFileSync(join(folder, ".config", "sitesolide", MARKER_NAME), "utf8")).rootClosed).toBe(true);
  });
});
