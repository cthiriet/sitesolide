/**
 * The access registry: per project, its people with access and their roles;
 * per person, the right to create projects. Held by the steward in
 * `/var/lib/sitesolide-steward/access.json`, root 0600, written atomically.
 *
 * **The registry is the steward's**, for the reason the tokens' is: one the
 * dashboard or the portal could write would let either of them make anyone
 * an admin of anything. The steward reads it at every decision, so a role
 * taken away holds from the next request, and writes the portal's projection
 * after every change (projectionOf), which the portal reads again as soon as
 * it changes.
 *
 * Pure: the registry comes in as a value, a new one goes out; the clock is a
 * parameter. The rules of who may grant what are rules.ts's; reading and
 * writing the file are system.ts's.
 */
import { atLeast, encodeProjection, isAccessId, isRole, PROJECTION_VERSION, rank, type PasswordGrant, type Projection, type Role, type SiteAccess } from "../../borrowed/access";
import { cleanDomain, cleanEmail } from "../../borrowed/sharing";
import { isValidSlug } from "../../borrowed/manifest";
import { MAX_DASHBOARD_PEOPLE, MAX_ENTRIES, type EntryKind, type EntryView, type PersonView } from "./protocol";

export { encodeProjection };

/** A password access as the registry keeps it: the identifier its cookie carries, the hash, the expiry. */
export type PasswordRecord = { id: string; hash: string; expiresAt: number | null };

export type Entry = {
  /** `alice@acme.com`, `@acme.com`, or the name an access was given under before the registry. */
  who: string;
  role: Role;
  by: string;
  createdAt: number;
  updatedAt: number;
  password?: PasswordRecord;
};

export type Creator = { email: string; by: string; at: number };

/** What the migration could not carry as an entry, kept so that nothing is lost: see migrate.ts. */
export type SetAside = { source: "members" | "sharing" | "password"; slug: string | null; who: string; reason: string };

export type Migration = { at: number; from: string[]; setAside: SetAside[] };

export type Registry = {
  version: 1;
  /** By slug, each project's entries, sorted by `who`. */
  projects: Record<string, Entry[]>;
  /** Who may create projects, sorted by email. */
  creators: Creator[];
  /** When this registry was made from the stores before it, and what it set aside. Null for one begun empty. */
  migration: Migration | null;
};

export const EMPTY_REGISTRY: Registry = { version: 1, projects: {}, creators: [], migration: null };

export type Refusal = { refusal: string; code?: "invalid" | "out-of-scope" | "not-found" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const HASH = /^[0-9a-f]{64}$/;
/** A name carried over from an access given before the registry: printable ASCII, a line at most. */
const LEGACY_NAME = /^[\x20-\x7e]{1,120}$/;
/** Who acted: `owner`, `migration`, an email, a token. */
const BY = /^(owner|migration|token:[A-Za-z0-9_-]{1,64}|[^\s]{1,254})$/;

// --- who ---------------------------------------------------------------------------

export type Who = { kind: "person"; who: string; email: string } | { kind: "domain"; who: string; domain: string };

/**
 * An email, or a domain written `@acme.com`, cleaned by the portal's own
 * rules (borrowed/sharing.ts); or the refusal. A bare `acme.com` is said to
 * need its `@`, rather than read as anything.
 */
export function readWho(value: unknown): Who | Refusal {
  if (typeof value !== "string") return { refusal: "who: an email, like alice@acme.com, or a domain, like @acme.com", code: "invalid" };
  const text = value.trim();
  if (text.startsWith("@")) {
    const domain = cleanDomain(text.slice(1));
    if (domain === null) return { refusal: `${text.slice(0, 80)} is not a domain, like @acme.com`, code: "invalid" };
    return { kind: "domain", who: `@${domain}`, domain };
  }
  const email = cleanEmail(text);
  if (email !== null) return { kind: "person", who: email, email };
  if (cleanDomain(text) !== null) return { refusal: `${text.slice(0, 80)}: write a domain with its @, like @${cleanDomain(text)}`, code: "invalid" };
  return { refusal: `${JSON.stringify(text).slice(0, 80)} is neither an email nor a domain like @acme.com`, code: "invalid" };
}

/** What kind of entry this is, as it is shown. */
export function kindOf(entry: Entry): EntryKind {
  if (entry.password !== undefined) return "password";
  return entry.who.startsWith("@") ? "domain" : "person";
}

/** The email an entry names, null for a domain or a name from before the registry. */
export function emailOf(entry: Entry): string | null {
  return cleanEmail(entry.who) === entry.who ? entry.who : null;
}

// --- the file ----------------------------------------------------------------------

function readPassword(value: unknown): PasswordRecord | null {
  if (!isObject(value)) return null;
  const { id, hash, expiresAt } = value;
  if (!isAccessId(id) || typeof hash !== "string" || !HASH.test(hash)) return null;
  if (expiresAt !== null && !isDate(expiresAt)) return null;
  return { id, hash, expiresAt };
}

function readEntry(value: unknown): Entry | null {
  if (!isObject(value)) return null;
  const { who, role, by, createdAt, updatedAt, password } = value;
  if (typeof who !== "string" || !isRole(role) || typeof by !== "string" || !BY.test(by) || !isDate(createdAt) || !isDate(updatedAt)) return null;
  if (password === undefined) {
    // A person or a domain, as readWho writes them.
    const read = readWho(who);
    if ("refusal" in read || read.who !== who) return null;
    if (read.kind === "domain" && role !== "visitor") return null;
    return { who, role, by, createdAt, updatedAt };
  }
  const record = readPassword(password);
  // Password access opens a site and nothing more.
  if (record === null || role !== "visitor" || !LEGACY_NAME.test(who) || who.startsWith("@")) return null;
  return { who, role, by, createdAt, updatedAt, password: record };
}

function readSetAside(value: unknown): SetAside | null {
  if (!isObject(value)) return null;
  const { source, slug, who, reason } = value;
  if (source !== "members" && source !== "sharing" && source !== "password") return null;
  if (slug !== null && typeof slug !== "string") return null;
  if (typeof who !== "string" || typeof reason !== "string") return null;
  return { source, slug, who, reason };
}

/**
 * The registry's file, read and judged whole. A file that does not read is
 * not guessed at: every person is refused until a human looks, the safe
 * failure for a list of who may do what.
 */
export function readRegistry(text: string): Registry | { unreadable: string } {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "access.json is not JSON" };
  }
  if (!isObject(object) || object.version !== 1 || !isObject(object.projects) || !Array.isArray(object.creators)) {
    return { unreadable: "access.json does not have the expected shape" };
  }
  const projects: Record<string, Entry[]> = {};
  for (const [slug, entries] of Object.entries(object.projects)) {
    if (!isValidSlug(slug) || !Array.isArray(entries)) return { unreadable: `access.json: ${JSON.stringify(slug).slice(0, 70)} does not have the expected shape` };
    const read: Entry[] = [];
    const seen = new Set<string>();
    for (const value of entries) {
      const entry = readEntry(value);
      if (entry === null) return { unreadable: `access.json: an entry of ${slug} does not have the expected shape` };
      if (seen.has(entry.who)) return { unreadable: `access.json names ${entry.who} twice on ${slug}` };
      seen.add(entry.who);
      read.push(entry);
    }
    if (read.length > 0) projects[slug] = sortEntries(read);
  }
  const creators: Creator[] = [];
  for (const value of object.creators) {
    if (!isObject(value) || typeof value.email !== "string" || cleanEmail(value.email) !== value.email || typeof value.by !== "string" || !isDate(value.at)) {
      return { unreadable: "access.json: a person who may create projects does not have the expected shape" };
    }
    if (creators.some((creator) => creator.email === value.email)) return { unreadable: `access.json names ${value.email} twice among those who may create projects` };
    creators.push({ email: value.email, by: value.by, at: value.at });
  }
  let migration: Migration | null = null;
  if (object.migration !== null && object.migration !== undefined) {
    const raw = object.migration;
    if (!isObject(raw) || !isDate(raw.at) || !Array.isArray(raw.from) || !raw.from.every((one) => typeof one === "string") || !Array.isArray(raw.setAside)) {
      return { unreadable: "access.json: its migration record does not have the expected shape" };
    }
    const setAside: SetAside[] = [];
    for (const value of raw.setAside) {
      const one = readSetAside(value);
      if (one === null) return { unreadable: "access.json: its migration record does not have the expected shape" };
      setAside.push(one);
    }
    migration = { at: raw.at, from: raw.from as string[], setAside };
  }
  return { version: 1, projects, creators: creators.sort((a, b) => a.email.localeCompare(b.email)), migration };
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

/** The role this email's own entry holds on this project, or null: a domain's does not count here. */
export function roleOf(registry: Registry, email: string, slug: string): Role | null {
  return findEntry(registry, slug, email)?.role ?? null;
}

export function mayCreate(registry: Registry, email: string): boolean {
  return registry.creators.some((creator) => creator.email === email);
}

/** Every project this email holds a role on, `visitor` included. */
export function rolesOf(registry: Registry, email: string): Record<string, Role> {
  const roles: Record<string, Role> = {};
  for (const [slug, entries] of Object.entries(registry.projects).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = entries.find((one) => one.who === email);
    if (entry !== undefined) roles[slug] = entry.role;
  }
  return roles;
}

/** The roles the dashboard knows: `viewer` and above. `visitor` opens a site and shows nothing here. */
export function dashboardRolesOf(registry: Registry, email: string): Record<string, "viewer" | "developer" | "admin"> {
  const roles: Record<string, "viewer" | "developer" | "admin"> = {};
  for (const [slug, role] of Object.entries(rolesOf(registry, email))) {
    if (role !== "visitor") roles[slug] = role;
  }
  return roles;
}

/**
 * Who signs in to the dashboard: someone with a role above `visitor`
 * somewhere, or the right to create projects. A visitor everywhere, password
 * access included, has nothing to see there and is refused at sign-in.
 */
export function isDashboardPerson(registry: Registry, email: string): boolean {
  return mayCreate(registry, email) || Object.keys(dashboardRolesOf(registry, email)).length > 0;
}

/**
 * What a person who signs in holds now: their roles above Can open, and the
 * create right; null for someone who does not sign in to the dashboard.
 * The shape of src/people/tokens.ts's `MemberRights`, which a person's own
 * tokens are narrowed to at every use, and by the installer when it starts.
 */
export function rightsOf(registry: Registry, email: string): { email: string; roles: Record<string, "viewer" | "developer" | "admin">; create: boolean } | null {
  if (!isDashboardPerson(registry, email)) return null;
  return { email, roles: dashboardRolesOf(registry, email), create: mayCreate(registry, email) };
}

/** Every email that signs in to the dashboard. */
export function dashboardPeople(registry: Registry): string[] {
  const emails = new Set(registry.creators.map((creator) => creator.email));
  for (const entries of Object.values(registry.projects)) {
    for (const entry of entries) if (entry.role !== "visitor" && emailOf(entry) !== null) emails.add(entry.who);
  }
  return [...emails].sort();
}

/** An entry as it is shown, never its password's hash nor its identifier. */
export function entryView(entry: Entry, now: number): EntryView {
  return {
    who: entry.who,
    kind: kindOf(entry),
    role: entry.role,
    by: entry.by,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    password: entry.password === undefined ? null : { expiresAt: entry.password.expiresAt, expired: entry.password.expiresAt !== null && entry.password.expiresAt <= now },
  };
}

/** The highest roles first, then people, domains, password access, each by name: the order a list shows. */
export function entryViews(entries: Entry[], now: number): EntryView[] {
  const order: Record<EntryKind, number> = { person: 0, domain: 1, password: 2 };
  return [...entries]
    .sort((a, b) => rank(b.role) - rank(a.role) || order[kindOf(a)] - order[kindOf(b)] || (a.who < b.who ? -1 : a.who > b.who ? 1 : 0))
    .map((entry) => entryView(entry, now));
}

/** Everyone across projects, each with their roles, their create right, their password access. */
export function peopleViews(registry: Registry, admins: readonly string[], now: number): { people: PersonView[]; domains: { slug: string; domain: string }[] } {
  const people = new Map<string, PersonView>();
  const domains: { slug: string; domain: string }[] = [];
  const person = (who: string): PersonView => {
    let found = people.get(who);
    if (found === undefined) {
      found = { who, roles: {}, create: false, passwords: [], admin: admins.includes(who) };
      people.set(who, found);
    }
    return found;
  };
  for (const [slug, entries] of Object.entries(registry.projects)) {
    for (const entry of entries) {
      if (kindOf(entry) === "domain") {
        domains.push({ slug, domain: entry.who });
        continue;
      }
      const view = person(entry.who);
      view.roles[slug] = entry.role;
      if (entry.password !== undefined) {
        view.passwords.push({ slug, expiresAt: entry.password.expiresAt, expired: entry.password.expiresAt !== null && entry.password.expiresAt <= now });
      }
    }
  }
  for (const creator of registry.creators) person(creator.email).create = true;
  for (const admin of admins) person(admin);
  return {
    people: [...people.values()].sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : 0)),
    domains: domains.sort((a, b) => a.slug.localeCompare(b.slug) || a.domain.localeCompare(b.domain)),
  };
}

/** `blog: developer, shop: viewer`, for the journal and the CLI. */
export function rolesText(roles: Record<string, Role>): string {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "no project" : entries.map(([slug, role]) => `${slug}: ${role}`).join(", ");
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

export type Put = { registry: Registry; entry: Entry; change: "add" | "role" | "none" };

/**
 * An entry added, or its role changed. The caller has judged that this
 * granter may give this role to this `who` here (rules.ts). A password
 * access is given once: asked again, it keeps its password, which only
 * removing it and giving it anew replaces.
 */
export function putEntry(registry: Registry, slug: string, who: string, role: Role, by: string, now: number, password?: PasswordRecord): Put | Refusal {
  const entries = entriesOf(registry, slug);
  const found = entries.find((entry) => entry.who === who) ?? null;
  if (found === null) {
    if (entries.length >= MAX_ENTRIES) return { refusal: `${MAX_ENTRIES} entries at most on one project: give a whole domain access rather than its people one by one`, code: "invalid" };
    const entry: Entry = password === undefined ? { who, role, by, createdAt: now, updatedAt: now } : { who, role, by, createdAt: now, updatedAt: now, password };
    return { registry: withEntries(registry, slug, [...entries, entry]), entry, change: "add" };
  }
  if (found.role === role) return { registry, entry: found, change: "none" };
  if (found.password !== undefined && role !== "visitor") return { refusal: `${who} has password access, which opens the site and nothing more`, code: "out-of-scope" };
  const changed: Entry = { ...found, role, updatedAt: now };
  return { registry: withEntries(registry, slug, entries.map((entry) => (entry.who === who ? changed : entry))), entry: changed, change: "role" };
}

export function removeEntry(registry: Registry, slug: string, who: string): { registry: Registry; entry: Entry } | Refusal {
  const entries = entriesOf(registry, slug);
  const found = entries.find((entry) => entry.who === who);
  if (found === undefined) return { refusal: `${who} has no access to ${slug}`, code: "not-found" };
  return { registry: withEntries(registry, slug, entries.filter((entry) => entry.who !== who)), entry: found };
}

/** The right to create projects given, or taken back. */
export function setCreate(registry: Registry, email: string, create: boolean, by: string, now: number): { registry: Registry; change: boolean } | Refusal {
  const has = mayCreate(registry, email);
  if (has === create) return { registry, change: false };
  if (create) {
    if (!isDashboardPerson(registry, email) && dashboardPeople(registry).length >= MAX_DASHBOARD_PEOPLE) {
      return { refusal: `${MAX_DASHBOARD_PEOPLE} people sign in to the dashboard at most: take someone who left off first`, code: "invalid" };
    }
    const creators = [...registry.creators, { email, by, at: now }].sort((a, b) => a.email.localeCompare(b.email));
    return { registry: { ...registry, creators }, change: true };
  }
  return { registry: { ...registry, creators: registry.creators.filter((creator) => creator.email !== email) }, change: true };
}

/** Someone taken off every project and the create right: what removing a person from People does. */
export function removePerson(registry: Registry, email: string): { registry: Registry; removed: { slug: string; entry: Entry }[]; create: boolean } {
  const removed: { slug: string; entry: Entry }[] = [];
  let next = registry;
  for (const slug of Object.keys(registry.projects)) {
    const found = findEntry(registry, slug, email);
    if (found === null) continue;
    removed.push({ slug, entry: found });
    next = withEntries(next, slug, entriesOf(next, slug).filter((entry) => entry.who !== email));
  }
  const create = mayCreate(registry, email);
  if (create) next = { ...next, creators: next.creators.filter((creator) => creator.email !== email) };
  return { registry: next, removed, create };
}

/**
 * A project a person created, through a token of their own that may create:
 * they become its admin, whatever a registry edited by hand said there
 * before. Recorded at the start of the project's first deployment, before
 * anything is written on the machine.
 */
export function recordCreation(registry: Registry, email: string, slug: string, now: number): Put | Refusal {
  if (!isDashboardPerson(registry, email)) return { refusal: `${email} no longer signs in to this dashboard`, code: "out-of-scope" };
  const found = findEntry(registry, slug, email);
  if (found !== null && found.password !== undefined) {
    // A password access cannot be raised: the admin entry replaces it.
    const removed = removeEntry(registry, slug, email);
    if ("refusal" in removed) return removed;
    return putEntry(removed.registry, slug, email, "admin", email, now);
  }
  return putEntry(registry, slug, email, "admin", email, now);
}

/** Does this change raise someone above `visitor`, the changes that ask for an unlock? */
export function raisesAboveVisitor(before: Role | null, after: Role): boolean {
  return atLeast(after, "viewer") && (before === null || rank(after) > rank(before));
}

// --- the portal's projection ---------------------------------------------------------

/**
 * What the portal reads: every project's people by host, the address Caddy
 * announces for it. The roles as they stand, each password access with its
 * hash and expiry. Projects not deployed are carried too: the portal is
 * asked only for a site it guards, and a site deployed later finds its
 * people already there.
 */
export function projectionOf(registry: Registry, hostOf: (slug: string) => string | null, now: number): Projection {
  const sites: Record<string, SiteAccess> = {};
  for (const [slug, entries] of Object.entries(registry.projects)) {
    const host = hostOf(slug);
    if (host === null) continue;
    const people: Record<string, Role> = {};
    const domains: string[] = [];
    const passwords: PasswordGrant[] = [];
    for (const entry of entries) {
      if (entry.password !== undefined) {
        passwords.push({ id: entry.password.id, who: entry.who, hash: entry.password.hash, expiresAt: entry.password.expiresAt });
        // A password given to an email inside the company's domains also lets its owner in with their account.
        if (emailOf(entry) !== null) people[entry.who] = "visitor";
      } else if (entry.who.startsWith("@")) {
        domains.push(entry.who.slice(1));
      } else {
        people[entry.who] = entry.role;
      }
    }
    sites[host] = { slug, people, domains: domains.sort(), passwords };
  }
  return { version: PROJECTION_VERSION, writtenAt: now, sites };
}
