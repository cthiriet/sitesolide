/**
 * Generates the systemd unit of an application project.
 *
 * The model is the hardening shared by every service on the machine.
 * **Nothing is taken away from it here**: this file exists so that a project
 * deployed from any repository is confined exactly like a site from the
 * repository, and not slightly less.
 *
 * Pure: returns text, touches nothing.
 */
import { sameDirectives } from "./comparison";
import { egressUnitLines } from "./egress";
import {
  commandErrors,
  isValidDescription,
  isValidEnvName,
  isValidEnvValue,
  isValidSecretName,
  isValidSlug,
  servedContact,
  servedZone,
  servicesOf,
  type Manifest,
  type ServiceView,
} from "./manifest";

export type ProjectPaths = {
  root: string;
  app: string;
  publicDir: string;
  dataDir: string;
};

/** The served tree on the VM, the same for every project. */
export function projectPaths(slug: string, sitesRoot = "/srv/sites"): ProjectPaths {
  const root = `${sitesRoot}/${slug}`;
  return {
    root,
    app: `${root}/app`,
    publicDir: `${root}/public`,
    dataDir: `${root}/data`,
  };
}

/**
 * A unit as systemctl and journalctl must be given it. The main unit is the
 * slug, which has no dot, and systemd adds `.service` itself. A secondary unit,
 * `<slug>.<name>`, gets it written out: systemd reads what follows the last dot
 * as a type, and the suffix removes any doubt about which unit is meant.
 */
export function unitArgument(unit: string): string {
  return unit.includes(".") ? `${unit}.service` : unit;
}

/** The project's system user, with no shell, created by `init`. */
export function systemUser(slug: string): string {
  return `site-${slug}`;
}

/** Where a declared secret lives on the machine: one directory, one name. */
export function secretPath(name: string, folder = "/etc/sitesolide"): string {
  return `${folder}/${name}`;
}

/**
 * The placeholders an environment value can carry, and their replacement.
 *
 * Without them, a versioned manifest would have to write the domain of the
 * machine serving it, and would no longer be valid elsewhere: the dashboard
 * declares "PUBLIC_URL": "https://{slug}.{zone}" and is valid for everyone.
 *
 * A placeholder whose value is empty stays in place, visible as is. Better a
 * variable that is obviously incomplete, seen in `systemctl cat`, than a wrong
 * address with nothing to say it is wrong.
 *
 * Except for an optional one, where empty is an answer and not a gap. The
 * contact address is optional: absent, the door page of a locked preview drops
 * its line. Left as `{contact}`, it was not absent but a value, and the page
 * offered to write to "{contact}".
 */
const OPTIONAL_PLACEHOLDERS: ReadonlySet<string> = new Set(["contact"]);

export function substitute(value: string, placeholders: Record<string, string>): string {
  let output = value;
  for (const [name, replacement] of Object.entries(placeholders)) {
    if (replacement !== "" || OPTIONAL_PLACEHOLDERS.has(name)) output = output.replaceAll(`{${name}}`, replacement);
  }
  return output;
}

/**
 * A manifest's text as a unit setting carries it. systemd expands `%`
 * specifiers in Description=, Environment= and ExecStart=: `%h` becomes a home
 * folder, `%m` the machine's id, and an unknown one makes systemd drop the
 * line. `%%` is the percent sign itself, so the setting says what the manifest
 * wrote, whoever wrote it. A text without `%`, as every unit in service today,
 * comes out unchanged.
 */
export function escapeSpecifiers(text: string): string {
  return text.replaceAll("%", "%%");
}

/**
 * The second barrier behind validate(), as in fragment.ts: since the control
 * API, a team token writes the manifest, and a value that would add a
 * directive, set a variable past the rules on names, or run the command as
 * root (`ExecStart=+...`) is never written. It throws rather than writes, and
 * refuses only what validate() refuses.
 */
function assertWritable(manifest: Manifest, service: ServiceView): void {
  const refused = (what: string) => new Error(`${what} is not what validate() accepts, it is never written into a unit`);
  if (manifest.description !== undefined && !isValidDescription(manifest.description)) throw refused("description");
  if (typeof service.start !== "string" || commandErrors(service.start, "start").length > 0) throw refused(`the start of ${service.unit}`);
  for (const [name, value] of Object.entries(service.env)) {
    if (!isValidEnvName(name) || !isValidEnvValue(value)) throw refused(`env ${JSON.stringify(name)}`);
  }
  for (const secret of manifest.secrets ?? []) {
    if (!isValidSecretName(secret)) throw refused(`secrets ${JSON.stringify(secret)}`);
  }
}

/**
 * What a service is told of its tree: its port, its data folder and its
 * public folder, as its unit sets them, `PORT`, `DATA_DIR` and `PUBLIC_DIR`.
 * The backup component hands the same to a service's backup command
 * (dashboard/src/backup/hooks.ts): one writing of them for both.
 */
export function treeVariables(manifest: Manifest, service: ServiceView, sitesRoot = "/srv/sites"): [string, string][] {
  const paths = projectPaths(manifest.slug, sitesRoot);
  return [
    ["PORT", String(service.port)],
    ["DATA_DIR", paths.dataDir],
    ["PUBLIC_DIR", paths.publicDir],
  ];
}

/**
 * A service's own `env`, the project's merged in, its placeholders replaced:
 * each value as the process receives it. The unit escapes the `%` on top,
 * for systemd's specifiers; a backup command, handed them through
 * systemd-run's `--setenv`, which expands none, takes them as they are.
 */
export function declaredVariables(service: ServiceView, placeholders: Record<string, string>): [string, string][] {
  return Object.entries(service.env).map(([key, value]) => [key, substitute(value, placeholders)]);
}

/** A generated unit: its name without `.service`, and its text. */
export type GeneratedUnit = { unit: string; text: string };

function defaultPlaceholders(manifest: Manifest): Record<string, string> {
  return { slug: manifest.slug, zone: servedZone(), contact: servedContact() };
}

/**
 * The unit of the project's main service: the only one of a project with a
 * single `start`, the first of its `services` otherwise.
 */
export function generateUnit(manifest: Manifest, placeholders = defaultPlaceholders(manifest)): string {
  const [main] = generateUnits(manifest, placeholders);
  if (main === undefined) throw new Error(`${manifest.slug} declares no service`);
  return main.text;
}

/**
 * Every unit of the project, the main one first.
 *
 * The others hang on the main one: it `Wants=` them, so starting it starts
 * them, and they are `PartOf=` it, so stopping or restarting it does the same
 * to them. That is what lets the dashboard and the steward, which know a
 * project by its main unit alone, restart all of it when a secret changes.
 */
export function generateUnits(manifest: Manifest, placeholders = defaultPlaceholders(manifest)): GeneratedUnit[] {
  const services = servicesOf(manifest);
  const main = services[0];
  if (main === undefined) return [];
  const others = services.slice(1).map((service) => service.unit);
  return services.map((service, rank) => ({
    unit: service.unit,
    text: renderUnit(manifest, service, rank === 0 ? { others } : { main: main.unit }, placeholders),
  }));
}

function renderUnit(
  manifest: Manifest,
  service: ServiceView,
  place: { others: string[] } | { main: string },
  placeholders: Record<string, string>,
): string {
  assertWritable(manifest, service);
  const slug = manifest.slug;
  const account = systemUser(slug);
  const paths = projectPaths(slug);
  const secrets = manifest.secrets ?? [];
  const isOutbound = manifest.network === "outbound";
  const description = escapeSpecifiers(manifest.description ?? `Project ${slug}`);

  const lines = [
    `# Service of project ${slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
    "#",
    "# Isolation: dedicated user with no shell, system mounted read only,",
    "# writing allowed in the project's data folder alone. A compromised",
    "# project can read neither the landing nor the other sites.",
    "",
    "[Unit]",
    // What `systemctl status` shows. Without the field, the slug alone, which
    // is enough for a personal project and loses the little a hand-written unit
    // said. The zone does not come in here: a unit names no machine, and the
    // served address is read in the Caddy fragment.
    `Description=${service.name === null ? description : `${description}, service ${service.name}`}`,
    "After=network-online.target",
    "Wants=network-online.target",
  ];

  if ("main" in place) {
    lines.push(
      "# Started by the project's main unit, and stopped or restarted with it.",
      `PartOf=${place.main}.service`,
    );
  } else if (place.others.length > 0) {
    const others = place.others.map((unit) => `${unit}.service`).join(" ");
    lines.push(
      "# The project's other services start before this one, and follow it when",
      "# it stops or restarts: see their PartOf.",
      `Wants=${others}`,
      `After=${others}`,
    );
  }

  lines.push(
    "",
    "[Service]",
    "Type=simple",
    `User=${account}`,
    `Group=${account}`,
    `WorkingDirectory=${paths.app}`,
    "",
    ...treeVariables(manifest, service).map(([key, value]) => `Environment=${key}=${value}`),
  );

  // The proxy and the connectors, only for a project that asks for them: the
  // unit of every other project is unchanged, line for line.
  lines.push(...egressUnitLines(manifest));

  // The variables declared by the project. They never carry a secret, this file
  // being versioned: validate() refuses the names that announce one. What does
  // hide arrives through EnvironmentFile, from /etc/sitesolide, which the
  // dashboard's Secrets section holds on the VM.
  //
  // `{zone}` and `{slug}` are replaced there, so that a versioned manifest
  // never writes a machine's domain: a project declares
  // "PUBLIC_URL": "https://{slug}.{zone}" and is valid for everyone.
  //
  // The `%` escaped after the replacement, so that a zone or a contact holding
  // one is written as it is too.
  for (const [key, value] of declaredVariables(service, placeholders)) {
    lines.push(`Environment=${key}=${escapeSpecifiers(value)}`);
  }

  // The secrets arrive through the environment, never through a file the
  // service could read: systemd reads EnvironmentFile before entering the
  // namespace. The dash lets the service start if the file is missing, and it
  // is bin/sitesolide.ts that then refuses to restart, failing which the
  // service would run without saying anything.
  for (const secret of secrets) {
    lines.push(`EnvironmentFile=-${secretPath(secret)}`);
  }

  lines.push(
    "",
    `ExecStart=${escapeSpecifiers(service.start)}`,
    "Restart=always",
    "RestartSec=2",
    "",
    "# What the service writes belongs to it alone.",
    "UMask=0077",
    "",
    "# Confinement",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    `ReadWritePaths=${paths.dataDir}`,
    "",
    "# /srv is replaced by an empty mount, then only this project's folders",
    "# are exposed again in it: the service cannot read the landing nor the",
    "# other sites, even if their Unix permissions allowed it.",
    "TemporaryFileSystem=/srv:ro",
    `BindReadOnlyPaths=${paths.app}`,
    `BindReadOnlyPaths=${paths.publicDir}`,
    `BindPaths=${paths.dataDir}`,
    "",
  );

  if (secrets.length === 0) {
    // A service with no secret must not even learn which other sites have one.
    // The dash avoids the 226/NAMESPACE failure if the directory does not exist
    // yet, which Restart=always would turn into a loop.
    lines.push(
      "# No secret for this project: the whole folder is closed to it, which",
      "# hides from it even the names of the files.",
      "InaccessiblePaths=-/etc/sitesolide",
      "",
    );
  } else {
    // Putting InaccessiblePaths back here assumes that systemd reads
    // EnvironmentFile before applying the namespace. The steward's bench
    // measured it on 16 September 2026, on arm64 and inside a container
    // to be confirmed on x86_64 before changing the units already in service,
    // whose rule we follow until then.
    lines.push(
      "# This project reads its own file in /etc/sitesolide: InaccessiblePaths",
      "# is not laid here, or systemd could not hand the file to it.",
      "",
    );
  }

  lines.push(
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectControlGroups=true",
    "RestrictNamespaces=true",
    "RestrictSUIDSGID=true",
    "RestrictRealtime=true",
    "LockPersonality=true",
    `MemoryMax=${service.memory}`,
    "",
  );

  if (isOutbound) {
    lines.push(
      "# network: outbound. This project reaches an outside API; the network",
      "# confinement is lifted, everything else holds.",
      "",
    );
  } else {
    lines.push(
      "# The only client of this service is Caddy, on the loopback.",
      "#",
      "# THIS BLOCKING ALSO CUTS DNS OFF. This machine's resolvers are those",
      "# of the hosting provider, hence external. Measured on 19 August 2026",
      "# in a transient unit carrying these very two lines:",
      "#",
      "#   to a name        curl: (6) Could not resolve host",
      "#   to an IP         curl: (28) Connection timed out, after the full delay",
      "#   to 127.0.0.1     200, the loopback goes through",
      "#",
      "# Both messages mislead: the first sends one hunting a DNS outage, the",
      "# second a slowness of the remote service. The cure is neither to tinker",
      "# with /etc/resolv.conf nor to lengthen a delay, it is network: outbound",
      "# in the project's sitesolide.json.",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
      "",
    );
  }

  if ("main" in place) {
    // Never enabled on its own: the main unit wants it, at boot as after a
    // deployment, and a second way of starting it would outlive a removal.
    lines.push("# No [Install]: started by the project's main unit.", "");
  } else {
    lines.push("[Install]", "WantedBy=multi-user.target", "");
  }

  return lines.join("\n");
}

// --- a project's program, run outside its service --------------------------------

/** One program run as the project's account, in a transient unit. */
export type ProjectRun = {
  slug: string;
  purpose: "extract" | "install";
  /** Fixed paths only: nothing a manifest or an archive wrote ever goes into the arguments. */
  command: string[];
  /** Its standard input: the archive's descriptor, the install command's text, or none. */
  stdin: number | Uint8Array | null;
  /** The only directories of /srv it sees: `source` mounted at `target`, writable. */
  binds: { source: string; target: string }[];
  workingDirectory: string | null;
  /** Outbound network, never the loopback. Off for the extraction. */
  network: boolean;
  timeoutS: number;
  memory: string;
};

/**
 * The `systemd-run` line for a project's program: the generated unit's
 * confinement, the binds alone visible under /srv, and the limits. The
 * installer runs the extraction and `install` with it for a token
 * (dashboard/src/installer/real.ts), and `deploy` its `install` over SSH, see
 * sandboxedInstallCommand: one writing of the walls for both paths.
 */
export function systemdRunArguments(run: ProjectRun, systemdRun = "/usr/bin/systemd-run"): string[] {
  const account = systemUser(run.slug);
  const properties = [
    `User=${account}`,
    `Group=${account}`,
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictNamespaces=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "UMask=0022",
    // The generated unit's own pattern for its data folder: /srv emptied, the
    // directory bound back in, and declared writable for ProtectSystem=strict.
    "TemporaryFileSystem=/srv:ro",
    ...run.binds.flatMap(({ source, target }) => [`BindPaths=${source}:${target}`, `ReadWritePaths=${target}`]),
    "InaccessiblePaths=-/etc/sitesolide",
    `MemoryMax=${run.memory}`,
    `RuntimeMaxSec=${run.timeoutS}`,
    "TasksMax=256",
    // The extraction needs no network at all; an install fetches packages, but
    // never reaches the loopback, where every other project listens.
    ...(run.network ? ["IPAddressDeny=localhost"] : ["PrivateNetwork=yes", "IPAddressDeny=any"]),
    ...(run.workingDirectory === null ? [] : [`WorkingDirectory=${run.workingDirectory}`]),
  ];
  return [
    systemdRun,
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    // Nothing expanded in the command line (systemd 254 and later), which only
    // carries fixed paths anyway.
    "--expand-environment=no",
    `--description=sitesolide ${run.purpose} for ${run.slug}`,
    ...properties.flatMap((property) => ["-p", property]),
    "-E",
    "HOME=/tmp",
    "-E",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "-E",
    "CI=1",
    ...run.command,
  ];
}

/**
 * The remote command `deploy` runs a manifest's `install` with over SSH: as
 * the project's own account, in the walls the installer gives it for a token,
 * the network but never the loopback, /srv hidden but `app/`, nothing of
 * /etc/sitesolide, a throwaway HOME, fifteen minutes and 1G at most. The
 * install command itself travels on standard input, to `sh -s`: systemd
 * expands `$VAR` and `%` in a unit's command line, and the manifest's text
 * must reach the shell exactly as it was written.
 *
 * It used to run as the deployment account, which holds sudo without a
 * password (sitesolide setup gives it that), outside any sandbox; and `bun install`
 * and `uv sync` run the lifecycle scripts of what they fetch. Any package one
 * of them pulled had root on the machine that serves every site.
 *
 * `app/` belongs to the deployment account, so that the service cannot
 * rewrite its own code. It is handed to the project's account for the length
 * of the install, then back, whatever the install's outcome: a failed one
 * leaving `app/` to the project would refuse the next rsync. `-h` never
 * follows a link the install laid, and the service keeps seeing `app/`
 * read-only meanwhile, through its own unit.
 */
export function sandboxedInstallCommand(slug: string, owner: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid slug: ${slug}`);
  if (!/^[a-z_][a-z0-9_.-]*$/.test(owner)) throw new Error(`unexpected account: ${owner}`);
  const app = projectPaths(slug).app;
  const account = systemUser(slug);
  const run = systemdRunArguments({
    slug,
    purpose: "install",
    command: ["/bin/sh", "-s"],
    stdin: null,
    binds: [{ source: app, target: app }],
    workingDirectory: app,
    network: true,
    timeoutS: 900,
    memory: "1G",
  });
  // Every argument is fixed or built from the slug; a quote among them would
  // break out of the double quotes below.
  if (run.some((argument) => /["'$`\\]/.test(argument))) throw new Error("unexpected character in the systemd-run line");
  const line = run.map((argument) => `"${argument}"`).join(" ");
  return `sudo sh -c 'chown -hR ${account}:${account} ${app} && ${line}; code=$?; chown -hR ${owner}:${owner} ${app}; exit $code'`;
}

/**
 * What the machine answers when asked about a file it carries, or does not. Two
 * words, and nothing else is recognised.
 *
 * **An empty output is not an absence.** A refused `sudo`, an ssh that does not
 * get through or a remote shell that balks give the same emptiness, and
 * mistaking it for "the file is not there" would deposit over what is in
 * service. It is the only path by which `deploy` could replace a unit or a
 * secret without meaning to, and these two markers close it.
 */
export const MARKER_ABSENT = "ABSENT";
export const MARKER_PRESENT = "PRESENT";

export type UnitRead =
  | { kind: "absent" }
  | { kind: "present"; content: string }
  | { kind: "unreadable" };

/**
 * The answer to the reading of a unit: the marker, then the file as is. The
 * marker comes first rather than in place of an empty output, a unit being able
 * to be empty without being absent.
 */
export function readUnitAnswer(output: string): UnitRead {
  if (output.trim() === MARKER_ABSENT) return { kind: "absent" };
  if (output.startsWith(`${MARKER_PRESENT}\n`)) {
    return { kind: "present", content: output.slice(MARKER_PRESENT.length + 1) };
  }
  return { kind: "unreadable" };
}

export type UnitState = {
  /** What /etc/systemd/system/<slug>.service holds, "" if the file is missing. */
  installed: string;
  /** What the manifest generates today. */
  generated: string;
  /** --force, the deliberate act of switching to the generated one. */
  replace: boolean;
};

export type UnitAction = "install" | "present" | "diverged";

/**
 * What is to be done with a project's unit, so that `deploy` can put it in
 * place on the first pass without ever replacing the one running a service.
 *
 * Hand-written units carry decisions the manifest cannot express:
 * a unit that needs a device may drop `PrivateDevices` on purpose, saying
 * why. Replacing it because a deployment happened to pass by would cut that
 * device off without anyone having asked for it, and that is exactly
 * what `diverged` avoids: the divergence is reported, and `--force` settles it.
 *
 * Returning `present` on an equivalent unit is what makes `deploy` idempotent:
 * the second pass deposits nothing, reloads nothing, and says nothing. The
 * equivalence is about the directives and not about the text, failing which a
 * hand-written unit would be declared divergent at every deployment for its
 * comments alone, while running exactly the same service. See comparison.ts.
 */
export function decideUnit(state: UnitState): UnitAction {
  if (state.installed.trim() === "") return "install";
  if (sameDirectives(state.installed, state.generated)) return "present";
  return state.replace ? "install" : "diverged";
}
