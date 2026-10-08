#!/usr/bin/env bun
/**
 * Deploys a project onto the machine from any repository.
 *
 *   sitesolide setup <user@host>    install the machine itself, see bin/cli/setup.ts
 *   sitesolide upgrade [--dry-run]  bring its components to this release, see bin/cli/upgrade.ts
 *   sitesolide detect [--write]     the manifest a folder without one implies
 *   sitesolide deploy [--dry-run]   prepare, build, push, install, verify
 *   sitesolide status               what the VM actually carries
 *   sitesolide logs [--follow]      journalctl for the service
 *   sitesolide backups              the project's data snapshots, read only
 *   sitesolide share [<email|@domain>...]   general access and people with access
 *   sitesolide people               everyone with access, and who may create projects
 *   sitesolide remove --confirm <slug>  take the project off the machine
 *   sitesolide run -- <command>     load the vault secret and run
 *   sitesolide mcp                  the same commands, as tools for an agent
 *   sitesolide login --url <url>    a team member: a token instead of SSH
 *   sitesolide machine create       a VM from a cloud provider's API, see cli/machine.ts
 *   sitesolide help, --version      without any configuration
 *
 * The scripts this file runs live in the kit, the repository or what a
 * compiled binary unpacks: see bin/cli/kit.ts and bin/build.ts.
 *
 * `--json` turns the output of every command but `init` and `run` into one
 * event per line, for agents: see the output section below, bin/cli/output.ts
 * and docs/agents.md.
 *
 * A workstation with no `server`, but a dashboard address and a token, is a
 * team member's: `deploy`, `status`, `logs` and `share` then go through the
 * dashboard's control API, and nothing below runs. See bin/cli/remote.ts.
 *
 * The interface is in English, options and messages alike: a CLI is a technical
 * identifier, like the manifest keys.
 *
 * ONE COMMAND IS ENOUGH, including on the first run: `deploy` creates the
 * system user, puts the unit in place and checks that every declared secret is
 * on the VM; one that is missing stops it, naming the dashboard's Secrets
 * section where it is created, and the same command then finishes. It never
 * replaces, on the other hand, a unit in service, whose contents may differ
 * from the generated one for good reasons: that case is reported, and
 * `--force` settles it by hand. Nor does it push or touch a secret, for another
 * reason: THE VM IS THE SOURCE OF TRUTH.
 * /etc/sitesolide is managed from the Secrets section of the dashboard, and a
 * deployment that measured the machine against the workstation's vault would
 * take every value changed over there for a lag to catch up on. Everything
 * `deploy` puts in place is idempotent: the second run changes nothing on the
 * machine.
 *
 * THE GENERAL ACCESS OF A DEPLOYED SITE IS SET FROM THE DASHBOARD, AND THE VM
 * IS THE SOURCE OF TRUTH THERE TOO. The dashboard's gatekeeper rewrites on the
 * machine the deposited manifest, the site's Caddy block and the preview locks,
 * without changing anything in the repository; `sitesolide lock` reaches the
 * same gatekeeper. Now `deploy` deposits the repository's manifest again and
 * generates the block from it: without precaution, it would silently reopen a
 * site the dashboard has just closed, or drop the code it set. `deploy`
 * therefore reads the deposited manifest first. If its `portal` or its `lock`
 * differs from the local manifest's, it is its own that holds for everything
 * `deploy` generates and deposits, and the local sitesolide.json is rewritten
 * so that the repository catches up with the machine: to be committed. A first
 * deployment, which the machine does not know, takes the repository's value; an
 * unreadable read stops everything. bin/deploy-caddy.sh holds the same rule for
 * the block it is given, and refuses to deposit one that would contradict the
 * VM. See bin/cli/portal-vm.ts.
 *
 * THE GATEKEEPER AND THIS CLI NEVER TOUCH CADDY AT THE SAME TIME. The read from
 * the start is several minutes old when `deploy` deposits the manifest and the
 * block, and a gesture of the gatekeeper falling between the two was
 * overwritten without warning. `deploy` therefore takes the shared lock,
 * /run/sitesolide-gatekeeper/caddy.lock, just before its first deposit, reads
 * the door again under it, which decides, and releases it at the end of the
 * Caddy step; `remove` holds it from start to finish. The scripts launched in
 * the meantime receive the ownership through CADDY_LOCK_HELD. The lock is
 * released on every path, failure and interruption included: see
 * releaseCaddyLock and bin/cli/caddy-lock.ts.
 *
 * `deploy` deposits its own project's block and nothing else: the blocks of
 * the other sites are the machine's, and nothing on the workstation keeps a
 * copy of them. Before the build, it confronts the block it will generate with
 * the one in service, so that a refusal never falls after the code was pushed.
 *
 * Instructions in docs/commands.md. This file carries only the orchestration:
 * what decides lives in bin/cli/, as pure functions tested by
 * bin/tests/cli-*.test.ts.
 *
 * TWO PROHIBITIONS, each paid for with an incident:
 *
 *   - neither `caddy stop` nor `caddy start`, which address the administration
 *     API of the instance in service whatever --config is given, and have
 *     already cut the three domains for 23 minutes on 11 August 2026;
 *   - never /etc/caddy/domaines.map nor /etc/caddy/locks/*.caddy, produced on
 *     the VM: overwriting them from the workstation would reopen locked previews.
 *
 * The remote commands go through Bun.spawn with an array of arguments, never
 * through an assembled string: the escaping of a slug or of a path must not
 * depend on the punctuation it contains.
 */
import { resolve4, resolve6 } from "node:dns/promises";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { compareDirectives, countItemized, sameDirectives, summariseDivergence } from "./cli/comparison";
import {
  adoptLegacyKeys,
  composeConfig,
  configPath,
  deploymentAccount,
  OPTIONAL_SETTINGS,
  writeConfig,
  IncompleteConfig,
  legacyKeysWarning,
  projectsRepo,
  readConfig,
  readConfigFile,
  type Config,
} from "./cli/config";
import { backupComponentCommand, backupsReport, readBackupComponent } from "./cli/backups";
import { sourceRefusal } from "./cli/source";
import { decideBlock, generateFragment } from "./cli/fragment";
import { hintFor } from "./cli/hints";
import { inferManifest, renderManifest, slugFromFolder, type Inference } from "./cli/infer";
import {
  isApp,
  isProtected,
  isSystemName,
  isValidSlug,
  mainPort,
  missingExclusions,
  NEVER_SENT,
  readManifest,
  servicesOf,
  setDomainActive,
  setLock,
  setPortal,
  validate,
  PORTAL_SLUG,
  SERVICE_PORTS,
  type Manifest,
} from "./cli/manifest";
import {
  eventFor,
  forEachLine,
  formatEvent,
  readJournalEntry,
  readLockState,
  readStatus,
  type OutputEvent,
} from "./cli/output";
import { choosePort, needsPort, setPort } from "./cli/ports";
import {
  switchAnnouncement,
  depositedManifestPath,
  readManifestsCommand,
  readDepositedManifests,
  confirmDoorUnderLock,
  decidePortal,
  guardDepositedManifest,
  readDepositedManifest,
  readManifestAmongAll,
  type ManifestAction,
  type DepositedRead,
} from "./cli/portal-vm";
import {
  isValidConfirmation,
  ownershipReleaseCommand,
  readOwnershipRelease,
  removalSteps,
  leftToDo,
} from "./cli/removal";
import {
  dashboardAddress,
  decideSecret,
  readPresenceAnswer,
  type SecretAction,
  type PresenceRead,
} from "./cli/secrets";
import {
  secretPath,
  projectPaths,
  decideUnit,
  generateUnits,
  readUnitAnswer,
  sandboxedInstallCommand,
  type UnitRead,
  MARKER_ABSENT,
  MARKER_PRESENT,
  systemUser,
  unitArgument,
} from "./cli/unit";
import {
  lockCommand,
  readRelease,
  takeLock,
  releaseScript,
  HELD_VARIABLE,
  type Execution,
} from "./cli/caddy-lock";
import { PROJECT_PORTS_FILE, projectPortPairs, projectPortsFile, reachesOwnPorts, type ProjectAccount } from "./cli/loopback";
import { declaresConnectors, declaresEgress, egressStateCommand, readEgressState } from "./cli/egress";
import { machine } from "./cli/machine";
import { eventOutput, humanOutput, login, remoteMode, REMOTE_USAGE, runRemote } from "./cli/remote";
import { KitUnavailable, kitEnv, kitRoot, projectEnv, VERSION, workingFolder } from "./cli/kit";
import { ownerGeneralCommand, PEOPLE_USAGE, people, SHARE_USAGE, share, sshAccess, sshGeneral, sshPeople } from "./cli/access";
import {
  foreignUnit,
  listUnitsCommand,
  loopbackStateCommand,
  portConflicts,
  projectPortsCommand,
  readCurrentPairs,
  currentPairsCommand,
  readLoopbackState,
  readUidsAnswer,
  readUnitOrigins,
  readUnitsAnswer,
  removeUnitsCommand,
  staleUnits,
  uidsCommand,
  unitOriginsCommand,
  unitPath,
} from "./cli/services";

const MANIFEST_NAME = "sitesolide.json";

/**
 * Sets what a deployment has just sent to the modes the control API's archive
 * gives: directories and executables 755, the rest 644.
 *
 * rsync -a carries the workstation's modes, and what it sends is read by
 * another account than the one that owns it: the service as site-<slug>, the
 * public files as caddy. A file written under a umask of 077 landed 0600, and
 * the service died on EACCES at startup. Measured on 6 October 2026, the
 * dashboard's borrowed/ copies on a fresh machine. Done on the machine rather
 * than with rsync's --chmod, which the openrsync macOS ships ignores without a
 * word, locally and remotely alike.
 *
 * Only what the deployment account owns, which is what rsync wrote: app/ also
 * holds what `install` left there as site-<slug>, and a chmod -R would stop on
 * the first of those files. Those are pruned, not entered: a directory of
 * theirs may well be closed to this account.
 */
function sentModesCommand(path: string): string {
  return `find ${path} ! -user "$(id -un)" -prune -o -exec chmod u+rwX,go=rX {} +`;
}

type Project = {
  /** Where sitesolide.json lives, and where a door changed from the dashboard is written back. */
  folder: string;
  /**
   * The folder whose content leaves: the manifest's own, or the one its
   * `source` names. The build, the exclusions, the public files and the upload
   * all start from here.
   */
  code: string;
  manifest: Manifest;
  /**
   * The manifest's text as it will leave for the VM. It follows `manifest`:
   * when the dashboard has changed the door, both carry the VM's value, in a
   * dry run as for real.
   */
  raw: string;
};

// --- output ------------------------------------------------------------------

/**
 * `--json`: every line printed below becomes one event on standard output,
 * and the run ends with one `result` or one `error`, which carries a hint an
 * agent can act on. See bin/cli/output.ts and bin/cli/hints.ts.
 *
 * The choice is made here and nowhere else: the call sites keep saying what
 * they always said, and the human output is what it was. The few commands
 * that hand over data rather than lines, status, logs, `lock --status` and
 * `domain`, add it to the final event with `note`. What the commands launched
 * print goes through `relayOutput`, so that nothing but events reaches
 * standard output.
 */
let jsonOutput = false;

/** What the run concluded, gathered on the way for the `result` event. */
const outcome: Record<string, unknown> = {};

function emit(event: OutputEvent): void {
  console.log(formatEvent(event));
}

function say(message: string): void {
  if (!jsonOutput) return console.log(message);
  const event = eventFor(message);
  if (event !== null) emit(event);
}

function step(message: string): void {
  if (jsonOutput) return emit({ type: "step", message });
  console.log(`-> ${message}`);
}

/** Something wrong that stops nothing. */
function warn(message: string, details: string[] = []): void {
  if (jsonOutput) return emit({ type: "warning", message, details });
  console.error(`!! ${message}`);
  for (const line of details) console.error(`   ${line}`);
}

/**
 * The last event of a run, under --json: the Caddy lock released first, so
 * that the warning a failed release prints comes before the `result` or the
 * `error`, never after the line an agent reads as the end. The `exit` event
 * still releases it on the paths that never get here.
 */
function finalEvent(event: OutputEvent): void {
  releaseCaddyLock();
  emit(event);
}

function die(message: string, details: string[] = []): never {
  if (jsonOutput) {
    finalEvent({ type: "error", message, details: details.filter((line) => line.trim() !== ""), hint: hintFor(message) });
    process.exit(1);
  }
  console.error(`!! ${message}`);
  for (const line of details) console.error(`   ${line}`);
  process.exit(1);
}

/** Adds to what the `result` event carries. Prints nothing, in either mode. */
function note(fields: Record<string, unknown>): void {
  Object.assign(outcome, fields);
}

/** A generated file shown before anything leaves: a `file` event, or its text under a title. */
function showFile(name: string, content: string, spaced = true): void {
  if (jsonOutput) return emit({ type: "file", name, content });
  if (spaced) say("");
  say(`--- ${name} ---`);
  say(content);
}

/**
 * What a launched command writes, as `output` events under --json. In human
 * mode the stream is the terminal's, `"inherit"`, and there is nothing to
 * relay.
 */
function relayOutput(stream: unknown, name: "stdout" | "stderr"): Promise<void> {
  if (!(stream instanceof ReadableStream)) return Promise.resolve();
  return forEachLine(stream, (line) => emit({ type: "output", stream: name, line }));
}

/** Where a launched command writes: the terminal, or a pipe whose lines become events. */
function childOutput(): "inherit" | "pipe" {
  return jsonOutput ? "pipe" : "inherit";
}

/** Turns --json on for this run. Only the options before `--` count: what follows belongs to the command `run` launches. */
function chooseOutput(arguments_: string[]): void {
  const separator = arguments_.indexOf("--");
  jsonOutput = (separator === -1 ? arguments_ : arguments_.slice(0, separator)).includes("--json");
}

/**
 * The environment of a launched command: this process's, `extra` on top.
 * Undefined in human mode without `extra`, which leaves Bun.spawn as it was.
 *
 * Under --json, ssh never waits for a keyboard: a passphrase or a host key to
 * confirm fails the connection at once, through an askpass that answers
 * nothing, instead of hanging an agent that has no terminal to type in. The
 * scripts of bin/ inherit it. It is passed at every spawn because Bun.spawn,
 * given no `env`, hands down the environment the process started with, not
 * what was assigned to process.env since.
 */
function childEnvironment(extra?: Record<string, string>): Record<string, string | undefined> | undefined {
  if (!jsonOutput && (extra === undefined || Object.keys(extra).length === 0)) return undefined;
  const silent = jsonOutput ? { SSH_ASKPASS_REQUIRE: "force", SSH_ASKPASS: Bun.which("false") ?? "/usr/bin/false" } : {};
  return { ...process.env, ...silent, ...extra };
}

// --- the kit -----------------------------------------------------------------

/**
 * The scripts of bin/ and the files they read live in the kit: the
 * repository, or the folder a compiled binary unpacks them into. Every path
 * to one of them goes through here, never through this file's own location,
 * which inside a binary is a file system nothing else can read. See
 * bin/cli/kit.ts.
 *
 * A kit that cannot be unpacked is a refusal like any other, with its hint
 * under --json, and never a stack trace.
 */
function fromKit<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof KitUnavailable) die(error.message, error.details);
    throw error;
  }
}

/** A script of bin/, in the kit. */
function script(name: string): string {
  return join(fromKit(kitRoot), "bin", name);
}

/**
 * The environment of the project's own build, and of the command `run`
 * starts: undefined, which leaves Bun.spawn as it was, unless a compiled
 * binary on a workstation without Bun lends its own, last on the PATH. See
 * projectEnv in bin/cli/kit.ts.
 */
function projectEnvironment(): Record<string, string | undefined> | undefined {
  const extra = fromKit(projectEnv);
  return Object.keys(extra).length === 0 ? undefined : { ...process.env, ...extra };
}

/** The final event of a run that succeeded, under --json. */
function finish(command: string): void {
  if (jsonOutput) finalEvent({ type: "result", ok: true, command, ...outcome });
}

// --- Caddy lock --------------------------------------------------------------

/**
 * The lock shared with the gatekeeper, as long as this process holds it: the
 * holder line and the machine that carries it. One take per process only.
 */
let heldLock: { line: string; server: string } | null = null;

/**
 * The commands launched by the executor and not finished yet. An interruption
 * falling during one of them lets it finish: it may be bin/deploy-caddy.sh in
 * the middle of a restore, under the lock passed on to it, and releasing the
 * lock before it ends would reopen the window it closes.
 */
let running = 0;
let interruption: { signal: string; code: number } | null = null;

/**
 * Releases the lock, if it is held. Synchronous, because it is also called from
 * the `exit` event: `die` leaves through process.exit, which unwinds no
 * `finally`, and that is what makes it safe on every path. A release that fails
 * warns and stops nothing: the lock is taken over after fifteen minutes, and
 * the warning says how to remove it by hand.
 */
export function releaseCaddyLock(): void {
  if (heldLock === null) return;
  const { line, server } = heldLock;
  heldLock = null;
  let execution: Execution;
  try {
    // Bounded and without a prompt: this release can run after a Ctrl-C, and
    // must neither wait for a passphrase nor hang on a dead connection.
    const proc = Bun.spawnSync(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", server, lockCommand(releaseScript(line))],
      {
        env: childEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    execution = {
      code: proc.exitCode ?? 1,
      output: proc.stdout.toString(),
      error: proc.stderr.toString(),
    };
  } catch (error) {
    execution = { code: 1, output: "", error: (error as Error).message };
  }
  const release = readRelease(line, execution);
  if (release.kind === "warning") warn(release.message, release.details);
}

/**
 * Takes the lock before the first deposit, or refuses. `after` says what the
 * refusal leaves behind, which is not the same depending on the step: nothing
 * for `remove`, the files already pushed for `deploy`.
 *
 * In a dry run, nothing is taken: taking it is a write on the VM.
 */
async function takeCaddyLock(config: Config, executor: Executor, after: string): Promise<void> {
  if (heldLock !== null) return;
  if (executor.simulated) {
    say("   [dry-run] take the Caddy lock shared with the dashboard's gatekeeper");
    return;
  }
  armRelease();
  step("Caddy lock, shared with the dashboard's gatekeeper");
  const acquisition = await takeLock("deploy", process.pid, (command) => executor.execute(config, command));
  if (acquisition.kind === "rejects") die(acquisition.message, [...acquisition.details, after]);
  heldLock = { line: acquisition.line, server: config.server };
  for (const announcement of acquisition.announcements) say(`   ${announcement}`);
  stopIfInterrupted();
}

/**
 * The lock released on every path: `die` and any exit go through the `exit`
 * event, and so does an interruption, once the running command has finished.
 * Armed just before the first take, and not before: a command that does not
 * touch Caddy keeps the ordinary behaviour of Ctrl-C.
 */
let armed = false;
function armRelease(): void {
  if (armed) return;
  armed = true;
  process.on("exit", releaseCaddyLock);
  process.on("SIGINT", () => interrupt("SIGINT", 130));
  process.on("SIGTERM", () => interrupt("SIGTERM", 143));
}

/** What the scripts launched under the lock receive, so as not to take it again. */
function envUnderLock(config: Config): Record<string, string> {
  return heldLock === null
    ? { SITESOLIDE_SERVER: config.server }
    : { SITESOLIDE_SERVER: config.server, [HELD_VARIABLE]: heldLock.line };
}

/**
 * An interruption during a running command lets it finish, and stops
 * everything when it returns; a second interruption, or an interruption
 * between two commands, exits at once. In both cases the lock is released by
 * the `exit` event.
 */
function interrupt(signal: string, code: number): void {
  if (interruption !== null || running === 0) {
    // Under --json, the run still ends with its error, the lock released
    // before it, rather than with nothing at all.
    if (jsonOutput) finalEvent({ type: "error", message: `interrupted by ${signal}`, details: [], hint: hintFor(`interrupted by ${signal}`) });
    process.exit(code);
  }
  interruption = { signal, code };
  warn(`${signal}: the running step finishes first, then everything stops`);
}

function stopIfInterrupted(): void {
  if (interruption === null) return;
  const message = `interrupted by ${interruption.signal}`;
  if (jsonOutput) finalEvent({ type: "error", message, details: [], hint: hintFor(message) });
  else console.error(`!! ${message}`);
  process.exit(interruption.code);
}

// --- execution ---------------------------------------------------------------

/**
 * Everything that leaves the process goes through here. In dry-run mode, the
 * command is shown and nothing leaves: that is what makes an end-to-end test
 * possible without touching the machine that serves the clients.
 */
class Executor {
  constructor(private readonly dryRun: boolean) {}

  get simulated(): boolean {
    return this.dryRun;
  }

  async run(
    command: string[],
    options: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {},
  ): Promise<string> {
    if (this.dryRun) {
      say(`   [dry-run] ${command.join(" ")}`);
      return "";
    }
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      // The scripts of bin/ read SITESOLIDE_SERVER as the CLI reads its configuration:
      // without this line, a workstation aiming at another machine through its
      // configuration file would see deploy-caddy.sh and deploy-secrets.sh talk
      // to the default one, that is to say to production.
      //
      // The kit's environment comes first, its own `bun` on the PATH when this
      // is a compiled binary: the scripts call it, and the workstation may have
      // none.
      env: childEnvironment({ ...fromKit(kitEnv), ...options.env }),
      stdout: options.quiet ? "pipe" : childOutput(),
      stderr: childOutput(),
    });
    running++;
    let output = "";
    let code: number;
    try {
      const relayed = Promise.all([options.quiet ? null : relayOutput(proc.stdout, "stdout"), relayOutput(proc.stderr, "stderr")]);
      output = options.quiet ? await new Response(proc.stdout).text() : "";
      await relayed;
      code = await proc.exited;
    } finally {
      running--;
    }
    stopIfInterrupted();
    if (code !== 0) die(`failed (${code}): ${command.join(" ")}`);
    return output;
  }

  /**
   * A command on the VM whose code and outputs are returned as they are, for
   * the lock and for `share`, which read them themselves. Never
   * short-circuited by the dry-run mode: it is only called outside it.
   * `input` goes to the command's standard input, never into its arguments.
   */
  async execute(config: Config, command: string, input?: string): Promise<Execution> {
    const proc = Bun.spawn(["ssh", config.server, command], {
      env: childEnvironment(),
      ...(input === undefined ? {} : { stdin: new TextEncoder().encode(input) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    running++;
    try {
      const [output, error] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, output, error };
    } finally {
      running--;
    }
  }

  /** A command on the VM. The remote shell receives one single string, quoted here. */
  ssh(config: Config, command: string, quiet = false): Promise<string> {
    return this.run(["ssh", config.server, command], { quiet });
  }

  /**
   * Read only: never short-circuited by the dry-run mode, it changes nothing. A
   * remote command that fails is reported rather than swallowed: an empty and
   * silent output made `status` look mute while the remote shell was refusing
   * its syntax.
   */
  async read(config: Config, command: string): Promise<string> {
    const proc = Bun.spawn(["ssh", config.server, command], {
      env: childEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) warn(`read refused by the server: ${error.trim() || "no message"}`);
    return output;
  }
}

// --- reading the project -----------------------------------------------------

/**
 * `raw` stands for a manifest not on disk: the one inferred for a dry run,
 * which writes nothing. `portLater` is `deploy`'s: an app without a port is
 * judged as if it had the one `deploy` is about to give it, see allocatePort.
 */
function readProject(folder: string, options: { raw?: string; portLater?: boolean } = {}): Project {
  const path = join(folder, MANIFEST_NAME);
  if (options.raw === undefined && !existsSync(path)) {
    die(`${MANIFEST_NAME} not found in ${folder}`, [
      "a deployable project declares its slug and what to do with it,",
      "with the keys listed in bin/cli/manifest.ts of the platform",
    ]);
  }

  const raw = options.raw ?? readFileSync(path, "utf8");
  const read = readManifest(raw);
  const manifest = read.manifest;
  let errors = read.errors;
  if (manifest !== undefined && needsPort(manifest)) {
    const others = validate({ ...manifest, port: SERVICE_PORTS.last });
    if (options.portLater) errors = others;
    else if (others.length === 0) {
      die("port: required, and only deploy chooses one", [
        "this manifest declares no port yet: `sitesolide deploy` picks a free one on the server and writes it here",
      ]);
    }
  }
  if (manifest === undefined || errors.length > 0) {
    die(`${MANIFEST_NAME} rejected`, errors);
  }

  // The dependencies installed on the workstation never leave: a node_modules
  // from macOS or a .venv built for arm64 poured onto a Linux x86_64 machine
  // gives a service that does not start, after erasing the previous one.
  //
  // The check only targets application projects, the only ones whose folder
  // leaves by rsync. A showcase site pushes nothing but its publicDir, and
  // asking it to declare an exclusion with no effect refused the deployment of
  // three sites of the repository, whose node_modules carries only a Tailwind
  // compiler.
  // The code beside the manifest, or in the repository `source` names, which
  // then carries nothing about its deployment.
  const code = manifest.source === undefined ? folder : resolve(folder, manifest.source);
  if (!existsSync(code) || !statSync(code).isDirectory()) {
    die(`source not found: ${manifest.source} (${code})`, [
      "the path is relative to the folder holding sitesolide.json",
    ]);
  }
  // Outside the owner's sites repository, a manifest is someone else's text:
  // its source stays inside its own repository. See bin/cli/source.ts.
  const escape = manifest.source === undefined ? null : sourceRefusal(folder, code, projectsRepo());
  if (escape !== null) {
    die(escape, [
      "a manifest outside your sites repository may only point inside its own repository",
      "nothing was built nor sent: the build would have run there, and the folder been uploaded",
    ]);
  }

  const missing = isApp(manifest)
    ? missingExclusions(manifest, readdirSync(code))
    : [];
  if (missing.length > 0) {
    die(`exclude: ${missing.join(", ")} present on disk and not excluded`, [
      `add "exclude": [${missing.map((n) => `"${n}"`).join(", ")}] to the manifest`,
    ]);
  }

  return { folder, code, manifest, raw };
}

/**
 * The refusal common to both deployment files, which names what differs.
 *
 * The previous message blamed the wrong cause: it spoke of a hand-written file
 * when nine times out of ten the manifest has just changed. The two cases
 * resemble each other too much to be told apart for sure, but the directives
 * concerned do read: they say which of the two readings is the right one far
 * better than a general sentence.
 */
function refuseDivergence(path: string, current: string, generated: string): never {
  const divergence = compareDirectives(current, generated);
  die(`${path} no longer matches the manifest`, [
    "these directives differ (- only in the file, + only in the manifest):",
    ...summariseDivergence(divergence),
    "if the manifest is right, re-run with --force",
    "if the file is right, it carries something the manifest cannot express:",
    "read it before switching",
  ]);
}

/** A file on the machine, read with markers: absent, present with its content, or unreadable. */
async function readRemoteFile(config: Config, executor: Executor, path: string): Promise<UnitRead> {
  // The marker tells the missing file from the read that failed: without it, a
  // refused sudo would return the same emptiness as a file that does not
  // exist, and a hand-written file would be replaced without anything saying so.
  return readUnitAnswer(
    await executor.read(
      config,
      `if sudo test -f ${path}; then echo ${MARKER_PRESENT}; sudo cat ${path}; else echo ${MARKER_ABSENT}; fi`,
    ),
  );
}

/** Where a project's Caddy block lives on the machine. */
function blockPath(slug: string): string {
  return `/etc/caddy/sites/${slug}.caddy`;
}

/**
 * Confronts the block this deployment will generate with the one in service,
 * BEFORE anything is pushed.
 *
 * A block edited by hand on the machine carries a decision the generator knows
 * nothing of, and replacing it without saying so would erase it. The refusal
 * must fall before the build and the rsync: after them, the new code would stay
 * served by the old block, which is how this check came to be. It used to read
 * a copy kept on the workstation; the machine holds the block in service, so
 * it is read there.
 *
 * `doorConfirmed` says that the VM already carries the door of `manifest`. A
 * block that differs from the generated one by the door alone is then behind
 * the dashboard's change, and this deployment catches up with it: no --force
 * needed. Anything else calls for it.
 *
 * In a dry run nothing is asked of the machine: the generated block is shown.
 */
async function checkRemoteBlock(
  manifest: Manifest,
  config: Config,
  executor: Executor,
  replace: boolean,
  doorConfirmed: boolean,
): Promise<void> {
  const generated = generateFragment(manifest);
  if (generated === null || executor.simulated) return;
  const path = blockPath(manifest.slug);
  const reading = await readRemoteFile(config, executor, path);
  if (reading.kind === "unreadable") {
    die(`cannot tell whether ${path} is there`, [
      "the server answered neither an absence nor a block",
      "nothing was pushed: a block is never replaced on a reading that failed",
    ]);
  }
  const inService = reading.kind === "present" ? reading.content : null;
  switch (decideBlock({ manifest, inService, replace, doorConfirmed })) {
    case "deposit":
      return;
    case "upgrades":
      say(`   ${path} was written by an earlier release, the current one replaces it`);
      return;
    case "follows-door":
      say(`   ${path} will follow the portal set from the dashboard`);
      return;
    case "forced":
      say(`   --force: ${path} will be replaced by the generated one`);
      return;
    case "diverged":
      refuseDivergence(path, inService ?? "", generated);
  }
}

// --- deploy ------------------------------------------------------------------

/**
 * `--build`: a dry run runs the build too. Off by default.
 *
 * The build is the folder's own code, run by a shell on the workstation that
 * holds root SSH to the machine. A dry run is what an agent is told to try
 * first, through the MCP tool or `--json`, on a folder it may have just
 * cloned, before anyone has read it: running the build there turned "show me
 * what would happen" into "run this repository's code here". A dry run
 * therefore shows the step and skips it; whoever wants what it produces
 * checked asks for it, by typing `--build`.
 */
let buildInDryRun = false;

/**
 * `--compare`, with --dry-run: the build runs, as with --build, and the dry
 * run then measures on the server what this deployment would change there,
 * changing nothing. What `sitesolide upgrade` asks of the platform's own
 * components, the dashboard and the portal, to redeploy only those that
 * differ. See compareWithServer.
 */
let compareInDryRun = false;

/** Whether this run executes the build: always for real, in a dry run only with --build or --compare. */
function buildRuns(project: Project, executor: Executor): boolean {
  return project.manifest.build !== undefined && (!executor.simulated || buildInDryRun || compareInDryRun);
}

async function runBuild(project: Project, executor: Executor): Promise<void> {
  const { build } = project.manifest;
  if (build === undefined) return;
  if (!buildRuns(project, executor)) {
    say(`   [dry-run] build (${build}), not run: it is this folder's code, run here only for real or with --dry-run --build or --compare`);
    return;
  }
  step(`build (${build})`);
  const proc = Bun.spawn(["sh", "-c", build], {
    cwd: project.code,
    env: projectEnvironment(),
    stdout: childOutput(),
    stderr: childOutput(),
  });
  await Promise.all([relayOutput(proc.stdout, "stdout"), relayOutput(proc.stderr, "stderr")]);
  if ((await proc.exited) !== 0) die(`build failed: ${build}`);
}

function publicFolder(project: Project): string | null {
  const { publicDir } = project.manifest;
  return publicDir === undefined ? null : join(project.code, publicDir);
}

function checkPublicFolder(project: Project, executor?: Executor): void {
  const folder = publicFolder(project);
  if (folder === null) return;
  // A dry run that skipped the build cannot judge what the build produces.
  if (executor !== undefined && project.manifest.build !== undefined && !buildRuns(project, executor)) {
    say(`   [dry-run] check that the build fills ${project.manifest.publicDir}`);
    return;
  }
  if (!existsSync(folder)) {
    die(`publicDir not found: ${project.manifest.publicDir}`, ["did the build run?"]);
  }
  // This check protects the rsync's --delete: an empty folder erases the site.
  if (readdirSync(folder).length === 0) {
    die(`publicDir is empty: ${project.manifest.publicDir}`, [
      "rsync --delete would wipe the live site",
    ]);
  }
}

/**
 * The directory gestures, in order. Only the data folder belongs to the service
 * and is writable by it: the code and the public files stay with the deployment
 * account, and a deployment never makes them modifiable by the service.
 */
export function directoryCommands(slug: string, isApplication: boolean, owner: string): string[] {
  const paths = projectPaths(slug);
  const account = systemUser(slug);
  if (!isApplication) {
    return [
      `sudo mkdir -p ${paths.publicDir}`,
      `sudo chown ${owner}:${owner} ${paths.root} ${paths.publicDir}`,
      `sudo chmod 755 ${paths.root} ${paths.publicDir}`,
    ];
  }
  return [
    `sudo mkdir -p ${paths.app} ${paths.publicDir} ${paths.dataDir}`,
    `sudo chown ${owner}:${owner} ${paths.root} ${paths.app} ${paths.publicDir}`,
    `sudo chown -R ${account}:${account} ${paths.dataDir}`,
    `sudo chmod 755 ${paths.root} ${paths.app} ${paths.publicDir}`,
    `sudo chmod 750 ${paths.dataDir}`,
  ];
}

/**
 * The rsync that sends an application's code into app/: the command a
 * deployment runs, and the one `--compare` runs in a dry run. Its options come
 * first, so that the comparison can add its own after `-a`.
 */
function codeSync(project: Project, config: Config): string[] {
  const { manifest } = project;
  const exclusions = (manifest.exclude ?? []).flatMap((name) => ["--exclude", name]);
  const also = manifest.publicDir === undefined ? [] : ["--exclude", manifest.publicDir];
  return [
    "rsync",
    "-a",
    "--delete",
    ...exclusions,
    ...also,
    // .git and every .env, at any depth: see NEVER_SENT.
    ...NEVER_SENT.flatMap((pattern) => ["--exclude", pattern]),
    // The manifest is already deposited at the project's root, where the
    // service reads it: a second copy in app/ would make two of them diverge,
    // and nothing would say which one is authoritative.
    "--exclude",
    MANIFEST_NAME,
    `${project.code}/`,
    `${config.server}:${projectPaths(manifest.slug).app}/`,
  ];
}

/** The rsync that sends the public files, as codeSync for app/. */
function publicSync(publicDir: string, project: Project, config: Config): string[] {
  return [
    "rsync",
    "-a",
    "--delete",
    // Neither .git nor a .env is ever served: excluded here, at any depth,
    // and removed from the machine if an earlier deployment left one there,
    // which a mere exclusion would protect from --delete. The public tree
    // has no other exclusion this could reach.
    "--delete-excluded",
    ...NEVER_SENT.flatMap((pattern) => ["--exclude", pattern]),
    `${publicDir}/`,
    `${config.server}:${projectPaths(project.manifest.slug).publicDir}/`,
  ];
}

async function deploy(
  rawProject: Project,
  config: Config,
  executor: Executor,
  replace = false,
): Promise<void> {
  const slug = rawProject.manifest.slug;
  const paths = projectPaths(slug);
  const isApplication = isApp(rawProject.manifest);

  const serviceCount = servicesOf(rawProject.manifest).length;
  say(`-> project ${slug}, ${isApplication ? (serviceCount > 1 ? `${serviceCount} services` : "service") : "static"}`);
  if (rawProject.code !== rawProject.folder) say(`   code from ${rawProject.code}`);
  note({
    slug,
    kind: isApplication ? (serviceCount > 1 ? "services" : "service") : "static",
    dryRun: executor.simulated,
    manifestWritten: outcome.manifestWritten === true,
  });

  // The door before everything else, in a dry run as for real: the block shown,
  // the block checked, the order of the steps and the deposited manifest all
  // depend on it. From here on, `project` carries the value the VM makes
  // authoritative, and `rawProject` is of no further use. An app that declares
  // no port gets one first: every read of the manifest after this needs it.
  const { project, switched, doorConfirmed } = await reconcilePortal(await allocatePort(rawProject, config, executor), config, executor);
  const { manifest } = project;
  note({ port: mainPort(manifest), portal: isProtected(manifest) });
  if (switched) note({ manifestWritten: !executor.simulated });
  if (isApplication && executor.simulated) showGeneratedFiles(manifest);

  // Before the build and before anything is pushed: a refusal that falls after
  // the rsync and the restart leaves the new code served by the old block. The
  // blocks of the other sites are not this deployment's business: it deposits
  // its own, and leaves theirs as the machine carries them.
  if (isApplication) await checkRemoteBlock(manifest, config, executor, replace, doorConfirmed);
  if (isApplication) await checkUnitNames(manifest, config, executor);
  if (isApplication) await checkPorts(manifest, config, executor);
  // A backup command reaches its service on its port, through the same set.
  if (reachesOwnPorts(manifest)) await requireProjectSet(config, executor);
  if (declaresEgress(manifest) || declaresConnectors(manifest)) await requireEgress(config, executor);
  if (servicesOf(manifest).some((service) => service.backup !== null)) await checkBackupComponent(config, executor);
  const behindPortal = isProtected(manifest);
  if (behindPortal) await requirePortal(config, executor);

  await runBuild(project, executor);
  checkPublicFolder(project, executor);
  if (executor.simulated && compareInDryRun) {
    await compareWithServer(project, config, executor, doorConfirmed);
    return;
  }

  // The lock shared with the gatekeeper, taken just before the first deposit of
  // the manifest or of the block, and the door read again under it: it is that
  // read which decides, the one from the start being several minutes old. It is
  // held until the end of the Caddy step, the manifest deposit included, and
  // released before the verification, which changes nothing.
  let alreadyUnderLock = false;
  const enterUnderLock = async (): Promise<void> => {
    if (alreadyUnderLock) return;
    alreadyUnderLock = true;
    await takeCaddyLock(
      config,
      executor,
      "neither the manifest nor the Caddy block was deposited: rerun `sitesolide deploy` in a moment",
    );
    await rereadUnderLock(manifest, config, executor, isApplication);
  };

  // rsync only creates the last folder of the path: without this mkdir, a first
  // deployment fails on a project never put online. An application project has
  // more to prepare than a folder, and `deploy` takes care of it itself: see
  // prepareService, which puts in place what is missing and replaces nothing.
  if (isApplication) {
    await prepareService(project, config, executor, replace);
    // A protected site receives its door BEFORE its files: put in place first,
    // they would be served in the clear by the zone's wildcard block until the
    // fragment arrives. The reverse order, the one of the other projects,
    // avoids a 404 that would make deploy-caddy.sh restore; here the door
    // answers 401 whether the site exists or not, and the verification passes.
    if (behindPortal) {
      await enterUnderLock();
      await installFragment(manifest, config, executor);
    }
  } else {
    step("directories");
    await executor.ssh(config, directoryCommands(slug, false, deploymentAccount(config.server)).join(" && "));
  }

  if (isApplication) {
    step("application code");
    await executor.run(codeSync(project, config));
    await executor.ssh(config, sentModesCommand(paths.app));
  }

  const publicDir = publicFolder(project);
  if (publicDir !== null) {
    step("public files");
    await executor.run(publicSync(publicDir, project, config));
    await executor.ssh(config, sentModesCommand(paths.publicDir));
  }

  await enterUnderLock();
  await depositManifest(project, config, executor);
  // Under the lock, like the manifest it reads back from the machine: two
  // deployments rebuilding the set side by side would each drop the other's
  // project. Before the restart, which is when the services start calling
  // each other. A single service follows along too: a project that no longer
  // declares several must drop out of the set, before another project takes
  // its former ports.
  if (isApplication) await rebuildProjectPorts(config, executor, reachesOwnPorts(manifest) ? "services" : "follow");
  // With no Caddy step to follow, the lock has nothing left to protect: a
  // static site has none, a protected site has already put its door in place.
  if (!isApplication || behindPortal) releaseCaddyLock();

  if (isApplication) {
    // The secrets come after prepareService, which creates site-<slug>, and
    // after depositManifest. That order is what makes their refusal workable:
    // a secret missing everywhere is created from the Secrets section of the
    // dashboard, which only handles a project whose manifest it reads on the VM
    // and only puts a file in place in the name of its user. Both therefore
    // exist when `deploy` stops here, and running it again after the creation
    // is enough.
    await ensureSecrets(manifest, config, executor);

    if (manifest.install !== undefined) {
      step(`dependencies (${manifest.install}), as ${systemUser(slug)} in its service's walls`);
      await installAsProject(manifest, config, executor);
    }

    // Every unit named, rather than the main one alone and its PartOf: a
    // service that was never started would not be restarted by it, and
    // is-active must answer for each of them. reset-failed first: a release
    // that crash-looped past the start limit left its unit refusing any
    // start, the restart of the fix that follows included, until it is reset.
    const units = servicesOf(manifest).map((service) => unitArgument(service.unit)).join(" ");
    step(serviceCount > 1 ? "services restart" : "service restart");
    await executor.ssh(config, `sudo systemctl reset-failed ${units} 2>/dev/null; sudo systemctl restart ${units} && systemctl is-active ${units}`);

    if (!behindPortal) await installFragment(manifest, config, executor);
  }

  // The end of the Caddy step. The release is also guaranteed by the `exit`
  // event on every failure path, `die` unwinding no finally.
  releaseCaddyLock();
  await verify(manifest, config, executor);
  if (executor.simulated) {
    say("-> dry run, nothing was installed");
    return;
  }
  if (switched) {
    say("");
    say(`   commit ${MANIFEST_NAME}:`);
    say("   the dashboard changed its general access, and git should say what the server does.");
  }
}

/**
 * `deploy --dry-run --compare`: what this deployment would change on the
 * server, read there and changed nowhere. Each measure is the deployment's
 * own decision, made on what the server carries:
 *
 *   the code and the public files   the deployment's very rsync, in a dry run
 *                                   that compares contents (--checksum): an
 *                                   entry it would send or delete is a change,
 *                                   a time or a mode alone is not, the modes
 *                                   being set again on the machine anyway
 *   the manifest                    the deposited one, against the one leaving
 *   the units                       missing, or left by an earlier release's
 *                                   generator to be removed; one that differs
 *                                   is reported, never counted: deploy leaves it
 *                                   as it is without --force
 *   the Caddy block                 any difference, deploy-caddy.sh depositing
 *                                   what differs by a byte; one edited by hand
 *                                   is refused, as deploy refuses it
 *
 * A project the server does not carry yet is one change, everything to send,
 * and rsync is not asked. What it never measures: a secret, whose content no
 * command reads, and the Caddyfile, which `sitesolide upgrade` compares on its
 * own.
 */
async function compareWithServer(project: Project, config: Config, executor: Executor, doorConfirmed: boolean): Promise<void> {
  const { manifest } = project;
  const slug = manifest.slug;
  const paths = projectPaths(slug);
  step("compare with the server: read there, changed nowhere");
  const changes: string[] = [];
  const kept: string[] = [];

  const manifestPath = `${paths.root}/${MANIFEST_NAME}`;
  const deposited = await readRemoteFile(config, executor, manifestPath);
  if (deposited.kind === "unreadable") {
    die(`cannot tell whether ${manifestPath} is there`, ["the server answered neither an absence nor a manifest", "nothing was changed"]);
  }
  // A project the server does not carry yet has no tree to compare with:
  // everything would be sent, and rsync would only fail on the missing folders.
  if (deposited.kind === "absent") {
    changes.push(`${paths.root}: not on the server yet, everything would be sent`);
  } else {
    if (isApp(manifest)) {
      const count = await itemizedChanges(codeSync(project, config), paths.app);
      if (count > 0) changes.push(`${paths.app}: ${count} entr${count === 1 ? "y" : "ies"} to send or delete`);
    }
    const publicDir = publicFolder(project);
    if (publicDir !== null) {
      const count = await itemizedChanges(publicSync(publicDir, project, config), paths.publicDir);
      if (count > 0) changes.push(`${paths.publicDir}: ${count} entr${count === 1 ? "y" : "ies"} to send or delete`);
    }
    if (deposited.content !== project.raw) changes.push(manifestPath);
  }

  if (isApp(manifest)) {
    for (const { unit, text } of generateUnits(manifest)) {
      const path = unitPath(unit);
      const reading = await readRemoteFile(config, executor, path);
      if (reading.kind === "unreadable") {
        die(`cannot tell whether ${path} is there`, ["the server answered neither an absence nor a unit file", "nothing was changed"]);
      }
      const action = decideUnit({ installed: reading.kind === "present" ? reading.content : "", generated: text, replace: false });
      if (action === "install") changes.push(path);
      if (action === "diverged") kept.push(path);
    }
    const listing = readUnitsAnswer(await executor.read(config, listUnitsCommand(slug)), slug);
    if (listing.kind === "unreadable") {
      die(`cannot tell whether other units of ${slug} are there`, ["the server did not answer the listing", "nothing was changed"]);
    }
    for (const unit of staleUnits(manifest, listing.units)) changes.push(`${unitPath(unit)}, no longer declared`);

    const generated = generateFragment(manifest);
    if (generated !== null) {
      const path = blockPath(slug);
      const reading = await readRemoteFile(config, executor, path);
      if (reading.kind === "unreadable") {
        die(`cannot tell whether ${path} is there`, ["the server answered neither an absence nor a block", "nothing was changed"]);
      }
      const inService = reading.kind === "present" ? reading.content : null;
      if (decideBlock({ manifest, inService, replace: false, doorConfirmed }) === "diverged") refuseDivergence(path, inService ?? "", generated);
      if (inService !== generated) changes.push(path);
    }
  }

  note({ compared: true, changes, kept });
  for (const change of changes) say(`   differs    ${change}`);
  for (const path of kept) say(`   differs    ${path}, left as it is: deploy replaces it only with --force`);
  say(changes.length === 0 ? "-> nothing would change on the server" : `-> ${changes.length} difference(s) with the server, nothing was changed`);
}

/**
 * How many entries an rsync would send or delete: the command given, run in a
 * dry run that compares contents and lists what it would do. Read only on the
 * server. An entry whose time or mode alone differs is listed with a leading
 * dot, and does not count.
 */
async function itemizedChanges(command: string[], destination: string): Promise<number> {
  const [program, archive, ...rest] = command;
  const proc = Bun.spawn([program!, archive!, "--dry-run", "--itemize-changes", "--checksum", ...rest], {
    env: childEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) {
    die(`cannot compare ${destination} with the server: rsync failed (${code})`, [
      ...error.trim().split("\n").filter((line) => line.trim() !== "").slice(-3),
      "nothing was changed",
    ]);
  }
  return countItemized(output);
}

/**
 * The manifest the VM carries for this site, read for its door alone: missing,
 * present, or unreadable. Read only, therefore never short-circuited by the
 * dry-run mode. See bin/cli/portal-vm.ts.
 */
async function readDepositedDoor(
  slug: string,
  config: Config,
  executor: Executor,
): Promise<DepositedRead> {
  return readDepositedManifest(await executor.read(config, readManifestsCommand(slug)), slug);
}

/**
 * The door read again under the lock, just before the first deposit: it is what
 * decides. In a dry run, nothing is read again: no lock is taken.
 *
 * For an application project, every manifest is read, and its ports measured
 * once more against them, as the installer does. The check before the build
 * is minutes old by now: two deployments started side by side, from two
 * workstations, two agents or a workstation and a token, chose and checked
 * their ports on the same reading, and the first to get here has deposited
 * its own since. Without this, the second deposited the same port, and the
 * next reboot decided which project Caddy's visitors reached.
 */
async function rereadUnderLock(
  manifest: Manifest,
  config: Config,
  executor: Executor,
  isApplication: boolean,
): Promise<void> {
  if (executor.simulated) {
    say(`   [dry-run] read the portal${isApplication ? " and the ports" : ""} again under the lock, and decide on them`);
    return;
  }
  const slug = manifest.slug;
  const output = await executor.read(config, readManifestsCommand(isApplication ? "*" : slug));
  const door = isApplication ? readManifestAmongAll(output, slug) : readDepositedManifest(output, slug);
  const agreement = confirmDoorUnderLock(slug, { portal: isProtected(manifest), lock: manifest.lock === true }, door);
  if (agreement.kind === "rejects") die(agreement.message, agreement.details);
  if (!isApplication) return;
  const reading = readDepositedManifests(output);
  if (reading.kind === "unreadable") {
    die("cannot read the manifests on the server to check the ports again under the lock", [
      reading.reason,
      "neither the manifest nor the Caddy block was deposited",
    ]);
  }
  const conflicts = portConflicts(manifest, reading.manifests);
  if (conflicts.length > 0) {
    die("port already taken on the server, by a deployment that ran meanwhile", [
      ...conflicts,
      "neither the manifest nor the Caddy block was deposited: delete `port` from sitesolide.json, or pick another free one, then deploy again",
    ]);
  }
}

/**
 * The guard of the gestures that deposit the local manifest as it is, without
 * taking over the VM's door as `deploy` does: they would erase a portal set
 * from the dashboard. Called before any write, the local one included.
 */
async function requireAgreedDoor(
  project: Project,
  config: Config,
  executor: Executor,
  action: ManifestAction,
): Promise<void> {
  const { manifest } = project;
  const agreement = guardDepositedManifest(
    manifest.slug,
    { portal: isProtected(manifest), lock: manifest.lock === true },
    await readDepositedDoor(manifest.slug, config, executor),
    action,
  );
  if (agreement.kind === "rejects") die(agreement.message, agreement.details);
}

/**
 * The door this deployment applies: the one the VM carries for a site already
 * deployed, the repository's one for a first run.
 *
 * The dashboard's gatekeeper sets and removes the portal on the machine without
 * touching the repository. Taking the local manifest's value here would
 * silently reopen a site the dashboard has just closed, or close the one it has
 * reopened. The deposited manifest is therefore read first, and if it says
 * something else, it is the one that wins: the local sitesolide.json is
 * rewritten by setPortal, which touches only that field, and the output asks
 * for it to be committed.
 *
 * The read is never short-circuited by the dry-run mode: it changes nothing,
 * and a dry run that ignored the door in service would show a block that is not
 * the one the deployment would set. Only the local write is skipped. An
 * unreadable read stops everything, dry run included: nothing then says which
 * door the machine holds.
 *
 * The decision is taken in bin/cli/portal-vm.ts, on the raw answer.
 *
 * Also returns `switched`, true when the local manifest has just been rewritten,
 * and `doorConfirmed`, true as soon as the VM carries a manifest for this
 * site: the door applied is then the machine's one, and the repository's block
 * may follow it.
 */
async function reconcilePortal(
  project: Project,
  config: Config,
  executor: Executor,
): Promise<{ project: Project; switched: boolean; doorConfirmed: boolean }> {
  const { manifest } = project;
  const reading = await readDepositedDoor(manifest.slug, config, executor);
  const decision = decidePortal(manifest.slug, { portal: isProtected(manifest), lock: manifest.lock === true }, reading);
  if (decision.kind === "rejects") die(decision.message, decision.details);
  const doorConfirmed = reading.kind === "present";
  if (decision.kind === "repository") return { project, switched: false, doorConfirmed };

  const announcement = switchAnnouncement(decision, executor.simulated);
  step(announcement.title);
  for (const line of announcement.details) say(`   ${line}`);

  // Both fields at once: the manifest refuses them together, and a switch
  // between Restricted and the code changed both on the machine.
  const raw = setLock(setPortal(project.raw, decision.portal), decision.lock);
  const { manifest: followed, errors } = readManifest(raw);
  if (followed === undefined || errors.length > 0) {
    die(`${MANIFEST_NAME} rejected once the general access set from the dashboard is applied`, errors);
  }

  const path = join(project.folder, MANIFEST_NAME);
  if (executor.simulated) {
    say(`   [dry-run] write ${path}`);
  } else {
    writeFileSync(path, raw);
  }
  return { project: { ...project, manifest: followed, raw }, switched: true, doorConfirmed };
}

/**
 * Generates the project's Caddy block and deposits it, after the service has
 * started and before the verification.
 *
 * The order is not negotiable: a block set before the code exists makes the
 * project's address answer 404, the verification of bin/deploy-caddy.sh fails,
 * and its restore cancels the deposit. Measured on the first real deployment,
 * on 19 August 2026.
 *
 * The block is generated every time rather than kept anywhere: it thereby
 * follows the manifest, whose port or routes may have changed. It leaves alone,
 * validated on the machine with the blocks already in service, and the deposit
 * is idempotent, bin/deploy-caddy.sh touching nothing when the fingerprints are
 * identical. The file handed to the script lives the time of the call.
 */
async function installFragment(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const fragment = generateFragment(manifest);
  if (fragment === null) return;
  const name = `${manifest.slug}.caddy`;
  if (executor.simulated) {
    say(`   [dry-run] bin/deploy-caddy.sh ${name}, validated with the blocks in service`);
    return;
  }

  step("Caddy fragment, through the validated path");
  const folder = mkdtempSync(join(tmpdir(), "sitesolide-block-"));
  try {
    const path = join(folder, name);
    await Bun.write(path, fragment);
    // Under the lock this deployment holds: the script checks it and does not
    // take it again.
    await executor.run([script("deploy-caddy.sh"), path], {
      env: envUnderLock(config),
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Is the file on the VM? Presence alone is asked for: the VM is the source of
 * truth, and neither the contents nor their fingerprint have anything to
 * decide.
 *
 * The markers are printed by the shell sudo launches, never by the one of the
 * connection: a refused sudo can therefore write nothing at all, and an empty
 * output reads as the failure it is. Placed in front of the `test` alone, sudo
 * would make that refusal fall into the branch of absence. See
 * readPresenceAnswer, which refuses to conclude on what it does not recognise.
 */
async function remotePresence(
  config: Config,
  executor: Executor,
  destination: string,
): Promise<PresenceRead> {
  const output = await executor.read(
    config,
    `sudo sh -c "if test -f ${destination}; then echo ${MARKER_PRESENT}; else echo ${MARKER_ABSENT}; fi"`,
  );
  return readPresenceAnswer(output);
}

/**
 * Checks that every declared secret is on the VM, and stops on the first that
 * is not, saying where to create it.
 *
 * THE VM IS THE SOURCE OF TRUTH. /etc/sitesolide is managed from the Secrets
 * section of the dashboard, which reads, sets and removes the variables there
 * then restarts the service. Nothing is pushed from the workstation: see
 * bin/cli/secrets.ts for why.
 *
 * Every presence is read before anything is decided, so that the message names
 * all the missing files at once rather than one per run. No content is read.
 */
async function ensureSecrets(
  manifest: Manifest,
  config: Config,
  executor: Executor,
): Promise<void> {
  const secrets = manifest.secrets ?? [];
  if (secrets.length === 0) return;
  step("declared secrets");

  // In a dry run, nothing is asked of the VM: an end-to-end test must be able
  // to run without it, and without a forgotten path talking to production.
  if (executor.simulated) {
    for (const name of secrets) say(`   [dry-run] check that ${secretPath(name)} is on the server`);
    return;
  }

  const dashboard = dashboardAddress(config.zone);
  const actions: { name: string; action: SecretAction }[] = [];
  for (const name of secrets) {
    const presence = await remotePresence(config, executor, secretPath(name));
    if (presence.kind === "unreadable") {
      die(`cannot tell whether ${secretPath(name)} is there`, [
        "the server answered neither an absence nor a presence",
      ]);
    }
    actions.push({ name, action: decideSecret({ name, onServer: presence.kind === "present" }, dashboard) });
  }

  const [first, ...others] = actions.filter(({ action }) => action.kind === "rejects");
  if (first !== undefined && first.action.kind === "rejects") {
    die(first.action.message, [
      ...others.map(({ name }) => `also missing: ${secretPath(name)}`),
      ...first.action.details,
    ]);
  }
  for (const { name } of actions) say(`   present  ${secretPath(name)}`);
}

/**
 * The manifest's `install`, run on the machine as the project's own account,
 * in a transient unit with its service's walls, as the installer runs it for
 * a token: see sandboxedInstallCommand in bin/cli/unit.ts, which says why it
 * no longer runs as the deployment account. The command leaves on standard
 * input, never in the arguments.
 */
async function installAsProject(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const install = manifest.install!;
  const account = systemUser(manifest.slug);
  if (executor.simulated) {
    say(`   [dry-run] run ${install} in ${projectPaths(manifest.slug).app} as ${account}, in a transient unit with the service's walls`);
    return;
  }
  const proc = Bun.spawn(["ssh", config.server, sandboxedInstallCommand(manifest.slug, deploymentAccount(config.server))], {
    env: childEnvironment(),
    stdin: new TextEncoder().encode(`${install}\n`),
    stdout: childOutput(),
    stderr: childOutput(),
  });
  running++;
  let code: number;
  try {
    await Promise.all([relayOutput(proc.stdout, "stdout"), relayOutput(proc.stderr, "stderr")]);
    code = await proc.exited;
  } finally {
    running--;
  }
  stopIfInterrupted();
  if (code !== 0) {
    die(`install failed (${code}): ${install}`, [
      `it ran as ${account}, with the network but not the loopback, a throwaway HOME and only app/ writable`,
      "a step that writes outside app/ or needs root fails there: move it into build, which runs on this workstation",
      "the code is in place, the service was not restarted",
    ]);
  }
}

/** The file leaves through standard input: nothing is written in /tmp on the way. */
async function depositText(
  executor: Executor,
  config: Config,
  content: string,
  destination: string,
  owner: string,
  mode: string,
): Promise<void> {
  if (executor.simulated) {
    say(`   [dry-run] write ${destination} (${owner}, ${mode})`);
    return;
  }
  const command = `sudo install -m ${mode} -o ${owner.split(":")[0]} -g ${owner.split(":")[1]} /dev/stdin ${destination}`;
  const proc = Bun.spawn(["ssh", config.server, command], {
    env: childEnvironment(),
    stdin: new TextEncoder().encode(content),
    stdout: childOutput(),
    stderr: childOutput(),
  });
  running++;
  let code: number;
  try {
    await Promise.all([relayOutput(proc.stdout, "stdout"), relayOutput(proc.stderr, "stderr")]);
    code = await proc.exited;
  } finally {
    running--;
  }
  stopIfInterrupted();
  if (code !== 0) die(`write refused: ${destination}`);
}

/**
 * 200 and 401 only: the 401 is the intended behaviour of a locked preview, and
 * taking it for an error would make a perfectly healthy deployment fail.
 *
 * A 404 at the root stays a failure, on purpose: most often nothing is served
 * at all, a service answering elsewhere or a publicDir without its
 * index.html. It is the one failure an app that works can still hit, one that
 * answers only its routes, so it says so plainly, with what to do, as
 * docs/manifest.md does under `start`.
 */
async function verify(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const address = `https://${manifest.slug}.${config.zone}/`;
  note({ url: address, status: null });
  if (executor.simulated) {
    say(`   [dry-run] verify ${address}`);
    return;
  }
  step("verify");
  let code = 0;
  let door: string | null = null;
  try {
    const response = await fetch(address, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    code = response.status;
    door = response.headers.get("x-portal");
  } catch (err) {
    die(`${address} unreachable: ${(err as Error).message}`);
  }
  say(`   ${address} ${code}`);
  note({ status: code });

  // A protected site that answers 200 to a stranger is not a success: it is the
  // worst possible state, a site its owner believes closed. Only the portal's
  // 401, recognisable by its header, says that the door is in place.
  if (isProtected(manifest)) {
    if (code === 401 && door === "connexion") {
      say("   Restricted: visitors are asked to sign in.");
      return;
    }
    die(`${address} should answer the portal's 401, got ${code}`, [
      "sitesolide.json says Restricted, and the site answers anyone",
    ]);
  }

  if (code === 401) {
    say(`   it opens with a code, see sitesolide lock --status`);
    return;
  }
  if (code === 404) {
    die(`${address} answered 404: nothing is served at the site's root`, [
      "deploy counts a 404 at / as a failure: most often it means nothing is served at all",
      "make / answer 200, from the app, which receives / unless the manifest has routes, or from an index.html in publicDir",
      "docs/manifest.md says why, under start",
    ]);
  }
  if (code !== 200) die(`unexpected response: ${code}`);
}

/**
 * Does the portal answer, with a fingerprint in place? Otherwise nothing leaves.
 *
 * Protecting a site behind a stopped portal would close it with a 502; behind
 * a portal without a fingerprint, it would close it to its owner himself,
 * nobody being able to get in any more. Both are seen here, before the first
 * byte is sent, rather than on the first visit.
 */
async function requirePortal(config: Config, executor: Executor): Promise<void> {
  const address = `https://${PORTAL_SLUG}.${config.zone}/sante`;
  if (executor.simulated) {
    say(`   [dry-run] check ${address}`);
    return;
  }
  step("portal");
  let state: { configure?: unknown } = {};
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(15000) });
    if (response.ok) state = (await response.json()) as { configure?: unknown };
  } catch {
    // Treated as an absence, below.
  }
  if (state.configure !== true) {
    die(`the portal is not ready at ${address}`, [
      "a site behind it would be closed to its owner too",
      "deploy portal/ first, with its secret: cd portal && sitesolide deploy",
    ]);
  }
  say(`   ${address} ready`);
}

// --- preparing the service ---------------------------------------------------

/**
 * Puts in place what is missing for a service to be able to start: the system
 * user, the directory tree, the unit. Called by `deploy` as soon as a project
 * is an application one, so that a first run holds in a single command.
 *
 * IT NEVER REPLACES A UNIT IN SERVICE. A hand-written unit carries decisions
 * the manifest cannot express, such as a PrivateDevices deliberately left out
 * for a service that needs a device: replacing it because a deployment happened
 * to pass by would cut that device off without anyone having asked for it. A
 * unit that differs from the generated one is reported and left in place;
 * --force is the deliberate gesture of switching over, and the only one.
 *
 * IT IS IDEMPOTENT, which is the condition for `deploy` to be able to call it
 * every time: the user is created only if missing, mkdir and chown are redone
 * with no consequence, and an identical unit is neither deposited again nor
 * reloaded. The second run changes nothing on the machine.
 *
 * THE CADDY FRAGMENT IS NOT SET HERE. Set before the code exists, it would be
 * picked up by the first bin/deploy-caddy.sh to come along, including that of
 * another project, and would deposit a block proxying to a port where nothing
 * listens: 502 on that address, and the verification of the next deployment
 * fails. Measured on 19 August 2026. It is deploy that writes it, once the
 * service is active.
 */
async function prepareService(
  project: Project,
  config: Config,
  executor: Executor,
  replace: boolean,
): Promise<void> {
  const { manifest } = project;
  const slug = manifest.slug;
  const account = systemUser(slug);
  const units = generateUnits(manifest);

  step("system user and directories");
  await executor.ssh(
    config,
    [
      `id -u ${account} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${account}`,
      ...directoryCommands(slug, true, deploymentAccount(config.server)),
    ].join(" && "),
  );

  step(units.length > 1 ? "systemd units" : "systemd unit");
  if (executor.simulated) {
    for (const { unit } of units) say(`   [dry-run] read ${unitPath(unit)}, install it if missing`);
    say(`   [dry-run] remove the generated units of ${slug} the manifest no longer declares`);
    return;
  }

  // Every unit is read and decided before any is laid: a refusal must not fall
  // half way through. Each is decided on its own, one edited by hand on the
  // machine stays as it is, and the others of the project still get theirs.
  const decisions = [];
  for (const { unit, text } of units) {
    const path = unitPath(unit);
    const reading = await readRemoteFile(config, executor, path);
    if (reading.kind === "unreadable") {
      die(`cannot tell whether ${path} is there`, [
        "the server answered neither an absence nor a unit file",
        "nothing was installed: a unit is never replaced on a reading that failed",
      ]);
    }
    const installed = reading.kind === "present" ? reading.content : "";
    decisions.push({ unit, text, path, installed, action: decideUnit({ installed, generated: text, replace }) });
  }

  // The main unit is what starts the others, at boot as after a deployment. A
  // main unit left as it is would not want them, and they would be missing
  // from the next reboot on, with nothing to say so.
  const [main] = decisions;
  if (main !== undefined && main.action === "diverged" && units.length > 1) {
    say(`   ${main.path} must want the project's other services, or they do not start at boot`);
    refuseDivergence(main.path, main.installed, main.text);
  }

  let installed = false;
  for (const { unit, text, path, action } of decisions) {
    switch (action) {
      case "present":
        say(`   unchanged  ${path}`);
        continue;
      case "diverged":
        say(`   differs    ${path}, left as it is`);
        say("   it may carry a directive the manifest cannot express, such as one");
        say("   deliberately left out. Read it, then re-run with --force to switch");
        say("   to the generated one. Until then the service keeps this unit, so a");
        say("   changed port, memory or env in the manifest has no effect yet.");
        continue;
    }

    showFile(`${unit}.service`, text);

    step(units.length > 1 ? `install ${unit}.service` : "install the unit");
    await depositText(executor, config, text, path, "root:root", "644");
    installed = true;
  }

  await removeStaleUnits(manifest, config, executor);
  // The main unit alone is enabled: it wants the others, at boot as here.
  if (installed) await executor.ssh(config, `sudo systemctl daemon-reload && sudo systemctl enable ${slug}`);
}

/**
 * The secondary units still on the machine that the manifest no longer
 * declares: a service renamed or dropped from `services`. Left there, it would
 * keep running the previous code, reachable on its port, with nothing in the
 * repository saying it exists.
 *
 * A listing that fails removes nothing: better a unit left behind, and said
 * so, than one removed on the strength of an empty answer.
 */
async function removeStaleUnits(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const reading = readUnitsAnswer(await executor.read(config, listUnitsCommand(manifest.slug)), manifest.slug);
  if (reading.kind === "unreadable") {
    say(`   could not list the other units of ${manifest.slug}: none removed`);
    return;
  }
  const stale = staleUnits(manifest, reading.units);
  if (stale.length === 0) return;
  step("units the manifest no longer declares");
  for (const unit of stale) say(`   remove ${unitPath(unit)}`);
  await executor.ssh(config, removeUnitsCommand(stale));
}

/**
 * Refuses, before anything is written, a unit name systemd already gives to
 * a service of the machine: a package's unit in /lib/systemd/system, which
 * deploy would otherwise shadow with its own in /etc, or a unit in /etc that
 * is not this project's. See unitOriginsCommand in bin/cli/services.ts.
 *
 * A read, hence done in a dry run too. `--force` does not lift it: it replaces
 * a project's unit edited by hand, never a system service.
 */
async function checkUnitNames(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const units = servicesOf(manifest).map((service) => service.unit);
  const reading = readUnitOrigins(await executor.read(config, unitOriginsCommand(manifest.slug, units)), units);
  if (reading.kind === "unreadable") {
    die(`cannot tell whether systemd already runs a service named ${manifest.slug}`, [
      "the server answered nothing readable",
      "nothing was written: a unit is never laid over a service the reading could not see",
    ]);
  }
  const foreign = units.flatMap((unit) => foreignUnit(unit, manifest.slug, reading.facts.get(unit)!) ?? []);
  if (foreign.length > 0) {
    die(`${manifest.slug} is already the name of a service of the server, which deploy never replaces`, [
      ...foreign,
      "nothing was written: pick another slug in sitesolide.json",
    ]);
  }
}

/**
 * Refuses a port another project already declares on the machine, before
 * anything is pushed. See portConflicts in bin/cli/services.ts.
 *
 * A read, hence done in a dry run too: it is exactly what a dry run is for.
 */
async function checkPorts(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const reading = readDepositedManifests(await executor.read(config, readManifestsCommand("*")));
  if (reading.kind === "unreadable") {
    die("cannot read the manifests on the server to check the ports", [
      reading.reason,
      "nothing was pushed: a port another project declares would take its visitors",
    ]);
  }
  const conflicts = portConflicts(manifest, reading.manifests);
  if (conflicts.length > 0) {
    die("port already taken on the server", [...conflicts, "pick a free port between 3000 and 3099 in sitesolide.json"]);
  }
}

/**
 * Refuses, before anything is pushed, a machine whose loopback rule would cut
 * this project's services off from each other: one laid before the project set
 * existed. A read, hence done in a dry run too; the dry run is where this is
 * worth learning. A machine with no rule at all passes: nothing stands between
 * the services there.
 */
async function requireProjectSet(config: Config, executor: Executor): Promise<void> {
  switch (readLoopbackState(await executor.read(config, loopbackStateCommand()))) {
    case "unreadable":
      die("cannot tell whether the loopback rule is in place", [
        "nothing was pushed: this project could fail to reach its own ports",
      ]);
    case "table":
      die("the loopback rule in service predates the project set", [
        "this project could not reach its own ports, its services each other or its backup command its service; lay the current rule first:",
        `  ${script("deploy-loopback.sh")} close`,
        "then run sitesolide deploy again. Nothing was pushed.",
      ]);
  }
}

/**
 * Says, before anything is pushed, when the server's backup component
 * predates the services' backup commands: it would read this project's
 * without a word, and go on copying the live folder as files, the very
 * snapshot the command exists to replace. A warning and not a refusal:
 * deploying changes nothing of what the backups do, and upgrading the
 * component is the owner's `sitesolide upgrade`. A read, hence done in a dry
 * run too.
 */
async function checkBackupComponent(config: Config, executor: Executor): Promise<void> {
  switch (readBackupComponent(await executor.read(config, backupComponentCommand()))) {
    case "current":
      return;
    case "outdated":
      warn("the backup component on the server predates backup commands: until it is upgraded, it copies this project's live folder as files", [
        "sitesolide upgrade brings it up to date (bin/deploy-backup.sh install from a checkout), see dashboard/src/backup/README.md",
      ]);
      return;
    case "absent":
      warn("the backup component is not installed on the server: nothing saves this project's data, its backup command included", [
        "sitesolide setup installs it on the server",
      ]);
      return;
    case "unreadable":
      warn("cannot tell whether the server's backup component runs backup commands");
  }
}

/**
 * Refuses, before anything is pushed, a project that declares `egress` or
 * `connectors` on a machine where the egress proxy does not run. Deployed
 * there, its service would start with its proxy variables pointing at nothing,
 * every outbound call would fail, and nothing would say why. A read, hence
 * done in a dry run too.
 */
async function requireEgress(config: Config, executor: Executor): Promise<void> {
  const state = readEgressState(await executor.read(config, egressStateCommand()));
  // Named in the refusals only: unpacking a kit to print a path nobody reads
  // would be a write for nothing.
  const install = (): string => script("deploy-egress.sh");
  switch (state) {
    case "active":
      return;
    case "unreadable":
      die("cannot tell whether the egress proxy runs on the server", [
        "nothing was pushed: this project's outbound calls and connectors go through it",
      ]);
    case "inactive":
      die("the egress proxy is installed on the server but not running", [
        "this project's outbound calls and connectors go through it; read its journal, then lay it again:",
        `  sudo journalctl -u sitesolide-egress -n 50   (on the server)`,
        `  ${install()}`,
        "then run sitesolide deploy again. Nothing was pushed.",
      ]);
    case "absent":
      die("this project declares egress or connectors, and the egress proxy is not installed on the server", [
        "install it first, see egress/README.md:",
        `  ${install()}`,
        "then run sitesolide deploy again. Nothing was pushed.",
      ]);
  }
}

/**
 * Rebuilds the loopback's project set from the manifests on the machine, so
 * that each project with several services, or with a backup command,
 * reaches its own ports, and only those. See PROJECT_PORTS_SET and
 * reachesOwnPorts in bin/cli/loopback.ts.
 *
 * `services` is the deployment of a project that reaches its own ports: a
 * failure stops it, its services, or its backup command, depending on the
 * set. `follow` is every other deployment and every removal: the set is
 * rewritten only when it differs from what the manifests say, so that a
 * project that dropped its services or left the machine drops out of it, and
 * a failure is reported without stopping anything.
 *
 * The file is checked by `nft -c`, applied, and only then replaces the one in
 * service: a refused file leaves both the set and the file as they were. On a
 * machine without the set, it is written without being applied, for the next
 * bin/deploy-loopback.sh to replay.
 */
async function rebuildProjectPorts(config: Config, executor: Executor, mode: "services" | "follow"): Promise<void> {
  const strict = mode === "services";
  if (executor.simulated) {
    if (strict) {
      step("loopback: each project's own ports");
      say(`   [dry-run] rebuild ${PROJECT_PORTS_FILE} from the manifests on the server`);
    }
    return;
  }
  const fail = (message: string, details: string[] = []): void => {
    if (strict) die(message, details);
    say(`   !! ${message}: the loopback's project set was left as it is`);
  };

  const state = readLoopbackState(await executor.read(config, loopbackStateCommand()));
  if (state === "unreadable") return fail("cannot tell whether the loopback rule is in place");
  if (state === "table" && strict) {
    return fail("the loopback rule in service predates the project set", [
      `lay the current rule first: ${script("deploy-loopback.sh")} close`,
    ]);
  }

  const reading = readDepositedManifests(await executor.read(config, readManifestsCommand("*")));
  if (reading.kind === "unreadable") return fail("cannot read the manifests on the server", [reading.reason]);
  const projects: Manifest[] = [];
  for (const [folder, raw] of reading.manifests) {
    const { manifest } = readManifest(raw);
    if (manifest === undefined || !reachesOwnPorts(manifest)) continue;
    // The shape the set needs, and nothing more: a manifest deposited by an
    // older or newer checkout may fail today's validation on a key that has
    // nothing to do with its ports, and dropping it would cut its services
    // off from each other.
    const ports = servicesOf(manifest).map((service) => service.port);
    if (manifest.slug !== folder || !ports.every((port) => Number.isInteger(port) && port >= 3000 && port <= 3099)) {
      say(`   skipped ${folder}: its services on the server do not read, they lose their access`);
      continue;
    }
    projects.push(manifest);
  }

  const slugs = projects.map((manifest) => manifest.slug);
  let uids = new Map<string, number>();
  if (slugs.length > 0) {
    const read = readUidsAnswer(await executor.read(config, uidsCommand(slugs)), slugs);
    if (read.kind === "unreadable") return fail("cannot read the system users of the projects that reach their own ports");
    uids = read.uids;
  }
  const accounts: ProjectAccount[] = projects.map((manifest) => ({ manifest, uid: uids.get(manifest.slug)! }));

  if (state === "set" && !strict) {
    // Nothing to write while the kernel already carries what the manifests say.
    const current = readCurrentPairs(await executor.read(config, currentPairsCommand()));
    if (current === null) return fail("cannot read the loopback's project set");
    const wanted = projectPortPairs(accounts);
    if (current.length === wanted.length && current.every((pair) => wanted.includes(pair))) return;
  }
  if (state !== "set" && !strict) {
    // Without the set, only a file already there is kept in step: a machine
    // that never had a project reaching its own ports gets nothing written.
    const presence = await remotePresence(config, executor, PROJECT_PORTS_FILE);
    if (presence.kind !== "present") return;
  }

  step("loopback: each project's own ports");
  const result = await executor.execute(config, projectPortsCommand(projectPortsFile(accounts), state === "set"));
  if (result.code !== 0) {
    return fail(`${PROJECT_PORTS_FILE} refused`, [result.error.trim() || "no message"]);
  }
  say(`   ${slugs.length === 0 ? "no project" : slugs.join(", ")} reaching ${slugs.length === 1 ? "its" : "their"} own ports`);
  if (state !== "set") say("   written, to be applied by the next bin/deploy-loopback.sh");
}

/**
 * The systemd unit and the Caddy fragment as the CLI generates them, shown in a
 * dry run before anything leaves.
 *
 * That was the reason for `sitesolide init` to exist, the only thing the
 * command did that `deploy` did not: setting them, it does on its own since an
 * application project deploys in a single go. Two verbs for one gesture made
 * people believe in a prerequisite that no longer existed, so the reading
 * joined the gesture.
 *
 * It is worth keeping: these two files enter a configuration shared by every
 * site, and the fragment goes through bin/deploy-caddy.sh, which validates them
 * together. Reading them beforehand costs one command, reading them afterwards
 * costs an outage.
 */
function showGeneratedFiles(manifest: Manifest): void {
  const slug = manifest.slug;
  const fragment = generateFragment(manifest);
  for (const { unit, text } of generateUnits(manifest)) showFile(`${unit}.service`, text);
  if (fragment !== null) {
    showFile(`${slug}.caddy`, fragment, false);
    say("   installed by deploy, once the service is up");
  }
}

// --- status, logs, secrets, run ----------------------------------------------

async function showStatus(config: Config, executor: Executor): Promise<void> {
  // Everything is a read: the machine's state is read on the machine, never in
  // a file of the repository, which would lie from the first deployment made
  // from somewhere else. The script leaves as a single string, with real line
  // breaks: the pieces joined by "; " produced ";;" that the remote shell
  // refused, and the empty output passed for silence.
  const script = `
echo "=== projects served ==="
printf "%-22s %-8s %-10s %-8s %-8s %s\n" PROJECT SIZE SERVICE MEMORY PEAK LIMIT
megabytes() {
  case "$1" in
    ""|"[not set]"|infinity) echo "-" ;;
    *) echo "$(($1 / 1048576))MB" ;;
  esac
}
# One line per unit: the project's main one, named after its folder, then the
# others of a project with several services, <slug>.<name>, indented under it.
row() {
  name=$1 size=$2 unit=$3
  # A static site has no unit, and the landing's one does not carry the name of
  # its folder: showing "inactive" in those two cases would suggest a service
  # that is down. LoadState tells a missing unit from a stopped one.
  if [ "$(systemctl show "$unit" -p LoadState --value 2>/dev/null)" = loaded ]; then
    service=$(systemctl is-active "$unit" 2>/dev/null || true)
  else
    service="-"
  fi
  memory=$(megabytes "$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null)")
  # The peak since the last start, which systemd keeps itself. It is the only way
  # to read a MemoryMax decision back: the current value says nothing of the
  # moment when the service consumed the most, and sampling from the outside
  # misses the short spikes. It resets to zero on every restart, so a figure
  # taken just after a deployment measures nothing.
  peak=$(megabytes "$(systemctl show "$unit" -p MemoryPeak --value 2>/dev/null)")
  # The ceiling in service, and not the manifest's one: it is the unit set on the
  # machine that decides, and a manifest changed without deploy --force does not change it.
  # The three columns together are what makes the decision readable again.
  cap=$(megabytes "$(systemctl show "$unit" -p MemoryMax --value 2>/dev/null)")
  printf "%-22s %-8s %-10s %-8s %-8s %s\n" "$name" "$size" "$service" "$memory" "$peak" "$cap"
}
for folder in /srv/sites/*/; do
  slug=$(basename "$folder")
  row "$slug" "$(du -sh "$folder" 2>/dev/null | cut -f1)" "$slug"
  for file in /etc/systemd/system/"$slug".*.service; do
    [ -e "$file" ] || continue
    unit=$(basename "$file" .service)
    row "  .\${unit#"$slug".}" "" "$unit"
  done
done

echo
echo "=== ports listening on loopback ==="
ss -ltn 2>/dev/null | grep 127.0.0.1 | awk '{print $4}' | sort -u

echo
echo "=== memory ==="
free -m | head -2
`;
  const output = await executor.read(config, script);
  if (!jsonOutput) return say(output.trimEnd());
  // An empty answer is a read that failed, already warned about: data that
  // said "no project" would be a lie.
  if (!output.includes("=== projects served ===")) die("cannot read the status of the server", ["the server answered nothing readable"]);
  note(readStatus(output));
}

async function logs(
  project: Project,
  config: Config,
  follow: boolean,
  executor: Executor,
  lines = 50,
): Promise<void> {
  // Every unit of the project, interleaved by time: a request that fails in
  // the front often says why only in the log of the service it called.
  const units = servicesOf(project.manifest).map((service) => `-u ${unitArgument(service.unit)}`);
  const selection = units.length > 0 ? units.join(" ") : `-u ${project.manifest.slug}`;
  if (jsonOutput) return journalEvents(project.manifest.slug, selection, config, follow, lines, executor);
  await executor.run([
    "ssh",
    ...(follow ? ["-t"] : []),
    config.server,
    `journalctl ${selection} -n ${lines} --no-pager${follow ? " -f" : ""}`,
  ]);
}

/**
 * `logs --json`: the journal as entries, from journalctl's own JSON rather
 * than its lines, each one a `log` event with its time, unit and priority.
 * `--follow` keeps the stream open, one event per entry, for as long as the
 * connection lasts; without it, the run ends with a `result`. No `-t`: there
 * is no terminal at the other end of a pipe.
 */
async function journalEvents(
  slug: string,
  selection: string,
  config: Config,
  follow: boolean,
  lines: number,
  executor: Executor,
): Promise<void> {
  const command = `journalctl ${selection} -n ${lines} --no-pager -o json --output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT${follow ? " -f" : ""}`;
  note({ slug, units: selection.split(" ").filter((word) => word !== "-u") });
  if (executor.simulated) {
    say(`   [dry-run] ssh ${config.server} ${command}`);
    return;
  }
  const proc = Bun.spawn(["ssh", config.server, command], { env: childEnvironment(), stdout: "pipe", stderr: "pipe" });
  let entries = 0;
  await Promise.all([
    forEachLine(proc.stdout, (line) => {
      if (line.trim() === "") return;
      entries++;
      emit(readJournalEntry(line));
    }),
    relayOutput(proc.stderr, "stderr"),
  ]);
  const code = await proc.exited;
  if (code !== 0) die(`failed (${code}): ssh ${config.server} ${command}`);
  note({ entries });
}

/**
 * `sitesolide secrets` pushes nothing: the secrets are managed on the machine,
 * from the Secrets section of the dashboard, because the VM is the source of
 * truth. A verb of the workstation that wrote into /etc/sitesolide would put a
 * development copy back over the value in service, without anything reporting
 * it.
 *
 * The verb stays recognised so that the hand typing it learns where to go,
 * rather than landing on the general usage. It exits in error: nothing was
 * done, and a script chaining it must not believe otherwise.
 *
 * Every site's file is managed over there, including those that were kept out
 * of it: the dashboard's own, the portal's and the landing's. The vault keeps
 * only what belongs to no site, cloudflare.env, the token Caddy reads for its
 * certificates.
 *
 * The dashboard's own password is the one exception, since it is what opens the
 * dashboard: bin/dashboard-password.sh puts it on a machine that has none.
 */
function pointToDashboard(config: Config): never {
  die(`secrets are managed in the Secrets section of ${dashboardAddress(config.zone)}`, [
    "the server is the source of truth: read, set or remove a variable there,",
    "create a declared file that is missing, then restart the service",
    "every site's file is managed there, the dashboard, the portal and the landing included",
    "",
    "the dashboard's own password, on a machine that has none yet:",
    `  ${script("dashboard-password.sh")}`,
  ]);
}

/**
 * Loads a secret from the workstation's vault and runs the command. The file is
 * sourced by bash, never read by this process: nothing of its contents goes
 * through the CLI, is shown or is logged.
 *
 * The vault is not a copy of production. It holds what the workstation itself
 * needs to reach production, the API token a command-line tool presents for
 * instance, and nothing that only the machine uses: those live in
 * /etc/sitesolide alone, managed from the dashboard.
 */
async function runWithSecret(
  project: Project,
  config: Config,
  command: string[],
): Promise<void> {
  const secrets = project.manifest.secrets ?? [];
  if (secrets.length === 0) die("no secret declared in the manifest");
  if (command.length === 0) die("usage: sitesolide run -- <command>");

  const files = secrets.map((name) => join(config.vault, name));
  for (const file of files) {
    if (!existsSync(file)) {
      die(`missing from the vault: ${file}`, [
        "the vault holds what this workstation needs to reach production, and only that",
        `put the file there yourself; its values are the ones in the Secrets section of ${dashboardAddress(config.zone)}`,
      ]);
    }
  }

  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `set -a; ${files.map((f) => `. "${f}"`).join("; ")}; set +a; exec "$@"`,
      "bash",
      ...command,
    ],
    { cwd: project.code, env: projectEnvironment(), stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  process.exit(await proc.exited);
}

/**
 * The manifest as it is, at the project's root on the VM. It is what the
 * domains table and the lock generator read, and a static project otherwise
 * only sends up its public/: without this deposit, its domains would drop out
 * of the table.
 *
 * The text deposited is `project.raw`, and not the file read back from disk:
 * for `deploy`, it already carries the door the VM makes authoritative, in a
 * dry run as for real.
 */
async function depositManifest(
  project: Project,
  config: Config,
  executor: Executor,
): Promise<void> {
  const paths = projectPaths(project.manifest.slug);
  step("manifest");
  await depositText(
    executor,
    config,
    project.raw,
    `${paths.root}/${MANIFEST_NAME}`,
    `${deploymentAccount(config.server)}:${deploymentAccount(config.server)}`,
    "644",
  );

  // Two leftovers from before the switch, removed here because nothing else
  // will remove them. The descriptor drifts first: nobody reads it any more,
  // and as long as it lies around the table refuses to regenerate itself. The
  // copy of the manifest in app/ next, deposited by the rsync of the code
  // before it excludes it: an --exclude protects the file at the destination
  // instead of erasing it, so the exclusion alone would freeze it there for
  // ever, drifting from the one the machine really reads.
  await executor.ssh(
    config,
    `sudo rm -f ${paths.root}/site.json ${paths.app}/${MANIFEST_NAME}`,
  );
}

// --- lock --------------------------------------------------------------------

/**
 * The preview code, from the project's folder: general access set to Anyone
 * with the code, a new code, or back to Public.
 *
 * One path changes a site's general access on the machine, and this is not a
 * second one: root asks the steward on its owner socket (bin/cli/access.ts,
 * `sshGeneral`), which launches the gatekeeper, exactly as the dashboard's
 * Access section does. The gatekeeper draws the code on the machine, writes
 * the manifest, the codes file and the locks' fragment in one transaction,
 * validates, reloads Caddy with systemctl, checks over HTTPS that the door
 * page answers without the code and the site with it, and restores at the
 * slightest failure, under the Caddy lock the deploy scripts share. A
 * restricted site switches to the code in the same transaction.
 *
 * The code comes back in the steward's answer and is said here, once: it is
 * written into no file of the workstation. The repository follows the
 * machine: the local sitesolide.json gets the general access the machine now
 * carries, to commit, as `deploy` would write it.
 *
 * `--status` reads without changing anything: bin/lock.sh state measures what
 * the machine wants, installs and serves.
 */
async function lockPreview(
  project: Project,
  config: Config,
  executor: Executor,
  subcommand: "enable" | "code" | "disable" | "state",
): Promise<void> {
  const slug = project.manifest.slug;
  note({ slug });
  if (subcommand === "state") {
    const command = [script("lock.sh"), "state", slug];
    const env = { SITESOLIDE_SERVER: config.server, SITESOLIDE_PROJECT_DIR: project.folder };
    // `--status --json` hands the table over as data, this project's row of it.
    if (jsonOutput) {
      note({ lock: readLockState(await executor.run(command, { env, quiet: true }), slug) });
      return;
    }
    await executor.run(command, { env });
    return;
  }

  const access = subcommand === "disable" ? "public" : "code";
  const renew = subcommand === "code";
  step(`general access of ${slug}: ${renew ? "a new code" : access === "code" ? "Anyone with the code" : "Public"}, through the steward and the gatekeeper`);
  if (executor.simulated) {
    say(`   [dry-run] ssh ${config.server} ${ownerGeneralCommand()}`);
    say(`   [dry-run]   with ${JSON.stringify({ slug, access, ...(renew ? { renew } : {}) })}`);
    say("   [dry-run] the gatekeeper draws the code on the machine, writes sitesolide.json, the codes and the locks,");
    say("   [dry-run] validates, reloads Caddy, checks the site over HTTPS, and restores everything on a failure");
    say(`   [dry-run] write ${join(project.folder, MANIFEST_NAME)}, so that the repository follows`);
    note({ dryRun: true });
    return;
  }

  // A project that brings its own door page lays it first: the gatekeeper
  // writes the template's only where no page of the site's own stands.
  if (access === "code") await depositOwnDoorPage(project, config, executor);

  const answer = await sshGeneral((remote, input) => executor.execute(config, remote, input), slug, access, renew);
  if (!answer.ok) die(answer.failure.message, answer.failure.details ?? []);
  const { general, detail, code } = answer.value;
  say(`   ${detail}`);

  const written = followGeneral(project, executor, general.access);
  const url = code === null ? null : (code.url ?? `https://${slug}.${config.zone}/?key=${code.code}`);
  note({ access: general.access, code: code?.code ?? null, url, manifestWritten: written });
  if (code !== null) {
    say("");
    say(`   ${slug} opens with its code.`);
    say("");
    say(`   Code   : ${code.code}`);
    say(`   Link   : ${url}`);
    say("");
    say("   This link sets a cookie valid for thirty days, then sends back to the home");
    say("   page. The code is not a secret: it travels in the clear in the URL and lives");
    say("   in the clear in Caddy's configuration. It keeps out a passing visitor, not");
    say("   an adversary. It is also shown in the site's Access section, to the owner and its Admins.");
  } else {
    say("");
    say(`   ${slug} is public again: its code no longer opens anything.`);
  }
  if (written) {
    say("");
    say(`   commit ${MANIFEST_NAME}: it now says what the server does.`);
  }
}

/**
 * The repository catches up with the machine, as `deploy` makes it: the local
 * manifest's `portal` and `lock` set as the general access now in force, the
 * rest of the file untouched. True when the file was rewritten.
 */
function followGeneral(project: Project, executor: Executor, access: "public" | "restricted" | "code"): boolean {
  const path = join(project.folder, MANIFEST_NAME);
  if (executor.simulated || !existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  const followed = setLock(setPortal(raw, access === "restricted"), access === "code");
  const before = readManifest(raw).manifest;
  if (before !== undefined && isProtected(before) === (access === "restricted") && (before.lock === true) === (access === "code")) return false;
  writeFileSync(path, followed);
  return true;
}

/**
 * A site's own door page, `verrou.html` beside its manifest, laid where Caddy
 * serves it, `/srv/garde/<slug>/index.html`, a name the machine carries. It
 * is a page and nothing Caddy reads as configuration: it changes no general
 * access, and the gatekeeper, which writes the template's page, leaves a page
 * it did not write as it is. A project without one gets the template's.
 */
async function depositOwnDoorPage(project: Project, config: Config, executor: Executor): Promise<void> {
  const source = join(project.folder, "verrou.html");
  if (!existsSync(source)) return;
  const slug = project.manifest.slug;
  const folder = `/srv/garde/${slug}`;
  const account = deploymentAccount(config.server);
  step("door page, the project's own verrou.html");
  await executor.ssh(config, `sudo mkdir -p ${folder} && sudo chown ${account}:${account} ${folder} && sudo chmod 755 ${folder}`);
  await executor.run(["rsync", "--chmod=F644", source, `${config.server}:${folder}/index.html`]);
}

// --- domain ------------------------------------------------------------------

/** The host of `config.server`, without the account: `me@192.0.2.1` -> `192.0.2.1`. */
function serverHost(config: Config): string {
  const target = config.server;
  const at = target.lastIndexOf("@");
  return at === -1 ? target : target.slice(at + 1);
}

/** The addresses of a name, A and AAAA together. A name that does not resolve returns []. */
async function addresses(name: string): Promise<string[]> {
  const found: string[] = [];
  for (const resolver of [resolve4, resolve6]) {
    try {
      found.push(...(await resolver(name)));
    } catch {
      // NXDOMAIN, no record of that type, a mute resolver: the absence reads in
      // the empty array, it has no business interrupting the measurement.
    }
  }
  return found;
}

/**
 * Where the client's domain points, compared with the machine that would serve
 * it.
 *
 * It is the only thing the CLI cannot correct by itself, and the only one that
 * makes a switch fail: Caddy asks for its certificate on the first request, and
 * a request that never arrives never gets one.
 */
async function domainPointsHere(domain: string, config: Config): Promise<boolean> {
  const host = serverHost(config);
  const expected = new Set(/^[\d.]+$/.test(host) ? [host] : await addresses(host));
  const found = await addresses(domain);
  return found.length > 0 && found.some((address) => expected.has(address));
}

/** The declared domain, or the stop: without it there is nothing to switch. */
function requireDomain(manifest: Manifest): { name: string; active?: boolean } {
  const domain = manifest.domain;
  if (domain === undefined) {
    die("no domain declared in the manifest", [
      "a project without a domain lives under the preview subdomain, and needs nothing here",
      'declare it first:  "domain": { "name": "example.com", "active": false }',
    ]);
  }
  return domain as { name: string; active?: boolean };
}

/**
 * What the machine knows of the project's domain, measured and not assumed.
 *
 * Four lines that may diverge, and that is the whole point: the manifest says
 * what is wanted, the table what is installed, the DNS where the visitors go,
 * the HTTP code what they really get.
 */
async function showDomain(
  project: Project,
  config: Config,
  executor: Executor,
): Promise<void> {
  const { manifest } = project;
  const domain = requireDomain(manifest);
  const active = domain.active === true;

  say(`-> domain of ${manifest.slug}`);
  say(`   declared   ${domain.name}${(domain as { aliases?: string[] }).aliases?.length ? ` (aliases: ${(domain as { aliases?: string[] }).aliases?.join(", ")})` : ""}`);
  say(`   manifest   ${active ? "active" : "inactive, preview only"}`);

  const table = await executor.read(
    config,
    `grep -c "^\\s*${domain.name} " /etc/caddy/domaines.map || true`,
  );
  say(`   table      ${table.trim() === "0" ? "absent, run bin/generate-domains.sh" : "present"}`);

  const pointsHere = await domainPointsHere(domain.name, config);
  say(`   dns        ${pointsHere ? `points to ${serverHost(config)}` : "does not point here yet"}`);

  let code: string;
  try {
    const response = await fetch(`https://${domain.name}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    code = String(response.status);
  } catch (err) {
    code = `unreachable: ${(err as Error).message}`;
  }
  say(`   https      ${code}`);
  note({
    slug: manifest.slug,
    domain: {
      name: domain.name,
      aliases: (domain as { aliases?: string[] }).aliases ?? [],
      active,
      table: table.trim() !== "0",
      dns: pointsHere,
      https: /^[0-9]+$/.test(code) ? Number(code) : code,
    },
  });
}

/**
 * The switch of a site onto its domain, or the return to its preview.
 *
 * Three gestures that go together and that were forgotten separately: the
 * versioned manifest, the same file on the VM, and the table Caddy reads again.
 * The table comes last, and without it nothing changes: it is what authorises
 * the certificate, and it does not regenerate itself at deployment time.
 */
async function switchDomain(
  project: Project,
  config: Config,
  executor: Executor,
  active: boolean,
  force: boolean,
): Promise<void> {
  const domain = requireDomain(project.manifest);
  note({ slug: project.manifest.slug, domain: domain.name, active, dryRun: executor.simulated });

  if (active && domain.active === true) {
    say(`-> ${domain.name} is already active, nothing was touched`);
    say("   to see where it stands:  sitesolide domain");
    return;
  }
  if (!active && domain.active !== true) {
    say(`-> ${domain.name} is already inactive, nothing was touched`);
    return;
  }

  // The local manifest leaves for the VM as it is: on a site whose door the
  // dashboard has changed, it would erase it. The guard comes before the DNS,
  // which would serve no purpose if the gesture has to stop anyway, and under
  // the lock shared with the gatekeeper: without it, a door set between the
  // guard and the manifest deposit would be erased by that deposit, and the
  // next deployment, which follows the VM, would reopen the site.
  await takeCaddyLock(config, executor, "nothing was written");
  await requireAgreedDoor(project, config, executor, "domain");

  // A domain activated before its DNS makes a certificate be asked for that the
  // authority will refuse, and those refusals are counted: a few attempts are
  // enough to block the name for a week. The check costs nothing, the wait does.
  if (active && !(await domainPointsHere(domain.name, config))) {
    if (!force) {
      die(`${domain.name} does not resolve to ${serverHost(config)}`, [
        "Caddy asks for a certificate on the first request, and a request that never arrives never gets one",
        "point the record at the server, wait for it to propagate, then run this again",
        "to switch anyway:  sitesolide domain --activate --force",
      ]);
    }
    say(`   --force: ${domain.name} does not point here, switching anyway`);
  }

  const path = join(project.folder, MANIFEST_NAME);
  step(`manifest: domain.active = ${active}`);
  if (executor.simulated) {
    say(`   [dry-run] write ${path}`);
  } else {
    writeFileSync(path, setDomainActive(readFileSync(path, "utf8"), active));
  }

  const reread = executor.simulated ? project : readProject(project.folder);
  await depositManifest(reread, config, executor);

  step("domains table, through the validated path");
  // Under the lock this gesture holds: the script checks it and does not take
  // it again.
  await executor.run([script("generate-domains.sh")], {
    env: envUnderLock(config),
  });
  releaseCaddyLock();

  if (!executor.simulated) await showDomain(reread, config, executor);
  say("");
  say(`   commit ${MANIFEST_NAME}: a deployment would otherwise put back the state in git.`);
}

// --- remove ------------------------------------------------------------------

/**
 * Takes a project off the machine: the Caddy block, the service, the folder,
 * the secret, the account.
 *
 * The command that was missing, and its absence showed: `deploy` knew how to
 * set everything up, nothing knew how to take anything away. An abandoned
 * project stayed served by the VM, its system user and its data folder
 * outliving it without the repository saying anything more about it.
 *
 * **The order is the deployment's in reverse, and it is not so out of
 * symmetry.** `deploy` sets the Caddy block last, once the service is up,
 * because a block in front of a missing service returns 502; deleting in that
 * direction would produce exactly that. The block therefore leaves first,
 * through bin/deploy-caddy.sh, the only way that validates before reloading and
 * restores the previous configuration if the validation fails.
 *
 * **A site behind the portal does the reverse**, like `deploy` which sets its
 * door before its files: removing its block hands the address back to the
 * zone's wildcard block, which serves public/ to everyone. The service is
 * stopped and public/ removed before the block, see removalSteps.
 *
 * **The lock shared with the gatekeeper is held from start to finish**, the
 * read of the door included: it is that read which decides the order, and the
 * gatekeeper must not change it in the meantime. bin/deploy-caddy.sh receives
 * it through CADDY_LOCK_HELD. A site that opens with a code is first made
 * Public through the steward, before the lock is taken: the gatekeeper takes
 * it for its own transaction.
 *
 * **The site's code is never deleted here.** It lives in the neighbouring
 * repository, under git: `git rm -r` does it better, and the history keeps the
 * site recoverable. A deployment command that erases sources is a tool nobody
 * dares run any more. The end of the run says what is left to do.
 */
async function remove(
  project: Project,
  config: Config,
  executor: Executor,
  confirmation: string | undefined,
): Promise<void> {
  const { manifest } = project;
  const slug = manifest.slug;
  const isApplication = isApp(manifest);

  if (!isValidConfirmation(confirmation, slug)) {
    die(`removal needs the slug typed back: --confirm ${slug}`, [
      "a bare flag protects nothing, --yes gets typed without reading",
      "typing the name makes it impossible to remove the wrong project from",
      "the wrong directory, which is how this accident actually happens",
    ]);
  }

  note({ slug, dryRun: executor.simulated });
  say(`-> removing ${slug}, ${isApplication ? "service" : "static"}`);
  say("   this deletes the served directory and its data. The VM has no backup.");

  // A site that opens with a code goes back to Public first, through the
  // steward and the gatekeeper, the one path that changes a general access:
  // once the folder is deleted, its code would stay in force on the machine
  // with nothing left to remove it. Before the Caddy lock this command then
  // holds to the end, which the gatekeeper would wait on.
  const first = await readDepositedDoor(slug, config, executor);
  if (first.kind === "present" && first.lock) {
    step("preview code, back to Public through the steward and the gatekeeper");
    if (executor.simulated) {
      say(`   [dry-run] ssh ${config.server} ${ownerGeneralCommand()}`);
      say(`   [dry-run]   with ${JSON.stringify({ slug, access: "public" })}`);
    } else {
      const reopened = await sshGeneral((remote, input) => executor.execute(config, remote, input), slug, "public", false);
      if (!reopened.ok) die(reopened.failure.message, [...(reopened.failure.details ?? []), "nothing was removed"]);
      say(`   ${reopened.value.detail}`);
    }
  }

  // Before the read of the door, which decides the order of the gestures.
  await takeCaddyLock(config, executor, "nothing was removed");

  // The block of a site closed from the dashboard may exist only on the VM: a
  // static site has none in the repository, and deploy-caddy.sh never deletes
  // an orphan. Only the deposited manifest says that it must be removed too.
  // Read before any gesture: an unreadable read would leave that block behind
  // an erased site, and nothing would say so any more.
  const deposited = await readDepositedDoor(slug, config, executor);
  if (deposited.kind === "unreadable") {
    die(`cannot tell whether ${slug} is restricted on the server`, [
      `${depositedManifestPath(slug)}: ${deposited.reason}`,
      "nothing was removed: a Caddy block set from the dashboard could be left behind",
    ]);
  }

  // Given a code again between the two readings, from the dashboard: the
  // code would outlive the folder. Nothing is removed; running this again
  // takes it back to Public first.
  if (deposited.kind === "present" && deposited.lock && !executor.simulated) {
    die(`${slug} was given a code again while it was being removed`, ["nothing was removed: run this command again"]);
  }

  // The door the VM carries, or the manifest's when the VM no longer has one: a
  // deployment interrupted before its deposit may already have set the
  // protected block and pushed the files it protects.
  const behindPortal = deposited.kind === "present" ? deposited.portal : isProtected(manifest);
  // An application always has a block, a protected site has its door's. A
  // block already gone is reported as such by bin/deploy-caddy.sh, so assuming
  // one costs nothing, where missing one would leave it loaded in front of a
  // stopped service.
  const hasBlock = isApplication || behindPortal;

  for (const removalStep of removalSteps(
    { slug, isApplication, secrets: manifest.secrets ?? [], units: servicesOf(manifest).map((service) => service.unit) },
    { block: hasBlock, isProtected: behindPortal },
  )) {
    if (removalStep.kind === "action") {
      step(removalStep.action.title);
      await executor.ssh(config, removalStep.action.command);
      continue;
    }
    step("Caddy fragment, through the validated path");
    if (executor.simulated) {
      say(`   [dry-run] bin/deploy-caddy.sh with SITESOLIDE_REMOVE=${slug}.caddy`);
    } else {
      // SITESOLIDE_REMOVE: without it, the block stays loaded in front of a
      // stopped service. Measured on 15 September 2026 while removing a project.
      await executor.run([script("deploy-caddy.sh")], {
        env: { ...envUnderLock(config), SITESOLIDE_REMOVE: `${slug}.caddy` },
      });
    }
  }

  // The table regenerates itself from the manifests left on the VM: the
  // project's one having disappeared with its folder, the client's domain drops
  // out of it. Without this step, the `ask` endpoint would go on authorising a
  // certificate for a site that no longer exists.
  if (manifest.domain !== undefined) {
    step("domains table, through the validated path");
    await executor.run([script("generate-domains.sh")], {
      env: envUnderLock(config),
    });
  }

  // Its manifest gone with its folder, the project drops out of the set: its
  // ports go back to being Caddy's alone, before another project takes them.
  await rebuildProjectPorts(config, executor, "follow");

  releaseCaddyLock();
  step("token ownership, on the steward");
  if (executor.simulated) {
    say(`   [dry-run] release ${slug} from the token that created it, if one did, and drop its people with access: the steward's owner socket`);
    say("-> dry run, nothing was removed");
    return;
  }
  // The project is gone whatever the steward says: a refusal here is said, and
  // running this command again, which tolerates every absence, finishes it.
  const release = readOwnershipRelease(await executor.execute(config, ownershipReleaseCommand(), JSON.stringify({ slug })));
  if (release.kind === "released") say(`   ${slug} created by token ${release.token}: its name is free again for another token`);
  else if (release.kind === "none") say(`   no token created ${slug}`);
  else if (release.kind === "outdated") warn(`the steward on the server keeps no record to release, or predates it: run sitesolide upgrade, then this command again, if a token created ${slug} or people had access to it`);
  else warn(`the steward kept ${slug} as its token's, or kept its people with access (${release.reason}): run this command again`);
  if ((release.kind === "released" || release.kind === "none") && release.access > 0) say(`   its people with access dropped: ${release.access}, so that a project created later under that name starts from nobody`);

  say("");
  say("-> gone from the machine. What is left, and this command will not do it:");
  for (const line of leftToDo(slug, project.folder)) say(`   ${line}`);
}

// --- a folder without a manifest, an app without a port ----------------------

/** How the human output names what a folder was recognised as. */
const KIND_LABEL: Record<Exclude<Inference["kind"], "none">, string> = {
  static: "a folder of files",
  "static-build": "a site built into a folder of files",
  bun: "a Bun app",
  node: "a Node app, run by Bun",
  python: "a Python app",
  go: "a Go app",
};

/**
 * The manifest a folder implies, or the stop that says why there is none.
 * `chosen` is `--slug`; without it, the folder's name gives the slug. For
 * `deploy`, which asked for a manifest and found none, the stop says that
 * first.
 */
function inferOrDie(
  folder: string,
  chosen: string | undefined,
  forDeploy = false,
): { inference: Exclude<Inference, { kind: "none" }>; raw: string } {
  if (chosen !== undefined && (!isValidSlug(chosen) || chosen === "landing" || isSystemName(chosen))) {
    die(`--slug: ${chosen} is not a usable slug`, [
      "lowercase letters, digits and dashes, no dot, not landing, nor the name of a service the machine runs",
    ]);
  }
  const slug = chosen ?? slugFromFolder(basename(folder));
  if (slug === null) die(`no usable slug in the folder name: ${basename(folder)}`, ["pass one with --slug <name>"]);
  const inference = inferManifest(folder, slug);
  if (inference.kind === "none") {
    die(
      forDeploy ? `${MANIFEST_NAME} not found in ${folder}, and none can be inferred` : `nothing deployable recognised in ${folder}`,
      inference.reasons,
    );
  }
  return { inference, raw: renderManifest(inference.manifest) };
}

/** The inferred manifest, with what it was inferred from and what to check before deploying it. */
function showInference(inference: Exclude<Inference, { kind: "none" }>, raw: string, title: string): void {
  if (jsonOutput) {
    emit({ type: "inferred", kind: inference.kind, manifest: JSON.parse(raw), reasons: inference.reasons, notes: inference.notes });
    return;
  }
  step(title);
  say(`   from: ${inference.reasons.join("; ")}`);
  say(raw.trimEnd());
  for (const line of inference.notes) say(`   note: ${line}`);
}

/**
 * `sitesolide detect`: what the folder implies, written nowhere unless
 * `--write` asks, and never over a manifest already there. Reads nothing on
 * the machine, needs no configuration: an agent can ask before anything is
 * set up.
 */
function detect(folder: string, write: boolean, chosen: string | undefined): void {
  const { inference, raw } = inferOrDie(folder, chosen);
  const path = join(folder, MANIFEST_NAME);
  const present = existsSync(path);
  if (write && present) {
    die(`${MANIFEST_NAME} already exists in ${folder}`, ["detect --write never replaces a manifest"]);
  }
  note({
    kind: inference.kind,
    manifest: inference.manifest,
    reasons: inference.reasons,
    notes: inference.notes,
    written: write ? path : null,
  });
  if (!jsonOutput) showInference(inference, raw, `this folder reads as ${KIND_LABEL[inference.kind]}`);
  if (write) {
    writeFileSync(path, raw);
    say(`   written: ${path}`);
    say("   review it, commit it, then: sitesolide deploy");
  } else if (present) {
    say(`   ${MANIFEST_NAME} already exists here: this is what the folder alone implies, nothing was written`);
  } else {
    say("   nothing was written; to write it: sitesolide detect --write");
  }
}

/**
 * The project `deploy` works on: the folder's manifest, or, in a folder that
 * has none, the inferred one, shown and refused unless `--yes` accepts it.
 *
 * An inferred manifest names the project after its folder, and folders called
 * `api` or `site` are not rare: the machine may already serve a project of
 * that name, deployed from somewhere else, which this deployment would
 * replace. It is refused before anything is written. A manifest written by
 * hand is its author's decision, and is not second-guessed here.
 *
 * In a dry run, the accepted manifest stays in memory: a dry run writes nothing.
 */
async function projectToDeploy(
  folder: string,
  config: Config,
  executor: Executor,
  accept: boolean,
  chosen: string | undefined,
): Promise<Project> {
  const path = join(folder, MANIFEST_NAME);
  if (existsSync(path)) {
    if (chosen !== undefined) warn(`--slug ${chosen} ignored: ${MANIFEST_NAME} names the project`);
    return readProject(folder, { portLater: true });
  }

  const { inference, raw } = inferOrDie(folder, chosen, true);
  const slug = inference.manifest.slug;
  showInference(inference, raw, `no ${MANIFEST_NAME}: this folder reads as ${KIND_LABEL[inference.kind]}`);
  note({ inferred: inference.kind });

  const reading = readDepositedManifests(await executor.read(config, readManifestsCommand(slug)));
  if (reading.kind === "unreadable") {
    die(`cannot tell whether ${slug} already exists on the server`, [reading.reason, "nothing was written nor pushed"]);
  }
  if (reading.manifests.has(slug)) {
    die(`${slug} already exists on the server, and this folder has no ${MANIFEST_NAME}`, [
      "deploying the inferred manifest under that name would replace the project the server carries",
      "pick another name:  sitesolide deploy --yes --slug <name>",
    ]);
  }
  if (!accept) {
    die(`no ${MANIFEST_NAME} in ${folder}: inferred one shown above, not written`, [
      "to write it and deploy:            sitesolide deploy --yes",
      "to write it and review it first:   sitesolide detect --write",
    ]);
  }
  if (executor.simulated) {
    say(`   [dry-run] write ${path}`);
  } else {
    writeFileSync(path, raw);
    say(`   written: ${path}, commit it`);
  }
  note({ manifestWritten: !executor.simulated });
  return readProject(folder, { raw, portLater: true });
}

/**
 * Gives a port to an app whose manifest declares none, and writes it into the
 * local sitesolide.json, which then has to be committed: the next deployment,
 * from this workstation or another, keeps it. See bin/cli/ports.ts for the
 * choice. A read, hence done in a dry run too, which only skips the write.
 */
async function allocatePort(project: Project, config: Config, executor: Executor): Promise<Project> {
  if (!needsPort(project.manifest)) return project;
  const slug = project.manifest.slug;
  const reading = readDepositedManifests(await executor.read(config, readManifestsCommand("*")));
  if (reading.kind === "unreadable") {
    die("cannot read the manifests on the server to choose a port", [reading.reason, "nothing was pushed"]);
  }
  const choice = choosePort(slug, reading.manifests);
  if (choice.kind === "full") {
    die("no free port left on the server", [
      `every port from ${SERVICE_PORTS.first} to ${SERVICE_PORTS.last} is declared by a project or reserved`,
    ]);
  }
  step(
    choice.kind === "kept"
      ? `port ${choice.port}, the one the server already gives ${slug}`
      : `port ${choice.port}, the lowest free one on the server`,
  );
  const raw = setPort(project.raw, choice.port);
  const { manifest, errors } = readManifest(raw);
  if (manifest === undefined || errors.length > 0) die(`${MANIFEST_NAME} rejected`, errors);
  const path = join(project.folder, MANIFEST_NAME);
  if (executor.simulated) {
    say(`   [dry-run] write ${path} with "port": ${choice.port}`);
  } else {
    writeFileSync(path, raw);
    say(`   written into ${path}: commit it, so that the next deploy keeps this port`);
  }
  note({ portChosen: choice.kind, manifestWritten: !executor.simulated });
  return { ...project, manifest, raw };
}

/** The value given to an option, `--slug shop`, or undefined. */
function optionValue(arguments_: string[], name: string): string | undefined {
  const marker = arguments_.indexOf(name);
  return marker === -1 ? undefined : arguments_[marker + 1];
}

// --- entry point -------------------------------------------------------------

/**
 * Writes `~/.config/sitesolide/config.json`, the only thing the CLI cannot
 * guess: which machine to serve, and under which zone.
 *
 * No value is offered by default for those two. A default would aim at the
 * machine of whoever wrote the file, and a `deploy` launched without
 * configuration would leave for theirs: better to refuse than to get the
 * recipient wrong.
 *
 * Re-run over a file written by an earlier version, it offers the old values
 * and writes them back under the current names, leaving out the keys no longer
 * read: that is what takes a configuration across a change without retyping it.
 */
async function initialise(arguments_: string[]): Promise<void> {
  const value = (name: string): string | undefined => {
    const marker = arguments_.indexOf(`--${name}`);
    return marker === -1 ? undefined : arguments_[marker + 1];
  };

  const existing = Bun.file(configPath());
  const onDisk = (await existing.exists()) ? ((await existing.json()) as Record<string, string>) : {};
  const adopted = adoptLegacyKeys(onDisk);
  if (adopted.legacy.length > 0) console.error(legacyKeysWarning(adopted.legacy));
  const previous = adopted.config as Record<string, string>;

  const ask = (name: string, question: string, current?: string): string => {
    const given = value(name);
    if (given !== undefined) return given;
    const response = prompt(current === undefined ? `${question} ` : `${question} [${current}] `);
    const chosen = response === null || response.trim() === "" ? (current ?? "") : response.trim();
    if (chosen === "") die(`${name} is required`, ["it is what tells the CLI which machine to serve"]);
    return chosen;
  };

  // The paths are written only if they are given or already set: see
  // composeConfig, which `sitesolide setup` writes the file through too.
  const config = composeConfig(
    {
      server: ask("server", "SSH target, user@host:", previous.server),
      zone: ask("zone", "DNS zone served, e.g. example.com:", previous.zone),
      email: ask("email", "Contact address for the certificate authority:", previous.email),
    },
    Object.fromEntries(OPTIONAL_SETTINGS.map((key) => [key, value(key)])),
    previous,
  );

  const path = configPath();
  await writeConfig(path, config);
  console.log(`written: ${path}`);
  for (const [key, given] of Object.entries(config)) console.log(`  ${key}: ${given}`);
}

/**
 * The list `help` prints, and an unknown command. `zone` names the dashboard
 * when the configuration knows it; `help` runs without one.
 */
function usage(zone: string | null): string {
  return [
    "usage:",
    "  sitesolide help                 this list, with or without a configuration; --help after any command",
    "  sitesolide --version            the release this binary was built from, dev from a checkout",
    "  sitesolide setup <user@host>    install a fresh Debian 13 machine, resumable, a no-op once done",
    "     --zone <dns.zone> --email <you@example.com>",
    "     --contact <you@example.com>   shown on the page that asks for a preview code",
    "     --user <name>                the account that deploys, deploy by default as root",
    "     --skip-dns                   create the DNS records by hand: setup lists them and waits",
    "     --dns-replace                replace records that point elsewhere, on your decision alone",
    "     --cloudflare-token-stdin     read the Cloudflare token from standard input",
    "     --minimal                    leave out backups, the installer and the egress proxy",
    "     --any-os                     go on with a system other than Debian 13, at your own risk",
    "     --config-dir <dir>           another installation's own configuration folder",
    "     --dry-run                    check every step, change nothing",
    "  sitesolide upgrade              bring every installed component to this release's code, resumable",
    "     --dry-run                    list each component, up to date, out of date or missing, change nothing",
    "  sitesolide init                 write ~/.config/sitesolide/config.json",
    "     --server <user@host> --zone <dns.zone> --email <you@example.com>",
    "     --contact <you@example.com>   shown on the page that asks for a preview code",
    "  sitesolide detect               the sitesolide.json this folder implies, written nowhere",
    "     --write                      write it, never over an existing one",
    "     --slug <name>                name the project, rather than after its folder",
    "  sitesolide deploy               prepare, build, push, install, restart, verify",
    "     --dry-run                    show the unit and the fragment, install nothing, build nothing",
    "     --build                      with --dry-run: run the build too, the folder's own code, here",
    "     --compare                    with --dry-run: build, then list what would change on the server",
    "     --force                      switch a hand-written unit to the generated one",
    "     --yes [--slug <name>]        no sitesolide.json: write the inferred one, then deploy",
    "  sitesolide status               what the server actually runs",
    "  sitesolide logs [--follow]      journalctl for this project",
    "     --lines <n>                  how many lines back, 50 by default",
    "  sitesolide backups              this project's data snapshots, read only",
    "  sitesolide share                this project's general access and people with access",
    "     <email|@domain>...           give them access, Can open by default",
    "     --role <role>                can-open, viewer, developer or admin",
    "     --expires <24h|7d|30d|never> for password access, 7d by default",
    "     --remove <email|@domain>...  take their access away; password access by the name it is listed under",
    "  sitesolide people               everyone with access, their roles, who may create projects",
    "     <email> --may-create         let them create projects, Admin of what they create",
    "     <email> --no-create          take that right back",
    "     --migrate-without-portal     carry access over without the portal's database, when it does not read",
    "  sitesolide lock   [--dry-run]   Anyone with the code: the site opens with a code, said once; or the one in force",
    "     --status                     wanted / installed / measured, without touching",
    "     --new-code                   a new code, the old one no longer opens it",
    "  sitesolide unlock [--dry-run]   back to Public, its code dropped",
    "  sitesolide domain               where this project's own domain stands",
    "     --activate [--force]         switch the site onto it, then rebuild the table",
    "     --deactivate                 back to the preview subdomain",
    "  sitesolide remove --confirm <slug>",
    "                                  take the project off the machine, for good, its name freed from the token that created it",
    "     --dry-run                    show every step, remove nothing",
    "  sitesolide run -- <command>     load the secret from the vault and run",
    "  sitesolide mcp                  serve these commands to an agent, over MCP on stdio",
    "  sitesolide login --url <https://dashboard.zone>",
    "                                  a person with a token: deploy without SSH",
    "     --token-stdin                read the token from standard input",
    "  sitesolide machine create|list|destroy --provider hetzner",
    "                                  a VM ordered by API, before setup: sitesolide machine lists the options",
    "  any command --api               go through the dashboard's API even with a server",
    "  SITESOLIDE_CONFIG_DIR=<dir>     before any command: read that installation's configuration",
    "",
    "--json, on every command but init and run: one JSON event per line, see docs/agents.md",
    `secrets live on the server: manage them in the Secrets section of ${zone === null ? "https://dashboard.<zone>" : dashboardAddress(zone)}`,
    "general access of a deployed site is set from the dashboard too: deploy follows the server",
  ].join("\n");
}

/** `help`, `--help` or `-h`, as the command or among its options; never what follows `--`, which `run` hands on. */
function asksForHelp(arguments_: string[]): boolean {
  const separator = arguments_.indexOf("--");
  const own = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  return own[0] === "help" || own.includes("--help") || own.includes("-h");
}

/**
 * The list for this workstation: a team member's, with a token and no
 * server, gets the commands the token runs. Neither reads more than the
 * configuration file, and an unreadable one only loses the zone.
 */
function helpText(arguments_: string[]): string {
  // `share --help` and `people --help`: their own usage, short, rather than every command.
  if (arguments_[0] === "share") return SHARE_USAGE.join("\n");
  if (arguments_[0] === "people") return PEOPLE_USAGE.join("\n");
  if (remoteMode(arguments_, process.env)) return REMOTE_USAGE.join("\n");
  let zone: string | null = process.env.SITESOLIDE_ZONE ?? null;
  try {
    zone ??= readConfigFile().zone ?? null;
  } catch {
    // Unreadable: the list stays generic.
  }
  return usage(zone === "" ? null : zone);
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0] ?? "";
  const dryRun = arguments_.includes("--dry-run");
  const replace = arguments_.includes("--force");
  const executor = new Executor(dryRun);
  chooseOutput(arguments_);
  buildInDryRun = arguments_.includes("--build");
  compareInDryRun = arguments_.includes("--compare");

  // `init` prompts and `run` hands the terminal to the command it launches:
  // neither has events to print.
  if (jsonOutput && (command === "init" || command === "run")) {
    die(`--json is not available for ${command}`, ["its output is for a person, or for the command it runs"]);
  }

  // Neither reads the configuration: they are what someone types first, on a
  // workstation where `init` has not run yet, and a "missing settings" in
  // answer to --help explained nothing. `--help` after any command asks for
  // the list too, rather than running the command: `deploy --help` is a
  // question, and deploying in answer would be the worst one.
  if (command === "--version" || command === "version") {
    if (jsonOutput) {
      note({ version: VERSION, bun: Bun.version });
      finish("version");
    } else console.log(`sitesolide ${VERSION}`);
    process.exit(0);
  }
  if ((command === "" && !jsonOutput) || asksForHelp(arguments_)) {
    const text = helpText(arguments_);
    if (jsonOutput) {
      note({ usage: text.split("\n") });
      finish("help");
      process.exit(0);
    }
    // Bare, the command is a mistake as much as a question: the list goes to
    // standard error, and the exit code says nothing was done.
    if (command === "") {
      console.error(text);
      process.exit(1);
    }
    console.log(text);
    process.exit(0);
  }

  // A component of the unpacked kit, the dashboard that `setup` deploys, is
  // worked on in a writable copy: the kit is a read-only cache, and what a
  // command writes into the folder, a manifest that follows the server, must
  // not land there. Elsewhere, the folder itself. See bin/cli/kit.ts.
  const folder = fromKit(() => workingFolder(process.cwd()));
  if (folder !== process.cwd()) say(`   the kit is read-only: working on a copy of this folder, ${folder}`);

  // Neither reads the configuration: `detect` reads the folder alone, and
  // `mcp` runs every tool call as a command of its own, which reads it then.
  if (command === "detect") {
    detect(folder, arguments_.includes("--write"), optionValue(arguments_, "--slug"));
    finish(command);
    process.exit(0);
  }
  if (command === "mcp") {
    await (await import("./mcp")).serve();
    process.exit(0);
  }

  // `init` writes the configuration: reading it first would refuse it for being
  // missing, and there would then be no way to set it.
  if (command === "init") {
    await initialise(arguments_);
    process.exit(0);
  }

  // `setup` installs a machine and writes the configuration as it goes: it
  // reads the one in place itself, to refuse one that names another server.
  // See bin/cli/setup.ts.
  if (command === "setup") {
    process.exit(await (await import("./cli/setup")).setupCommand(arguments_.slice(1)));
  }

  // `upgrade` brings the components setup installed to this release's code,
  // through setup's own runner, checks and scripts: it reads the
  // configuration itself, and needs the owner's SSH access. See
  // bin/cli/upgrade.ts.
  if (command === "upgrade") {
    process.exit(await (await import("./cli/upgrade")).upgradeCommand(arguments_.slice(1)));
  }

  // A team member's workstation has no server and no root: `login`, and the
  // commands the dashboard's control API carries, go through it instead of
  // SSH. The owner's path below is untouched. See bin/cli/remote.ts.
  //
  // `--json` reaches them too: the same events, and one final `result` or
  // `error` with its hint, whichever way the command runs.
  const remoteOutput = jsonOutput ? eventOutput() : humanOutput;

  // `machine` orders the VM the configuration will name: it comes before
  // there is one to read, and talks to the provider's API, never over SSH.
  // See bin/cli/machine.ts.
  if (command === "machine") process.exit(await machine(arguments_, { environment: process.env, output: remoteOutput }));
  if (command === "login") process.exit(await login(arguments_, { environment: process.env, output: remoteOutput }));
  if (remoteMode(arguments_, process.env)) {
    process.exit(
      await runRemote(command, arguments_, {
        folder,
        environment: process.env,
        output: remoteOutput,
        build: (project) => runBuild(project, executor),
        checkPublic: (project) => checkPublicFolder(project),
      }),
    );
  }

  const config = await (async () => {
    try {
      return await readConfig();
    } catch (error) {
      if (error instanceof IncompleteConfig) {
        die(`missing settings: ${error.missing.join(", ")}`, [
          "run: sitesolide init",
          `it writes ${configPath()}, which says which machine to serve and under which zone`,
          "someone with a token runs instead: sitesolide login --url https://dashboard.<zone>",
        ]);
      }
      throw error;
    }
  })();

  // The scripts of bin/ read the projects folder from the environment: set
  // here, it goes down to every sub-process without being repeated at each
  // call, and keeps the precedence it already has in mergeConfig.
  process.env.SITESOLIDE_ZONE = config.zone;


  switch (command) {
    case "deploy":
      if (compareInDryRun && !dryRun) {
        die("--compare needs --dry-run", ["it measures what a deployment would change on the server, and changes nothing there"]);
      }
      await deploy(
        await projectToDeploy(folder, config, executor, arguments_.includes("--yes"), optionValue(arguments_, "--slug")),
        config,
        executor,
        replace,
      );
      break;
    case "status":
      await showStatus(config, executor);
      break;
    case "logs": {
      const lines = optionValue(arguments_, "--lines") ?? "50";
      if (!/^[0-9]+$/.test(lines) || Number(lines) < 1 || Number(lines) > 1000) {
        die(`--lines: ${lines} is not a number of lines between 1 and 1000`);
      }
      await logs(readProject(folder), config, arguments_.includes("--follow"), executor, Number(lines));
      break;
    }
    case "backups": {
      // Read only: the restore itself is the dashboard's, see bin/cli/backups.ts.
      const report = await backupsReport(readProject(folder).manifest.slug, dashboardAddress(config.zone), (command) =>
        executor.read(config, command),
      );
      for (const line of report.lines) (report.ok ? say : console.error)(line);
      if (!report.ok) process.exit(1);
      break;
    }
    case "share":
      // The steward's access registry, on its owner socket, as root over SSH:
      // see bin/cli/access.ts.
      process.exit(await share(arguments_, readProject(folder).manifest.slug, sshAccess((remote, input) => executor.execute(config, remote, input), dashboardAddress(config.zone)), remoteOutput));
    case "people":
      // The same registry, machine-wide. It reads no project folder.
      process.exit(await people(arguments_, dashboardAddress(config.zone), sshPeople((remote, input) => executor.execute(config, remote, input)), remoteOutput));
    case "secrets":
      pointToDashboard(config);
    case "lock": {
      const which = arguments_.includes("--status")
        ? "state"
        : arguments_.includes("--new-code")
          ? "code"
          : "enable";
      await lockPreview(readProject(folder), config, executor, which);
      break;
    }
    case "unlock":
      await lockPreview(readProject(folder), config, executor, "disable");
      break;
    case "domain": {
      const project = readProject(folder);
      if (arguments_.includes("--activate")) {
        await switchDomain(project, config, executor, true, replace);
      } else if (arguments_.includes("--deactivate")) {
        await switchDomain(project, config, executor, false, replace);
      } else {
        await showDomain(project, config, executor);
      }
      break;
    }
    case "remove": {
      const marker = arguments_.indexOf("--confirm");
      await remove(
        readProject(folder),
        config,
        executor,
        marker === -1 ? undefined : arguments_[marker + 1],
      );
      break;
    }
    case "run": {
      const separator = arguments_.indexOf("--");
      await runWithSecret(
        readProject(folder),
        config,
        separator === -1 ? [] : arguments_.slice(separator + 1),
      );
      break;
    }
    default:
      if (jsonOutput) die(`unknown command: ${command === "" ? "none given" : command}`);
      console.error(usage(config.zone));
      process.exit(1);
  }
  finish(command);
}
