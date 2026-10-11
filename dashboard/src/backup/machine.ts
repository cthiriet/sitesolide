/**
 * The machine's own state, snapshotted every hour beside the projects' data,
 * under the folder `machine` (MACHINE_FOLDER): what no project's data folder
 * holds and no repository gives back.
 *
 *   /etc/sitesolide               every project's secret files
 *   /var/lib/sitesolide-steward   who may open which site, the previous
 *                                 versions of the secrets, the steward's log
 *   /etc/caddy                    the preview codes, the zone's settings, the
 *                                 DNS token, the table of the clients' domains
 *
 * Without it, a lost machine took its secrets and its access registry with
 * it: the data came back from the bucket, and every key had to be minted
 * again by hand. The cloud provider's images of the whole machine, where
 * there are any, go with the machine's account, and the provider's backups
 * with the machine itself.
 *
 * **The same path as a project's**, so that everything around the copy holds
 * for it unchanged: restic runs the copy, the snapshot is read back, kept by
 * the same retention, copied to the bucket encrypted by restic, checked, and
 * reported in the status file, where the monitor names it when it fails.
 *
 * **Its copy reads through one capability, as nobody.** The files belong to
 * every account, `site-<slug>` or root, in 0600: the copy runs as a dynamic
 * user of its own with CAP_DAC_READ_SEARCH alone, in a transient unit with
 * no network, the three folders bound read-only into its empty /srv as one
 * tree, nothing of the machine writable but its staging folder (runner.ts).
 * Not root: uid 0, even stripped of its capabilities, may still signal
 * root's processes and ask PID 1 for a unit. Every file is archived as it
 * is (`raw`): no SQLite is opened, whatever the steward leaves in its
 * state. A folder missing from the machine is left out, not an error: the
 * bind is optional. The run itself still does not see them
 * (sitesolide-backup.service): PID 1 lays the binds from its own side. That
 * wall only ever kept the run from reading them by mistake, a root process
 * being free to ask PID 1 for a unit.
 *
 * **Never restored by a page.** `machine` is no site (scope.ts): the steward
 * lists none of its snapshots and refuses its restore, and so does the
 * restore's one-shot (request.ts). It is put back by hand, file by file, by
 * someone who knows what an old secret brings back (README, "The machine's
 * own state").
 */
import { join } from "node:path";
import { MACHINE_FOLDER } from "../../borrowed/backups";
import type { BackupConfig } from "./config";
import type { Project } from "./projects";

/** A folder of the machine, and where the copy finds it under its view. */
export type MachineSource = { source: string; place: string };

/** What the copy reads, in the archive under `data/<place>`: each place is the folder's own path. */
export const MACHINE_SOURCES: readonly MachineSource[] = [
  { source: "/etc/sitesolide", place: "etc/sitesolide" },
  { source: "/var/lib/sitesolide-steward", place: "var/lib/sitesolide-steward" },
  { source: "/etc/caddy", place: "etc/caddy" },
];

/** Where the copy's unit sees them, inside its empty /srv: nothing of the machine's own /srv is there. */
export const MACHINE_VIEW = "/srv/machine";

/**
 * The machine's state as the run snapshots it: a project whose data folder
 * is the view, and which no account owns, its copy running as a dynamic
 * user. Null when there is none to take.
 */
export function machineProject(config: BackupConfig): Project | null {
  if (config.machine === null) return null;
  return {
    folder: MACHINE_FOLDER,
    account: "nobody",
    owner: null,
    dataDir: config.machine.dataDir,
    manifest: null,
    sources: config.machine.sources,
  };
}

/** The read-only binds of the copy's unit, each optional: `-<source>:<view>/<place>`. */
export function machineBinds(project: Project): string[] {
  return (project.sources ?? []).map(({ source, place }) => `-${source}:${join(project.dataDir, place)}`);
}
