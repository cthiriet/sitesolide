/**
 * The names of the data snapshots the machine keeps, and what `sitesolide
 * backups` asks the machine and prints of its answer.
 *
 * The snapshots are taken on the machine by the backup component
 * (dashboard/backup.ts, dashboard/src/backup/), one per project and per run,
 * in a restic repository, `/var/backups/sitesolide-restic`. A snapshot's name
 * is drawn from what restic records of it, its path, its time and its tag,
 * and is the same in the bucket's copy: the time it carries is what retention
 * sorts on, what the dashboard lists and what a restore names. It lives here,
 * in the CLI, because the dashboard borrows this file
 * (dashboard/scripts/borrow.ts): a second writing of the rule would one day
 * list a snapshot the other side cannot find.
 *
 * Pure: nothing here touches the disk or the network.
 */

/** The restic repository of the machine, every project's snapshots, root's alone. */
export const RESTIC_REPOSITORY = "/var/backups/sitesolide-restic";

/** Its password, drawn at install and never shown: root's, 0600, beside it. */
export const RESTIC_KEY = "/var/backups/sitesolide-restic.key";

/**
 * Where the archives written before restic live, one folder per project: they
 * are imported into the repository by the first runs of this version, then
 * removed seven days after their copy was verified.
 */
export const BACKUP_FOLDER = "/var/backups/sitesolide";

/** The component, built into one file by bin/deploy-backup.sh. */
export const BACKUP_SCRIPT = "/usr/local/lib/sitesolide/backup.js";

/** What the CLI prints in place of a list when the component is not installed. */
export const MARKER_NOT_INSTALLED = "NOT-INSTALLED";

/**
 * What a component that runs the services' backup commands carries in its
 * build, and an older one does not: its `features` mode prints it, which is
 * what keeps it in the bundle. An older component reads a manifest's backup
 * command without a word, and copies the live folder as files.
 */
export const SERVICE_COMMANDS_FEATURE = "sitesolide-backup-feature:service-commands";

/** The last line of the reading, so that an empty output is never taken for an answer. */
export const BACKUP_COMPONENT_MARKER = "DONE";

/**
 * Whether the machine's component runs backup commands, read before a
 * project that declares one is deployed: a search of its build for the
 * feature, the file being 0644, no sudo and nothing run.
 */
export function backupComponentCommand(): string {
  return (
    `sh -c 'if [ ! -f ${BACKUP_SCRIPT} ]; then echo absent; ` +
    `elif grep -qF ${SERVICE_COMMANDS_FEATURE} ${BACKUP_SCRIPT}; then echo current; else echo outdated; fi; ` +
    `echo ${BACKUP_COMPONENT_MARKER}'`
  );
}

export type BackupComponent = "current" | "outdated" | "absent" | "unreadable";

export function readBackupComponent(output: string): BackupComponent {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 2 || lines[1] !== BACKUP_COMPONENT_MARKER) return "unreadable";
  const state = lines[0];
  return state === "current" || state === "outdated" || state === "absent" ? state : "unreadable";
}

/**
 * `scheduled`: taken by the timer. `pre-restore`: the data as it was just
 * before a restore replaced it, which is what makes a restore undoable.
 */
export type SnapshotKind = "scheduled" | "pre-restore";

export type Snapshot = {
  /** The name a restore asks for. */
  name: string;
  /** The project's folder under /srv/sites. */
  folder: string;
  /** When it was taken, in milliseconds, to the second. */
  takenAt: number;
  kind: SnapshotKind;
  /** An archive of the format before restic: a `.tar.gz` file waiting for its import. */
  legacy: boolean;
};

/** The suffix of a snapshot: what `restic dump` gives back of it, a plain tar. */
export const SNAPSHOT_SUFFIX = ".tar";

/** The suffix of an archive written before restic: a tar compressed with gzip. */
export const LEGACY_SUFFIX = ".tar.gz";

const PRE_RESTORE_SUFFIX = "-pre-restore";

/**
 * A project's folder as it can appear in a snapshot's path and name: a slug,
 * or the landing's folder, which bears the zone's name and therefore dots.
 * Never `..`, never a slash, never a leading or trailing dot or dash: the name
 * becomes a directory under /var/backups and a unit instance.
 */
export function isBackupFolder(folder: unknown): folder is string {
  return (
    typeof folder === "string" &&
    folder.length <= 253 &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(folder) &&
    !folder.includes("..")
  );
}

/** `20261004T130000Z`: sortable as text, with no character a shell or a URL would read. */
export function compactTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** The milliseconds of a compact time, or null for anything that is not one exactly. */
export function readCompactTime(text: string): number | null {
  const parts = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC carries 31 February over into March: the reading back refuses it.
  return compactTime(ms) === text ? ms : null;
}

function nameOf(folder: string, takenAt: number, kind: SnapshotKind, suffix: string): string {
  if (!isBackupFolder(folder)) throw new Error("not a project folder");
  return `${folder}-${compactTime(takenAt)}${kind === "pre-restore" ? PRE_RESTORE_SUFFIX : ""}${suffix}`;
}

/** The name of a snapshot. Throws on a folder outside the rule: it would become a path. */
export function snapshotName(folder: string, takenAt: number, kind: SnapshotKind): string {
  return nameOf(folder, takenAt, kind, SNAPSHOT_SUFFIX);
}

/** The file name an archive of the format before restic had. */
export function legacySnapshotName(folder: string, takenAt: number, kind: SnapshotKind): string {
  return nameOf(folder, takenAt, kind, LEGACY_SUFFIX);
}

/**
 * A name read back, or null if it is not a snapshot of this folder: a
 * snapshot's, or an archive's of the format before restic, which says so.
 *
 * The folder is given rather than guessed: `shop-api-20261004T130000Z.tar`
 * would otherwise be readable as a snapshot of `shop` and of `shop-api`. A
 * name that does not parse is never a snapshot, and retention never deletes it.
 */
export function readSnapshotName(folder: string, name: string): Snapshot | null {
  if (!isBackupFolder(folder) || !name.startsWith(`${folder}-`)) return null;
  const legacy = name.endsWith(LEGACY_SUFFIX);
  const suffix = legacy ? LEGACY_SUFFIX : SNAPSHOT_SUFFIX;
  if (!name.endsWith(suffix)) return null;
  let middle = name.slice(folder.length + 1, -suffix.length);
  let kind: SnapshotKind = "scheduled";
  if (middle.endsWith(PRE_RESTORE_SUFFIX)) {
    kind = "pre-restore";
    middle = middle.slice(0, -PRE_RESTORE_SUFFIX.length);
  }
  const takenAt = readCompactTime(middle);
  return takenAt === null ? null : { name, folder, takenAt, kind, legacy };
}

/**
 * The snapshot's name for an archive of the format before restic, the one
 * its import gives it: the same folder, time and kind. A snapshot's name is
 * its own twin; anything else, null.
 */
export function twinName(folder: string, name: string): string | null {
  const read = readSnapshotName(folder, name);
  return read === null ? null : snapshotName(folder, read.takenAt, read.kind);
}

// --- sitesolide backups ------------------------------------------------------

/**
 * One snapshot as `backup.js list` prints it: on the server, in the bucket, or
 * both. `bytes` is the size of the data it holds, as a tar; `added`, what it
 * added to the repository when it was taken, once deduplicated and compressed.
 * `added` is absent from the answer of a component before restic.
 */
export type ListedSnapshot = {
  name: string;
  takenAt: number;
  kind: SnapshotKind;
  bytes: number | null;
  added?: number | null;
  local: boolean;
  offsite: boolean;
};

/** This project's line of the last run, as `/var/lib/sitesolide-backup/last-run.json` carries it. */
export type ListedRun = { startedAt: string; finishedAt: string; ok: boolean; snapshot: string | null; error: string | null };

export type Listing = { folder: string; snapshots: ListedSnapshot[]; lastRun: ListedRun | null };

/**
 * The read-only command `sitesolide backups` sends. The component prints JSON;
 * when it is missing, a marker rather than an empty output, which a refused
 * sudo would give just as well.
 */
export function listCommand(folder: string): string {
  if (!isBackupFolder(folder)) throw new Error("not a project folder");
  return `if [ -f ${BACKUP_SCRIPT} ]; then sudo /usr/local/bin/bun ${BACKUP_SCRIPT} list ${folder}; else echo ${MARKER_NOT_INSTALLED}; fi`;
}

export type ListAnswer = { kind: "not-installed" } | { kind: "listing"; listing: Listing } | { kind: "unreadable" };

function isListedSnapshot(value: unknown): value is ListedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.takenAt === "number" &&
    (v.kind === "scheduled" || v.kind === "pre-restore") &&
    (v.bytes === null || typeof v.bytes === "number") &&
    (v.added === undefined || v.added === null || typeof v.added === "number") &&
    typeof v.local === "boolean" &&
    typeof v.offsite === "boolean"
  );
}

/** What the machine answered, judged. Anything else than the two shapes is unreadable. */
export function readListAnswer(output: string): ListAnswer {
  const text = output.trim();
  if (text === MARKER_NOT_INSTALLED) return { kind: "not-installed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "unreadable" };
  const { folder, snapshots, lastRun } = parsed as Record<string, unknown>;
  if (typeof folder !== "string" || !Array.isArray(snapshots) || !snapshots.every(isListedSnapshot)) return { kind: "unreadable" };
  const run = typeof lastRun === "object" && lastRun !== null ? (lastRun as ListedRun) : null;
  return { kind: "listing", listing: { folder, snapshots, lastRun: run } };
}

/** `12.3 MB`, counted in 1024s like the dashboard's sizes, `-` when unknown. */
export function humanSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function where(snapshot: ListedSnapshot): string {
  if (snapshot.local && snapshot.offsite) return "server, offsite";
  return snapshot.local ? "server" : "offsite only";
}

/** `2026-10-04 13:00 UTC`: the machine's clock, said as such. */
export function utcMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * All of `sitesolide backups`, but the ssh: the command sent, the answer
 * judged, the lines printed. `read` runs a read-only command on the machine.
 * `ok` false makes the CLI exit in error, a script chaining it must not
 * believe it saw a list.
 */
export async function backupsReport(folder: string, dashboardUrl: string, read: (command: string) => Promise<string>): Promise<{ ok: boolean; lines: string[] }> {
  const answer = readListAnswer(await read(listCommand(folder)));
  if (answer.kind === "listing") return { ok: true, lines: listingLines(answer.listing, dashboardUrl) };
  if (answer.kind === "not-installed") {
    return { ok: false, lines: ["backups are not installed on the server", "install them from the platform's repository: bin/deploy-backup.sh install, then enable"] };
  }
  return { ok: false, lines: ["the server's answer could not be read", "check that the deployment account may run sudo, and the component's version: bin/deploy-backup.sh install"] };
}

/** The lines `sitesolide backups` prints, newest snapshot first. */
export function listingLines(listing: Listing, dashboardUrl: string): string[] {
  const lines = [`=== backups of ${listing.folder} ===`];
  if (listing.snapshots.length === 0) {
    lines.push("no snapshot yet");
  } else {
    lines.push(`${"TAKEN".padEnd(22)}${"KIND".padEnd(14)}${"SIZE".padEnd(10)}${"ADDED".padEnd(10)}WHERE`);
    const ordered = [...listing.snapshots].sort((a, b) => b.takenAt - a.takenAt || b.name.localeCompare(a.name));
    for (const snapshot of ordered) {
      lines.push(
        `${utcMinute(snapshot.takenAt).padEnd(22)}${snapshot.kind.padEnd(14)}${humanSize(snapshot.bytes).padEnd(10)}${humanSize(snapshot.added ?? null).padEnd(10)}${where(snapshot)}`,
      );
    }
  }
  const run = listing.lastRun;
  if (run !== null) {
    const finished = Date.parse(run.finishedAt);
    const when = Number.isFinite(finished) ? utcMinute(finished) : run.finishedAt;
    lines.push("", `last run: ${when}, ${run.ok ? "ok" : `failed: ${run.error ?? "no reason given"}`}`);
  }
  lines.push("", `restore from the Backups section of ${dashboardUrl}`);
  return lines;
}
