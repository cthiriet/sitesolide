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

/** What a repository declares in order to be deployable. */
export type Manifest = {
  slug: string;
  description?: string;
  publicDir?: string;
  build?: string;
  install?: string;
  start?: string;
  port?: number;
  routes?: string[];
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
  "publicDir",
  "build",
  "install",
  "start",
  "port",
  "routes",
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
  return typeof manifest.start === "string" && manifest.start.length > 0;
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

  if (manifest.publicDir !== undefined) {
    if (typeof manifest.publicDir !== "string" || !isInternalPath(manifest.publicDir)) {
      errors.push("publicDir: a path inside the repository, no `..`");
    }
  }

  if (!isApplication && manifest.publicDir === undefined) {
    errors.push("a project without `start` must declare `publicDir`");
  }

  if (isApplication) {
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

  for (const [key, value] of Object.entries(manifest.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      errors.push(`env: "${key}" is not an environment variable name`);
    } else if (RESERVED_ENV.includes(key)) {
      errors.push(`env: ${key} is set by the deployment and cannot be redefined`);
    } else if (SUSPICIOUS_ENV.test(key)) {
      errors.push(
        `env: ${key} looks like a secret; secrets live on the server, managed from the dashboard, not here`,
      );
    }
    if (typeof value !== "string") {
      errors.push(`env: the value of ${key} must be a string`);
    }
  }
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
