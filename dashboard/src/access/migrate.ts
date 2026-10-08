/**
 * The registry made once from the stores before it: the dashboard's
 * `members.json`, and the portal's sharing and password access in
 * `portal.db`. Pure: the files come in as values, read by system.ts.
 *
 * **Nothing lost, nothing widened.** Every role, every person and domain who
 * opened a site, every password access with its hash, identifier and expiry,
 * so that cookies and passwords in circulation keep working, becomes an
 * entry. Two things never become one, and are kept in the registry's
 * migration record instead, with why:
 *
 * - people and domains a site's sharing kept for later while its mode let
 *   them out (`admins` keeps both lists, `people` its domains): giving them
 *   access would open the site to people who could not open it the day
 *   before;
 * - a password access whose site is the platform's, or a host this zone does
 *   not name.
 *
 * **Conflicts go to the higher role.** A person both shared with and given a
 * role keeps the role, which includes opening the site. A password access
 * given to an email that already holds a role there is set aside: the role
 * opens the site with their account.
 *
 * Revoked password access was deleted from the portal's database when it was
 * revoked, and so is in no row to carry over; an expired one is carried with
 * its expiry, and opens nothing, as before.
 */
import { atLeast, isAccessId, rank, WHO_MAX, type Role } from "../../borrowed/access";
import { cleanDomain, cleanEmail, readPolicy } from "../../borrowed/sharing";
import { isValidSlug } from "../../borrowed/manifest";
import { reservedReason } from "../control/policy";
import { sortEntries, type Entry, type Registry, type SetAside } from "./registry";

/** A row of the portal's `sharing` table, as SQLite gives it. */
export type SharingRow = { host: string; mode: string; people: string; domains: string; updated_at: number };

/** A row of the portal's `invites` table: its columns kept their French names on the machine. */
export type InviteRow = { id: string; hote: string; libelle: string; empreinte: string; cree_a: number; expire_a: number | null };

export type PortalRows = { sharing: SharingRow[]; invites: InviteRow[] };

/**
 * What the record lists at most of what was set aside: past it, one line
 * says how many more, which stay in the stores before the registry, kept
 * read-only. A portal full of hosts this zone does not name would otherwise
 * make a registry too big to read back, and the migration would never end.
 */
export const MAX_SET_ASIDE = 500;

export type MigrationReport = {
  roles: number;
  people: number;
  domains: number;
  passwords: number;
  creators: number;
  setAside: number;
};

type MemberRecord = { email: string; roles: Record<string, "viewer" | "developer" | "admin">; create: boolean; invitedBy: string; createdAt: number; updatedAt: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * `members.json` as the steward before this one wrote it. A file that does
 * not read stops the migration: guessing at a list of who may do what is
 * the one thing not to do, and the owner is told to look.
 */
export function readMembersFile(text: string | null): MemberRecord[] | { unreadable: string } {
  if (text === null) return [];
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "members.json is not JSON" };
  }
  if (!isObject(object) || !Array.isArray(object.members)) return { unreadable: "members.json does not have the expected shape" };
  const members: MemberRecord[] = [];
  for (const value of object.members) {
    if (!isObject(value)) return { unreadable: "a person of members.json does not have the expected shape" };
    const { email, roles, invitedBy, createdAt, updatedAt, create } = value;
    if (typeof email !== "string" || cleanEmail(email) !== email || !isObject(roles)) return { unreadable: "a person of members.json does not have the expected shape" };
    const read: MemberRecord["roles"] = {};
    for (const [slug, role] of Object.entries(roles)) {
      if (!isValidSlug(slug) || (role !== "viewer" && role !== "developer" && role !== "admin")) return { unreadable: `a role of ${email} in members.json does not read` };
      read[slug] = role;
    }
    if (create !== undefined && typeof create !== "boolean") return { unreadable: `the create right of ${email} in members.json does not read` };
    members.push({
      email,
      roles: read,
      create: create === true,
      invitedBy: typeof invitedBy === "string" && invitedBy.length <= 254 ? invitedBy : "owner",
      createdAt: isDate(createdAt) ? createdAt : 0,
      updatedAt: isDate(updatedAt) ? updatedAt : 0,
    });
  }
  return members;
}

function parseList(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The slug a host names under this zone, or null: `<slug>.<zone>`, the only address a restricted site has. */
export function slugOfHost(host: string, zone: string): string | null {
  const suffix = `.${zone}`;
  if (zone === "" || !host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  return isValidSlug(slug) ? slug : null;
}

/** A name carried over as it stands: printable ASCII on one line, as the portal's labels are. */
function legacyName(label: string): string | null {
  const trimmed = label.trim();
  return /^[\x20-\x7e]{1,80}$/.test(trimmed) && !trimmed.startsWith("@") ? trimmed : null;
}

/**
 * What the record says when the owner carried the rest over without the
 * portal's database, which did not read (`sitesolide people
 * --migrate-without-portal`): who could open which site, and password
 * access, were not carried over, and stay in that database, read-only.
 */
export const WITHOUT_PORTAL: SetAside = {
  source: "sharing",
  slug: null,
  who: "portal.db",
  reason: "carried over without the portal's database, at the owner's request: who could open which site, and password access, were left in it",
};

/**
 * The registry, from the old stores. `now` dates the record; every entry
 * keeps the dates it had. `withoutPortal`: the owner left the portal's
 * database out, and the record says so.
 */
export function migrate(
  members: MemberRecord[],
  portal: PortalRows | null,
  zone: string,
  now: number,
  options: { withoutPortal?: boolean } = {},
): { registry: Registry; report: MigrationReport } {
  const projects = new Map<string, Map<string, Entry>>();
  const setAside: SetAside[] = [];
  const report: MigrationReport = { roles: 0, people: 0, domains: 0, passwords: 0, creators: 0, setAside: 0 };
  const entriesOf = (slug: string): Map<string, Entry> => {
    let found = projects.get(slug);
    if (found === undefined) {
      found = new Map();
      projects.set(slug, found);
    }
    return found;
  };
  const platform = (slug: string) => reservedReason(slug, zone) !== null;

  /** An entry given, or the existing one kept when its role is as high: toward the higher role. */
  function give(slug: string, who: string, role: Role, by: string, at: number): void {
    const entries = entriesOf(slug);
    const found = entries.get(who);
    if (found === undefined) {
      entries.set(who, { who, role, by, createdAt: at, updatedAt: at });
      return;
    }
    if (found.password === undefined && rank(role) > rank(found.role)) entries.set(who, { ...found, role });
  }

  // 1. The dashboard's people and their roles.
  const creators = members.filter((member) => member.create).map((member) => ({ email: member.email, by: member.invitedBy, at: member.createdAt }));
  for (const member of members) {
    for (const [slug, role] of Object.entries(member.roles)) {
      if (platform(slug)) {
        setAside.push({ source: "members", slug, who: member.email, reason: `${role} on a project of the platform, which stays the owner's` });
        continue;
      }
      give(slug, member.email, role, member.invitedBy, member.createdAt);
      report.roles++;
    }
  }
  report.creators = creators.length;

  // 2. Who a site's sharing let in, and only them.
  for (const row of portal?.sharing ?? []) {
    const slug = slugOfHost(row.host, zone);
    const reading = readPolicy({ mode: row.mode, people: parseList(row.people), domains: parseList(row.domains) });
    if (slug === null || platform(slug) || "error" in reading) {
      setAside.push({ source: "sharing", slug, who: row.host, reason: slug === null || platform(slug) ? "a host this zone gives no project" : "a policy the portal itself would not read" });
      continue;
    }
    const { mode, people, domains } = reading.policy;
    const at = isDate(row.updated_at) ? row.updated_at : now;
    for (const email of people) {
      if (mode === "admins") {
        setAside.push({ source: "sharing", slug, who: email, reason: "kept for later by the old sharing, which let only admins in: not given access" });
        continue;
      }
      const before = entriesOf(slug).get(email);
      give(slug, email, "visitor", "migration", at);
      if (before === undefined) report.people++;
    }
    for (const domain of domains) {
      if (mode !== "domain") {
        setAside.push({ source: "sharing", slug, who: `@${domain}`, reason: `kept for later by the old sharing, whose mode (${mode}) let no domain in: not given access` });
        continue;
      }
      if (cleanDomain(domain) !== domain) continue;
      const before = entriesOf(slug).get(`@${domain}`);
      give(slug, `@${domain}`, "visitor", "migration", at);
      if (before === undefined) report.domains++;
    }
  }

  // 3. Password access, with its hash, identifier and expiry: the passwords
  // and cookies in circulation keep opening what they opened.
  const invites = [...(portal?.invites ?? [])].sort((a, b) => a.cree_a - b.cree_a || a.id.localeCompare(b.id));
  for (const row of invites) {
    const slug = slugOfHost(row.hote, zone);
    const label = typeof row.libelle === "string" ? row.libelle : "";
    if (slug === null || platform(slug)) {
      setAside.push({ source: "password", slug, who: label.slice(0, 80), reason: `password access for ${row.hote.slice(0, 80)}, a host this zone gives no project` });
      continue;
    }
    if (!isAccessId(row.id) || !/^[0-9a-f]{64}$/.test(row.empreinte) || (row.expire_a !== null && !isDate(row.expire_a))) {
      setAside.push({ source: "password", slug, who: label.slice(0, 80), reason: "a password access the portal itself would not read" });
      continue;
    }
    const email = cleanEmail(label);
    const base = email ?? legacyName(label) ?? `access ${row.id}`;
    const entries = entriesOf(slug);
    let who = base;
    const found = entries.get(who);
    if (found !== undefined && found.password === undefined && email !== null) {
      if (atLeast(found.role, "viewer")) {
        setAside.push({ source: "password", slug, who: email, reason: `password access set aside: ${email} is ${found.role} there, which opens the site with their account` });
        continue;
      }
      // Can open already, by the old sharing: the password joins the entry.
      entries.set(who, { ...found, by: found.by, password: { id: row.id, hash: row.empreinte, expiresAt: row.expire_a } });
      report.passwords++;
      continue;
    }
    // Two accesses given under one name stay two entries, within the bound of a `who`.
    for (let n = 2; entries.has(who); n++) who = `${base.slice(0, WHO_MAX - String(n).length - 3)} (${n})`;
    const at = isDate(row.cree_a) ? row.cree_a : now;
    entries.set(who, { who, role: "visitor", by: "migration", createdAt: at, updatedAt: at, password: { id: row.id, hash: row.empreinte, expiresAt: row.expire_a } });
    report.passwords++;
  }

  const registryProjects: Record<string, Entry[]> = {};
  for (const [slug, entries] of [...projects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entries.size > 0) registryProjects[slug] = sortEntries([...entries.values()]);
  }
  report.setAside = setAside.length;
  const listed = setAside.length <= MAX_SET_ASIDE ? setAside : setAside.slice(0, MAX_SET_ASIDE - 1);
  if (listed !== setAside) {
    const more = setAside.length - listed.length;
    listed.push({ source: setAside[listed.length]!.source, slug: null, who: `${more} more`, reason: `${more} more set aside, not listed here: they stay in the stores before the registry, kept read-only` });
  }
  if (options.withoutPortal === true) {
    listed.push(WITHOUT_PORTAL);
    report.setAside++;
  }
  const from = ["members.json", ...(portal === null ? [] : ["portal.db"])];
  return {
    registry: {
      version: 1,
      projects: registryProjects,
      creators: creators.sort((a, b) => a.email.localeCompare(b.email)),
      migration: { at: now, from, setAside: listed },
    },
    report,
  };
}

/** The report in a line, for the journal and the steward's log. */
export function reportText(report: MigrationReport): string {
  return `${report.roles} role(s), ${report.people} person(s) and ${report.domains} domain(s) who could open a site, ${report.passwords} password access, ${report.creators} who may create projects; ${report.setAside} set aside`;
}
