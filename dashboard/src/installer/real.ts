/**
 * The installer's real host: the disk, `useradd`, `systemctl`, `systemd-run`
 * and `nft`, every path and every command from `HostConfig`, so that the tests
 * mount it as it stands on a throwaway tree with the commands replaced.
 *
 * It decides nothing: pipeline.ts does, with the modules borrowed from
 * bin/cli/. What lives here is the care each write needs.
 *
 * **What the project's account does, and what root does.** The archive is
 * read by the project's account alone, inside a transient unit started with
 * `systemd-run`, which sees nothing of /srv but the staging directory, has no
 * network and a memory ceiling; root hands it the archive on its standard
 * input, through a descriptor opened with `O_NOFOLLOW` on a file it checked
 * belongs to the dashboard. `install` runs the same way, with the network (a
 * package manager fetches), but not the loopback, and with the staged `app/`
 * mounted at the project's final path, so that what it writes in absolute
 * paths (a Python virtualenv) is right once in place. Root only moves the
 * staged trees into place, after handing them to the deployment account: the
 * code stays out of the service's reach, as over SSH.
 *
 * **A project's store of secrets** is root's: its folders are laid here as
 * the SSH path lays them (bin/cli/store.ts, `storePrepareCommand`), each one
 * opened without following a link and changed through its descriptor, and
 * its names read back for the log. Never a value: the env file is parsed
 * for its names alone, and a file's content is never opened.
 */
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import type { Machine } from "../gatekeeper/machine";
import { readAccount, readBounded, writeAtomically } from "../secrets/system";
import { autobindReachesBlocks, LOOPBACK_TABLE, PROJECT_PORTS_SET, reservesEveryBlock } from "../../borrowed/loopback";
import { isValidFileName, isValidSchedule, isValidSlug } from "../../borrowed/manifest";
import { keys, parseEnvBytes } from "../../borrowed/envfile";
import { MAX_STORE_ENV_BYTES, STORE_FOLDER_MODE, STORE_PREVIOUS_ROOT, storePaths } from "../../borrowed/store";
import { COMPONENTS_FOLDER, GENERATOR_MARK, MARKER_DONE, readAccounts, readCurrentPairs, readListeners, readStability, type ComponentState, type Listener } from "../../borrowed/services";
import { BIND_LINES_FEATURE, BIND_PROPERTIES, isTimerUnit, readBindStates, systemdRunArguments, systemUser, unitArgument, unitFileName, type BindState, type ProjectRun } from "../../borrowed/unit";
import { zoneNamesScript } from "../../borrowed/zone-names";
import { BUNDLE_NAME, DEPLOYMENT_ID_SHAPE, MAX_BUNDLE_BYTES } from "../control/protocol";
import type { ExtractOutcome } from "./extract";
import type { Execution, Host, Standing } from "./host";

/**
 * One program run as the project's account, and the `systemd-run` line that
 * confines it: in bin/cli/unit.ts, which `sitesolide deploy` runs its
 * `install` with over SSH too, so that both paths build the same walls.
 */
export { systemdRunArguments, type ProjectRun };

export type Commands = {
  systemctl: (arguments_: string[], timeoutMs: number) => Promise<Execution>;
  useradd: (account: string) => Promise<Execution>;
  userdel: (account: string) => Promise<Execution>;
  asProject: (run: ProjectRun) => Promise<Execution>;
  nft: (arguments_: string[], timeoutMs: number) => Promise<Execution>;
  /** `systemd-analyze`, for `calendar` alone: a reading of a schedule, which needs no manager. */
  systemdAnalyze: (arguments_: string[], timeoutMs: number) => Promise<Execution>;
  /** `/bin/sh -c`, for a script of the platform's own, never one a manifest wrote: the zone's sites. */
  shell: (script: string, timeoutMs: number) => Promise<Execution>;
};

export type HostConfig = {
  /** /srv/sites */
  sitesDir: string;
  /** /etc/systemd/system */
  unitsFolder: string;
  /** /etc/sitesolide, whose files are checked present, never read; the stores are under its `projects/`. */
  secretsFolder: string;
  /**
   * /var/lib/sitesolide-steward/precedents/projects, the previous versions
   * of each store the steward keeps: `STORE_PREVIOUS_ROOT` when absent.
   */
  storePreviousFolder?: string;
  /** /var/lib/sitesolide-steward/claims.json, the tokens' claims the steward writes; read alone. */
  claimsFile?: string;
  /** /srv/sites/dashboard/data/control */
  spoolFolder: string;
  /** /etc/passwd */
  accountsFile: string;
  /** /etc/sitesolide-loopback-projects.nft */
  projectPortsFile: string;
  /** /usr/local/lib/sitesolide/backup.js, searched for this release's bind lines; absent, no backup runs. */
  backupScript?: string;
  /** /proc/sys/net/ipv4, where the kernel's ephemeral range and reserved ports are read. */
  procNetFolder?: string;
  /** /proc/net/tcp and tcp6, the kernel's listening sockets and the uid of each. */
  procNetTcp?: string[];
  /** /etc/caddy/tls-zone.caddy, whose policy says whether the zone is certified on demand. */
  tlsZoneFile: string;
  /** /etc/caddy/zone-names, the zone's sites the ask endpoint allows on demand. */
  zoneNamesFile: string;
  /**
   * The account that owns the served trees and the manifest, as the SSH path
   * leaves them: the one `sitesolide init` names in `server`. null on the
   * workstation, where nothing is handed over.
   */
  deployAccount: string | null;
  /** The account the staged archives must belong to, `site-dashboard`. null: unchecked. */
  dashboardAccount: string | null;
  /** The program that extracts, `--extract <dir>` appended: bun and installer.js. */
  extractor: string[];
  machine: Machine;
  commands: Commands;
  log: (line: string) => void;
  /** Told when this deployment made the project's folder, and when it took it away again. */
  laid?: (laid: boolean) => void;
  now?: () => number;
};

/** Entries a staged tree may hold once `install` has run: node_modules counts tens of thousands. */
export const MAX_TREE_ENTRIES = 500_000;

const STAGING = ".incoming";
const ASIDE = ".previous-";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function code(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** A manifest or a unit file, read without following a link and within 256 KiB; null when missing or not a plain file. */
function readText(path: string): string | null {
  const examination = readBounded(path, 256 * 1024);
  return examination.kind === "present" && examination.bytes !== null ? decoder.decode(examination.bytes) : null;
}

/** Runs a command bounded in time, standard error folded into the output, never throwing. */
export async function spawn(command: string[], timeoutMs: number, options: { stdin?: number | Uint8Array | null; cwd?: string } = {}): Promise<Execution> {
  try {
    const process = Bun.spawn(command, {
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", SYSTEMD_COLORS: "0" },
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exit] = await Promise.all([process.stdout.text(), process.stderr.text(), process.exited]);
    return { code: exit, output: `${stdout}${stderr === "" ? "" : `\n${stderr}`}` };
  } catch (error) {
    return { code: 127, output: `cannot run ${command[0]}: ${(error as Error).message}` };
  }
}

export function realCommands(paths: { systemctl: string; useradd: string; userdel: string; systemdRun: string; nft: string; systemdAnalyze: string }): Commands {
  return {
    systemctl: (arguments_, timeoutMs) => spawn([paths.systemctl, ...arguments_], timeoutMs),
    useradd: (account) => spawn([paths.useradd, "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", account], 30_000),
    // No --remove: the account has no home, and its files go with the tree
    // before it, as `sitesolide remove` orders it (bin/cli/removal.ts).
    userdel: (account) => spawn([paths.userdel, account], 30_000),
    asProject: (run) => spawn(systemdRunArguments(run, paths.systemdRun), (run.timeoutS + 30) * 1000, { stdin: run.stdin }),
    nft: (arguments_, timeoutMs) => spawn([paths.nft, ...arguments_], timeoutMs),
    systemdAnalyze: (arguments_, timeoutMs) => spawn([paths.systemdAnalyze, ...arguments_], timeoutMs),
    shell: (script, timeoutMs) => spawn(["/bin/sh", "-c", script], timeoutMs),
  };
}

/** Every entry under a directory, depth first, without following a link. */
function walk(root: string, visit: (path: string) => void, max = MAX_TREE_ENTRIES): void {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      count++;
      if (count > max) throw new Error(`more than ${max} entries in the staged tree`);
      visit(path);
      if (lstatSync(path).isDirectory()) pending.push(path);
    }
  }
}

/**
 * The exit status of each unit's main process, from a `systemctl show` that
 * asked for `ExecMainStatus`, by unit as named; a unit systemd says nothing
 * of is left out.
 */
export function exitStatuses(output: string, units: string[]): Map<string, number> {
  const byId = new Map(units.map((unit) => [unitFileName(unit), unit]));
  const statuses = new Map<string, number>();
  for (const block of output.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const equal = line.indexOf("=");
      if (equal > 0) fields.set(line.slice(0, equal).trim(), line.slice(equal + 1).trim());
    }
    const unit = byId.get(fields.get("Id") ?? "");
    const status = Number(fields.get("ExecMainStatus"));
    if (unit !== undefined && fields.has("ExecMainStatus") && Number.isInteger(status)) statuses.set(unit, status);
  }
  return statuses;
}

export function createHost(config: HostConfig): Host {
  const now = config.now ?? Date.now;
  const storeRoot = join(config.secretsFolder, "projects");
  const claimsFile = config.claimsFile ?? "/var/lib/sitesolide-steward/claims.json";
  const storePrevious = config.storePreviousFolder ?? STORE_PREVIOUS_ROOT;
  const root = (slug: string) => {
    if (!isValidSlug(slug)) throw new Error("invalid slug");
    return join(config.sitesDir, slug);
  };

  function account(name: string): { uid: number; gid: number } | null {
    return readAccount(readFileSync(config.accountsFile, "utf8"), name);
  }

  /** The deployment account's ids, or null on the workstation. Missing when it should be there: an error. */
  function deployIds(): { uid: number; gid: number } | null {
    if (config.deployAccount === null) return null;
    const ids = account(config.deployAccount);
    if (ids === null) throw new Error(`the deployment account ${config.deployAccount} does not exist`);
    return ids;
  }

  function projectIds(slug: string): { uid: number; gid: number } | null {
    if (config.deployAccount === null) return null;
    const ids = account(systemUser(slug));
    if (ids === null) throw new Error(`${systemUser(slug)} does not exist`);
    return ids;
  }

  return {
    now,
    log: config.log,
    laid: config.laid ?? (() => undefined),
    machine: config.machine,

    async readManifests() {
      const manifests = new Map<string, string>();
      for (const entry of readdirSync(config.sitesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const text = readText(join(config.sitesDir, entry.name, "sitesolide.json"));
        if (text !== null) manifests.set(entry.name, text);
      }
      return manifests;
    },

    async readUnit(unit) {
      return readText(join(config.unitsFolder, unitFileName(unit)));
    },

    async generatedUnits(slug) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      const units: string[] = [];
      for (const name of readdirSync(config.unitsFolder)) {
        if (!name.startsWith(`${slug}.`) || !(name.endsWith(".service") || name.endsWith(".timer"))) continue;
        // A service by its name without `.service`, a timer by its own, as
        // listUnitsCommand of bin/cli/services.ts prints them.
        const unit = isTimerUnit(name) ? name : name.slice(0, -".service".length);
        if (!/^[a-z0-9.-]+$/.test(unit) || unit === slug) continue;
        const text = readText(join(config.unitsFolder, name));
        if (text === null) continue;
        // The same test as listUnitsCommand of bin/cli/services.ts: a unit
        // the generator wrote, hanging on the project's main one.
        if (text.split("\n").includes(`PartOf=${slug}.service`) && text.includes("generated by bin/sitesolide.ts")) units.push(unit);
      }
      return units.sort();
    },

    unitsFolder: config.unitsFolder,

    async secondBlockState() {
      const table = await config.commands.nft(["list", "table", "inet", LOOPBACK_TABLE], 10_000);
      if (table.code === 127) return null;
      // Every service unit file, followed as systemd follows it: a dangling
      // link or /dev/null, a masked unit, is no file and runs nothing, and a
      // template runs nothing by itself. As secondBlockStateCommand skips them.
      let names: string[];
      try {
        names = readdirSync(config.unitsFolder)
          .filter((name) => name.endsWith(".service") && !name.endsWith("@.service"))
          .filter((name) => {
            try {
              return statSync(join(config.unitsFolder, name)).isFile();
            } catch (error) {
              if (code(error) === "ENOENT" || code(error) === "ELOOP") return false;
              throw error;
            }
          })
          .sort();
      } catch {
        return null;
      }
      let units: BindState[] = [];
      if (names.length > 0) {
        // One block per file, from a systemctl that succeeded: a failure, a
        // timeout or an answer cut off is no answer, never a machine with no
        // unit at fault.
        const shown = await config.commands.systemctl(["show", ...BIND_PROPERTIES.flatMap((property) => ["-p", property]), "--", ...names], 10_000);
        if (shown.code !== 0) return null;
        const read = readBindStates(shown.output);
        if (read === null || read.length !== names.length) return null;
        units = read;
      }
      // What already listens on a port of a later block, and as whom.
      let listeners: Listener[] | null;
      try {
        const accounts = readAccounts(readFileSync(config.accountsFile, "utf8"));
        const lines: string[] = [];
        for (const [i, file] of (config.procNetTcp ?? ["/proc/net/tcp", "/proc/net/tcp6"]).entries()) {
          try {
            lines.push(...readFileSync(file, "utf8").split("\n").slice(1));
          } catch (error) {
            // tcp6 is absent from a kernel booted without IPv6; tcp never is.
            if (i === 0 || code(error) !== "ENOENT") throw error;
          }
        }
        listeners = accounts === null ? null : readListeners(lines, accounts);
      } catch {
        return null;
      }
      if (listeners === null) return null;
      // This installer is the current one, by being the one that runs.
      let backup: ComponentState;
      try {
        backup = readFileSync(config.backupScript ?? `${COMPONENTS_FOLDER}/backup.js`, "utf8").includes(BIND_LINES_FEATURE) ? "current" : "outdated";
      } catch (error) {
        if (code(error) !== "ENOENT") return null;
        backup = "absent";
      }
      const proc = config.procNetFolder ?? "/proc/sys/net/ipv4";
      let autobind: boolean | null;
      try {
        // readFileSync: procfs announces a size of zero bytes.
        autobind = autobindReachesBlocks(readFileSync(join(proc, "ip_local_port_range"), "utf8"), readFileSync(join(proc, "ip_local_reserved_ports"), "utf8"));
      } catch {
        return null;
      }
      if (autobind === null) return null;
      return { reserved: table.code === 0 && reservesEveryBlock(table.output), units, components: { backup, installer: "current" }, listeners, autobind };
    },

    async unitFacts(slug, unit) {
      if (!isValidSlug(slug) || (unit !== slug && !(unit.startsWith(`${slug}.`) && /^[a-z0-9.-]+$/.test(unit)))) throw new Error("invalid unit");
      const shown = await config.commands.systemctl(["show", "-p", "LoadState", "-p", "FragmentPath", unitFileName(unit)], 10_000);
      if (shown.code !== 0) return null;
      const fields = new Map(shown.output.split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const] : [])));
      const loadState = fields.get("LoadState");
      const fragmentPath = fields.get("FragmentPath") ?? "";
      if (loadState === undefined || loadState === "") return null;
      // The file is read, bounded, without following a link: what it says is
      // only whether the generator wrote it, or whether it serves this project.
      let text = "";
      try {
        text = (fragmentPath === "" ? null : readText(fragmentPath)) ?? "";
      } catch {
        // Unreadable: neither mark nor project, so foreign unless absent.
      }
      return { loadState, fragmentPath, generated: text.includes(GENERATOR_MARK), project: text.includes(`/srv/sites/${slug}/`) };
    },

    refreshZoneNames() {
      return config.commands.shell(zoneNamesScript({ sites: config.sitesDir, policy: config.tlsZoneFile, names: config.zoneNamesFile }), 30_000);
    },

    async refusedSchedules(schedules) {
      const refused: string[] = [];
      for (const schedule of schedules) {
        // validate() has judged it already; the second barrier, as
        // scheduleCheckCommand has: nothing it refuses reaches a command.
        if (!isValidSchedule(schedule)) throw new Error(`invalid schedule: ${schedule}`);
        // One argument, never a shell: the expression reaches systemd as written.
        // It exits 1 on an expression it cannot parse; any other failure, a
        // program missing or stopped for its time, says nothing of the schedule.
        const read = await config.commands.systemdAnalyze(["calendar", schedule], 10_000);
        if (read.code === 1) refused.push(schedule);
        else if (read.code !== 0) return null;
      }
      return refused;
    },

    async standing(units) {
      for (const unit of units) {
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(unit)) throw new Error("invalid unit");
      }
      const shown = await config.commands.systemctl(
        ["show", "-p", "Id", "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts", "-p", "ExecMainStatus", ...units.map(unitArgument)],
        10_000,
      );
      if (shown.code !== 0) return null;
      // The marker readStability expects after a complete answer, which a
      // command that exited 0 has given.
      const read = readStability(`${shown.output}\n${MARKER_DONE}\n`, units);
      if (read === null) return null;
      const statuses = exitStatuses(shown.output, units);
      return new Map<string, Standing>([...read].map(([unit, standing]) => [unit, { ...standing, status: statuses.get(unit) ?? null }]));
    },

    async storeNames(slug) {
      const { env, files } = storePaths(slug, storeRoot);
      try {
        let variables: string[] = [];
        const examination = readBounded(env, MAX_STORE_ENV_BYTES);
        if (examination.kind === "present") {
          if (examination.bytes === null) return null;
          const parsed = parseEnvBytes(examination.bytes);
          if (!parsed.ok) {
            // The reason names a line and what is wrong with it, never its content.
            config.log(`   !! the store's env does not read back (line ${parsed.line}: ${parsed.reason}): systemd may ignore all of it`);
            return null;
          }
          variables = keys(parsed.document);
        }
        const present: string[] = [];
        let entries: string[];
        try {
          entries = readdirSync(files);
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
          entries = [];
        }
        for (const name of entries) {
          // What LoadCredential= loads: a regular file, never a link, a dot
          // file or a name the store refuses.
          if (!isValidFileName(name)) continue;
          const stat = lstatSync(join(files, name));
          if (stat.isFile() && stat.size > 0) present.push(name);
        }
        return { variables, files: present.sort() };
      } catch {
        return null;
      }
    },

    async ensureAccount(slug) {
      const name = systemUser(slug);
      if (account(name) !== null) return "present";
      const created = await config.commands.useradd(name);
      if (created.code !== 0 || account(name) === null) throw new Error(`useradd ${name} failed: ${created.output.trim().slice(0, 200)}`);
      return "created";
    },

    async prepareTree(slug, application) {
      const base = root(slug);
      const existed = existsSync(base);
      const folders = application ? [base, join(base, "app"), join(base, "public")] : [base, join(base, "public")];
      for (const folder of folders) mkdirSync(folder, { recursive: true, mode: 0o755 });
      const deploy = deployIds();
      for (const folder of folders) {
        if (deploy !== null) chownSync(folder, deploy.uid, deploy.gid);
        chmodSync(folder, 0o755);
      }
      if (!application) return existed ? "present" : "created";
      // The data folder is the service's own, and the only one it writes. Its
      // content is never walked: a link the service laid there must not lead
      // root's chown elsewhere.
      const data = join(base, "data");
      const created = !existsSync(data);
      mkdirSync(data, { recursive: true, mode: 0o750 });
      const owner = projectIds(slug);
      if (owner !== null && (created || lstatSync(data).uid === 0)) chownSync(data, owner.uid, owner.gid);
      chmodSync(data, 0o750);
      return existed ? "present" : "created";
    },

    async readClaims() {
      const examination = readBounded(claimsFile, 1024 * 1024);
      if (examination.kind === "absent") return null;
      if (examination.bytes === null) throw new Error("claims.json is not a plain file of a reasonable size");
      return decoder.decode(examination.bytes);
    },

    async prepareStore(slug) {
      // storePaths throws on a slug that is not valid: no path is built from one.
      const { folder, files } = storePaths(slug, storeRoot);
      const previous = join(storePrevious, slug);
      let created = false;
      for (const path of [storeRoot, folder, files]) {
        let stat: Stats | null = null;
        try {
          stat = lstatSync(path);
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
        }
        if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) return { kind: "refused", path };
        if (stat === null) {
          // A slug removed and created again must not find its predecessor's
          // previous versions to restore.
          if (path === folder) {
            rmSync(previous, { recursive: true, force: true });
            created = true;
          }
          mkdirSync(path, { mode: STORE_FOLDER_MODE });
        }
        // Changed through a descriptor opened without following a link: a
        // link laid between the reading above and here is never followed.
        let fd: number;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        } catch (error) {
          if (code(error) === "ELOOP" || code(error) === "ENOTDIR") return { kind: "refused", path };
          throw error;
        }
        try {
          if (!fstatSync(fd).isDirectory()) return { kind: "refused", path };
          // Root's on the machine; on the workstation, nothing is handed over.
          if (config.deployAccount !== null) fchownSync(fd, 0, 0);
          fchmodSync(fd, STORE_FOLDER_MODE);
        } finally {
          closeSync(fd);
        }
      }
      return { kind: "ready", created };
    },

    async removeStore(slug) {
      const { folder, files } = storePaths(slug, storeRoot);
      // rmdir alone: a folder that holds anything, a file the steward wrote
      // since, stays.
      for (const path of [files, folder]) {
        try {
          rmdirSync(path);
        } catch (error) {
          if (code(error) === "ENOTEMPTY" || code(error) === "EEXIST") return false;
          if (code(error) !== "ENOENT") throw error;
        }
      }
      return true;
    },

    async stage(slug) {
      const staging = join(root(slug), STAGING);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { mode: 0o755 });
      const owner = projectIds(slug);
      if (owner !== null) chownSync(staging, owner.uid, owner.gid);
      return staging;
    },

    async extract(slug, deployment, staging) {
      if (!DEPLOYMENT_ID_SHAPE.test(deployment)) return { ok: false, reason: "not a deployment id" };
      const folder = join(config.spoolFolder, deployment);
      try {
        const stat = lstatSync(folder);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: "the staged archive's folder is not a plain directory" };
      } catch {
        return { ok: false, reason: "the archive is not in the dashboard's spool any more: deploy again" };
      }
      let fd: number;
      try {
        fd = openSync(join(folder, BUNDLE_NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        return { ok: false, reason: "the archive is not in the dashboard's spool any more: deploy again" };
      }
      try {
        // Whatever path led here, the file read is the dashboard's own: a
        // regular file, one link, of the dashboard's account. Nothing root
        // alone could read passes to the project's account.
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BUNDLE_BYTES) return { ok: false, reason: "the staged archive is not a plain file of a reasonable size" };
        if (config.dashboardAccount !== null) {
          const dashboard = account(config.dashboardAccount);
          if (dashboard === null || stat.uid !== dashboard.uid) return { ok: false, reason: "the staged archive does not belong to the dashboard" };
        }
        const ran = await config.commands.asProject({
          slug,
          purpose: "extract",
          command: [...config.extractor, "--extract", staging],
          stdin: fd,
          binds: [{ source: staging, target: staging }],
          workingDirectory: null,
          network: false,
          timeoutS: 300,
          memory: "256M",
        });
        const last = ran.output.trim().split("\n").filter((line) => line.startsWith("{")).pop();
        let outcome: ExtractOutcome | null = null;
        try {
          outcome = last === undefined ? null : (JSON.parse(last) as ExtractOutcome);
        } catch {
          outcome = null;
        }
        if (outcome === null || typeof outcome.ok !== "boolean") {
          return { ok: false, reason: `the extraction gave no verdict (exit ${ran.code}): the owner must read journalctl -u sitesolide-installer@${slug}` };
        }
        if (outcome.ok && ran.code !== 0) return { ok: false, reason: `the extraction exited ${ran.code}` };
        return outcome;
      } finally {
        closeSync(fd);
      }
    },

    async hasFiles(staging, part) {
      const folder = join(staging, part);
      if (!existsSync(folder)) return false;
      let found = false;
      try {
        walk(folder, (path) => {
          if (!found && lstatSync(path).isFile()) found = true;
        });
      } catch {
        // Past MAX_TREE_ENTRIES, or a name gone meanwhile: what was found stands.
      }
      return found;
    },

    async install(slug, staging, command) {
      const app = join(staging, "app");
      mkdirSync(app, { recursive: true, mode: 0o755 });
      const target = join(root(slug), "app");
      // The command on the shell's standard input, never in its arguments:
      // systemd expands `$VAR` and `%` specifiers in a unit's command line, and
      // the manifest's text must reach `sh` exactly as it was written.
      return config.commands.asProject({
        slug,
        purpose: "install",
        command: ["/bin/sh", "-s"],
        stdin: encoder.encode(`${command}\n`),
        binds: [{ source: app, target }],
        workingDirectory: target,
        network: true,
        timeoutS: 900,
        memory: "1G",
      });
    },

    async place(slug, staging, parts) {
      const base = root(slug);
      const deploy = deployIds();
      for (const part of parts) {
        const staged = join(staging, part);
        if (!existsSync(staged)) mkdirSync(staged, { mode: 0o755 });
        // Handed to the deployment account, links included and never
        // followed: the service must not be able to rewrite its own code.
        if (deploy !== null) {
          lchownSync(staged, deploy.uid, deploy.gid);
          walk(staged, (path) => lchownSync(path, deploy.uid, deploy.gid));
        }
        chmodSync(staged, 0o755);
      }
      for (const part of parts) {
        const final = join(base, part);
        const aside = join(base, `${ASIDE}${part}`);
        rmSync(aside, { recursive: true, force: true });
        // A rename each way: Caddy serves the new public/ from one instant to
        // the next, and the running service keeps the app/ it was started on
        // until its restart, its bind mount following the directory.
        if (existsSync(final)) renameSync(final, aside);
        renameSync(join(staging, part), final);
      }
    },

    async cleanUp(slug) {
      const base = root(slug);
      for (const name of [STAGING, `${ASIDE}app`, `${ASIDE}public`]) rmSync(join(base, name), { recursive: true, force: true });
    },

    async removeTree(slug) {
      const base = root(slug);
      // A manifest is the one thing this deployment never laid before it
      // stopped: one there was deposited by somebody else since.
      if (existsSync(join(base, "sitesolide.json"))) return false;
      // Links inside are removed, never followed.
      rmSync(base, { recursive: true, force: true });
      return true;
    },

    async removeAccount(slug) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      return config.commands.userdel(systemUser(slug));
    },

    async depositManifest(slug, text) {
      const deploy = deployIds();
      const ids = deploy ?? { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
      await config.machine.writeManifest(slug, text, { uid: ids.uid, gid: ids.gid, mode: 0o644 });
      // The leftovers bin/sitesolide.ts removes on every deposit, for the
      // reasons depositManifest gives there.
      for (const leftover of [join(root(slug), "site.json"), join(root(slug), "app", "sitesolide.json")]) {
        try {
          unlinkSync(leftover);
        } catch (error) {
          if (code(error) !== "ENOENT") throw error;
        }
      }
    },

    async installUnit(unit, text) {
      writeAtomically(config.unitsFolder, unitFileName(unit), encoder.encode(text), { owner: null, mode: 0o644 });
    },

    async removeUnits(units) {
      // The timers first, as removeUnitsCommand of bin/cli/services.ts
      // orders them: none starts its service between that service's stop and
      // its removal.
      const ordered = [...units.filter(isTimerUnit), ...units.filter((unit) => !isTimerUnit(unit))];
      await config.commands.systemctl(["disable", "--now", ...ordered.map(unitArgument)], 60_000);
      for (const unit of ordered) rmSync(join(config.unitsFolder, unitFileName(unit)), { force: true });
      await config.commands.systemctl(["daemon-reload"], 60_000);
      // A failed unit stays in systemd's memory once its file is gone, a
      // scheduled service after a run that failed among them: cleared, as
      // removeUnitsCommand clears it.
      await config.commands.systemctl(["reset-failed", ...ordered.map(unitArgument)], 60_000);
    },

    async enable(slug) {
      const reload = await config.commands.systemctl(["daemon-reload"], 60_000);
      if (reload.code !== 0) throw new Error("systemctl daemon-reload failed");
      const enabled = await config.commands.systemctl(["enable", slug], 60_000);
      if (enabled.code !== 0) throw new Error(`systemctl enable ${slug} failed`);
    },

    async restart(units) {
      // A release that crash-looped past the start limit leaves its unit
      // refusing any start, this restart included, until it is reset. A unit
      // that is not failed is left as it is, so the answer does not matter.
      await config.commands.systemctl(["reset-failed", ...units], 10_000);
      const restarted = await config.commands.systemctl(["restart", ...units], 120_000);
      if (restarted.code !== 0) return restarted;
      return config.commands.systemctl(["is-active", ...units], 10_000);
    },

    loopback: {
      async state() {
        const table = await config.commands.nft(["list", "table", "inet", LOOPBACK_TABLE], 10_000);
        if (table.code === 127) return "unreadable";
        if (table.code !== 0) return "none";
        const set = await config.commands.nft(["list", "set", "inet", LOOPBACK_TABLE, PROJECT_PORTS_SET], 10_000);
        return set.code === 0 ? "set" : "table";
      },
      async pairs() {
        const listed = await config.commands.nft(["list", "set", "inet", LOOPBACK_TABLE, PROJECT_PORTS_SET], 10_000);
        return listed.code === 0 ? readCurrentPairs(`${listed.output}\n${MARKER_DONE}\n`) : null;
      },
      async filePresent() {
        return existsSync(config.projectPortsFile);
      },
      async uids(slugs) {
        const uids = new Map<string, number>();
        for (const slug of slugs) {
          const ids = account(systemUser(slug));
          if (ids === null) return null;
          uids.set(slug, ids.uid);
        }
        return uids;
      },
      async write(content, apply) {
        const staging = `${config.projectPortsFile}.new`;
        writeFileSync(staging, content, { mode: 0o644 });
        if (apply) {
          for (const arguments_ of [["-c", "-f", staging], ["-f", staging]]) {
            const ran = await config.commands.nft(arguments_, 10_000);
            if (ran.code !== 0) {
              rmSync(staging, { force: true });
              return ran;
            }
          }
        }
        renameSync(staging, config.projectPortsFile);
        return { code: 0, output: "" };
      },
    },
  };
}
