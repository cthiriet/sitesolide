/**
 * The snapshots on the server's disk, as the run, the restore, the steward and
 * `sitesolide backups` all list them: by file name, under one folder per
 * project. Anything in a folder that is not a snapshot's name is ignored, and
 * therefore never deleted.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isBackupFolder, readSnapshotName, type Snapshot } from "../../borrowed/backups";

export type LocalSnapshot = Snapshot & { bytes: number };

/** A folder's snapshots, newest first. */
export function localSnapshots(backupFolder: string, folder: string): LocalSnapshot[] {
  let names: string[];
  try {
    names = readdirSync(join(backupFolder, folder));
  } catch {
    return [];
  }
  const found: LocalSnapshot[] = [];
  for (const name of names) {
    const snapshot = readSnapshotName(folder, name);
    if (snapshot === null) continue;
    try {
      const stat = lstatSync(join(backupFolder, folder, name));
      if (stat.isFile()) found.push({ ...snapshot, bytes: stat.size });
    } catch {
      // gone in the meantime
    }
  }
  return found.sort((a, b) => b.takenAt - a.takenAt);
}

/** The project folders that hold snapshots, those of removed projects included. */
export function backupFolders(backupFolder: string): string[] {
  try {
    return readdirSync(backupFolder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isBackupFolder(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
