/**
 * Who may open a restricted site besides the owner: the projection of the
 * steward's access registry that the portal reads, and the decisions it
 * makes from it.
 *
 * ## One source of truth, the steward's
 *
 * The steward, root, keeps the registry of every project's password access
 * (dashboard/src/access/). After every change it writes this projection to
 * `/etc/sitesolide-portal/access.json`, `root:site-portal 0640`, beside the
 * projection of the owner's passkeys: root writes it, the portal's account
 * reads it, the dashboard's cannot. The portal keeps no list of its own: it
 * reads this file again whenever it changes (src/projection.ts), so an access
 * removed is refused at its next request.
 *
 * ## Password access
 *
 * A guest signs in with a password the steward drew for them, for one site,
 * until its expiry. The projection carries its SHA-256, never the password:
 * drawn at random over about 92 bits, there is nothing to guess, and a fast
 * hash finds it by index rather than checking every access one by one, as
 * argon2id would make it. It opens the site as `visitor`; the owner, with a
 * passkey or the owner's password, opens every site as `admin`.
 *
 * Pure: the dashboard borrows this file, so that the steward writes exactly
 * what the portal reads. Its one import, `./email`, is borrowed beside it.
 */
import { EMAIL_MAX, cleanEmail } from "./email";

/** Where the steward writes it, beside the passkeys' projection, and its name. */
export const PROJECTION_FILE = "/etc/sitesolide-portal/access.json";
export const PROJECTION_NAME = "access.json";

/** A projection of a few hundred password accesses per site, a hundred sites, fits well within it. */
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

/**
 * One site's password accesses. A projection written before company sign-in
 * went carries `people` and `domains` beside them, which nothing reads any
 * more: they are ignored, and the steward's next write leaves them out.
 */
export type SiteAccess = {
  slug: string;
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
/**
 * Who a password access was given to: an email, or a name an access was given
 * under before the registry, printable ASCII on one line. One bound for both,
 * an email's own: the steward's registry reads `who` with the same one, so
 * that nothing it accepts makes this file unreadable.
 */
export const WHO_MAX = EMAIL_MAX;
const NAME = new RegExp(`^[\\x20-\\x7e]{1,${WHO_MAX}}$`);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isAccessId(value: unknown): value is string {
  return typeof value === "string" && ACCESS_ID.test(value);
}

function readSite(value: unknown): SiteAccess | null {
  if (!isObject(value)) return null;
  const { slug, passwords } = value;
  if (typeof slug !== "string" || !SLUG.test(slug) || !Array.isArray(passwords)) return null;
  const readPasswords: PasswordGrant[] = [];
  for (const grant of passwords) {
    if (!isObject(grant)) return null;
    const { id, who, hash, expiresAt } = grant;
    if (!isAccessId(id) || typeof who !== "string" || !NAME.test(who) || typeof hash !== "string" || !HASH.test(hash)) return null;
    if (expiresAt !== null && !isDate(expiresAt)) return null;
    readPasswords.push({ id, who, hash, expiresAt });
  }
  return { slug, passwords: readPasswords };
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

/**
 * The file as the steward writes it. Each site still carries an empty
 * `people` and `domains`: a portal of before company sign-in went requires
 * both and reads a site without them as unreadable, which would shut every
 * guest out between the steward's deployment and the portal's. Nothing here
 * reads them; they can go once no portal of before can be in service.
 */
export function encodeProjection(projection: Projection): string {
  const sites: Record<string, SiteAccess & { people: Record<string, never>; domains: never[] }> = {};
  for (const [host, site] of Object.entries(projection.sites)) sites[host] = { ...site, people: {}, domains: [] };
  return `${JSON.stringify({ ...projection, sites }, null, 2)}\n`;
}

// --- the portal's decisions ------------------------------------------------------

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
