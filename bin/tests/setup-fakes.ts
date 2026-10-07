/**
 * What the tests of `sitesolide setup`, and of `sitesolide upgrade`, put in
 * place of a machine, of the kit's scripts, of the workstation's resolver and
 * of the terminal. Nothing here
 * opens a connection: the machine is a model, the scripts are recorded, the
 * resolver reads the records the Cloudflare mock holds.
 *
 * THE MODEL MACHINE. Its state is the set of labels setup's checks report:
 * `caddy-package`, `root-login-off`, `api-active`... A check script is answered
 * by reading its labels, word for word as checkScript wrote them, and saying
 * which are not set; a run sets the labels of the last check of its step, as a
 * real run makes its check pass. The scripts are never executed, they are
 * recognised by the tag on their first line and on the command line, and a
 * command the model does not recognise is refused, as fake-ssh.ts refuses.
 *
 * Who may log in is the model's too: root until the ssh step closes it, the
 * deploy account once the account step has made it, unless the test breaks
 * that login to see the proof fail.
 */
import type { Execution, Machine } from "../cli/harden";
import type { KitRunner, KitTask, Observed, SetupDependencies, SetupOutput } from "../cli/setup";
import { scriptLabels, scriptTag, type StepReport } from "../cli/steps";
import type { CloudflareMock } from "./cloudflare-mock";

export const ZONE = "test-zone.invalid";
export const EMAIL = `ops@${ZONE}`;
export const HOST = "203.0.113.10";
export const IPV6 = "2001:db8::10";
export const TOKEN = "cf-test-token-0123456789abcdefABCDEF";
export const PORTAL_PASSWORD = "Pwd7-portal-test-only-Xy3k";
export const PORTAL_HASH = "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA";

export type Call = { account: string; command: string; tag: string; input: string };

/** One line of everything that reached the machine or the kit, in order. */
export type Timeline = string[];

export type MachineOptions = {
  deployUser?: string;
  /** The account a test connects as when it is not root, with sudo unless said otherwise. */
  sudoer?: { name: string; sudo: boolean };
  facts?: Partial<Record<string, string>>;
};

export class FakeMachine implements Machine {
  readonly labels = new Set<string>();
  /** The labels of the last check of each step. */
  readonly known = new Map<string, string[]>();
  readonly calls: Call[] = [];
  readonly logins = new Set<string>(["root"]);
  readonly sudo = new Set<string>(["root"]);
  /** Run tags that fail, once each. */
  readonly failing = new Set<string>();
  /** The deploy account's login fails even once it is made: a key the account did not get. */
  breakProof = false;
  /**
   * The logins sshd refused: what fail2ban counts. An account that does not
   * exist, or root once closed, lands here.
   */
  readonly refusedLogins: string[] = [];
  /** Every connection refused from the call after this tag's on: fail2ban banning the workstation. */
  banAfter: string | null = null;
  private banned = false;
  readonly deployUser: string;
  facts: Record<string, string>;

  constructor(
    readonly timeline: Timeline,
    options: MachineOptions = {},
  ) {
    this.deployUser = options.deployUser ?? "deploy";
    if (options.sudoer !== undefined) {
      this.logins.add(options.sudoer.name);
      if (options.sudoer.sudo) this.sudo.add(options.sudoer.name);
    }
    this.facts = {
      os: "debian",
      version: '"13"',
      system: "Debian GNU/Linux 13 (trixie)",
      architecture: "amd64",
      free: String(40 * 1024 * 1024),
      ssh: `198.51.100.2 50000 ${HOST} 22`,
      route4: JSON.stringify([{ dst: "default", gateway: "172.31.1.1", dev: "eth0" }]),
      route6: JSON.stringify([{ dst: "default", gateway: "fe80::1", dev: "eth0" }]),
      addresses: JSON.stringify([
        { ifname: "eth0", addr_info: [{ family: "inet", local: HOST, scope: "global" }, { family: "inet6", local: IPV6, scope: "global" }, { family: "inet6", local: "fe80::1", scope: "link" }] },
        { ifname: "docker0", addr_info: [{ family: "inet", local: "172.17.0.1", scope: "global" }] },
      ]),
      ...options.facts,
    } as Record<string, string>;
  }

  /** Every label of every step set: a machine already installed. */
  install(labels: Iterable<string>): void {
    for (const label of labels) this.labels.add(label);
  }

  /** Who logs in: root until the ssh step, the deploy account once made. */
  private answer(code: number, output = "", error = ""): Execution {
    return { code, output, error };
  }

  async exec(account: string, command: string, options: { input?: string; stream?: boolean } = {}): Promise<Execution> {
    const input = options.input ?? "";
    const tag = scriptTag(input) ?? command;
    this.calls.push({ account, command, tag, input });
    this.timeline.push(`${account} ${tag}`);
    if (this.banned) return this.answer(255, "", `ssh: connect to host ${HOST} port 22: Connection refused`);
    if (this.banAfter === tag) this.banned = true;
    if (!this.logins.has(account)) {
      this.refusedLogins.push(account);
      return this.answer(255, "", `${account}@${HOST}: Permission denied (publickey).`);
    }
    if (command === "true") return this.answer(0);
    if (command === "sudo -n true") return this.answer(this.sudo.has(account) ? 0 : 1, "", "sudo: a password is required");

    const match = /^(sudo -n )?sh -s ((?:setup|upgrade):[a-z0-9-]+:[a-z]+)$/.exec(command);
    if (match === null || match[2] !== scriptTag(input)) return this.answer(127, "", `fake machine: unexpected command: ${command}`);
    if (match[1] !== undefined && !this.sudo.has(account)) return this.answer(1, "", "sudo: a password is required");
    const [, step = "", verb = ""] = match[2].split(":");

    if (verb === "read") {
      const sudo = account === "root" ? "root" : this.sudo.has(account) ? "yes" : "no";
      const zone = this.labels.has("zone-file") ? ZONE : "";
      const lines = { ...this.facts, uid: account === "root" ? "0" : "1000", sudo, zone };
      return this.answer(0, `${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join("\n")}\nend=preflight\n`);
    }
    if (verb === "check" || verb === "installed") {
      const labels = scriptLabels(input);
      if (verb === "check") this.known.set(step, labels);
      const missing = labels.filter((label) => !this.labels.has(label));
      return this.answer(0, missing.length === 0 ? "check: done\n" : `check: missing ${missing.join(" ")}\n`);
    }
    if (verb === "disarm" || verb === "release") return this.answer(0);
    if (verb !== "run") return this.answer(127, "", `fake machine: unexpected verb ${verb}`);

    if (this.failing.has(match[2])) {
      this.failing.delete(match[2]);
      return this.answer(1, "", `E: the run of ${step} broke`);
    }
    for (const label of this.known.get(step) ?? []) this.labels.add(label);
    if (step === "account" && !this.breakProof) {
      this.logins.add(this.deployUser);
      this.sudo.add(this.deployUser);
    }
    if (step === "ssh") this.logins.delete("root");
    if (step === "portal-password") return this.answer(0, "portal-password: written\n");
    return this.answer(0);
  }

  /** The tags of the runs that reached the machine. */
  runs(): string[] {
    return this.calls.filter((call) => call.tag.endsWith(":run")).map((call) => call.tag);
  }
}

/** What each script of the kit sets on the model machine, and what it needs there. */
const EFFECTS: Record<string, string[]> = {
  "deploy-api.sh": ["api-active", "api-enabled"],
  "deploy-gatekeeper.sh": ["gatekeeper-code", "gatekeeper-on", "gatekeeper-off"],
  "dashboard-password.sh": ["dashboard-password"],
  "deploy dashboard": ["dashboard-active"],
  "deploy-steward.sh": ["steward-active", "steward-code"],
  "deploy-collector.sh": ["collector-enabled", "collector-active"],
  "deploy portal": ["portal-active"],
  "deploy-loopback.sh close": ["loopback-table", "loopback-unit"],
  "deploy-monitor.sh": ["monitor-enabled", "monitor-active"],
  "deploy-backup.sh install": ["backup-code", "backup-timer"],
  "deploy-backup.sh enable": ["backup-enabled", "backup-active"],
  "deploy-installer.sh": ["installer-code", "installer-unit"],
  "deploy-egress.sh": ["egress-active"],
};

export type FakeKit = { run: KitRunner; tasks: { name: string; environment: Record<string, string> }[]; failing: Set<string> };

export function taskName(task: KitTask): string {
  return task.kind === "deploy" ? `deploy ${task.folder}` : [task.name, ...task.args].join(" ");
}

export function fakeKit(machine: FakeMachine): FakeKit {
  const tasks: FakeKit["tasks"] = [];
  const failing = new Set<string>();
  const run: KitRunner = async (task, environment) => {
    const name = taskName(task);
    tasks.push({ name, environment });
    machine.timeline.push(`kit ${name}`);
    if (failing.has(name)) {
      failing.delete(name);
      return { code: 1, output: `!! ${name} broke` };
    }
    if (name === "deploy-caddy.sh") {
      // The first run lays the two files and stops on the unit; once the
      // drop-in loads them, it deposits the Caddyfile.
      if (!machine.labels.has("zone-variables")) {
        machine.install(["zone-file", "domain-table"]);
        return { code: 1, output: "-> first install: the zone file and an empty domain table, where missing\n!! STOP: the caddy.service unit does not load /etc/caddy/sitesolide.env." };
      }
      machine.install(["caddyfile"]);
      return { code: 0, output: "" };
    }
    if (name === "deploy portal" && !machine.labels.has("portal-password")) return { code: 1, output: "!! secret missing on the server: /etc/sitesolide/portal.env" };
    if (name === "deploy-egress.sh") machine.labels.delete("steward-after-egress");
    if (name === "deploy-steward.sh" && machine.labels.has("egress-active")) machine.labels.add("steward-after-egress");
    machine.install(EFFECTS[name] ?? []);
    return { code: 0, output: "" };
  };
  return { run, tasks, failing };
}

/**
 * The workstation's resolver, reading the records the Cloudflare mock holds,
 * the wildcard answering every name under the zone. `lag` answers nothing for
 * that many questions, as resolvers that have not caught up yet.
 */
export function fakeResolver(source: () => { name: string; type: string; content: string }[], lag = { questions: 0 }) {
  const asked: string[] = [];
  const resolve = async (name: string): Promise<Observed> => {
    asked.push(name);
    if (lag.questions > 0) {
      lag.questions--;
      return { ipv4: [], ipv6: [] };
    }
    const records = source();
    const exact = records.filter((record) => record.name === name);
    const under = name.endsWith(`.${ZONE}`) && exact.length === 0 ? records.filter((record) => record.name === `*.${ZONE}`) : exact;
    return {
      ipv4: under.filter((record) => record.type === "A").map((record) => record.content),
      ipv6: under.filter((record) => record.type === "AAAA").map((record) => record.content),
    };
  };
  return { resolve, asked };
}

/** Everything setup printed, by kind. */
export type Printed = {
  output: SetupOutput;
  lines: string[];
  checks: StepReport[];
  relayed: string[];
  secrets: string[][];
  errors: { message: string; details: string[] }[];
  results: Record<string, unknown>[];
  /** Every text that reached the terminal outside the secret channel. */
  everything(): string;
};

export function printed(json = false): Printed {
  const p: Omit<Printed, "output" | "everything"> = { lines: [], checks: [], relayed: [], secrets: [], errors: [], results: [] };
  const output: SetupOutput = {
    json,
    say: (line) => void p.lines.push(line),
    check: (report) => void p.checks.push(report),
    relay: (_, line) => void p.relayed.push(line),
    secret: (lines) => void p.secrets.push(lines),
    error: (message, details) => void p.errors.push({ message, details }),
    result: (fields) => void p.results.push(fields),
  };
  return {
    ...p,
    output,
    everything: () => JSON.stringify({ lines: p.lines, checks: p.checks, relayed: p.relayed, errors: p.errors, results: p.results }),
  };
}

export type Bench = {
  machine: FakeMachine;
  kit: FakeKit;
  timeline: Timeline;
  resolver: ReturnType<typeof fakeResolver>;
  clock: { now: number };
  drawn: { count: number };
  deps(print: Printed, overrides?: Partial<SetupDependencies>): SetupDependencies;
};

/** A machine, a kit, a resolver over the mock's records, a clock: one test's whole world. */
export function bench(mock: CloudflareMock, home: string, options: MachineOptions & { lag?: number; token?: string | null } = {}): Bench {
  const timeline: Timeline = [];
  const machine = new FakeMachine(timeline, options);
  const kit = fakeKit(machine);
  const resolver = fakeResolver(() => mock.records, { questions: options.lag ?? 0 });
  const clock = { now: 1_791_000_000_000 };
  const drawn = { count: 0 };
  let counter = 0;
  return {
    machine,
    kit,
    timeline,
    resolver,
    clock,
    drawn,
    deps: (print, overrides = {}) => ({
      machine,
      kit: kit.run,
      resolve: resolver.resolve,
      sameMachine: async (a, b) => a === b,
      cloudflare: { base: mock.base },
      token: async () => (options.token === undefined ? TOKEN : options.token),
      drawPassword: async () => {
        drawn.count++;
        return { password: PORTAL_PASSWORD, hash: PORTAL_HASH };
      },
      sleep: async (ms) => {
        clock.now += ms;
      },
      now: () => clock.now,
      random: () => `r${++counter}`,
      home,
      environment: {},
      output: print.output,
      secrets: { portal: null },
      ...overrides,
    }),
  };
}
