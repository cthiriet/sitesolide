/**
 * The steward's inputs and outputs for the control API, and nothing else: the
 * team registry, the request it leaves for the installer, the installer's
 * results, the journal of a project, and what a removed project left under
 * its name. An interface, so that the tests mount the steward's control
 * routes on a throwaway tree with a simulated `systemctl`.
 *
 * Kept apart from src/secrets/system.ts, whose interface the secrets routes
 * own; the two careful primitives, the bounded read and the atomic write, are
 * borrowed from there rather than written a second time.
 *
 * Every file here is root's: the registry and the requests live in the
 * steward's own state directory, 0700, and the installer's results in its
 * runtime directory, 0700. Nothing is written where the dashboard could have
 * laid a link. The backups' index and the connectors' files are only read,
 * through the readers the steward's pages already use, with their checks.
 */
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBounded, writeAtomically, type Command, type Examination } from "../secrets/system";
import { DEPLOYMENT_ID_SHAPE, INSTALLER_TEMPLATE } from "./protocol";
import { CREATIONS_NAME } from "./creations";
import type { Leftovers } from "./policy";
import { isValidSlug } from "../../borrowed/manifest";
import type { BackupReader } from "../backup/reader";
import type { ConnectorStore } from "../connectors/store";

export type ControlSystemConfig = {
  /** /var/lib/sitesolide-steward */
  stateFolder: string;
  /** /srv/sites */
  sitesDir: string;
  /** /etc/systemd/system, where the installer's template must be. */
  unitsFolder: string;
  /** /run/sitesolide-installer */
  installerFolder: string;
  /** /usr/bin/systemctl */
  systemctl: string;
  /** /usr/bin/journalctl */
  journalctl: string;
  /**
   * The backups' index and the connectors' files, as the steward reads them
   * for its own pages (dashboard/steward.ts): what a removed project left
   * under its name, which a token may not create (`leftovers`). Null where
   * that component is not part of this steward, the tests that need neither;
   * the machine's steward always carries both, read as absent while the
   * component is not installed.
   */
  backups: BackupReader | null;
  connectors: ConnectorStore | null;
};

export type ControlSystem = {
  now: () => number;
  /** The registry's text, null when the file does not exist. Throws when it is there but unreadable. */
  readTeam: () => Promise<string | null>;
  writeTeam: (text: string) => Promise<void>;
  /** `installs/<slug>.json`, read by the installer when it starts. */
  writeRequest: (slug: string, text: string) => Promise<void>;
  /** The creations waiting for their installer's result (creations.ts), null when there is no file. */
  readCreations: () => Promise<string | null>;
  writeCreations: (text: string) => Promise<void>;
  /** Does the machine carry `/srv/sites/<slug>`? */
  projectExists: (slug: string) => Promise<boolean>;
  /** The deposited manifest's text, null when there is none. */
  readManifest: (slug: string) => Promise<string | null>;
  /**
   * What the machine keeps under this name whether or not it carries the
   * project: snapshots in the backups' index, connector grants. Throws when
   * either is there and does not read: what cannot be read is never taken
   * for nothing left (src/control/policy.ts, `leftoversReason`).
   */
  leftovers: (slug: string) => Promise<Leftovers>;
  /** Is the installer's template in place? Without it, nothing can start. */
  installerInstalled: () => Promise<boolean>;
  readResult: (deployment: string) => Promise<Examination>;
  systemctl: (arguments_: string[], timeoutMs: number) => Promise<Command>;
  /** `journalctl` for these units, its standard output as it is. */
  journal: (units: string[], lines: number, cursor: string | null, timeoutMs: number) => Promise<Command>;
};

/** A registry, a request, a result: none of them has a reason to be bigger. */
export const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const ROOT_ONLY = { owner: null, mode: 0o600 };

/** Spawns a command with an array of arguments, bounded in time, standard error dropped. */
async function run(command: string[], timeoutMs: number): Promise<Command> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "" },
  });
  const [output, code] = await Promise.all([process.stdout.text(), process.exited]);
  return { code, output };
}

export function createControlSystem(config: ControlSystemConfig): ControlSystem {
  const teamFile = join(config.stateFolder, "team.json");
  const requests = join(config.stateFolder, "installs");

  return {
    now: () => Date.now(),

    async readTeam() {
      const examination = readBounded(teamFile, MAX_CONTROL_FILE_BYTES);
      if (examination.kind === "absent") return null;
      if (examination.bytes === null) throw new Error("team.json is not a plain file of a reasonable size");
      return decoder.decode(examination.bytes);
    },

    async writeTeam(text) {
      mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });
      writeAtomically(config.stateFolder, "team.json", encoder.encode(text), ROOT_ONLY);
    },

    async readCreations() {
      const examination = readBounded(join(config.stateFolder, CREATIONS_NAME), MAX_CONTROL_FILE_BYTES);
      if (examination.kind === "absent") return null;
      if (examination.bytes === null) throw new Error("creations.json is not a plain file of a reasonable size");
      return decoder.decode(examination.bytes);
    },

    async writeCreations(text) {
      mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });
      writeAtomically(config.stateFolder, CREATIONS_NAME, encoder.encode(text), ROOT_ONLY);
    },

    async writeRequest(slug, text) {
      if (!isValidSlug(slug)) throw new Error("not a slug");
      mkdirSync(requests, { recursive: true, mode: 0o700 });
      writeAtomically(requests, `${slug}.json`, encoder.encode(text), ROOT_ONLY);
    },

    async projectExists(slug) {
      if (!isValidSlug(slug)) return false;
      try {
        // A link in /srv/sites counts as present: it is not a slug a token may take.
        lstatSync(join(config.sitesDir, slug));
        return true;
      } catch {
        return false;
      }
    },

    async readManifest(slug) {
      if (!isValidSlug(slug)) return null;
      const examination = readBounded(join(config.sitesDir, slug, "sitesolide.json"), MAX_MANIFEST);
      if (examination.kind === "absent" || examination.bytes === null) return null;
      try {
        return decoder.decode(examination.bytes);
      } catch {
        return null;
      }
    },

    async leftovers(slug) {
      if (!isValidSlug(slug)) throw new Error("not a slug");
      // The backups' folder is the project's slug, as /srv/sites names it.
      const snapshots = config.backups === null ? 0 : config.backups.held(slug);
      if (snapshots === null) throw new Error("the backups' index does not read");
      let grants = 0;
      const reading = config.connectors === null ? ({ kind: "absent" } as const) : config.connectors.read();
      // Absent: the egress proxy is not installed, and nothing is lent.
      if (reading.kind === "unmanaged") throw new Error(`the connectors' files do not read: ${reading.reason}`);
      if (reading.kind === "managed") grants = reading.grants.grants.filter((grant) => grant.slug === slug).length;
      return { snapshots, grants };
    },

    async installerInstalled() {
      try {
        readFileSync(join(config.unitsFolder, INSTALLER_TEMPLATE));
        return true;
      } catch {
        return false;
      }
    },

    async readResult(deployment) {
      if (!DEPLOYMENT_ID_SHAPE.test(deployment)) return { kind: "absent" };
      return readBounded(join(config.installerFolder, `${deployment}.json`), MAX_CONTROL_FILE_BYTES);
    },

    systemctl: (arguments_, timeoutMs) => run([config.systemctl, ...arguments_], timeoutMs),

    journal(units, lines, cursor, timeoutMs) {
      const selection = units.flatMap((unit) => ["-u", unit]);
      const after = cursor === null ? [] : [`--after-cursor=${cursor}`];
      return run(
        [config.journalctl, ...selection, "-n", String(lines), "--no-pager", "-o", "short-iso", "--show-cursor", ...after],
        timeoutMs,
      );
    },
  };
}
