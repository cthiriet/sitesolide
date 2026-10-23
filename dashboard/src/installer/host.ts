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
import type { LoopbackState, UnitFacts, UnitStanding } from "../../borrowed/services";
import type { ProjectEntry } from "../secrets/scope";
import type { SecretFile } from "./claims";
import type { ExtractOutcome } from "./extract";

export type Execution = { code: number; output: string };

/**
 * How a unit stands, and the exit status of its main process, which says
 * what systemd's own words hide: 243 is a unit that could not load its
 * credentials, logged as a "Protocol error" (bin/cli/store.ts,
 * `credentialsFailure`). Null when systemd does not say.
 */
export type Standing = UnitStanding & { status: number | null };

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
  /** One unit file's text, a service's or a timer's (see unitFileName), null when it does not exist. */
  readUnit: (unit: string) => Promise<string | null>;
  /** The project's secondary units `deploy` generated, `<slug>.<name>`, and the timers of its scheduled ones, `<slug>.<name>.timer`. */
  generatedUnits: (slug: string) => Promise<string[]>;
  /** What systemd knows of a unit, wherever it reads it from; null when systemctl did not answer. */
  unitFacts: (slug: string, unit: string) => Promise<UnitFacts | null>;
  /** Where this host's systemd reads the units it lays: /etc/systemd/system. */
  unitsFolder: string;
  /**
   * A secret file of /etc/sitesolide, read without following a link: absent,
   * a plain file and the uid that owns it, or anything else. Its content is
   * never read.
   */
  secretFile: (name: string) => Promise<SecretFile>;
  /**
   * What the steward attaches a secret file to a site with
   * (src/secrets/scope.ts, `readSites`): every directory of /srv/sites with
   * its manifest, null when it has none, and the names in /etc/sitesolide,
   * those of a `<slug>-secrets` folder included. Throws when either cannot
   * be listed.
   */
  secretScope: () => Promise<{ projects: ProjectEntry[]; present: string[] }>;
  /** The uid of `site-<slug>`, null while the account does not exist. */
  accountUid: (slug: string) => Promise<number | null>;
  /**
   * The schedules systemd does not read as a time, asked of
   * `systemd-analyze calendar` one by one, in the order given; null when it
   * could not be asked. A read: nothing is written.
   */
  refusedSchedules: (schedules: string[]) => Promise<string[] | null>;
  /** How each unit stands, by unit as named, see stabilityCommand in services.ts, with its exit status; null when systemctl did not answer. */
  standing: (units: string[]) => Promise<Map<string, Standing> | null>;
  /**
   * The store's names: the variables its `env` sets and its files present,
   * regular and not empty, never a value nor a size. Null when it cannot be
   * read, an `env` that does not read back included, which the host says in
   * the log with its reason, never a line of it.
   */
  storeNames: (slug: string) => Promise<{ variables: string[]; files: string[] } | null>;

  /** Creates `site-<slug>` when it is missing. */
  ensureAccount: (slug: string) => Promise<"created" | "present">;
  /**
   * The project's directories, owners and modes, as `directoryCommands` of
   * bin/sitesolide.ts sets them. "created" when `/srv/sites/<slug>` did not
   * exist before.
   */
  prepareTree: (slug: string, application: boolean) => Promise<"created" | "present">;
  /**
   * The store's folders laid, as storePrepareCommand does over SSH
   * (bin/cli/store.ts): `projects/`, `projects/<slug>/` and its `files/`,
   * root's, 0700, each changed through a descriptor opened without
   * following a link; the previous versions a removed project of that name
   * left dropped when the project's folder is new. "refused" with the path
   * of a link or of anything there that is no folder: PID 1 would read
   * through it. Never touches the env file nor a file of the store.
   */
  prepareStore: (slug: string) => Promise<{ kind: "ready"; created: boolean } | { kind: "refused"; path: string }>;
  /**
   * The store's folders this deployment laid, removed again, while empty: a
   * creation undone. False, and the store left, when it holds anything.
   */
  removeStore: (slug: string) => Promise<boolean>;
  /**
   * The zone's sites written again for the ask endpoint, /etc/caddy/zone-names,
   * by the script `sitesolide deploy` sends over SSH (api/src/zone-names.ts),
   * run as root: nothing written on a zone with a DNS provider. Its last line
   * says which, see readZoneNamesAnswer.
   */
  refreshZoneNames: () => Promise<Execution>;
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

  /**
   * `/srv/sites/<slug>` removed whole, for a tree this deployment created and
   * nothing was served from. False, and nothing removed, when a manifest
   * appeared in it: somebody deployed it in the meantime.
   */
  removeTree: (slug: string) => Promise<boolean>;
  /** `userdel site-<slug>`, for an account this deployment created. */
  removeAccount: (slug: string) => Promise<Execution>;

  /** `/srv/sites/<slug>/sitesolide.json`, owned by the deployment account, 0644; the leftovers removed. */
  depositManifest: (slug: string, text: string) => Promise<void>;
  /** `/etc/systemd/system/<unit>.service`, or the timer's own name, root 0644. */
  installUnit: (unit: string, text: string) => Promise<void>;
  /** Stopped, disabled and removed, the timers first, then `daemon-reload`. */
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
