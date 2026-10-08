/**
 * `/var/lib/sitesolide-backup/last-run.json`: what the last run did, for
 * whoever watches the machine.
 *
 * Its shape is a contract with the monitor, which reads it and raises an alarm
 * when a run fails or stops happening:
 *
 *   { "startedAt": ISO, "finishedAt": ISO, "ok": boolean,
 *     "projects": { "<folder>": { "ok": boolean, "snapshot": string | null, "error": string | null } },
 *     "checks": { "local": Check | null, "offsite": Check | null, "since": ISO | null, "offsiteSince": ISO | null } }
 *
 * `checks`, the last daily check of each repository (maintenance.ts), each
 * `{ "at": ISO, "ok": boolean, "error": string | null }`: null before the
 * first, and `offsite` null without a bucket; `since` and `offsiteSince`,
 * when checks of each were first due. A monitor that predates the key
 * ignores it.
 *
 * A project left out on purpose, opted out by its manifest or with an empty or
 * missing data folder, is listed with `ok: true` and `snapshot: null`: nothing
 * was owed. A project whose snapshot was taken but whose offsite copy failed is
 * `ok: false` with its snapshot named: the local copy exists, the second one
 * does not. `ok` at the top is false as soon as one project is, or the run
 * itself failed.
 *
 * Written whole, by rename, 0644 in a 0755 folder: the monitor runs as an
 * unprivileged dynamic user. It therefore holds nothing that is not already
 * public on the machine: times, booleans, project folders (their subdomains),
 * snapshot names and short reasons. A reason never names a file inside a
 * project's data (copy.ts sends the path apart, to the journal), never quotes
 * a system error's message (which carries paths), and never restic's words,
 * which may quote a repository's paths: restic.ts gives fixed sentences.
 * tests/backup-run.test.ts holds the failures to that.
 */
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, constants } from "node:fs";
import { join } from "node:path";

export const STATUS_NAME = "last-run.json";

export type ProjectStatus = { ok: boolean; snapshot: string | null; error: string | null };

/** A repository's last check: when, its verdict, and a fixed sentence when it failed. */
export type Check = { at: string; ok: boolean; error: string | null };

/**
 * `since`, when checks of the server's repository were first due, the first
 * run; `offsiteSince`, of the bucket's, null without a bucket. The monitor
 * warns when none came three days after either.
 */
export type Checks = { local: Check | null; offsite: Check | null; since?: string | null; offsiteSince?: string | null };

export type RunStatus = {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  projects: Record<string, ProjectStatus>;
  checks?: Checks;
};

function readCheck(value: unknown): Check | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== "string" || typeof v.ok !== "boolean" || (v.error !== null && typeof v.error !== "string")) return undefined;
  return { at: v.at, ok: v.ok, error: v.error as string | null };
}

/** An error message fit for the status file and the page: one line, bounded, never a path to a secret. */
export function shortError(message: string): string {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

export function writeStatus(stateFolder: string, status: RunStatus): void {
  writeFileAtomically(stateFolder, STATUS_NAME, `${JSON.stringify(status, null, 2)}\n`, 0o644);
}

/** The status read back, or null when it is missing or not the contract's shape. */
export function readStatus(text: string | null): RunStatus | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { startedAt, finishedAt, ok, projects, checks } = parsed as Record<string, unknown>;
  if (typeof startedAt !== "string" || typeof finishedAt !== "string" || typeof ok !== "boolean") return null;
  if (typeof projects !== "object" || projects === null || Array.isArray(projects)) return null;
  const read: Record<string, ProjectStatus> = {};
  for (const [folder, value] of Object.entries(projects)) {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.ok !== "boolean") return null;
    if (entry.snapshot !== null && typeof entry.snapshot !== "string") return null;
    if (entry.error !== null && typeof entry.error !== "string") return null;
    read[folder] = { ok: entry.ok, snapshot: entry.snapshot as string | null, error: entry.error as string | null };
  }
  if (checks === undefined) return { startedAt, finishedAt, ok, projects: read };
  if (typeof checks !== "object" || checks === null) return null;
  const local = readCheck((checks as Record<string, unknown>).local);
  const offsite = readCheck((checks as Record<string, unknown>).offsite);
  if (local === undefined || offsite === undefined) return null;
  const moment = (value: unknown) => (typeof value === "string" ? value : null);
  const { since, offsiteSince } = checks as Record<string, unknown>;
  return { startedAt, finishedAt, ok, projects: read, checks: { local, offsite, since: moment(since), offsiteSince: moment(offsiteSince) } };
}

/**
 * A file written whole: a temporary beside it, created exclusively, synced,
 * renamed, and the folder synced so that the rename survives a power cut.
 */
export function writeFileAtomically(folder: string, name: string, content: string | Uint8Array, mode: number): void {
  const final = join(folder, name);
  const temporary = join(folder, `.${name}.${crypto.getRandomValues(new Uint32Array(2)).join("")}.tmp`);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  let placed = false;
  try {
    try {
      // The umask of the unit (0077) would otherwise close a file meant to be read.
      fchmodSync(fd, mode);
      let written = 0;
      while (written < bytes.byteLength) written += writeSync(fd, bytes, written, bytes.byteLength - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, final);
    placed = true;
    syncFolder(folder);
  } finally {
    if (!placed) {
      try {
        unlinkSync(temporary);
      } catch {
        // already gone
      }
    }
  }
}

export function syncFolder(folder: string): void {
  const fd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
