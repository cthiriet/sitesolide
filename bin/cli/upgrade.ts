/**
 * `sitesolide upgrade`: the components `sitesolide setup` installed on the
 * configured machine, brought to the code this binary, or this checkout,
 * carries. Setup installs what is missing and never deploys again what is
 * there; this is the other half, for a machine already in service.
 *
 *   caddy-unit     Caddy's drop-in            setup's own run: install, daemon-reload, restart
 *   backups        the backup component       bin/deploy-backup.sh install, before the steward
 *   egress         the egress proxy           bin/deploy-egress.sh, the steward restarted after it
 *   steward        the steward                bin/deploy-steward.sh
 *   dashboard      the dashboard              sitesolide deploy in dashboard/
 *   collector      the collector's units      bin/deploy-collector.sh, after the dashboard
 *   gatekeeper     the gatekeeper             bin/deploy-gatekeeper.sh, after the dashboard
 *   installer      the team installer         bin/deploy-installer.sh, after the steward
 *   caddy-config   the Caddyfile              bin/deploy-caddy.sh
 *   api            the shared service         bin/deploy-api.sh
 *   portal         the portal                 sitesolide deploy in portal/
 *   monitor        the monitor                bin/deploy-monitor.sh
 *
 * The order is docs/upgrading.md's: the backup install before the steward,
 * whose unit opens the backups' folder only if it exists when it starts; the
 * egress proxy before the steward too, which must start again after it to
 * write the connectors' folder; the root components that only listen before
 * the dashboard, which accept the old one and the new one; the gatekeeper and
 * the installer, which embed the CLI's generators, after it.
 *
 * OUT OF DATE IS MEASURED, NEVER ASSUMED. Each component is a step of
 * bin/cli/steps.ts: a check that only reads, and a run, the very script or
 * `sitesolide deploy` setup runs for it, through setup's own runner. The check
 * is what setup checks for that component (COMPONENT_CONDITIONS), plus the
 * fingerprint of what would be installed against what is:
 *
 *   - a component its script builds, the steward or the monitor: the script's
 *     own `--fingerprint`, which builds as it would to install and prints the
 *     SHA-256 of every file it lays, compared on the machine with sha256sum,
 *     the measure the script itself verifies after installing;
 *   - a file the kit carries as it is, the Caddyfile, a drop-in, a unit: its
 *     SHA-256, the measure bin/deploy-caddy.sh compares;
 *   - the shared service: the digest of its tree as bin/deploy-api.sh sends
 *     it, against the release in service;
 *   - the dashboard and the portal: `sitesolide deploy --dry-run --compare`,
 *     deploy's own reading of what it would change on the server.
 *
 * Only what differs runs. A second run right after a successful one finds
 * every component up to date and changes nothing; a run after a failure
 * resumes at the component that failed, the ones before it found up to date.
 *
 * A COMPONENT THAT IS NOT INSTALLED IS NOT INSTALLED HERE. One read says
 * which components the machine carries; the others are reported missing, and
 * `sitesolide setup` is the command that installs them.
 *
 * WHAT IT NEVER DOES. It never reads, writes nor rotates a secret: no file of
 * /etc/sitesolide is read, no password drawn, the passwords' steps are
 * setup's alone. It never touches Caddy but through bin/deploy-caddy.sh and
 * systemctl, never `caddy stop` nor `caddy start` (see CLAUDE.md). It never
 * forces: a unit or a block edited by hand on the machine stays as deploy
 * leaves it, and says so.
 *
 * Everything that reaches the outside goes through `UpgradeDependencies`, so
 * that the tests run the whole sequence against the model machine and kit of
 * bin/tests/setup-fakes.ts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_VARIABLE, IncompleteConfig, mergeConfig, privateFolder, type Config } from "./config";
import { BAN_ADVICE, CONNECTION_LOST, HOST_KEY_CHANGED, hostKeyAdvice, machineCheck, rootCheck, rootRun, type Machine } from "./harden";
import { isCompiled, KitUnavailable, kitRoot, VERSION } from "./kit";
import { formatEvent } from "./output";
import {
  CADDY_DROP_IN,
  caddyUnitRun,
  childEnvironment,
  COMPONENT_CONDITIONS,
  kitRunner,
  LIB,
  present,
  setupOutput,
  sshMachine,
  UNITS,
  withoutToken,
  type KitRunner,
  type KitTask,
  type SetupOutput,
} from "./setup";
import { runSteps, StepFailure, type Check, type Condition, type Step, type StepReport } from "./steps";

// --- the command line ------------------------------------------------------------

export type UpgradeOptions = { dryRun: boolean; json: boolean };

export type Refusal = { message: string; details: string[] };

export const UPGRADE_USAGE = "usage: sitesolide upgrade [--dry-run] [--json]";

/** The command line, read; a refusal for anything it does not take. */
export function parseUpgradeArguments(arguments_: readonly string[]): UpgradeOptions | Refusal {
  const unknown = arguments_.filter((argument) => argument !== "--dry-run" && argument !== "--json");
  if (unknown.length > 0) {
    return {
      message: UPGRADE_USAGE,
      details: [
        `not an option of upgrade: ${unknown.join(" ")}`,
        "it upgrades the machine the configuration names: SITESOLIDE_CONFIG_DIR=<dir> before it for another installation",
        "see docs/upgrading.md",
      ],
    };
  }
  return { dryRun: arguments_.includes("--dry-run"), json: arguments_.includes("--json") };
}

// --- what upgrade depends on -------------------------------------------------------

export type UpgradeDependencies = {
  /** The machine at this host, reached as the account `exec` is given. */
  connect(host: string): Machine;
  kit: KitRunner;
  /** The kit's folder: the repository, or what a compiled binary unpacked. */
  kitRoot: string;
  home: string;
  environment: Record<string, string | undefined>;
  output: SetupOutput;
};

export type UpgradeContext = {
  machine: Machine;
  /** The account the configuration names, which has sudo without a password. */
  operator: string;
  server: string;
  config: Config;
  options: UpgradeOptions;
  deps: UpgradeDependencies;
  /** What every script and every `sitesolide deploy` upgrade launches receives. */
  childEnvironment: Record<string, string>;
  /** The components the machine carries. */
  installed: ReadonlySet<string>;
  /** The components this run found out of date, or upgraded: one that must follow them reads it. */
  due: Set<string>;
};

// --- fingerprints ---------------------------------------------------------------------

function sha256(content: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/** A path of the machine a fingerprint names: written into a check script, so nothing but these characters. */
const MACHINE_PATH = /^\/[A-Za-z0-9._@/-]+$/;

/** One file a deploy script would install: the SHA-256 of what it would lay, and where. */
export type Fingerprint = { sha256: string; path: string };

/**
 * The lines a deploy script prints with `--fingerprint`, as sha256sum prints
 * them: the fingerprint, two spaces, the path on the machine. Every other line
 * is the script talking, and is skipped.
 */
export function readFingerprints(output: string): Fingerprint[] {
  const found: Fingerprint[] = [];
  for (const line of output.split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match !== null && MACHINE_PATH.test(match[2]!)) found.push({ sha256: match[1]!, path: match[2]! });
  }
  return found;
}

/** The name a file is reported under: its own, as a check's label may spell it. */
export function labelFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name.replace(/[^a-z0-9:@.-]/g, "-").replace(/^[^a-z0-9]+/, "") || "file";
}

/** A condition that holds when the machine's file has this fingerprint: missing or different, it does not. */
export function sameFile(fingerprint: Fingerprint, label = labelFor(fingerprint.path)): Condition {
  if (!/^[0-9a-f]{64}$/.test(fingerprint.sha256) || !MACHINE_PATH.test(fingerprint.path)) {
    throw new Error(`unexpected fingerprint: ${JSON.stringify(fingerprint)}`);
  }
  return { label, test: `[ "$(sha256sum '${fingerprint.path}' 2>/dev/null | cut -d' ' -f1)" = '${fingerprint.sha256}' ]` };
}

/** What a file of the kit becomes on the machine, laid as it is. */
function kitFile(context: UpgradeContext, path: string, destination: string, label?: string): Condition {
  return sameFile({ sha256: sha256(readFileSync(join(context.deps.kitRoot, path))), path: destination }, label);
}

/**
 * The drop-in as setup lays it, a final line break ensured: see caddyUnitRun,
 * which this fingerprint has to match.
 */
function dropIn(root: string): string {
  const text = readFileSync(join(root, "infra", "caddy", "caddy.service.d", "override.conf"), "utf8");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** What bin/deploy-api.sh leaves out of a release, at any depth, as its rsync does. */
export const API_LEFT_OUT = ["node_modules", "deploy"] as const;

/**
 * The files of a tree as `find . -type f | sort | xargs sha256sum` lists them,
 * the names in `skip` left out at any depth with what they hold: one line per
 * file, its fingerprint, two spaces, `./` and its path, in the byte order
 * `LC_ALL=C sort` gives. A symbolic link is no file to find, and none here.
 */
export function treeListing(root: string, skip: readonly string[]): string {
  const files: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative === "" ? root : join(root, relative), { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(`./${path}`);
    }
  };
  walk("");
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return files.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}\n`).join("");
}

/** The digest of that listing: one fingerprint for a whole tree. */
export function treeDigest(root: string, skip: readonly string[]): string {
  return sha256(treeListing(root, skip));
}

/** The same digest, computed on the machine, for the tree at `folder`. */
export function treeDigestCommand(folder: string, skip: readonly string[]): string {
  if (!MACHINE_PATH.test(folder) || skip.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))) throw new Error(`unexpected tree: ${folder}`);
  const pruned = skip.map((name) => `-name '${name}'`).join(" -o ");
  return `cd ${folder} && find . \\( ${pruned} \\) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1`;
}

// --- the checks --------------------------------------------------------------------------

/** The components' checks, each its own tag, run as root through the operator. */
function machineState(context: UpgradeContext, id: string, conditions: Condition[]): Promise<Check> {
  const tag = `upgrade:${id}:check`;
  return rootCheck(context.machine, context.operator, tag, machineCheck(tag, conditions));
}

/** The files a deploy script would install, from its own `--fingerprint`. */
async function scriptFingerprints(context: UpgradeContext, name: string): Promise<Condition[]> {
  const task: KitTask = { kind: "script", name, args: ["--fingerprint"], quiet: true };
  const { code, output } = await context.deps.kit(task, context.childEnvironment);
  const said = output.split("\n").filter((line) => line.trim() !== "").at(-1) ?? "nothing";
  if (code !== 0) throw new StepFailure(`bin/${name} --fingerprint failed (exit code ${code}): ${said}`);
  const fingerprints = readFingerprints(output);
  if (fingerprints.length === 0) throw new StepFailure(`bin/${name} --fingerprint printed no fingerprint: ${said}`);
  return fingerprints.map((fingerprint) => sameFile(fingerprint));
}

/** The last event a command printed under --json: its `result` or its `error`. */
export function lastEvent(output: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (event !== null && typeof event === "object" && ((event as { type?: unknown }).type === "result" || (event as { type?: unknown }).type === "error")) {
        last = event as Record<string, unknown>;
      }
    } catch {
      // Not an event: a line of a build, or of a script.
    }
  }
  return last;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * A component `sitesolide deploy` installs: deploy's own comparison with the
 * server, then what setup checks for it. A unit edited on the machine, which
 * deploy leaves as it is without --force, is said, and never counted: no run
 * of upgrade would change it.
 */
async function deployedState(context: UpgradeContext, folder: "dashboard" | "portal", conditions: Condition[]): Promise<Check> {
  context.deps.output.say(`   ${folder}/: compared with the server by sitesolide deploy --dry-run --compare, its build first`);
  const task: KitTask = { kind: "deploy", folder, args: ["--dry-run", "--compare", "--json"], quiet: true };
  const { code, output } = await context.deps.kit(task, context.childEnvironment);
  const event = lastEvent(output);
  if (event === null || event.type !== "result" || event.compared !== true) {
    const message = event !== null && typeof event.message === "string" ? event.message : `no result (exit code ${code})`;
    return { state: "unreadable", reason: `sitesolide deploy --dry-run --compare in ${folder}/: ${message}` };
  }
  for (const path of strings(event.kept)) {
    context.deps.output.say(`!! ${path} differs from the unit deploy generates, and stays as it is: read it, then deploy ${folder}/ with --force if it should go`);
  }
  const machine = await machineState(context, folder, conditions);
  if (machine.state === "unreadable") return machine;
  const missing = [...strings(event.changes), ...(machine.state === "missing" ? machine.missing : [])];
  return missing.length === 0 ? { state: "done" } : { state: "missing", missing };
}

/**
 * The steward can write the backups' folder: systemd opened it to the steward
 * when it started, which only happens if the folder existed then. Read in the
 * steward's own mounts, where ReadWritePaths lays one per path it opens.
 */
export const STEWARD_WRITES_BACKUPS: Condition = {
  label: "steward-writes-backups",
  test: "! test -d /var/lib/sitesolide-backup || { pid=$(systemctl show -p MainPID --value sitesolide-steward) && [ \"${pid:-0}\" != 0 ] && awk '$5 == \"/var/lib/sitesolide-backup\"' /proc/$pid/mountinfo | grep -q .; }",
};

// --- the components --------------------------------------------------------------------------

/** A script of the kit's bin/, run with upgrade's environment; what it printed quoted when it fails. */
async function script(context: UpgradeContext, name: string, args: string[] = []): Promise<void> {
  const { code, output } = await context.deps.kit({ kind: "script", name, args }, context.childEnvironment);
  if (code !== 0) throw new StepFailure(`bin/${[name, ...args].join(" ")} failed (exit code ${code})`, tail(output));
}

async function deployFolder(context: UpgradeContext, folder: "dashboard" | "portal"): Promise<void> {
  const { code, output } = await context.deps.kit({ kind: "deploy", folder }, context.childEnvironment);
  if (code !== 0) throw new StepFailure(`sitesolide deploy in ${folder}/ failed (exit code ${code})`, tail(output));
}

/** The end of what a command printed, for the report of a failure. */
function tail(output: string): string[] {
  return output.split("\n").filter((line) => line.trim() !== "").slice(-8);
}

function journal(context: UpgradeContext, unit: string): string {
  return `ssh ${context.server} 'sudo journalctl -u ${unit} -n 50'`;
}

/** One component: how upgrade tells it is there, what it checks, what it runs. */
export type Component = {
  id: string;
  title: string;
  /** Whether the machine carries the component at all, read for every one of them in a single connection. */
  installed: Condition;
  /** What a run does, for the dry run and the report. */
  plan: string;
  check(context: UpgradeContext): Promise<Check>;
  run(context: UpgradeContext): Promise<void>;
  inspect(context: UpgradeContext): string;
};

/** Every component, in the order they are brought up to date. */
export function upgradeComponents(): Component[] {
  const C = COMPONENT_CONDITIONS;
  return [
    {
      id: "caddy-unit",
      title: "Caddy's drop-in",
      installed: present("installed", CADDY_DROP_IN),
      plan: "the drop-in installed, systemctl daemon-reload, systemctl restart caddy",
      check: (context) =>
        machineState(context, "caddy-unit", [...C["caddy-unit"], sameFile({ sha256: sha256(dropIn(context.deps.kitRoot)), path: CADDY_DROP_IN })]),
      run: (context) => rootRun(context.machine, context.operator, "setup:caddy-unit:run", caddyUnitRun(dropIn(context.deps.kitRoot)), "Caddy did not restart with its drop-in"),
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "backups",
      title: "backups",
      installed: present("installed", `${LIB}/backup.js`),
      plan: "bin/deploy-backup.sh install",
      check: async (context) => machineState(context, "backups", [...C["backups-installed"], ...(await scriptFingerprints(context, "deploy-backup.sh"))]),
      run: (context) => script(context, "deploy-backup.sh", ["install"]),
      inspect: (context) => journal(context, "sitesolide-backup"),
    },
    {
      id: "egress",
      title: "egress proxy",
      installed: present("installed", `${LIB}/egress.js`),
      plan: "bin/deploy-egress.sh, the steward restarted after it",
      check: async (context) => machineState(context, "egress", [...C["egress-proxy"], ...(await scriptFingerprints(context, "deploy-egress.sh"))]),
      run: (context) => script(context, "deploy-egress.sh"),
      inspect: (context) => journal(context, "sitesolide-egress"),
    },
    {
      id: "steward",
      title: "steward",
      installed: present("installed", `${LIB}/steward.js`),
      plan: "bin/deploy-steward.sh",
      check: async (context) => {
        const found = await machineState(context, "steward", [
          ...C.steward,
          ...(await scriptFingerprints(context, "deploy-steward.sh")),
          ...(context.installed.has("egress") ? C["steward-after-egress"] : []),
          ...(context.installed.has("backups") ? [STEWARD_WRITES_BACKUPS] : []),
        ]);
        // A dry run runs nothing: the proxy found out of date would be
        // redeployed first, and the steward has to start again after it.
        if (context.options.dryRun && context.due.has("egress") && found.state !== "unreadable") {
          const missing = found.state === "missing" ? found.missing : [];
          if (!missing.includes("steward-after-egress")) return { state: "missing", missing: [...missing, "steward-after-egress"] };
        }
        return found;
      },
      run: (context) => script(context, "deploy-steward.sh"),
      inspect: (context) => journal(context, "sitesolide-steward"),
    },
    {
      id: "dashboard",
      title: "dashboard",
      installed: present("installed", "/srv/sites/dashboard/sitesolide.json"),
      plan: "sitesolide deploy in dashboard/",
      check: (context) => deployedState(context, "dashboard", C.dashboard),
      run: (context) => deployFolder(context, "dashboard"),
      inspect: (context) => journal(context, "dashboard"),
    },
    {
      id: "collector",
      title: "collector",
      installed: present("installed", `${UNITS}/sitesolide-collector.timer`),
      plan: "bin/deploy-collector.sh",
      check: (context) =>
        machineState(context, "collector", [
          ...C.collector,
          kitFile(context, "infra/collector/sitesolide-collector.service", `${UNITS}/sitesolide-collector.service`),
          kitFile(context, "infra/collector/sitesolide-collector.timer", `${UNITS}/sitesolide-collector.timer`),
        ]),
      run: (context) => script(context, "deploy-collector.sh"),
      inspect: (context) => journal(context, "sitesolide-collector"),
    },
    {
      id: "gatekeeper",
      title: "gatekeeper",
      installed: present("installed", `${LIB}/gatekeeper.js`),
      plan: "bin/deploy-gatekeeper.sh",
      check: async (context) =>
        machineState(context, "gatekeeper", [
          ...C.gatekeeper,
          ...(await scriptFingerprints(context, "deploy-gatekeeper.sh")),
          // The single template from before, which the script removes.
          { label: "no-previous-template", test: `! test -e ${UNITS}/sitesolide-gatekeeper@.service` },
        ]),
      run: (context) => script(context, "deploy-gatekeeper.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB} ${UNITS}/sitesolide-gatekeeper-*'`,
    },
    {
      id: "installer",
      title: "team installer",
      installed: present("installed", `${LIB}/installer.js`),
      plan: "bin/deploy-installer.sh",
      check: async (context) => machineState(context, "installer", [...C.installer, ...(await scriptFingerprints(context, "deploy-installer.sh"))]),
      run: (context) => script(context, "deploy-installer.sh"),
      inspect: (context) => `ssh ${context.server} 'ls -l ${LIB}/installer.js'`,
    },
    {
      id: "caddy-config",
      title: "the Caddyfile",
      installed: { label: "installed", test: "grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile" },
      plan: "bin/deploy-caddy.sh: validated, reloaded, verified, restored on failure",
      check: (context) => machineState(context, "caddy-config", [...C["caddy-config"], kitFile(context, "infra/caddy/Caddyfile", "/etc/caddy/Caddyfile", "caddyfile-current")]),
      run: (context) => script(context, "deploy-caddy.sh"),
      inspect: (context) => journal(context, "caddy"),
    },
    {
      id: "api",
      title: "shared service",
      installed: { label: "installed", test: "test -e /srv/api/current" },
      plan: "bin/deploy-api.sh",
      check: (context) =>
        machineState(context, "api", [
          ...C.api,
          kitFile(context, "api/deploy/sitesolide-api.service", `${UNITS}/sitesolide-api.service`),
          {
            label: "api-release",
            test: `[ "$(${treeDigestCommand("/srv/api/current", API_LEFT_OUT)})" = '${treeDigest(join(context.deps.kitRoot, "api"), API_LEFT_OUT)}' ]`,
          },
        ]),
      run: (context) => script(context, "deploy-api.sh"),
      inspect: (context) => journal(context, "sitesolide-api"),
    },
    {
      id: "portal",
      title: "portal",
      installed: present("installed", "/srv/sites/portal/sitesolide.json"),
      plan: "sitesolide deploy in portal/",
      check: (context) => deployedState(context, "portal", C.portal),
      run: (context) => deployFolder(context, "portal"),
      inspect: (context) => journal(context, "portal"),
    },
    {
      id: "monitor",
      title: "monitor",
      installed: present("installed", `${LIB}/monitor.js`),
      plan: "bin/deploy-monitor.sh",
      check: async (context) => machineState(context, "monitor", [...C.monitor, ...(await scriptFingerprints(context, "deploy-monitor.sh"))]),
      run: (context) => script(context, "deploy-monitor.sh"),
      inspect: (context) => journal(context, "sitesolide-monitor"),
    },
  ];
}

/** Why a component is left out: the machine does not carry it. */
export const NOT_INSTALLED = "not installed: sitesolide setup installs it";

/** The components as steps of the engine, the ones the machine does not carry left out. */
function upgradeSteps(components: readonly Component[]): Step<UpgradeContext>[] {
  return components.map((component) => ({
    id: component.id,
    title: component.title,
    skip: (context) => (context.installed.has(component.id) ? null : NOT_INSTALLED),
    check: (context) => component.check(context),
    run: async (context) => {
      await component.run(context);
    },
    inspect: (context) => component.inspect(context),
  }));
}

/** The survey: one condition per component, reported under its id. */
export function surveyScript(components: readonly Component[]): string {
  return machineCheck(
    "upgrade:survey:check",
    components.map((component) => ({ label: component.id, test: component.installed.test })),
  );
}

// --- the run ------------------------------------------------------------------------------

/** What a report says of its component. */
export type ComponentState = "up-to-date" | "out-of-date" | "missing" | "upgraded" | "failed";

export function stateOf(status: StepReport["status"]): ComponentState {
  switch (status) {
    case "done":
      return "up-to-date";
    case "todo":
      return "out-of-date";
    case "skip":
      return "missing";
    case "ok":
      return "upgraded";
    case "fail":
      return "failed";
  }
}

/** A report with what runs, or ran, for its component. */
export function withPlan(report: StepReport, plan: string): StepReport {
  if (report.status === "todo") return { ...report, detail: `${report.detail ?? "differs"}; would run ${plan}` };
  if (report.status === "ok") return { ...report, detail: `${(report.detail ?? "differed").replace(/^differs: /, "differed: ")}; ran ${plan}` };
  return report;
}

/** What this run brings the machine to: a release, or the checkout it runs from. */
function release(): string {
  if (VERSION !== "dev") return `release ${VERSION}`;
  return isCompiled() ? "this binary, version dev" : "this checkout";
}

function readFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runs upgrade; the exit code. */
export async function runUpgrade(options: UpgradeOptions, deps: UpgradeDependencies): Promise<number> {
  const out = deps.output;
  const refuse = (message: string, details: string[]): number => {
    out.error(message, details);
    return 1;
  };

  // 1. The configuration: the machine it names is the one upgraded, and no other.
  const folder = privateFolder(deps.home, deps.environment);
  let config: Config;
  try {
    config = mergeConfig(readFile(join(folder, "config.json")) as Partial<Config> | null, deps.environment, deps.home, (message) => out.say(`!! ${message}`));
  } catch (error) {
    if (!(error instanceof IncompleteConfig)) throw error;
    return refuse(`missing settings: ${error.missing.join(", ")}`, [
      `upgrade brings the machine ${join(folder, "config.json")} names to this release: it names none`,
      "a machine installed with setup has it written already: SITESOLIDE_CONFIG_DIR=<dir> before upgrade for another installation",
      "a machine installed by hand: sitesolide init --server <user@host> --zone <dns.zone> --email <address>",
      "a team token cannot upgrade a machine: its owner runs upgrade, over SSH",
    ]);
  }
  const at = config.server.lastIndexOf("@");
  if (at <= 0) {
    return refuse(`the configured server is not user@host: ${config.server}`, [
      "upgrade connects as the account that deploys, which has sudo without a password",
      "sitesolide init --server <user@host> writes it",
    ]);
  }
  const operator = config.server.slice(0, at);
  const host = config.server.slice(at + 1);
  const environmentPrefix = folder === privateFolder(deps.home, {}) ? "" : `${CONFIG_DIR_VARIABLE}=${folder} `;
  const setupCommand = `${environmentPrefix}sitesolide setup ${config.server} --zone ${config.zone} --email ${config.email}`;

  out.say(`-> upgrade of ${config.server}, zone ${config.zone}, to the code of ${release()}${options.dryRun ? ", dry run: nothing is changed on the machine" : ""}`);

  // 2. What the machine carries: one read, for every component.
  const machine = deps.connect(host);
  const components = upgradeComponents();
  const survey = await rootCheck(machine, operator, "upgrade:survey:check", surveyScript(components));
  if (survey.state === "unreadable") {
    const said = survey.reason;
    if (/a password is required|no tty present|terminal is required/.test(said)) {
      return refuse(`${config.server} has no sudo without a password, which upgrade needs`, [
        "upgrade runs every check and every script through sudo -n, as setup does: it never types a password",
        "setup leaves the deploy account with sudo without a password: the configuration may name another account",
      ]);
    }
    if (/Permission denied|Connection|timed out|No route|Could not resolve|Host key|kex_exchange|Broken pipe/i.test(said)) {
      return refuse(`cannot reach ${config.server} over SSH`, [
        said,
        ...(CONNECTION_LOST.test(said) ? BAN_ADVICE : []),
        ...(HOST_KEY_CHANGED.test(said) ? hostKeyAdvice(host) : []),
        "upgrade connects without a prompt: the key loaded in the agent (ssh-add), the machine up and its port open",
      ]);
    }
    return refuse(`cannot read what ${config.server} has installed: ${said}`, ["nothing was changed"]);
  }
  const missingIds = survey.state === "missing" ? survey.missing : [];
  const installed = new Set(components.map((component) => component.id).filter((id) => !missingIds.includes(id)));
  if (installed.size === 0) {
    return refuse(`nothing of sitesolide is installed on ${config.server}`, [
      "upgrade brings the components setup installed to this release, and installs none",
      `to install the machine: ${setupCommand}`,
    ]);
  }

  const context: UpgradeContext = {
    machine,
    operator,
    server: config.server,
    config,
    options,
    deps,
    childEnvironment: childEnvironment(deps.environment, { server: config.server, zone: config.zone, email: config.email, contact: config.contact, folder }, options.json),
    installed,
    due: new Set(),
  };
  const plans = new Map(components.map((component) => [component.id, component.plan]));

  // 3. The components, in order: each checked, and run only if it differs.
  const outcome = await runSteps(upgradeSteps(components), context, {
    checkOnly: options.dryRun,
    describe: (missing) => `differs: ${missing.join(", ")}`,
    report: (report) => {
      if (report.status === "todo" || report.status === "ok") context.due.add(report.step);
      out.check(withPlan(report, plans.get(report.step) ?? ""));
    },
    starting: (step) => out.say(`-> ${step.title}: ${plans.get(step.id) ?? ""}`),
  });

  const ids = (status: StepReport["status"]) => outcome.reports.filter((report) => report.status === status).map((report) => report.step);
  const upgraded = ids("ok");
  const missing = ids("skip");
  const listed = outcome.reports.map((report) => ({
    component: report.step,
    title: report.title,
    state: stateOf(report.status),
    detail: withPlan(report, plans.get(report.step) ?? "").detail,
    run: plans.get(report.step) ?? "",
  }));

  if (outcome.failure !== null) {
    const { step, message, details, inspect } = outcome.failure;
    // A machine that stopped answering in the middle of a run: asked once
    // more, it says so, and the report says what to do about it.
    const probe = await machine.exec(operator, "true");
    const lost = CONNECTION_LOST.test([message, ...details].join("\n")) || (probe.code !== 0 && CONNECTION_LOST.test(probe.error));
    out.error(lost ? `upgrade stopped at ${step}: the connection to the machine was refused or dropped` : `upgrade stopped at ${step}: ${message}`, [
      ...(lost ? [message] : []),
      ...details,
      ...(lost ? BAN_ADVICE : [`inspect: ${inspect}`, "run sitesolide upgrade again to resume: the components already up to date are skipped"]),
      ...(upgraded.length === 0 ? [] : [`upgraded before it: ${upgraded.join(", ")}`]),
    ]);
    return 1;
  }

  out.say("");
  if (options.dryRun) {
    const todo = ids("todo");
    out.say(todo.length === 0 ? "-> every installed component is up to date: nothing to do" : `-> dry run: ${todo.length} component(s) to upgrade, ${todo.join(", ")}; nothing was changed`);
  } else {
    out.say(upgraded.length === 0 ? `-> every installed component of ${config.server} was up to date: nothing was changed` : `-> upgraded on ${config.server}: ${upgraded.join(", ")}`);
  }
  if (missing.length > 0) out.say(`   not installed, left as they are: ${missing.join(", ")}; ${setupCommand} installs them`);
  out.result({
    dryRun: options.dryRun,
    server: config.server,
    zone: config.zone,
    release: release(),
    components: listed,
    upgraded,
    upToDate: ids("done"),
    outOfDate: ids("todo"),
    missing,
    next: missing.length === 0 ? [] : [setupCommand],
  });
  return 0;
}

// --- the real dependencies -------------------------------------------------------------

const STATE_WORDS: Record<StepReport["status"], string> = { done: "up to date", ok: "upgraded", todo: "out of date", skip: "missing", fail: "failed" };

function humanCheck(report: StepReport): string {
  return `${STATE_WORDS[report.status].padEnd(13)}${report.title.padEnd(20)}${report.detail ?? ""}`.trimEnd();
}

/** Setup's output, the checklist worded in upgrade's states, and `upgrade` named in its result. */
export function upgradeOutput(json: boolean, write: (line: string) => void = (line) => console.log(line)): SetupOutput {
  const base = setupOutput(json, write, "upgrade");
  return { ...base, check: (report) => write(json ? formatEvent({ type: "check", ...report }) : humanCheck(report)) };
}

/** `sitesolide upgrade ...`, from the command line: the exit code. */
export async function upgradeCommand(arguments_: readonly string[]): Promise<number> {
  const json = arguments_.includes("--json");
  const output = upgradeOutput(json);
  const parsed = parseUpgradeArguments(arguments_);
  if ("message" in parsed) {
    output.error(parsed.message, parsed.details);
    return 1;
  }
  let root: string;
  try {
    root = kitRoot();
  } catch (error) {
    if (!(error instanceof KitUnavailable)) throw error;
    output.error(error.message, error.details);
    return 1;
  }
  const environment = { ...process.env };
  const sshEnvironment = withoutToken(environment, json);
  return runUpgrade(parsed, {
    connect: (host) => sshMachine(host, sshEnvironment, output),
    kit: kitRunner(output, { capture: true }),
    kitRoot: root,
    home: homedir(),
    environment,
    output,
  });
}
