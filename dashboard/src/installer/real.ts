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
 */
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Machine } from "../gatekeeper/machine";
import { readAccount, readBounded, writeAtomically } from "../secrets/system";
import { LOOPBACK_TABLE, PROJECT_PORTS_SET } from "../../borrowed/loopback";
import { isValidSlug } from "../../borrowed/manifest";
import { GENERATOR_MARK, MARKER_DONE, readCurrentPairs } from "../../borrowed/services";
import { systemdRunArguments, systemUser, unitArgument, type ProjectRun } from "../../borrowed/unit";
import { BUNDLE_NAME, DEPLOYMENT_ID_SHAPE, MAX_BUNDLE_BYTES } from "../control/protocol";
import type { ExtractOutcome } from "./extract";
import type { Execution, Host, Part } from "./host";

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
};

export type HostConfig = {
  /** /srv/sites */
  sitesDir: string;
  /** /etc/systemd/system */
  unitsFolder: string;
  /** /etc/sitesolide, whose files are checked present, never read. */
  secretsFolder: string;
  /** /srv/sites/dashboard/data/control */
  spoolFolder: string;
  /** /etc/passwd */
  accountsFile: string;
  /** /etc/sitesolide-loopback-projects.nft */
  projectPortsFile: string;
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

export function realCommands(paths: { systemctl: string; useradd: string; userdel: string; systemdRun: string; nft: string }): Commands {
  return {
    systemctl: (arguments_, timeoutMs) => spawn([paths.systemctl, ...arguments_], timeoutMs),
    useradd: (account) => spawn([paths.useradd, "--system", "--no-create-home", "--shell", "/usr/sbin/nologin", account], 30_000),
    // No --remove: the account has no home, and its files go with the tree
    // before it, as `sitesolide remove` orders it (bin/cli/removal.ts).
    userdel: (account) => spawn([paths.userdel, account], 30_000),
    asProject: (run) => spawn(systemdRunArguments(run, paths.systemdRun), (run.timeoutS + 30) * 1000, { stdin: run.stdin }),
    nft: (arguments_, timeoutMs) => spawn([paths.nft, ...arguments_], timeoutMs),
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

export function createHost(config: HostConfig): Host {
  const now = config.now ?? Date.now;
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
    machine: config.machine,

    async readManifests() {
      const manifests = new Map<string, string>();
      for (const entry of readdirSync(config.sitesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const examination = readBounded(join(config.sitesDir, entry.name, "sitesolide.json"), 256 * 1024);
        if (examination.kind === "present" && examination.bytes !== null) manifests.set(entry.name, decoder.decode(examination.bytes));
      }
      return manifests;
    },

    async readUnit(unit) {
      const examination = readBounded(join(config.unitsFolder, `${unit}.service`), 256 * 1024);
      return examination.kind === "present" && examination.bytes !== null ? decoder.decode(examination.bytes) : null;
    },

    async generatedUnits(slug) {
      if (!isValidSlug(slug)) throw new Error("invalid slug");
      const units: string[] = [];
      for (const name of readdirSync(config.unitsFolder)) {
        if (!name.startsWith(`${slug}.`) || !name.endsWith(".service")) continue;
        const unit = name.slice(0, -".service".length);
        if (!/^[a-z0-9.-]+$/.test(unit) || unit === slug) continue;
        const examination = readBounded(join(config.unitsFolder, name), 256 * 1024);
        if (examination.kind !== "present" || examination.bytes === null) continue;
        const text = decoder.decode(examination.bytes);
        // The same test as listUnitsCommand of bin/cli/services.ts: a unit
        // the generator wrote, hanging on the project's main one.
        if (text.split("\n").includes(`PartOf=${slug}.service`) && text.includes("generated by bin/sitesolide.ts")) units.push(unit);
      }
      return units.sort();
    },

    unitsFolder: config.unitsFolder,

    async unitFacts(slug, unit) {
      if (!isValidSlug(slug) || (unit !== slug && !(unit.startsWith(`${slug}.`) && /^[a-z0-9.-]+$/.test(unit)))) throw new Error("invalid unit");
      const shown = await config.commands.systemctl(["show", "-p", "LoadState", "-p", "FragmentPath", `${unit}.service`], 10_000);
      if (shown.code !== 0) return null;
      const fields = new Map(shown.output.split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()] as const] : [])));
      const loadState = fields.get("LoadState");
      const fragmentPath = fields.get("FragmentPath") ?? "";
      if (loadState === undefined || loadState === "") return null;
      // The file is read, bounded, without following a link: what it says is
      // only whether the generator wrote it, or whether it serves this project.
      let text = "";
      try {
        const examination = fragmentPath === "" ? null : readBounded(fragmentPath, 256 * 1024);
        if (examination !== null && examination.kind === "present" && examination.bytes !== null) text = decoder.decode(examination.bytes);
      } catch {
        // Unreadable: neither mark nor project, so foreign unless absent.
      }
      return { loadState, fragmentPath, generated: text.includes(GENERATOR_MARK), project: text.includes(`/srv/sites/${slug}/`) };
    },

    async secretPresent(name) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return false;
      try {
        return lstatSync(join(config.secretsFolder, name)).isFile();
      } catch {
        return false;
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
        return found;
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
      writeAtomically(config.unitsFolder, `${unit}.service`, encoder.encode(text), { owner: null, mode: 0o644 });
    },

    async removeUnits(units) {
      const names = units.map(unitArgument);
      await config.commands.systemctl(["disable", "--now", ...names], 60_000);
      for (const unit of units) rmSync(join(config.unitsFolder, `${unit}.service`), { force: true });
      await config.commands.systemctl(["daemon-reload"], 60_000);
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
