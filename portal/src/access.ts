/**
 * Who may open a restricted site, and with which role: the projection of the
 * steward's access registry that the portal reads, and the decisions it makes
 * from it.
 *
 * ## One source of truth, the steward's
 *
 * The steward, root, keeps the registry of every project's people with
 * access (dashboard/src/access/). After every change it writes this
 * projection to `/etc/sitesolide-portal/access.json`, `root:site-portal 0640`,
 * the way it lays the assertion key beside it: root writes it, the portal's
 * account reads it, the dashboard's cannot. The portal keeps no list of its
 * own: it reads this file again whenever it changes (src/projection.ts), so a
 * person removed or lowered is refused at their next request.
 *
 * ## The roles
 *
 * One ladder, each rung including the ones below:
 *
 * | Role | What it opens |
 * |---|---|
 * | `visitor` | the site, when its general access is restricted |
 * | `viewer` | the same, and the project in the dashboard |
 * | `developer` | the same, and deploying, restarting, writing secrets |
 * | `admin` | everything of the project |
 *
 * The portal only asks "may this person open the site", which every rung
 * answers yes, and passes the role on to the site in `X-Sitesolide-Role`.
 * The owner's password and `OIDC_ADMIN_EMAILS` open every site as `admin`.
 *
 * ## Password access
 *
 * A person outside the company's domains signs in with a password the steward
 * drew for them, for one site, until its expiry. The projection carries its
 * SHA-256, never the password: drawn at random over about 92 bits, there is
 * nothing to guess, and a fast hash finds it by index (see guests.ts).
 *
 * Pure: the dashboard borrows this file, so that the steward writes exactly
 * what the portal reads. Its one import, `./sharing`, is borrowed beside it.
 */
import { cleanDomain, cleanEmail, domainOf } from "./sharing";

/** The ladder, from the narrowest. */
export const ROLES = ["visitor", "viewer", "developer", "admin"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The rung's height: a role grants what every lower one does. */
export function rank(role: Role): number {
  return ROLES.indexOf(role);
}

/** Does `role` reach `minimum`? */
export function atLeast(role: Role | null, minimum: Role): boolean {
  return role !== null && rank(role) >= rank(minimum);
}

/** The higher of two roles, null when neither is one. */
export function higher(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return rank(a) >= rank(b) ? a : b;
}

/** Where the steward writes it, beside the assertion key, and its name. */
export const PROJECTION_FILE = "/etc/sitesolide-portal/access.json";
export const PROJECTION_NAME = "access.json";

/** A projection of a few hundred people per site, a hundred sites, fits well within it. */
export const PROJECTION_MAX_BYTES = 8 * 1024 * 1024;

export const PROJECTION_VERSION = 1;

/** A password access as the portal needs it: which cookie it signs, which hash opens it, until when. */
export type PasswordGrant = {
  /** 16 characters of base64url: the identifier its cookie carries. */
  id: string;
  /** Who it was given to: an email, or the name an access given before the registry carried. */
  who: string;
  /** SHA-256 of the password, in hexadecimal. */
  hash: string;
  /** Milliseconds; null, until it is removed. */
  expiresAt: number | null;
};

/** One site's people with access. */
export type SiteAccess = {
  slug: string;
  /** A verified email, and its role. */
  people: Record<string, Role>;
  /** Everyone at these domains may open it, as `visitor`. */
  domains: string[];
  passwords: PasswordGrant[];
};

export type Projection = {
  version: typeof PROJECTION_VERSION;
  /** When the steward wrote it, in milliseconds. */
  writtenAt: number;
  /** By host, as Caddy announces it in `X-Portal-Hote`. */
  sites: Record<string, SiteAccess>;
};

/** Nobody at all: what a portal reads when the steward's file cannot be believed. */
export const EMPTY_PROJECTION: Projection = { version: PROJECTION_VERSION, writtenAt: 0, sites: {} };

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const SLUG = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const ACCESS_ID = /^[A-Za-z0-9_-]{16}$/;
const HASH = /^[0-9a-f]{64}$/;
/** A name an access was given under before the registry: printable ASCII, a line at most. */
const NAME = /^[\x20-\x7e]{1,120}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isAccessId(value: unknown): value is string {
  return typeof value === "string" && ACCESS_ID.test(value);
}

function readSite(value: unknown): SiteAccess | null {
  if (!isObject(value)) return null;
  const { slug, people, domains, passwords } = value;
  if (typeof slug !== "string" || !SLUG.test(slug) || !isObject(people) || !Array.isArray(domains) || !Array.isArray(passwords)) return null;
  const readPeople: Record<string, Role> = {};
  for (const [email, role] of Object.entries(people)) {
    if (cleanEmail(email) !== email || !isRole(role)) return null;
    readPeople[email] = role;
  }
  const readDomains: string[] = [];
  for (const domain of domains) {
    if (typeof domain !== "string" || cleanDomain(domain) !== domain) return null;
    readDomains.push(domain);
  }
  const readPasswords: PasswordGrant[] = [];
  for (const grant of passwords) {
    if (!isObject(grant)) return null;
    const { id, who, hash, expiresAt } = grant;
    if (!isAccessId(id) || typeof who !== "string" || !NAME.test(who) || typeof hash !== "string" || !HASH.test(hash)) return null;
    if (expiresAt !== null && !isDate(expiresAt)) return null;
    readPasswords.push({ id, who, hash, expiresAt });
  }
  return { slug, people: readPeople, domains: readDomains, passwords: readPasswords };
}

/**
 * The file, read and judged whole. A file that does not read is not guessed
 * at: the caller opens nothing from it, the safe failure for a list of who
 * may get in.
 */
export function readProjection(text: string): Projection | { unreadable: string } {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "access.json is not JSON" };
  }
  if (!isObject(object) || object.version !== PROJECTION_VERSION || !isDate(object.writtenAt) || !isObject(object.sites)) {
    return { unreadable: "access.json does not have the expected shape" };
  }
  const sites: Record<string, SiteAccess> = {};
  for (const [host, site] of Object.entries(object.sites)) {
    const read = HOST.test(host) && host.length <= 253 ? readSite(site) : null;
    if (read === null) return { unreadable: `access.json: the site ${JSON.stringify(host).slice(0, 80)} does not have the expected shape` };
    sites[host] = read;
  }
  return { version: PROJECTION_VERSION, writtenAt: object.writtenAt, sites };
}

/** The file as the steward writes it. */
export function encodeProjection(projection: Projection): string {
  return `${JSON.stringify(projection, null, 2)}\n`;
}

// --- the portal's decisions ------------------------------------------------------

/**
 * The role a verified email holds on a site, or null when it may not open
 * it: an admin email opens every site as `admin`; otherwise the higher of its
 * own entry and its domain's, which is `visitor`.
 */
export function emailRole(site: SiteAccess | undefined, email: string, admins: readonly string[]): Role | null {
  if (admins.includes(email)) return "admin";
  if (site === undefined) return null;
  const own = Object.hasOwn(site.people, email) ? site.people[email]! : null;
  const domain = site.domains.includes(domainOf(email)) ? "visitor" : null;
  return higher(own, domain);
}

/** Does this password access open a site right now? An expired one closes as a removed one does. */
export function grantOpens(grant: PasswordGrant | null | undefined, now: number): grant is PasswordGrant {
  return grant !== null && grant !== undefined && (grant.expiresAt === null || grant.expiresAt > now);
}

/** Every password access by its hash, with its host: a sign-in finds one without going over the others. */
export function passwordIndex(projection: Projection): Map<string, { host: string; grant: PasswordGrant }> {
  const index = new Map<string, { host: string; grant: PasswordGrant }>();
  for (const [host, site] of Object.entries(projection.sites)) {
    for (const grant of site.passwords) index.set(grant.hash, { host, grant });
  }
  return index;
}

/**
 * The expiry of a password access's cookie, in seconds: that of any cookie,
 * never beyond the access itself.
 */
export function grantExpiration(grant: PasswordGrant, nowS: number, durationS: number): number {
  const cap = nowS + durationS;
  return grant.expiresAt === null ? cap : Math.min(cap, Math.floor(grant.expiresAt / 1000));
}

/**
 * The actor a password access signs in under, in the audit: its email when
 * it was given to one, `password:<id>` for a name carried over from before.
 */
export function grantActor(grant: PasswordGrant): string {
  return cleanEmail(grant.who) === grant.who ? grant.who : `password:${grant.id}`;
}
