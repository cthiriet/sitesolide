/**
 * The backup commands of a project's services, run just before its copy.
 *
 * A service that keeps a server database in the data, PostgreSQL in
 * `data/postgres` for one, cannot be saved by copying its files while it
 * writes: the snapshot would report success and restore a cluster that does
 * not start, or starts corrupt. Its manifest declares instead, under the
 * service's `backup`, the folder it keeps live and a command that leaves a
 * consistent copy of it in `$BACKUP_DIR`, `pg_basebackup` for PostgreSQL. The
 * archive then holds that copy under `data/<folder>`, never the live files
 * (copy.ts).
 *
 * Each command runs in a transient unit of its own (runner.ts), as the
 * project's account, in the walls of its service: the same identity, the
 * same `app/`, `public/` and `data/`, the same working directory, its
 * service's environment as the unit sets it (bin/cli/unit.ts), its secrets
 * read by PID 1 from `/etc/sitesolide`, never on a command line, and the
 * loopback alone, to reach its service on its port. The machine's loopback
 * rule lets a project's account reach its own ports and nobody else's
 * (bin/cli/loopback.ts, reachesOwnPorts).
 *
 * `BACKUP_DIR` is a folder of the copy's own staging, under
 * `/var/cache/sitesolide-backup/<folder>/hooks/`, the unit's CacheDirectory:
 * on disk rather than in memory, 0700, the project's, outside the data the
 * snapshot reads. The command finds it empty: its own run empties it first,
 * whatever an earlier one left. Once the snapshot is over, taken or not, a
 * child of the project's removes it (discardHooks), root never opening a
 * project's file; within DISCARD_TIMEOUT_MS, and at best: what that removal
 * leaves, the next run's command empties before it starts, and the next run
 * removes even for a project that no longer declares a command.
 *
 * Bounded like the copy: the command shares the project's time with it
 * (projectTime, run.ts), has its service's memory ceiling and room for the
 * program that runs it, and is stopped when the disk comes down to its
 * reserve. A command that fails, runs out of its time or leaves nothing
 * fails that project's snapshot, loudly: the details to the journal, a
 * message of this module's to the status file, which anyone may read.
 *
 * **The verdict is the exit code, and nothing else.** The command is the
 * project's code, shares the hook mode's account, and may print anything,
 * a line shaped like the hook mode's own report included: the parent acts on
 * the hook mode's exit code alone (HOOK_EXIT, child.ts), and what was printed
 * goes to the journal.
 */
import { existsSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  commandErrors,
  commandWords,
  foldersOverlap,
  isDataFolder,
  isValidEnvName,
  isValidEnvValue,
  isValidMemory,
  isValidSecretName,
  isValidServiceName,
  isValidSlug,
  servicesOf,
  type ServiceView,
} from "../../borrowed/manifest";
import { HOOK_EXIT } from "./child";
import { declaredVariables, secretPath, treeVariables } from "../../borrowed/unit";
import { label } from "../secrets/scope";
import type { BackupConfig } from "./config";
import type { LiveFolder } from "./copy";
import type { Project } from "./projects";
import { startChild, within, type ChildReport, type Job } from "./runner";

/** One service's backup command, judged, with the folder it fills. */
export type Hook = {
  service: ServiceView;
  /** The live folder, relative to the data. */
  folder: string;
  /** The command's words, as systemd reads `start`. */
  words: string[];
  /** Where it leaves its copy: its `BACKUP_DIR`. */
  backupDir: string;
};

export type HookFailure = { ok: false; error: string; cause: "timeout" | null };

/** Where the commands of a project leave their copies, inside its copy's staging folder. */
export function hooksFolder(stagingPath: string): string {
  return join(stagingPath, "hooks");
}

/** How the status file names a command: by its service, never by anything of the data. */
function commandOf(service: ServiceView): string {
  return service.name === null ? "the backup command" : `the backup command of service ${service.name}`;
}

/**
 * The project's backup commands, judged again here: the manifest on the
 * machine is read as it is (projects.ts), and what goes into a unit is
 * checked first, as unit.ts checks what it writes. A command that does not
 * pass fails the snapshot rather than being run, or skipped in silence.
 */
export function projectHooks(project: Project, stagingPath: string): { hooks: Hook[] } | { error: string } {
  const manifest = project.manifest;
  if (manifest === null) return { hooks: [] };
  const declared = servicesOf(manifest).filter((service) => service.backup !== null);
  if (declared.length === 0) return { hooks: [] };
  // Its units, its paths and its account are the folder's: a manifest naming
  // another slug would have the command run with another project's tree.
  if (manifest.slug !== label(project.folder) || !isValidSlug(manifest.slug)) return { error: "its sitesolide.json names another slug, so its backup commands cannot be run safely" };
  const hooksAt = hooksFolder(stagingPath);
  const invalid = (service: ServiceView) => ({
    error: `${commandOf(service)} in sitesolide.json is not valid: fix it and deploy again, see docs/manifest.md`,
  });
  for (const secret of manifest.secrets ?? []) {
    if (!isValidSecretName(secret)) return { error: "a secret file named in its sitesolide.json is not valid: fix it and deploy again" };
  }
  const hooks: Hook[] = [];
  for (const service of declared) {
    // The service's name becomes a folder's name, which the hook mode
    // empties: a name that passed no validation, `..` for one, would have it
    // empty the data instead. The CLI's rule, then the path itself.
    if (service.name !== null && !isValidServiceName(service.name)) return invalid(service);
    const backupDir = join(hooksAt, service.unit);
    if (dirname(backupDir) !== hooksAt || service.unit === "." || service.unit === "..") return invalid(service);
    const { folder, command } = service.backup as { folder: unknown; command: unknown };
    if (!isDataFolder(folder) || typeof command !== "string" || commandErrors(command, "command").length > 0) return invalid(service);
    const words = commandWords(command);
    if (words === null || !isValidMemory(service.memory)) return invalid(service);
    for (const [name, value] of Object.entries(service.env)) {
      if (!isValidEnvName(name) || !isValidEnvValue(value)) return invalid(service);
    }
    if (hooks.some((other) => foldersOverlap(other.folder, folder))) return invalid(service);
    hooks.push({ service, folder, words, backupDir });
  }
  return { hooks };
}

/** The live folders a copy is given: each with its command's copy, or as files when the services are stopped. */
export function liveFolders(hooks: readonly Hook[], stopped: boolean): LiveFolder[] {
  return hooks.map((hook) => ({ folder: hook.folder, source: stopped ? null : hook.backupDir }));
}

/**
 * A command's unit: its service's walls, environment and secrets, the
 * loopback, the copy's CacheDirectory for its folder. `timeoutMs` is the
 * unit's RuntimeMaxSec; the command itself is given a little less, so that
 * running out of time is said rather than cut.
 */
export function hookJob(config: BackupConfig, project: Project, hook: Hook, timeoutMs: number, cacheDirectory: string | null): Job {
  const manifest = project.manifest!;
  const root = join(config.sitesDir, project.folder);
  const placeholders = { slug: manifest.slug, zone: config.zone, contact: config.contact };
  return {
    mode: "hook",
    folder: project.folder,
    account: project.account,
    uid: project.owner?.uid ?? null,
    // The expected uid as an argument: the environment of this unit is the
    // project's to set, its secret files included (child.ts, hookMain).
    args: [project.owner === null ? "-" : String(project.owner.uid), hook.backupDir, String(Math.max(1000, timeoutMs - HOOK_GRACE_MS)), ...hook.words],
    readWrite: [project.dataDir],
    bind: [project.dataDir],
    bindReadOnly: [join(root, "app"), join(root, "public")],
    cacheDirectory,
    stdin: null,
    stdout: "ignore",
    timeoutMs,
    loopback: true,
    // BACKUP_DIR last, over any `env` of that name: the folder is the component's.
    environment: [...treeVariables(manifest, hook.service, config.sitesDir), ...declaredVariables(hook.service, placeholders), ["BACKUP_DIR", hook.backupDir]],
    // The dash, as in the unit: a file not created yet leaves the variable
    // unset, and the command says what it misses.
    environmentFiles: (manifest.secrets ?? []).map((secret) => `-${secretPath(secret)}`),
    workingDirectory: join(root, "app"),
    memory: hookMemory(hook.service.memory),
  };
}

/**
 * What the program running the command takes on top of it: Bun, which reads
 * its output, about 50 MiB resident, measured on 8 October 2026 with Bun
 * 1.3.11, and a margin.
 */
export const HOOK_RUNNER_MEMORY = 128 * 1024 * 1024;

/** The command's memory ceiling: its service's, and room for the program that runs it. */
export function hookMemory(memory: string): string {
  const units: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
  const bytes = Number(memory.slice(0, -1)) * units[memory.slice(-1)]!;
  return `${Math.ceil((bytes + HOOK_RUNNER_MEMORY) / 1024 ** 2)}M`;
}

/** What the command is given less than its unit, to say it ran out of time before its unit is stopped. */
export const HOOK_GRACE_MS = 5000;

/** How often the disk is measured while a command writes its copy. */
const DISK_EVERY_MS = 1000;

/** How long a command that ran out of time is still listened to, for the journal's sake. */
const REPORT_GRACE_MS = 2000;

/**
 * How long the removal of the commands' copies may take. It runs once the
 * project's time is over, and the project's service, which shares its
 * account, may stop it: short, then, the cost to every project after it
 * bounded, and what it does not finish is the next run's to remove.
 */
export const DISCARD_TIMEOUT_MS = 15 * 1000;

/** The bytes free on the disk holding `path`, or on its nearest parent that exists. */
function freeOn(path: string): number {
  let current = path;
  for (;;) {
    try {
      const stat = statfsSync(current);
      return Number(stat.bavail) * Number(stat.bsize);
    } catch (error) {
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * Runs the commands one after the other, each within what is left of the
 * project's time, until `deadline`, a time of `Date.now()`. The disk of the
 * repository and the disk of the staging are measured every second: a command
 * that brings either down to the reserve is stopped.
 */
export async function runHooks(
  config: BackupConfig,
  project: Project,
  hooks: readonly Hook[],
  deadline: number,
  cacheDirectory: string | null,
  log: (line: string) => void,
): Promise<{ ok: true } | HookFailure> {
  for (const hook of hooks) {
    const what = commandOf(hook.service);
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, error: `${what} did not finish in its time, see the journal of sitesolide-backup`, cause: "timeout" };
    const child = startChild(hookJob(config, project, hook, left, cacheDirectory), config);
    let finished: { value: { code: number; report: ChildReport } } | null = null;
    let stopped: string | null = null;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      finished = await within(child.result, Math.min(DISK_EVERY_MS, remaining));
      if (finished !== null) break;
      if (freeOn(config.repository) < config.reserveBytes || freeOn(hook.backupDir) < config.reserveBytes) {
        stopped = "stopped: the disk was about to fill";
        break;
      }
    }
    if (finished === null) {
      child.stop();
      const late = await within(child.result, REPORT_GRACE_MS);
      const tail = late === null || late.value.report.tail === "" ? "" : `: ${late.value.report.tail}`;
      if (stopped !== null) {
        log(`backup ${project.folder}: ${what} was stopped, the disk came down to its reserve of ${config.reserveBytes} bytes${tail}`);
        return { ok: false, error: stopped, cause: null };
      }
      log(`backup ${project.folder}: ${what} did not finish within its time, it was stopped${tail}`);
      return { ok: false, error: `${what} did not finish in its time, see the journal of sitesolide-backup`, cause: "timeout" };
    }
    const { code, report } = finished.value;
    if (code === 0) {
      log(`backup ${project.folder}: ${what} left its copy of ${hook.folder}`);
      continue;
    }
    // What it printed is the project's: it reaches the journal, and only the
    // exit code turns into what the status file says.
    log(
      `backup ${project.folder}: ${what} failed, exit code ${code}${report.error === null ? "" : `, ${report.error}`}${report.detail === null ? "" : `, ${report.detail}`}${report.tail === "" ? "" : `: ${report.tail}`}`,
    );
    switch (code) {
      case HOOK_EXIT.timeout:
        return { ok: false, error: `${what} did not finish in its time, see the journal of sitesolide-backup`, cause: "timeout" };
      case HOOK_EXIT.empty:
        return { ok: false, error: `${what} left nothing in BACKUP_DIR, see docs/manifest.md`, cause: null };
      case HOOK_EXIT.start:
        return { ok: false, error: `${what} could not be started, see the journal of sitesolide-backup`, cause: null };
      case HOOK_EXIT.prepare:
        return { ok: false, error: `${what} could not have its BACKUP_DIR emptied, see the journal of sitesolide-backup`, cause: null };
      default:
        return { ok: false, error: `${what} failed, see the journal of sitesolide-backup`, cause: null };
    }
  }
  return { ok: true };
}

/** The removal's unit: the project's account, its staging folder, nothing of /srv, no network. */
export function discardJob(project: Project, stagingPath: string, cacheDirectory: string | null): Job {
  return {
    mode: "discard",
    folder: project.folder,
    account: project.account,
    uid: project.owner?.uid ?? null,
    args: [hooksFolder(stagingPath)],
    readWrite: [],
    bind: [],
    cacheDirectory,
    stdin: null,
    stdout: "ignore",
    timeoutMs: DISCARD_TIMEOUT_MS,
  };
}

/**
 * Removes what the commands left, as the project, once the snapshot is over,
 * taken or not, or what an earlier run left: at best, within
 * DISCARD_TIMEOUT_MS, outside the project's time. A removal that fails or
 * runs out of time is said in the journal; the next run tries again, and its
 * commands empty their folders first in any case.
 */
export async function discardHooks(config: BackupConfig, project: Project, stagingPath: string, cacheDirectory: string | null, log: (line: string) => void): Promise<void> {
  const job = discardJob(project, stagingPath, cacheDirectory);
  try {
    const child = startChild(job, config);
    const finished = await within(child.result, DISCARD_TIMEOUT_MS + REPORT_GRACE_MS);
    if (finished === null) {
      child.stop();
      log(`backup ${project.folder}: the backup commands' copies were not removed in time`);
    } else if (finished.value.code !== 0) {
      log(`backup ${project.folder}: the backup commands' copies were not removed, exit code ${finished.value.code}${finished.value.report.tail === "" ? "" : `: ${finished.value.report.tail}`}`);
    }
  } catch (error) {
    log(`backup ${project.folder}: the backup commands' copies were not removed (${(error as Error).message})`);
  }
}
