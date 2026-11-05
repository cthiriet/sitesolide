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
 * reach production. Outside git, no `git add` can publish them. A `terraform/`
 * folder may sit there too, from before 0.3, when Terraform created the
 * machine: nothing reads it any more, and it holds tokens and the machine's
 * address all the same.
 *
 * `SITESOLIDE_CONFIG_DIR` moves that whole folder, for a second installation
 * driven from the same workstation: see `privateFolder`.
 *
 * The keys and the environment variable names are the interface between this
 * module and the shell scripts of `bin/`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  /**
   * Who serves the zone's DNS, as setup was told with `--dns`: `manual`, or
   * on a machine set up before, a provider since removed, which setup
   * refuses (bin/cli/dns/registry.ts). Absent means Cloudflare; setup reads
   * it again when run without `--dns`, so that a run never switches a
   * machine to another way of obtaining its certificates unasked.
   */
  dns?: string;
  /**
   * `staging`: the zone's certificates come from Let's Encrypt's staging
   * environment, whose limits a test never reaches and whose certificates no
   * browser trusts, as setup was told with `--acme staging`. Absent means
   * production. A test installation's alone.
   */
  acme?: string;
  /**
   * The id of the Cloudflare Tunnel the machine is served through, as setup
   * was told with `--tunnel`; absent on a machine served directly. Nothing of
   * its credentials, which the machine alone keeps. See bin/cli/tunnel.ts.
   */
  tunnel?: string;
};

/** The one value of `acme` that changes anything. */
export const ACME_STAGING = "staging";

/** Whether the zone's certificates are staging's, which the workstation's own probes then accept unverified. */
export function acmeStaging(config: Pick<Config, "acme">): boolean {
  return config.acme === ACME_STAGING;
}

/** What `mergeConfig` requires, and only the user can know. */
export const REQUIRED_SETTINGS = ["server", "zone", "email"] as const;

/**
 * The variable that moves the whole private folder elsewhere: the
 * configuration and the vault with it.
 *
 * It exists for a second installation driven from the same workstation. The
 * folder in its usual place may well point at a machine in service, and
 * `sitesolide setup` refuses to overwrite a configuration that names another
 * server; a test machine gets a folder of its own instead, and every command
 * run with this variable set reads that folder and nothing else. One variable
 * read here, where every path of the CLI and of the scripts of bin/ comes
 * from, rather than an option each command would have to learn: a command
 * that forgot it would silently aim at the other machine.
 */
export const CONFIG_DIR_VARIABLE = "SITESOLIDE_CONFIG_DIR";

/** The folder of everything private to the workstation, beside the configuration file. */
export function privateFolder(home = homedir(), environment: Record<string, string | undefined> = process.env): string {
  const chosen = environment[CONFIG_DIR_VARIABLE];
  if (chosen !== undefined && chosen !== "") return expandHome(chosen, home);
  return join(home, ".config", "sitesolide");
}

/** The default paths, outside every repository. */
export function defaultPaths(home = homedir(), environment: Record<string, string | undefined> = process.env): { vault: string } {
  return {
    vault: join(privateFolder(home, environment), "secrets"),
  };
}

/**
 * The configuration file, read synchronously.
 *
 * The tests and the scripts need it without waiting, and the file is a few
 * lines long. Its absence gives an empty object: that is the state of an
 * install that has not run `sitesolide init` yet.
 */
export function readConfigFile(home = homedir(), environment: Record<string, string | undefined> = process.env): Partial<Config> {
  const path = configPath(home, environment);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
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

/**
 * The dashboard's address, derived from the configured zone. No default: a
 * ready-made value would send a user towards someone else's dashboard.
 */
export function dashboardAddress(zone: string): string {
  return `https://dashboard.${zone}`;
}

export function configPath(home = homedir(), environment: Record<string, string | undefined> = process.env): string {
  return join(privateFolder(home, environment), "config.json");
}

/** The settings `init` writes only when they are given or already set. */
export const OPTIONAL_SETTINGS = ["contact", "vault", "sites", "api", "dns", "acme", "tunnel"] as const;

/**
 * The file `sitesolide init` writes, and `sitesolide setup` too: the three
 * settings that name the machine, then each optional one given now or already
 * in the file. A file that stays silent about a path lets the defaults play,
 * and therefore never lies; the flag and the key carry the same name, so that
 * what is typed is what lands in the file. `previous` is the file as read:
 * what it already sets is carried over, and a key not among the settings is
 * left out.
 */
export function composeConfig(
  required: { server: string; zone: string; email: string },
  given: Partial<Record<(typeof OPTIONAL_SETTINGS)[number], string>>,
  previous: Record<string, unknown>,
): Record<string, string> {
  const config: Record<string, string> = { ...required };
  for (const key of OPTIONAL_SETTINGS) {
    const value = given[key] ?? previous[key];
    if (typeof value === "string" && value !== "") config[key] = value;
  }
  return config;
}

/** Writes the configuration at `path`, its folder made if missing. */
export async function writeConfig(path: string, config: Record<string, string>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(config, null, 2)}\n`);
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
 * without them would amount to guessing a machine.
 */
export function mergeConfig(file: Partial<Config> | null, environment: Record<string, string | undefined>, home = homedir()): Config {
  const defaults = defaultPaths(home, environment);
  const adopted = file ?? {};

  const required: Record<(typeof REQUIRED_SETTINGS)[number], string | undefined> = {
    server: environment.SITESOLIDE_SERVER ?? adopted.server,
    zone: environment.SITESOLIDE_ZONE ?? adopted.zone,
    email: environment.SITESOLIDE_EMAIL ?? adopted.email,
  };

  const missing = REQUIRED_SETTINGS.filter((name) => required[name] === undefined || required[name] === "");
  if (missing.length > 0) throw new IncompleteConfig(missing);

  const sites = environment.SITESOLIDE_SITES_REPO ?? adopted.sites ?? null;
  const contact = environment.SITESOLIDE_CONTACT ?? adopted.contact ?? null;
  const acme = environment.SITESOLIDE_ACME ?? adopted.acme;
  const tunnel = adopted.tunnel;
  return {
    ...(acme === ACME_STAGING ? { acme } : {}),
    ...(typeof tunnel === "string" && tunnel !== "" ? { tunnel } : {}),
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
