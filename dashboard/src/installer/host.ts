/**
 * What the installer asks of the machine, and nothing more.
 *
 * An interface so that the pipeline is tested without a VM, as the gatekeeper's
 * transaction is: the tests mount the real host (real.ts) on a throwaway tree,
 * with `systemctl`, `useradd`, `systemd-run`, `nft` and Caddy replaced, or a
 * simulated host that fails at the wanted step. The decisions live in
 * pipeline.ts and in the modules borrowed from bin/cli/; this file carries only
 * shapes.
 */
import type { Machine } from "../gatekeeper/machine";
import type { LoopbackState, UnitFacts } from "../../borrowed/services";
import type { ExtractOutcome } from "./extract";

export type Execution = { code: number; output: string };

/** The two trees a deployment replaces. */
export type Part = "app" | "public";

export type Host = {
  now: () => number;
  /** One line of the deployment's log, which the client follows. Never a secret. */
  log: (line: string) => void;

  /** The gatekeeper's machine: Caddy's lock, the blocks, validate, reload, probe. */
  machine: Machine;

  /** Every deposited manifest, by directory name. Throws when the listing cannot be read. */
  readManifests: () => Promise<Map<string, string>>;
  /** One unit file's text, null when it does not exist. */
  readUnit: (unit: string) => Promise<string | null>;
  /** The project's secondary units `deploy` generated, `<slug>.<name>`. */
  generatedUnits: (slug: string) => Promise<string[]>;
  /** What systemd knows of a unit, wherever it reads it from; null when systemctl did not answer. */
  unitFacts: (slug: string, unit: string) => Promise<UnitFacts | null>;
  /** Where this host's systemd reads the units it lays: /etc/systemd/system. */
  unitsFolder: string;
  /** Is the secret file in /etc/sitesolide? Its content is never read. */
  secretPresent: (name: string) => Promise<boolean>;

  /** Creates `site-<slug>` when it is missing. */
  ensureAccount: (slug: string) => Promise<"created" | "present">;
  /** The project's directories, owners and modes, as `directoryCommands` of bin/sitesolide.ts sets them. */
  prepareTree: (slug: string, application: boolean) => Promise<void>;
  /** An empty staging directory the project's account may write; returns its path. */
  stage: (slug: string) => Promise<string>;
  /** The deployment's archive, extracted into the staging directory as the project's account. */
  extract: (slug: string, deployment: string, staging: string) => Promise<ExtractOutcome>;
  /** Does the staged tree hold at least one file? */
  hasFiles: (staging: string, part: Part) => Promise<boolean>;
  /** The manifest's `install`, run as the project's account in the staged `app/`, seen at its final path. */
  install: (slug: string, staging: string, command: string) => Promise<Execution>;
  /** The staged trees handed to the deployment account, then put in place of the served ones. */
  place: (slug: string, staging: string, parts: Part[]) => Promise<void>;
  /** The staging directory and the trees set aside, removed. */
  cleanUp: (slug: string) => Promise<void>;

  /** `/srv/sites/<slug>/sitesolide.json`, owned by the deployment account, 0644; the leftovers removed. */
  depositManifest: (slug: string, text: string) => Promise<void>;
  /** `/etc/systemd/system/<unit>.service`, root 0644. */
  installUnit: (unit: string, text: string) => Promise<void>;
  /** Stopped, disabled and removed, then `daemon-reload`. */
  removeUnits: (units: string[]) => Promise<void>;
  /** `daemon-reload`, then `enable` of the main unit. */
  enable: (slug: string) => Promise<void>;
  /** `systemctl restart` of every unit named, then `is-active` of each. */
  restart: (units: string[]) => Promise<Execution>;

  loopback: {
    state: () => Promise<LoopbackState>;
    /** The `port . uid` pairs the kernel carries, null when the listing failed. */
    pairs: () => Promise<string[] | null>;
    /** Is /etc/sitesolide-loopback-projects.nft there? */
    filePresent: () => Promise<boolean>;
    /** The uid of each project's account, null when one is missing. */
    uids: (slugs: string[]) => Promise<Map<string, number> | null>;
    /** Writes the set's file, checks and applies it when `apply`, and only then replaces the one in service. */
    write: (content: string, apply: boolean) => Promise<Execution>;
  };
};
