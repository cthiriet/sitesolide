/**
 * Every call to restic, the program that stores the snapshots: the local
 * repository, `/var/backups/sitesolide-restic`, and the bucket's, if one is
 * configured. Root runs it, in the run's unit or the restore's; nothing of a
 * project's runs it, and no project's child sees its key.
 *
 * **Its environment is built from nothing.** Each call gets the variables it
 * needs and no other: the zone fixed to UTC (restic reads `--time` in the
 * local zone, measured on 0.18.1), the CPUs and the memory it may use, its
 * cache and temporary files on disk, and the repository with its password.
 * The bucket's credentials reach only the calls that talk to the bucket: a
 * backup, whose command restic starts with its own environment, never holds
 * one.
 *
 * **Bounded in memory and time.** Measured on 8 October 2026 with Debian's
 * 0.18.0 on two CPUs: 57 MiB for a listing up to 174 MiB for a copy to S3,
 * and the peaks grow with the CPUs Go may use. `GOMAXPROCS=2` and
 * `GOMEMLIMIT` keep it there, two connections per backend bound its parallel
 * packs, and under systemd it runs through `choom`, so that if the unit's
 * memory runs out the kernel kills restic, whose step fails and says so,
 * rather than the process that writes the status (the units' OOMPolicy is
 * `continue`). Every call has a deadline: past it, SIGTERM, which restic
 * answers by removing its lock and saving nothing, then SIGKILL.
 *
 * **What it says stays in the journal.** restic's messages may quote a
 * repository's paths or a pack's id: the status file and the page get the
 * fixed sentences of `resticFailure`, chosen by its exit code, never its text.
 *
 * Exit codes, from its documentation (075_scripting): 0 done, 1 failed, 3 a
 * backup could not read all its sources, 10 no repository, 11 the repository
 * is locked, 12 wrong password, 130 interrupted; any other is a failure.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { isBackupFolder, snapshotName, type SnapshotKind } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import { boundedText, within } from "./runner";

export type Repository = {
  /** What restic is told: a folder, or `s3:https://<endpoint>/<bucket>/<path>`. */
  url: string;
  /** Read from a file, the local repository's; handed in the environment, the bucket's. */
  password: { file: string } | { value: string };
  /** The variables of its backend: the bucket's credentials, nothing for a folder. */
  backend: Record<string, string>;
  /** `local` or `offsite`: which sentences a failure gets. */
  store: "local" | "offsite";
};

/** The host every snapshot records: a constant, so that no machine's name enters a repository, and nothing filters on it. */
export const SNAPSHOT_HOST = "sitesolide";

/** What restic may use: two CPUs, a soft memory ceiling, two connections per backend. */
export const RESTIC_PROCS = "2";
export const RESTIC_MEMORY = "128MiB";
export const RESTIC_CONNECTIONS = 2;
/** restic's `oom_score_adj`: the first process the kernel kills in the unit. */
export const RESTIC_OOM_SCORE = 1000;
/** Between SIGTERM, which lets restic remove its lock, and SIGKILL. */
export const RESTIC_STOP_GRACE_MS = 10_000;
/** What is read of restic's standard output when it is a document: a listing of thousands of snapshots stays far below. */
export const MAX_RESTIC_OUTPUT = 64 * 1024 * 1024;

export const KINDS: readonly SnapshotKind[] = ["scheduled", "pre-restore"];

/** What a call needs of the configuration: a download child, which has no BackupConfig, builds its own. */
export type ResticSettings = Pick<BackupConfig, "restic" | "choom" | "isolation" | "resticCache"> & {
  /** Where restic writes its temporary packs: `<cache>/tmp` unless said. */
  temporary?: string;
};

export function localRepository(config: Pick<BackupConfig, "repository" | "repositoryKey">): Repository {
  return { url: config.repository, password: { file: config.repositoryKey }, backend: {}, store: "local" };
}

/** The temporary files restic writes packs into before storing them: on disk, never on a tmpfs charged to the unit's memory. */
export function resticTemporary(config: Pick<ResticSettings, "resticCache" | "temporary">): string {
  return config.temporary ?? join(config.resticCache, "tmp");
}

/**
 * The whole environment of one call. `from`: the repository a copy reads, or
 * an initialisation takes its chunker parameters from, always the local one.
 */
export function resticEnvironment(config: Pick<ResticSettings, "resticCache" | "temporary">, repository: Repository, from: Repository | null = null): Record<string, string> {
  const password = (prefix: string, of: Repository): Record<string, string> =>
    "file" in of.password ? { [`${prefix}PASSWORD_FILE`]: of.password.file } : { [`${prefix}PASSWORD`]: of.password.value };
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TZ: "UTC",
    GOMAXPROCS: RESTIC_PROCS,
    GOMEMLIMIT: RESTIC_MEMORY,
    RESTIC_CACHE_DIR: config.resticCache,
    TMPDIR: resticTemporary(config),
    RESTIC_REPOSITORY: repository.url,
    ...password("RESTIC_", repository),
    ...repository.backend,
    ...(from === null ? {} : { RESTIC_FROM_REPOSITORY: from.url, ...password("RESTIC_FROM_", from) }),
  };
}

/** The command line of one call: restic and its bounds, through `choom` under systemd. */
export function resticCommand(config: Pick<ResticSettings, "restic" | "choom" | "isolation">, args: readonly string[]): string[] {
  const own = [config.restic, "-o", `local.connections=${RESTIC_CONNECTIONS}`, "-o", `s3.connections=${RESTIC_CONNECTIONS}`, ...args];
  return config.isolation === "systemd" ? [config.choom, "-n", String(RESTIC_OOM_SCORE), "--", ...own] : own;
}

export type ResticResult = {
  /** The exit code; null when the call was stopped at its deadline. */
  code: number | null;
  /** Its standard output, when it was read as a document. */
  stdout: string;
  /** The last of its standard error, the lines of a command it ran included. */
  stderr: string;
};

export type ResticCall = {
  /** Its standard output as a stream, when the caller takes it (a dump). */
  stdout: ReadableStream<Uint8Array> | null;
  result: Promise<ResticResult>;
  /** SIGTERM now, SIGKILL after the grace: restic removes its lock on the first. */
  stop: () => void;
};

/** A stream read whole as text, refused past `max` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("restic's output is larger than expected");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Bun.concatArrayBuffers(chunks, Infinity, true));
}

export type CallOptions = {
  from?: Repository | null;
  /**
   * Variables added to that call's environment: with no isolation, on the
   * workstation, a command restic runs is its own child and takes its
   * environment, a download child its bucket's settings with it. Under
   * systemd, PID 1 hands a child its file and this stays empty.
   */
  extra?: Record<string, string>;
  /** `document`: read whole, for a listing; `stream`: handed to the caller, for a dump; `ignore`. */
  stdout?: "document" | "stream" | "ignore";
};

export function startRestic(config: ResticSettings, repository: Repository, args: readonly string[], options: CallOptions = {}): ResticCall {
  const mode = options.stdout ?? "document";
  // Where restic writes its packs before storing them: a run empties it, any call may need it.
  mkdirSync(resticTemporary(config), { recursive: true, mode: 0o700 });
  const process: Subprocess<"ignore", "pipe" | "ignore", "pipe"> = Bun.spawn(resticCommand(config, args), {
    // Never a terminal: a restic that found no password would wait on a prompt forever.
    stdin: "ignore",
    stdout: mode === "ignore" ? "ignore" : "pipe",
    stderr: "pipe",
    env: { ...(options.extra ?? {}), ...resticEnvironment(config, repository, options.from ?? null) },
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill("SIGTERM");
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, RESTIC_STOP_GRACE_MS).unref();
  };
  const stdout = mode === "stream" ? (process.stdout as ReadableStream<Uint8Array>) : null;
  const result = (async (): Promise<ResticResult> => {
    const [out, err, code] = await Promise.all([
      mode === "document" ? readAll(process.stdout as ReadableStream<Uint8Array>, MAX_RESTIC_OUTPUT).catch(() => "") : Promise.resolve(""),
      boundedText(process.stderr as ReadableStream<Uint8Array>),
      process.exited,
    ]);
    return { code: stopped && code !== 0 ? null : code, stdout: out, stderr: err };
  })();
  return { stdout, result, stop };
}

/** One call, waited for until `deadline`, a time of `Date.now()`, and stopped past it. */
export async function runRestic(config: ResticSettings, repository: Repository, args: readonly string[], deadline: number, options: CallOptions = {}): Promise<ResticResult> {
  const call = startRestic(config, repository, args, options);
  const finished = await within(call.result, deadline - Date.now());
  if (finished !== null) return finished.value;
  call.stop();
  const late = await within(call.result, RESTIC_STOP_GRACE_MS + 2000);
  return { code: null, stdout: "", stderr: late?.value.stderr ?? "" };
}

/**
 * What the status file and the page say of a failed call: a fixed sentence,
 * chosen by the exit code and the repository, never restic's own words.
 */
export function resticFailure(result: Pick<ResticResult, "code">, repository: Pick<Repository, "store">): string {
  const offsite = repository.store === "offsite";
  switch (result.code) {
    case null:
      return "restic did not finish in time, see the journal of sitesolide-backup";
    case 10:
      return offsite ? "the bucket's repository does not exist, see the journal of sitesolide-backup" : "the server's repository does not exist: run bin/deploy-backup.sh install";
    case 11:
      return "the repository is locked by another restic process, see the journal of sitesolide-backup";
    case 12:
      return offsite
        ? "the bucket's repository does not open with BACKUP_ENCRYPTION_PASSPHRASE: it was changed since the repository was created, see the Backups README"
        : "the server's repository does not open with its key file, see the journal of sitesolide-backup";
    case 130:
      return "restic was interrupted, see the journal of sitesolide-backup";
    default:
      return `restic failed (exit code ${result.code}), see the journal of sitesolide-backup`;
  }
}

/** The journal's line for a call that failed: its words, the last of them, for root's eyes only. */
export function resticJournal(what: string, result: ResticResult): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tail = lines.slice(-4).join(" | ");
  return `${what}: ${result.code === null ? "stopped at its deadline" : `exit code ${result.code}`}${tail === "" ? "" : `: ${tail}`}`;
}

// --- What a backup's command says through restic -------------------------------

/**
 * restic forwards the standard error of the command it runs, each line
 * prefixed `subprocess <program>: `, through a scanner of 64 KiB per line: a
 * longer line ends all forwarding, silently, and the backup still succeeds
 * (measured on 0.18.0 and 0.18.1). The copy's report therefore keeps every
 * line short (child.ts), and its full summary travels in the archive's
 * description, which the read back parses (snapshot.ts).
 */
const SUBPROCESS = /^subprocess [^:\s]{1,64}: /;

/** The lines the command wrote, its prefix removed: what readReport reads. */
export function commandLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => SUBPROCESS.test(line))
    .map((line) => line.replace(SUBPROCESS, ""))
    .join("\n");
}

/** restic's own lines, for the journal. */
export function resticLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !SUBPROCESS.test(line))
    .join("\n");
}

/**
 * Whether a backup that failed did so because the command it ran failed, the
 * copy's unit killed for one, rather than restic itself: restic says
 * `command failed` in its last message then (measured on 0.18.0 and 0.18.1).
 */
export function commandFailed(stderr: string): boolean {
  return resticLines(stderr)
    .split("\n")
    .some((line) => /command failed/.test(line));
}

/** How a call watched by `watchCall` ended. */
export type Watched = { ended: ResticResult } | { stopped: "deadline" | "disk"; late: ResticResult | null };

/** How often, while restic writes, the free space is measured again. */
export const DISK_EVERY_MS = 1000;

/**
 * A call that writes into a repository, waited for until `deadline`, a time
 * of `Date.now()`, with the disk measured every second: past the deadline, or
 * once `diskLow` says the reserve is reached, `stopOthers` stops what restic
 * runs (a copy's unit, by name), then restic itself, which saves nothing once
 * stopped, unless it was finishing at that very instant: `late` says so.
 */
export async function watchCall(call: ResticCall, deadline: number, diskLow: () => boolean, stopOthers: () => void = () => undefined): Promise<Watched> {
  let stopped: "deadline" | "disk" = "deadline";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const finished = await within(call.result, Math.min(DISK_EVERY_MS, remaining));
    if (finished !== null) return { ended: finished.value };
    if (diskLow()) {
      stopped = "disk";
      break;
    }
  }
  stopOthers();
  call.stop();
  const late = await within(call.result, RESTIC_STOP_GRACE_MS + 2000);
  return { stopped, late: late?.value ?? null };
}

// --- Snapshots -------------------------------------------------------------------

/** One of our snapshots, as a repository holds it. */
export type Stored = {
  id: string;
  name: string;
  folder: string;
  takenAt: number;
  kind: SnapshotKind;
  /** The size of the tar it holds, and what it added to the repository when it was taken. */
  bytes: number | null;
  added: number | null;
};

/** `2026-10-04 13:00:00`: `--time` as restic reads it, in the zone the environment fixes to UTC. */
export function resticTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** The path a project's snapshots carry: one stable file per project, `restic dump --path /cms.tar latest /cms.tar` by hand. */
export function snapshotPath(folder: string): string {
  return `/${folder}.tar`;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * One snapshot of `restic snapshots --json` read back, or null if it is not
 * one of ours: a single path `/<folder>.tar`, a single tag naming its kind,
 * the host every snapshot of this component records, a time to the second.
 * One made by hand is never ours, and never forgotten.
 */
export function readStored(value: unknown): Stored | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[0-9a-f]{64}$/.test(v.id)) return null;
  if (v.hostname !== SNAPSHOT_HOST) return null;
  if (!Array.isArray(v.paths) || v.paths.length !== 1 || typeof v.paths[0] !== "string") return null;
  const path = /^\/(.+)\.tar$/.exec(v.paths[0]);
  if (path === null || !isBackupFolder(path[1])) return null;
  if (!Array.isArray(v.tags) || v.tags.length !== 1 || !KINDS.includes(v.tags[0] as SnapshotKind)) return null;
  const takenAt = typeof v.time === "string" ? Date.parse(v.time) : Number.NaN;
  if (!Number.isFinite(takenAt) || takenAt % 1000 !== 0) return null;
  const folder = path[1]!;
  const kind = v.tags[0] as SnapshotKind;
  const summary = typeof v.summary === "object" && v.summary !== null ? (v.summary as Record<string, unknown>) : {};
  return { id: v.id, name: snapshotName(folder, takenAt, kind), folder, takenAt, kind, bytes: count(summary.total_bytes_processed), added: count(summary.data_added_packed) };
}

/** A whole listing read back: ours, newest first. Throws on a listing that does not read, which is never taken for an empty one. */
export function readListing(json: string): Stored[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error("restic's listing is not a list");
  return parsed
    .map(readStored)
    .filter((stored): stored is Stored => stored !== null)
    .sort((a, b) => b.takenAt - a.takenAt || (a.name < b.name ? 1 : -1));
}

export type Listed = { snapshots: Stored[] } | { failure: ResticResult };

/** A repository's snapshots, ours alone. */
/**
 * A repository's snapshots, ours alone. With `log`, a listing that finds the
 * repository locked removes the stale locks and is tried once more: a stale
 * exclusive lock, left by a prune or a check killed outright, refuses even a
 * listing, and would refuse it every hour after. A download child, which is
 * not root and could take a live root lock for a dead one, passes none.
 */
export async function listSnapshots(
  config: ResticSettings,
  repository: Repository,
  deadline: number,
  extra: readonly string[] = [],
  log: ((line: string) => void) | null = null,
): Promise<Listed> {
  const args = [...extra, "snapshots", "--json", "-q"];
  const result = log === null ? await runRestic(config, repository, args, deadline) : await runExclusive(config, repository, args, deadline, log);
  if (result.code !== 0) return { failure: result };
  try {
    return { snapshots: readListing(result.stdout) };
  } catch {
    return { failure: { ...result, code: 1, stderr: `${result.stderr}\nthe listing does not read` } };
  }
}

/** The arguments of a project's backup, the command to run following them. */
export function backupArguments(folder: string, kind: SnapshotKind, takenAt: number): string[] {
  return ["backup", "--json", "-q", "--host", SNAPSHOT_HOST, "--tag", kind, "--time", resticTime(takenAt), "--stdin-filename", `${folder}.tar`, "--stdin-from-command", "--"];
}

/** The summary a backup prints last on its standard output: the new snapshot's id, and its figures. */
export function readBackupSummary(stdout: string): { id: string; bytes: number | null; added: number | null } | null {
  for (const line of stdout.split("\n").reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const v = parsed as Record<string, unknown> | null;
    if (v?.message_type !== "summary") continue;
    if (typeof v.snapshot_id !== "string" || !/^[0-9a-f]{64}$/.test(v.snapshot_id)) return null;
    return { id: v.snapshot_id, bytes: count(v.total_bytes_processed), added: count(v.data_added_packed) };
  }
  return null;
}

/**
 * Removes a repository's stale locks: a restic killed by SIGKILL (the OOM
 * killer through choom, a reboot, the run's own deadline) leaves its own,
 * which blocks forget and prune (exit code 11), and a stale exclusive one
 * blocks everything. Without `--remove-all`, restic removes only stale ones:
 * a dead process of this host, or a lock older than 30 minutes. Called as
 * root, under the component's own lock, which every call to restic of this
 * machine runs under: no live lock of ours can be there; a person's, live,
 * stays. The server's repository is a folder: restic runs only if it holds
 * locks. The bucket's is asked every time.
 */
export async function clearStaleLocks(config: ResticSettings, repository: Repository, deadline: number, log: (line: string) => void): Promise<void> {
  if (repository.store === "local") {
    let names: string[];
    try {
      names = readdirSync(join(repository.url, "locks"));
    } catch {
      return;
    }
    if (names.length === 0) return;
  }
  const result = await runRestic(config, repository, ["unlock"], deadline);
  if (result.code !== 0) log(resticJournal(`backup: restic unlock on the ${repository.store} repository`, result));
}

/**
 * An exclusive call (forget, prune): when it finds a lock, the stale ones are
 * removed and it is tried once more. A person's live lock still refuses it.
 */
export async function runExclusive(
  config: ResticSettings,
  repository: Repository,
  args: readonly string[],
  deadline: number,
  log: (line: string) => void,
  options: CallOptions = {},
): Promise<ResticResult> {
  const first = await runRestic(config, repository, args, deadline, options);
  if (first.code !== 11) return first;
  const unlocked = await runRestic(config, repository, ["unlock"], deadline);
  if (unlocked.code !== 0) log(resticJournal(`backup: restic unlock on the ${repository.store} repository`, unlocked));
  return runRestic(config, repository, args, deadline, options);
}

/**
 * Forgets the snapshots a repository holds under a name: one a backup saved
 * although the run no longer wanted it, restic finishing as it was stopped,
 * or saving with a summary that did not read. Returns the ids it could not
 * forget, which the caller records to try again.
 */
export async function forgetByName(config: ResticSettings, repository: Repository, folder: string, name: string, deadline: number, log: (line: string) => void): Promise<string[]> {
  const listed = await listSnapshots(config, repository, deadline, [], log);
  if ("failure" in listed) {
    log(resticJournal(`backup ${folder}: restic snapshots, to forget ${name}`, listed.failure));
    return [];
  }
  const ids = listed.snapshots.filter((stored) => stored.folder === folder && stored.name === name).map((stored) => stored.id);
  const result = await forgetSnapshots(config, repository, ids, deadline, log);
  if (result === null || result.code === 0) return [];
  log(resticJournal(`backup ${folder}: restic forget of ${name}`, result));
  return ids;
}

/** Forgets snapshots by id, in one call: the decision is retention.ts's, restic only carries it out. */
export async function forgetSnapshots(config: ResticSettings, repository: Repository, ids: readonly string[], deadline: number, log: (line: string) => void): Promise<ResticResult | null> {
  if (ids.length === 0) return null;
  return runExclusive(config, repository, ["forget", "-q", ...ids], deadline, log);
}
