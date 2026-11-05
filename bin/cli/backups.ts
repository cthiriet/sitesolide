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

// --- the archives written before restic --------------------------------------

/**
 * Up to 0.16, the backup component imported the archives written before
 * restic (0.4.0), `.tar.gz` files under this folder and `.enc` objects in the
 * bucket, into its repositories, and removed each seven days after its copy
 * was verified, the time to go back to the release before. This release
 * imports nothing: `bin/deploy-backup.sh install` refuses a machine where an
 * archive remains or a copy is younger than those seven days, before it
 * changes anything there, so that nothing the import still had to carry is
 * left behind unread. The refusal goes with the next release that no longer
 * needs it.
 */
export const PRE_RESTIC_FOLDER = "/var/backups/sitesolide";

/** The component's own database, where the release that imported recorded each archive's verified copy. */
export const BACKUP_DATABASE = "/var/lib/sitesolide-backup/backup.db";

/** How long an imported archive was kept, its copy verified, before it was removed. */
export const IMPORT_ROLLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The last line of the reading: an answer without it, cut short or refused by sudo, is no answer. */
export const PRE_RESTIC_MARKER = "PRE-RESTIC-READ";

/** The archives named in a refusal; the count says the rest. */
const NAMED_ARCHIVES = 5;

export type PreResticPaths = { folder: string; database: string; bun: string; sudo: string };

const MACHINE_PATHS: PreResticPaths = { folder: PRE_RESTIC_FOLDER, database: BACKUP_DATABASE, bun: "/usr/local/bin/bun", sudo: "sudo" };

/**
 * What the machine is read for before the component is installed, as root,
 * changing nothing: the archives left under the folder, at any depth, and
 * the newest import the database recorded, with the machine's own clock.
 * One Bun program, which the prerequisites already require: the machine
 * need not carry sqlite3, and a sudo refused prints nothing at all, never
 * an empty folder. The database is opened as its readers open it, read-write
 * but `query_only`, a WAL database whose `-wal` is gone being unreadable in
 * SQLite's read-only mode. `paths` are the tests'.
 */
export function preResticCommand(paths: PreResticPaths = MACHINE_PATHS): string {
  for (const value of [paths.folder, paths.database, paths.bun]) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`unexpected path: ${value}`);
  }
  if (paths.sudo !== "" && paths.sudo !== "sudo") throw new Error("unexpected sudo");
  const program = [
    `const { readdirSync, existsSync } = require("node:fs");`,
    `const { join } = require("node:path");`,
    `const { Database } = require("bun:sqlite");`,
    `const found = [];`,
    `const walk = (dir) => { let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }`,
    ` for (const entry of entries) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith(".tar.gz")) found.push(path); } };`,
    `walk(${JSON.stringify(paths.folder)});`,
    `console.log("archives " + String(found.length));`,
    `for (const path of found.sort().slice(0, ${NAMED_ARCHIVES})) console.log("archive " + path);`,
    `let newest = "none";`,
    `if (existsSync(${JSON.stringify(paths.database)})) { const db = new Database(${JSON.stringify(paths.database)}, { readwrite: true, create: false });`,
    ` db.run("PRAGMA busy_timeout = 10000"); db.run("PRAGMA query_only = ON");`,
    ` if (db.query("PRAGMA table_info(imported)").all().length > 0) { const row = db.query("SELECT MAX(at) AS at FROM imported").get(); if (row !== null && row.at !== null) newest = String(row.at); }`,
    ` db.close(); }`,
    `console.log("imported " + newest + " " + String(Date.now()));`,
    `console.log(${JSON.stringify(PRE_RESTIC_MARKER)});`,
  ].join("");
  if (program.includes("'")) throw new Error("the program must hold no single quote");
  return `${paths.sudo === "" ? "" : "sudo "}${paths.bun} -e '${program}'`;
}

export type PreResticState = { archives: number; named: string[]; importedAt: number | null; now: number };

/** The answer read back, or null for anything else than what the command prints. */
export function readPreResticState(output: string): PreResticState | null {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.at(-1) !== PRE_RESTIC_MARKER) return null;
  const count = /^archives (\d+)$/.exec(lines[0] ?? "");
  const imported = /^imported (none|\d+) (\d+)$/.exec(lines.at(-2) ?? "");
  if (count === null || imported === null) return null;
  const named = lines.slice(1, -2);
  if (!named.every((line) => line.startsWith("archive /"))) return null;
  return { archives: Number(count[1]), named: named.map((line) => line.slice("archive ".length)), importedAt: imported[1] === "none" ? null : Number(imported[1]), now: Number(imported[2]) };
}

/**
 * Why the install must not go on, a line each, or null when nothing the
 * import had to carry is left: no archive on the server, and no copy
 * verified less than seven days ago, by the machine's clock. An answer that
 * does not read refuses too: an install that cannot see is not one that may
 * leave archives behind.
 */
export function preResticRefusal(output: string): string[] | null {
  const state = readPreResticState(output);
  if (state === null) {
    return [
      "the machine did not say whether archives of the format before restic remain: nothing was installed",
      "check that the deployment account may run sudo and that /usr/local/bin/bun runs, then run this again",
    ];
  }
  const lines: string[] = [];
  if (state.archives > 0) {
    lines.push(
      `${state.archives} archive(s) of the format before restic remain under ${PRE_RESTIC_FOLDER}, which this release no longer imports:`,
      ...state.named.map((path) => `   ${path}`),
      ...(state.archives > state.named.length ? [`   and ${state.archives - state.named.length} more`] : []),
      "the backups of a release up to 0.16 import them at their hourly runs, their journal saying why one does not; or move them off the machine by hand",
    );
  }
  if (state.importedAt !== null && state.now - state.importedAt < IMPORT_ROLLBACK_MS) {
    lines.push(
      `an archive's copy was verified on ${utcMinute(state.importedAt)}, less than seven days ago: the backups in service remove it, and its bucket's object, on ${utcMinute(state.importedAt + IMPORT_ROLLBACK_MS)}; install this release after that`,
    );
  }
  return lines.length === 0 ? null : [...lines, "nothing was installed"];
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
};

/** The suffix of a snapshot: what `restic dump` gives back of it, a plain tar. */
export const SNAPSHOT_SUFFIX = ".tar";

const PRE_RESTORE_SUFFIX = "-pre-restore";

/**
 * The folder the machine's own state is snapshotted under, beside the
 * projects': the secrets of /etc/sitesolide, the steward's registry and
 * Caddy's configuration, which no project's data holds
 * (dashboard/src/backup/README.md). Never a site: `deploy` refuses it as a
 * slug, and the steward never takes it for one, so the dashboard neither
 * lists nor restores it.
 */
export const MACHINE_FOLDER = "machine";

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

/** The name of a snapshot. Throws on a folder outside the rule: it would become a path. */
export function snapshotName(folder: string, takenAt: number, kind: SnapshotKind): string {
  if (!isBackupFolder(folder)) throw new Error("not a project folder");
  return `${folder}-${compactTime(takenAt)}${kind === "pre-restore" ? PRE_RESTORE_SUFFIX : ""}${SNAPSHOT_SUFFIX}`;
}

/**
 * A name read back, or null if it is not a snapshot of this folder.
 *
 * The folder is given rather than guessed: `shop-api-20261004T130000Z.tar`
 * would otherwise be readable as a snapshot of `shop` and of `shop-api`. A
 * name that does not parse is never a snapshot, and retention never deletes it.
 */
export function readSnapshotName(folder: string, name: string): Snapshot | null {
  if (!isBackupFolder(folder) || !name.startsWith(`${folder}-`) || !name.endsWith(SNAPSHOT_SUFFIX)) return null;
  let middle = name.slice(folder.length + 1, -SNAPSHOT_SUFFIX.length);
  let kind: SnapshotKind = "scheduled";
  if (middle.endsWith(PRE_RESTORE_SUFFIX)) {
    kind = "pre-restore";
    middle = middle.slice(0, -PRE_RESTORE_SUFFIX.length);
  }
  const takenAt = readCompactTime(middle);
  return takenAt === null ? null : { name, folder, takenAt, kind };
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

/**
 * How serious a backup in trouble is, wherever it is said: a run that failed
 * or is overdue, a repository's check that failed, a bucket half configured,
 * which fails every project's run. A warning: the sites still serve, the
 * snapshot before is still there to restore, and the next hourly run may go
 * well, as a scheduled service's failed run is a warning. The monitor alerts
 * with it (monitor/src/checks.ts), the dashboard's home page and a site's
 * Backups section say it (dashboard/src/monitor.ts,
 * dashboard/web/src/lib/backups.ts), so that none says it in another tone.
 * The monitor's word and the dashboard's are the same for a warning.
 */
export const BACKUP_SEVERITY = "warning";
