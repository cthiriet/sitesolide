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
    if (typeof manifest.description !== "string" || /[\r\n]/.test(manifest.description)) {
      errors.push("description: a single line of text, no line break");
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

  // A line break in a value written into the unit would add a directive of its
  // own choosing to it, a `User=root` after the generated one.
  if (typeof manifest.start === "string" && /[\r\n]/.test(manifest.start)) {
    errors.push("start: a single line, no line break");
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

  for (const route of manifest.routes ?? []) {
    if (typeof route !== "string" || !route.startsWith("/")) {
      errors.push(`routes: "${String(route)}" should start with /`);
    }
  }
  if (manifest.routes !== undefined && !isApplication) {
    errors.push("routes: without `start`, no request reaches a service");
  }

  errors.push(...envErrors(manifest.env, "env"));
  if (manifest.env !== undefined && !isApplication) {
    errors.push("env: without `start`, no service would read these variables");
  }

  for (const [name, value] of Object.entries(manifest.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
      errors.push(`headers: "${name}" is not a header name`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      errors.push(`headers: the value of ${name} must be a string with no line break`);
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

  for (const secret of manifest.secrets ?? []) {
    if (typeof secret !== "string" || !isInternalPath(secret) || secret.includes("/")) {
      errors.push(`secrets: "${String(secret)}" must be a plain file name under /etc/sitesolide`);
    }
  }

  const domain = manifest.domain;
  if (domain !== undefined) {
    if (typeof domain.name !== "string" || !isValidDomain(domain.name)) {
      errors.push("domain.name: invalid domain name");
    } else if (zone !== "" && (domain.name === zone || domain.name.endsWith(`.${zone}`))) {
      // The `ask` endpoint already refuses these domains: the wildcard and the
      // apex cover them, and a manifest declaring them would get nothing.
      errors.push(`domain.name: the ${zone} zone is already covered by the wildcard`);
    }
    for (const alias of domain.aliases ?? []) {
      if (typeof alias !== "string" || !isValidDomain(alias)) {
        errors.push(`domain.aliases: "${String(alias)}" is invalid`);
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

  return errors;
}

/** The refusals of an `env`, the project's or a service's, `label` naming which. */
function envErrors(env: Record<string, string> | undefined, label: string): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
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
    } else if (/[\r\n]/.test(value)) {
      errors.push(`${label}: the value of ${key} must hold on one line`);
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
    } else if (/[\r\n]/.test(service.start)) {
      errors.push(`${label}.start: a single line, no line break`);
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
