/**
 * The access registry: per project, its guests, each a password access.
 * Held by the steward in `/var/lib/sitesolide-steward/access.json`, root
 * 0600, written atomically.
 *
 * **The registry is the steward's**, for the reason the tokens' is: one the
 * dashboard or the portal could write would let either of them let anyone
 * in. The steward reads it at every decision, so an access taken away holds
 * from the next request, and writes the portal's projection after every
 * change (projectionOf), which the portal reads again as soon as it changes.
 *
 * **A registry of before is read.** One written while people signed in with
 * a company account also named people and domains with a role, and who could
 * create projects: those are left out as it is read, and go from the file at
 * its next change. Its password accesses are kept as they stand.
 *
 * Pure: the registry comes in as a value, a new one goes out; the clock is a
 * parameter. Reading and writing the file are system.ts's.
 */
import { encodeProjection, isAccessId, PROJECTION_MAX_BYTES, PROJECTION_VERSION, readProjection, WHO_MAX, type PasswordGrant, type Projection, type SiteAccess } from "../../borrowed/access";
import { cleanEmail } from "../../borrowed/email";
import { isValidSlug } from "../../borrowed/manifest";
import { MAX_ENTRIES, REGISTRY_MAX_BYTES, type EntryView } from "./protocol";

export { encodeProjection };

/** A password access as the registry keeps it: the identifier its cookie carries, the hash, the expiry. */
export type PasswordRecord = { id: string; hash: string; expiresAt: number | null };

export type Entry = {
  /** `alice@acme.com`, or the name an access was given under before the registry. */
  who: string;
  by: string;
  createdAt: number;
  updatedAt: number;
  password: PasswordRecord;
};

export type Registry = {
  version: 1;
  /** By slug, each project's entries, sorted by `who`. */
  projects: Record<string, Entry[]>;
};

export const EMPTY_REGISTRY: Registry = { version: 1, projects: {} };

export type Refusal = { refusal: string; code?: "invalid" | "out-of-scope" | "not-found" };

/** A registry read, and how many entries of before it left out: people and domains with a role, who could create projects. */
export type Read = { registry: Registry; leftOut: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const HASH = /^[0-9a-f]{64}$/;
/**
 * A name carried over from an access given before the registry: printable
 * ASCII, a line at most. Bounded like any `who`, by an email's own length,
 * the bound the portal's projection reads with (borrowed/access.ts): one
 * bound everywhere, so that nothing this registry accepts makes the
 * projection unreadable.
 */
const LEGACY_NAME = new RegExp(`^[\\x20-\\x7e]{1,${WHO_MAX}}$`);
/** Who acted: `owner`, and before the owner alone did, `migration`, an email, a token. */
const BY = /^(owner|migration|token:[A-Za-z0-9_-]{1,64}|[^\s]{1,254})$/;

/** An email, cleaned by the portal's own rules (borrowed/email.ts); or the refusal. */
export function readWho(value: unknown): string | Refusal {
  if (typeof value !== "string") return { refusal: "who: an email, like alice@acme.com", code: "invalid" };
  const text = value.trim();
  if (text.length > WHO_MAX) return { refusal: `who: ${WHO_MAX} characters at most, the longest an email address may be`, code: "invalid" };
  if (text.startsWith("@")) return { refusal: `${text.slice(0, 80)}: a whole domain is given access no more, name its people one by one`, code: "invalid" };
  const email = cleanEmail(text);
  if (email !== null) return email;
  return { refusal: `${JSON.stringify(text).slice(0, 80)} is not an email address, like alice@acme.com`, code: "invalid" };
}

// --- the file ----------------------------------------------------------------------

function readPassword(value: unknown): PasswordRecord | null {
  if (!isObject(value)) return null;
  const { id, hash, expiresAt } = value;
  if (!isAccessId(id) || typeof hash !== "string" || !HASH.test(hash)) return null;
  if (expiresAt !== null && !isDate(expiresAt)) return null;
  return { id, hash, expiresAt };
}

/** An entry, `left-out` for a person or a domain of before, with a role and no password; null when it does not read. */
function readEntry(value: unknown): Entry | "left-out" | null {
  if (!isObject(value)) return null;
  const { who, role, by, createdAt, updatedAt, password } = value;
  if (typeof who !== "string" || typeof by !== "string" || !BY.test(by) || !isDate(createdAt) || !isDate(updatedAt)) return null;
  // A registry of before carried `role` on every entry: a password access was `visitor`.
  if (role !== undefined && role !== "visitor" && password !== undefined) return null;
  if (password === undefined) return "left-out";
  const record = readPassword(password);
  if (record === null || !LEGACY_NAME.test(who) || who.startsWith("@")) return null;
  return { who, by, createdAt, updatedAt, password: record };
}

/**
 * The registry's file, read and judged whole. A file that does not read is
 * not guessed at: every guest is refused until a human looks, the safe
 * failure for a list of who may open what.
 */
export function readRegistry(text: string): Read | { unreadable: string } {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "access.json is not JSON" };
  }
  if (!isObject(object) || object.version !== 1 || !isObject(object.projects)) {
    return { unreadable: "access.json does not have the expected shape" };
  }
  let leftOut = Array.isArray(object.creators) ? object.creators.length : 0;
  const projects: Record<string, Entry[]> = {};
  for (const [slug, entries] of Object.entries(object.projects)) {
    if (!isValidSlug(slug) || !Array.isArray(entries)) return { unreadable: `access.json: ${JSON.stringify(slug).slice(0, 70)} does not have the expected shape` };
    const read: Entry[] = [];
    const seen = new Set<string>();
    for (const value of entries) {
      const entry = readEntry(value);
      if (entry === null) return { unreadable: `access.json: an entry of ${slug} does not have the expected shape` };
      if (entry === "left-out") {
        leftOut++;
        continue;
      }
      if (seen.has(entry.who)) return { unreadable: `access.json names ${entry.who} twice on ${slug}` };
      seen.add(entry.who);
      read.push(entry);
    }
    if (read.length > 0) projects[slug] = sortEntries(read);
  }
  return { registry: { version: 1, projects }, leftOut };
}

export function encodeRegistry(registry: Registry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

/** Sorted by `who`, the order the file and the projection keep. */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0));
}

// --- reading -----------------------------------------------------------------------

export function entriesOf(registry: Registry, slug: string): Entry[] {
  return Object.hasOwn(registry.projects, slug) ? registry.projects[slug]! : [];
}

export function findEntry(registry: Registry, slug: string, who: string): Entry | null {
  return entriesOf(registry, slug).find((entry) => entry.who === who) ?? null;
}

/** An entry as it is shown, never its password's hash nor its identifier. */
export function entryView(entry: Entry, now: number): EntryView {
  const { expiresAt } = entry.password;
  return { who: entry.who, by: entry.by, createdAt: entry.createdAt, updatedAt: entry.updatedAt, expiresAt, expired: expiresAt !== null && expiresAt <= now };
}

/** By name: the order a list shows. */
export function entryViews(entries: Entry[], now: number): EntryView[] {
  return sortEntries(entries).map((entry) => entryView(entry, now));
}

// --- changing ----------------------------------------------------------------------

/** The projects in slug order, as the file keeps them: a list read from it never depends on the order of changes. */
function withEntries(registry: Registry, slug: string, entries: Entry[]): Registry {
  const next = { ...registry.projects };
  if (entries.length === 0) delete next[slug];
  else next[slug] = sortEntries(entries);
  const projects: Record<string, Entry[]> = {};
  for (const key of Object.keys(next).sort()) projects[key] = next[key]!;
  return { ...registry, projects };
}

export type Put = { registry: Registry; entry: Entry; change: "add" | "none" };

/**
 * A password access given. Asked again for the same guest, it keeps its
 * password, which only removing it and giving it anew replaces: `password`
 * is drawn by the caller for a new one alone.
 */
export function putEntry(registry: Registry, slug: string, who: string, by: string, now: number, password: () => PasswordRecord): Put | Refusal {
  const entries = entriesOf(registry, slug);
  const found = entries.find((entry) => entry.who === who) ?? null;
  if (found !== null) return { registry, entry: found, change: "none" };
  if (entries.length >= MAX_ENTRIES) return { refusal: `${MAX_ENTRIES} guests at most on one project`, code: "invalid" };
  const entry: Entry = { who, by, createdAt: now, updatedAt: now, password: password() };
  return { registry: withEntries(registry, slug, [...entries, entry]), entry, change: "add" };
}

export function removeEntry(registry: Registry, slug: string, who: string): { registry: Registry; entry: Entry } | Refusal {
  const entries = entriesOf(registry, slug);
  const found = entries.find((entry) => entry.who === who);
  if (found === undefined) return { refusal: `${who} has no access to ${slug}`, code: "not-found" };
  return { registry: withEntries(registry, slug, entries.filter((entry) => entry.who !== who)), entry: found };
}

/**
 * A project removed from the machine: its entries go with it, so that a
 * project created later under the same name starts from nobody. Returns
 * what was dropped; the registry unchanged when there was nothing.
 */
export function forgetProject(registry: Registry, slug: string): { registry: Registry; dropped: Entry[] } {
  const dropped = entriesOf(registry, slug);
  return dropped.length === 0 ? { registry, dropped } : { registry: withEntries(registry, slug, []), dropped };
}

/**
 * A project renamed on the machine: its entries move to the new slug, so
 * that the same guests open it under the new name, and the portal's
 * projection, by host, follows. Whatever the new name held, left by a
 * removal that stopped half way, is replaced. Returns how many moved.
 */
export function renameProject(registry: Registry, from: string, to: string): { registry: Registry; moved: number } {
  const entries = entriesOf(registry, from);
  if (entries.length === 0 && entriesOf(registry, to).length === 0) return { registry, moved: 0 };
  return { registry: withEntries(withEntries(registry, from, []), to, entries), moved: entries.length };
}

// --- the portal's projection ---------------------------------------------------------

/**
 * Does this registry, and the projection made from it, read back whole? The
 * steward asks before it writes either: a registry it could not read again
 * would refuse everyone at the next request, and a projection the portal
 * could not read would close every restricted site to its guests. Their
 * shape, and their size in bytes, which each is read with a bound on. A
 * change that would write either is refused instead, and nothing is
 * written. Null: both read.
 */
export function readsBack(registry: Registry, projection: Projection): string | null {
  const text = encodeRegistry(registry);
  if (Buffer.byteLength(text) > REGISTRY_MAX_BYTES) return `access.json would pass the ${REGISTRY_MAX_BYTES / 1024 / 1024} MB it is read with`;
  const again = readRegistry(text);
  if ("unreadable" in again) return again.unreadable;
  const portalText = encodeProjection(projection);
  if (Buffer.byteLength(portalText) > PROJECTION_MAX_BYTES) return `the portal's projection would pass the ${PROJECTION_MAX_BYTES / 1024 / 1024} MB it is read with`;
  const portal = readProjection(portalText);
  if ("unreadable" in portal) return portal.unreadable;
  return null;
}

/**
 * What the portal reads: every project's password accesses by host, the
 * address Caddy announces for it, each with its hash and expiry. Projects
 * not deployed are carried too: the portal is asked only for a site it
 * guards, and a site deployed later finds its guests already there.
 */
export function projectionOf(registry: Registry, hostOf: (slug: string) => string | null, now: number): Projection {
  const sites: Record<string, SiteAccess> = {};
  for (const [slug, entries] of Object.entries(registry.projects)) {
    const host = hostOf(slug);
    if (host === null) continue;
    const passwords: PasswordGrant[] = entries.map((entry) => ({ id: entry.password.id, who: entry.who, hash: entry.password.hash, expiresAt: entry.password.expiresAt }));
    sites[host] = { slug, passwords };
  }
  return { version: PROJECTION_VERSION, writtenAt: now, sites };
}
