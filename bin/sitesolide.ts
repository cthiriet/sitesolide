#!/usr/bin/env bun
/**
 * Deploys a project onto the machine from any repository.
 *
 *   sitesolide deploy [--dry-run]   prepare, build, push, install, verify
 *   sitesolide status               what the VM actually carries
 *   sitesolide logs [--follow]      journalctl for the service
 *   sitesolide remove --confirm <slug>  take the project off the machine
 *   sitesolide run -- <command>     load the vault secret and run
 *
 * The interface is in English, options and messages alike: a CLI is a technical
 * identifier, like the manifest keys. The code and the comments stay in French,
 * a rule of the repository.
 *
 * ONE COMMAND IS ENOUGH, including on the first run: `deploy` creates the
 * system user, puts the unit in place and pushes from the vault a secret the VM
 * does not have yet. It never replaces, on the other hand, a unit in service,
 * whose contents may differ from the generated one for good reasons: that case
 * is reported, and `--force` settles it by hand. Nor does it touch a secret
 * already there, for another reason: THE VM IS THE SOURCE OF TRUTH.
 * /etc/sitesolide is managed from the Secrets section of the dashboard, and a
 * deployment that measured the machine against the workstation's vault would
 * take every value changed over there for a lag to catch up on. Everything
 * `deploy` puts in place is idempotent: the second run changes nothing on the
 * machine.
 *
 * THE PORTAL OF A DEPLOYED SITE IS SET FROM THE DASHBOARD, AND THE VM IS THE
 * SOURCE OF TRUTH THERE TOO. The dashboard's gatekeeper rewrites on the machine
 * the deposited manifest and the site's Caddy block, without changing anything
 * in the repository. Now `deploy` deposits the repository's manifest again and
 * generates the block from it: without precaution, it would silently reopen a
 * site the dashboard has just closed. `deploy` therefore reads the deposited
 * manifest first. If it asks for a door other than the local manifest's, it is
 * its own that holds for everything `deploy` generates and deposits, and the
 * local sitesolide.json is rewritten so that the repository catches up with the
 * machine, as bin/lock.sh does with the lock: to be committed. A first
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
 * Instructions in README.md. This file carries only the orchestration: what
 * decides lives in bin/cli/, as pure functions tested by
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { compareDirectives, sameDirectives, summariseDivergence } from "./cli/comparison";
import {
  adoptLegacyKeys,
  configPath,
  deploymentAccount,
  IncompleteConfig,
  legacyKeysWarning,
  readConfig,
  type Config,
} from "./cli/config";
import { decideBlock, generateFragment } from "./cli/fragment";
import {
  isApp,
  isProtected,
  missingExclusions,
  readManifest,
  setDomainActive,
  setPortal,
  PORTAL_SLUG,
  type Manifest,
} from "./cli/manifest";
import {
  switchAnnouncement,
  depositedManifestPath,
  readManifestsCommand,
  confirmDoorUnderLock,
  decidePortal,
  guardDepositedManifest,
  readDepositedManifest,
  type ManifestAction,
  type DepositedRead,
} from "./cli/portal-vm";
import {
  isValidConfirmation,
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
  generateUnit,
  readUnitAnswer,
  type UnitRead,
  MARKER_ABSENT,
  MARKER_PRESENT,
  systemUser,
} from "./cli/unit";
import {
  lockCommand,
  readRelease,
  takeLock,
  releaseScript,
  HELD_VARIABLE,
  type Execution,
} from "./cli/caddy-lock";

const REPO_ROOT = resolve(import.meta.dir, "..");
const MANIFEST_NAME = "sitesolide.json";

type Project = {
  folder: string;
  manifest: Manifest;
  /**
   * The manifest's text as it will leave for the VM. It follows `manifest`:
   * when the dashboard has changed the door, both carry the VM's value, in a
   * dry run as for real.
   */
  raw: string;
};

// --- output ------------------------------------------------------------------

function say(message: string): void {
  console.log(message);
}

function step(message: string): void {
  console.log(`-> ${message}`);
}

function die(message: string, details: string[] = []): never {
  console.error(`!! ${message}`);
  for (const line of details) console.error(`   ${line}`);
  process.exit(1);
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
  if (release.kind === "warning") {
    console.error(`!! ${release.message}`);
    for (const detail of release.details) console.error(`   ${detail}`);
  }
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
  if (interruption !== null || running === 0) process.exit(code);
  interruption = { signal, code };
  console.error(`!! ${signal}: the running step finishes first, then everything stops`);
}

function stopIfInterrupted(): void {
  if (interruption === null) return;
  console.error(`!! interrupted by ${interruption.signal}`);
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
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
      stdout: options.quiet ? "pipe" : "inherit",
      stderr: "inherit",
    });
    running++;
    let output = "";
    let code: number;
    try {
      output = options.quiet ? await new Response(proc.stdout).text() : "";
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
   * the lock that reads them itself. Never short-circuited by the dry-run
   * mode: it is only called outside it.
   */
  async execute(config: Config, command: string): Promise<Execution> {
    const proc = Bun.spawn(["ssh", config.server, command], { stdout: "pipe", stderr: "pipe" });
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
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      console.error(`!! read refused by the server: ${error.trim() || "no message"}`);
    }
    return output;
  }
}

// --- reading the project -----------------------------------------------------

function readProject(folder: string): Project {
  const path = join(folder, MANIFEST_NAME);
  if (!existsSync(path)) {
    die(`${MANIFEST_NAME} not found in ${folder}`, [
      "a deployable project declares its slug and what to do with it,",
      "with the keys listed in bin/cli/manifest.ts of the platform",
    ]);
  }

  const raw = readFileSync(path, "utf8");
  const { manifest, errors } = readManifest(raw);
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
  const missing = isApp(manifest)
    ? missingExclusions(manifest, readdirSync(folder))
    : [];
  if (missing.length > 0) {
    die(`exclude: ${missing.join(", ")} present on disk and not excluded`, [
      `add "exclude": [${missing.map((n) => `"${n}"`).join(", ")}] to the manifest`,
    ]);
  }

  return { folder, manifest, raw };
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

async function runBuild(project: Project, executor: Executor): Promise<void> {
  const { build } = project.manifest;
  if (build === undefined) return;
  step(`build (${build})`);
  // The build runs on the workstation, even in a dry run: it is what produces
  // what would leave, and a test that skips it verifies nothing.
  const proc = Bun.spawn(["sh", "-c", build], {
    cwd: project.folder,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) die(`build failed: ${build}`);
}

function publicFolder(project: Project): string | null {
  const { publicDir } = project.manifest;
  return publicDir === undefined ? null : join(project.folder, publicDir);
}

function checkPublicFolder(project: Project): void {
  const folder = publicFolder(project);
  if (folder === null) return;
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

async function deploy(
  rawProject: Project,
  config: Config,
  executor: Executor,
  replace = false,
): Promise<void> {
  const slug = rawProject.manifest.slug;
  const paths = projectPaths(slug);
  const isApplication = isApp(rawProject.manifest);

  say(`-> project ${slug}, ${isApplication ? "service" : "static"}`);

  // The door before everything else, in a dry run as for real: the block shown,
  // the block checked, the order of the steps and the deposited manifest all
  // depend on it. From here on, `project` carries the value the VM makes
  // authoritative, and `rawProject` is of no further use.
  const { project, switched, doorConfirmed } = await reconcilePortal(rawProject, config, executor);
  const { manifest } = project;
  if (isApplication && executor.simulated) showGeneratedFiles(manifest);

  // Before the build and before anything is pushed: a refusal that falls after
  // the rsync and the restart leaves the new code served by the old block. The
  // blocks of the other sites are not this deployment's business: it deposits
  // its own, and leaves theirs as the machine carries them.
  if (isApplication) await checkRemoteBlock(manifest, config, executor, replace, doorConfirmed);
  const behindPortal = isProtected(manifest);
  if (behindPortal) await requirePortal(config, executor);

  await runBuild(project, executor);
  checkPublicFolder(project);

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
    const exclusions = (manifest.exclude ?? []).flatMap((name) => ["--exclude", name]);
    const publicDir = manifest.publicDir;
    const also = publicDir === undefined ? [] : ["--exclude", publicDir];
    await executor.run([
      "rsync",
      "-a",
      "--delete",
      ...exclusions,
      ...also,
      "--exclude",
      ".git",
      // The manifest is already deposited at the project's root, where the
      // service reads it: a second copy in app/ would make two of them diverge,
      // and nothing would say which one is authoritative.
      "--exclude",
      MANIFEST_NAME,
      `${project.folder}/`,
      `${config.server}:${paths.app}/`,
    ]);
  }

  const publicDir = publicFolder(project);
  if (publicDir !== null) {
    step("public files");
    await executor.run([
      "rsync",
      "-a",
      "--delete",
      `${publicDir}/`,
      `${config.server}:${paths.publicDir}/`,
    ]);
  }

  await enterUnderLock();
  await depositManifest(project, config, executor);
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
      step(`dependencies (${manifest.install})`);
      await executor.ssh(config, `cd ${paths.app} && ${manifest.install}`);
    }

    step("service restart");
    await executor.ssh(config, `sudo systemctl restart ${slug} && systemctl is-active ${slug}`);

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
    say("   the dashboard changed the portal, and git should say what the server does.");
  }
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
 * decides. For an application project, the same read also guards the blocks of
 * every site once more, so that the Caddy step is not refused after the service
 * restart. In a dry run, nothing is read again: no lock is taken.
 */
async function rereadUnderLock(
  manifest: Manifest,
  config: Config,
  executor: Executor,
  isApplication: boolean,
): Promise<void> {
  if (executor.simulated) {
    say("   [dry-run] read the portal again under the lock, and decide on it");
    return;
  }
  const slug = manifest.slug;
  const output = await executor.read(config, readManifestsCommand(slug));
  const agreement = confirmDoorUnderLock(slug, isProtected(manifest), readDepositedManifest(output, slug));
  if (agreement.kind === "rejects") die(agreement.message, agreement.details);
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
    isProtected(manifest),
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
  const decision = decidePortal(manifest.slug, isProtected(manifest), reading);
  if (decision.kind === "rejects") die(decision.message, decision.details);
  const doorConfirmed = reading.kind === "present";
  if (decision.kind === "repository") return { project, switched: false, doorConfirmed };

  const announcement = switchAnnouncement(decision.portal, executor.simulated);
  step(announcement.title);
  for (const line of announcement.details) say(`   ${line}`);

  const raw = setPortal(project.raw, decision.portal);
  const { manifest: followed, errors } = readManifest(raw);
  if (followed === undefined || errors.length > 0) {
    die(`${MANIFEST_NAME} rejected once the portal set from the dashboard is applied`, errors);
  }

  const path = join(project.folder, MANIFEST_NAME);
  if (executor.simulated) {
    say(`   [dry-run] write ${path}`);
  } else {
    writeFileSync(path, raw);
  }
  return { project: { folder: project.folder, manifest: followed, raw }, switched: true, doorConfirmed };
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
    await executor.run([join(REPO_ROOT, "bin", "deploy-caddy.sh"), path], {
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
    stdin: new TextEncoder().encode(content),
    stdout: "inherit",
    stderr: "inherit",
  });
  running++;
  let code: number;
  try {
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
 */
async function verify(manifest: Manifest, config: Config, executor: Executor): Promise<void> {
  const address = `https://${manifest.slug}.${config.zone}/`;
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

  // A protected site that answers 200 to a stranger is not a success: it is the
  // worst possible state, a site its owner believes closed. Only the portal's
  // 401, recognisable by its header, says that the door is in place.
  if (isProtected(manifest)) {
    if (code === 401 && door === "connexion") {
      say("   behind the portal: unknown visitors get the login page");
      return;
    }
    die(`${address} should answer the portal's 401, got ${code}`, [
      "the site is declared behind the portal, and is not",
    ]);
  }

  if (code === 401) {
    say(`   preview locked, see bin/lock.sh state ${manifest.slug}`);
    return;
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
  const unit = generateUnit(manifest);

  step("system user and directories");
  await executor.ssh(
    config,
    [
      `id -u ${account} >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin ${account}`,
      ...directoryCommands(slug, true, deploymentAccount(config.server)),
    ].join(" && "),
  );

  step("systemd unit");
  if (executor.simulated) {
    say(`   [dry-run] read /etc/systemd/system/${slug}.service, install it if missing`);
    return;
  }

  const path = `/etc/systemd/system/${slug}.service`;
  const reading = await readRemoteFile(config, executor, path);
  if (reading.kind === "unreadable") {
    die(`cannot tell whether ${path} is there`, [
      "the server answered neither an absence nor a unit file",
      "nothing was installed: a unit is never replaced on a reading that failed",
    ]);
  }

  switch (
    decideUnit({
      installed: reading.kind === "present" ? reading.content : "",
      generated: unit,
      replace,
    })
  ) {
    case "present":
      say(`   unchanged  ${path}`);
      return;
    case "diverged":
      say(`   differs    ${path}, left as it is`);
      say("   it may carry a directive the manifest cannot express, such as one");
      say("   deliberately left out. Read it, then re-run with --force to switch");
      say("   to the generated one. Until then the service keeps this unit, so a");
      say("   changed port, memory or env in the manifest has no effect yet.");
      return;
  }

  say("");
  say(`--- ${slug}.service ---`);
  say(unit);

  step("install the unit");
  await depositText(executor, config, unit, path, "root:root", "644");
  await executor.ssh(config, `sudo systemctl daemon-reload && sudo systemctl enable ${slug}`);
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
  say("");
  say(`--- ${slug}.service ---`);
  say(generateUnit(manifest));
  if (fragment !== null) {
    say(`--- ${slug}.caddy ---`);
    say(fragment);
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
for folder in /srv/sites/*/; do
  slug=$(basename "$folder")
  size=$(du -sh "$folder" 2>/dev/null | cut -f1)
  # A static site has no unit, and the landing's one does not carry the name of
  # its folder: showing "inactive" in those two cases would suggest a service
  # that is down. LoadState tells a missing unit from a stopped one.
  if [ "$(systemctl show "$slug" -p LoadState --value 2>/dev/null)" = loaded ]; then
    service=$(systemctl is-active "$slug" 2>/dev/null || true)
  else
    service="-"
  fi
  current_bytes=$(systemctl show "$slug" -p MemoryCurrent --value 2>/dev/null)
  case "$current_bytes" in
    ""|"[not set]") memory="-" ;;
    *) memory="$((current_bytes / 1048576))MB" ;;
  esac
  # The peak since the last start, which systemd keeps itself. It is the only way
  # to read a MemoryMax decision back: the current value says nothing of the
  # moment when the service consumed the most, and sampling from the outside
  # misses the short spikes. It resets to zero on every restart, so a figure
  # taken just after a deployment measures nothing.
  peak_bytes=$(systemctl show "$slug" -p MemoryPeak --value 2>/dev/null)
  case "$peak_bytes" in
    ""|"[not set]") peak="-" ;;
    *) peak="$((peak_bytes / 1048576))MB" ;;
  esac
  # The ceiling in service, and not the manifest's one: it is the unit set on the
  # machine that decides, and a manifest changed without deploy --force does not change it.
  # The three columns together are what makes the decision readable again.
  cap_bytes=$(systemctl show "$slug" -p MemoryMax --value 2>/dev/null)
  case "$cap_bytes" in
    ""|"[not set]"|infinity) cap="-" ;;
    *) cap="$((cap_bytes / 1048576))MB" ;;
  esac
  printf "%-22s %-8s %-10s %-8s %-8s %s\n" "$slug" "$size" "$service" "$memory" "$peak" "$cap"
done

echo
echo "=== ports listening on loopback ==="
ss -ltn 2>/dev/null | grep 127.0.0.1 | awk '{print $4}' | sort -u

echo
echo "=== memory ==="
free -m | head -2
`;
  const output = await executor.read(config, script);
  say(output.trimEnd());
}

async function logs(
  project: Project,
  config: Config,
  follow: boolean,
  executor: Executor,
): Promise<void> {
  const slug = project.manifest.slug;
  await executor.run([
    "ssh",
    ...(follow ? ["-t"] : []),
    config.server,
    `journalctl -u ${slug} -n 50 --no-pager${follow ? " -f" : ""}`,
  ]);
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
    `  ${join(REPO_ROOT, "bin", "dashboard-password.sh")}`,
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
    { cwd: project.folder, stdout: "inherit", stderr: "inherit", stdin: "inherit" },
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
 * The preview lock, from the project's folder.
 *
 * The gesture belongs to bin/lock.sh and stays there: it sets a code, writes
 * the manifest, generates the fragment, validates it, reloads Caddy and
 * measures the result over HTTP, with a restore on every failure. Rewriting it
 * here would make two paths to the same configuration in service, and that is
 * exactly what the disappearance of site.json has just corrected. The CLI
 * therefore only launches it, as it already launches deploy-caddy.sh.
 *
 * `SITESOLIDE_PROJECT_DIR` tells it where the project lives. Without it, the
 * script infers the folder from the slug, which assumes that the folder carries
 * its name: true in the sites repository, false for a project deployed from
 * somewhere else, and that is precisely what the CLI exists to allow.
 */
async function lockPreview(
  project: Project,
  config: Config,
  executor: Executor,
  subcommand: "enable" | "code" | "disable" | "state",
): Promise<void> {
  const slug = project.manifest.slug;
  await executor.run([join(REPO_ROOT, "bin", "lock.sh"), subcommand, slug], {
    env: { SITESOLIDE_SERVER: config.server, SITESOLIDE_PROJECT_DIR: project.folder },
  });
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
  await executor.run([join(REPO_ROOT, "bin", "generate-domains.sh")], {
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
 * gatekeeper must not change it in the meantime. bin/lock.sh and
 * bin/deploy-caddy.sh receive it through CADDY_LOCK_HELD.
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

  say(`-> removing ${slug}, ${isApplication ? "service" : "static"}`);
  say("   this deletes the served directory and its data. The VM has no backup.");

  // Before the read of the door, which decides the order of the gestures.
  await takeCaddyLock(config, executor, "nothing was removed");

  // The block of a site closed from the dashboard may exist only on the VM: a
  // static site has none in the repository, and deploy-caddy.sh never deletes
  // an orphan. Only the deposited manifest says that it must be removed too.
  // Read before any gesture: an unreadable read would leave that block behind
  // an erased site, and nothing would say so any more.
  const deposited = await readDepositedDoor(slug, config, executor);
  if (deposited.kind === "unreadable") {
    die(`cannot tell whether ${slug} is behind the portal on the server`, [
      `${depositedManifestPath(slug)}: ${deposited.reason}`,
      "nothing was removed: a Caddy block set from the dashboard could be left behind",
    ]);
  }

  // The lock before anything else: bin/lock.sh rewrites the manifest and the
  // fragment, and it needs both. Once the folder is deleted, its code would
  // stay set on the VM with nothing to remove it.
  if (manifest.lock === true) {
    step("preview lock");
    await executor.run([join(REPO_ROOT, "bin", "lock.sh"), "disable", slug], {
      env: { ...envUnderLock(config), SITESOLIDE_PROJECT_DIR: project.folder },
    });
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
    { slug, isApplication, secrets: manifest.secrets ?? [] },
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
      await executor.run([join(REPO_ROOT, "bin", "deploy-caddy.sh")], {
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
    await executor.run([join(REPO_ROOT, "bin", "generate-domains.sh")], {
      env: envUnderLock(config),
    });
  }

  releaseCaddyLock();
  if (executor.simulated) {
    say("-> dry run, nothing was removed");
    return;
  }

  say("");
  say("-> gone from the machine. What is left, and this command will not do it:");
  for (const line of leftToDo(slug, project.folder)) say(`   ${line}`);
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

  const config: Record<string, string> = {
    server: ask("server", "SSH target, user@host:", previous.server),
    zone: ask("zone", "DNS zone served, e.g. example.com:", previous.zone),
    email: ask("email", "Contact address for the certificate authority:", previous.email),
  };

  // The paths are written only if they are given or already set: a file that
  // stays silent about them lets the repository's defaults play, and therefore
  // never lies. The flag and the key carry the same name, so that what is typed
  // is what lands in the file.
  for (const key of ["contact", "vault", "sites"] as const) {
    const given = value(key) ?? previous[key];
    if (given !== undefined && given !== "") config[key] = given;
  }

  const path = configPath();
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`written: ${path}`);
  for (const [key, given] of Object.entries(config)) console.log(`  ${key}: ${given}`);
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0] ?? "";
  const dryRun = arguments_.includes("--dry-run");
  const replace = arguments_.includes("--force");
  const executor = new Executor(dryRun);
  const folder = process.cwd();

  // `init` writes the configuration: reading it first would refuse it for being
  // missing, and there would then be no way to set it.
  if (command === "init") {
    await initialise(arguments_);
    process.exit(0);
  }

  const config = await (async () => {
    try {
      return await readConfig();
    } catch (error) {
      if (error instanceof IncompleteConfig) {
        die(`missing settings: ${error.missing.join(", ")}`, [
          "run: sitesolide init",
          `it writes ${configPath()}, which says which machine to serve and under which zone`,
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
      await deploy(readProject(folder), config, executor, replace);
      break;
    case "status":
      await showStatus(config, executor);
      break;
    case "logs":
      await logs(readProject(folder), config, arguments_.includes("--follow"), executor);
      break;
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
      console.error(
        [
          "usage:",
          "  sitesolide init                 write ~/.config/sitesolide/config.json",
          "     --server <user@host> --zone <dns.zone> --email <you@example.com>",
          "     --contact <you@example.com>   shown on a locked preview's door",
          "  sitesolide deploy               prepare, build, push, install, restart, verify",
          "     --dry-run                    show the unit and the fragment, install nothing",
          "     --force                      switch a hand-written unit to the generated one",
          "  sitesolide status               what the server actually runs",
          "  sitesolide logs [--follow]      journalctl for this project",
          "  sitesolide lock   [--dry-run]   close the preview behind a code, or show it",
          "     --status                     wanted / installed / measured, without touching",
          "     --new-code                   replace the code in force by a fresh one",
          "  sitesolide unlock [--dry-run]   reopen the preview and drop its code",
          "  sitesolide domain               where this project's own domain stands",
          "     --activate [--force]         switch the site onto it, then rebuild the table",
          "     --deactivate                 back to the preview subdomain",
          "  sitesolide remove --confirm <slug>",
          "                                  take the project off the machine, for good",
          "     --dry-run                    show every step, remove nothing",
          "  sitesolide run -- <command>     load the secret from the vault and run",
          "",
          `secrets live on the server: manage them in the Secrets section of ${dashboardAddress(config.zone)}`,
          "the portal of a deployed site is set from the dashboard too: deploy follows the server",
        ].join("\n"),
      );
      process.exit(1);
  }
}
