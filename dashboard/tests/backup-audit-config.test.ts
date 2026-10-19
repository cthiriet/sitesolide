/**
 * What root takes from its environment, under systemd. The run's unit and the
 * restore's read /etc/sitesolide/dashboard-backup.env with EnvironmentFile=,
 * and the dashboard's Secrets page writes that file: any variable name the
 * steward does not reserve, BACKUP_RESTIC among them. A program or a folder
 * taken from it would have root run whatever the page named, or write where
 * it said. Under systemd, then, every program and every folder is the
 * machine's own; the tests' tree moves them only with BACKUP_ISOLATION=none,
 * which config.ts refuses to root under systemd.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotName } from "../borrowed/backups";
import { downloadMain } from "../src/backup/child";
import { configFrom } from "../src/backup/config";
import { main } from "../src/backup/main";

const ENTRY = { bun: "/usr/local/bin/bun", script: "/usr/local/lib/sitesolide/backup.js" };

/** What a page could write into dashboard-backup.env: a program, a folder, for every one the component reads. */
const PLANTED = {
  BACKUP_RESTIC: "/srv/sites/shop/data/restic",
  BACKUP_CHOOM: "/srv/sites/shop/data/choom",
  BACKUP_GZIP: "/srv/sites/shop/data/gzip",
  SYSTEMCTL: "/srv/sites/shop/data/systemctl",
  SYSTEMD_RUN: "/srv/sites/shop/data/systemd-run",
  SITES_DIR: "/var/backups",
  BACKUP_FOLDER: "/srv/sites/shop/data/archives",
  BACKUP_REPOSITORY: "rclone:shop",
  BACKUP_REPOSITORY_KEY: "/srv/sites/shop/data/key",
  BACKUP_RESTIC_CACHE: "/srv/sites/shop/data/cache",
  BACKUP_STATE_FOLDER: "/var/backups/sitesolide-restic",
  BACKUP_RUN_FOLDER: "/srv/sites/shop/data/run",
  BACKUP_STAGING_FOLDER: "/srv/sites/shop/data/staging",
  ACCOUNTS_FILE: "/srv/sites/shop/data/passwd",
  UNITS_FOLDER: "/srv/sites/shop/data/units",
  BACKUP_OFFSITE_FILE: "/etc/sitesolide/shop.env",
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("root's programs and folders, under systemd", () => {
  test("are the machine's own whatever the environment says: the file the Secrets page writes never names one", () => {
    const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid", ...PLANTED }, ENTRY);
    expect(config.isolation).toBe("systemd");
    expect({
      restic: config.restic,
      choom: config.choom,
      gzip: config.gzip,
      systemctl: config.systemctl,
      systemdRun: config.systemdRun,
      sitesDir: config.sitesDir,
      backupFolder: config.backupFolder,
      repository: config.repository,
      repositoryKey: config.repositoryKey,
      resticCache: config.resticCache,
      stateFolder: config.stateFolder,
      runFolder: config.runFolder,
      stagingFolder: config.stagingFolder,
      accountsFile: config.accountsFile,
      unitsFolder: config.unitsFolder,
      offsiteFile: config.offsiteFile,
    }).toEqual({
      restic: "/usr/bin/restic",
      choom: "/usr/bin/choom",
      gzip: "/usr/bin/gzip",
      systemctl: "/usr/bin/systemctl",
      systemdRun: "/usr/bin/systemd-run",
      sitesDir: "/srv/sites",
      backupFolder: "/var/backups/sitesolide",
      repository: "/var/backups/sitesolide-restic",
      repositoryKey: "/var/backups/sitesolide-restic.key",
      resticCache: "/var/cache/sitesolide-restic",
      stateFolder: "/var/lib/sitesolide-backup",
      runFolder: "/run/sitesolide-backup",
      stagingFolder: "/var/cache/sitesolide-backup",
      accountsFile: "/etc/passwd",
      unitsFolder: "/etc/systemd/system",
      offsiteFile: "/etc/sitesolide/dashboard-backup.env",
    });
  });

  test("the settings the README gives the file still apply: retention, the reserve, the child's time", () => {
    const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid", BACKUP_KEEP_HOURLY: "6", BACKUP_DISK_RESERVE: "2048", BACKUP_CHILD_TIMEOUT_MS: "60000" }, ENTRY);
    expect(config.retention.hourly).toBe(6);
    expect(config.reserveBytes).toBe(2048);
    expect(config.childTimeoutMs).toBe(60_000);
  });

  test("the workstation's tests still move them, with no isolation", () => {
    const config = configFrom({ SITESOLIDE_ZONE: "test-zone.invalid", BACKUP_ISOLATION: "none", ...PLANTED }, ENTRY);
    expect(config.restic).toBe(PLANTED.BACKUP_RESTIC);
    expect(config.sitesDir).toBe(PLANTED.SITES_DIR);
    expect(config.stateFolder).toBe(PLANTED.BACKUP_STATE_FOLDER);
  });

  test("nor does the restore's download child run a restic the file names: PID 1 hands it that very file", async () => {
    // The child is a dynamic user with the network and the bucket's keys; its
    // unit reads dashboard-backup.env, which overrides the restic root sets.
    const holder = mkdtempSync(join(tmpdir(), "backup-audit-restic-"));
    roots.push(holder);
    const planted = join(holder, "restic");
    writeFileSync(planted, `#!/bin/sh\ntouch "${planted}.ran"\nexit 1\n`, { mode: 0o755 });
    const code = await downloadMain(["shop", snapshotName("shop", Date.UTC(2026, 9, 4, 13), "scheduled")], {
      BACKUP_S3_ENDPOINT: "https://bucket.test-zone.invalid",
      BACKUP_S3_BUCKET: "backups",
      BACKUP_S3_ACCESS_KEY_ID: "AKIDAUDIT",
      BACKUP_S3_SECRET_ACCESS_KEY: "secret",
      BACKUP_ENCRYPTION_PASSPHRASE: "sixteen chars ok",
      BACKUP_RESTIC: planted,
    }).catch(() => 1);
    expect(code).not.toBe(0);
    expect(existsSync(`${planted}.ran`)).toBe(false);
  });

  test("a run whose settings are at fault writes its failed status in its own folder, never one the environment names", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "backup-audit-state-"));
    roots.push(elsewhere);
    const code = await main(["run"], { SITESOLIDE_ZONE: "test-zone.invalid", BACKUP_STATE_FOLDER: elsewhere, BACKUP_KEEP_HOURLY: "many" });
    expect(code).toBe(1);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
