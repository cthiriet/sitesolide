import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSsh, firewallCheck, firewallRun, proveAccessPath, sshCheck, sshdContent, sshdSettings, sshDisarm, sshRun, type HardenContext } from "../cli/harden";
import { hintFor, DEFAULT_HINT, REMOTE_HINTS } from "../cli/hints";
import { inboundFor, machine, providerSshProblem, type MachineDependencies, type ProviderSsh } from "../cli/machine";
import { eventOutput, type Output } from "../cli/remote";
import type { OutputEvent } from "../cli/output";
import { chooseAccess, parseSetupArguments, pinHostKey, REFUSALS, runSetup, type SetupOptions } from "../cli/setup";
import {
  accessFromConfig,
  accessProblem,
  anyRuleTest,
  inNetwork,
  parseInterfaces,
  parseNetwork,
  parseNetworks,
  publicRuleTest,
  readConnection,
  sshRuleConditions,
  sshRulesRun,
  ufwShown,
  type SshAccess,
} from "../cli/ssh-access";
import { AUTH_KEY_VARIABLE, tailscaleCheck, tailscaleRun } from "../cli/tailscale";
import { scriptLabels } from "../cli/steps";
import { withoutToken } from "../cli/setup";
import { composeConfig } from "../cli/config";
import { createFakeHetzner, FAKE_TOKEN, type FakeHetzner } from "../../clouds/fakes/hetzner";
import { WEB_SERVER, type Machine as CloudMachine } from "../../clouds/src/provider";
import { startCloudflareMock, type CloudflareMock } from "./cloudflare-mock";
import { bench, EMAIL, HOST, printed, TOKEN, ZONE, type Bench } from "./setup-fakes";

/**
 * Who may reach ssh: the networks and interfaces of --ssh-from and
 * --ssh-interface, written into ufw by setup and upgrade and into the
 * provider's firewall by `sitesolide machine`; the sshd drop-in; the tailnet;
 * and the host key pinned at first contact. What has to hold above all: a
 * run never closes public ssh unless its own connection arrives by the path
 * that stays open, and a run without the options never reopens it.
 */

const TAILNET = { client: "100.101.102.103", local: "100.64.0.7", port: 22, device: "tailscale0" };
const PUBLIC = { client: "198.51.100.2", local: HOST, port: 22, device: "eth0" };

describe("networks and interfaces", () => {
  test("a network is normalised, an address stands for its /32 or /128, host bits and /0 are refused", () => {
    expect(parseNetwork("203.0.113.0/24")).toEqual({ network: "203.0.113.0/24" });
    expect(parseNetwork("198.51.100.7")).toEqual({ network: "198.51.100.7/32" });
    expect(parseNetwork("2001:DB8:0:0::/32")).toEqual({ network: "2001:db8::/32" });
    expect(parseNetwork("2001:db8:0:0:1:0:0:1")).toEqual({ network: "2001:db8::1:0:0:1/128" });
    expect(parseNetwork("203.0.113.9/24")).toEqual({ problem: "host bits set: the network is 203.0.113.0/24" });
    expect(parseNetwork("0.0.0.0/0")).toEqual({ problem: "a /0 is everywhere: --ssh-public says that" });
    expect(parseNetwork("203.0.113.0/33")).toEqual({ problem: "the prefix must be 0 to 32" });
    expect(parseNetwork("example.invalid")).toEqual({ problem: "not an IPv4 or IPv6 address" });
    expect(parseNetworks("100.64.0.0/10, fd7a:115c:a1e0::/48,100.64.0.0/10")).toEqual({ networks: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"] });
    // A value that is no network is not repeated when it does not look like one.
    expect(parseNetworks("tskey-auth-abcdefghijklmnop")).toEqual({ problem: "(not shown): not an IPv4 or IPv6 address" });
  });

  test("an address inside a network, of its own family only", () => {
    expect(inNetwork("100.101.102.103", "100.64.0.0/10")).toBe(true);
    expect(inNetwork("100.128.0.1", "100.64.0.0/10")).toBe(false);
    expect(inNetwork("fd7a:115c:a1e0::5", "fd7a:115c:a1e0::/48")).toBe(true);
    expect(inNetwork("198.51.100.2", "fd7a:115c:a1e0::/48")).toBe(false);
  });

  test("interfaces as Linux names them; anything else refused", () => {
    expect(parseInterfaces("tailscale0")).toEqual({ interfaces: ["tailscale0"] });
    expect(parseInterfaces("wg0,tailscale0")).toEqual({ interfaces: ["wg0", "tailscale0"] });
    expect("problem" in parseInterfaces("eth0; reboot")).toBe(true);
    expect("problem" in parseInterfaces("a-name-far-too-long-for-linux")).toBe(true);
  });

  test("ufw shows a host network as its bare address", () => {
    expect(ufwShown("198.51.100.7/32")).toBe("198.51.100.7");
    expect(ufwShown("2001:db8::1/128")).toBe("2001:db8::1");
    expect(ufwShown("203.0.113.0/24")).toBe("203.0.113.0/24");
  });

  test("the configuration's record read back; a value edited into nonsense is a refusal, never public ssh", () => {
    expect(accessFromConfig({})).toEqual({ from: [], interfaces: [] });
    expect(accessFromConfig({ sshFrom: "203.0.113.0/24", sshInterface: "tailscale0" })).toEqual({ from: ["203.0.113.0/24"], interfaces: ["tailscale0"] });
    expect(accessFromConfig({ sshFrom: "everyone" })).toEqual({ problem: "sshFrom in the configuration: (not shown): not an IPv4 or IPv6 address" });
  });

  test("init run again carries the access and the tailnet over: dropping them would reopen ssh at the next setup", () => {
    const config = composeConfig({ server: `deploy@${HOST}`, zone: ZONE, email: EMAIL }, {}, { sshFrom: "203.0.113.0/24", sshInterface: "tailscale0", tailscale: "tag:server", unknown: "x" });
    expect(config).toMatchObject({ sshFrom: "203.0.113.0/24", sshInterface: "tailscale0", tailscale: "tag:server" });
    expect(config).not.toHaveProperty("unknown");
  });
});

describe("the connection proves the path that stays open", () => {
  const interfaceOnly: SshAccess = { from: [], interfaces: ["tailscale0"] };
  test("read from $SSH_CONNECTION and the interface of its local address", () => {
    expect(readConnection(`ssh=100.101.102.103 50000 100.64.0.7 22\nsshdev=tailscale0\nend=connection\n`)).toEqual(TAILNET);
    expect(readConnection("ssh=\nsshdev=\n")).toEqual({ client: null, local: null, port: null, device: null });
    // Nothing that is no interface name reaches a script.
    expect(readConnection("ssh=198.51.100.2 1 203.0.113.10 22\nsshdev=$(reboot)\n").device).toBeNull();
  });

  test("over the tailnet, the interface proves it; over the public address, it does not", () => {
    expect(accessProblem(interfaceOnly, TAILNET)).toBeNull();
    expect(accessProblem(interfaceOnly, PUBLIC)).toBe("this connection comes from 198.51.100.2 on eth0, which ssh on tailscale0 only would refuse");
    expect(accessProblem({ from: ["198.51.100.0/24"], interfaces: [] }, PUBLIC)).toBeNull();
    expect(accessProblem({ from: ["203.0.113.0/24"], interfaces: [] }, PUBLIC)).not.toBeNull();
    expect(accessProblem({ from: [], interfaces: [] }, PUBLIC)).toBeNull();
    expect(() => proveAccessPath({ sshAccess: interfaceOnly, connection: PUBLIC })).toThrow("public ssh stays open: this connection comes from 198.51.100.2 on eth0");
    expect(() => proveAccessPath({ sshAccess: interfaceOnly })).toThrow("public ssh stays open");
  });
});

/** A `ufw` that prints this status, first on PATH, to run the conditions' tests for real. */
function fakeUfw(status: string): { path: string; remove: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "fake-ufw-"));
  writeFileSync(join(folder, "status"), status);
  writeFileSync(join(folder, "ufw"), `#!/bin/sh\ncat ${join(folder, "status")}\n`);
  chmodSync(join(folder, "ufw"), 0o755);
  return { path: `${folder}:/usr/bin:/bin`, remove: () => rmSync(folder, { recursive: true, force: true }) };
}

function holds(test_: string, path: string): boolean {
  return Bun.spawnSync(["sh", "-c", test_], { env: { PATH: path }, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

const HEADER = "Status: active\n\nTo                         Action      From\n--                         ------      ----\n";
const PUBLIC_STATUS = `${HEADER}22/tcp                     ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere\n22/tcp (v6)                ALLOW       Anywhere (v6)\n80/tcp (v6)                ALLOW       Anywhere (v6)\n443/tcp (v6)               ALLOW       Anywhere (v6)\n`;
const RESTRICTED_STATUS = `${HEADER}22/tcp                     ALLOW       203.0.113.0/24\n22/tcp                     ALLOW       198.51.100.7\n22/tcp on tailscale0       ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n443/tcp                    ALLOW       Anywhere\n22/tcp (v6) on tailscale0  ALLOW       Anywhere (v6)\n80/tcp (v6)                ALLOW       Anywhere (v6)\n443/tcp (v6)               ALLOW       Anywhere (v6)\n`;

describe("ufw", () => {
  const access: SshAccess = { from: ["203.0.113.0/24", "198.51.100.7/32"], interfaces: ["tailscale0"] };

  test("the conditions read ufw's status as it prints it", () => {
    const open = fakeUfw(PUBLIC_STATUS);
    const closed = fakeUfw(RESTRICTED_STATUS);
    try {
      expect(holds(publicRuleTest(22), open.path)).toBe(true);
      expect(holds(publicRuleTest(22), closed.path)).toBe(false);
      expect(holds(anyRuleTest(22), open.path)).toBe(true);
      expect(holds(anyRuleTest(22), closed.path)).toBe(true);
      const conditions = sshRuleConditions(22, access);
      expect(conditions.map((condition) => condition.label)).toEqual(["ufw-22-from-203.0.113.0-24", "ufw-22-from-198.51.100.7-32", "ufw-22-on-tailscale0", "ufw-22-public-closed"]);
      expect(conditions.every((condition) => holds(condition.test, closed.path))).toBe(true);
      expect(conditions.filter((condition) => !holds(condition.test, open.path)).map((condition) => condition.label)).toEqual(conditions.map((condition) => condition.label));
    } finally {
      open.remove();
      closed.remove();
    }
  });

  test("restricted: the new rules first, then the public ones deleted, every spelling; never the web's", () => {
    const run = sshRulesRun(22, access);
    const lines = run.split("\n");
    const lastAllow = Math.max(...lines.map((line, index) => (line.startsWith("ufw allow") ? index : -1)));
    const firstDelete = lines.findIndex((line) => line.startsWith("ufw delete"));
    expect(lastAllow).toBeLessThan(firstDelete);
    expect(run).toContain("ufw allow from 203.0.113.0/24 to any port 22 proto tcp");
    expect(run).toContain("ufw allow in on tailscale0 to any port 22 proto tcp");
    for (const rule of ["22/tcp", "22", "OpenSSH"]) expect(run).toContain(`ufw delete allow ${rule} `);
    expect(run).not.toContain("80");
    const script = firewallRun(22, false, access);
    expect(script.indexOf("ufw delete")).toBeLessThan(script.indexOf("ufw --force enable"));
    expect(script).toContain('for port in 80 443; do ufw allow "$port/tcp"');
  });

  test("no restriction given: ssh opened to all only where no rule lets it in, so a restriction stays", () => {
    expect(sshRulesRun(22, { from: [], interfaces: [] })).toBe(`${anyRuleTest(22)} || ufw allow 22/tcp >/dev/null </dev/null`);
    expect(scriptLabels(firewallCheck(22))).toEqual(["ufw-active", "ufw-deny-incoming", "ufw-22", "ufw-80", "ufw-443"]);
    // --ssh-public alone opens it again.
    expect(sshRulesRun(22, { from: [], interfaces: [] }, true)).toBe("ufw allow 22/tcp >/dev/null </dev/null");
    expect(scriptLabels(firewallCheck(22, false, { from: [], interfaces: [] }, true))).toContain("ufw-22-public");
  });

  test("every script parses as a POSIX shell script", () => {
    for (const script of [firewallRun(22, false, access), firewallRun(2222, true, access), firewallCheck(22, false, access), tailscaleCheck("tag:server"), tailscaleRun("tag:server", "tskey-auth-k0000000000CNTRL-abcdefghijkl"), tailscaleRun("tag:server", null), sshRun("deploy"), sshCheck("deploy"), sshDisarm()]) {
      const parsed = Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script), stderr: "pipe" });
      expect({ script: script.split("\n")[0], error: parsed.stderr.toString() }).toEqual({ script: script.split("\n")[0], error: "" });
    }
  });
});

describe("the sshd drop-in", () => {
  test("keys only, no root, the deploy account alone, no forwarding, modern algorithms", () => {
    const content = sshdContent("deploy");
    for (const line of [
      "PermitRootLogin no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "AuthenticationMethods publickey",
      "AllowUsers deploy",
      "MaxAuthTries 5",
      "LoginGraceTime 30",
      "AllowTcpForwarding no",
      "AllowAgentForwarding no",
      "X11Forwarding no",
      "PubkeyAuthOptions touch-required",
      "KexAlgorithms mlkem768x25519-sha256,sntrup761x25519-sha512,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org",
    ]) {
      expect(content.split("\n")).toContain(line);
    }
    expect(content).not.toMatch(/diffie-hellman|sha1|cbc|hmac-md5/);
    // The check reads what sshd applies, as `sshd -T` prints it: lowercase keys.
    expect(sshCheck("deploy")).toContain("grep -qxF 'allowusers deploy'");
    expect(scriptLabels(sshCheck("deploy"))).toEqual(sshdSettings("deploy").map((setting) => setting.label));
  });

  test("the safety net puts the previous drop-in back rather than removing it", () => {
    const script = sshRun("deploy");
    expect(script).toContain('mv "$drop_in.before" "$drop_in.rollback"');
    expect(script).toContain('"if [ -f $drop_in.rollback ]; then mv $drop_in.rollback $drop_in; else rm -f $drop_in; fi; systemctl reload ssh || true"');
    expect(sshDisarm()).toContain("rm -f /etc/ssh/sshd_config.d/00-sitesolide.conf.rollback");
  });

  // Where an sshd is installed, the drop-in is one it accepts.
  const sshd = Bun.which("sshd") ?? (Bun.file("/usr/sbin/sshd").size > 0 ? "/usr/sbin/sshd" : null);
  test.skipIf(sshd === null)("sshd -t accepts the drop-in", () => {
    const folder = mkdtempSync(join(tmpdir(), "sshd-"));
    try {
      Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(folder, "host")]);
      writeFileSync(join(folder, "sshd_config"), `${sshdContent("deploy")}HostKey ${join(folder, "host")}\n`);
      const checked = Bun.spawnSync([sshd!, "-t", "-f", join(folder, "sshd_config")], { stderr: "pipe" });
      expect(checked.stderr.toString()).toBe("");
      expect(checked.exitCode).toBe(0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("AllowUsers names the account the second proof logs in as", async () => {
    const inputs: string[] = [];
    const context: HardenContext = {
      host: HOST,
      operator: "root",
      deployUser: "admin",
      sshPort: 22,
      accountReady: true,
      clientAddress: null,
      ignoredAddress: null,
      machine: {
        exec: async (_account, _command, given = {}) => {
          inputs.push(given.input ?? "");
          return { code: 0, output: given.input?.includes("check") ? "check: done\n" : "", error: "" };
        },
      },
    };
    await closeSsh(context);
    expect(inputs.find((input) => input.includes("setup:ssh:run"))).toContain("AllowUsers admin");
  });
});

// --- setup ---------------------------------------------------------------------------------------

const HOMES: string[] = [];
let mock: CloudflareMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
});

function world(facts: Record<string, string> = {}): Bench {
  mock = startCloudflareMock({ token: TOKEN, zones: [{ id: "zone-1", name: ZONE }] });
  const folder = mkdtempSync(join(tmpdir(), "ssh-access-home-"));
  HOMES.push(folder);
  return bench(mock, folder, { facts });
}

function options(...extra: string[]): SetupOptions {
  const parsed = parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, ...extra]);
  if ("message" in parsed) throw new Error(parsed.message);
  return parsed;
}

async function setup(b: Bench, given: SetupOptions, overrides: Parameters<Bench["deps"]>[1] = {}) {
  const print = printed();
  const code = await runSetup(given, b.deps(print, overrides));
  return { code, print, statuses: print.checks.map((report) => `${report.step}:${report.status}`) };
}

function configOf(b: Bench): Record<string, unknown> {
  const home = b.deps(printed()).home;
  return JSON.parse(readFileSync(join(home, ".config", "sitesolide", "config.json"), "utf8")) as Record<string, unknown>;
}

describe("setup --ssh-from and --ssh-interface", () => {
  test("the options read, and refused together with --ssh-public", () => {
    const given = options("--ssh-from", "203.0.113.0/24", "--ssh-interface", "tailscale0");
    expect(given.sshFrom).toEqual(["203.0.113.0/24"]);
    expect(given.sshInterfaces).toEqual(["tailscale0"]);
    expect(parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--ssh-public", "--ssh-from", "203.0.113.0/24"])).toMatchObject({ details: ["--ssh-public opens ssh to all: it does not go with --ssh-from nor --ssh-interface", "see docs/setup.md"] });
    expect(parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--ssh-from", "203.0.113.9/24"])).toMatchObject({ message: "setup: the ssh access is not valid: --ssh-from 203.0.113.9/24: host bits set: the network is 203.0.113.0/24" });
  });

  test("absent options: the configuration's access; given: theirs as a whole; --ssh-public: open again", () => {
    const recorded = { sshFrom: "203.0.113.0/24" };
    expect(chooseAccess(options(), recorded)).toEqual({ access: { from: ["203.0.113.0/24"], interfaces: [] }, reopen: false });
    expect(chooseAccess(options("--ssh-interface", "tailscale0"), recorded)).toEqual({ access: { from: [], interfaces: ["tailscale0"] }, reopen: false });
    expect(chooseAccess(options("--ssh-public"), recorded)).toEqual({ access: { from: [], interfaces: [] }, reopen: true });
  });

  test("connected over the public address, --ssh-interface tailscale0 is refused at the firewall, nothing changed there", async () => {
    const b = world();
    const r = await setup(b, options("--ssh-interface", "tailscale0"));
    expect(r.code).toBe(1);
    expect(r.statuses).toContain("firewall:fail");
    expect(r.print.errors[0]!.message).toBe("setup stopped at firewall: public ssh stays open: this connection comes from 198.51.100.2 on eth0, which ssh on tailscale0 only would refuse");
    expect(hintFor(r.print.errors[0]!.message)).toContain("never --ssh-public");
    expect(b.machine.runs()).not.toContain("setup:firewall:run");
  });

  test("connected over the tailnet: ssh on tailscale0 alone, recorded, and kept by a run without the option", async () => {
    const b = world({ ssh: `100.101.102.103 50000 100.64.0.7 22`, sshdev: "tailscale0" });
    const r = await setup(b, options("--ssh-interface", "tailscale0"));
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    const run = b.machine.calls.find((call) => call.tag === "setup:firewall:run")!.input;
    expect(run).toContain("ufw allow in on tailscale0 to any port 22 proto tcp");
    expect(run).toContain("ufw delete allow 22/tcp");
    expect(configOf(b)).toMatchObject({ sshInterface: "tailscale0" });
    expect(configOf(b)).not.toHaveProperty("sshFrom");

    // Again, without the option: the restriction is read back, and nothing runs.
    const again = await setup(b, options());
    expect(again.code).toBe(0);
    expect(again.statuses).toContain("firewall:done");
    expect(again.statuses).toContain("configuration:done");
    expect(b.machine.calls.filter((call) => call.tag === "setup:firewall:check").at(-1)!.input).toContain("ufw-22-public-closed");
  });

  test("a fresh machine opened to all is never narrowed nor reopened by a run without options", async () => {
    const b = world();
    expect((await setup(b, options())).code).toBe(0);
    expect(b.machine.calls.find((call) => call.tag === "setup:firewall:run")!.input).toContain("|| ufw allow 22/tcp");
    expect(configOf(b)).not.toHaveProperty("sshInterface");
  });
});

describe("setup --tailscale", () => {
  const KEY = "tskey-auth-k0000000000CNTRL-abcdefghijklmnopqrstuvwxyz";

  test("the key reaches the machine on standard input alone, never in a command, and never in what is printed", async () => {
    const b = world();
    const r = await setup(b, options("--tailscale"), { tailscaleKey: async () => KEY });
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.statuses).toContain("tailscale:ok");
    const run = b.machine.calls.find((call) => call.tag === "setup:tailscale:run")!;
    expect(run.input).toContain(KEY);
    expect(run.input).toContain('--auth-key="file:$key_file"');
    expect(run.input).toContain("--ssh=false");
    expect(run.input).toContain("--advertise-tags='tag:server'");
    expect(b.machine.calls.every((call) => !call.command.includes(KEY))).toBe(true);
    expect(JSON.stringify(r.print)).not.toContain(KEY);
    expect(configOf(b)).toMatchObject({ tailscale: "tag:server" });
    // After the hardening, before Caddy.
    expect(r.statuses.indexOf("tailscale:ok")).toBeGreaterThan(r.statuses.indexOf("fail2ban:ok"));
    expect(r.statuses.indexOf("tailscale:ok")).toBeLessThan(r.statuses.indexOf("caddy:ok"));
  });

  test("no key and a machine outside a tailnet: the step stops and says where the key goes", async () => {
    const b = world();
    const r = await setup(b, options("--tailscale-tag", "tag:web"));
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("setup stopped at tailscale: no Tailscale auth key: the machine has not joined a tailnet");
    expect(r.print.errors[0]!.details.join("\n")).toContain(AUTH_KEY_VARIABLE);
    expect(hintFor(r.print.errors[0]!.message)).not.toBe(DEFAULT_HINT);
  });

  test("the check refuses Tailscale SSH; the run turns it off; scripts carry no key when none is needed", () => {
    expect(tailscaleCheck("tag:server")).toContain(`! tailscale debug prefs 2>/dev/null | grep -Eq '"RunSSH": *true'`);
    expect(tailscaleRun("tag:server", null)).toContain("tailscale set --ssh=false");
    expect(tailscaleRun("tag:server", null)).not.toContain("tskey-");
    expect(tailscaleRun("tag:server", null)).toContain('if [ "$found" != 2596A99EAAB33821893C0A79458CA832957F5868 ]; then');
    expect(() => tailscaleRun("tag:server", "not a key")).toThrow();
    expect(() => tailscaleCheck("server")).toThrow();
  });

  test("the key never reaches the scripts setup launches, and stdin carries one secret at a time", () => {
    expect(withoutToken({ [AUTH_KEY_VARIABLE]: KEY, PATH: "/bin" }, false)).toEqual({ PATH: "/bin" });
    expect(parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--tailscale", "--tailscale-key-stdin", "--cloudflare-token-stdin"])).toMatchObject({ message: "usage: sitesolide setup <user@host> --zone <dns.zone> --email <address>" });
    expect(parseSetupArguments([`root@${HOST}`, "--zone", ZONE, "--email", EMAIL, "--tailscale-key-stdin"])).toMatchObject({ details: ["--tailscale-key-stdin goes with --tailscale", "see docs/setup.md"] });
  });
});

describe("setup --host-key", () => {
  const FINGERPRINT = `SHA256:${"a".repeat(43)}`;
  const OTHER = `SHA256:${"b".repeat(43)}`;
  const out = { output: printed().output };

  test("a fingerprint that is not among the machine's keys refuses before any connection", async () => {
    const pinned: string[] = [];
    const keys = { presented: async () => [{ fingerprint: OTHER, line: `${HOST} ssh-ed25519 AAAA` }], known: async () => false, pin: async (line: string) => void pinned.push(line) };
    expect(await pinHostKey(HOST, FINGERPRINT, { ...out, hostKeys: keys })).toEqual(REFUSALS.hostKeyMismatch(HOST, FINGERPRINT, [OTHER]));
    expect(pinned).toEqual([]);
  });

  test("the matching key alone is recorded; a known host is left to ssh", async () => {
    const pinned: string[] = [];
    const keys = {
      presented: async () => [
        { fingerprint: OTHER, line: `${HOST} ssh-rsa BBBB` },
        { fingerprint: FINGERPRINT, line: `${HOST} ssh-ed25519 AAAA` },
      ],
      known: async () => false,
      pin: async (line: string) => void pinned.push(line),
    };
    expect(await pinHostKey(HOST, FINGERPRINT, { ...out, hostKeys: keys })).toBeNull();
    expect(pinned).toEqual([`${HOST} ssh-ed25519 AAAA`]);
    expect(await pinHostKey(HOST, FINGERPRINT, { ...out, hostKeys: { ...keys, known: async () => true } })).toBeNull();
    expect(pinned).toHaveLength(1);
  });

  test("a mismatch through the whole run: nothing reaches the machine", async () => {
    const b = world();
    const keys = { presented: async () => [{ fingerprint: OTHER, line: `${HOST} ssh-ed25519 AAAA` }], known: async () => false, pin: async () => {} };
    const r = await setup(b, options("--host-key", FINGERPRINT), { hostKeys: keys });
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`${HOST} does not present the host key ${FINGERPRINT}`);
    expect(b.machine.calls).toEqual([]);
  });
});

// --- the provider's firewall ---------------------------------------------------------------------

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";

describe("sitesolide machine and ssh", () => {
  let fake: FakeHetzner;
  let listener: Bun.TCPSocketListener<undefined>;
  let home: string;
  beforeAll(() => {
    fake = createFakeHetzner();
    listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
    home = mkdtempSync(join(tmpdir(), "machine-ssh-home-"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
  });
  afterAll(() => {
    fake.stop();
    listener.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  async function run(arguments_: string[], extra: Partial<MachineDependencies> = {}) {
    const lines: string[] = [];
    let now = Date.parse("2026-10-05T10:00:00Z");
    const code = await machine(["machine", ...arguments_, "--json"], {
      environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url },
      home,
      workstation: {
        environment: {},
        run: async (argv) => {
          if (argv[0] === "ssh-add" || argv[0] === "ssh-keygen") return { code: 0, stdout: `${ED25519}\n`, stderr: "" };
          return { code: 127, stdout: "", stderr: "not installed" };
        },
        readFile: () => null,
      },
      output: eventOutput((line) => lines.push(line)) as Output,
      clock: { now: () => now, sleep: async (ms) => void (now += ms) },
      sshTarget: () => ({ hostname: "127.0.0.1", port: listener.port }),
      knownFingerprints: async () => [],
      interactive: false,
      ...extra,
    });
    const events = lines.map((line) => JSON.parse(line) as OutputEvent);
    return { code, events, last: events.at(-1)! as unknown as Record<string, unknown> };
  }

  const sshRule = () => fake.firewalls[0]!.rules.find((rule) => (rule as { port?: string }).port === "22") as { source_ips: string[] } | undefined;

  test("the web server's rules, ssh's sources replaced or left out", () => {
    expect(inboundFor({ kind: "public" })).toEqual([...WEB_SERVER]);
    expect(inboundFor({ kind: "closed" }).map((rule) => rule.port ?? "icmp")).toEqual([80, 443, "icmp"]);
    expect(inboundFor({ kind: "from", networks: ["203.0.113.0/24"] }).find((rule) => rule.port === 22)!.sources).toEqual(["203.0.113.0/24"]);
  });

  test("create --ssh-from: port 22 open to those networks alone at Hetzner's firewall", async () => {
    fake.reset();
    const r = await run(["create", "--provider", "hetzner", "--name", "web", "--ssh-from", "198.51.100.0/24"]);
    expect(r.last).toMatchObject({ type: "result" });
    expect(r.code).toBe(0);
    expect(sshRule()!.source_ips).toEqual(["198.51.100.0/24"]);
  });

  test("create --ssh-from at a provider whose firewall takes only the web server's rules: refused, nothing ordered", async () => {
    const r = await run(["create", "--provider", "linode", "--name", "web", "--ssh-from", "198.51.100.0/24"], { environment: { LINODE_TOKEN: "x".repeat(64), SITESOLIDE_LINODE_API: "http://127.0.0.1:9" } });
    expect(r.code).toBe(1);
  });

  const machineOf = (): CloudMachine => ({ ...(fake.servers[0] as unknown as CloudMachine), ipv4: fake.servers[0]!.ipv4, ipv6: null });

  test("narrowing is refused unless the configured server reaches the machine without what is closed", () => {
    const at = machineOf();
    const on = (connection: typeof TAILNET, addresses: string[]) => ({ server: "deploy@web-tailnet", connection: { ...connection, addresses } });
    const closed: ProviderSsh = { kind: "closed" };
    expect(providerSshProblem(closed, at, null)).toContain("no configured server answered");
    expect(providerSshProblem(closed, at, on(TAILNET, ["100.64.0.7"]))).toContain("is not this machine");
    expect(providerSshProblem(closed, at, on(TAILNET, [at.ipv4!, "100.64.0.7"]))).toBeNull();
    expect(providerSshProblem(closed, at, on({ ...PUBLIC, local: at.ipv4! }, [at.ipv4!]))).toContain("would cut it off");
    expect(providerSshProblem({ kind: "from", networks: ["198.51.100.0/24"] }, at, on({ ...PUBLIC, local: at.ipv4! }, [at.ipv4!]))).toBeNull();
    expect(providerSshProblem({ kind: "public" }, at, null)).toBeNull();
  });

  test("firewall --ssh-closed: refused over the public address, done over the tailnet, and --ssh-public reopens it", async () => {
    fake.reset();
    expect((await run(["create", "--provider", "hetzner", "--name", "web"])).code).toBe(0);
    const ipv4 = fake.servers[0]!.ipv4!;

    const refused = await run(["firewall", "web", "--provider", "hetzner", "--ssh-closed"], {
      configuredConnection: async () => ({ server: `deploy@${ipv4}`, connection: { ...PUBLIC, local: ipv4, addresses: [ipv4] } }),
    });
    expect(refused.code).toBe(1);
    expect(refused.last).toMatchObject({ type: "error", hint: REMOTE_HINTS["ssh-unproven"] });
    expect(String(refused.last.message)).toStartWith("port 22 left as it is:");
    expect(sshRule()!.source_ips).toEqual(["0.0.0.0/0", "::/0"]);

    const closed = await run(["firewall", "web", "--provider", "hetzner", "--ssh-closed"], {
      configuredConnection: async () => ({ server: "deploy@web-tailnet", connection: { ...TAILNET, addresses: [ipv4, TAILNET.local] } }),
    });
    expect(closed.code).toBe(0);
    expect(sshRule()).toBeUndefined();
    expect(fake.firewalls[0]!.rules.length).toBe(3);

    // The break-glass needs no proof.
    const reopened = await run(["firewall", "web", "--provider", "hetzner", "--ssh-public"]);
    expect(reopened.code).toBe(0);
    expect(sshRule()!.source_ips).toEqual(["0.0.0.0/0", "::/0"]);
  });

  test("its codes have hints", () => {
    for (const code of ["ssh-access", "ssh-unproven"]) expect(REMOTE_HINTS[code]).toBeDefined();
  });
});
