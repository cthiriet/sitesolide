/**
 * Where the backup component reads and writes, and how hard it works, from
 * its unit's environment. Every path has the production default and a variable
 * that moves it, so that the tests run the real code on a throwaway tree, the
 * way the steward and the gatekeeper are run on the workstation:
 *
 *   E=$(mktemp -d) && mkdir -p $E/sites/cms/data $E/backups $E/state $E/run $E/staging $E/cache
 *   head -c 48 /dev/urandom | base64 > $E/key && restic -r $E/repository -p $E/key init
 *   SITES_DIR=$E/sites BACKUP_FOLDER=$E/backups BACKUP_STATE_FOLDER=$E/state \
 *     BACKUP_RUN_FOLDER=$E/run BACKUP_STAGING_FOLDER=$E/staging BACKUP_ISOLATION=none \
 *     BACKUP_REPOSITORY=$E/repository BACKUP_REPOSITORY_KEY=$E/key BACKUP_RESTIC_CACHE=$E/cache \
 *     BACKUP_RESTIC=$(command -v restic) SITESOLIDE_ZONE=test-zone.invalid bun backup.ts run
 *
 * The retention, the disk reserve and the bucket are the only settings an
 * installation may want to change; they live here, in one place, and the unit
 * or /etc/sitesolide/dashboard-backup.env sets them. The paths of restic and
 * of its repository move for the tests alone.
 */
import { BACKUP_FOLDER, RESTIC_KEY, RESTIC_REPOSITORY } from "../../borrowed/backups";
import { offsiteFrom, type OffsiteSetting } from "./offsite";
import { policyFrom, type RetentionPolicy } from "./retention";

export type Isolation = "systemd" | "none";

export type BackupConfig = {
  sitesDir: string;
  /**
   * The archives written before restic, one folder per project, root's
   * alone: read by the import, removed after it (legacy.ts), never written.
   */
  backupFolder: string;
  /** The restic repository holding every project's snapshots, root's alone. */
  repository: string;
  /** The file holding its password, root's, 0600, drawn at install. */
  repositoryKey: string;
  /** restic itself, Debian's package, and the program that makes it the first one the kernel kills when memory runs out. */
  restic: string;
  choom: string;
  /** restic's cache and temporary files: on disk, root's, 0700, the units' CacheDirectory. */
  resticCache: string;
  /** gzip, which reads an archive of the format before restic for its import. */
  gzip: string;
  /** The component's database, the status file the monitor reads, the restore requests. */
  stateFolder: string;
  /** The lock shared by a run and a restore, and the restores' results. */
  runFolder: string;
  /**
   * Where a project's databases are copied before being archived. Under
   * systemd it is each copy unit's own CacheDirectory, created by PID 1 for the
   * project's account; with no isolation, a folder per project made here.
   */
  stagingFolder: string;
  accountsFile: string;
  unitsFolder: string;
  systemctl: string;
  systemdRun: string;
  /** The Bun that runs the copies, and the script they run: this one. */
  bun: string;
  script: string;
  /**
   * `systemd`: everything that reads or writes a project's data runs as that
   * project's account, in a transient unit confined like its own service.
   * `none`: in this very process's identity, for the workstation's tests.
   */
  isolation: Isolation;
  /** Owners are checked and set: false on the workstation, where no site-* account exists. */
  checkOwners: boolean;
  retention: RetentionPolicy;
  /** Never leave less than this free on the backups disk: a full disk stops every site. */
  reserveBytes: number;
  /** The longest a copy or an extraction of one project may take. */
  childTimeoutMs: number;
  offsite: OffsiteSetting;
  /**
   * The file the bucket's settings come from: the unit reads it, and a
   * download child is handed it by name, read by PID 1 (runner.ts).
   */
  offsiteFile: string;
  zone: string;
  /** The contact address, for a `{contact}` in the env a backup command is handed: /etc/caddy/sitesolide.env sets it. */
  contact: string;
};

export const DEFAULT_RESERVE_BYTES = 1024 * 1024 * 1024;
/** Where the units read the bucket's settings, managed from the dashboard's Secrets. */
export const OFFSITE_FILE = "/etc/sitesolide/dashboard-backup.env";
/**
 * A copy of several gigabytes takes minutes, not twenty: beyond, the child is
 * stuck, and the run must still have time for the others and for its status.
 */
export const DEFAULT_CHILD_TIMEOUT_MS = 20 * 60 * 1000;

export type Environment = Record<string, string | undefined>;

/**
 * Why an isolation is refused, or null. The units read
 * /etc/sitesolide/dashboard-backup.env, which the dashboard's Secrets page
 * writes: `none` there would have root copy every project's data itself, and
 * point restic at any repository. It is the workstation's, never root's under
 * systemd, which sets INVOCATION_ID for every unit.
 */
export function isolationRefusal(isolation: Isolation, uid: number | null, invocationId: string | undefined): string | null {
  if (isolation === "none" && uid === 0 && (invocationId ?? "") !== "") return "BACKUP_ISOLATION=none is for the workstation's tests, never under systemd";
  return null;
}

function countFrom(raw: string, name: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a whole number`);
  return Number(raw);
}

/** The configuration, or an exception naming the variable at fault: the run then fails loudly, never half-configured. */
export function configFrom(env: Environment, entry: { bun: string; script: string }): BackupConfig {
  const retention = policyFrom(env);
  if ("error" in retention) throw new Error(retention.error);
  const isolation = env.BACKUP_ISOLATION ?? "systemd";
  if (isolation !== "systemd" && isolation !== "none") throw new Error("BACKUP_ISOLATION must be systemd or none");
  const refused = isolationRefusal(isolation, process.getuid?.() ?? null, env.INVOCATION_ID);
  if (refused !== null) throw new Error(refused);
  return {
    sitesDir: env.SITES_DIR ?? "/srv/sites",
    backupFolder: env.BACKUP_FOLDER ?? BACKUP_FOLDER,
    repository: env.BACKUP_REPOSITORY ?? RESTIC_REPOSITORY,
    repositoryKey: env.BACKUP_REPOSITORY_KEY ?? RESTIC_KEY,
    restic: env.BACKUP_RESTIC ?? "/usr/bin/restic",
    choom: env.BACKUP_CHOOM ?? "/usr/bin/choom",
    resticCache: env.BACKUP_RESTIC_CACHE ?? "/var/cache/sitesolide-restic",
    gzip: env.BACKUP_GZIP ?? "/usr/bin/gzip",
    stateFolder: env.BACKUP_STATE_FOLDER ?? "/var/lib/sitesolide-backup",
    runFolder: env.BACKUP_RUN_FOLDER ?? "/run/sitesolide-backup",
    stagingFolder: env.BACKUP_STAGING_FOLDER ?? "/var/cache/sitesolide-backup",
    accountsFile: env.ACCOUNTS_FILE ?? "/etc/passwd",
    unitsFolder: env.UNITS_FOLDER ?? "/etc/systemd/system",
    // Absolute paths: under a minimal PATH, nothing to look for.
    systemctl: env.SYSTEMCTL ?? "/usr/bin/systemctl",
    systemdRun: env.SYSTEMD_RUN ?? "/usr/bin/systemd-run",
    bun: entry.bun,
    script: entry.script,
    isolation,
    // The accounts exist where the isolation does: on the machine.
    checkOwners: isolation === "systemd",
    retention,
    reserveBytes: countFrom(env.BACKUP_DISK_RESERVE ?? String(DEFAULT_RESERVE_BYTES), "BACKUP_DISK_RESERVE"),
    childTimeoutMs: countFrom(env.BACKUP_CHILD_TIMEOUT_MS ?? String(DEFAULT_CHILD_TIMEOUT_MS), "BACKUP_CHILD_TIMEOUT_MS"),
    offsite: offsiteFrom(env),
    offsiteFile: env.BACKUP_OFFSITE_FILE ?? OFFSITE_FILE,
    // No default: the landing's folder bears the zone's name, and an invented
    // zone would leave the landing's data out of every snapshot.
    zone: env.SITESOLIDE_ZONE ?? "",
    contact: env.SITESOLIDE_CONTACT ?? "",
  };
}
