/**
 * How root has a project's data read or written without touching it itself:
 * this same script, in another mode, run by PID 1 as a transient unit under
 * the project's account, confined exactly like the project's own service.
 *
 *   systemd-run --wait --pipe --uid=site-cms ... -- bun backup.js copy /srv/sites/cms/data ...
 *
 * `--pipe` hands the unit this process's pipes as they are: the archive flows
 * from the copy's standard output straight into root's, and into the
 * extraction's standard input from root's file, with no copy through
 * systemd-run. `--wait` returns the unit's exit code.
 *
 * Why a transient unit rather than dropping privileges in place (`setpriv`,
 * `Bun.spawn({ uid })`):
 *
 * - the unit sees the machine the way the project's service sees it: `/srv`
 *   replaced by an empty mount with only its own data bound back in, the rest
 *   read-only, no network at all. Dropping the uid alone would leave the
 *   other projects' folders and the network as root's namespace has them;
 * - SQLite writes a database's `-shm` beside it: the data folder must be
 *   writable for the copy, and only for it. A root component whose unit made
 *   every project's data writable would hold far more than it needs;
 * - `Bun.spawn({ uid })` was measured on 4 October 2026 as a non-root user on
 *   macOS: the child ran under the parent's uid, silently. A drop of identity
 *   that fails without a word is not one to build on. PID 1, on the other hand,
 *   sets `User=` with its groups, or the unit does not start;
 * - this mirrors what the steward already does with the gatekeeper: a root
 *   component asks PID 1 for a unit whose limits it does not choose at run time.
 *
 * With `BACKUP_ISOLATION=none`, the workstation's tests run the same modes as
 * plain children of this process: the code that reads and writes the data is
 * the same, only the identity and the walls differ. The walls are checked by
 * tests/backup-runner.test.ts against bin/cli/unit.ts, and on the machine by
 * the commands of src/backup/README.md.
 */
import type { BackupConfig } from "./config";

export type ChildMode = "copy" | "extract";

export type Job = {
  mode: ChildMode;
  /** The project's folder under /srv/sites, and its account. */
  folder: string;
  account: string;
  /** The account's uid, checked by the child against its own; null with no isolation. */
  uid: number | null;
  args: string[];
  /** What the child may write. */
  readWrite: string[];
  /** What is mounted back into the empty /srv. */
  bind: string[];
  /** Under /var/cache, created by PID 1 for the account, where the copy stages its databases. */
  cacheDirectory: string | null;
  /** A file whose bytes go on standard input, or nothing. */
  stdin: string | null;
  /** The child's standard output: the archive, or nothing worth reading. */
  stdout: "pipe" | "ignore";
};

/** A memory ceiling for a copy or an extraction: Bun, SQLite's cache, one chunk at a time. */
export const CHILD_MEMORY = "512M";

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The unit's name: what it does, for whom, and a suffix so that a previous one
 * still being unloaded never collides. `--collect` unloads it even failed.
 */
export function unitName(job: Pick<Job, "mode" | "folder">, suffix: string = hex(4)): string {
  return `sitesolide-backup-${job.mode}-${job.folder}-${suffix}.service`;
}

/**
 * The confinement of a child, directive by directive. Every line of a
 * project's own unit that applies to a process with no network and no secret
 * is here (bin/cli/unit.ts), and the test holds them side by side.
 */
export function confinement(job: Job, timeoutMs: number): string[] {
  const properties = [
    "UMask=0077",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    ...job.readWrite.map((path) => `ReadWritePaths=${path}`),
    "TemporaryFileSystem=/srv:ro",
    ...job.bind.map((path) => `BindPaths=${path}`),
    // Neither the secrets nor the steward's state: nothing here needs them.
    "InaccessiblePaths=-/etc/sitesolide",
    "InaccessiblePaths=-/var/lib/sitesolide-steward",
    "InaccessiblePaths=-/var/backups",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictNamespaces=yes",
    "RestrictSUIDSGID=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    `MemoryMax=${CHILD_MEMORY}`,
    // Reading and writing data, never the network, not even the loopback: a
    // forged database has nowhere to send what it would read.
    "IPAddressDeny=any",
    "IOSchedulingClass=idle",
    `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`,
  ];
  if (job.cacheDirectory !== null) properties.push(`CacheDirectory=${job.cacheDirectory}`, "CacheDirectoryMode=0700");
  return properties;
}

/** The command line of a child: through systemd-run, or plain with no isolation. */
export function childCommand(job: Job, config: Pick<BackupConfig, "isolation" | "systemdRun" | "bun" | "script" | "childTimeoutMs">, suffix?: string): string[] {
  const own = [config.bun, config.script, job.mode, ...job.args];
  if (config.isolation === "none") return own;
  return [
    config.systemdRun,
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${unitName(job, suffix)}`,
    `--description=Backup ${job.mode} of ${job.folder}`,
    `--uid=${job.account}`,
    `--gid=${job.account}`,
    "--nice=10",
    ...(job.uid === null ? [] : [`--setenv=BACKUP_EXPECTED_UID=${job.uid}`]),
    ...confinement(job, config.childTimeoutMs).flatMap((property) => ["-p", property]),
    "--",
    ...own,
  ];
}

// --- What a child says ---------------------------------------------------------

/**
 * A child speaks on its standard error, one JSON object per line: an `error`
 * when it gives up, a `summary` when it is done. Anything else, a line of
 * systemd-run or a stack, is kept as the tail that explains a failure.
 */
export type ChildReport = {
  summary: Record<string, unknown> | null;
  /** What went wrong, naming no file: fit for the status file. */
  error: string | null;
  /** Where, inside the data: for the journal only. */
  path: string | null;
  tail: string;
};

/** Beyond this, the standard error of a child is not read further. */
export const MAX_REPORT_BYTES = 256 * 1024;

export function readReport(text: string): ChildReport {
  let summary: Record<string, unknown> | null = null;
  let error: string | null = null;
  let path: string | null = null;
  const others: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const event = (parsed as Record<string, unknown>).event;
      if (event === "summary") {
        summary = parsed as Record<string, unknown>;
        continue;
      }
      if (event === "error" && typeof (parsed as Record<string, unknown>).message === "string") {
        error = (parsed as Record<string, unknown>).message as string;
        const where = (parsed as Record<string, unknown>).path;
        path = typeof where === "string" ? where : null;
        continue;
      }
    }
    others.push(trimmed);
  }
  return { summary, error, path, tail: others.slice(-5).join(" | ") };
}

export type Child = {
  /** The archive, for a copy; null otherwise. */
  stdout: ReadableStream<Uint8Array> | null;
  /** The exit code and what the child said. */
  result: Promise<{ code: number; report: ChildReport }>;
};

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total < MAX_REPORT_BYTES) {
      chunks.push(value.subarray(0, MAX_REPORT_BYTES - total));
      total += Math.min(value.byteLength, MAX_REPORT_BYTES - total);
    }
  }
  return new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
}

export function startChild(job: Job, config: BackupConfig): Child {
  const process = Bun.spawn(childCommand(job, config), {
    stdin: job.stdin === null ? "ignore" : Bun.file(job.stdin),
    stdout: job.stdout,
    stderr: "pipe",
    // The unit's RuntimeMaxSec stops the child itself; this stops the waiting.
    timeout: config.childTimeoutMs + 30_000,
    killSignal: "SIGKILL",
  });
  const stdout = job.stdout === "pipe" ? (process.stdout as ReadableStream<Uint8Array>) : null;
  const result = (async () => {
    const [text, code] = await Promise.all([boundedText(process.stderr as ReadableStream<Uint8Array>), process.exited]);
    return { code, report: readReport(text) };
  })();
  return { stdout, result };
}
