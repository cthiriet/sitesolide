/**
 * The rename's real host: the installer's own (real.ts) for what both read
 * and write the same way, the manifests, the units, systemd's facts, the
 * zone's sites, and here what only a rename does: renaming an account,
 * moving a project's folders, setting its unit files aside, the domain table.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTable, render } from "../../borrowed/table";
import { isValidSlug } from "../../borrowed/manifest";
import { STORE_PREVIOUS_ROOT, storePaths } from "../../borrowed/store";
import { isTimerUnit, systemUser, unitFileName } from "../../borrowed/unit";
import { waitForLock } from "../backup/lock";
import { readAccount, readBounded, writeAtomically } from "../secrets/system";
import type { Host } from "./host";
import { spawn } from "./real";
import type { Place, RenameHost } from "./rename";

export type RenameHostConfig = {
  /** The installer's host, mounted on the same machine. */
  installer: Host;
  sitesDir: string;
  /** /etc/sitesolide, the stores under its `projects/`. */
  secretsFolder: string;
  /** /var/lib/sitesolide-steward/precedents/projects */
  storePreviousFolder?: string;
  /** /etc/passwd */
  accountsFile: string;
  /** /etc/caddy/domaines.map */
  domainTableFile: string;
  /** `usermod` and `groupmod`, absolute: under a minimal PATH, nothing to look for. */
  usermod: string;
  groupmod: string;
  systemctl: (arguments_: string[], timeoutMs: number) => Promise<{ code: number; output: string }>;
  /** /run/sitesolide-backup, where the backups' lock lives (src/backup/lock.ts). */
  backupRunFolder: string;
  /** The pause between two attempts at the backups' lock, and the wait itself in place of the run's. */
  backupLockStepMs?: number;
  backupLockWaitMs?: number;
};

function code(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export function createRenameHost(config: RenameHostConfig): RenameHost {
  const { installer } = config;
  const storeRoot = join(config.secretsFolder, "projects");
  const previousRoot = config.storePreviousFolder ?? STORE_PREVIOUS_ROOT;

  function pathOf(place: Place, slug: string): string {
    if (!isValidSlug(slug)) throw new Error("invalid slug");
    if (place === "tree") return join(config.sitesDir, slug);
    if (place === "store") return storePaths(slug, storeRoot).folder;
    return join(previousRoot, slug);
  }

  /** Where a removal sets public/ while Caddy is reloaded without the site's block: the wildcard serves public/ alone. */
  const PUBLIC_ASIDE = ".public-removed";

  function present(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
  }

  return {
    now: installer.machine.now,
    wait: installer.machine.wait,
    log: installer.log,
    machine: installer.machine,
    unitsFolder: installer.unitsFolder,
    readManifests: installer.readManifests,
    readUnit: installer.readUnit,
    installUnit: installer.installUnit,
    unitFacts: installer.unitFacts,
    refreshZoneNames: installer.refreshZoneNames,
    systemctl: config.systemctl,

    async accountExists(slug) {
      return readAccount(readFileSync(config.accountsFile, "utf8"), systemUser(slug)) !== null;
    },

    async renameAccount(from, to) {
      if (!isValidSlug(from) || !isValidSlug(to)) throw new Error("invalid slug");
      // The home useradd wrote by default, `/home/site-<slug>`, never made
      // (--no-create-home), follows the name; any other is left as it is.
      const home = readFileSync(config.accountsFile, "utf8").split("\n").find((line) => line.startsWith(`${systemUser(from)}:`))?.split(":")[5];
      const moveHome = home === `/home/${systemUser(from)}` ? ["-d", `/home/${systemUser(to)}`] : [];
      const user = await spawn([config.usermod, "-l", systemUser(to), ...moveHome, systemUser(from)], 30_000);
      if (user.code !== 0) return user;
      const group = await spawn([config.groupmod, "-n", systemUser(to), systemUser(from)], 30_000);
      if (group.code === 0) return group;
      // The account renamed and not its group: the account goes back, so
      // that the run's way back finds both under the old name.
      await spawn([config.usermod, "-l", systemUser(from), ...(moveHome.length === 0 ? [] : ["-d", `/home/${systemUser(from)}`]), systemUser(to)], 30_000);
      return group;
    },

    async exists(place, slug) {
      return present(pathOf(place, slug));
    },

    async move(place, from, to) {
      const source = pathOf(place, from);
      const destination = pathOf(place, to);
      // renameSync replaces an empty folder silently: refused beforehand.
      if (present(destination)) throw new Error(`${destination} already exists`);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${source} is not a folder`);
      renameSync(source, destination);
    },

    async dropPrevious(slug) {
      rmSync(pathOf("previous", slug), { recursive: true, force: true });
    },

    async unitFiles(slug) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      const units: string[] = [];
      for (const name of readdirSync(installer.unitsFolder)) {
        if (name === `${slug}.service`) {
          units.push(slug);
          continue;
        }
        if (!name.startsWith(`${slug}.`) || !(name.endsWith(".service") || name.endsWith(".timer"))) continue;
        const unit = isTimerUnit(name) ? name : name.slice(0, -".service".length);
        // `<slug>.<service>` and its timer: a dot more would be another
        // project's, `nis2.example` being no service of `nis2` but a slug
        // never has a dot either.
        if (/^[a-z0-9-]+\.[a-z0-9-]+(\.timer)?$/.test(unit)) units.push(unit);
      }
      return units.sort();
    },

    async deleteUnits(units) {
      for (const unit of units) rmSync(join(installer.unitsFolder, unitFileName(unit)), { force: true });
    },

    async moveDropIn(from, to) {
      const source = join(installer.unitsFolder, `${unitFileName(from)}.d`);
      if (!present(source)) return false;
      const destination = join(installer.unitsFolder, `${unitFileName(to)}.d`);
      if (present(destination)) throw new Error(`${destination} already exists`);
      renameSync(source, destination);
      return true;
    },

    async removePlace(place, slug) {
      rmSync(pathOf(place, slug), { recursive: true, force: true });
    },

    async setPublicAside(slug, aside) {
      const tree = pathOf("tree", slug);
      if (!present(tree)) return false;
      if (lstatSync(tree).isSymbolicLink()) throw new Error(`${tree} is not a folder`);
      const shown = join(tree, "public");
      const hidden = join(tree, PUBLIC_ASIDE);
      const [source, destination] = aside ? [shown, hidden] : [hidden, shown];
      if (!present(source)) return false;
      if (present(destination)) {
        // Whatever the project left under that name is no folder of ours: links inside are removed, never followed.
        if (aside) rmSync(destination, { recursive: true, force: true });
        else throw new Error(`${destination} already exists`);
      }
      renameSync(source, destination);
      return true;
    },

    async takeBackupLock(who, waitMs) {
      // The unit lays the folder before it starts, when no backup has run since boot.
      const taken = await waitForLock(config.backupRunFolder, who, config.backupLockWaitMs ?? waitMs, config.backupLockStepMs);
      return taken.ok ? taken.release : null;
    },

    async removeDropIn(unit) {
      rmSync(join(installer.unitsFolder, `${unitFileName(unit)}.d`), { recursive: true, force: true });
    },

    deleteAccount: (slug) => installer.removeAccount(slug),

    async writeManifest(slug, text, read) {
      await installer.machine.writeManifest(slug, text, read.permissions);
    },

    domainTable: {
      async read() {
        const examination = readBounded(config.domainTableFile, 4 * 1024 * 1024);
        if (examination.kind === "absent") return null;
        if (examination.bytes === null) throw new Error(`${config.domainTableFile} is not a plain file of a reasonable size`);
        return new TextDecoder().decode(examination.bytes);
      },
      async build(without) {
        const table = buildTable(config.sitesDir);
        for (const [name, folder] of table) if (folder === without) table.delete(name);
        return `${render(table)}\n`;
      },
      async write(text) {
        if (text === null) {
          rmSync(config.domainTableFile, { force: true });
          return;
        }
        if (!existsSync(dirname(config.domainTableFile))) throw new Error(`${dirname(config.domainTableFile)} is missing`);
        writeAtomically(dirname(config.domainTableFile), config.domainTableFile.slice(dirname(config.domainTableFile).length + 1), new TextEncoder().encode(text), { owner: null, mode: 0o644 });
      },
    },
  };
}
