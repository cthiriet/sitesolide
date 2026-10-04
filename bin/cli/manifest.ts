/**
 * The `sitesolide.json` manifest, read at the root of the deployed repository.
 *
 * An input format, hand-written in arbitrary repositories just like a
 * `package.json`, hence its keys in English, like the whole of the CLI's
 * interface. `KNOWN_KEYS` lists them all.
 *
 * It is a site's only configuration file, on both sides: it is versioned in the
 * repository and deposited as is at the root of the project on the VM, where
 * api/src/table.ts and api/scripts/generate-locks.ts read it again. The
 * `site.json` with French keys that held this role is gone: two files for a
 * single state ended up diverging, and the lock showed it.
 *
 * This whole file is pure: nothing in it touches the disk or the network, so
 * that every refusal from `validate()` is checkable without a server.
 */
import { egressErrors } from "./egress";

/**
 * One process of a project that runs several, declared under `services`: a web
 * front, the API it calls, a worker behind it. Each one becomes a systemd unit
 * of its own, under the project's system user, with the project's directories
 * and secrets.
 */
export type Service = {
  start: string;
  port: number;
  /** The paths Caddy sends to this service. Absent: every path no other service claims. */
  routes?: string[];
  /** Reached by the project's other services only, never by Caddy. */
  internal?: boolean;
  memory?: string;
  /** Added to the project's `env`, and winning over it on a shared name. */
  env?: Record<string, string>;
};

/** What a repository declares in order to be deployable. */
export type Manifest = {
  slug: string;
  description?: string;
  /** Where the code lives, when not beside the manifest, see isSourcePath. */
  source?: string;
  publicDir?: string;
  build?: string;
  install?: string;
  start?: string;
  port?: number;
  routes?: string[];
  /** Several processes instead of one `start`, see Service. */
  services?: Record<string, Service>;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  exclude?: string[];
  memory?: string;
  network?: "localhost" | "outbound";
  secrets?: string[];
  domain?: { name: string; aliases?: string[]; active?: boolean };
  lock?: boolean;
  /** The site goes behind the shared portal, see portal/README.md. */
  portal?: boolean;
  /** The paths the portal lets through: signed webhooks, above all. */
  portalExempt?: string[];
  /** The hosts reachable through the egress proxy, see bin/cli/egress.ts. */
  egress?: string[];
  /** The connectors asked for; a grant on the machine allows them, see bin/cli/egress.ts. */
  connectors?: string[];
  /** `false` keeps the data folder out of the machine's snapshots, see isBackedUp. */
  backup?: boolean;
};

/**
 * Every key this file knows how to read. Another one is a typo, and a typo on
 * `portal` or `lock` would deploy an open site its author believes closed: it
 * is therefore refused rather than passed over in silence.
 */
export const KNOWN_KEYS = [
  "slug",
  "description",
  "source",
  "publicDir",
  "build",
  "install",
  "start",
  "port",
  "routes",
  "services",
  "env",
  "headers",
  "exclude",
  "memory",
  "network",
  "secrets",
  "domain",
  "lock",
  "portal",
  "portalExempt",
  "egress",
  "connectors",
  "backup",
];

/** The keys of one entry of `services`, refused beyond these for the same reason. */
export const SERVICE_KEYS = ["start", "port", "routes", "internal", "memory", "env"];

/**
 * The services' ports: 3000 the landing, 3001 the shared service, then the
 * sites and the projects. The loopback rule reserves them to Caddy and root,
 * see bin/cli/loopback.ts; it lives here because the manifest's validation
 * needs it too, and this file is the one the dashboard borrows.
 */
export const SERVICE_PORTS = { first: 3000, last: 3099 };

/** The slug of the portal itself, which cannot put itself behind its own door. */
export const PORTAL_SLUG = "portal";

/** Default memory ceiling, the one of the units already in service. */
export const DEFAULT_MEMORY = "256M";

/**
 * The slug becomes a DNS label, `<slug>.<zone>`, and a directory name inside a
 * path built by Caddy. Stricter than api's `isValidSlug`, which accepts dots
 * because it also reads the zone's directory, the landing's: a slug generated
 * here never has a dot.
 */
export function isValidSlug(slug: string): boolean {
  return slug.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/** Same rule as api's `isValidDomain`: what passes here must pass there too. */
export function isValidDomain(domain: string): boolean {
  return (
    domain.length > 0 &&
    domain.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  );
}

/**
 * A path declared in the manifest must never leave the deployed repository:
 * `publicDir` is the source of an rsync, and a `..` there would send any
 * directory on the workstation off to the VM.
 */
export function isInternalPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[/\\]/).some((part) => part === "..");
}

/**
 * `source` names the folder whose content leaves, when the code lives in a
 * repository of its own that should carry nothing about its deployment: the
 * manifest then stays in the sites repository, and points at it.
 *
 * Relative to the manifest's folder, `..` included, since the code is
 * elsewhere by definition. Never absolute: `/Users/<name>/...` would name the
 * workstation that wrote it, and fail on every other one.
 */
export function isSourcePath(path: string): boolean {
  if (path.length === 0 || /[\r\n]/.test(path)) return false;
  return !path.startsWith("/") && !path.startsWith("~") && !/^[a-zA-Z]:/.test(path);
}

/** `256M`, `1G`, `524288K`. A bare number would be accepted by systemd as bytes. */
export function isValidMemory(memory: string): boolean {
  return /^[0-9]+[KMG]$/.test(memory);
}

/** The service is an application as soon as it declares a start command. */
/**
 * Variables set by the generator, which a manifest cannot redefine: they
 * describe the served tree, and a value from the manifest would make the
 * service write somewhere other than its own directory.
 */
export const RESERVED_ENV = ["PORT", "DATA_DIR", "PUBLIC_DIR"];

/**
 * A secret is never written into a versioned file. `env` is made for what has
 * nothing to hide, `NODE_ENV` or an AWS region; what does hide goes through the
 * vault and `secrets`. The check is on the name rather than on the value:
 * nobody knows how to recognise a secret by its shape, everybody recognises a
 * key named `API_KEY`.
 */
export const SUSPICIOUS_ENV = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS)$/;

export function isApp(manifest: Manifest): boolean {
  return (typeof manifest.start === "string" && manifest.start.length > 0) || hasServices(manifest);
}

/** Does the project declare its processes under `services`, rather than one `start`? */
export function hasServices(manifest: Manifest): boolean {
  const services = manifest.services;
  return typeof services === "object" && services !== null && !Array.isArray(services) && Object.keys(services).length > 0;
}

/**
 * A service name becomes the second half of a unit name, `<slug>.<name>`, and a
 * Caddy matcher name. The dot between the two is what keeps units apart: a
 * slug never carries one, so `shop.api` can only belong to `shop`, where
 * `shop-api` could be another project's slug.
 */
export function isValidServiceName(name: string): boolean {
  return name.length <= 32 && /^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name) && !UNIT_TYPES.includes(name);
}

/**
 * The unit types of systemd. A name ending in one of them is read as that
 * type: `lab.socket` addresses a socket unit, not `lab.socket.service`, and
 * a restart or a removal would reach the wrong unit. The leading letter keeps
 * integer-like names out, which JavaScript would sort before the others and
 * silently make the main service.
 */
const UNIT_TYPES = ["service", "socket", "device", "mount", "automount", "swap", "target", "path", "timer", "slice", "scope"];

/** One process as the deployment sees it, whichever way the manifest declared it. */
export type ServiceView = {
  /** Its name under `services`, null for a project with a single `start`. */
  name: string | null;
  /**
   * The systemd unit, without `.service`. The first service keeps the slug, so
   * that every tool naming a project's unit after its folder, the dashboard,
   * the steward and the collector, still finds the one that stands for the
   * whole project. The others are `<slug>.<name>`.
   */
  unit: string;
  start: string;
  port: number;
  routes?: string[];
  internal: boolean;
  memory: string;
  env: Record<string, string>;
};

/**
 * Every process of the project, the main one first. Empty for a static site.
 *
 * A project with a single `start` gives one entry built from its top-level
 * keys, exactly those the generators read before `services` existed: its unit
 * and its block come out unchanged.
 */
export function servicesOf(manifest: Manifest): ServiceView[] {
  if (hasServices(manifest)) {
    // Tolerant of a broken entry, which validate() reports: the dashboard reads
    // the manifests on the machine as they are, and one bad line must not take
    // the whole page down.
    const entries = Object.entries(manifest.services!).filter(
      ([, service]) => typeof service === "object" && service !== null && !Array.isArray(service),
    );
    return entries.map(([name, service], rank) => ({
      name,
      unit: rank === 0 ? manifest.slug : `${manifest.slug}.${name}`,
      start: service.start,
      port: service.port,
      routes: service.routes,
      internal: service.internal === true,
      memory: service.memory ?? manifest.memory ?? DEFAULT_MEMORY,
      env: { ...manifest.env, ...service.env },
    }));
  }
  if (!isApp(manifest)) return [];
  return [
    {
      name: null,
      unit: manifest.slug,
      start: manifest.start!,
      port: manifest.port!,
      routes: manifest.routes,
      internal: false,
      memory: manifest.memory ?? DEFAULT_MEMORY,
      env: manifest.env ?? {},
    },
  ];
}

/** The port of the project's main service, the one a single-service project declares. */
export function mainPort(manifest: Manifest): number | null {
  const port = servicesOf(manifest)[0]?.port;
  return typeof port === "number" ? port : null;
}

/**
 * A route goes as is into a Caddy `path` matcher: a path, with no space, quote
 * or brace that would cut the line. `/_portal` belongs to the portal, which
 * Caddy routes before the site.
 *
 * The top-level `routes` are judged by this rule too. They were only asked to
 * start with a slash, which let `/x\n\theader Leak "{$CLOUDFLARE_API_TOKEN}"`
 * through: a line break and a placeholder of its choosing in the site's block.
 */
export function isValidRoute(route: unknown): route is string {
  return typeof route === "string" && /^\/[A-Za-z0-9._~\/*%-]*$/.test(route) && !route.startsWith("/_portal");
}

/**
 * Could one request match both routes? Caddy compares paths without regard to
 * case, and a `*` matches anything, so the answer errs on the side of yes: two
 * services that could both claim a path are refused, rather than having the
 * written order of the block decide, which the comparison of blocks does not
 * see (bin/cli/comparison.ts).
 */
export function routesOverlap(a: string, b: string): boolean {
  const prefix = (route: string): string => {
    const star = route.indexOf("*");
    return (star === -1 ? route : route.slice(0, star)).toLowerCase();
  };
  const [wildA, wildB] = [a.includes("*"), b.includes("*")];
  const [prefixA, prefixB] = [prefix(a), prefix(b)];
  if (!wildA && !wildB) return prefixA === prefixB;
  if (wildA && wildB) return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
  return wildA ? prefixB.startsWith(prefixA) : prefixA.startsWith(prefixB);
}

/** Does the site go behind the portal? */
export function isProtected(manifest: Manifest): boolean {
  return manifest.portal === true;
}

/**
 * An exemption goes as is into a Caddy `path` matcher: a path, with no space,
 * quote or brace that would cut the line, and with no `..`.
 */
export function isValidExemption(path: unknown): path is string {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9._~\/*-]*$/.test(path)) return false;
  if (path.split("/").includes("..")) return false;
  // Exempting everything amounts to protecting nothing.
  if (["/", "/*", "*"].includes(path)) return false;
  // Those paths belong to the portal, which Caddy routes before the site.
  return !path.startsWith("/_portal");
}

/**
 * A header's name, written bare after `header` in the site's Caddy block.
 *
 * A subset of the token characters of RFC 7230, on purpose: the full set holds
 * `+`, `-`, `?` and `>`, which Caddy reads at the head of a name as "add",
 * "delete", "default" and "defer", and `$`, `*` or `|`, which no real header
 * needs. A letter first, then letters, digits and dashes: every header in use.
 */
export function isValidHeaderName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 128 && /^[A-Za-z][A-Za-z0-9-]*$/.test(name);
}

/**
 * A header's value, written between double quotes in the site's Caddy block,
 * and served to every visitor.
 *
 * **Since the control API, whoever holds a team token writes it.** Caddy
 * substitutes `{$NAME}` with its own environment while it reads the
 * configuration, and `{env.NAME}` at each request: a value of
 * `{$CLOUDFLARE_API_TOKEN}` was the zone's DNS token, in a response header, to
 * anyone who asked. Measured on Caddy 2.11.4, both forms. A `"` ends the
 * quoted value and lets the rest of the line become directives, a `\` escapes
 * the closing quote, a backtick opens Caddy's other quoting.
 *
 * Printable ASCII, then, without `"`, `\`, `{`, `}`, `$` and the backtick: the
 * characters Caddy reads as syntax or as a placeholder, and `$`, which no
 * header needs, refused with them so that no spelling of a placeholder is left.
 * What real headers use all stays: the single quotes, semicolons, colons,
 * slashes, commas, parentheses and spaces of a Content-Security-Policy or a
 * Permissions-Policy, the angle brackets of a Link. A Permissions-Policy that
 * names an origin between double quotes is the one casualty: the service
 * sends that header itself.
 */
export function isValidHeaderValue(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]*$/.test(value) && !/["\\{}$`]/.test(value);
}

/**
 * C0 and C1 control characters, and DEL. A line break in a value written into
 * the unit would add a directive of its own choosing to it, a `User=root` after
 * the generated one; the others have no business in a one-line setting.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Does this text end with a backslash systemd would take for a line
 * continuation? It then glues the next line of the unit onto the value: the
 * `Restart=always` after `ExecStart=` becomes an argument of the command.
 */
function endsWithContinuation(text: string): boolean {
  return /\\\s*$/.test(text);
}

/**
 * The refusals of a command systemd runs, the project's `start` or a
 * service's, `label` naming which.
 *
 * systemd reads a prefix on `ExecStart=` as an instruction: `+` and `!` run the
 * command with full privileges, that is as root, whatever `User=` says; `@`,
 * `-`, `:` and `|` change what is run or how. A manifest written by a team
 * token must never reach any of them, so the command starts with the program
 * itself: an absolute path, or a name systemd looks up, its first character a
 * letter, a digit, a slash, a dot or an underscore. A lone `;` separates
 * a second command, whose own prefix is judged the same way. `$NAME` stays
 * allowed: systemd expands it from the service's own environment, which the
 * service holds anyway, and `--port $PORT` is a common way to write a start.
 * A `%` is escaped by the generator, see unit.ts.
 */
export function commandErrors(command: string, label: string): string[] {
  if (CONTROL_CHARACTERS.test(command)) return [`${label}: a single line, no line break`];
  const errors: string[] = [];
  const words = command.split(/\s+/);
  const programs = [words[0] ?? "", ...words.flatMap((word, rank) => (word === ";" ? [words[rank + 1] ?? ""] : []))];
  if (!programs.every((program) => /^[A-Za-z0-9/._]/.test(program))) {
    errors.push(
      `${label}: must start with the program to run, such as /usr/local/bin/bun; systemd reads a leading + ! @ - : or | as an instruction, + and ! as "run as root"`,
    );
  }
  if (endsWithContinuation(command)) {
    errors.push(`${label}: must not end with a backslash, which systemd reads as a line continuation`);
  }
  return errors;
}

/** A one-line text for the unit's Description=, see validate(). */
export function isValidDescription(description: unknown): description is string {
  return typeof description === "string" && !CONTROL_CHARACTERS.test(description) && !endsWithContinuation(description);
}

/** An environment variable's name, as `Environment=` and every shell expect one. */
export function isValidEnvName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

/**
 * An environment variable's value, written as `Environment=KEY=value`, which
 * systemd splits on spaces and unquotes: `"x DATA_DIR=/elsewhere"` would set a
 * second variable, past every rule on names, and a backslash would escape a
 * character or continue the line. One line, then, without spaces, quotes or
 * backslashes. Such a value never worked as written; it is refused rather than
 * quoted, which keeps every unit in service byte for byte. `$` has no meaning
 * there for systemd, and a `%` is escaped by the generator, see unit.ts.
 */
export function isValidEnvValue(value: unknown): value is string {
  return typeof value === "string" && !CONTROL_CHARACTERS.test(value) && !/[\s"'\\]/.test(value);
}

/**
 * The name of a secret file, written into the unit as
 * `EnvironmentFile=-/etc/sitesolide/<name>` and read there as root. A plain
 * file name: no path, no space, no `%` systemd would expand, no line break
 * that would add a directive of its own after it.
 */
export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Parses the manifest's JSON. Returning the errors rather than throwing allows
 * showing them all at once, rather than having them fixed one by one.
 */
/**
 * The served zone, for the one rule that depends on it: a customer domain
 * declared under it would get nothing, the wildcard and the apex already
 * covering it.
 *
 * It comes from the environment rather than from a parameter because this
 * module is also embedded by the dashboard, which validates the same manifests
 * on the machine. Empty, the rule does not apply: better to refuse nothing than
 * to refuse in the name of an invented zone.
 */
export function servedZone(environment: Record<string, string | undefined> = process.env): string {
  return environment.SITESOLIDE_ZONE ?? "";
}

/**
 * The address to ask for an access code, shown by the door page of a closed
 * preview. Empty for whoever has not declared it, and the line then disappears
 * from the page.
 */
export function servedContact(environment: Record<string, string | undefined> = process.env): string {
  return environment.SITESOLIDE_CONTACT ?? "";
}

export function readManifest(raw: string): { manifest?: Manifest; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { errors: [`sitesolide.json is unreadable: ${(err as Error).message}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { errors: ["sitesolide.json must contain an object"] };
  }
  const manifest = parsed as Manifest;
  return { manifest, errors: validate(manifest) };
}

/**
 * The refusals that are decided without the VM. The two that remain, a slug
 * already taken and a port already listened to, are measured on the machine: a
 * local registry would lie from the first deployment made from somewhere else.
 */
export function validate(manifest: Manifest, zone = servedZone()): string[] {
  const errors: string[] = [];
  const isApplication = isApp(manifest);

  for (const key of Object.keys(manifest)) {
    if (!KNOWN_KEYS.includes(key)) {
      errors.push(`${key}: unknown key, a typo here could deploy an open site`);
    }
  }

  if (typeof manifest.slug !== "string" || !isValidSlug(manifest.slug)) {
    errors.push(
      "slug: lowercase letters, digits and dashes, no dot, no leading or trailing dash",
    );
  } else if (manifest.slug === "landing") {
    // Without this refusal, the deployment SUCCEEDS: it creates
    // /srv/sites/landing and publishes a duplicate of the landing that the
    // wildcard block serves straight away.
    errors.push("slug: landing is reserved for the site on the bare domain, which deploy does not handle");
  }

  if (manifest.description !== undefined) {
    // Written into the unit's Description=: a trailing backslash would glue the
    // next line onto it, and a `%` is escaped by the generator.
    if (!isValidDescription(manifest.description)) {
      errors.push("description: a single line of text, no line break, not ending with a backslash");
    }
  }

  if (manifest.source !== undefined) {
    if (typeof manifest.source !== "string" || !isSourcePath(manifest.source)) {
      errors.push("source: a path relative to this manifest's folder, such as ../../my-app, never absolute");
    }
  }

  if (manifest.publicDir !== undefined) {
    if (typeof manifest.publicDir !== "string" || !isInternalPath(manifest.publicDir)) {
      errors.push("publicDir: a path inside the repository, no `..`");
    }
  }

  if (!isApplication && manifest.publicDir === undefined) {
    errors.push("a project without `start` must declare `publicDir`");
  }

  // Written into the unit's ExecStart=: see commandErrors.
  if (typeof manifest.start === "string" && manifest.start.length > 0) {
    errors.push(...commandErrors(manifest.start, "start"));
  }

  if (manifest.services !== undefined) {
    errors.push(...serviceErrors(manifest));
  } else if (isApplication) {
    if (typeof manifest.port !== "number" || !Number.isInteger(manifest.port)) {
      errors.push("port: required as soon as `start` is declared");
    } else if (manifest.port < 1024 || manifest.port > 65535) {
      errors.push("port: between 1024 and 65535");
    }
  } else if (manifest.port !== undefined) {
    errors.push("port: useless without `start`, Caddy serves the folder itself");
  }

  if (manifest.memory !== undefined && !isValidMemory(manifest.memory)) {
    errors.push("memory: a number followed by K, M or G, such as 256M");
  }

  if (manifest.network !== undefined && !["localhost", "outbound"].includes(manifest.network)) {
    errors.push("network: `localhost` or `outbound`");
  }

  errors.push(...egressErrors(manifest, isApplication));

  // Joined into the `path` matcher of the site's Caddy block, like a service's.
  if (manifest.routes !== undefined && !Array.isArray(manifest.routes)) {
    errors.push("routes: a list of paths, such as [\"/api/*\"]");
  } else {
    for (const route of manifest.routes ?? []) {
      if (!isValidRoute(route)) {
        errors.push(`routes: "${String(route)}" should start with / and be a path such as /api/*, not under /_portal`);
      }
    }
  }
  if (manifest.routes !== undefined && !isApplication) {
    errors.push("routes: without `start`, no request reaches a service");
  }

  errors.push(...envErrors(manifest.env, "env"));
  if (manifest.env !== undefined && !isApplication) {
    errors.push("env: without `start`, no service would read these variables");
  }

  // Written into the site's Caddy block, see isValidHeaderName and
  // isValidHeaderValue.
  const headers = manifest.headers as unknown;
  const headersObject = typeof headers === "object" && headers !== null && !Array.isArray(headers);
  if (headers !== undefined && !headersObject) {
    errors.push('headers: an object naming each header, such as { "X-Robots-Tag": "noindex" }');
  }
  for (const [name, value] of headersObject ? Object.entries(headers) : []) {
    if (!isValidHeaderName(name)) {
      errors.push(`headers: "${name}" is not a header name`);
    }
    if (!isValidHeaderValue(value)) {
      errors.push(
        `headers: the value of ${name} must be printable ASCII with no line break, and none of " \\ { } $ or a backtick, which Caddy reads as syntax or placeholders`,
      );
    }
    // The headers are placed in the routes snippet, therefore on ALL of the
    // site's blocks. A noindex there would also hold for the customer's final
    // domain, which it would drop from Google with nothing to report it.
    if (name.toLowerCase() === "x-robots-tag" && manifest.domain !== undefined) {
      errors.push(
        "headers: X-Robots-Tag would also apply to the customer domain, which must stay indexed",
      );
    }
  }

  if (manifest.secrets !== undefined && !Array.isArray(manifest.secrets)) {
    errors.push('secrets: a list of file names, such as ["api.env"]');
  } else {
    for (const secret of manifest.secrets ?? []) {
      if (!isValidSecretName(secret)) {
        errors.push(`secrets: "${String(secret)}" must be a plain file name under /etc/sitesolide`);
      }
    }
  }

  const declared = manifest.domain as unknown;
  if (declared !== undefined && (typeof declared !== "object" || declared === null || Array.isArray(declared))) {
    // A `null` here, or an `aliases` that is no list, used to throw from
    // validate() itself, and the installer with it.
    errors.push('domain: an object such as { "name": "example.com" }');
  } else if (manifest.domain !== undefined) {
    const domain = manifest.domain;
    if (typeof domain.name !== "string" || !isValidDomain(domain.name)) {
      errors.push("domain.name: invalid domain name");
    } else if (zone !== "" && (domain.name === zone || domain.name.endsWith(`.${zone}`))) {
      // The `ask` endpoint already refuses these domains: the wildcard and the
      // apex cover them, and a manifest declaring them would get nothing.
      errors.push(`domain.name: the ${zone} zone is already covered by the wildcard`);
    }
    if (domain.aliases !== undefined && !Array.isArray(domain.aliases)) {
      errors.push('domain.aliases: a list of domain names, such as ["www.example.com"]');
    } else {
      for (const alias of domain.aliases ?? []) {
        if (typeof alias !== "string" || !isValidDomain(alias)) {
          errors.push(`domain.aliases: "${String(alias)}" is invalid`);
        }
      }
    }
  }

  if (manifest.portal !== undefined) {
    if (manifest.portal !== true) {
      // Like lock: its absence is already the shape of an open site.
      errors.push("portal: true, or absent");
    } else {
      if (!isApplication) {
        errors.push("portal: only a project with `start` can sit behind the portal for now");
      }
      if (manifest.lock === true) {
        errors.push("portal: a site behind the portal needs no preview lock");
      }
      if (manifest.domain !== undefined) {
        errors.push("portal: not yet on a customer domain, only under the served zone");
      }
      if (manifest.slug === PORTAL_SLUG) {
        errors.push("portal: the portal cannot sit behind itself");
      }
    }
  }

  if (manifest.portalExempt !== undefined) {
    // Without `portal`, the exemptions are accepted and do nothing: the
    // generator only reads them behind the door. That is the shape left by a
    // portal removed from the dashboard, which keeps them in reserve so that
    // the door put back reopens the same paths, a provider's webhook included. Their
    // shape, on the other hand, is judged in both cases: an exemption that
    // would open everything must not wait for the portal's return to be seen.
    if (!Array.isArray(manifest.portalExempt)) {
      errors.push("portalExempt: a list of paths");
    } else {
      for (const path of manifest.portalExempt) {
        if (!isValidExemption(path)) {
          errors.push(`portalExempt: "${String(path)}" must be a path such as /webhook/*, not everything, not /_portal`);
        }
      }
    }
  }

  errors.push(...backupErrors(manifest, isApplication));

  return errors;
}

/**
 * Is the project's data folder in the machine's snapshots? Every app's is,
 * unless its manifest says `"backup": false`: a folder holding nothing worth
 * keeping, a cache or a copy of something kept elsewhere, need not take room
 * on the backups disk every hour. See dashboard/src/backup/README.md.
 */
export function isBackedUp(manifest: Manifest): boolean {
  return manifest.backup !== false;
}

/**
 * `backup` opts out, and that is all it can say. Like `portal`, its absence
 * already has a meaning, the default, and `true` would be a second way of
 * writing it, which ends up diverging. A static site has no data folder.
 */
function backupErrors(manifest: Manifest, isApplication: boolean): string[] {
  if (manifest.backup === undefined) return [];
  if (manifest.backup !== false) return ["backup: false to keep the data folder out of the snapshots, or absent"];
  if (!isApplication) return ["backup: without `start`, there is no data folder to back up"];
  return [];
}

/** The refusals of an `env`, the project's or a service's, `label` naming which. */
function envErrors(env: Record<string, string> | undefined, label: string): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!isValidEnvName(key)) {
      errors.push(`${label}: "${key}" is not an environment variable name`);
    } else if (RESERVED_ENV.includes(key)) {
      errors.push(`${label}: ${key} is set by the deployment and cannot be redefined`);
    } else if (SUSPICIOUS_ENV.test(key)) {
      errors.push(
        `${label}: ${key} looks like a secret; secrets live on the server, managed from the dashboard, not here`,
      );
    }
    if (typeof value !== "string") {
      errors.push(`${label}: the value of ${key} must be a string`);
    } else if (CONTROL_CHARACTERS.test(value)) {
      errors.push(`${label}: the value of ${key} must hold on one line`);
    } else if (!isValidEnvValue(value)) {
      errors.push(`${label}: the value of ${key} must hold no space, quote or backslash, which systemd would split or unquote`);
    }
  }
  return errors;
}

/**
 * The refusals of `services`.
 *
 * Every port sits in the range the loopback rule closes. Outside it, the
 * project's internal service would be reachable by every other project on the
 * machine, which is exactly what declaring it internal was meant to prevent.
 *
 * Exactly one public service takes the paths nobody claims, unless a
 * `publicDir` serves them: without it, a path matched by no route would get an
 * empty 200 from Caddy, a page that looks served and is not.
 */
function serviceErrors(manifest: Manifest): string[] {
  const errors: string[] = [];
  const services = manifest.services as unknown;
  if (typeof services !== "object" || services === null || Array.isArray(services) || Object.keys(services).length === 0) {
    return ['services: an object naming each service, such as { "web": { "start": "...", "port": 3040 } }'];
  }
  for (const key of ["start", "port", "routes"] as const) {
    if (manifest[key] !== undefined) {
      errors.push(`${key}: declared per service once \`services\` is present`);
    }
  }

  const ports = new Map<number, string>();
  const defaults: string[] = [];
  const claimed: { name: string; route: string }[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const label = `services.${name}`;
    if (!isValidServiceName(name)) {
      errors.push(
        `services: "${name}" should start with a letter, then lowercase letters, digits and dashes, 32 characters at most, and not be a systemd unit type`,
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${label}: an object with at least \`start\` and \`port\``);
      continue;
    }
    const service = raw as Service;
    for (const key of Object.keys(service)) {
      if (!SERVICE_KEYS.includes(key)) {
        errors.push(`${label}.${key}: unknown key, a typo here could deploy something unintended`);
      }
    }

    if (typeof service.start !== "string" || service.start.length === 0) {
      errors.push(`${label}.start: required, the command systemd runs`);
    } else {
      errors.push(...commandErrors(service.start, `${label}.start`));
    }

    const port = service.port;
    if (typeof port !== "number" || !Number.isInteger(port)) {
      errors.push(`${label}.port: required, the loopback port the service listens on`);
    } else if (port < SERVICE_PORTS.first || port > SERVICE_PORTS.last) {
      errors.push(
        `${label}.port: between ${SERVICE_PORTS.first} and ${SERVICE_PORTS.last}, the range only Caddy and the project itself can reach`,
      );
    } else if (ports.has(port)) {
      errors.push(`${label}.port: ${port} is already the port of ${ports.get(port)}`);
    } else {
      ports.set(port, name);
    }

    if (service.internal !== undefined && service.internal !== true) {
      errors.push(`${label}.internal: true, or absent`);
    }
    const internal = service.internal === true;

    if (service.routes !== undefined) {
      if (!Array.isArray(service.routes) || service.routes.length === 0) {
        errors.push(`${label}.routes: a non-empty list of paths, or absent to take every path left`);
      } else {
        for (const route of service.routes) {
          if (!isValidRoute(route)) {
            errors.push(`${label}.routes: "${String(route)}" must be a path such as /api/*, not under /_portal`);
          } else {
            claimed.push({ name, route });
          }
        }
      }
      if (internal) errors.push(`${label}.routes: an internal service receives no request from Caddy`);
    } else if (!internal) {
      defaults.push(name);
    }

    if (service.memory !== undefined && !isValidMemory(service.memory)) {
      errors.push(`${label}.memory: a number followed by K, M or G, such as 256M`);
    }
    errors.push(...envErrors(service.env, `${label}.env`));
  }

  if (defaults.length > 1) {
    errors.push(`services: ${defaults.join(", ")} would all take every path left; give routes to all but one`);
  }
  if (defaults.length === 0 && manifest.publicDir === undefined) {
    errors.push("services: without publicDir, one public service must take every path left: leave its routes out");
  }
  for (const [i, a] of claimed.entries()) {
    for (const b of claimed.slice(i + 1)) {
      if (a.name !== b.name && routesOverlap(a.route, b.route)) {
        errors.push(`services: ${a.route} (${a.name}) and ${b.route} (${b.name}) could match the same request`);
      }
    }
  }
  return errors;
}

/**
 * What the rsync must never carry along: the dependencies installed on the
 * workstation. A macOS `node_modules` or a `.venv` built for arm64 dumped onto
 * a Linux x86_64 machine gives a service that does not start, after erasing the
 * previous one.
 *
 * The check takes the directory's entries rather than reading the disk, so as
 * to stay checkable without a test tree.
 */
export const DEPENDENCIES = ["node_modules", ".venv", "venv", "__pycache__"];

export function missingExclusions(manifest: Manifest, entries: string[]): string[] {
  const declared = new Set(manifest.exclude ?? []);
  return DEPENDENCIES.filter((name) => entries.includes(name) && !declared.has(name));
}

/**
 * The manifest read back as an object, validating nothing further: the
 * functions below only touch one key and leave the rest as is, key order
 * included. The file is versioned, and an action that puts a lock in place must
 * not read as a rewrite of the manifest.
 */
function readObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("sitesolide.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The manifest rewritten with its `lock` field, as bin/lock.sh records it.
 *
 * The lock lives here and nowhere else: this is the file the deployment
 * deposits on the VM and that the lock generator reads there, and a lock
 * written elsewhere would be erased at the next deployment.
 *
 * The field disappears when the lock is lifted, rather than being `false`: its
 * absence is already the shape open sites have, and two ways of writing the
 * same thing end up diverging.
 */
export function setLock(raw: string, closed: boolean): string {
  const manifest = readObject(raw);
  if (closed) manifest.lock = true;
  else delete manifest.lock;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The manifest rewritten with its `portal` field, as the dashboard's
 * gatekeeper deposits it on the VM (dashboard/src/gatekeeper/).
 *
 * Like the lock, the field disappears when the door is removed: `validate()`
 * refuses `false`, and its absence is already the shape of an open site.
 *
 * `portalExempt` stays in place. Without `portal`, it is inert, the generator
 * does not read it; keeping it means a door put back reopens the same paths,
 * instead of silently closing a webhook that a third party calls unsigned. For
 * the same reason, `portal` put back comes just before `portalExempt`: a
 * removal followed by a placement gives back the original file, key order
 * included.
 */
export function setPortal(raw: string, active: boolean): string {
  const parsed = readObject(raw);
  if (!active) {
    delete parsed.portal;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if ("portal" in parsed || !("portalExempt" in parsed)) {
    parsed.portal = true;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const ordered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "portalExempt") ordered.portal = true;
    ordered[key] = value;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * The manifest rewritten with its `domain.active`, as `sitesolide domain`
 * records it.
 *
 * `active` governs the domain's entry in the table: true, Caddy routes it and
 * the `ask` endpoint authorises its certificate; false, the site stays
 * reachable on its preview subdomain and nothing is issued in its name.
 *
 * The field is written even when it is `false`, unlike the lock: a `domain`
 * without `active` reads as a forgotten switch, where a manifest without `lock`
 * is simply an open site.
 */
export function setDomainActive(raw: string, active: boolean): string {
  const parsed = readObject(raw);
  const domain = parsed.domain;
  if (typeof domain !== "object" || domain === null || Array.isArray(domain)) {
    throw new Error("no domain declared in sitesolide.json");
  }
  (domain as Record<string, unknown>).active = active;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
