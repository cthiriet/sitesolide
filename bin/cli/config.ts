/**
 * The workstation's configuration, so that the CLI works from any repository.
 *
 * `~/.config/sitesolide/config.json`, written by `sitesolide init`:
 *
 *   { "server": "me@203.0.113.10",
 *     "zone": "example.com",
 *     "email": "me@example.com" }
 *
 * **Nothing has a default value that names a machine.** The server, the zone
 * and the contact address have none: a ready-made value here would aim at the
 * machine of whoever wrote the file, and a `deploy` run without configuration
 * would land on it. They stay missing until `sitesolide init` has run, and the
 * CLI says so.
 *
 * Nothing the machine holds is kept here. Its secrets live in /etc/sitesolide,
 * its units and Caddy blocks are generated from each project's manifest at
 * deploy time: no copy of them waits on the workstation, in this repository or
 * in another one.
 *
 * What is private to the workstation sits beside this file, outside every
 * repository: `secrets/`, the credentials the workstation itself presents to
 * reach production, and `terraform/`, the values and the state of the machine's
 * infrastructure. Outside git, no `git add` can publish them.
 *
 * The keys and the environment variable names are the interface between this
 * module and the shell scripts of `bin/`. A file written before they were
 * translated still works: `adoptLegacyKeys` reads the French keys and says on
 * standard error that they are outdated. See `docs/migration.md`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Config = {
  /** `user@host`, as ssh takes it. */
  server: string;
  /** The DNS zone served, of which every project gets a subdomain. */
  zone: string;
  /**
   * The address the certificate authority warns: certificate expiry, changed
   * terms, revocation. Let's Encrypt asks for one.
   */
  email: string;
  /**
   * The address to ask for an access code, shown to a visitor landing on a
   * closed preview. Optional: absent, the line disappears from the page, which
   * stays usable for whoever already has their code.
   */
  contact: string | null;
  /**
   * The credentials the workstation itself presents to reach production, an
   * API token a command-line tool sends for instance, read by `sitesolide run`.
   * Never a copy of what only the machine uses.
   */
  vault: string;
  /**
   * A repository holding the code of several projects, if there is one.
   *
   * The CLI does not need it: it runs from a project's directory, anywhere. It
   * only serves the checks that read every project at once, and its absence
   * skips them rather than failing them.
   */
  sites: string | null;
};

/** What `mergeConfig` requires, and only the user can know. */
export const REQUIRED_SETTINGS = ["server", "zone", "email"] as const;

/**
 * The keys a configuration written before the translation carries, and what
 * each of them became.
 *
 * They are read, never written: `sitesolide init` only puts down the names on
 * the right. Dropping them would have turned an existing file into an
 * "incomplete configuration", a message that says nothing about the rename and
 * sends its reader editing the file blind.
 */
export const LEGACY_KEYS = {
  serveur: "server",
  courriel: "email",
  coffre: "vault",
} as const satisfies Record<string, keyof Config>;

/**
 * Keys an earlier configuration carried for what the workstation no longer
 * keeps: the generated blocks and units, and the secrets registry. They are
 * dropped on reading and named, so that `sitesolide init` gets run to rewrite
 * the file without them.
 */
export const OBSOLETE_KEYS = ["projets", "projects", "destinations"] as const;

/**
 * Fills in the English keys from the French ones and names those that were
 * found, so that the caller can say they are outdated. A file carrying both
 * keeps the English one: it is the one `init` writes.
 */
export function adoptLegacyKeys(file: Partial<Config> | null): {
  config: Partial<Config>;
  legacy: string[];
} {
  if (file === null) return { config: {}, legacy: [] };
  const raw = file as Partial<Config> & Record<string, unknown>;
  const config: Partial<Config> = { ...file };
  const legacy: string[] = [];
  for (const name of OBSOLETE_KEYS) {
    if (raw[name] === undefined) continue;
    legacy.push(name);
    delete (config as Record<string, unknown>)[name];
  }
  for (const [before, after] of Object.entries(LEGACY_KEYS) as [string, keyof Config][]) {
    const value = raw[before];
    if (value === undefined) continue;
    legacy.push(before);
    if (config[after] === undefined) (config as Record<string, unknown>)[after] = value;
    delete (config as Record<string, unknown>)[before];
  }
  return { config, legacy };
}

/** What is said, once, when a configuration still carries the French keys. */
export function legacyKeysWarning(legacy: readonly string[]): string {
  const renamed = legacy.filter((name) => name in LEGACY_KEYS);
  const dropped = legacy.filter((name) => !(name in LEGACY_KEYS));
  const lines = [];
  if (renamed.length > 0) {
    const pairs = renamed.map((name) => `${name} -> ${LEGACY_KEYS[name as keyof typeof LEGACY_KEYS]}`).join(", ");
    lines.push(`${configPath()} still uses the old keys: ${pairs}; they are read all the same`);
  }
  if (dropped.length > 0) {
    lines.push(`${configPath()} carries keys no longer read: ${dropped.join(", ")}`);
  }
  lines.push(`"sitesolide init" rewrites the file with the current keys`);
  return lines.join("\n");
}

/** The folder of everything private to the workstation, beside the configuration file. */
export function privateFolder(home = homedir()): string {
  return join(home, ".config", "sitesolide");
}

/** The default paths, outside every repository. */
export function defaultPaths(home = homedir()): { vault: string; terraform: string } {
  return {
    vault: join(privateFolder(home), "secrets"),
    terraform: join(privateFolder(home), "terraform"),
  };
}

/**
 * The configuration file, read synchronously.
 *
 * The tests and the scripts need it without waiting, and the file is a few
 * lines long. Its absence gives an empty object: that is the state of an
 * install that has not run `sitesolide init` yet. A file written with the old
 * keys comes back with the new ones, silently: the warning belongs to
 * `mergeConfig`, which every command goes through, and repeating it here would
 * print it twice per run.
 */
export function readConfigFile(home = homedir()): Partial<Config> {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  return adoptLegacyKeys(JSON.parse(readFileSync(path, "utf8")) as Partial<Config>).config;
}

/**
 * The repository holding the code of several projects. `null` when there is
 * none, which is the ordinary case: the CLI runs from a project's directory,
 * and only needs this setting for the checks that read all of them together.
 */
export function projectsRepo(home = homedir()): string | null {
  const raw = process.env.SITESOLIDE_SITES_REPO ?? readConfigFile(home).sites ?? null;
  if (raw === null || raw === "") return null;
  return expandHome(raw, home);
}

/**
 * The account that connects to the machine, taken from `server`.
 *
 * It owns `/srv/sites/<slug>` and the files a deployment puts there: the
 * service runs as `site-<slug>`, and must therefore not be able to rewrite what
 * Caddy serves for it. Deriving it avoids declaring it twice, which would end
 * up naming two different accounts.
 */
export function deploymentAccount(server: string): string {
  const separator = server.indexOf("@");
  return separator === -1 ? server : server.slice(0, separator);
}

export function configPath(home = homedir()): string {
  return join(privateFolder(home), "config.json");
}

/** `~/Code/x` and `$HOME/Code/x` mean the same thing once written here. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(path);
}

/** What the CLI throws when the configuration is missing, with what repairs it. */
export class IncompleteConfig extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `incomplete configuration: ${missing.join(", ")}\n` +
        `declare them with "sitesolide init", which writes ${configPath()}`,
    );
    this.name = "IncompleteConfig";
  }
}

/**
 * Merges the three sources, from least to most authoritative: the defaults, the
 * file, the environment. `SITESOLIDE_SERVER` keeps the precedence it already
 * has in the scripts under `bin/`, so that a test against another machine is
 * set up the same way everywhere.
 *
 * Throws if the server, the zone or the contact address is missing: going on
 * without them would amount to guessing a machine. A file still carrying the
 * French keys is not missing anything: it is read, and `warn` says so.
 */
export function mergeConfig(
  file: Partial<Config> | null,
  environment: Record<string, string | undefined>,
  home = homedir(),
  warn: (message: string) => void = (message) => console.error(message),
): Config {
  const defaults = defaultPaths(home);
  const { config: adopted, legacy } = adoptLegacyKeys(file);
  if (legacy.length > 0) warn(legacyKeysWarning(legacy));

  const required: Record<(typeof REQUIRED_SETTINGS)[number], string | undefined> = {
    server: environment.SITESOLIDE_SERVER ?? adopted.server,
    zone: environment.SITESOLIDE_ZONE ?? adopted.zone,
    email: environment.SITESOLIDE_EMAIL ?? adopted.email,
  };

  const missing = REQUIRED_SETTINGS.filter((name) => required[name] === undefined || required[name] === "");
  if (missing.length > 0) throw new IncompleteConfig(missing);

  const sites = environment.SITESOLIDE_SITES_REPO ?? adopted.sites ?? null;
  const contact = environment.SITESOLIDE_CONTACT ?? adopted.contact ?? null;
  return {
    server: required.server as string,
    zone: required.zone as string,
    email: required.email as string,
    contact: contact === null || contact === "" ? null : contact,
    vault: expandHome(environment.SITESOLIDE_VAULT ?? adopted.vault ?? defaults.vault, home),
    sites: sites === null || sites === "" ? null : expandHome(sites, home),
  };
}

/** Reads the file if it exists. Its absence is not an error in itself: the environment may suffice. */
export async function readConfig(home = homedir()): Promise<Config> {
  const file = Bun.file(configPath(home));
  const present = await file.exists();
  const contents = present ? ((await file.json()) as Partial<Config>) : null;
  return mergeConfig(contents, process.env, home);
}
